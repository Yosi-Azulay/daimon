import fs from 'node:fs';
import path from 'node:path';
import type { AppmanConfig, DiscoveredApp } from './types.js';
import { findCycle } from './depends.js';
import { isPortFree } from './ports.js';
import { History } from './history.js';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function runDoctor(config: AppmanConfig, apps: DiscoveredApp[]): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const appNames = new Set(apps.map(a => a.name));

  for (const sr of config.searchRoots) {
    const root = typeof sr === 'string' ? sr : sr.path;
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) {
      checks.push({ name: `searchRoot exists: ${abs}`, ok: false, detail: 'not found' });
      continue;
    }
    const hasMarker = fs.existsSync(path.join(abs, 'nx.json'))
      || fs.existsSync(path.join(abs, 'angular.json'))
      || fs.existsSync(path.join(abs, '.storybook'))
      || ['ts', 'js', 'mjs', 'cjs'].some(x => fs.existsSync(path.join(abs, `vite.config.${x}`)));
    checks.push({ name: `searchRoot has marker: ${abs}`, ok: hasMarker, detail: hasMarker ? undefined : 'no nx.json/angular.json/vite.config.*/.storybook' });
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

  const apiFree = await isPortFree(config.apiPort);
  checks.push({ name: `apiPort ${config.apiPort}`, ok: apiFree, detail: apiFree ? undefined : 'in use (may be held by us)' });

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

  checks.push({ name: 'agent token footprint', ok: true, detail: tokenFootprint(apps) });

  const ok = checks.every(c => c.ok);
  return { ok, checks };
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
