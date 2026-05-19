import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readLock, removeLock, lockPath, spawnDetached, waitForExit } from './daemon.js';
import { configLookupPaths, loadConfig } from './config.js';
import { History } from './history.js';

export type AutoFixName = 'orphan-daemon' | 'stale-lock' | 'missing-search-root' | 'corrupt-history-db';

export const ALL_AUTO_FIX: AutoFixName[] = ['orphan-daemon', 'stale-lock', 'missing-search-root', 'corrupt-history-db'];

export interface RoutineResult {
  name: AutoFixName;
  detected: boolean;
  description: string;
}

export interface RunResult {
  ran: RoutineResult[];
  skipped: RoutineResult[];
  errors: { name: AutoFixName; error: string }[];
}

function detectOrphan(): { detected: boolean; description: string; lockCwd?: string } {
  const lock = readLock();
  if (!lock) return { detected: false, description: 'no daemon running' };
  const here = process.cwd();
  const localCfg = path.join(here, 'daimon.config.json');
  if (!fs.existsSync(localCfg)) return { detected: false, description: 'no local daimon.config.json in cwd' };
  const lockCwd = lock.cwd;
  const lockCfg = lock.configPath;
  const sameCwd = lockCwd && path.resolve(lockCwd) === path.resolve(here);
  const sameCfg = lockCfg && path.resolve(lockCfg) === path.resolve(localCfg);
  if (sameCwd || sameCfg) return { detected: false, description: 'daemon already running from this cwd/config' };
  return {
    detected: true,
    description: `daemon (pid ${lock.pid}) is running from ${lockCwd ?? '(unknown)'} but local daimon.config.json exists at ${here}`,
    lockCwd,
  };
}

async function fixOrphan(): Promise<string> {
  const lock = readLock();
  if (!lock) return 'no daemon running; nothing to do';
  try { await fetch(`http://127.0.0.1:${lock.apiPort}/api/snapshot-state`, { method: 'POST' }); } catch {}
  try { await fetch(`http://127.0.0.1:${lock.apiPort}/api/shutdown`, { method: 'POST' }); } catch {}
  await waitForExit(lock.pid, 5000);
  removeLock();
  const info = await spawnDetached({});
  return `respawned daemon at pid ${info.pid} from ${process.cwd()}; previous pid ${lock.pid} (cwd ${lock.cwd ?? 'unknown'}) was shut down with state handoff. To undo: stop with 'daimon daemon stop' and start from the prior directory.`;
}

function detectStaleLock(): { detected: boolean; description: string } {
  let raw: string;
  try { raw = fs.readFileSync(lockPath(), 'utf8'); } catch { return { detected: false, description: 'no lock file present' }; }
  let info: any;
  try { info = JSON.parse(raw); } catch { return { detected: true, description: 'lock file is malformed JSON' }; }
  if (!info || typeof info.pid !== 'number') return { detected: true, description: 'lock file has no pid' };
  try { process.kill(info.pid, 0); return { detected: false, description: `lock file owner pid ${info.pid} is alive` }; }
  catch (err: any) {
    if (err?.code === 'EPERM') return { detected: false, description: `lock file owner pid ${info.pid} alive (EPERM)` };
    return { detected: true, description: `lock file claims pid ${info.pid} but the process is gone` };
  }
}

async function fixStaleLock(): Promise<string> {
  let prior = '(unknown)';
  try { const raw = JSON.parse(fs.readFileSync(lockPath(), 'utf8')); prior = String(raw?.pid ?? '?'); } catch {}
  removeLock();
  const info = await spawnDetached({});
  return `removed stale ${lockPath()} (prior pid ${prior} was dead); spawned fresh daemon at pid ${info.pid}.`;
}

