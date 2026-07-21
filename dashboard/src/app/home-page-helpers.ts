// Pure helpers for the overview home (M158, v1.12), extracted so the pass-rate
// math is unit-tested under Vitest without the Angular runtime. The home page
// recomposes existing endpoints only — no new API — so these operate on shapes
// the daemon already returns.

export interface PassRateInput {
  passed: number | null;
  total: number | null;
}

export interface PassRate {
  /** Overall pass percentage across the counted runs, or null when nothing had totals. */
  pct: number | null;
  /** How many runs contributed a usable total. */
  runs: number;
  passed: number;
  total: number;
}

// Aggregate pass-rate across recent test runs. Fail-soft like everything test-
// related in daimon: a run without a numeric total (a parser that couldn't
// read totals) simply doesn't contribute — it is NOT counted as 0/0 — and if
// nothing has totals the pct is null (a note), never a fabricated 0%.
export function computePassRate(runs: PassRateInput[]): PassRate {
  let passed = 0;
  let total = 0;
  let counted = 0;
  for (const r of runs) {
    if (typeof r.total === 'number' && r.total > 0 && typeof r.passed === 'number' && r.passed >= 0) {
      passed += r.passed;
      total += Math.max(r.passed, r.total >= r.passed ? r.total : r.passed);
      counted++;
    }
  }
  return { pct: total > 0 ? Math.round((passed / total) * 100) : null, runs: counted, passed, total };
}

// Bucket a pass percentage into a status tone for the widget accent.
export function passRateTone(pct: number | null): 'ok' | 'warn' | 'error' | 'muted' {
  if (pct === null) return 'muted';
  if (pct >= 95) return 'ok';
  if (pct >= 80) return 'warn';
  return 'error';
}

export interface StatusTotals {
  apps: number;
  serving: number;
  errors: number;
  stopped: number;
}

// Normalize the overview totals into a plain object the widget renders,
// tolerating a missing/partial overview (every field defaults to 0).
export function statusSummary(totals: Partial<StatusTotals> | null | undefined): StatusTotals {
  return {
    apps: totals?.apps ?? 0,
    serving: totals?.serving ?? 0,
    errors: totals?.errors ?? 0,
    stopped: totals?.stopped ?? 0,
  };
}

// Workspace filtering (M177, v1.15): when a workspace filter is active the
// Status widget can't use the server's daemon-wide overview.totals anymore,
// so it recomputes the same counts client-side from the (already
// workspace-filtered) app rows. Mirrors apps-list's status-chip counting
// (serving/errors/stopped), so the two surfaces never disagree.
export function statusSummaryFromApps(apps: { status: string; errorCount: number }[]): StatusTotals {
  let serving = 0, errors = 0, stopped = 0;
  for (const a of apps) {
    if (a.status === 'serving') serving++;
    if (a.status === 'error' || (a.errorCount ?? 0) > 0) errors++;
    if (a.status === 'stopped') stopped++;
  }
  return { apps: apps.length, serving, errors, stopped };
}

export interface ResourceTotals {
  cpuPct: number | null;
  memMb: number | null;
}

// The per-app-aggregate half of the Resources widget (App CPU / App memory),
// recomputed from workspace-filtered app rows the same way statusSummaryFromApps
// recomputes Status — Daemon RSS stays server-global and is never filtered.
export function resourceTotalsFromApps(apps: { cpu?: number | null; memMB?: number | null }[]): ResourceTotals {
  let cpuSum = 0, cpuCount = 0, memSum = 0, memCount = 0;
  for (const a of apps) {
    if (typeof a.cpu === 'number') { cpuSum += a.cpu; cpuCount++; }
    if (typeof a.memMB === 'number') { memSum += a.memMB; memCount++; }
  }
  return { cpuPct: cpuCount > 0 ? cpuSum : null, memMb: memCount > 0 ? memSum : null };
}

// Rows keyed by app name (needs-attention items) or by `.app` (test runs)
// share the same membership-Set-or-null shape from workspace-helpers'
// workspaceMemberNames() — this just applies it, `null` meaning "no filter".
export function filterByMemberSet<T>(items: T[], members: Set<string> | null, key: (item: T) => string): T[] {
  return members === null ? items : items.filter(i => members.has(key(i)));
}
