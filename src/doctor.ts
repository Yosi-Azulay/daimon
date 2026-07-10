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
    const nm = path.join(r, 'node_modules');
    checks.push({ name: `node_modules: ${r}`, ok: fs.existsSync(nm), detail: fs.existsSync(nm) ? undefined : 'missing' });
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
