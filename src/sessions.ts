// Session derivation (M134, v1.8 "Rewind"). A session is a contiguous
// daemon-uptime slice — DERIVED, never stored: no sessions table, no session
// events, no new analytics state. Boundaries come from the two daemon-lifecycle
// self-events already in history under the synthetic `__daemon__` app
// (`daemon-start` opens a slice, `daemon-stop` closes it cleanly); everything
// else — apps touched, error/test/compile counts, the `show` blocks — is pure
// COMPOSITION over the existing History queries, exactly like report.ts.
//
// Determinism is the whole point: a session id is `s-<startTsMs>`, so a deep
// link minted today still resolves after any number of re-derivations. The
// derivation is recomputed on demand; the M134 bench proved it stays under
// budget on the 100k-event corpus, so NO cache ships (the plan's "measure
// first" — a cache would only ever be a rebuildable in-memory boundary map,
// never a table).

import type { History } from './history.js';
import { diffEnvSnapshots } from './envFiles.js';

// The synthetic app under which the daemon records its own lifecycle + warnings.
export const DAEMON_APP = '__daemon__';

export interface SessionSummary {
  id: string;
  start: number;
  // null === the current, still-open session.
  end: number | null;
  durationMs: number;
  // true = clean daemon-stop; false = unclean (a later daemon-start with no
  // intervening stop — a crash/kill); null = the open current session.
  endedCleanly: boolean | null;
  current: boolean;
  // Apps touched in the slice (excludes the synthetic daemon app), sorted.
  apps: string[];
  errorCount: number;
  testRunCount: number;
  compileCount: number;
}

interface Boundary {
  id: string;
  start: number;
  end: number | null;
  endedCleanly: boolean | null;
  current: boolean;
}

// ---------------------------------------------------------------------------
// Boundaries — the exact rules the rest of the release is built on.
// ---------------------------------------------------------------------------

// Derive raw session boundaries oldest→newest from the daemon lifecycle events.
// Pure over one indexed query (app = __daemon__) plus, for each unclean slice,
// a single bounded "last event before the next boot" lookup.
export function deriveBoundaries(h: History | null, now = Date.now()): Boundary[] {
  if (!h) return [];
  const daemonEvents = h
    .queryEvents({ app: DAEMON_APP, limit: 100000 })
    .filter(e => e.type === 'daemon-start' || e.type === 'daemon-stop')
    // Oldest→newest; at an equal ts a stop sorts BEFORE a start so a same-ms
    // restart closes the old daemon's session cleanly before the new one opens
    // (start-first would spuriously flag the prior slice unclean).
    .sort((a, b) => a.ts - b.ts || (a.type === 'daemon-stop' ? -1 : 1));

  const out: Boundary[] = [];
  let openStart: number | null = null;

  const push = (start: number, end: number | null, endedCleanly: boolean | null, current: boolean) => {
    out.push({ id: `s-${start}`, start, end, endedCleanly, current });
  };

  for (const ev of daemonEvents) {
    if (ev.type === 'daemon-start') {
      if (openStart != null) {
        // A boot with no intervening stop: the previous daemon died unclean.
        // Close it at its last observed event timestamp (any kind), which the
        // crash self-event, when present, naturally supplies as the newest row.
        const end = lastObservedBefore(h, openStart, ev.ts);
        push(openStart, end, false, false);
      }
      openStart = ev.ts;
    } else {
      // daemon-stop
      if (openStart != null) {
        push(openStart, ev.ts, true, false);
        openStart = null;
      }
      // A stop with no open session (truncated history) is ignored — fail-soft.
    }
  }
  if (openStart != null) push(openStart, null, null, true);
  return out;
}

// The newest event of any kind strictly before the next boot — the moment the
// unclean daemon last showed a sign of life. Falls back to the boot ts itself
// for a zero-activity slice so end >= start always holds.
function lastObservedBefore(h: History, start: number, nextStart: number): number {
  const rows = h.queryEvents({ since: start, until: nextStart - 1, limit: 1 });
  return rows.length ? rows[0].ts : start;
}