function detectMissingSearchRoot(): { detected: boolean; description: string; markerFiles?: string[] } {
  const here = process.cwd();
  const markers = ['nx.json', 'angular.json', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', '.storybook'];
  const found = markers.filter(m => fs.existsSync(path.join(here, m)));
  if (!found.length) return { detected: false, description: 'no nx.json/angular.json/vite.config.*/.storybook in cwd' };
  const r = loadConfig();
  if (r.kind !== 'loaded') return { detected: true, description: `${found.join(', ')} present but no config is loaded`, markerFiles: found };
  const roots = r.config.searchRoots.map(sr => path.resolve(typeof sr === 'string' ? sr : sr.path));
  const covered = roots.some(rp => here.startsWith(rp));
  if (covered) return { detected: false, description: `${found.join(', ')} present and a configured searchRoot covers ${here}` };
  return { detected: true, description: `${found.join(', ')} present in ${here} but no searchRoot covers it`, markerFiles: found };
}

function fixMissingSearchRoot(): string {
  const here = process.cwd();
  const { local, user } = configLookupPaths();
  const target = fs.existsSync(local) ? local : user;
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
  raw.searchRoots = Array.isArray(raw.searchRoots) ? raw.searchRoots : [];
  if (!raw.searchRoots.some((sr: any) => (typeof sr === 'string' ? sr : sr?.path) === here)) {
    let label: string | undefined;
    try { const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')); if (typeof pkg.name === 'string') label = pkg.name; } catch {}
    raw.searchRoots.push(label ? { path: here, label } : here);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  const lock = readLock();
  if (lock) {
    try { void fetch(`http://127.0.0.1:${lock.apiPort}/api/config/reload`, { method: 'POST' }); } catch {}
  }
  return `appended ${here} as a searchRoot in ${target}; triggered soft-reload of the running daemon.`;
}

function detectCorruptHistoryDb(): { detected: boolean; description: string; dbPath?: string } {
  const r = loadConfig();
  if (r.kind !== 'loaded' || !r.config.history.enabled) return { detected: false, description: 'history disabled' };
  const p = r.config.history.path;
  if (!fs.existsSync(p)) return { detected: false, description: 'history db does not exist (will be created on next start)' };
  try {
    const h = new History(r.config.history);
    const ok = h.quickCheck();
    h.close();
    if (!ok) return { detected: true, description: `quick_check failed on ${p}`, dbPath: p };
    return { detected: false, description: 'history db quick_check passed' };
  } catch (err: any) {
    return { detected: true, description: `cannot open ${p}: ${err?.message ?? String(err)}`, dbPath: p };
  }
}

function fixCorruptHistoryDb(): string {
  const r = loadConfig();
  if (r.kind !== 'loaded') return 'no config; cannot determine history path';
  const p = r.config.history.path;
  const rotated = `${p}.corrupt-${Date.now()}`;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.renameSync(p + suffix, rotated + suffix); } catch {}
  }
  return `rotated ${p} → ${rotated} (and -wal/-shm siblings). The daemon will rebuild an empty history db on next start.`;
}

const ROUTINES: Record<AutoFixName, { detect: () => any | Promise<any>; fix: () => string | Promise<string> }> = {
  'orphan-daemon': { detect: detectOrphan, fix: fixOrphan },
  'stale-lock': { detect: detectStaleLock, fix: fixStaleLock },
  'missing-search-root': { detect: detectMissingSearchRoot, fix: fixMissingSearchRoot },
  'corrupt-history-db': { detect: detectCorruptHistoryDb, fix: fixCorruptHistoryDb },
};

export async function runAutoFix(opts: { permitted: AutoFixName[]; dryRun?: boolean }): Promise<RunResult> {
  const result: RunResult = { ran: [], skipped: [], errors: [] };
  for (const name of ALL_AUTO_FIX) {
    if (!opts.permitted.includes(name)) continue;
    const r = ROUTINES[name];
    let det: any;
    try { det = await r.detect(); } catch (err: any) { result.errors.push({ name, error: err?.message ?? String(err) }); continue; }
    if (!det.detected) { result.skipped.push({ name, detected: false, description: det.description }); continue; }
    if (opts.dryRun) { result.ran.push({ name, detected: true, description: `(dry-run) would fix: ${det.description}` }); continue; }
    try {
      const desc = await r.fix();
      result.ran.push({ name, detected: true, description: `${det.description} — ${desc}` });
    } catch (err: any) {
      result.errors.push({ name, error: err?.message ?? String(err) });
    }
  }
  return result;
}

void os;
