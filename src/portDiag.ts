import { spawnSync } from 'node:child_process';
import http from 'node:http';
import treeKill from 'tree-kill';

export interface PortHolder {
  pid: number;
  name?: string;
  cmd?: string;
  // ISO-ish process start time when the platform reports it (M81 forensics).
  startedAt?: string;
}

export function findPortHolder(port: number): PortHolder | null {
  // `port` is interpolated into a PowerShell command string, so refuse anything
  // that isn't a plain positive integer rather than trust the `number` type
  // (a loosely-coerced request param could arrive as a non-numeric value).
  port = Number(port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (process.platform === 'win32') {
    // One PowerShell round-trip (each spawn costs ~1s): resolve the listening
    // pid AND its process identity in a single -Command.
    const script = `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Get-CimInstance Win32_Process -Filter "ProcessId=$p" | Select-Object -Property ProcessId,Name,CommandLine,@{n='StartedIso';e={$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')}} | ConvertTo-Json -Compress }`;
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (ps.status !== 0) return null;
    const raw = (ps.stdout || '').trim();
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      const pid = Number(obj.ProcessId);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      return {
        pid,
        name: typeof obj.Name === 'string' ? obj.Name : undefined,
        cmd: typeof obj.CommandLine === 'string' ? obj.CommandLine : undefined,
        startedAt: typeof obj.StartedIso === 'string' ? obj.StartedIso : undefined,
      };
    } catch {
      return null;
    }
  }
  const lsof = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (lsof.status !== 0) return null;
  const lines = (lsof.stdout || '').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('COMMAND'));
  if (!lines.length) return null;
  const cols = lines[0].split(/\s+/);
  const pid = Number(cols[1]);
  let startedAt: string | undefined;
  try {
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    const t = (ps.stdout || '').trim();
    if (ps.status === 0 && t) startedAt = t;
  } catch {}
  return { pid, name: cols[0], startedAt };
}

// One-shot listener scan (M81): which of `ports` have a LISTEN socket, and by
// which pid. One netstat/ss invocation for the whole set — findPortHolder's
// per-port PowerShell round-trip would be far too slow for a 100-port pool.
// Best-effort: returns an empty map when the platform tool is unavailable.
export function scanListeningPorts(ports: Iterable<number>): Map<number, number> {
  const want = new Set<number>();
  for (const p of ports) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n <= 65535) want.add(n);
  }
  const out = new Map<number, number>();
  if (!want.size) return out;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      if (r.status !== 0) return out;
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        // "  TCP    127.0.0.1:4999    0.0.0.0:0    LISTENING    12345"
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (!m) continue;
        const port = Number(m[1]);
        const pid = Number(m[2]);
        if (want.has(port) && !out.has(port) && pid > 0) out.set(port, pid);
      }
      return out;
    }
    // POSIX: prefer ss (fast, ubiquitous on Linux); fall back to lsof (macOS).
    const ss = spawnSync('ss', ['-ltnp'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (ss.status === 0 && (ss.stdout || '').trim()) {
      for (const line of (ss.stdout || '').split(/\r?\n/)) {
        const portM = line.match(/[\s\][:](\d+)\s+[\d.:*]+/);
        const pidM = line.match(/pid=(\d+)/);
        if (!portM) continue;
        const port = Number(portM[1]);
        if (want.has(port) && !out.has(port)) out.set(port, pidM ? Number(pidM[1]) : 0);
      }
      return out;
    }
    const lsof = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (lsof.status === 0) {
      for (const line of (lsof.stdout || '').split(/\r?\n/)) {
        if (!line.trim() || line.startsWith('COMMAND')) continue;
        const cols = line.split(/\s+/);
        const pid = Number(cols[1]);
        const m = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (!m) continue;
        const port = Number(m[1]);
        if (want.has(port) && !out.has(port) && pid > 0) out.set(port, pid);
      }
    }
  } catch {}
  return out;
}

