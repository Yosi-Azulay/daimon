import fs from 'node:fs';
import path from 'node:path';
import { daimonDir } from './daemon.js';
import { scanListeningPorts } from './portDiag.js';
import type { Registry } from './registry.js';

// Daemon handoff (M88). `daimon daemon restart` asks the outgoing daemon to
// write this file, then shuts it down WITHOUT killing managed children (the
// registry's handoff-pending flag suppresses stopAll). The incoming daemon
// consumes the file and re-adopts each child it can verify — pid alive AND the
// announced port listening. Anything unverifiable is reported (status
// 'orphaned' with a remedy), never silently dropped and never blindly killed.

export interface HandoffApp {
  name: string;
  port: number;
  // pid/startedAt absent in pre-v0.14 handoff files: consumers treat that as
  // the legacy contract (children were killed; restart them fresh).
  pid?: number | null;
  startedAt?: number | null;
}

interface Handoff {
  ts: number;
  apps: HandoffApp[];
}

function handoffPath(): string {
  return path.join(daimonDir(), 'state-handoff.json');
}

export function writeHandoff(registry: Registry): string {
  const running: { name: string; port: number; startedAt: number | null; spawnPid: number | null }[] = [];
  for (const name of registry.names()) {
    const s = registry.getState(name);
    if (!s) continue;
    if ((s.status === 'serving' || s.status === 'compiling' || s.status === 'starting') && s.port) {
      running.push({ name, port: s.port, startedAt: s.startedAt ?? null, spawnPid: s.pid ?? null });
    }
  }
  // Record the pid actually LISTENING on each app's port, not the spawn
  // (shell/npm wrapper) pid: on Windows the wrapper dies with the daemon's
  // stdio pipes while the real server survives. Snapshot time is the one
  // moment we can positively bind pid↔port — the incoming daemon verifies the
  // same pair before adopting. One netstat/ss pass for all apps (findPortHolder
  // would cost ~1s of PowerShell per app on Windows).
  let listeners = new Map<number, number>();
  try { listeners = scanListeningPorts(running.map(r => r.port)); } catch {}
  const apps: HandoffApp[] = running.map(r => ({
    name: r.name,
    port: r.port,
    pid: listeners.get(r.port) ?? r.spawnPid,
    startedAt: r.startedAt,
  }));
  // Arm the handoff window: the next shutdown (within 60s) leaves children
  // running for the incoming daemon to re-adopt.
  registry.beginHandoff();
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
