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