// Does the process listening on `port` answer as a daimon? Probes the v0.13
// signature endpoint, then falls back to the /api/self shape older daemons
// expose. Loopback-only by construction.
export function probeDaimonSignature(port: number, timeoutMs = 1500): Promise<{ daimon: boolean; version?: string; pid?: number } | null> {
  const get = (path: string): Promise<any | null> => new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size < 65536) chunks.push(c); });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
  return (async () => {
    const sig = await get('/api/signature');
    if (sig && sig.daimon === true) {
      return { daimon: true, version: typeof sig.version === 'string' ? sig.version : undefined, pid: typeof sig.pid === 'number' ? sig.pid : undefined };
    }
    const self = await get('/api/self');
    if (self && typeof self.rssMB === 'number' && typeof self.eventLoopLagMs === 'number') {
      return { daimon: true };
    }
    return sig === null && self === null ? null : { daimon: false };
  })();
}

export interface ApiPortForensics {
  port: number;
  holder: PortHolder | null;
  signature: { daimon: boolean; version?: string; pid?: number } | null;
  lockExists: boolean;
}

// opts.probeTimeoutMs (M91): the 1.5s default is a production-UX choice; test
// harnesses pass a generous ceiling so a contended host can't turn a slow-but-
// correct signature response into a false "no response" classification.
export async function inspectApiPort(port: number, lockExists: boolean, opts: { probeTimeoutMs?: number } = {}): Promise<ApiPortForensics> {
  const holder = findPortHolder(port);
  const signature = holder ? await probeDaimonSignature(port, opts.probeTimeoutMs ?? 1500) : null;
  return { port, holder, signature, lockExists };
}

// The exact startup-failure message M81 promises: who holds the api port,
// whether it answers as a daimon, and the remedy. One line per element so
// callers can prefix `[daimon]` or join for an Error message.
export function renderApiPortConflict(f: ApiPortForensics, crashDumpPath?: string | null): string[] {
  const lines: string[] = [];
  lines.push(`failed to bind api port 127.0.0.1:${f.port} (EADDRINUSE)`);
  if (f.holder) {
    const bits = [`holder: pid ${f.holder.pid}`];
    if (f.holder.name) bits.push(`(${f.holder.name})`);
    if (f.holder.startedAt) bits.push(`started ${f.holder.startedAt}`);
    if (f.signature?.daimon) {
      bits.push(`— responds as a daimon${f.signature.version ? ` v${f.signature.version}` : ''}${f.lockExists ? '' : ', no daemon.lock (orphan)'}`);
    } else if (f.signature && !f.signature.daimon) {
      bits.push('— does NOT respond as a daimon');
    } else {
      bits.push('— no response on the daimon signature endpoint');
    }
    lines.push(bits.join(' '));
    if (f.signature?.daimon && !f.lockExists) {
      lines.push(`remedy: run \`daimon doctor --auto-fix\` (terminates a verified orphan daimon), or kill pid ${f.holder.pid} yourself`);
    } else if (f.signature?.daimon && f.lockExists) {
      lines.push('remedy: a daemon is already running — use `daimon daemon stop` first, or talk to the running one');
    } else {
      lines.push(`remedy: something else owns this port — kill pid ${f.holder.pid} if it is unexpected, or change apiPort in daimon.config.json`);
    }
  } else {
    lines.push('holder: could not identify the owning process');
    lines.push('remedy: inspect with `netstat -ano` (Windows) / `lsof -iTCP -sTCP:LISTEN` (POSIX), or change apiPort in daimon.config.json');
  }
  if (crashDumpPath) lines.push(`crash dump: ${crashDumpPath}`);
  return lines;
}

export function describeHolder(port: number, h: PortHolder | null): string {
  if (!h) return `port ${port} already in use`;
  const parts: string[] = [`port ${port} in use by`];
  if (h.name) parts.push(h.name);
  parts.push(`(pid ${h.pid}`);
  if (h.cmd) parts[parts.length - 1] += `, cmd: ${h.cmd.slice(0, 120)}`;
  parts[parts.length - 1] += ')';
  return parts.join(' ');
}

export function killHolder(h: PortHolder): Promise<boolean> {
  return new Promise(resolve => {
    if (!h.pid || h.pid === process.pid) { resolve(false); return; }
    treeKill(h.pid, 'SIGTERM', err => {
      if (err) { setTimeout(() => treeKill(h.pid, 'SIGKILL', err2 => resolve(!err2)), 500); return; }
      resolve(true);
    });
  });
}
