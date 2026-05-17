import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SessionOp {
  ts: number;
  kind: 'start' | 'stop' | 'restart' | 'run';
  app: string;
  task?: string;
  args?: string[];
}

export class SessionRecorder {
  private file: string | null = null;
  private startTs = 0;

  isRecording(): boolean { return this.file != null; }

  start(): { path: string } {
    if (this.file) return { path: this.file };
    const dir = path.join(os.homedir(), '.daimon', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    fs.writeFileSync(f, '');
    this.file = f;
    this.startTs = Date.now();
    return { path: f };
  }

  stop(): { path: string | null } {
    const out = { path: this.file };
    this.file = null;
    this.startTs = 0;
    return out;
  }

  append(op: Omit<SessionOp, 'ts'>): void {
    if (!this.file) return;
    const line = JSON.stringify({ ts: Date.now() - this.startTs, ...op }) + '\n';
    try { fs.appendFileSync(this.file, line); } catch {}
  }
}

export function readSession(file: string): SessionOp[] {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
}
