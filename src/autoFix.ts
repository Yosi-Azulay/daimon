import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readLock, removeLock, lockPath, spawnDetached, waitForExit } from './daemon.js';
import { configLookupPaths, loadConfig } from './config.js';
import { History } from './history.js';
import { isPortFree } from './ports.js';
import { discoverApps } from './discovery.js';
import { profileProbePath } from './healthProfiles.js';
import { generateAgentId } from './agents.js';

// Doctor-initiated daemon calls must carry the agent id like every other
// caller, so the audit trail shows who triggered restarts/reloads.
function agentFetch(url: string): Promise<unknown> {
  return fetch(url, {
    method: 'POST',
    headers: { 'x-daimon-agent': generateAgentId(), 'x-daimon-cwd': process.cwd() },
  });
}

export type AutoFixName =
  | 'orphan-daemon'
  | 'stale-lock'
  | 'missing-search-root'
  | 'corrupt-history-db'
  | 'port-conflict-pred'
  | 'node-version-mismatch'
  | 'orphan-node-modules'
  | 'orphan-venv'
  | 'orphan-bundler-cache'
  | 'orphan-cargo-target'
  | 'dead-search-root'
  | 'health-probe-missing';

export const ALL_AUTO_FIX: AutoFixName[] = [
  'orphan-daemon',
  'stale-lock',
  'missing-search-root',
  'corrupt-history-db',
  'port-conflict-pred',
  'node-version-mismatch',
  'orphan-node-modules',
  'orphan-venv',
  'orphan-bundler-cache',
  'orphan-cargo-target',
  'dead-search-root',
  'health-probe-missing',
];

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
  try { await agentFetch(`http://127.0.0.1:${lock.apiPort}/api/snapshot-state`); } catch {}
  try { await agentFetch(`http://127.0.0.1:${lock.apiPort}/api/shutdown`); } catch {}
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
    try { void agentFetch(`http://127.0.0.1:${lock.apiPort}/api/config/reload`); } catch {}
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

async function detectPortConflict(): Promise<{ detected: boolean; description: string; conflicts?: number[] }> {
  const r = loadConfig();
  if (r.kind !== 'loaded') return { detected: false, description: 'no config loaded' };
  const [lo, hi] = r.config.portRange ?? [4200, 4299];
  const overrides = r.config.overrides ?? {};
  const pinned = Object.values(overrides).map(o => o.port).filter((p): p is number => typeof p === 'number');
  const candidates = Array.from(new Set([...pinned, lo, hi]));
  const conflicts: number[] = [];
  for (const p of candidates) {
    if (!Number.isFinite(p) || p <= 0) continue;
    try { if (!(await isPortFree(p))) conflicts.push(p); } catch {}
  }
  if (!conflicts.length) return { detected: false, description: `all checked ports free (range ${lo}-${hi} + pinned)` };
  return { detected: true, description: `ports already LISTEN: ${conflicts.join(', ')} (range ${lo}-${hi} + pinned overrides)`, conflicts };
}

function fixPortConflict(): string {
  // Predictive rule: never kills a holder, just reports. Pair with `daimon free-port <p>` for action.
  return 'no automated fix — predictive rule only. Run `daimon free-port <port>` to inspect the holder, or pick a different port in daimon.config.json. To undo: nothing was changed.';
}

function detectNodeVersionMismatch(): { detected: boolean; description: string; expected?: string; actual?: string } {
  const here = process.cwd();
  const actual = process.versions.node;
  const nvmPath = path.join(here, '.nvmrc');
  if (fs.existsSync(nvmPath)) {
    const want = fs.readFileSync(nvmPath, 'utf8').trim().replace(/^v/i, '');
    if (want && !actual.startsWith(want)) {
      return { detected: true, description: `.nvmrc requires ${want}, running ${actual}`, expected: want, actual };
    }
  }
  const pkgPath = path.join(here, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const eng = pkg?.engines?.node;
      if (typeof eng === 'string' && eng.trim()) {
        // very rough check: extract the first numeric token from the spec
        const m = eng.match(/(\d+)(?:\.(\d+))?/);
        if (m) {
          const wantMajor = Number(m[1]);
          const haveMajor = Number(actual.split('.')[0]);
          if (Number.isFinite(wantMajor) && Number.isFinite(haveMajor) && haveMajor < wantMajor) {
            return { detected: true, description: `package.json engines.node = "${eng}" but running ${actual}`, expected: eng, actual };
          }
        }
      }
    } catch {}
  }
  return { detected: false, description: `node ${actual} satisfies .nvmrc / engines.node (or neither is present)` };
}

