// Pure helpers for the command palette's search mode (M77, extended M180/M181
// v1.16 "Recall"), extracted so they're unit-testable under Vitest without
// spinning up the Angular runtime. Mirrors src/history.ts's SearchHit /
// GET /api/search response.

export interface SearchHit {
  // 'tests' and 'error-groups' (M180, v1.16) appear only when the palette
  // requests the unified `scope=all` — see DaimonApi.search.
  kind: 'logs' | 'errors' | 'events' | 'tests' | 'error-groups';
  app: string;
  ts: number;
  snippet: string;
  // Stable pointer: "event:<id>", "log:<id>", "test:<id>", "errgroup:<fp>".
  ref: string;
}

// A saved search (M181, v1.16) — a name and a query string, nothing more.
// Mirrors src/stateFile.ts's SavedSearch / GET /api/searches response.
export interface SavedSearch {
  name: string;
  query: string;
  createdMs: number;
  updatedMs: number;
}

const SEARCH_PREFIX = '>';

// Search mode triggers when the raw palette input starts with `>` (after
// trimming leading whitespace so a stray space before typing doesn't miss it).
export function isSearchQuery(raw: string): boolean {
  return raw.trimStart().startsWith(SEARCH_PREFIX);
}

// Strips the `>` trigger (and a single following space, if present) to get
// the text that's actually sent to GET /api/search.
export function searchQueryText(raw: string): string {
  const trimmed = raw.trimStart();
  const rest = trimmed.slice(SEARCH_PREFIX.length);
  return rest.startsWith(' ') ? rest.slice(1) : rest;
}

// Most-actionable first; the two v1.16 kinds slot in next to their closest
// relative (error groups beside per-app errors, tests before the noisiest
// kind, logs).
const KIND_ORDER: SearchHit['kind'][] = ['errors', 'error-groups', 'events', 'tests', 'logs'];
const KIND_LABEL: Record<SearchHit['kind'], string> = {
  errors: 'Errors',
  'error-groups': 'Error groups',
  events: 'Events',
  tests: 'Tests',
  logs: 'Logs',
};

export interface SearchHitGroup {
  kind: SearchHit['kind'];
  label: string;
  hits: SearchHit[];
}

// Groups hits by kind in a fixed display order (most-actionable first),
// preserving each hit's relative order (the API already returns ts-desc).
// Empty kinds are omitted so the palette doesn't render blank section headers.
export function groupHitsByKind(hits: SearchHit[]): SearchHitGroup[] {
  const byKind = new Map<SearchHit['kind'], SearchHit[]>();
  for (const h of hits) {
    const arr = byKind.get(h.kind);
    if (arr) arr.push(h);
    else byKind.set(h.kind, [h]);
  }
  return KIND_ORDER
    .filter(k => byKind.has(k))
    .map(k => ({ kind: k, label: KIND_LABEL[k], hits: byKind.get(k)! }));
}

// Flattens grouped hits back into the order they render in, for index-based
// keyboard navigation (arrow up/down, enter) over the grouped list.
export function flattenGroups(groups: SearchHitGroup[]): SearchHit[] {
  return groups.flatMap(g => g.hits);
}

// Where selecting a hit should navigate (M85 deep-links):
//  - events land on the Timeline page, anchored at the hit's ts via `?at=`
//    so the timeline scrolls to and highlights the nearest row;
//  - logs land on that app's Logs page (the live tailer has no historical-ts
//    seek, so there's no `ts` param to pass — app is the most it can target).
//    `?from=search` (M102) tells the Logs page to clear any active
//    level/regex filter so the live buffer isn't hidden behind whatever
//    filter happened to be set before the deep-link landed;
//  - errors land on the app's detail page with its Errors tab preselected;
//  - tests (M180, v1.16) land on the Tests page — it has no per-run deep
//    link yet, so the ref is carried for a future one rather than guessed;
//  - error-groups (M180) land on the global Errors panel, same reasoning.
export function routeForHit(hit: SearchHit): string {
  // `&app=` (M137, v1.8) presets the Timeline page's app filter so a
  // palette hit lands already scoped to the app it came from, not just
  // anchored at its timestamp.
  if (hit.kind === 'events') return `/timeline?at=${hit.ts}&app=${encodeURIComponent(hit.app)}`;
  if (hit.kind === 'logs') return `/logs/${hit.app}?from=search`;
  if (hit.kind === 'tests') return '/tests';
  if (hit.kind === 'error-groups') return '/errors';
  return `/apps/${hit.app}?tab=errors`;
}

export function fmtHitAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ── Fuzzy ranking (M157, v1.12) ──────────────────────────────────────────
// The palette 2.0 unifies navigation, app jumps, and actions into ONE ranked
// list. Ranking is subsequence matching with tiers — exact prefix beats a
// word-start match beats a scattered subsequence — implemented here as pure
// functions so command-palette.spec.ts can pin the order without booting
// Angular. No dependency added; this is deliberately small, not a full fzy.

const WORD_BOUNDARY = /[\s\-_/.:]/;

