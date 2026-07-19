// Pure logic for the TUI timeline chord (M136, v1.8 "Rewind"): bucket math,
// state-change jumps, and navigation — all side-effect-free so they unit test
// without ink or a real terminal (same pattern as testChord.ts / groupChord.ts).
// The ink pane (TimelinePane.tsx) queries history ONCE on open and drives every
// keystroke through these in-memory helpers — never a per-key table scan.

export const TIMELINE_CHORD_KEY = 'i';
export const TIMELINE_CHORD_HELP = '[i] timeline';

export type Granularity = 'day' | 'hour';

export interface TimelineEvent {
  ts: number;
  app: string;
  type: string;
  to_state?: string | null;
}

export interface Bucket {
  start: number;
  end: number; // exclusive
  count: number;
}

export function bucketSpan(g: Granularity): number {
  return g === 'day' ? 86_400_000 : 3_600_000;
}

// Align a timestamp to the start of its UTC hour/day. UTC keeps the math
// deterministic across machines/timezones (the TUI shows relative labels).
export function bucketStart(ts: number, g: Granularity): number {
  const span = bucketSpan(g);
  return Math.floor(ts / span) * span;
}

// Sparse ascending buckets — only spans that actually contain events — optionally
// restricted to [from, to). Sparse so "events across three days" yields exactly
// three day buckets, not a run of empties.
export function bucketize(events: TimelineEvent[], g: Granularity, range?: { from: number; to: number }): Bucket[] {
  const span = bucketSpan(g);
  const counts = new Map<number, number>();
  for (const ev of events) {
    if (range && (ev.ts < range.from || ev.ts >= range.to)) continue;
    const b = bucketStart(ev.ts, g);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, count]) => ({ start, end: start + span, count }));
}

// A per-app state change: a start (→ starting), a stop (→ stopped), or a crash.
export function isStateChange(ev: TimelineEvent, app: string): boolean {
  if (ev.app !== app) return false;
  if (ev.type === 'crash') return true;
  if (ev.type === 'status' && (ev.to_state === 'starting' || ev.to_state === 'stopped')) return true;
  return false;
}

// The next (dir=1) or previous (dir=-1) state-change timestamp for `app`
// strictly after/before `fromTs`. Null when there is none in that direction.
export function findStateChange(events: TimelineEvent[], app: string, fromTs: number, dir: 1 | -1): number | null {
  const changes = events.filter(e => isStateChange(e, app)).map(e => e.ts).sort((a, b) => a - b);
  if (dir === 1) {
    for (const ts of changes) if (ts > fromTs) return ts;
  } else {
    for (let i = changes.length - 1; i >= 0; i--) if (changes[i] < fromTs) return changes[i];
  }
  return null;
}

// Index of the bucket containing `ts`, else the nearest bucket by start. -1 for
// an empty list. Used to land a state-change jump on the right bucket.
export function bucketIndexForTs(buckets: Bucket[], ts: number): number {
  if (!buckets.length) return -1;
  for (let i = 0; i < buckets.length; i++) {
    if (ts >= buckets[i].start && ts < buckets[i].end) return i;
  }
  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < buckets.length; i++) {
    const d = Math.min(Math.abs(ts - buckets[i].start), Math.abs(ts - buckets[i].end));
    if (d < best) { best = d; nearest = i; }
  }
  return nearest;
}

// Clamp a selection index into [0, len-1] (or -1 when empty).
export function clampIndex(i: number, len: number): number {
  if (len <= 0) return -1;
  return Math.max(0, Math.min(len - 1, i));
}

// A tiny sparkline for the density strip: one glyph per bucket, height scaled to
// the busiest bucket. Deterministic and width-bounded.
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
export function densityGlyph(count: number, max: number): string {
  if (count <= 0 || max <= 0) return SPARK[0];
  const idx = Math.min(SPARK.length - 1, Math.max(0, Math.round((count / max) * (SPARK.length - 1))));
  return SPARK[idx];
}
