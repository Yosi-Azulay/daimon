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
