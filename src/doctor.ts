import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppmanConfig, DiscoveredApp } from './types.js';
import { findCycle } from './depends.js';
import { isPortFree } from './ports.js';
import { History } from './history.js';
import { analyseRestartCadence } from './profiles.js';
import { configValidationWarnings } from './config.js';
import { allProfiles, matchDetect, RootFs } from './frameworks.js';
import { daimonDir, readLock } from './daemon.js';
import { inspectApiPort } from './portDiag.js';
import { resolveEnvFilePath } from './envFiles.js';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

// Doctor coverage table (M91): every recurring failure class from v0.11–v0.14
// mapped to its doctor rule, auto-fix, built-in remedy — or a documented gap
// with the reason. Rendered into docs/index.html by build:docs; M90's support
// path ("run daimon doctor first") leans on this being complete.
export interface DoctorCoverageRow {
  failure: string;
  kind: 'rule' | 'auto-fix' | 'built-in' | 'gap';
  coverage: string;
}

export const DOCTOR_COVERAGE: DoctorCoverageRow[] = [
  { failure: 'Orphan daimon holding the api port (no daemon.lock)', kind: 'auto-fix', coverage: '`port-holder-no-lock` — kills only a holder that answers GET /api/signature as a daimon AND has no live lock, re-verified at fix time (M81 verify-then-kill). Plus EADDRINUSE startup forensics naming the holder + remedy.' },
  { failure: 'Stale daemon.lock after an unclean exit', kind: 'auto-fix', coverage: '`stale-lock`; startup also self-clears any lock whose pid is dead (M88 recovery step 2).' },
  { failure: 'Corrupt history.db', kind: 'auto-fix', coverage: '`corrupt-history-db`; startup independently archives a corrupt db as history.db.corrupt-<ts> and rebuilds, with a self-warn event.' },
  { failure: 'Corrupt state.json (ports/mutes/digests)', kind: 'built-in', coverage: 'Recovered from state.json.bak; if both are unreadable, archived as state.json.corrupt-<ts> + fresh start + self-warn (M88). Repaired before doctor could even run.' },
  { failure: 'Missing or deleted searchRoot', kind: 'auto-fix', coverage: '`searchRoot exists` check; `missing-search-root` / `dead-search-root` auto-fixes.' },
  { failure: 'Workspace not detected as an app', kind: 'rule', coverage: '`searchRoot has marker` (checks the full framework registry); `daimon frameworks` shows per-profile rejection stats; `daimon why-empty` explains an empty list.' },
  { failure: 'Invalid custom framework profile (config data row)', kind: 'rule', coverage: '`config-valid` — invalid rows are skipped with a field-level warning at load; doctor surfaces the warnings.' },
  { failure: 'Typo’d or unknown config key', kind: 'rule', coverage: 'Load-time warning with the nearest valid name (never a failure — old configs stay loadable); `daimon config validate` reports the same offline; `config-valid` doctor check surfaces it (M91).' },
  { failure: 'Pinned-port collision between apps', kind: 'rule', coverage: '`port pin <n>` collision check; predicted pool conflicts via `port-conflict-pred` (M81).' },
  { failure: 'Restart storm / crash loop', kind: 'rule', coverage: '`restart-storm: <app>` (threshold via restartStorm.perHour) + `smart-restart-tune`; crash reports ring-buffer 10/app and surface in `daimon why`.' },
  { failure: 'Flaky tests', kind: 'gap', coverage: 'No doctor rule by design: flakiness is derived from run history at each git head, not from config or daemon state — `daimon test-history <app> --flaky` is the surface.' },
  { failure: 'Full-text search degraded (FTS5 unavailable)', kind: 'built-in', coverage: 'Search degrades to a LIKE scan (fallback:true) and a self-warn event fires; `history-db-healthy` covers the underlying db.' },
  { failure: 'Convention env file missing for a framework', kind: 'rule', coverage: '`env-file-missing: <app>` — suggest-only; daimon never creates or edits .env files (M82).' },
  { failure: 'Node version below daimon’s floor', kind: 'auto-fix', coverage: '`node-version-mismatch`.' },
  { failure: 'Orphaned dependency caches (node_modules / venv / bundler / cargo target)', kind: 'auto-fix', coverage: '`orphan-node-modules` / `orphan-venv` / `orphan-bundler-cache` / `orphan-cargo-target`.' },
  { failure: 'Health probe pointed at a 404 path', kind: 'auto-fix', coverage: '`health-probe-missing`; `daimon pin-health <app> --accept` persists the discovered path.' },
  { failure: 'Child unverifiable after a daemon handoff', kind: 'gap', coverage: 'No auto-fix by design (verify-then-kill: daimon never kills what it cannot positively identify). The app surfaces as status `orphaned` with a per-case remedy in `daimon list` / `daimon why` (M88).' },
  { failure: 'CLI and daemon running different versions', kind: 'built-in', coverage: 'Every CLI call compares versions via the x-daimon-version header and warns on stderr with the remedy (`daimon daemon restart`) — never a hard fail (M88).' },
];

