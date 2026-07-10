// `daimon report` (M83) — the digest engine. Pure COMPOSITION over existing
// history queries + registry state: no new analytics tables, no new state.
// The section list is closed (PLAN-locked): uptime, errors (new vs recurring
// vs resolved), tests (pass rate + flakiest), compiles (p50/p95 + slowest +
// regressions), crashes/storms, agents, env changes. Every section degrades
// independently — missing data yields a `note`, never an error.

import type { Registry } from './registry.js';
import type { History } from './history.js';
import { findFlakyTests } from './testRunners.js';
import { diffEnvSnapshots } from './envFiles.js';

export interface ReportOpts {
  // Window start (ms since epoch).
  since: number;
  until?: number;
  app?: string;
  workspace?: string;
}

export interface ReportInputs {
  registry: Registry;
  history: History | null;
  // Live agent registry snapshot (server-side); optional for CLI-side calls.
  agents?: { id: string; lastSeen: number }[];
  flakyThreshold?: number;
}

export interface Report {
  generatedAt: number;
  since: number;
  until: number;
  app: string | null;
  workspace: string | null;
  sections: Record<string, any>;
}

function pct(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

export function buildReport(inputs: ReportInputs, opts: ReportOpts): Report {
  const { registry, history: h } = inputs;
  const until = opts.until ?? Date.now();
  const since = opts.since;
  const windowMs = Math.max(1, until - since);

  // App scope: single app, workspace label, or everything the registry knows.
  const allApps = registry.list();
  const scoped = allApps.filter(a => {
    if (opts.app && a.name !== opts.app && a.baseName !== opts.app) return false;
    if (opts.workspace && a.workspaceLabel !== opts.workspace) return false;
    return true;
  });
  const scopedNames = new Set(scoped.map(a => a.name));
  const inScope = (app: string): boolean => scopedNames.has(app) || (!opts.app && !opts.workspace);

  const report: Report = {
    generatedAt: until,
    since,
    until,
    app: opts.app ?? null,
    workspace: opts.workspace ?? null,
    sections: {},
  };
  const S = report.sections;

  if (!scoped.length) {
    S.uptime = { note: opts.app ? `unknown app: ${opts.app}` : 'no apps in scope' };
  }

  // --- uptime -----------------------------------------------------------
  try {
    if (!h) {
      S.uptime = { note: 'history disabled — uptime unavailable' };
    } else if (scoped.length) {
      const rows: { app: string; uptimePct: number | null; restarts: number; status: string }[] = [];
      for (const a of scoped.slice(0, 50)) {
        const events = h.queryEvents({ app: a.name, since, until, type: 'status', limit: 5000 });
        if (!events.length) {
          rows.push({ app: a.name, uptimePct: a.status === 'serving' ? 100 : null, restarts: 0, status: a.status });
          continue;
        }
        const ordered = [...events].sort((x, y) => x.ts - y.ts);
        let serving = 0;
        let servingSince: number | null = null;
        // State at window start: infer from the first event's from_state.
        if (ordered[0].from_state === 'serving') servingSince = since;
        for (const ev of ordered) {
          if (ev.to_state === 'serving' && servingSince == null) servingSince = ev.ts;
          else if (ev.to_state !== 'serving' && servingSince != null) { serving += ev.ts - servingSince; servingSince = null; }
        }
        if (servingSince != null) serving += until - servingSince;
        const restarts = ordered.filter(ev => ev.to_state === 'starting' && (ev.from_state === 'serving' || ev.from_state === 'error' || ev.from_state === 'compiling')).length;
        rows.push({ app: a.name, uptimePct: Math.round((serving / windowMs) * 1000) / 10, restarts, status: a.status });
      }
      S.uptime = rows.length ? { apps: rows } : { note: 'no status activity in the window' };
    }
  } catch (err: any) {
    S.uptime = { note: `unavailable: ${err?.message || err}` };
  }

  // --- errors: new vs recurring vs resolved ------------------------------
  try {
    if (!h) {
      S.errors = { note: 'history disabled — error history unavailable' };
    } else {
      const evs = h.queryEvents({ app: opts.app, since, until, limit: 10000 })
        .filter(e => (e.type === 'error-new' || e.type === 'error-recur') && inScope(e.app));
      if (!evs.length) {
        S.errors = { note: 'no errors in the window' };
      } else {
        const groups = new Map<string, { app: string; message: string; count: number; first: number; last: number; sawNew: boolean }>();
        for (const e of evs) {
          const msg = e.message ?? '';
          const key = `${e.app}::${msg}`;
          const g = groups.get(key) ?? { app: e.app, message: msg.slice(0, 200), count: 0, first: e.ts, last: e.ts, sawNew: false };
          g.count++;
          g.first = Math.min(g.first, e.ts);
          g.last = Math.max(g.last, e.ts);
          if (e.type === 'error-new') g.sawNew = true;
          groups.set(key, g);
        }
        // Resolved = seen in the window but absent from the app's CURRENT
        // error map (compile fixed it / app restarted clean).
        const currentByApp = new Map<string, Set<string>>();
        for (const a of scoped) {
          currentByApp.set(a.name, new Set((registry.errors(a.name) ?? []).map(x => x.message)));
        }
        const list = [...groups.values()].map(g => ({
          app: g.app,
          message: g.message,
          count: g.count,
          first: g.first,
          last: g.last,
          kind: g.sawNew ? 'new' : 'recurring',
          resolved: !(currentByApp.get(g.app)?.has(g.message) ?? false),
        })).sort((a, b) => b.count - a.count);
        S.errors = {
          total: evs.length,
          groups: list.slice(0, 15),
          newCount: list.filter(g => g.kind === 'new').length,
          recurringCount: list.filter(g => g.kind === 'recurring').length,
          resolvedCount: list.filter(g => g.resolved).length,
        };
      }
    }
  } catch (err: any) {
    S.errors = { note: `unavailable: ${err?.message || err}` };
  }

  // --- tests --------------------------------------------------------------
  try {
    if (!h) {
      S.tests = { note: 'history disabled — test history unavailable' };
    } else {
      const runs = h.queryTestRuns({ app: opts.app, since, limit: 200 }).filter(r => r.ts <= until && inScope(r.app));
      if (!runs.length) {
        S.tests = { note: 'no test runs in the window' };
      } else {
        let passed = 0, total = 0;
        for (const r of runs) {
          if (typeof r.passed === 'number') passed += r.passed;
          if (typeof r.total === 'number') total += r.total;
        }
        const threshold = inputs.flakyThreshold ?? 3;
        const heads = [...new Set(runs.map(r => r.gitHead).filter((g): g is string => !!g))];
        const flaky = heads.flatMap(head => findFlakyTests(runs, ids => h.queryTestFailures(ids), head, threshold));
        S.tests = {
          runs: runs.length,
          failedRuns: runs.filter(r => (r.failed ?? 0) > 0 || (r.exitCode != null && r.exitCode !== 0)).length,
          passRatePct: total > 0 ? Math.round((passed / total) * 1000) / 10 : null,
          flakiest: flaky.sort((a, b) => b.flips - a.flips).slice(0, 5),
        };
      }
    }
  } catch (err: any) {
    S.tests = { note: `unavailable: ${err?.message || err}` };
  }

  // --- compiles -------------------------------------------------------------
  try {
    if (!h) {
      S.compiles = { note: 'history disabled — compile history unavailable' };
    } else {
      const rows = h.queryCompiles({ app: opts.app, since, until, limit: 10000 }).filter(r => inScope(r.app));
      if (!rows.length) {
        S.compiles = { note: 'no compiles in the window' };
      } else {
        const times = rows.map(r => r.ms);
        const slowest = rows.reduce((m, r) => (r.ms > m.ms ? r : m), rows[0]);
        const regressions = h.queryEvents({ app: opts.app, since, until, type: 'regression-detected', limit: 50 })
          .filter(e => inScope(e.app))
          .map(e => { try { return { app: e.app, ts: e.ts, ...JSON.parse(e.message ?? '{}') }; } catch { return { app: e.app, ts: e.ts }; } })
          .slice(0, 10);
        S.compiles = {
          count: rows.length,
          p50Ms: pct(times, 0.5),
          p95Ms: pct(times, 0.95),
          slowest: { app: slowest.app, ms: slowest.ms, ts: slowest.ts },
          regressions,
        };
      }
    }
  } catch (err: any) {
    S.compiles = { note: `unavailable: ${err?.message || err}` };
  }

  // --- crashes + storms -------------------------------------------------------
  try {
    if (!h) {
      S.crashes = { note: 'history disabled — crash history unavailable' };
    } else {
      const crashes = h.queryCrashes({ app: opts.app, since, limit: 200 }).filter(c => c.ts <= until && inScope(c.app));
      const storms = h.queryEvents({ app: opts.app, since, until, type: 'restart-storm', limit: 50 })
        .filter(e => inScope(e.app))
        .map(e => { try { return { ts: e.ts, ...JSON.parse(e.message ?? '{}') }; } catch { return { ts: e.ts, app: e.app }; } });
      if (!crashes.length && !storms.length) {
        S.crashes = { note: 'no crashes in the window' };
      } else {
        const byApp = new Map<string, number>();
        for (const c of crashes) byApp.set(c.app, (byApp.get(c.app) ?? 0) + 1);
        S.crashes = {
          total: crashes.length,
          byApp: [...byApp.entries()].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count),
          last: crashes[0] ? { app: crashes[0].app, ts: crashes[0].ts, exitCode: crashes[0].exitCode, signal: crashes[0].signal } : null,
          storms,
        };
      }
    }
  } catch (err: any) {
    S.crashes = { note: `unavailable: ${err?.message || err}` };
  }

  // --- agent activity ----------------------------------------------------------
  try {
    const active = (inputs.agents ?? []).filter(a => a.lastSeen >= since);
    const taskRuns = h
      ? h.queryTasks({ app: opts.app, since, limit: 500 }).filter(t => t.ts <= until && inScope(t.app))
      : [];
    if (!active.length && !taskRuns.length) {
      S.agents = { note: 'no agent activity in the window' };
    } else {
      const tasksByApp = new Map<string, number>();
      for (const t of taskRuns) tasksByApp.set(t.app, (tasksByApp.get(t.app) ?? 0) + 1);
      S.agents = {
        active: active.slice(0, 10),
        taskRuns: taskRuns.length,
        taskRunsByApp: [...tasksByApp.entries()].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      };
    }
  } catch (err: any) {
    S.agents = { note: `unavailable: ${err?.message || err}` };
  }

  // --- env changes -----------------------------------------------------------
  try {
    if (!h) {
      S.env = { note: 'history disabled — env snapshots unavailable' };
    } else {
      const changes: any[] = [];
      for (const a of scoped.slice(0, 50)) {
        const snaps = h.queryEnvSnapshots({ app: a.name, limit: 20 });
        const inWindow = snaps.filter(s => s.ts >= since && s.ts <= until);
        if (!inWindow.length) continue;
        const latest = inWindow[0];
        // Baseline: last snapshot before the window, else the oldest in-window.
        const baseline = snaps.find(s => s.ts < since) ?? inWindow[inWindow.length - 1];
        if (baseline.id === latest.id) continue;
        try {
          const d = diffEnvSnapshots(JSON.parse(baseline.json), JSON.parse(latest.json));
          if (d.changed) changes.push({ app: a.name, from: baseline.ts, to: latest.ts, ...d });
        } catch {}
      }
      S.env = changes.length ? { changes } : { note: 'no env changes in the window' };
    }
  } catch (err: any) {
    S.env = { note: `unavailable: ${err?.message || err}` };
  }

  return report;
}

