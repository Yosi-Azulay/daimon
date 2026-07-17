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
