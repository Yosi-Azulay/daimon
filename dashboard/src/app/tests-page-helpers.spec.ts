import { describe, expect, it } from 'vitest';
import {
  diffRuns,
  filterCardsByWorkspace,
  flakyByFingerprint,
  groupRunsByApp,
  isFlaky,
  pillKindForRun,
  runLabel,
  shortHead,
  sparklineFor,
  vscodeUri,
  type TestRun,
} from './tests-page-helpers';

const baseRun: TestRun = {
  id: 1,
  ts: 1000,
  app: 'web',
  runner: 'vitest',
  durationMs: 500,
  total: 10,
  passed: 10,
  failed: 0,
  skipped: 0,
  exitCode: 0,
  gitHead: 'abc1234',
  failures: [],
};

describe('groupRunsByApp / runLabel / runOutcome-ish helpers', () => {
  it('groups newest-first runs by app, preserving order within each app', () => {
    const runs: TestRun[] = [
      { ...baseRun, id: 1, app: 'web', ts: 2000 },
      { ...baseRun, id: 2, app: 'api', ts: 1500 },
      { ...baseRun, id: 3, app: 'web', ts: 1000 },
    ];
    const grouped = groupRunsByApp(runs);
    expect([...grouped.keys()]).toEqual(['web', 'api']);
    expect(grouped.get('web')!.map(r => r.id)).toEqual([1, 3]);
  });

  it('runLabel/pillKindForRun/vscodeUri/shortHead/isFlaky/flakyByFingerprint/diffRuns still behave', () => {
    expect(runLabel(baseRun)).toBe('10/10');
    expect(pillKindForRun(baseRun)).toBe('ok');
    expect(pillKindForRun(null)).toBe('neutral');
    expect(shortHead('abc1234567')).toBe('abc1234');
    expect(shortHead(null)).toBe('—');
    expect(vscodeUri('a/b.ts', 3)).toBe('vscode://file/a/b.ts:3');
    const flaky = flakyByFingerprint([{ fingerprint: 'fp1', test: 't', suite: 's', flips: 4, gitHead: 'h' }]);
    expect(isFlaky('fp1', flaky)).toBe(true);
    expect(isFlaky(null, flaky)).toBe(false);
    const older = { ...baseRun, id: 1, ts: 1, failures: [{ suite: 's', test: 'a', file: null, line: null, message: null, fingerprint: 'fp-a' }] };
    const newer = { ...baseRun, id: 2, ts: 2, failures: [{ suite: 's', test: 'b', file: null, line: null, message: null, fingerprint: 'fp-b' }] };
    const diff = diffRuns(newer, older); // order-independent
    expect(diff.newlyFailing.map(f => f.fingerprint)).toEqual(['fp-b']);
    expect(diff.newlyPassing.map(f => f.fingerprint)).toEqual(['fp-a']);
    expect(sparklineFor([baseRun], 30).map(c => c.id)).toEqual([1]);
  });
});

// Workspace filtering (M177, v1.15): the Tests page trims its per-app cards
// to the active workspace via the shared membership-Set-or-null convention.
describe('filterCardsByWorkspace', () => {
  const cards = [{ app: 'web' }, { app: 'api' }, { app: 'orphaned-app' }];

  it('null members -> no filter, everything (incl. apps unknown to the registry) stays visible', () => {
    expect(filterCardsByWorkspace(cards, null)).toBe(cards);
  });

  it('a member set keeps only cards for apps in it', () => {
    expect(filterCardsByWorkspace(cards, new Set(['web']))).toEqual([{ app: 'web' }]);
  });

  it('an empty member set (workspace matches nothing) hides every card', () => {
    expect(filterCardsByWorkspace(cards, new Set())).toEqual([]);
  });
});
