import fs from 'node:fs';
import path from 'node:path';
import { daimonDir } from './daemon.js';
import type { Registry } from './registry.js';

interface Handoff {
  ts: number;
  apps: { name: string; port: number }[];
}

function handoffPath(): string {
  return path.join(daimonDir(), 'state-handoff.json');
}

export function writeHandoff(registry: Registry): string {
  const apps: { name: string; port: number }[] = [];
  for (const name of registry.names()) {
    const s = registry.getState(name);
    if (!s) continue;
    if ((s.status === 'serving' || s.status === 'compiling' || s.status === 'starting') && s.port) {
      apps.push({ name, port: s.port });
    }
  }
  const data: Handoff = { ts: Date.now(), apps };
  const p = handoffPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic temp+rename: the handoff is written by the outgoing daemon and read
  // by the incoming one across a process boundary, so a plain in-place write can
  // be observed half-complete (JSON.parse throws → apps aren't re-adopted).
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
  return p;
}

export function consumeHandoff(maxAgeMs = 60_000): Handoff | null {
  const p = handoffPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw) as Handoff;
    fs.unlinkSync(p);
    if (!data || typeof data.ts !== 'number') return null;
    if (Date.now() - data.ts > maxAgeMs) return null;
    return data;
  } catch {
    return null;
  }
}
