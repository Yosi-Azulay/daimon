// Pure helpers extracted from tests-page so they're unit-testable under Vitest
// without spinning up the Angular runtime. Types here are the dashboard's
// mirror of src/history.ts's TestRunRow/TestFailureRow and
// src/testRunners.ts's FlakyTest — kept structurally compatible with the
// GET /api/tests and GET /api/tests/flaky response shapes (M74/M75).

export interface TestFailure {
  suite: string | null;
  test: string | null;
  file: string | null;
  line: number | null;
  message: string | null;
  fingerprint: string | null;
}

export interface TestRun {
  id: number;
  ts: number;
  app: string;
  runner: string | null;
  durationMs: number | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  exitCode: number | null;
  gitHead: string | null;
  failures: TestFailure[];
}

export interface FlakyTest {
  fingerprint: string;
  test: string;
  suite: string;
  flips: number;
  gitHead: string;
}

export type RunOutcome = 'pass' | 'fail' | 'unknown';

export function vscodeUri(file: string, line?: number): string {
  const enc = encodeURI(file.replace(/\\/g, '/'));
  return `vscode://file/${enc}${typeof line === 'number' ? `:${line}` : ''}`;
}

export function runOutcome(run: TestRun): RunOutcome {
  if ((run.failed ?? 0) > 0) return 'fail';
  if (run.exitCode != null) return run.exitCode === 0 ? 'pass' : 'fail';
  return 'unknown';
}

export function runLabel(run: TestRun): string {
  const total = run.total ?? ((run.passed ?? 0) + (run.failed ?? 0) + (run.skipped ?? 0));
  if (!total && run.exitCode == null) return 'no data';
  if (!total) return `exit ${run.exitCode}`;
  const parts = [`${run.passed ?? 0}/${total}`];
  if ((run.failed ?? 0) > 0) parts.push(`${run.failed} failed`);
  if ((run.skipped ?? 0) > 0) parts.push(`${run.skipped} skipped`);
  return parts.join(' · ');
}

// Groups a flat run list (newest-first, as returned by GET /api/tests) by app,
// preserving the newest-first order within each app.
export function groupRunsByApp(runs: TestRun[]): Map<string, TestRun[]> {
  const groups = new Map<string, TestRun[]>();
  for (const r of runs) {
    const arr = groups.get(r.app);
    if (arr) arr.push(r);
    else groups.set(r.app, [r]);
  }
  return groups;
}

export interface SparkCell {
  id: number;
  ts: number;
  outcome: RunOutcome;
}

// Oldest-first cell strip for a sparkline: takes the `max` most recent runs
// (runs is assumed newest-first) and reverses them so the strip reads
// left-to-right as time passing.
export function sparklineFor(runs: TestRun[], max = 30): SparkCell[] {
  return runs.slice(0, max).reverse().map(r => ({ id: r.id, ts: r.ts, outcome: runOutcome(r) }));
}

export interface RunDiff {
  newlyFailing: TestFailure[];
  newlyPassing: TestFailure[];
}

// Diffs two runs of the same app regardless of argument order — the run with
// the smaller ts is treated as "older". A fingerprint present only in the
// newer run's failures is "newly failing" (returned with its newer-run
// details); one present only in the older run's is "newly passing" (returned
// with its older-run details, since that's the only place the test's
// name/location was recorded). Failures without a fingerprint can't be
// diffed and are ignored (unparsed output — fail-soft per M74).
export function diffRuns(a: TestRun, b: TestRun): RunDiff {
  const [older, newer] = a.ts <= b.ts ? [a, b] : [b, a];
  const olderByFp = new Map<string, TestFailure>();
  for (const f of older.failures) if (f.fingerprint) olderByFp.set(f.fingerprint, f);
  const newerByFp = new Map<string, TestFailure>();
  for (const f of newer.failures) if (f.fingerprint) newerByFp.set(f.fingerprint, f);
  const newlyFailing = [...newerByFp.entries()].filter(([fp]) => !olderByFp.has(fp)).map(([, f]) => f);
  const newlyPassing = [...olderByFp.entries()].filter(([fp]) => !newerByFp.has(fp)).map(([, f]) => f);
  return { newlyFailing, newlyPassing };
}

// Index flaky results by fingerprint for O(1) lookup while rendering failure lists.
export function flakyByFingerprint(flaky: FlakyTest[]): Map<string, FlakyTest> {
  const m = new Map<string, FlakyTest>();
  for (const f of flaky) m.set(f.fingerprint, f);
  return m;
}

export function isFlaky(fingerprint: string | null | undefined, flaky: Map<string, FlakyTest>): boolean {
  return !!fingerprint && flaky.has(fingerprint);
}

export function pillKindForRun(run: TestRun | null): 'ok' | 'fail' | 'neutral' {
  if (!run) return 'neutral';
  return runOutcome(run) === 'fail' ? 'fail' : (runOutcome(run) === 'pass' ? 'ok' : 'neutral');
}

export function shortHead(gitHead: string | null): string {
  return gitHead ? gitHead.slice(0, 7) : '—';
}
