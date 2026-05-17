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
}

const DAIMON_DIR = path.join(os.homedir(), '.daimon');
const LOCK_PATH = path.join(DAIMON_DIR, 'daemon.lock');

export function daimonDir(): string {
  return DAIMON_DIR;
}

export function lockPath(): string {
  return LOCK_PATH;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err && err.code === 'EPERM';
  }
}

export function readLock(): LockInfo | null {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8');
    const info = JSON.parse(raw) as LockInfo;
    if (!info || typeof info.pid !== 'number') return null;
    if (!isPidAlive(info.pid)) {
      try { fs.unlinkSync(LOCK_PATH); } catch {}
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export function writeLock(info: LockInfo): void {
  fs.mkdirSync(DAIMON_DIR, { recursive: true });
  const tmp = LOCK_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info));
  fs.renameSync(tmp, LOCK_PATH);
}

export function removeLock(): void {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
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
  throw new Error('daemon failed to start within 5s');
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

export function buildLockInfo(apiPort: number, headless: boolean): LockInfo {
  return {
    pid: process.pid,
    apiPort,
    version: DAIMON_VERSION,
    startedAt: Date.now(),
    headless,
  };
}
