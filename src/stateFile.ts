import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_PATH = path.join(os.homedir(), '.daimon', 'state.json');

export interface PersistedState {
  ports: Record<string, number>;
}

export function loadPersistedState(): PersistedState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.ports && typeof parsed.ports === 'object') {
      return { ports: parsed.ports };
    }
  } catch {}
  return { ports: {} };
}

let timer: NodeJS.Timeout | null = null;
let pending: PersistedState | null = null;

export function savePersistedState(state: PersistedState): void {
  pending = state;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const toWrite = pending;
    pending = null;
    if (!toWrite) return;
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify(toWrite), 'utf8');
    } catch (err: any) {
      process.stderr.write(`[daimon] warning: state write failed: ${err.message}\n`);
    }
  }, 500);
}
