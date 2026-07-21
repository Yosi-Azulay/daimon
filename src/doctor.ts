import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppmanConfig, DiscoveredApp } from './types.js';
import type { DiscoveryStats } from './discovery.js';
import { findCycle } from './depends.js';
import { isPortFree } from './ports.js';
import { History } from './history.js';
import { analyseRestartCadence } from './profiles.js';
import { configValidationWarnings } from './config.js';
import { allProfiles, matchDetect, RootFs } from './frameworks.js';
import { daimonDir, readLock } from './daemon.js';
import { loadPlugins, pluginsDir } from './plugins.js';
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
  { failure: 'Log storm (volume spiking against the app’s own baseline)', kind: 'rule', coverage: '`log-storm-active: <app>` (M101, v1.2) — suggest-only: names the observed rate, baseline, and the remedy (`daimon logs <app> --since 5m --level error`, mute, or stop). Detection is always on; tune via `logs.storm`; OS notification is opt-in via notifications.kinds.' },
  { failure: 'CPU storm (sustained CPU above the app’s own baseline)', kind: 'rule', coverage: '`cpu-storm-active: <app>` (M109, v1.3) — advise-only by contract (warn-never-kill): names the observed mean vs baseline and points at `daimon why` / `daimon logs`; a restart recalibrates. Suspicion events: `cpu-storm`, `resource-leak-suspect`, `resource-budget-exceeded` (budgets via resources.rssMb/cpuPct).' },
  { failure: 'Flaky tests', kind: 'gap', coverage: 'No doctor rule by design: flakiness is derived from run history at each git head, not from config or daemon state — `daimon test-history <app> --flaky` is the surface.' },
  { failure: 'Full-text search degraded (FTS5 unavailable)', kind: 'built-in', coverage: 'Search degrades to a LIKE scan (fallback:true) and a self-warn event fires; `history-db-healthy` covers the underlying db.' },
  { failure: 'Convention env file missing for a framework', kind: 'rule', coverage: '`env-file-missing: <app>` — suggest-only; daimon never creates or edits .env files (M82).' },
  { failure: 'Node version below daimon’s floor', kind: 'auto-fix', coverage: '`node-version-mismatch`.' },
  { failure: 'Orphaned dependency caches (node_modules / venv / bundler / cargo target)', kind: 'auto-fix', coverage: '`orphan-node-modules` / `orphan-venv` / `orphan-bundler-cache` / `orphan-cargo-target`.' },
  { failure: 'Health probe pointed at a 404 path', kind: 'auto-fix', coverage: '`health-probe-missing`; `daimon pin-health <app> --accept` persists the discovered path.' },
  { failure: 'Child unverifiable after a daemon handoff', kind: 'gap', coverage: 'No auto-fix by design (verify-then-kill: daimon never kills what it cannot positively identify). The app surfaces as status `orphaned` with a per-case remedy in `daimon list` / `daimon why` (M88).' },
  { failure: 'CLI and daemon running different versions', kind: 'built-in', coverage: 'Every CLI call compares versions via the x-daimon-version header and warns on stderr with the remedy (`daimon daemon restart`) — never a hard fail (M88).' },
  { failure: 'Plugin failed to load, or was disabled after a hook threw', kind: 'rule', coverage: '`plugin-load-error: <file>` (M118, v1.5) — advise-only: names the captured error and the remedy (fix or remove the file, then `daimon daemon restart`). Doctor never deletes or edits plugin files; a hook throw disables the plugin for the session with one `plugin-error` self-event (M117 crash isolation), never a daemon-down. `daimon plugins` is the detail view.' },
  { failure: 'Ran daimon from the wrong directory (config lives in a parent, or only the global ~/.daimon/config.json was found)', kind: 'rule', coverage: '`config-wrong-directory` (M171, v1.14) — suggest-only: names the config file daimon actually found and how to use it (cd there, copy it here, or rely on the global fallback on purpose). Only fires when the caller tells doctor which path it loaded (`daimon doctor` does); never invents a --config flag that does not exist.' },
  { failure: 'Config present but the daemon was never started', kind: 'rule', coverage: '`daemon-not-started` (M171, v1.14) — suggest-only: fires only when nothing at all answers on apiPort (distinct from `port-holder-no-lock`, which owns the case where something ELSE holds it); remedy is `daimon daemon start`.' },
  { failure: 'Config loads but discovery found zero apps', kind: 'rule', coverage: '`no-apps-detected` (M171, v1.14) — suggest-only: surfaces the single likeliest cause from discovery\'s own `stats.rejected` tally (no searchRoots configured, a missing path, no serve target, a fallback superseded by a named profile, no dev/serve/start script, or no framework markers at all) with the matching remedy — never a generic guess.' },
  { failure: 'Detected apps support per-app ports but no ports.pool is configured', kind: 'rule', coverage: '`port-pool-absent` (M171, v1.14) — suggest-only: fires when at least one discovered app\'s framework profile declares `portFlag`/`portEnv` (see src/frameworks.ts) and `ports.pool` is unset; proposes the key with a concrete example range. Never writes config.' },
];

