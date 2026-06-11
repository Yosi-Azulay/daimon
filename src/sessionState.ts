import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppStatus, ErrorEntry, LogEntry } from './types.js';

// Session preservation (M55): the daemon periodically snapshots the
// recoverable parts of per-app state so a crash (kill -9) doesn't wipe error
// history, recent logs, and compile stats. Written with temp+rename so a
// crash mid-write leaves the previous snapshot intact.

const SESSION_PATH = path.join(os.homedir(), '.daimon', 'session-state.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionAppState {
  name: string;
  status: AppStatus;
  port: number | null;
  errors: ErrorEntry[];
  logTail: LogEntry[];
  compileHistory: number[];
}

export interface SessionSnapshot {
  savedAt: number;
  apps: SessionAppState[];
}

export function sessionStatePath(): string {
  return SESSION_PATH;
}

export function saveSessionState(snapshot: SessionSnapshot, file = SESSION_PATH): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err: any) {
    process.stderr.write(`[daimon] warning: session-state write failed: ${err?.message || err}\n`);
  }
}

export function loadSessionState(file = SESSION_PATH, maxAgeMs = MAX_AGE_MS, now = Date.now()): SessionSnapshot | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.apps)) return null;
    if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt > maxAgeMs) return null;
    return parsed as SessionSnapshot;
  } catch {
    return null;
  }
}
