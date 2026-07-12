import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DAIMON_VERSION } from './version.js';

export interface LockInfo {
  pid: number;
  apiPort: number;
  version: string;
  startedAt: number;
  headless: boolean;
  cwd?: string;
  configPath?: string;
}

// DAIMON_HOME (M79): first-class relocation of daimon's entire state dir --
// lock, config, history DB, logs, plugins, snapshots, sessions. Read per call
// (not cached at module load) so test harnesses can isolate ~/.daimon without
// HOME/USERPROFILE games.
export function daimonDir(): string {
  const env = process.env.DAIMON_HOME?.trim();
  return env ? path.resolve(env) : path.join(os.homedir(), '.daimon');
}

export function lockPath(): string {
  return path.join(daimonDir(), 'daemon.lock');
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err && err.code === 'EPERM';
  }
}

export function readLock(): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath(), 'utf8');
    const info = JSON.parse(raw) as LockInfo;
    if (!info || typeof info.pid !== 'number') return null;
    if (!isPidAlive(info.pid)) {
      try { fs.unlinkSync(lockPath()); } catch {}
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export function writeLock(info: LockInfo): void {
  fs.mkdirSync(daimonDir(), { recursive: true });
  const tmp = lockPath() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info));
  fs.renameSync(tmp, lockPath());
}

export function removeLock(): void {
  try { fs.unlinkSync(lockPath()); } catch {}
}

function resolveMainJs(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'main.js');
}

export async function spawnDetached(opts: { port?: number } = {}): Promise<LockInfo> {
  const env = { ...process.env };
  if (opts.port) env.DAIMON_PORT = String(opts.port);
  const child = spawn(process.execPath, [resolveMainJs(), '--headless'], {
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: true,
  });
  child.unref();
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const info = readLock();
    if (info && (!opts.port || info.apiPort === opts.port)) return info;
    await new Promise(r => setTimeout(r, 100));
  }
  // The detached child's stderr is discarded, but its startup forensics
  // (M81: EADDRINUSE holder identity + remedy) land in a crash dump — surface
  // that instead of the bare v0.12-era "failed to start within 5s".
  const dump = newestCrashDumpSince(start - 2000);
  if (dump) {
    const gist = crashDumpGist(dump);
    throw new Error(`daemon failed to start within 5s${gist ? ` — ${gist}` : ''}; crash dump: ${dump}`);
  }
  throw new Error('daemon failed to start within 5s');
}

function newestCrashDumpSince(sinceMs: number): string | null {
  try {
    const dir = path.join(daimonDir(), 'crashes');
    let best: { file: string; mtime: number } | null = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.txt')) continue;
      const full = path.join(dir, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime >= sinceMs && (!best || mtime > best.mtime)) best = { file: full, mtime };
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

// Pull the human-relevant forensic lines (bind failure, holder identity,
// remedy) out of a crash dump so the CLI error names the pid directly.
function crashDumpGist(file: string): string | null {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000).split(/\r?\n/);
    const hits = head.filter(l => /EADDRINUSE|holder:|remedy:/i.test(l)).map(l => l.trim());
    return hits.length ? hits.slice(0, 3).join(' · ') : null;
  } catch {
    return null;
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

export function buildLockInfo(apiPort: number, headless: boolean, configPath?: string): LockInfo {
  return {
    pid: process.pid,
    apiPort,
    version: DAIMON_VERSION,
    startedAt: Date.now(),
    headless,
    cwd: process.cwd(),
    configPath,
  };
}