// ---------------------------------------------------------------------------
// List — boundaries + per-slice counts, newest first. One windowed pass over
// each source table (events / compiles / test runs), bucketed by a pointer walk
// so cost is O(rows) regardless of how many sessions the corpus holds.
// ---------------------------------------------------------------------------

export function listSessions(h: History | null, opts: { since?: number; now?: number } = {}): SessionSummary[] {
  const now = opts.now ?? Date.now();
  const boundaries = deriveBoundaries(h, now);
  if (!boundaries.length) return [];

  // Per-slice counts via the windowed SQL aggregates in the DB layer. Each
  // session window [start, end] is bounded and indexed, and gap rows fall
  // outside every window — so this stays cheap even on the 100k corpus.
  const summaries: SessionSummary[] = boundaries.map(b => {
    const end = b.end ?? now;
    const counts = h ? h.sliceCounts(b.start, end) : { apps: [], errorCount: 0, compileCount: 0, testRunCount: 0 };
    return {
      id: b.id,
      start: b.start,
      end: b.end,
      durationMs: end - b.start,
      endedCleanly: b.endedCleanly,
      current: b.current,
      apps: counts.apps,
      errorCount: counts.errorCount,
      testRunCount: counts.testRunCount,
      compileCount: counts.compileCount,
    };
  });

  const sinceTs = opts.since;
  const filtered = sinceTs != null
    ? summaries.filter(s => (s.end ?? now) >= sinceTs)
    : summaries;

  // Newest first, per CLI convention.
  return filtered.sort((a, b) => b.start - a.start);
}

// ---------------------------------------------------------------------------
// Show — one session as a compact digest. Closed block list; every block is
// composed from existing history queries scoped to [start, end] and degrades
// independently to a { note }, never an error.
// ---------------------------------------------------------------------------

export interface SessionDetail extends SessionSummary {
  blocks: Record<string, any>;
}

