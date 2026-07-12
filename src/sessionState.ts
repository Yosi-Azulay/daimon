import fs from 'node:fs';
import path from 'node:path';
import type { AppStatus, ErrorEntry, LogEntry } from './types.js';
import { daimonDir } from './daemon.js';

// Session preservation (M55): the daemon periodically snapshots the
// recoverable parts of per-app state so a crash (kill -9) doesn't wipe error
// history, recent logs, and compile stats. Written with temp+rename so a
// crash mid-write leaves the previous snapshot intact.

const SESSION_PATH = () => path.join(daimonDir(), 'session-state.json');
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
  return SESSION_PATH();
}

export function saveSessionState(snapshot: SessionSnapshot, file = SESSION_PATH()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    // Keep a .bak of the last good snapshot (M88): loadSessionState falls
    // back to it when the main file won't parse, same as state.json.
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch {}
    fs.renameSync(tmp, file);
  } catch (err: any) {
    process.stderr.write(`[daimon] warning: session-state write failed: ${err?.message || err}\n`);
  }
}

function parseSessionState(raw: string, maxAgeMs: number, now: number): SessionSnapshot | null {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.apps)) return null;
  if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt > maxAgeMs) return null;
  return parsed as SessionSnapshot;
}

export function loadSessionState(file = SESSION_PATH(), maxAgeMs = MAX_AGE_MS, now = Date.now()): SessionSnapshot | null {
  try {
    const fromMain = parseSessionState(fs.readFileSync(file, 'utf8'), maxAgeMs, now);
    if (fromMain) return fromMain;
  } catch {}
  // Corrupt or missing main → last good .bak (M88). Session state is a cache
  // of errors/log tails, so a stale-but-parseable copy beats a silent reset.
  try {
    return parseSessionState(fs.readFileSync(file + '.bak', 'utf8'), maxAgeMs, now);
  } catch {
    return null;
  }
}
