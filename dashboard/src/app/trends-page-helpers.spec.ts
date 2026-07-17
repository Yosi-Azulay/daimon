import { describe, expect, it } from 'vitest';
import { TREND_METRICS, unionLabels, alignSeries, fmtBucketLabel, type Series } from './trends-page-helpers';

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
});
