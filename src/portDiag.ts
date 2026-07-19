import { spawnSync } from 'node:child_process';
import http from 'node:http';
import treeKill from 'tree-kill';
import { killHint, inspectPortCmd } from './platformRemedy.js';

export interface PortHolder {
  pid: number;
  name?: string;
  cmd?: string;
  // ISO-ish process start time when the platform reports it (M81 forensics).
  startedAt?: string;
}

// --- Injectable command-runner seam (M141) ---------------------------------
// Every OS-tool round-trip (netstat / ss / lsof / ps / PowerShell) goes through
// a CmdRunner so tests can feed RECORDED real output through the exact
// production parse path — no test-only fork of the parsing logic. The default
// runner is a real spawnSync, so production and the Windows suite are unchanged.
export interface CmdResult { status: number | null; stdout: string }
export type CmdRunner = (cmd: string, args: string[]) => CmdResult;

const defaultRunner: CmdRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '' };
};

// platform + run are injectable together: a test drives the linux/darwin branch
// on this Windows box by passing { platform: 'linux', run } with recorded output.
export interface PortProbeOpts { platform?: NodeJS.Platform; run?: CmdRunner }

// --- Pure parsers (M141): one per tool, fixture-exercised -------------------

// netstat -ano -p TCP  →  "  TCP    127.0.0.1:4999    0.0.0.0:0    LISTENING    12345"
export function parseNetstatListen(stdout: string, want: Set<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (want.has(port) && !out.has(port) && pid > 0) out.set(port, pid);
  }
  return out;
}

// ss -ltnp (Linux). Field-addressed, NOT free-regex-scanned: the local endpoint
// is the first whitespace field ending in ":<numeric-port>". This is robust
// whether or not a leading Netid column is present (iproute2 omits it for -t;
// BusyBox/container ss prints it), because Recv-Q/Send-Q have no colon, the
// header's "Address:Port" ends in letters, and a listener's Peer address ends
// in ":*" — so only the real local port matches. The old code used a single
// `[\s\][:](\d+)\s+…` regex that matched the Recv-Q column ("0") on every
// standard line and returned NOTHING on Linux (M140 bug — daimon ports was
// silently blind on its primary POSIX platform).
export function parseSsListen(stdout: string, want: Set<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let port: number | null = null;
    for (const field of line.split(/\s+/)) {
      const m = field.match(/:(\d+)$/);
      if (m) { port = Number(m[1]); break; }
    }
    if (port === null || !want.has(port) || out.has(port)) continue;
    const pidM = line.match(/pid=(\d+)/);
    out.set(port, pidM ? Number(pidM[1]) : 0);
  }
  return out;
}

// lsof -nP -iTCP -sTCP:LISTEN (macOS / any POSIX). NAME column ends "(LISTEN)".
export function parseLsofListen(stdout: string, want: Set<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('COMMAND')) continue;
    const cols = line.split(/\s+/);
    const pid = Number(cols[1]);
    const m = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (!m) continue;
    const port = Number(m[1]);
    if (want.has(port) && !out.has(port) && pid > 0) out.set(port, pid);
  }
  return out;
}

// lsof -nP -iTCP:<port> -sTCP:LISTEN  →  first holder row (COMMAND PID USER …).
export function parseLsofHolder(stdout: string): { pid: number; name?: string } | null {
  const lines = stdout.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('COMMAND'));
  if (!lines.length) return null;
  const cols = lines[0].split(/\s+/);
  const pid = Number(cols[1]);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, name: cols[0] || undefined };
}

// PowerShell Get-NetTCPConnection + Win32_Process → one compact JSON object.
export function parseWinHolder(stdout: string): PortHolder | null {
  const raw = (stdout || '').trim();
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

export function findPortHolder(port: number, opts: PortProbeOpts = {}): PortHolder | null {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  // `port` is interpolated into a PowerShell command string, so refuse anything
  // that isn't a plain positive integer rather than trust the `number` type
  // (a loosely-coerced request param could arrive as a non-numeric value).
  port = Number(port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (platform === 'win32') {
    // One PowerShell round-trip (each spawn costs ~1s): resolve the listening
    // pid AND its process identity in a single -Command.
    const script = `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Get-CimInstance Win32_Process -Filter "ProcessId=$p" | Select-Object -Property ProcessId,Name,CommandLine,@{n='StartedIso';e={$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')}} | ConvertTo-Json -Compress }`;
    const ps = run('powershell', ['-NoProfile', '-Command', script]);
    if (ps.status !== 0) return null;
    return parseWinHolder(ps.stdout);
  }
  const lsof = run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN']);
  if (lsof.status !== 0) return null;
  const holder = parseLsofHolder(lsof.stdout);
  if (!holder) return null;
  let startedAt: string | undefined;
  try {
    const ps = run('ps', ['-o', 'lstart=', '-p', String(holder.pid)]);
    const t = (ps.stdout || '').trim();
    if (ps.status === 0 && t) startedAt = t;
  } catch {}
  return { pid: holder.pid, name: holder.name, startedAt };
}

// One-shot listener scan (M81): which of `ports` have a LISTEN socket, and by
// which pid. One netstat/ss invocation for the whole set — findPortHolder's
// per-port PowerShell round-trip would be far too slow for a 100-port pool.
// Best-effort: returns an empty map when the platform tool is unavailable.
export function scanListeningPorts(ports: Iterable<number>, opts: PortProbeOpts = {}): Map<number, number> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  const want = new Set<number>();
  for (const p of ports) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n <= 65535) want.add(n);
  }
  const out = new Map<number, number>();
  if (!want.size) return out;
  try {
    if (platform === 'win32') {
      const r = run('netstat', ['-ano', '-p', 'TCP']);
      if (r.status !== 0) return out;
      return parseNetstatListen(r.stdout, want);
    }
    // POSIX: prefer ss (fast, ubiquitous on Linux); fall back to lsof (macOS).
    const ss = run('ss', ['-ltnp']);
    if (ss.status === 0 && ss.stdout.trim()) return parseSsListen(ss.stdout, want);
    const lsof = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    if (lsof.status === 0) return parseLsofListen(lsof.stdout, want);
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
export async function inspectApiPort(port: number, lockExists: boolean, opts: { probeTimeoutMs?: number } & PortProbeOpts = {}): Promise<ApiPortForensics> {
  const holder = findPortHolder(port, { platform: opts.platform, run: opts.run });
  const signature = holder ? await probeDaimonSignature(port, opts.probeTimeoutMs ?? 1500) : null;
  return { port, holder, signature, lockExists };
}

// The exact startup-failure message M81 promises: who holds the api port,
// whether it answers as a daimon, and the remedy. One line per element so
// callers can prefix `[daimon]` or join for an Error message.
export function renderApiPortConflict(f: ApiPortForensics, crashDumpPath?: string | null, platform: NodeJS.Platform = process.platform): string[] {
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
      lines.push(`remedy: run \`daimon doctor --auto-fix\` (terminates a verified orphan daimon), or run ${killHint(f.holder.pid, platform)} yourself`);
    } else if (f.signature?.daimon && f.lockExists) {
      lines.push('remedy: a daemon is already running — use `daimon daemon stop` first, or talk to the running one');
    } else {
      lines.push(`remedy: something else owns this port — run ${killHint(f.holder.pid, platform)} if it is unexpected, or change apiPort in daimon.config.json`);
    }
  } else {
    lines.push('holder: could not identify the owning process');
    lines.push(`remedy: inspect with \`${inspectPortCmd(f.port, platform)}\`, or change apiPort in daimon.config.json`);
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
