import fs from 'node:fs';
import path from 'node:path';
import { daimonDir } from './daemon.js';

const STATE_PATH = () => path.join(daimonDir(), 'state.json');

export interface PersistedState {
  ports: Record<string, number>;
}

export function loadPersistedState(): PersistedState {
  try {
    const raw = fs.readFileSync(STATE_PATH(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.ports && typeof parsed.ports === 'object') {
      return { ports: parsed.ports };
    }
  } catch {}
  return { ports: {} };
}

let timer: NodeJS.Timeout | null = null;
let pending: PersistedState | null = null;

function writeNow(state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH()), { recursive: true });
    // Atomic temp+rename so a crash mid-write can't leave a truncated
    // state.json — a half-written file fails JSON.parse on load and silently
    // resets every persisted port assignment.
    const tmp = STATE_PATH() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, STATE_PATH());
  } catch (err: any) {
    process.stderr.write(`[daimon] warning: state write failed: ${err.message}\n`);
  }
}

export function savePersistedState(state: PersistedState): void {
  pending = state;
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
