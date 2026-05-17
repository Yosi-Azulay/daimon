import { spawnSync } from 'node:child_process';
import treeKill from 'tree-kill';

export interface PortHolder {
  pid: number;
  name?: string;
  cmd?: string;
}

export function findPortHolder(port: number): PortHolder | null {
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8', windowsHide: true });
    if (ps.status !== 0) return null;
    const pid = Number((ps.stdout || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    const proc = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -Property Name,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
    let name: string | undefined;
    let cmd: string | undefined;
    try {
      const obj = JSON.parse((proc.stdout || '').trim() || '{}');
      name = typeof obj.Name === 'string' ? obj.Name : undefined;
      cmd = typeof obj.CommandLine === 'string' ? obj.CommandLine : undefined;
    } catch {}
    return { pid, name, cmd };
  }
  const lsof = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (lsof.status !== 0) return null;
  const lines = (lsof.stdout || '').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('COMMAND'));
  if (!lines.length) return null;
  const cols = lines[0].split(/\s+/);
  const pid = Number(cols[1]);
  return { pid, name: cols[0] };
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
