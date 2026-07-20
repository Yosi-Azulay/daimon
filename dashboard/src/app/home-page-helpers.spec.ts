import { describe, it, expect } from 'vitest';
import { computePassRate, passRateTone, statusSummary } from './home-page-helpers';

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