export async function runDoctor(
  config: AppmanConfig,
  apps: DiscoveredApp[],
  opts?: {
    plugins?: boolean;
    historyHealth?: boolean;
    // The file path the CALLER actually loaded the config from (cfgR.path from
    // config.ts's loadConfig() — `daimon doctor` passes it). Doctor never
    // re-resolves config itself: without this, config-wrong-directory simply
    // stays silent rather than guessing (M171, v1.14).
    configPath?: string;
    // Rejection tally from the discoverApps() call the caller already made
    // (M171, v1.14). Without it, no-apps-detected still fires on an empty
    // `apps` array — it just can't name a likeliest cause.
    discoveryStats?: DiscoveryStats;
  },
): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const appNames = new Set(apps.map(a => a.name));

  // ONE history handle for the whole sweep (M146, v1.10).
  //
  // Six separate `new History(...)` opens used to happen per run, and each one
  // paid an O(database-size) `PRAGMA integrity_check`: measured at 8.5s per
  // open on the 1M-event corpus, so a single `daimon doctor` spent ~51s inside
  // SQLite verifying the same file six times. Opened lazily (the first rule
  // that needs it wins) and closed once at the end.
  //
  // `verify: 'skip'` is correct rather than a shortcut: doctor runs its OWN
  // explicit health check below, so having the constructor verify as well was
  // always duplicated work.
  let sharedHistory: History | null = null;
  let historyOpened = false;
  const history = (): History | null => {
    if (!historyOpened) {
      historyOpened = true;
      try { sharedHistory = new History(config.history, { verify: 'skip' }); } catch { sharedHistory = null; }
    }
    return sharedHistory;
  };
  const closeHistory = () => { try { sharedHistory?.close(); } catch {} };

  // Active state directory (M79): relocatable via DAIMON_HOME.
  checks.push({
    name: 'daimon-home',
    ok: true,
    detail: `${daimonDir()}${process.env.DAIMON_HOME ? ' (from DAIMON_HOME)' : ''}`,
  });

  // config-wrong-directory (M171, v1.14): the classic "ran daimon from the
  // wrong folder" mistake. Only runs when the caller names the file it
  // actually loaded (`opts.configPath`, e.g. cfgR.path from loadConfig()) —
  // doctor never re-resolves config itself, so a request path that omits this
  // (like `why`) simply skips the rule rather than guessing. Config
  // resolution per configLookupPaths() is exactly two candidates: cwd, then
  // daimonDir()/config.json — there is no --config flag, so the remedy never
  // invents one.
  if (opts?.configPath) {
    const cwd = process.cwd();
    const localCfgPath = path.join(cwd, 'daimon.config.json');
    if (path.resolve(opts.configPath) !== path.resolve(localCfgPath)) {
      // loadConfig() never walks up — so a daimon.config.json in any
      // ancestor directory is DEFINITELY not the one that loaded, a fact we
      // can state outright rather than infer. The home directory itself is
      // excluded from the walk: a stray daimon.config.json sitting directly
      // in $HOME (as opposed to inside a project a few levels down) is not
      // "a parent project you forgot to cd into" — that's the global-fallback
      // case below (~/.daimon/config.json), and treating an unrelated $HOME
      // file as a project config would be noise, not a finding.
      const home = path.resolve(os.homedir());
      let foundParent: string | null = null;
      let dir = path.dirname(cwd);
      let prev = cwd;
      for (let i = 0; i < 24 && dir !== prev; i++) {
        const candidate = path.join(dir, 'daimon.config.json');
        if (path.resolve(dir) !== home && fs.existsSync(candidate)) { foundParent = candidate; break; }
        prev = dir;
        dir = path.dirname(dir);
      }
      const userCfgPath = path.join(daimonDir(), 'config.json');
      if (foundParent) {
        checks.push({
          name: 'config-wrong-directory',
          ok: true,
          detail: `no daimon.config.json in ${cwd} — found one at ${foundParent} instead. cd there to use it, or copy/move it into this folder (daimon has no --config flag; it only checks cwd, then ${userCfgPath})`,
        });
      } else if (path.resolve(opts.configPath) === path.resolve(userCfgPath)) {
        checks.push({
          name: 'config-wrong-directory',
          ok: true,
          detail: `no daimon.config.json in ${cwd} — daimon fell back to the global config at ${opts.configPath}. If that wasn't intentional, add a daimon.config.json here (or run 'daimon init')`,
        });
      }
    }
  }

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

  // no-apps-detected (M171, v1.14): config loaded fine, but discovery came
  // back empty — a distinct failure class from config-wrong-directory (that
  // one is about the config FILE; this one is about the workspace it points
  // at). Surfaces the single likeliest rejection reason from discovery's own
  // stats.rejected tally — never a generic guess — so the remedy matches what
  // actually happened.
  if (apps.length === 0) {
    // ok:true — suggest-only, like every other advisory rule (env-file-missing,
    // port-pool-absent). `daimon doctor` exits 1 on any ok:false check, and a
    // freshly-installed workspace that hasn't been pointed at anything yet is
    // not a doctor FAILURE; making it one would break `daimon doctor && …` for
    // everyone who scripted against v1.13's exit codes.
    checks.push({ name: 'no-apps-detected', ok: true, detail: noAppsDetectedDetail(config, opts?.discoveryStats) });
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
    // daemon-not-started (M171, v1.14): nobody at all is listening — the
    // first-run gap where a stranger writes a config and never runs
    // `daimon daemon start`. Distinct from port-holder-no-lock, which only
    // fires when something ELSE holds the port; this is precisely the case
    // where nothing does.
    // ok:true — suggest-only. A stopped daemon is a normal state, not a fault:
    // `daimon doctor` exits 1 on any ok:false check, so failing here would
    // break the `daimon doctor && daimon daemon start` idiom that worked
    // through v1.13. The finding still tells a stranger what to do next.
    checks.push({
      name: 'daemon-not-started',
      ok: true,
      detail: `no daimon is listening on apiPort ${config.apiPort}${process.env.DAIMON_PORT ? ` (config.apiPort; DAIMON_PORT=${process.env.DAIMON_PORT} is set, so a daemon may be running on that port instead)` : ''} — run 'daimon daemon start'`,
    });
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

  // The deep health check. `historyHealth: false` lets a REQUEST path (the
  // `why` route) run doctor's per-app rules without paying for it — quick_check
  // is still O(database size) (5.9s on the 610MB corpus), and `why` filters
  // this finding out of its response anyway.
  if (config.history.enabled && opts?.historyHealth !== false) {
    let ok = false;
    let detail: string | undefined;
    try {
      const h = history();
      if (!h) throw new Error('history db could not be opened');
      ok = h.quickCheck();
      const archived = h.archivedCorruptDbPath();
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
      const h = history();
      if (!h) throw new Error('history db unavailable');
      const since = Date.now() - 7 * 24 * 60 * 60_000;
      const events = h.queryEvents({ since, type: 'status', limit: 20_000 });
      const orphanCleanups = h.queryEvents({ app: '__daemon__', since: Date.now() - 24 * 60 * 60_000, limit: 500 })
        .filter(e => (e.message || '').startsWith('orphaned app detached'));
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
      const h = history();
      if (!h) throw new Error('history db unavailable');
      const crashes = h.queryCrashes({ since: Date.now() - 3600_000, limit: 1000 });
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

  // log-storm-active (M101, v1.2): an app whose log volume is currently
  // storming — the latest log-storm event in the last 6h has no matching
  // log-storm-end. Suggest-only, never auto-fixed: the remedy is to read the
  // spike, mute it, or stop the app.
  if (config.history.enabled) {
    try {
      const h = history();
      if (!h) throw new Error('history db unavailable');
      const since = Date.now() - 6 * 3600_000;
      const storms = h.queryEvents({ since, type: 'log-storm', limit: 1000 });
      const ends = h.queryEvents({ since, type: 'log-storm-end', limit: 1000 });
      const lastEnd = new Map<string, number>();
      for (const e of ends) lastEnd.set(e.app, Math.max(lastEnd.get(e.app) ?? 0, e.ts));
      let anyLogStorm = false;
      const seenApps = new Set<string>();
      for (const s of storms.sort((a, b) => b.ts - a.ts)) {
        if (seenApps.has(s.app)) continue;
        seenApps.add(s.app);
        if ((lastEnd.get(s.app) ?? 0) >= s.ts) continue;
        anyLogStorm = true;
        let rate = '';
        try {
          const d = JSON.parse(s.message ?? '{}');
          if (d.observedPerMin != null) rate = `${d.observedPerMin} lines/min vs baseline ${d.baselinePerMin ?? '?'} `;
        } catch {}
        checks.push({
          name: `log-storm-active: ${s.app}`,
          ok: false,
          detail: `${rate}since ${new Date(s.ts).toISOString()} — inspect with 'daimon logs ${s.app} --since 5m --level error', 'daimon mute ${s.app}' to silence notifications, or 'daimon stop ${s.app}'`,
        });
      }
      if (!anyLogStorm) checks.push({ name: 'log-storm', ok: true });
    } catch (err: any) {
      checks.push({ name: 'log-storm', ok: true, detail: `skipped: ${err?.message || err}` });
    }
  }

  // cpu-storm-active (M109, v1.3): the latest cpu-storm event in the last 6h
  // with no app restart since it (a restart resets the baseline and closes
  // the episode; re-arms are silent, so this is the honest offline signal).
  // ADVISE-ONLY, no auto-fix exists: warn-never-kill extends to doctor.
  if (config.history.enabled) {
    try {
      const h = history();
      if (!h) throw new Error('history db unavailable');
      const since = Date.now() - 6 * 3600_000;
      const storms = h.queryEvents({ since, type: 'cpu-storm', limit: 1000 });
      const statuses = h.queryEvents({ since, type: 'status', limit: 2000 });
      const lastStart = new Map<string, number>();
      for (const ev of statuses) {
        if (ev.to_state === 'starting') lastStart.set(ev.app, Math.max(lastStart.get(ev.app) ?? 0, ev.ts));
      }
      let anyCpuStorm = false;
      const seenApps = new Set<string>();
      for (const s of storms.sort((a, b) => b.ts - a.ts)) {
        if (seenApps.has(s.app)) continue;
        seenApps.add(s.app);
        if ((lastStart.get(s.app) ?? 0) >= s.ts) continue; // restarted since: episode closed
        anyCpuStorm = true;
        let rate = '';
        try {
          const d = JSON.parse(s.message ?? '{}');
          if (d.windowMeanPct != null) rate = `CPU ~${d.windowMeanPct}% vs baseline ${d.baselineCpuPct ?? '?'}% `;
        } catch {}
        checks.push({
          name: `cpu-storm-active: ${s.app}`,
          ok: false,
          detail: `${rate}since ${new Date(s.ts).toISOString()} — investigate with 'daimon why ${s.app}' and 'daimon logs ${s.app} --since 15m'; restarting the app recalibrates its baseline. Advise-only: daimon never kills or throttles.`,
        });
      }
      if (!anyCpuStorm) checks.push({ name: 'cpu-storm', ok: true });
    } catch (err: any) {
      checks.push({ name: 'cpu-storm', ok: true, detail: `skipped: ${err?.message || err}` });
    }
  }

  // env-file-missing (M82): a convention file that existed at the last spawn
  // snapshot but is gone now, or an envFiles.<app> config reference that never
  // resolves on disk. Suggest-only — never fails doctor, never auto-fixed.
  if (config.history.enabled) {
    try {
      const h = history();
      if (!h) throw new Error('history db unavailable');
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

  // port-pool-absent (M171, v1.14): at least one detected app's framework
  // profile documents a port-injection mechanism (portFlag/portEnv —
  // registry-declared, never guessed; M81), but no ports.pool is configured —
  // the first-run gap where every such app fights over the same hard-coded
  // default port. Suggest-only: doctor proposes the key, never writes it.
  if (!config.ports?.pool) {
    const profileMap = new Map(allProfiles(config.frameworks).map(p => [p.id, p]));
    const injectable = apps.filter(a => {
      const p = a.serverProfile ? profileMap.get(a.serverProfile) : undefined;
      return !!(p?.portFlag || p?.portEnv);
    });
    if (injectable.length > 0) {
      const profileNames = [...new Set(injectable.map(a => a.serverProfile))].join(', ');
      checks.push({
        name: 'port-pool-absent',
        ok: true,
        detail: `${injectable.length} detected app${injectable.length === 1 ? '' : 's'} (${profileNames}) can take a per-app port (portFlag/portEnv) but no "ports" pool is configured — add "ports": { "pool": "4200-4299" } to daimon.config.json so each gets its own port instead of colliding on the framework's default`,
      });
    }
  }

  // Plugin API v1 (M118): surface files that failed to load or validate, and
  // run plugin-contributed doctor rules. Advise-only both ways — doctor never
  // deletes or edits a user's plugin files (never-edit-user-source rule).
  // opts.plugins === false skips this section: the daemon's per-request
  // runDoctor call (/api/why) must not re-import plugin files — each
  // cache-busted import() is cached forever by Node's ESM loader, so loading
  // here on a request path would grow the daemon's module registry without
  // bound. CLI doctor runs in a short-lived process where fresh reads are
  // exactly what we want.
  if (opts?.plugins !== false) try {
    const loaded = await loadPlugins(pluginsDir(config.plugins?.dir ?? undefined));
    for (const p of loaded) {
      if (p.status !== 'active') {
        checks.push({
          name: `plugin-load-error: ${path.basename(p.file)}`,
          ok: false,
          detail: `${p.error} — fix or remove the file yourself, then 'daimon daemon restart' (doctor never touches plugin files)`,
        });
      }
    }
    const pluginCtx = Object.freeze({
      config,
      apps: apps.map(a => ({ name: a.name, framework: a.serverProfile ?? a.workspaceType ?? null, workspaceRoot: a.workspaceRoot ?? null })),
    });
    for (const p of loaded) {
      if (p.status !== 'active' || !p.rules?.length) continue;
      for (const rule of p.rules) {
        try {
          const r = await rule.check(pluginCtx);
          const arr = Array.isArray(r) ? r : [r];
          for (const f of arr) {
            if (f && typeof f === 'object' && typeof f.ok === 'boolean') {
              checks.push({ name: `plugin:${p.name}/${rule.id}`, ok: f.ok, detail: f.detail });
            }
          }
        } catch (err: any) {
          checks.push({
            name: `plugin:${p.name}/${rule.id}`,
            ok: false,
            detail: `check threw: ${err?.message ?? String(err)} — fix or remove the plugin file (advise-only; built-in rules are unaffected)`,
          });
        }
      }
    }
  } catch { /* plugins must never break doctor's built-in rules */ }

  checks.push({ name: 'agent token footprint', ok: true, detail: tokenFootprint(apps) });

  closeHistory();

  const ok = checks.every(c => c.ok);
  return { ok, checks };
}

// Reason -> remedy for no-apps-detected (M171, v1.14). Keys are the exact
// strings discovery.ts already bumps into stats.rejected — never invented
// here, so a remedy can only ever match a cause discovery itself recorded.
const NO_APPS_REMEDIES: Record<string, string> = {
  'searchRoot missing': "the configured searchRoot doesn't exist on disk — fix the path in daimon.config.json's searchRoots, or 'daimon workspaces rm' it",
  'no serve target': 'the nx/angular project(s) found have no serve target — add one, or point searchRoots at a different folder',
  'fallback superseded by named profile': 'a named framework profile matched the folder but produced no app (name collision or unsafe name) — run `daimon discover` for the per-folder detail',
  'package.json has no dev/serve/start script': "package.json was found but has no dev/serve/start script — add one, or run 'daimon frameworks' to see what each profile looks for",
  'no project markers': 'no framework markers matched at all — run `daimon frameworks` to see the registry, or check that searchRoots points at the right folder',
};

// Picks the single likeliest cause of an empty apps[] from discovery's own
// rejection tally, never a generic guess (M171, v1.14).
function noAppsDetectedDetail(config: AppmanConfig, stats?: DiscoveryStats): string {
  if (config.searchRoots.length === 0) {
    return "no searchRoots configured — run 'daimon init' in your workspace, or 'daimon workspaces add <path>'";
  }
  const rejected = stats?.rejected ?? {};
  const top = Object.entries(rejected).sort((a, b) => b[1] - a[1])[0];
  if (!top) {
    return `0 apps found across ${config.searchRoots.length} searchRoot${config.searchRoots.length === 1 ? '' : 's'} — run 'daimon discover' for the per-folder rejection breakdown, or 'daimon frameworks' for the registry`;
  }
  const [reason, count] = top;
  const remedy = NO_APPS_REMEDIES[reason] ?? "run 'daimon discover' for the full per-folder breakdown, or 'daimon frameworks' for the registry";
  return `0 apps found — likeliest cause: "${reason}" (${count}×). ${remedy}`;
}

// Pure system-directory membership check (M140): takes an already-normalized,
// lowercased, trailing-separator-stripped path so it is testable for BOTH the
// Windows and POSIX lists on either host — path.resolve is host-bound and can't
// represent a POSIX absolute path on Windows, so the resolve step stays in the
// caller and the platform-specific list logic lives here.
export function isSystemDir(normLower: string, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const systemDirs = win
    ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata']
    : ['/usr', '/etc', '/bin', '/sbin', '/var', '/system', '/library', '/opt/homebrew'];
  for (const sys of systemDirs) {
    if (normLower === sys || normLower.startsWith(sys + sep)) return true;
  }
  return false;
}

// Exported for `daimon why` (server-side) and tests.
export function suspiciousRootReason(root: string): string | null {
  const abs = path.resolve(root);
  const norm = abs.replace(/[\\/]+$/, '').toLowerCase();
  const parsedRoot = path.parse(abs).root.replace(/[\\/]+$/, '').toLowerCase();
  if (norm === parsedRoot) return 'drive/filesystem root';
  const home = os.homedir().replace(/[\\/]+$/, '').toLowerCase();
  if (norm === home) return 'home directory root';
  if (isSystemDir(norm)) return 'system directory';
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
