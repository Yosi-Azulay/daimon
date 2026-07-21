// Pure logic for the TUI log-pane level-cycle chord and inline grep (M102):
// cycling order, the level/grep line-filter predicate, grep pattern
// compilation (regex with a substring fallback), and header label formatting
// are all side-effect-free so they can be unit tested without ink or a real
// terminal — same pattern as testChord.ts / groupChord.ts.
//
// Grep here is intentionally more forgiving than the server-side --grep
// (server.ts rejects an invalid regex with 400 — see GET .../logs). This is
// live, character-by-character interactive input: a mid-typed pattern like
// `[abc` is invalid until the user finishes it, so failing to compile falls
// back to a plain case-insensitive substring match instead of erroring —
// grep must never crash the pane on a keystroke.

import type { LogLevel } from '../frameworks.js';

export const LEVEL_CHORD_KEY = 'l';
export const LEVEL_CHORD_HELP = '[l] level';
export const GREP_CHORD_KEY = '/';
export const GREP_CHORD_HELP = '[/] grep';

export type LevelFilter = 'all' | 'error' | 'warn' | 'info';

const CYCLE: LevelFilter[] = ['all', 'error', 'warn', 'info'];

// all -> error -> warn -> info -> all
export function nextLevelFilter(current: LevelFilter): LevelFilter {
  const idx = CYCLE.indexOf(current);
  return CYCLE[(idx + 1) % CYCLE.length];
}

// '' when unfiltered (nothing to show in the header); `[level: X]` otherwise.
export function formatLevelIndicator(filter: LevelFilter): string {
  return filter === 'all' ? '' : `[level: ${filter}]`;
}

export interface LogLineLike {
  line: string;
  level?: LogLevel | null;
}

// 'all' passes everything through. Any other filter requires an exact
// classified match — unclassified lines (level absent/null) are excluded
// whenever a level filter is active.
export function matchesLevel(entry: LogLineLike, filter: LevelFilter): boolean {
  if (filter === 'all') return true;
  return entry.level === filter;
}

// Compiles a grep pattern into a matcher. An empty pattern matches every
// line (no-op filter). Tries the pattern as a case-insensitive regex first;
// an invalid pattern falls back to a plain case-insensitive substring match
// rather than throwing.
export function compileGrep(pattern: string): (line: string) => boolean {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, 'i');
    return (line: string) => re.test(line);
  } catch {
    const needle = pattern.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
  }
}

// Combined predicate: level AND grep both must pass.
export function filterLogLines<T extends LogLineLike>(
  entries: T[],
  levelFilter: LevelFilter,
  grepPattern: string,
): T[] {
  const grepMatch = compileGrep(grepPattern);
  return entries.filter(e => matchesLevel(e, levelFilter) && grepMatch(e.line));
}

// ── log pane 2.0 (v1.13, M164) ────────────────────────────────────────────────
// Follow mode, grep match navigation, and the filter/highlight toggle. All pure
// — the pane holds the state, this module decides what the state becomes.

// How grep presents its matches. `filter` (the DEFAULT, and exactly what v1.2
// shipped) narrows the stream to matching lines only; `highlight` keeps every
// line in view and just paints the matches, which is what makes `n`/`N`
// navigation meaningful. Toggled from inside the search input — Esc still
// clears grep entirely and restores the full stream.
export type GrepMode = 'filter' | 'highlight';

export function nextGrepMode(mode: GrepMode): GrepMode {
  return mode === 'filter' ? 'highlight' : 'filter';
}

// The entries the pane renders: level always applies, grep only narrows in
// `filter` mode. An empty grep pattern is a no-op in either mode.
export function visibleLogLines<T extends LogLineLike>(
  entries: T[],
  levelFilter: LevelFilter,
  grepPattern: string,
  mode: GrepMode,
): T[] {
  if (mode === 'highlight') return entries.filter(e => matchesLevel(e, levelFilter));
  return filterLogLines(entries, levelFilter, grepPattern);
}

// Indices (into `entries`) of the lines grep matches. Empty pattern = no
// matches to navigate, NOT "everything matches" — `n` with no query is a no-op
// rather than a jump to line 2.
export function matchingIndices<T extends LogLineLike>(entries: T[], grepPattern: string): number[] {
  if (!grepPattern) return [];
  const m = compileGrep(grepPattern);
  const out: number[] = [];
  for (let i = 0; i < entries.length; i++) if (m(entries[i].line)) out.push(i);
  return out;
}

// The next (dir=1) / previous (dir=-1) match strictly after/before `fromIdx`,
// WRAPPING at the ends so repeated `n` walks the whole file and comes back
// round. Null only when there are no matches at all.
export function nextMatchIndex(matches: number[], fromIdx: number, dir: 1 | -1): number | null {
  if (!matches.length) return null;
  if (dir === 1) {
    for (const i of matches) if (i > fromIdx) return i;
    return matches[0];
  }
  for (let k = matches.length - 1; k >= 0; k--) if (matches[k] < fromIdx) return matches[k];
  return matches[matches.length - 1];
}

// Follow mode: the pane tails the newest line. Scrolling UP (any amount) pauses
// follow; reaching the bottom — or pressing `G` — resumes it. Before v1.13 this
// was implicit (scroll === 0 happened to tail); now it is state the header
// names honestly.
export function isFollowing(scroll: number, explicitFollow: boolean): boolean {
  return explicitFollow && scroll === 0;
}

export function formatFollowIndicator(following: boolean): string {
  return following ? '[following]' : '[paused]';
}

// v1.2 log-storm state surfaced in the pane header + status bar. Empty string
// when the app is not storming, so callers can render it unconditionally.
export function formatStormIndicator(active: boolean): string {
  return active ? '⚡ log storm' : '';
}

export function formatGrepIndicator(pattern: string, mode: GrepMode, matchCount: number): string {
  if (!pattern) return '';
  return mode === 'filter'
    ? `[grep "${pattern}"]`
    : `[grep "${pattern}" ${matchCount} match${matchCount === 1 ? '' : 'es'}]`;
}
