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
  // Quarantine first-seen (M130, v1.7): pattern → first-seen ts. Powers
  // "oldest since <date>" so a parked test can't rot invisibly. Additive.
  quarantineFirstSeen?: Record<string, number>;
  // "While you were away" acknowledgement (M135, v1.8): the ts through which
  // the away summary has been dismissed. Refines the gap baseline so a dismissed
  // summary never re-nags on re-attach. Additive; absent = never acknowledged.
  awayAck?: number;
  // First-attach TUI hint (M170, v1.14): the ts at which the "press ? for
  // help" line was shown. Present = shown once already, never show it again.
  // Additive; absent = this machine has never attached the TUI.
  tuiHintSeen?: number;
  // Saved searches (M181, v1.16): named query strings, and NOTHING else.
  // INERT BY CONSTRUCTION — no schedule, no notification kind, no hook: a
  // saved search runs when a human runs it, never on a timer (the no-cron
  // rule). Stored as a list so order is stable and a rename is a rewrite of
  // one row. Additive; absent = none saved.
  savedSearches?: SavedSearch[];
}

export interface SavedSearch {
  name: string;
  query: string;
  createdMs: number;
  updatedMs: number;
}

// Saved searches are user data written by another daimon version, so parsing
// is defensive: a malformed row is DROPPED, never fabricated and never fatal
// (the fail-soft rule that governs every other reader of user state).
function parseSavedSearches(v: unknown): SavedSearch[] | null {
  if (!Array.isArray(v)) return null;
  const out: SavedSearch[] = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name.trim()) continue;
    if (typeof r.query !== 'string' || !r.query.trim()) continue;
    out.push({
      name: r.name,
      query: r.query,
      createdMs: typeof r.createdMs === 'number' ? r.createdMs : 0,
      updatedMs: typeof r.updatedMs === 'number' ? r.updatedMs : 0,
    });
  }
  return out;
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
      ...(parsed.quarantineFirstSeen && typeof parsed.quarantineFirstSeen === 'object' ? { quarantineFirstSeen: parsed.quarantineFirstSeen } : {}),
      ...(typeof parsed.awayAck === 'number' ? { awayAck: parsed.awayAck } : {}),
      ...(typeof parsed.tuiHintSeen === 'number' ? { tuiHintSeen: parsed.tuiHintSeen } : {}),
      ...(parsed.savedSearches ? { savedSearches: parseSavedSearches(parsed.savedSearches) ?? [] } : {}),
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

/**
 * The state this process is working from, WITHOUT re-reading the file.
 *
 * Callers that only need to read (the saved-searches routes, M181) must use
 * this rather than loadPersistedState(): a reload replaces the in-memory
 * `current` that savePersistedState merges into, so a reload racing the 500ms
 * debounce would quietly drop the write that is still pending. Loading once,
 * on first use, keeps the merge-write invariant intact.
 */
export function currentPersistedState(): PersistedState {
  return current ? { ...current } : loadPersistedState();
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