// Score `text` against `query` as a subsequence. Returns null when `query`
// is NOT a subsequence of `text` (the item is filtered out). Higher score =
// better match. An empty query scores 0 (everything matches, unfiltered).
//
// Scoring rewards, per matched char: a match at a word boundary (the start of
// a word), a match contiguous with the previous one, and — as a large flat
// bonus — the whole query being a prefix of the text. This yields the
// required tiering: exact-prefix > word-start > scattered.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;

  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null; // not a subsequence
    // Word-boundary bonus: char is at index 0 or follows a separator.
    const atWordStart = found === 0 || WORD_BOUNDARY.test(t[found - 1]);
    if (atWordStart) score += 10;
    // Contiguity bonus: immediately follows the previous matched char.
    if (found === lastMatch + 1) score += 6;
    // Every matched char is worth a little; earlier matches worth slightly more.
    score += Math.max(1, 5 - found * 0.1);
    lastMatch = found;
    ti = found + 1;
  }
  // Whole-query prefix: the strongest signal a user means this item.
  if (t.startsWith(q)) score += 40;
  // Prefer shorter targets on ties (a 4-char label beats a 40-char one).
  score -= t.length * 0.05;
  return score;
}

export interface Rankable {
  /** Text shown and primarily matched against. */
  label: string;
  /** Extra match text (aliases, hints) that never shows but improves recall. */
  keywords?: string;
}

// Rank a list against a query, dropping non-matches, best first. Stable on
// ties via the original index so equal-score items keep input order.
export function rankItems<T extends Rankable>(query: string, items: T[]): T[] {
  const q = query.trim();
  if (!q) return items;
  const scored: { item: T; score: number; i: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const a = fuzzyScore(q, it.label);
    const b = it.keywords ? fuzzyScore(q, it.keywords) : null;
    // Match on label OR keywords; take the better score, but keyword-only
    // matches are slightly discounted so a label hit always wins.
    let best: number | null = null;
    if (a !== null) best = a;
    if (b !== null) best = best === null ? b - 8 : Math.max(best, b - 8);
    if (best !== null) scored.push({ item: it, score: best, i });
  }
  scored.sort((x, y) => (y.score - x.score) || (x.i - y.i));
  return scored.map(s => s.item);
}

// ── Recents (M157) ───────────────────────────────────────────────────────
// The palette remembers the last N NAVIGATION selections (nav + app jumps),
// never actions — replaying "Stop web" blind on reopen would be dangerous.
// Stored in localStorage; these helpers are pure so the dedup/cap logic is
// unit-tested independently of the browser.

export interface RecentEntry {
  label: string;
  route: string;
  icon: string;
}

export const RECENTS_MAX = 6;

// Add `entry` to the front of `list`, de-duplicated by route (a re-selection
// moves it to the top rather than adding a second copy), capped at `max`.
export function rememberRecent(list: RecentEntry[], entry: RecentEntry, max = RECENTS_MAX): RecentEntry[] {
  const next = [entry, ...list.filter(r => r.route !== entry.route)];
  return next.slice(0, max);
}

// Parse the stored recents JSON defensively — a hand-edited or corrupt value
// yields [] rather than throwing.
export function parseRecents(raw: string | null): RecentEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is RecentEntry =>
        !!r && typeof r.label === 'string' && typeof r.route === 'string' && typeof r.icon === 'string',
    ).slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

// ── Query syntax + unified search (M179/M180, v1.16) ─────────────────────

// Shape of DaimonApi.search()'s return value — the subset these helpers act
// on. `error`/`hint` are present ONLY when GET /api/search 400'd on a bad
// M179 query (an unknown field like `lvl:`) — every other failure still
// degrades to an empty, error-less result (DaimonApi's existing contract).
export interface SearchApiResult {
  hits: SearchHit[];
  fallback: boolean;
  facets?: Record<string, number>;
  error?: string;
  hint?: string;
}

// True when the API call returned a query-syntax error rather than (possibly
// empty) results — the palette renders the error + hint INSTEAD OF "no
// results" so a typo'd field reads as "fix your query", not "nothing found".
export function isSearchSyntaxError(r: Pick<SearchApiResult, 'error'>): boolean {
  return typeof r.error === 'string' && r.error.length > 0;
}

// Compact one-line facet summary ("3 errors · 1 test · 2 logs") for the
// palette's search-mode header, shown only when the API returned `facets`
// (i.e. the unified `scope=all` was requested). Zero-count kinds are
// omitted; the order matches KIND_ORDER so the summary never disagrees with
// the grouped results rendered below it.
const FACET_SINGULAR: Record<string, string> = {
  errors: 'error',
  'error-groups': 'error group',
  events: 'event',
  tests: 'test',
  logs: 'log',
};

export function formatFacetSummary(facets: Record<string, number> | null | undefined): string | null {
  if (!facets) return null;
  const parts = KIND_ORDER
    .map(k => [k, facets[k] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? FACET_SINGULAR[k] : KIND_LABEL[k].toLowerCase()}`);
  return parts.length ? parts.join(' · ') : null;
}

// ── Saved searches (M181, v1.16) ──────────────────────────────────────────
// Saved searches are inert data (name + query string) — surfacing them in
// the palette is display + one explicit run action, nothing auto-executes.
// See src/savedSearches.ts's header comment for the standing rule.

// Presentation order for the idle palette list: most recently updated first
// (mirrors the server's `sortSaved`, so a re-save also floats to the top
// here without any client-side re-sort).
export function sortSavedSearches(searches: SavedSearch[]): SavedSearch[] {
  return [...searches].sort((a, b) => (b.updatedMs - a.updatedMs) || a.name.localeCompare(b.name));
}

// The full palette input text produced by selecting a saved search: the `>`
// search-mode trigger plus the saved query, so running one behaves exactly
// like the user typing `> <query>` themselves — same debounce, same parser,
// same errors.
export function savedSearchQueryText(s: Pick<SavedSearch, 'query'>): string {
  return `${SEARCH_PREFIX} ${s.query}`;
}