export async function runDoctor(config: AppmanConfig, apps: DiscoveredApp[]): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const appNames = new Set(apps.map(a => a.name));

  // Active state directory (M79): relocatable via DAIMON_HOME.
  checks.push({
    name: 'daimon-home',
    ok: true,
    detail: `${daimonDir()}${process.env.DAIMON_HOME ? ' (from DAIMON_HOME)' : ''}`,
  });

  // Field-level validation problems collected when this process loaded the
  // config (M55 malformed-config softening — broken fields ran on defaults).
  const cfgWarnings = configValidationWarnings();
  if (cfgWarnings.length === 0) {
    checks.push({ name: 'config-valid', ok: true });
  } else {
    for (const w of cfgWarnings) {
      checks.push({ name: 'config-valid', ok: false, detail: `${w} — field fell back to its default` });
    }
  }

  for (const sr of config.searchRoots) {
    const root = typeof sr === 'string' ? sr : sr.path;
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) {
      checks.push({ name: `searchRoot exists: ${abs}`, ok: false, detail: 'not found' });
      continue;
    }
    // v0.11: consult the full framework registry (built-ins + custom config
    // profiles) instead of the legacy four-marker list, so a Next.js/Django/
    // dotnet-only root doesn't false-flag.
    const rootFs = new RootFs(abs);
    const hasMarker = allProfiles(config.frameworks).some(p => matchDetect(p.detect, rootFs));
    checks.push({ name: `searchRoot has marker: ${abs}`, ok: hasMarker, detail: hasMarker ? undefined : 'no framework markers (see `daimon frameworks` for the registry)' });
  }

  for (const [name, ov] of Object.entries(config.overrides ?? {})) {
    const inDiscovered = appNames.has(name);
    const hasCmd = !!ov.command;
    const ok = inDiscovered || hasCmd;
    checks.push({ name: `override "${name}"`, ok, detail: ok ? undefined : 'unknown app and no command override' });
  }

  const pinned = Object.entries(config.overrides ?? {})
    .filter(([, ov]) => typeof ov.port === 'number')
    .map(([name, ov]) => ({ name, port: ov.port as number }));
  const seen = new Map<number, string>();
  for (const p of pinned) {
    if (seen.has(p.port)) {
      checks.push({ name: `port pin ${p.port}`, ok: false, detail: `collision: ${seen.get(p.port)} and ${p.name}` });
    } else {
      seen.set(p.port, p.name);
    }
  }
  if (pinned.length && !checks.some(c => c.name.startsWith('port pin'))) {
    checks.push({ name: 'pinned ports', ok: true });
  }

  for (const name of config.autoStart ?? []) {
    checks.push({ name: `autoStart "${name}"`, ok: appNames.has(name), detail: appNames.has(name) ? undefined : 'unknown app' });
  }
  for (const [profile, names] of Object.entries(config.profiles ?? {})) {
    for (const n of names) {
      checks.push({ name: `profile "${profile}" entry "${n}"`, ok: appNames.has(n), detail: appNames.has(n) ? undefined : 'unknown app' });
    }
  }

  if (config.depends && Object.keys(config.depends).length) {
    for (const [k, ds] of Object.entries(config.depends)) {
      for (const d of ds) {
        if (!appNames.has(d)) checks.push({ name: `depends "${k}" -> "${d}"`, ok: false, detail: 'unknown app' });
      }
    }
    const cycle = findCycle(config.depends);
    if (cycle) checks.push({ name: 'depends DAG', ok: false, detail: `cycle: ${cycle.join(' -> ')}` });
    else checks.push({ name: 'depends DAG', ok: true });
  }

  const roots = new Set(apps.map(a => a.workspaceRoot));
  for (const r of roots) {
    // Only meaningful where a package.json exists — a Django/Rails/Go root
    // legitimately has no node_modules (M90: fewer false findings).
    if (!fs.existsSync(path.join(r, 'package.json'))) continue;
    const nm = path.join(r, 'node_modules');
    const ok = fs.existsSync(nm);
    checks.push({ name: `node_modules: ${r}`, ok, detail: ok ? undefined : 'missing — run your package manager install (npm/pnpm/yarn/bun) there; daimon never installs for you' });
  }

  // apiPort + port-holder-no-lock (M81): a busy apiPort is fine when the
  // locked daemon holds it; an unlocked holder that answers as a daimon is a
  // verified orphan (auto-fixable); anything else is identify-and-advise.
  const apiFree = await isPortFree(config.apiPort);
  if (apiFree) {
    checks.push({ name: `apiPort ${config.apiPort}`, ok: true });
    checks.push({ name: 'port-holder-no-lock', ok: true });
  } else {
    const lock = readLock();
    if (lock && lock.apiPort === config.apiPort) {
      checks.push({ name: `apiPort ${config.apiPort}`, ok: true, detail: `held by the running daemon (pid ${lock.pid})` });
      checks.push({ name: 'port-holder-no-lock', ok: true });
    } else {
      checks.push({ name: `apiPort ${config.apiPort}`, ok: false, detail: 'in use with no live daemon.lock' });
      const f = await inspectApiPort(config.apiPort, lock !== null);
      if (f.signature?.daimon) {
        checks.push({
          name: 'port-holder-no-lock',
          ok: false,
          detail: `apiPort ${config.apiPort} held by an unlocked daimon${f.signature.version ? ` v${f.signature.version}` : ''} (pid ${f.holder?.pid ?? '?'}) — run 'daimon doctor --auto-fix' to terminate the verified orphan`,
        });
      } else {
        checks.push({
          name: 'port-holder-no-lock',
          ok: false,
          detail: `apiPort ${config.apiPort} held by a non-daimon process${f.holder ? ` (pid ${f.holder.pid}${f.holder.name ? `, ${f.holder.name}` : ''})` : ''} — daimon will not kill it; free the port yourself or change apiPort`,
        });
      }
    }
  }

  if (config.history.enabled) {
    let ok = false;
    let detail: string | undefined;
    try {
      const h = new History(config.history);
      ok = h.quickCheck();
      const archived = h.archivedCorruptDbPath();
      h.close();
      if (!ok) detail = 'quick_check failed';
      else if (archived) detail = `rebuilt fresh; previous db archived at ${archived}`;
    } catch (err: any) {
      detail = err?.message || String(err);
    }
    checks.push({ name: 'history db', ok, detail });

    // Surface any archived corrupt-DB files left over from previous startups.
    // Each archived file is informational (not a hard failure) — the db is
    // healthy now but the user may want to inspect or delete the snapshot.
    try {
      const dir = path.dirname(config.history.path);
      const base = path.basename(config.history.path);
      const stale = fs.readdirSync(dir).filter(f => f.startsWith(base + '.corrupt-'));
      if (stale.length > 0) {
        checks.push({
          name: 'history-db-healthy',
          ok: true,
          detail: `${stale.length} archived corrupt snapshot${stale.length === 1 ? '' : 's'} present (${stale.slice(0, 2).join(', ')}${stale.length > 2 ? ', …' : ''}). Safe to delete after review.`,
        });
      } else {
        checks.push({ name: 'history-db-healthy', ok: true });
      }
    } catch {
      checks.push({ name: 'history-db-healthy', ok: true });
    }
  }

  // smart-restart-tune (M61): scan last 7d of status events for restart-storms.
  // Surfaces apps whose restart cadence suggests a flaky restartPolicy.
  // Also reports orphaned-app cleanups (M55) from the last 24h.
  if (config.history.enabled) {
    try {
      const h = new History(config.history);
      const since = Date.now() - 7 * 24 * 60 * 60_000;
      const events = h.queryEvents({ since, type: 'status', limit: 20_000 });
      const orphanCleanups = h.queryEvents({ app: '__daemon__', since: Date.now() - 24 * 60 * 60_000, limit: 500 })
        .filter(e => (e.message || '').startsWith('orphaned app detached'));
      h.close();
      checks.push({
        name: 'orphaned-app-cleanup',
        ok: true,
        detail: orphanCleanups.length
          ? `${orphanCleanups.length} app${orphanCleanups.length === 1 ? '' : 's'} detached after config reloads in the last 24h`
          : undefined,
      });
      const concerns = analyseRestartCadence(events.map(r => ({ ts: r.ts, app: r.app, type: r.type, to_state: r.to_state, from_state: r.from_state } as any)), 7, 5);
      if (concerns.length === 0) {
        checks.push({ name: 'smart-restart-tune', ok: true });
      } else {
        for (const c of concerns) {
          checks.push({ name: `smart-restart-tune: ${c.app}`, ok: false, detail: c.reason });
        }
      }
    } catch (err: any) {
      checks.push({ name: 'smart-restart-tune', ok: true, detail: `skipped: ${err?.message || err}` });
    }
  }

  // restart-storm (M76): apps whose unrequested exits exceeded
  // restartStorm.perHour within the last hour, from the crashes table.
  if (config.history.enabled) {
    try {
      const h = new History(config.history);
      const crashes = h.queryCrashes({ since: Date.now() - 3600_000, limit: 1000 });
      h.close();
      const threshold = config.restartStorm?.perHour ?? 20;
      const byApp = new Map<string, { count: number; exits: Map<string, number> }>();
      for (const c of crashes) {
        const cur = byApp.get(c.app) ?? { count: 0, exits: new Map() };
        cur.count++;
        const key = String(c.exitCode ?? c.signal ?? 'unknown');
        cur.exits.set(key, (cur.exits.get(key) ?? 0) + 1);
        byApp.set(c.app, cur);
      }
      let anyStorm = false;
      for (const [app, v] of byApp) {
        if (v.count <= threshold) continue;
        anyStorm = true;
        const topExit = [...v.exits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
        checks.push({
          name: `restart-storm: ${app}`,
          ok: false,
          detail: `${v.count} unrequested exits in the last hour (top exit code ${topExit}, threshold ${threshold}/h) — run 'daimon why ${app}'`,
        });
      }
      if (!anyStorm) checks.push({ name: 'restart-storm', ok: true });
    } catch (err: any) {
      checks.push({ name: 'restart-storm', ok: true, detail: `skipped: ${err?.message || err}` });
    }
  }

  // env-file-missing (M82): a convention file that existed at the last spawn
  // snapshot but is gone now, or an envFiles.<app> config reference that never
  // resolves on disk. Suggest-only — never fails doctor, never auto-fixed.
  if (config.history.enabled) {
    try {
      const h = new History(config.history);
      for (const a of apps) {
        const row = h.queryEnvSnapshots({ app: a.name, limit: 1 })[0];
        if (!row) continue;
        try {
          const snap = JSON.parse(row.json);
          for (const f of snap.files ?? []) {
            if (f?.exists && typeof f.file === 'string' && !fs.existsSync(resolveEnvFilePath(a.workspaceRoot, f.file))) {
              checks.push({
                name: `env-file-missing: ${a.name}`,
                ok: true,
                detail: `${f.file} existed at the last spawn but is missing now — the app may behave differently on its next start`,
              });
            }
          }
        } catch {}
      }
      h.close();
    } catch {}
  }
  for (const [appName, files] of Object.entries(config.envFiles ?? {})) {
    const app = apps.find(x => x.name === appName || (x.baseName ?? x.name) === appName);
    if (!app) continue;
    for (const f of files) {
      if (!fs.existsSync(resolveEnvFilePath(app.workspaceRoot, f))) {
        checks.push({
          name: `env-file-missing: ${appName}`,
          ok: true,
          detail: `envFiles.${appName} references ${f}, which does not exist under ${app.workspaceRoot}`,
        });
      }
    }
  }

  // searchroot-hygiene (M76): suspicious roots (drive roots, system dirs, the
  // home dir itself) scan slowly and match junk. Suggest-only — never fails
  // doctor, never auto-applied.
  for (const sr of config.searchRoots) {
    const root = typeof sr === 'string' ? sr : sr.path;
    const reason = suspiciousRootReason(root);
    if (reason) {
      checks.push({
        name: `searchroot-hygiene: ${root}`,
        ok: true,
        detail: `${reason} — consider narrowing to your projects folder (edit searchRoots or run 'daimon workspaces rm ${root}')`,
      });
    }
  }

  checks.push({ name: 'agent token footprint', ok: true, detail: tokenFootprint(apps) });

  const ok = checks.every(c => c.ok);
  return { ok, checks };
}

