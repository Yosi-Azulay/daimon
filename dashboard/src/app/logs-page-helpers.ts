// Pure helpers for the Logs page (M102, v1.2 log-sense dashboard half),
// extracted so they're unit-testable under Vitest without spinning up the
// Angular runtime. Mirrors the server's LogLevel (src/frameworks.ts) and the
// M101 log-storm marker on compact app status (src/types.ts AppRow.logStorm).

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export interface LogLineLite {
  level: LogLevel | null;
}

// Live per-level counts over whatever lines are currently buffered client-side
// (not server-refetched) — so a chip's count reflects exactly what toggling it
// will filter down to. Unclassified (null-level) lines are deliberately never
// counted under any bucket, matching the server's own "unclassified lines are
// excluded from level filters" rule (M100/M101).
export function countsByLevel(rows: LogLineLite[]): Record<LogLevel, number> {
  const out: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const r of rows) if (r.level) out[r.level]++;
  return out;
}

// Clicking the already-active chip clears the filter; clicking a different
// one switches to it. Single-select, not multi — mirrors the server's `level`
// query param (one value, not a set).
export function toggleLevel(current: LogLevel | null, clicked: LogLevel): LogLevel | null {
  return current === clicked ? null : clicked;
}

// A line passes the level filter when no filter is active, or its classified
// level matches exactly. A `null` (unclassified) line never passes an active
// filter — matches the server's GET /api/apps/:name/logs?level= semantics.
export function matchesLevel(rowLevel: LogLevel | null, selected: LogLevel | null): boolean {
  return selected == null || rowLevel === selected;
}

export interface TextPredicate {
  pred: ((s: string) => boolean) | null;
  error: string | null;
}

// Builds the case-insensitive substring/regex line predicate for the filter
// box. An invalid regex never throws into the caller — it surfaces as
// `error` with `pred: null`, which callers must treat as "apply no filter"
// (never crash, never silently keep the previous filter).
export function buildTextPredicate(raw: string, useRegex: boolean): TextPredicate {
  if (!raw) return { pred: null, error: null };
  if (!useRegex) {
    const needle = raw.toLowerCase();
    return { pred: (s: string) => s.toLowerCase().includes(needle), error: null };
  }
  try {
    const rx = new RegExp(raw, 'i');
    return { pred: (s: string) => rx.test(s), error: null };
  } catch (e: any) {
    return { pred: null, error: e?.message ?? 'invalid regex' };
  }
}

export interface StormMarker {
  observedPerMin: number;
  baselinePerMin: number | null;
}

// Storm banner copy (M101 marker -> M102 dashboard surface). Baseline is
// null when the app hasn't accumulated enough history for a rolling average
// yet — rendered as an em dash rather than "0" so it doesn't read as "no logs".
export function formatStormBanner(storm: StormMarker): string {
  const baseline = storm.baselinePerMin != null ? Math.round(storm.baselinePerMin) : '—';
  return `Log storm: ${Math.round(storm.observedPerMin)} lines/min vs baseline ${baseline}`;
}

// Whether the storm banner should currently render, given the "dismissed
// for this episode" bookmark (keyed by the marker's `since`). Dismissing
// silences the CURRENT episode only — a later storm (a fresh `since`)
// re-shows it rather than staying silenced forever. Extracted as pure logic
// so this rule has a unit test independent of the live registry's in-memory
// storm detector, which nothing outside the daemon process can seed
// deterministically (see logs.spec.ts's note on the e2e drive).
export function stormBannerVisible(storm: { since: number } | null | undefined, dismissedSince: number | null): boolean {
  return !!storm && dismissedSince !== storm.since;
}

// Builds the `>` command-palette search-mode query pre-filled with the log
// page's current filter text (M85 deep-link plumbing, reused for M102's
// "jump to search" affordance). Trims so an empty/whitespace-only filter
// opens a bare search mode instead of a query with a trailing space.
export function searchPrefillQuery(filterText: string): string {
  const trimmed = filterText.trim();
  return trimmed ? `> ${trimmed}` : '>';
}
