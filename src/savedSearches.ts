// Saved searches (M181, v1.16 "Recall").
//
// THE WHOLE FEATURE IS DATA. A saved search is a name and a query string in
// ~/.daimon/state.json; nothing here schedules, watches, notifies, or runs
// anything. That is a standing decision, not an oversight: scheduled searches
// would be a second scheduler (the DigestScheduler is the only one daimon has,
// and "the digest is not a cron engine" is the rule it was built under), and a
// search that runs itself is a notification feature wearing a search's clothes.
// `test/saved-searches.test.mjs` greps the compiled daemon to keep it that way.
//
// This module is PURE: it transforms a list and reports what happened. The
// caller owns persistence (savePersistedState's merge-write, so saving a search
// can never clobber ports/mutes/digests) — the same split the ports allocator
// and the quarantine bookkeeping use.

import { parseSearchQuery, type SearchQueryError } from './searchQuery.js';
import type { SavedSearch } from './stateFile.js';

export type SavedSearchResult =
  | { ok: true; searches: SavedSearch[]; entry: SavedSearch }
  | ({ ok: false; status: number } & SearchQueryError);

export const SAVED_SEARCH_NAME_MAX = 64;
export const SAVED_SEARCH_MAX = 200;

/** Names are user-facing labels: printable, trimmed, bounded. The bound exists
 *  so a pasted log line can't become a "name" that breaks every table. */
export function validateSavedSearchName(name: string): SearchQueryError | null {
  const n = (name ?? '').trim();
  if (!n) return { error: 'a saved search needs a name', hint: "example: daimon searches save errors-today 'level:error after:24h'" };
  if (n.length > SAVED_SEARCH_NAME_MAX) {
    return { error: `name is longer than ${SAVED_SEARCH_NAME_MAX} characters`, hint: 'pick a short label — it is what the palette and the TUI list' };
  }
  // Control characters as ESCAPES, never literal bytes in source (the M91
  // grep-clean-tree rule).
  if (/[\u0000-\u001f\u007f]/.test(n)) {
    return { error: 'name contains control characters', hint: 'use letters, digits, dashes' };
  }
  // `.` and `..` are URL DOT SEGMENTS: the WHATWG parser normalises them away,
  // so `DELETE /api/searches/..` never reaches the route — such a name could be
  // created but never removed except by hand-editing state.json.
  if (n === '.' || n === '..') {
    return { error: `'${n}' is not a usable name`, hint: 'it is a URL path segment, so it could never be deleted again — pick a word' };
  }
  return null;
}

export function findSaved(searches: SavedSearch[], name: string): SavedSearch | undefined {
  const n = (name ?? '').trim();
  return searches.find(s => s.name === n);
}

/**
 * Save (or, with `force`, overwrite) a named query.
 *
 * The query is VALIDATED BY THE REAL PARSER at save time (M179), so a saved
 * search can never be a query that fails when it is finally run — the same
 * error text the search surfaces show is returned here instead.
 */
export function saveSearch(
  searches: SavedSearch[],
  name: string,
  query: string,
  opts: { force?: boolean; now?: number } = {},
): SavedSearchResult {
  const now = opts.now ?? Date.now();
  const nameErr = validateSavedSearchName(name);
  if (nameErr) return { ok: false, status: 400, ...nameErr };
  const n = name.trim();
  const q = (query ?? '').trim();
  if (!q) return { ok: false, status: 400, error: 'a saved search needs a query', hint: "example: daimon searches save flaky 'kind:tests app:web'" };
  const parsed = parseSearchQuery(q);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error, hint: parsed.hint };
  const existing = findSaved(searches, n);
  if (existing && !opts.force) {
    return { ok: false, status: 409, error: `a saved search named '${n}' already exists`, hint: `run it, delete it, or save again with --force to replace it` };
  }
  if (!existing && searches.length >= SAVED_SEARCH_MAX) {
    return { ok: false, status: 400, error: `too many saved searches (max ${SAVED_SEARCH_MAX})`, hint: "delete one with 'daimon searches delete <name>'" };
  }
  const entry: SavedSearch = {
    name: n,
    query: q,
    createdMs: existing?.createdMs ?? now,
    updatedMs: now,
  };
  const next = existing ? searches.map(s => (s.name === n ? entry : s)) : [...searches, entry];
  return { ok: true, searches: next, entry };
}

export function renameSearch(
  searches: SavedSearch[],
  from: string,
  to: string,
  opts: { now?: number } = {},
): SavedSearchResult {
  const nameErr = validateSavedSearchName(to);
  if (nameErr) return { ok: false, status: 400, ...nameErr };
  const f = (from ?? '').trim();
  const t = to.trim();
  const existing = findSaved(searches, f);
  if (!existing) return { ok: false, status: 404, ...notFound(searches, f) };
  if (f !== t && findSaved(searches, t)) {
    return { ok: false, status: 409, error: `a saved search named '${t}' already exists`, hint: 'pick another name, or delete that one first' };
  }
  const entry: SavedSearch = { ...existing, name: t, updatedMs: opts.now ?? Date.now() };
  return { ok: true, searches: searches.map(s => (s.name === f ? entry : s)), entry };
}

export function deleteSearch(searches: SavedSearch[], name: string): SavedSearchResult {
  const n = (name ?? '').trim();
  const existing = findSaved(searches, n);
  if (!existing) return { ok: false, status: 404, ...notFound(searches, n) };
  return { ok: true, searches: searches.filter(s => s.name !== n), entry: existing };
}

/** Not-found errors name what IS there — a remedy, not a dead end (M90). */
function notFound(searches: SavedSearch[], name: string): SearchQueryError {
  const names = searches.map(s => s.name);
  return {
    error: `no saved search named '${name}'`,
    hint: names.length ? `saved: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ' …' : ''}` : "nothing saved yet — 'daimon searches save <name> <query>'",
  };
}

/** Stable presentation order: most recently updated first, then by name. */
export function sortSaved(searches: SavedSearch[]): SavedSearch[] {
  return [...searches].sort((a, b) => (b.updatedMs - a.updatedMs) || a.name.localeCompare(b.name));
}
