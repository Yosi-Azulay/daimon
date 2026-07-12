import fs from 'node:fs';
import path from 'node:path';
import { daimonDir } from './daemon.js';

const STATE_PATH = () => path.join(daimonDir(), 'state.json');

export interface PersistedState {
  ports: Record<string, number>;
  // Per-app notification mutes (M84): app → until-ts, or null = indefinite.
  mutes?: Record<string, number | null>;
  // Scheduled digest bookkeeping (M84): webhook url → last-sent ts. Guards
  // the "catch-up once, never more than one per day" rule across restarts.
  digests?: Record<string, number>;
}

// What the last loadPersistedState() had to do to produce a usable state
// (M88). Mirrors History.archivedCorruptDbPath(): main.ts reads this after
// boot and records a self-warn event so recovery is never silent.
export interface StateLoadDiagnostics {
  recoveredFromBak: boolean;
  archivedCorruptPath: string | null;
}

let lastDiagnostics: StateLoadDiagnostics = { recoveredFromBak: false, archivedCorruptPath: null };

export function stateLoadDiagnostics(): StateLoadDiagnostics {
  return { ...lastDiagnostics };
}

// Last full state seen by this process — savePersistedState merges partial
// updates into it so the ports writer can't clobber mutes and vice versa.
let current: PersistedState | null = null;

function parseState(raw: string): PersistedState | null {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && parsed.ports && typeof parsed.ports === 'object') {
    return {
      ports: parsed.ports,
      ...(parsed.mutes && typeof parsed.mutes === 'object' ? { mutes: parsed.mutes } : {}),
      ...(parsed.digests && typeof parsed.digests === 'object' ? { digests: parsed.digests } : {}),
    };
  }
  return null;
}

// Load order (M88): state.json → state.json.bak → archive-corrupt + fresh.
// A recovered or archived load is reported via stateLoadDiagnostics() so the
// daemon can emit a self-warn event — never a silent reset.
export function loadPersistedState(): PersistedState {
  lastDiagnostics = { recoveredFromBak: false, archivedCorruptPath: null };
  const p = STATE_PATH();
  const mainExists = fs.existsSync(p);
  try {
    const state = parseState(fs.readFileSync(p, 'utf8'));
    if (state) {
      current = state;
      return { ...current };
    }
  } catch {}
  // Main is missing or corrupt — try the .bak of the last good write.
  try {
    const state = parseState(fs.readFileSync(p + '.bak', 'utf8'));
    if (state) {
      lastDiagnostics.recoveredFromBak = true;
      current = state;
      // Move the corrupt main aside BEFORE the heal-write: writeNow copies
      // main → .bak, which would clobber the good .bak with the corrupt file.
      if (mainExists) {
        try { fs.renameSync(p, p + '.corrupt-' + Date.now()); } catch {}
      }
      try { writeNow(state); } catch {}
      return { ...current };
    }
  } catch {}
  // Both unreadable. Archive the corrupt main (if any) for forensics — same
  // convention as history.db.corrupt-<ts> — and start fresh.
  if (mainExists) {
    const archived = p + '.corrupt-' + Date.now();
    try {
      fs.renameSync(p, archived);
      lastDiagnostics.archivedCorruptPath = archived;
    } catch {}
  }
  current = { ports: {} };
  return { ...current };
}

let timer: NodeJS.Timeout | null = null;
let pending: PersistedState | null = null;

function writeNow(state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH()), { recursive: true });
    // Atomic temp+rename so a crash mid-write can't leave a truncated
    // state.json, plus a .bak of the last good version taken BEFORE the
    // rename — loadPersistedState falls back to it when main won't parse.
    const p = STATE_PATH();
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak'); } catch {}
    fs.renameSync(tmp, p);
  } catch (err: any) {
    process.stderr.write(`[daimon] warning: state write failed: ${err.message}\n`);
  }
}

export function savePersistedState(state: Partial<PersistedState>): void {
  current = { ports: {}, ...(current ?? {}), ...state };
  pending = current;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const toWrite = pending;
    pending = null;
    if (!toWrite) return;
    writeNow(toWrite);
  }, 500);
}

// Flush any debounced pending write synchronously — call on clean shutdown so
// port changes made in the last 500ms aren't lost.
export function flushPersistedState(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  const toWrite = pending;
  pending = null;
  if (toWrite) writeNow(toWrite);
}