function pct(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

// Find one session by id (or null). Cheap — boundaries only, no counts.
export function findSession(h: History | null, id: string, now = Date.now()): Boundary | null {
  return deriveBoundaries(h, now).find(b => b.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Session context for `daimon why` (M138, v1.8). The failure, situated in what
// else was happening in the same session before it — errors in OTHER apps, env
// changes, compile regressions. Additive + degradable: null when history is
// disabled; a { sessionId: null, note } when the failure predates any derivable
// session; a brief note when the session was otherwise quiet. Composition over
// the slice queries only — the failure's own errors are excluded (they are the
// rest of the why response).
export interface SessionContext {
  sessionId: string | null;
  start?: number;
  otherAppErrors?: { app: string; message: string; count: number }[];
  envChanges?: { app: string; from: number; to: number; [k: string]: any }[];
  regressions?: { app: string; ts: number; [k: string]: any }[];
  note?: string;
}

export function buildSessionContext(h: History | null, opts: { app: string; ts: number; now?: number }): SessionContext | null {
  if (!h) return null;
  const now = opts.now ?? Date.now();
  const anchor = opts.ts;
  const boundaries = deriveBoundaries(h, now);
  // The session the failure belongs to: [start, end (or now for current)].
  const session = boundaries.find(b => anchor >= b.start && anchor <= (b.end ?? now));
  if (!session) {
    return { sessionId: null, note: 'no derivable session for this failure (pre-history or before the first daemon-start)' };
  }
  const start = session.start;
  const ctx: SessionContext = { sessionId: session.id, start };

  try {
    // Errors in OTHER apps, before the failure.
    const evs = h.queryEvents({ since: start, until: anchor, limit: 20000 })
      .filter(e => (e.type === 'error-new' || e.type === 'error-recur') && e.app !== opts.app && e.app !== DAEMON_APP);
    if (evs.length) {
      const groups = new Map<string, { app: string; message: string; count: number }>();
      for (const e of evs) {
        const key = `${e.app}::${e.message ?? ''}`;
        const g = groups.get(key) ?? { app: e.app, message: (e.message ?? '').slice(0, 160), count: 0 };
        g.count++;
        groups.set(key, g);
      }
      const list = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 5);
      if (list.length) ctx.otherAppErrors = list;
    }

    // Compile/bundle regressions anywhere in the session before the failure.
    const regs = h.queryEvents({ since: start, until: anchor, type: 'regression-detected', limit: 50 })
      .map(r => { try { return { app: r.app, ts: r.ts, ...JSON.parse(r.message ?? '{}') }; } catch { return { app: r.app, ts: r.ts }; } });
    if (regs.length) ctx.regressions = regs.slice(0, 5);

    // Env changes in the session (key names only, never values).
    const changes: SessionContext['envChanges'] = [];
    const appsInSession = h.sliceCounts(start, session.end ?? now).apps;
    for (const app of appsInSession) {
      const snaps = h.queryEnvSnapshots({ app, limit: 40 });
      const inWindow = snaps.filter(s => s.ts >= start && s.ts <= anchor);
      if (!inWindow.length) continue;
      const latest = inWindow[0];
      const baseline = snaps.find(s => s.ts < start) ?? inWindow[inWindow.length - 1];
      if (baseline.id === latest.id) continue;
      try {
        const d = diffEnvSnapshots(JSON.parse(baseline.json), JSON.parse(latest.json));
        if (d.changed) changes.push({ app, from: baseline.ts, to: latest.ts, ...d });
      } catch {}
    }
    if (changes.length) ctx.envChanges = changes;
  } catch {
    // Fail-soft: a partial context is fine; never let this break a why response.
  }

  if (!ctx.otherAppErrors && !ctx.regressions && !ctx.envChanges) {
    ctx.note = 'nothing else happened in this session before the failure';
  }
  return ctx;
}

export function showSession(h: History | null, id: string, now = Date.now()): SessionDetail | null {
  const list = listSessions(h, { now });
  const summary = list.find(s => s.id === id);
  if (!summary) return null;
  const start = summary.start;
  const end = summary.end ?? now;
  const blocks: Record<string, any> = {};

  // --- apps started / stopped -------------------------------------------
  try {
    if (!h) {
      blocks.apps = { note: 'history disabled' };
    } else {
      const evs = h.queryEvents({ since: start, until: end, type: 'status', limit: 20000 })
        .filter(e => e.app !== DAEMON_APP);
      const started = new Set<string>();
      const stopped = new Set<string>();
      for (const e of evs) {
        if (e.to_state === 'starting') started.add(e.app);
        if (e.to_state === 'stopped') stopped.add(e.app);
      }
      blocks.apps = (started.size || stopped.size)
        ? { started: [...started].sort(), stopped: [...stopped].sort() }
        : { note: 'no app lifecycle in this session' };
    }
  } catch (err: any) {
    blocks.apps = { note: `unavailable: ${err?.message || err}` };
  }

  // --- error groups: new vs recurring -----------------------------------
  try {
    if (!h) {
      blocks.errors = { note: 'history disabled' };
    } else {
      const evs = h.queryEvents({ since: start, until: end, limit: 20000 })
        .filter(e => e.type === 'error-new' || e.type === 'error-recur');
      if (!evs.length) {
        blocks.errors = { note: 'no errors in this session' };
      } else {
        const groups = new Map<string, { app: string; message: string; count: number; sawNew: boolean }>();
        for (const e of evs) {
          const msg = e.message ?? '';
          const key = `${e.app}::${msg}`;
          const g = groups.get(key) ?? { app: e.app, message: msg.slice(0, 200), count: 0, sawNew: false };
          g.count++;
          if (e.type === 'error-new') g.sawNew = true;
          groups.set(key, g);
        }
        const list = [...groups.values()]
          .map(g => ({ app: g.app, message: g.message, count: g.count, kind: g.sawNew ? 'new' : 'recurring' }))
          .sort((a, b) => b.count - a.count);
        blocks.errors = {
          total: evs.length,
          newCount: list.filter(g => g.kind === 'new').length,
          recurringCount: list.filter(g => g.kind === 'recurring').length,
          groups: list.slice(0, 15),
        };
      }
    }
  } catch (err: any) {
    blocks.errors = { note: `unavailable: ${err?.message || err}` };
  }

  // --- test runs --------------------------------------------------------
  try {
    if (!h) {
      blocks.tests = { note: 'history disabled' };
    } else {
      const runs = h.queryTestRuns({ since: start, limit: 5000 }).filter(r => r.ts <= end);
      if (!runs.length) {
        blocks.tests = { note: 'no test runs in this session' };
      } else {
        let passed = 0, total = 0;
        for (const r of runs) {
          if (typeof r.passed === 'number') passed += r.passed;
          if (typeof r.total === 'number') total += r.total;
        }
        blocks.tests = {
          runs: runs.length,
          failedRuns: runs.filter(r => (r.failed ?? 0) > 0 || (r.exitCode != null && r.exitCode !== 0)).length,
          passRatePct: total > 0 ? Math.round((passed / total) * 1000) / 10 : null,
        };
      }
    }
  } catch (err: any) {
    blocks.tests = { note: `unavailable: ${err?.message || err}` };
  }

  // --- compiles: p50/p95 ------------------------------------------------
  try {
    if (!h) {
      blocks.compiles = { note: 'history disabled' };
    } else {
      const rows = h.queryCompiles({ since: start, until: end, limit: 20000 });
      if (!rows.length) {
        blocks.compiles = { note: 'no compiles in this session' };
      } else {
        const times = rows.map(r => r.ms);
        const slowest = rows.reduce((m, r) => (r.ms > m.ms ? r : m), rows[0]);
        blocks.compiles = {
          count: rows.length,
          p50Ms: pct(times, 0.5),
          p95Ms: pct(times, 0.95),
          slowest: { app: slowest.app, ms: slowest.ms, ts: slowest.ts },
        };
      }
    }
  } catch (err: any) {
    blocks.compiles = { note: `unavailable: ${err?.message || err}` };
  }

  // --- crashes ----------------------------------------------------------
  try {
    if (!h) {
      blocks.crashes = { note: 'history disabled' };
    } else {
      const crashes = h.queryCrashes({ since: start, limit: 200 }).filter(c => c.ts <= end);
      blocks.crashes = crashes.length
        ? {
            total: crashes.length,
            last: { app: crashes[0].app, ts: crashes[0].ts, exitCode: crashes[0].exitCode, signal: crashes[0].signal },
          }
        : { note: 'no crashes in this session' };
    }
  } catch (err: any) {
    blocks.crashes = { note: `unavailable: ${err?.message || err}` };
  }

  // --- env changes ------------------------------------------------------
  // Values are NEVER present — env snapshots carry key names + salted hashes
  // only; diffEnvSnapshots reports names. Baseline is the last snapshot before
  // the session, else the oldest in-session.
  try {
    if (!h) {
      blocks.env = { note: 'history disabled' };
    } else {
      const changes: any[] = [];
      for (const app of summary.apps) {
        const snaps = h.queryEnvSnapshots({ app, limit: 40 });
        const inWindow = snaps.filter(s => s.ts >= start && s.ts <= end);
        if (!inWindow.length) continue;
        const latest = inWindow[0];
        const baseline = snaps.find(s => s.ts < start) ?? inWindow[inWindow.length - 1];
        if (baseline.id === latest.id) continue;
        try {
          const d = diffEnvSnapshots(JSON.parse(baseline.json), JSON.parse(latest.json));
          if (d.changed) changes.push({ app, from: baseline.ts, to: latest.ts, ...d });
        } catch {}
      }
      blocks.env = changes.length ? { changes } : { note: 'no env changes in this session' };
    }
  } catch (err: any) {
    blocks.env = { note: `unavailable: ${err?.message || err}` };
  }

  return { ...summary, blocks };
}
