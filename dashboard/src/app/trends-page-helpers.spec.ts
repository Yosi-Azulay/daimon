import { describe, expect, it } from 'vitest';
import { TREND_METRICS, unionLabels, alignSeries, alignSeriesNullable, fmtBucketLabel, type Series, type NullableSeriesPoint } from './trends-page-helpers';

describe('trends-page helpers', () => {
  it('TREND_METRICS requests rss and cpu alongside the pre-existing metrics (M109)', () => {
    expect(TREND_METRICS).toContain('rss');
    expect(TREND_METRICS).toContain('cpu');
    expect(TREND_METRICS).toEqual(['compile', 'bundle', 'errors', 'restarts', 'rss', 'cpu']);
  });

  it('unionLabels merges rss/cpu series buckets and alignSeries fills gaps with 0', () => {
    const rss: Series[] = [{ app: 'web', points: [{ t: 100, v: 200 }, { t: 300, v: 620 }] }];
    const cpu: Series[] = [{ app: 'web', points: [{ t: 100, v: 12.5 }] }]; // missing the t=300 bucket
    const { buckets, labels } = unionLabels([rss, cpu], '24h');

    expect(buckets).toEqual([100, 300]);
    expect(labels.length).toBe(2);
    expect(labels[0]).toBe(fmtBucketLabel(100, '24h'));

    expect(alignSeries(rss[0].points, buckets, 'v')).toEqual([200, 620]);
    // cpu has no point at t=300 -> gap filled with 0, not dropped or fabricated.
    expect(alignSeries(cpu[0].points, buckets, 'v')).toEqual([12.5, 0]);
  });

  it('alignSeries returns an all-zero series for an app with no rss/cpu points', () => {
    expect(alignSeries([], [100, 200, 300], 'v')).toEqual([0, 0, 0]);
  });

  // Coverage over time (M129, v1.7): alignSeriesNullable is the gap-preserving
  // counterpart to alignSeries — a missing or null-valued bucket must render
  // as a GAP (null), never a fabricated 0%.
  it('alignSeriesNullable fills a missing bucket with null, not 0', () => {
    const points: NullableSeriesPoint[] = [{ t: 100, v: 80 }, { t: 300, v: 90 }]; // no point at t=200
    expect(alignSeriesNullable(points, [100, 200, 300], 'v')).toEqual([80, null, 90]);
  });

  it('alignSeriesNullable preserves an explicit null value at a present bucket', () => {
    const points: NullableSeriesPoint[] = [{ t: 100, v: 80 }, { t: 200, v: null }, { t: 300, v: 90 }];
    expect(alignSeriesNullable(points, [100, 200, 300], 'v')).toEqual([80, null, 90]);
  });

  it('alignSeriesNullable renders a gap between two real points (rising-then-gap-then-rising coverage)', () => {
    // Simulates a run history where the middle run had no coverage data.
    const points: NullableSeriesPoint[] = [{ t: 1, v: 50 }, { t: 3, v: 70 }]; // t=2 run had null coverage, omitted
    const aligned = alignSeriesNullable(points, [1, 2, 3], 'v');
    expect(aligned).toEqual([50, null, 70]);
    expect(aligned[1]).toBeNull();
  });

  it('alignSeriesNullable returns an all-null series for an app with zero coverage data', () => {
    expect(alignSeriesNullable([], [100, 200, 300], 'v')).toEqual([null, null, null]);
  });
});
