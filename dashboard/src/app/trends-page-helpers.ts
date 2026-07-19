// Pure logic for the Trends page (M85 test pass-rate, M109 rss/cpu resource
// series), pulled out of trends-page.ts so it's exercisable without the
// Angular runtime (see vite.config.ts — this Vitest layer never boots
// Angular, only pure units).

export type Window = '24h' | '7d' | '30d';

export interface SeriesPoint { t: number; v: number; v2?: number; }
export interface Series { app: string; points: SeriesPoint[]; }

// The full set of `/api/history/trends?metrics=` values the Trends page
// requests in its one batched round-trip per app. rss/cpu (M109, v1.3 —
// experimental) ride the same endpoint as compile/bundle/errors/restarts.
export const TREND_METRICS = ['compile', 'bundle', 'errors', 'restarts', 'rss', 'cpu'] as const;
export type TrendMetric = typeof TREND_METRICS[number];

export function fmtBucketLabel(t: number, window: Window): string {
  const d = new Date(t);
  if (window === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function unionLabels(seriesGroups: Series[][], win: Window): { buckets: number[]; labels: string[] } {
  const set = new Set<number>();
  for (const group of seriesGroups) for (const s of group) for (const p of s.points) set.add(p.t);
  const buckets = [...set].sort((a, b) => a - b);
  return { buckets, labels: buckets.map(t => fmtBucketLabel(t, win)) };
}

export function alignSeries(points: SeriesPoint[], buckets: number[], key: 'v' | 'v2' = 'v'): number[] {
  const m = new Map<number, SeriesPoint>();
  for (const p of points) m.set(p.t, p);
  return buckets.map(t => {
    const p = m.get(t);
    if (!p) return 0;
    const v = key === 'v' ? p.v : p.v2;
    return typeof v === 'number' ? v : 0;
  });
}

// A point whose value may legitimately be absent — distinct from SeriesPoint
// (whose v/v2 are always a real number) so callers can't accidentally feed a
// "no data" 0 into it.
export interface NullableSeriesPoint { t: number; v: number | null; v2?: number | null; }

// Coverage over time (M129, v1.7 — experimental): unlike alignSeries (which
// backfills every missing bucket with 0 — correct for counters like errors/
// restarts, where "no event" really does mean zero), a coverage run with no
// coverage data is NOT a 0% run. This aligner backfills missing buckets
// (bucket absent from `points`, or present with a null value) with `null` so
// Chart.js draws a GAP (`spanGaps: false` on the dataset) instead of a
// fabricated dip to zero.
export function alignSeriesNullable(points: NullableSeriesPoint[], buckets: number[], key: 'v' | 'v2' = 'v'): (number | null)[] {
  const m = new Map<number, NullableSeriesPoint>();
  for (const p of points) m.set(p.t, p);
  return buckets.map(t => {
    const p = m.get(t);
    if (!p) return null;
    const v = key === 'v' ? p.v : p.v2;
    return typeof v === 'number' ? v : null;
  });
}
