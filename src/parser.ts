import crypto from 'node:crypto';
import type { AppState, AppStatus } from './types.js';

const SERVING_PATTERNS = [
  /Local:\s+http/i,
  /Application bundle generation complete/i,
  /compiled successfully/i,
  /webpack compiled/i,
  /Angular Live Development Server is listening/i,
];

const COMPILING_PATTERNS = [
  /Building\.\.\./i,
  /Compilation started/i,
  /Initial chunk files/i,
  /Compiling/i,
];

const ERROR_PATTERNS = [
  /^\s*ERROR\b/,
  /\berror TS\d+/,
  /✘/,
  /\[ERROR\]/,
  /Cannot find module/i,
];

function hashLine(line: string): string {
  return crypto.createHash('sha1').update(line).digest('hex').slice(0, 16);
}

export function parseLine(state: AppState, line: string): AppStatus | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let newStatus: AppStatus | null = null;

  if (SERVING_PATTERNS.some(rx => rx.test(trimmed))) {
    if (state.status === 'compiling' || state.status === 'starting') {
      const now = Date.now();
      if (state.compileStartedAt != null) {
        state.lastCompileMs = now - state.compileStartedAt;
        state.lastCompileAt = now;
        state.compileStartedAt = null;
      }
    }
    newStatus = 'serving';
  } else if (COMPILING_PATTERNS.some(rx => rx.test(trimmed))) {
    if (state.status === 'starting' || state.status === 'serving') {
      state.compileStartedAt = Date.now();
      newStatus = 'compiling';
    }
  }

  if (ERROR_PATTERNS.some(rx => rx.test(trimmed))) {
    const hash = hashLine(trimmed);
    const now = Date.now();
    const existing = state.errors.get(hash);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
    } else {
      state.errors.set(hash, {
        message: trimmed,
        count: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }
    newStatus = 'error';
  }

  if (newStatus) state.status = newStatus;
  return newStatus;
}