function fixNodeVersionMismatch(): string {
  return 'no automated fix — switching Node versions touches the user environment. Run `nvm use` (or your version manager equivalent) in this directory, then re-run daimon. To undo: nothing was changed.';
}

function listAppRoots(): { name: string; root: string; pkgPath: string; lockPath: string | null; nmPath: string }[] {
  const r = loadConfig();
  if (r.kind !== 'loaded') return [];
  const out: { name: string; root: string; pkgPath: string; lockPath: string | null; nmPath: string }[] = [];
  const seen = new Set<string>();
  for (const sr of r.config.searchRoots) {
    const rootPath = typeof sr === 'string' ? sr : sr.path;
    if (!rootPath || !fs.existsSync(rootPath) || seen.has(rootPath)) continue;
    seen.add(rootPath);
    const pkgPath = path.join(rootPath, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    let lockFound: string | null = null;
    for (const lf of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      const p = path.join(rootPath, lf);
      if (fs.existsSync(p)) { lockFound = p; break; }
    }
    out.push({ name: path.basename(rootPath), root: rootPath, pkgPath, lockPath: lockFound, nmPath: path.join(rootPath, 'node_modules') });
  }
  return out;
}

function detectOrphanNodeModules(): { detected: boolean; description: string; entries?: { root: string; reason: 'missing' | 'stale' }[] } {
  const roots = listAppRoots();
  if (!roots.length) return { detected: false, description: 'no searchRoots with package.json found' };
  const entries: { root: string; reason: 'missing' | 'stale' }[] = [];
  for (const r of roots) {
    if (!fs.existsSync(r.nmPath)) { entries.push({ root: r.root, reason: 'missing' }); continue; }
    if (r.lockPath) {
      try {
        const lockMtime = fs.statSync(r.lockPath).mtimeMs;
        const nmMtime = fs.statSync(r.nmPath).mtimeMs;
        if (lockMtime > nmMtime + 1000) entries.push({ root: r.root, reason: 'stale' });
      } catch {}
    }
  }
  if (!entries.length) return { detected: false, description: 'every searchRoot package.json has a fresh node_modules' };
  const summary = entries.map(e => `${e.reason}: ${e.root}`).join(' · ');
  return { detected: true, description: `node_modules issues — ${summary}`, entries };
}

function fixOrphanNodeModules(): string {
  const det = detectOrphanNodeModules();
  if (!det.detected || !det.entries) return 'nothing to suggest';
  const suggestions = det.entries.map(e => `(cd "${e.root}" && npm install)`).join(' && ');
  // Never runs npm install per the PLAN-locked decision; only reports.
  return `would suggest: ${suggestions}. Daimon does not run package managers on your behalf — run the command(s) yourself. To undo: nothing was changed.`;
}

function configuredRoots(): string[] {
  const r = loadConfig();
  if (r.kind !== 'loaded') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sr of r.config.searchRoots) {
    const p = typeof sr === 'string' ? sr : sr?.path;
    if (!p || !fs.existsSync(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function detectOrphanVenv(): { detected: boolean; description: string; entries?: { root: string; reason: 'missing' | 'stale' }[] } {
  const roots = configuredRoots();
  if (!roots.length) return { detected: false, description: 'no searchRoots resolved on disk' };
  const entries: { root: string; reason: 'missing' | 'stale' }[] = [];
  for (const root of roots) {
    const pyproject = path.join(root, 'pyproject.toml');
    const reqTxt = path.join(root, 'requirements.txt');
    const managePy = path.join(root, 'manage.py');
    const hasPyMarker = fs.existsSync(pyproject) || fs.existsSync(reqTxt) || fs.existsSync(managePy);
    if (!hasPyMarker) continue;
    const venvPath = ['.venv', 'venv', 'env'].map(d => path.join(root, d)).find(p => fs.existsSync(p));
    if (!venvPath) { entries.push({ root, reason: 'missing' }); continue; }
    const sourceMtimes: number[] = [];
    for (const f of [pyproject, reqTxt]) {
      if (fs.existsSync(f)) {
        try { sourceMtimes.push(fs.statSync(f).mtimeMs); } catch {}
      }
    }
    if (sourceMtimes.length) {
      try {
        const venvMtime = fs.statSync(venvPath).mtimeMs;
        if (Math.max(...sourceMtimes) > venvMtime + 1000) entries.push({ root, reason: 'stale' });
      } catch {}
    }
  }
  if (!entries.length) return { detected: false, description: 'every Python searchRoot has a fresh venv (or no Python markers)' };
  const summary = entries.map(e => `${e.reason}: ${e.root}`).join(' · ');
  return { detected: true, description: `venv issues — ${summary}`, entries };
}

function fixOrphanVenv(): string {
  const det = detectOrphanVenv();
  if (!det.detected || !det.entries) return 'nothing to suggest';
  const suggestions = det.entries.map(e => `(cd "${e.root}" && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt)`).join(' && ');
  return `would suggest: ${suggestions}. Daimon does not run pip on your behalf — run the command(s) yourself. To undo: nothing was changed.`;
}

function detectOrphanBundlerCache(): { detected: boolean; description: string; entries?: { root: string; reason: 'missing' | 'stale' }[] } {
  const roots = configuredRoots();
  if (!roots.length) return { detected: false, description: 'no searchRoots resolved on disk' };
  const entries: { root: string; reason: 'missing' | 'stale' }[] = [];
  for (const root of roots) {
    const gemfile = path.join(root, 'Gemfile');
    if (!fs.existsSync(gemfile)) continue;
    const lockf = path.join(root, 'Gemfile.lock');
    const cachePath = path.join(root, 'vendor', 'bundle');
    const altCachePath = path.join(root, '.bundle');
    const cache = fs.existsSync(cachePath) ? cachePath : fs.existsSync(altCachePath) ? altCachePath : null;
    if (!cache) { entries.push({ root, reason: 'missing' }); continue; }
    if (fs.existsSync(lockf)) {
      try {
        const lockMtime = fs.statSync(lockf).mtimeMs;
        const cacheMtime = fs.statSync(cache).mtimeMs;
        if (lockMtime > cacheMtime + 1000) entries.push({ root, reason: 'stale' });
      } catch {}
    }
  }
  if (!entries.length) return { detected: false, description: 'every Ruby searchRoot has a fresh bundle cache (or no Gemfile)' };
  const summary = entries.map(e => `${e.reason}: ${e.root}`).join(' · ');
  return { detected: true, description: `bundler cache issues — ${summary}`, entries };
}

function fixOrphanBundlerCache(): string {
  const det = detectOrphanBundlerCache();
  if (!det.detected || !det.entries) return 'nothing to suggest';
  const suggestions = det.entries.map(e => `(cd "${e.root}" && bundle install)`).join(' && ');
  return `would suggest: ${suggestions}. Daimon does not run bundle install on your behalf — run the command(s) yourself. To undo: nothing was changed.`;
}

function detectOrphanCargoTarget(): { detected: boolean; description: string; entries?: { root: string; reason: 'missing' | 'stale' }[] } {
  const roots = configuredRoots();
  if (!roots.length) return { detected: false, description: 'no searchRoots resolved on disk' };
  const entries: { root: string; reason: 'missing' | 'stale' }[] = [];
  for (const root of roots) {
    const cargoToml = path.join(root, 'Cargo.toml');
    if (!fs.existsSync(cargoToml)) continue;
    const lockf = path.join(root, 'Cargo.lock');
    const target = path.join(root, 'target');
    if (!fs.existsSync(target)) { entries.push({ root, reason: 'missing' }); continue; }
    if (fs.existsSync(lockf)) {
      try {
        const lockMtime = fs.statSync(lockf).mtimeMs;
        const tgtMtime = fs.statSync(target).mtimeMs;
        if (lockMtime > tgtMtime + 1000) entries.push({ root, reason: 'stale' });
      } catch {}
    }
  }
  if (!entries.length) return { detected: false, description: 'every Rust searchRoot has a fresh target/ (or no Cargo.toml)' };
  const summary = entries.map(e => `${e.reason}: ${e.root}`).join(' · ');
  return { detected: true, description: `cargo target issues — ${summary}`, entries };
}

function fixOrphanCargoTarget(): string {
  const det = detectOrphanCargoTarget();
  if (!det.detected || !det.entries) return 'nothing to suggest';
  const suggestions = det.entries.map(e => `(cd "${e.root}" && cargo build)`).join(' && ');
  return `would suggest: ${suggestions}. Daimon does not run cargo on your behalf — run the command(s) yourself. To undo: nothing was changed.`;
}

function detectDeadSearchRoot(): { detected: boolean; description: string; dead?: string[] } {
  const r = loadConfig();
  if (r.kind !== 'loaded') return { detected: false, description: 'no config loaded' };
  const dead: string[] = [];
  for (const sr of r.config.searchRoots) {
    const p = typeof sr === 'string' ? sr : sr.path;
    if (!p) continue;
    if (!fs.existsSync(p)) dead.push(p);
  }
  if (!dead.length) return { detected: false, description: 'every configured searchRoot resolves on disk' };
  return { detected: true, description: `searchRoots no longer on disk: ${dead.join(', ')}`, dead };
}

function fixDeadSearchRoot(): string {
  const det = detectDeadSearchRoot();
  if (!det.detected || !det.dead || !det.dead.length) return 'nothing to remove';
  const { local, user } = configLookupPaths();
  const target = fs.existsSync(local) ? local : user;
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
  if (!Array.isArray(raw.searchRoots)) return 'config has no searchRoots array; nothing removed';
  const dead = new Set(det.dead);
  const before = raw.searchRoots.length;
  raw.searchRoots = raw.searchRoots.filter((sr: any) => {
    const p = typeof sr === 'string' ? sr : sr?.path;
    return !dead.has(p);
  });
  const removed = before - raw.searchRoots.length;
  fs.writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  const lock = readLock();
  if (lock) { try { void agentFetch(`http://127.0.0.1:${lock.apiPort}/api/config/reload`); } catch {} }
  return `removed ${removed} dead searchRoot entr${removed === 1 ? 'y' : 'ies'} from ${target} (${[...dead].join(', ')}); triggered soft-reload. To undo: edit ${target} and re-add the path(s).`;
}

function detectHealthProbeMissing(): { detected: boolean; description: string; entries?: { name: string; profile: string; path: string }[] } {
  const r = loadConfig();
  if (r.kind !== 'loaded') return { detected: false, description: 'no config loaded' };
  // Match the daemon's discovery so a polyglot app with a profile but no
  // resolved probe path surfaces here. Each entry carries the
  // profile-suggested default that the auto-fix would write.
  const apps = discoverApps(r.config, {});
  const overrides = r.config.overrides ?? {};
  const entries: { name: string; profile: string; path: string }[] = [];
  for (const a of apps) {
    if (!a.serverProfile) continue;
    const baseName = a.baseName ?? a.name;
    const userPath = overrides[a.name]?.healthProbePath ?? overrides[baseName]?.healthProbePath;
    if (userPath) continue;
    const suggested = profileProbePath(a.serverProfile);
    if (!suggested || suggested === '/') continue;
    entries.push({ name: a.name, profile: a.serverProfile, path: suggested });
  }
  if (!entries.length) return { detected: false, description: 'every app with a known framework profile already has a probe path resolved' };
  const summary = entries.map(e => `${e.name} (${e.profile} → ${e.path})`).join(' · ');
  return { detected: true, description: `apps missing a profile-aware health probe path: ${summary}`, entries };
}

function fixHealthProbeMissing(): string {
  const det = detectHealthProbeMissing();
  if (!det.detected || !det.entries) return 'nothing to set';
  const { local, user } = configLookupPaths();
  const target = fs.existsSync(local) ? local : user;
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
  if (!raw.overrides || typeof raw.overrides !== 'object') raw.overrides = {};
  const wrote: string[] = [];
  for (const e of det.entries) {
    if (!raw.overrides[e.name] || typeof raw.overrides[e.name] !== 'object') raw.overrides[e.name] = {};
    if (raw.overrides[e.name].healthProbePath) continue;
    raw.overrides[e.name].healthProbePath = e.path;
    wrote.push(`${e.name} → ${e.path}`);
  }
  if (!wrote.length) return 'every detected app already had a healthProbePath in overrides; nothing changed.';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  const lock = readLock();
  if (lock) { try { void agentFetch(`http://127.0.0.1:${lock.apiPort}/api/config/reload`); } catch {} }
  return `wrote healthProbePath to overrides in ${target} for: ${wrote.join(', ')}; triggered soft-reload. To undo: edit ${target}.`;
}

const ROUTINES: Record<AutoFixName, { detect: () => any | Promise<any>; fix: () => string | Promise<string> }> = {
  'orphan-daemon': { detect: detectOrphan, fix: fixOrphan },
  'stale-lock': { detect: detectStaleLock, fix: fixStaleLock },
  'missing-search-root': { detect: detectMissingSearchRoot, fix: fixMissingSearchRoot },
  'corrupt-history-db': { detect: detectCorruptHistoryDb, fix: fixCorruptHistoryDb },
  'port-conflict-pred': { detect: detectPortConflict, fix: fixPortConflict },
  'node-version-mismatch': { detect: detectNodeVersionMismatch, fix: fixNodeVersionMismatch },
  'orphan-node-modules': { detect: detectOrphanNodeModules, fix: fixOrphanNodeModules },
  'orphan-venv': { detect: detectOrphanVenv, fix: fixOrphanVenv },
  'orphan-bundler-cache': { detect: detectOrphanBundlerCache, fix: fixOrphanBundlerCache },
  'orphan-cargo-target': { detect: detectOrphanCargoTarget, fix: fixOrphanCargoTarget },
  'dead-search-root': { detect: detectDeadSearchRoot, fix: fixDeadSearchRoot },
  'health-probe-missing': { detect: detectHealthProbeMissing, fix: fixHealthProbeMissing },
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