// ---------------------------------------------------------------------------
// Markdown rendering (--md): human-first, paste-into-Slack/PR friendly.
// ---------------------------------------------------------------------------

function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

export function renderReportMd(r: Report): string {
  const L: string[] = [];
  const windowH = Math.round((r.until - r.since) / 3600_000);
  const scope = [r.app ? `app \`${r.app}\`` : null, r.workspace ? `workspace \`${r.workspace}\`` : null].filter(Boolean).join(', ');
  L.push(`# daimon report — last ${windowH >= 48 ? `${Math.round(windowH / 24)}d` : `${windowH}h`}${scope ? ` (${scope})` : ''}`);
  L.push(`_generated ${fmtTs(r.generatedAt)}_`);
  L.push('');

  const S = r.sections;

  L.push('## Uptime');
  if (S.uptime?.note) L.push(`> ${S.uptime.note}`);
  else {
    for (const a of S.uptime?.apps ?? []) {
      L.push(`- **${a.app}** — ${a.uptimePct != null ? a.uptimePct + '%' : 'n/a'} serving, ${a.restarts} restart${a.restarts === 1 ? '' : 's'} (now: ${a.status})`);
    }
  }
  L.push('');

  L.push('## Errors');
  if (S.errors?.note) L.push(`> ${S.errors.note}`);
  else {
    L.push(`${S.errors.total} error events · ${S.errors.newCount} new group${S.errors.newCount === 1 ? '' : 's'} · ${S.errors.recurringCount} recurring · ${S.errors.resolvedCount} resolved`);
    for (const g of (S.errors.groups ?? []).slice(0, 8)) {
      L.push(`- [${g.kind}${g.resolved ? ', resolved' : ''}] **${g.app}** ×${g.count}: ${g.message.slice(0, 120)}`);
    }
  }
  L.push('');

  L.push('## Tests');
  if (S.tests?.note) L.push(`> ${S.tests.note}`);
  else {
    L.push(`${S.tests.runs} run${S.tests.runs === 1 ? '' : 's'} · ${S.tests.failedRuns} failed · pass rate ${S.tests.passRatePct != null ? S.tests.passRatePct + '%' : 'n/a'}`);
    for (const f of S.tests.flakiest ?? []) {
      L.push(`- flaky: \`${f.test ?? f.fingerprint}\` (${f.flips} flips)`);
    }
  }
  L.push('');

  L.push('## Compiles');
  if (S.compiles?.note) L.push(`> ${S.compiles.note}`);
  else {
    L.push(`${S.compiles.count} compiles · p50 ${fmtDur(S.compiles.p50Ms)} · p95 ${fmtDur(S.compiles.p95Ms)} · slowest ${fmtDur(S.compiles.slowest?.ms)} (${S.compiles.slowest?.app})`);
    for (const g of (S.compiles.regressions ?? []).slice(0, 5)) {
      L.push(`- regression: **${g.app}** ${g.kind ?? ''} ${g.suspectCommit ? `— suspect ${String(g.suspectCommit).slice(0, 60)}` : ''}`.trimEnd());
    }
  }
  L.push('');

  L.push('## Crashes & storms');
  if (S.crashes?.note) L.push(`> ${S.crashes.note}`);
  else {
    L.push(`${S.crashes.total} crash${S.crashes.total === 1 ? '' : 'es'}${S.crashes.storms?.length ? ` · ${S.crashes.storms.length} restart-storm event${S.crashes.storms.length === 1 ? '' : 's'}` : ''}`);
    for (const b of (S.crashes.byApp ?? []).slice(0, 5)) L.push(`- **${b.app}** ×${b.count}`);
  }
  L.push('');

  L.push('## Agents');
  if (S.agents?.note) L.push(`> ${S.agents.note}`);
  else {
    L.push(`${(S.agents.active ?? []).length} active agent${(S.agents.active ?? []).length === 1 ? '' : 's'} · ${S.agents.taskRuns} task run${S.agents.taskRuns === 1 ? '' : 's'}`);
    for (const t of (S.agents.taskRunsByApp ?? []).slice(0, 5)) L.push(`- **${t.app}** ×${t.count}`);
  }
  L.push('');

  L.push('## Env changes');
  if (S.env?.note) L.push(`> ${S.env.note}`);
  else {
    for (const c of (S.env.changes ?? []).slice(0, 10)) {
      const bits: string[] = [];
      if (c.filesAdded?.length) bits.push(`files added: ${c.filesAdded.join(', ')}`);
      if (c.filesRemoved?.length) bits.push(`files removed: ${c.filesRemoved.join(', ')}`);
      if (c.keysAdded?.length) bits.push(`+${c.keysAdded.length} key${c.keysAdded.length === 1 ? '' : 's'}`);
      if (c.keysRemoved?.length) bits.push(`-${c.keysRemoved.length} key${c.keysRemoved.length === 1 ? '' : 's'}`);
      if (c.keysChanged?.length) bits.push(`changed: ${c.keysChanged.map((k: any) => k.key).join(', ')}`);
      L.push(`- **${c.app}** — ${bits.join(' · ')}`);
    }
  }
  L.push('');
  L.push('_values are never included — env changes list key names only_');

  return L.join('\n');
}