// Exported for `daimon why` (server-side) and tests.
export function suspiciousRootReason(root: string): string | null {
  const abs = path.resolve(root);
  const norm = abs.replace(/[\\/]+$/, '').toLowerCase();
  const parsedRoot = path.parse(abs).root.replace(/[\\/]+$/, '').toLowerCase();
  if (norm === parsedRoot) return 'drive/filesystem root';
  const home = os.homedir().replace(/[\\/]+$/, '').toLowerCase();
  if (norm === home) return 'home directory root';
  const systemDirs = process.platform === 'win32'
    ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata']
    : ['/usr', '/etc', '/bin', '/sbin', '/var', '/system', '/library', '/opt/homebrew'];
  for (const sys of systemDirs) {
    if (norm === sys || norm.startsWith(sys + path.sep)) return 'system directory';
  }
  return null;
}

function tokenFootprint(apps: DiscoveredApp[]): string {
  const N = apps.length;
  const skill = 120;
  const compactPerApp = 34;
  const fullPerApp = 285;
  const compactTotal = skill + N * compactPerApp;
  const fullTotal = skill + N * fullPerApp;
  const savings = N > 0 ? Math.round((1 - compactTotal / fullTotal) * 100) : 0;
  return `skill=${skill} tokens · daimon list (${N} apps) ≈ ${compactTotal} tokens compact / ${fullTotal} tokens full · savings: ~${savings}%`;
}
