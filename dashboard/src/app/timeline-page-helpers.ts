// Pure helpers for the Timeline page (M137, v1.8 "Rewind" — experimental),
// extracted so the bucketing/brush/keyboard-nav math is unit-testable under
// Vitest without spinning up the Angular runtime — same convention as
// trends-page-helpers.ts / command-palette-helpers.ts.

export interface TimelineRowLike {
  ts: number;
  app: string;
  kind: string;
  summary: string;
}

export interface DensityBucket {
  count: number;
  from: number;
  to: number;
}

export interface DensityModel {
  buckets: DensityBucket[];
  domainMin: number;
  domainMax: number;
}

// Buckets `rows` into `bucketCount` equal-width time slices spanning the
// rows' own [min ts, max ts] — a data-driven domain, not the query window, so
// a sparse window still fills the strip meaningfully. A single-timestamp
// input (or empty input) never divides by zero.
export function bucketizeTimeline(rows: TimelineRowLike[], bucketCount: number): DensityModel {
  if (!rows.length || bucketCount <= 0) return { buckets: [], domainMin: 0, domainMax: 0 };
  let domainMin = Infinity;
  let domainMax = -Infinity;
  for (const r of rows) {
    if (r.ts < domainMin) domainMin = r.ts;
    if (r.ts > domainMax) domainMax = r.ts;
  }
  const span = domainMax - domainMin || 1;
  const bucketMs = span / bucketCount;
  const buckets: DensityBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    count: 0,
    from: domainMin + i * bucketMs,
    to: domainMin + (i + 1) * bucketMs,
  }));
  for (const r of rows) {
    let idx = Math.floor((r.ts - domainMin) / bucketMs);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count++;
  }
  return { buckets, domainMin, domainMax };
}

// Converts a horizontal drag [startX, endX] over a `width`-px-wide strip into
// a `{ from, to }` timestamp range, given the strip's own time domain. Drags
// under 3px collapse to `null` (a click, not a brush) so a stray tap never
// pins a zero-width range.
export function brushToRange(
  startX: number,
  endX: number,
  width: number,
  domainMin: number,
  domainMax: number,
): { from: number; to: number } | null {
  if (width <= 0 || domainMax <= domainMin) return null;
  const lo = Math.max(0, Math.min(startX, endX));
  const hi = Math.min(width, Math.max(startX, endX));
  if (hi - lo < 3) return null;
  const span = domainMax - domainMin;
  const from = domainMin + (lo / width) * span;
  const to = domainMin + (hi / width) * span;
  return { from, to };
}

// A `{ from, to }` range expressed as left%/width% of a strip spanning
// [domainMin, domainMax] — for positioning the "confirmed brush" overlay
// without re-deriving pixel geometry in the template.
export function rangeToPct(
  range: { from: number; to: number },
  domainMin: number,
  domainMax: number,
): { leftPct: number; widthPct: number } {
  const span = domainMax - domainMin || 1;
  const leftPct = ((range.from - domainMin) / span) * 100;
  const widthPct = ((range.to - range.from) / span) * 100;
  return { leftPct: clamp(leftPct, 0, 100), widthPct: clamp(widthPct, 0, 100 - clamp(leftPct, 0, 100)) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export type NavKey = 'up' | 'down' | 'home' | 'end';

// Roving-focus index math over a newest-first row list. `down` moves toward
// older rows (index+1), `up` toward newer (index-1); `home` is the newest row
// (index 0), `end` the oldest (last index). No rows -> -1 (nothing focusable).
export function moveFocusIndex(current: number, key: NavKey, length: number): number {
  if (length <= 0) return -1;
  const base = current < 0 ? 0 : current;
  switch (key) {
    case 'up': return current < 0 ? 0 : Math.max(0, base - 1);
    case 'down': return current < 0 ? 0 : Math.min(length - 1, base + 1);
    case 'home': return 0;
    case 'end': return length - 1;
  }
}

// The aria-live announcement text for a newly-focused row — "app · kind ·
// summary", matching the per-row aria-label convention already used on click.
export function announceRow(row: TimelineRowLike, kindLabel: Record<string, string>): string {
  return `${row.app} · ${kindLabel[row.kind] || row.kind} · ${row.summary}`;
}

// Parses a `?kind=` deep-link param (comma-separated, matching `?kinds=` on
// the history/timeline HTTP endpoint) into a preset Set, filtered to known
// kinds. Returns null (no override) for an absent/all-unknown param so the
// caller falls back to "all kinds" rather than presetting an empty set.
export function parseKindsParam(raw: string | null | undefined, allKinds: string[]): Set<string> | null {
  if (!raw) return null;
  const wanted = raw.split(',').map(s => s.trim()).filter(k => allKinds.includes(k));
  return wanted.length ? new Set(wanted) : null;
}

// The [from, to] window a `?session=<id>` deep link should cover — the
// session's own bounds, with an open (still-current) session's null `end`
// resolved to `now`.
export function sessionWindow(detail: { start: number; end: number | null }, now = Date.now()): { from: number; to: number } {
  return { from: detail.start, to: detail.end ?? now };
}
