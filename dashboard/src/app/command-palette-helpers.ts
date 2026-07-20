// Pure helpers for the command palette's search mode (M77), extracted so
// they're unit-testable under Vitest without spinning up the Angular
// runtime. Mirrors src/history.ts's SearchHit / GET /api/search response.

export interface SearchHit {
  kind: 'logs' | 'errors' | 'events';
  app: string;
  ts: number;
  snippet: string;
  ref: string;
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

const KIND_ORDER: SearchHit['kind'][] = ['errors', 'events', 'logs'];
const KIND_LABEL: Record<SearchHit['kind'], string> = { errors: 'Errors', events: 'Events', logs: 'Logs' };

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
//  - errors land on the app's detail page with its Errors tab preselected.
export function routeForHit(hit: SearchHit): string {
  // `&app=` (M137, v1.8) presets the Timeline page's app filter so a
  // palette hit lands already scoped to the app it came from, not just
  // anchored at its timestamp.
  if (hit.kind === 'events') return `/timeline?at=${hit.ts}&app=${encodeURIComponent(hit.app)}`;
  if (hit.kind === 'logs') return `/logs/${hit.app}?from=search`;
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
