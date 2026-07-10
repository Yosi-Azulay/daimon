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

// Where selecting a hit should navigate: errors/events land on the app's
// detail page (where errors/events already surface); logs land on that
// app's logs page.
export function routeForHit(hit: SearchHit): string {
  return hit.kind === 'logs' ? `/logs/${hit.app}` : `/apps/${hit.app}`;
}

export function fmtHitAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
