import crypto from 'node:crypto';
import type { AppState, ErrorEntry, ParsedError } from './types.js';

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

const TS_CODE_RX = /\berror TS(\d+)/;
const ESBUILD_TS_RX = /✘\s*\[ERROR\]\s*TS(\d+)/;
const LOCATION_RX = /([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte)):(\d+):(\d+)/;

function hashLine(line: string): string {
  return crypto.createHash('sha1').update(line).digest('hex').slice(0, 16);
}

function parseStructured(line: string): ParsedError {
  const out: ParsedError = { message: line };
  const codeMatch = line.match(ESBUILD_TS_RX) || line.match(TS_CODE_RX);
  if (codeMatch) out.code = `TS${codeMatch[1]}`;
  const locMatch = line.match(LOCATION_RX);
  if (locMatch) {
    out.file = locMatch[1];
    out.line = Number(locMatch[2]);
    out.col = Number(locMatch[3]);
  }
  return out;
}

export interface ParseResult {
  statusChanged: boolean;
  error?: { entry: ErrorEntry; isNew: boolean };
}

export function parseLine(state: AppState, line: string): ParseResult | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const prev = state.status;
  let statusChanged = false;

  if (SERVING_PATTERNS.some(rx => rx.test(trimmed))) {
    if (state.status === 'compiling' || state.status === 'starting') {
      const now = Date.now();
      if (state.compileStartedAt != null) {
        const compileMs = now - state.compileStartedAt;
        state.lastCompileMs = compileMs;
        state.lastCompileAt = now;
        state.compileStartedAt = null;
        state.compileHistory.push(compileMs);
        if (state.compileHistory.length > 20) {
          state.compileHistory.splice(0, state.compileHistory.length - 20);
        }
      }
    }
    state.status = 'serving';
  } else if (COMPILING_PATTERNS.some(rx => rx.test(trimmed))) {
    if (state.status === 'starting' || state.status === 'serving') {
      state.compileStartedAt = Date.now();
      state.status = 'compiling';
    }
  }

  let errorResult: ParseResult['error'];
  if (ERROR_PATTERNS.some(rx => rx.test(trimmed))) {
    const hash = hashLine(trimmed);
    const now = Date.now();
    const existing = state.errors.get(hash);
    let isNew = false;
    let entry: ErrorEntry;
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      entry = existing;
    } else {
      entry = {
        message: trimmed,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        parsed: parseStructured(trimmed),
      };
      state.errors.set(hash, entry);
      isNew = true;
    }
    errorResult = { entry, isNew };
    state.status = 'error';
  }

  statusChanged = state.status !== prev;
  return { statusChanged, error: errorResult };
}
