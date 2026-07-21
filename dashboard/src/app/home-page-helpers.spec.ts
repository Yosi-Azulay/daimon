import { describe, it, expect } from 'vitest';
import {
  computePassRate,
  filterByMemberSet,
  passRateTone,
  resourceTotalsFromApps,
  statusSummary,
  statusSummaryFromApps,
} from './home-page-helpers';

describe('computePassRate', () => {
  it('aggregates passed/total across runs with usable totals', () => {
    const r = computePassRate([
      { passed: 9, total: 10 },
      { passed: 5, total: 5 },
    ]);
    expect(r.passed).toBe(14);
    expect(r.total).toBe(15);
    expect(r.pct).toBe(93);
    expect(r.runs).toBe(2);
  });

  it('ignores runs without numeric totals (fail-soft, never counted as 0/0)', () => {
    const r = computePassRate([
      { passed: 10, total: 10 },
      { passed: null, total: null },
      { passed: 2, total: null },
    ]);
    expect(r.runs).toBe(1);
    expect(r.pct).toBe(100);
  });

  it('returns null pct when nothing had totals (a note, not a fabricated 0%)', () => {
    expect(computePassRate([{ passed: null, total: null }]).pct).toBeNull();
    expect(computePassRate([]).pct).toBeNull();
  });

  it('rounds to a whole percent', () => {
    expect(computePassRate([{ passed: 1, total: 3 }]).pct).toBe(33);
  });
});

describe('passRateTone', () => {
  it('buckets by threshold', () => {
    expect(passRateTone(null)).toBe('muted');
    expect(passRateTone(100)).toBe('ok');
    expect(passRateTone(95)).toBe('ok');
    expect(passRateTone(90)).toBe('warn');
    expect(passRateTone(80)).toBe('warn');
    expect(passRateTone(50)).toBe('error');
  });
});

describe('statusSummary', () => {
  it('normalizes partial/missing totals to zeros', () => {
    expect(statusSummary(null)).toEqual({ apps: 0, serving: 0, errors: 0, stopped: 0 });
    expect(statusSummary({ apps: 3, serving: 2 })).toEqual({ apps: 3, serving: 2, errors: 0, stopped: 0 });
  });
});

// Workspace filtering (M177, v1.15): client-side recomputation used once a
// workspace filter takes the Status/Resources widgets off the server's
// daemon-wide overview.totals.
describe('statusSummaryFromApps', () => {
  it('counts serving/errors/stopped over a (workspace-filtered) app row set', () => {
    const apps = [
      { status: 'serving', errorCount: 0 },
      { status: 'error', errorCount: 2 },
      { status: 'serving', errorCount: 1 }, // serving but with errors still counts as errored
      { status: 'stopped', errorCount: 0 },
    ];
    expect(statusSummaryFromApps(apps)).toEqual({ apps: 4, serving: 2, errors: 2, stopped: 1 });
  });

  it('empty input -> all zeros', () => {
    expect(statusSummaryFromApps([])).toEqual({ apps: 0, serving: 0, errors: 0, stopped: 0 });
  });
});

describe('resourceTotalsFromApps', () => {
  it('sums cpu/mem across apps that report a numeric value', () => {
    const apps = [{ cpu: 10, memMB: 100 }, { cpu: 5, memMB: null }, { cpu: null, memMB: 50 }];
    expect(resourceTotalsFromApps(apps)).toEqual({ cpuPct: 15, memMb: 150 });
  });

  it('null when nothing in the set reports that metric (never a fabricated 0)', () => {
    expect(resourceTotalsFromApps([{ cpu: null, memMB: null }])).toEqual({ cpuPct: null, memMb: null });
    expect(resourceTotalsFromApps([])).toEqual({ cpuPct: null, memMb: null });
  });
});

describe('filterByMemberSet', () => {
  const items = [{ app: 'web' }, { app: 'api' }];

  it('null members -> no filter (pass through)', () => {
    expect(filterByMemberSet(items, null, i => i.app)).toBe(items);
  });

  it('keeps only items whose key is in the member set', () => {
    expect(filterByMemberSet(items, new Set(['web']), i => i.app)).toEqual([{ app: 'web' }]);
  });
});
