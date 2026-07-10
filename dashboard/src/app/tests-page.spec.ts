import { describe, expect, it } from 'vitest';
import {
  vscodeUri,
  runOutcome,
  runLabel,
  groupRunsByApp,
  sparklineFor,
  diffRuns,
  flakyByFingerprint,
  isFlaky,
  pillKindForRun,
  shortHead,
  type TestRun,
} from './tests-page-helpers';

function run(over: Partial<TestRun> = {}): TestRun {
  return {
    id: 1, ts: 0, app: 'web', runner: 'vitest', durationMs: 1000,
    total: 10, passed: 10, failed: 0, skipped: 0, exitCode: 0, gitHead: 'abc1234',
    failures: [],
    ...over,
  };
}

describe('tests-page helpers', () => {
  it('vscodeUri normalizes Windows paths and appends line number', () => {
    expect(vscodeUri('src\\foo\\bar.ts', 42)).toBe('vscode://file/src/foo/bar.ts:42');
    expect(vscodeUri('src/baz.ts')).toBe('vscode://file/src/baz.ts');
  });

  it('runOutcome prefers the failed count, falls back to exit code, then unknown', () => {
    expect(runOutcome(run({ failed: 2, exitCode: 0 }))).toBe('fail');
    expect(runOutcome(run({ failed: 0, exitCode: 1 }))).toBe('fail');
    expect(runOutcome(run({ failed: 0, exitCode: 0 }))).toBe('pass');
    expect(runOutcome(run({ failed: 0, exitCode: null, total: null }))).toBe('unknown');
  });

  it('runLabel formats passed/total and failure/skip tails', () => {
    expect(runLabel(run({ passed: 10, failed: 0, skipped: 0, total: 10 }))).toBe('10/10');
    expect(runLabel(run({ passed: 8, failed: 2, skipped: 0, total: 10 }))).toBe('8/10 · 2 failed');
    expect(runLabel(run({ passed: 7, failed: 2, skipped: 1, total: 10 }))).toBe('7/10 · 2 failed · 1 skipped');
    expect(runLabel(run({ passed: 0, failed: 0, skipped: 0, total: 0, exitCode: 1 }))).toBe('exit 1');
    expect(runLabel(run({ passed: 0, failed: 0, skipped: 0, total: 0, exitCode: null }))).toBe('no data');
  });

  it('groupRunsByApp preserves newest-first order within each app', () => {
    const runs = [run({ id: 3, app: 'a', ts: 30 }), run({ id: 2, app: 'b', ts: 20 }), run({ id: 1, app: 'a', ts: 10 })];
    const grouped = groupRunsByApp(runs);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')!.map(r => r.id)).toEqual([3, 1]);
    expect(grouped.get('b')!.map(r => r.id)).toEqual([2]);
  });

  it('sparklineFor caps at max and reverses to oldest-first', () => {
    const runs = [run({ id: 3, ts: 30, failed: 1 }), run({ id: 2, ts: 20 }), run({ id: 1, ts: 10 })];
    const spark = sparklineFor(runs, 2);
    expect(spark.map(c => c.id)).toEqual([2, 3]);
    expect(spark[1].outcome).toBe('fail');
  });

  it('diffRuns finds newly-failing and newly-passing fingerprints regardless of arg order', () => {
    const older = run({
      id: 1, ts: 10,
      failures: [
        { suite: 's', test: 'a', file: 'a.ts', line: 1, message: 'boom', fingerprint: 'fp-a' },
        { suite: 's', test: 'b', file: 'b.ts', line: 1, message: 'boom', fingerprint: 'fp-b' },
      ],
    });
    const newer = run({
      id: 2, ts: 20,
      failures: [
        { suite: 's', test: 'b', file: 'b.ts', line: 1, message: 'boom', fingerprint: 'fp-b' },
        { suite: 's', test: 'c', file: 'c.ts', line: 1, message: 'boom', fingerprint: 'fp-c' },
      ],
    });
    const diff = diffRuns(newer, older); // order-independent
    expect(diff.newlyFailing.map(f => f.fingerprint)).toEqual(['fp-c']);
    expect(diff.newlyPassing.map(f => f.fingerprint)).toEqual(['fp-a']);
  });

  it('diffRuns ignores failures without a fingerprint', () => {
    const older = run({ id: 1, ts: 10, failures: [{ suite: null, test: null, file: null, line: null, message: 'x', fingerprint: null }] });
    const newer = run({ id: 2, ts: 20, failures: [] });
    const diff = diffRuns(older, newer);
    expect(diff.newlyFailing).toEqual([]);
    expect(diff.newlyPassing).toEqual([]);
  });

  it('flakyByFingerprint indexes by fingerprint and isFlaky looks it up', () => {
    const idx = flakyByFingerprint([{ fingerprint: 'fp-a', test: 'a', suite: 's', flips: 4, gitHead: 'abc' }]);
    expect(isFlaky('fp-a', idx)).toBe(true);
    expect(isFlaky('fp-z', idx)).toBe(false);
    expect(isFlaky(null, idx)).toBe(false);
  });

  it('pillKindForRun maps outcome to pill kind', () => {
    expect(pillKindForRun(null)).toBe('neutral');
    expect(pillKindForRun(run({ failed: 0, exitCode: 0 }))).toBe('ok');
    expect(pillKindForRun(run({ failed: 1, exitCode: 0 }))).toBe('fail');
    expect(pillKindForRun(run({ failed: 0, exitCode: null, total: null }))).toBe('neutral');
  });

  it('shortHead truncates to 7 chars, dashes when absent', () => {
    expect(shortHead('abcdef1234567')).toBe('abcdef1');
    expect(shortHead(null)).toBe('—');
  });
});
