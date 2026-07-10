import fs from 'node:fs';
import path from 'node:path';
import { daimonDir } from './daemon.js';

export interface CursorsFile {
  errors: Record<string, number>;
}

const cursorsPath = () => path.join(daimonDir(), 'cursors.json');

function load(): CursorsFile {
  try {
    const raw = fs.readFileSync(cursorsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.errors && typeof parsed.errors === 'object') {
      return { errors: parsed.errors };
    }
  } catch {}
  return { errors: {} };
}

let writeTimer: NodeJS.Timeout | null = null;
let pending: CursorsFile | null = null;
function scheduleSave(data: CursorsFile): void {
  pending = data;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const toWrite = pending;
    pending = null;
    if (!toWrite) return;
    try {
      fs.mkdirSync(path.dirname(cursorsPath()), { recursive: true });
      fs.writeFileSync(cursorsPath(), JSON.stringify(toWrite), 'utf8');
    } catch (err: any) {
      process.stderr.write(`[daimon] warning: cursor write failed: ${err.message}\n`);
    }
  }, 500);
}

export class Cursors {
  private data: CursorsFile = load();

  getErrorCursor(client: string, app: string): number {
    return this.data.errors[`${client}:${app}`] ?? 0;
  }

  setErrorCursor(client: string, app: string, ts: number): void {
    this.data.errors[`${client}:${app}`] = ts;
    scheduleSave(this.data);
  }
}
