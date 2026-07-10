// Pure logic for the TUI `T` test-run chord (M85): the key binding, its
// help-ribbon label, the concurrency guard, and result formatting are all
// side-effect-free so they can be unit tested without ink or a real
// terminal — same pattern as ribbon.ts.

export const TEST_CHORD_KEY = 'T';
export const TEST_CHORD_HELP = '[T] test';

// True when pressing the chord should kick off a new run rather than be a
// no-op — i.e. no run is already in flight for the selected app.
export function canStartTestRun(running: boolean): boolean {
  return !running;
}

export interface TestSummaryTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
}

export interface TestSummarySuccess {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  totals: TestSummaryTotals | null;
}

export interface TestSummaryError {
  error: string;
  hint?: string;
}

export type TestRunOutcome = TestSummarySuccess | TestSummaryError;

function fmtSecs(ms: number): string {
  return (ms / 1000).toFixed(1);
}

// ✓ 42/42 in 3.1s  |  ✗ 3 failed / 42 in 12.4s  |  tests: <error>
export function formatTestSummary(result: TestRunOutcome): string {
  if ('error' in result) return `tests: ${result.error}`;
  if (result.timedOut) return `tests: timed out after ${fmtSecs(result.durationMs)}s`;
  const secs = fmtSecs(result.totals?.durationMs ?? result.durationMs);
  if (result.totals) {
    const { passed, total, failed } = result.totals;
    return failed > 0 ? `✗ ${failed} failed / ${total} in ${secs}s` : `✓ ${passed}/${total} in ${secs}s`;
  }
  return result.exitCode === 0 ? `✓ exit 0 in ${secs}s` : `✗ exit ${result.exitCode ?? '?'} in ${secs}s`;
}
