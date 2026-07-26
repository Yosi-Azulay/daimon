import { describe, expect, it } from 'vitest';
import {
  isSearchQuery,
  searchQueryText,
  groupHitsByKind,
  flattenGroups,
  routeForHit,
  fmtHitAgo,
  fuzzyScore,
  rankItems,
  rememberRecent,
  parseRecents,
  isSearchSyntaxError,
  formatFacetSummary,
  sortSavedSearches,
  savedSearchQueryText,
  type RecentEntry,
  type SearchHit,
  type SavedSearch,
} from './command-palette-helpers';

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return { kind: 'logs', app: 'web', ts: 0, snippet: 'boom', ref: 'log:1', ...over };
}

describe('command-palette search helpers', () => {
  it('isSearchQuery triggers on a leading > (ignoring leading whitespace)', () => {
    expect(isSearchQuery('>foo')).toBe(true);
    expect(isSearchQuery('  >foo')).toBe(true);
    expect(isSearchQuery('foo')).toBe(false);
    expect(isSearchQuery('')).toBe(false);
  });

  it('searchQueryText strips the trigger and one following space', () => {
    expect(searchQueryText('>foo')).toBe('foo');
    expect(searchQueryText('> foo')).toBe('foo');
    expect(searchQueryText('>  foo')).toBe(' foo');
    expect(searchQueryText('>')).toBe('');
  });

  it('groupHitsByKind orders errors, then events, then logs, and omits empty kinds', () => {
    const hits = [
      hit({ kind: 'logs', ref: 'log:1' }),
      hit({ kind: 'errors', ref: 'event:1' }),
      hit({ kind: 'events', ref: 'event:2' }),
      hit({ kind: 'errors', ref: 'event:3' }),
    ];
    const groups = groupHitsByKind(hits);
    expect(groups.map(g => g.kind)).toEqual(['errors', 'events', 'logs']);
    expect(groups[0].hits.map(h => h.ref)).toEqual(['event:1', 'event:3']);
    expect(groups.find(g => g.kind === 'events')!.hits.map(h => h.ref)).toEqual(['event:2']);
  });

  it('groupHitsByKind returns no groups for an empty input', () => {
    expect(groupHitsByKind([])).toEqual([]);
  });

  it('flattenGroups restores render order', () => {
    const groups = groupHitsByKind([
      hit({ kind: 'logs', ref: 'log:1' }),
      hit({ kind: 'errors', ref: 'event:1' }),
    ]);
    expect(flattenGroups(groups).map(h => h.ref)).toEqual(['event:1', 'log:1']);
  });

  it('routeForHit sends logs to the app logs page, errors to the app errors tab, events to the timeline at ts', () => {
    // '?from=search' (M102) tells the Logs page to clear any active filter so
    // the deep-linked buffer isn't hidden behind a stale level/regex filter.
    expect(routeForHit(hit({ kind: 'logs', app: 'web' }))).toBe('/logs/web?from=search');
    expect(routeForHit(hit({ kind: 'errors', app: 'api' }))).toBe('/apps/api?tab=errors');
    expect(routeForHit(hit({ kind: 'events', app: 'api', ts: 12345 }))).toBe('/timeline?at=12345&app=api');
  });

  it('fmtHitAgo formats relative time buckets', () => {
    const now = 1_000_000;
    expect(fmtHitAgo(now - 5_000, now)).toBe('5s ago');
    expect(fmtHitAgo(now - 120_000, now)).toBe('2m ago');
    expect(fmtHitAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(fmtHitAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('fuzzyScore ranking (M157)', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'Errors')).toBeNull();
    expect(fuzzyScore('errz', 'Errors')).toBeNull();
  });

  it('matches a scattered subsequence', () => {
    expect(fuzzyScore('rgs', 'Regressions')).not.toBeNull();
  });

  it('scores an empty query as neutral (everything matches)', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('tiers exact-prefix above word-start above scattered', () => {
    const prefix = fuzzyScore('log', 'Logs')!;          // exact prefix
    const wordStart = fuzzyScore('log', 'Go to Logs')!;  // matches at a word start
    const scattered = fuzzyScore('log', 'Catalog')!;     // mid-word contiguous, no boundary
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(scattered);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('ERR', 'errors')).not.toBeNull();
    expect(fuzzyScore('err', 'ERRORS')).not.toBeNull();
  });
});

describe('rankItems (M157)', () => {
  const items = [
    { label: 'Go to Errors', keywords: 'Errors' },
    { label: 'Go to Events', keywords: 'Events' },
    { label: 'Go to Trends', keywords: 'Trends' },
    { label: 'web', keywords: 'open app' },
  ];

  it('returns the full list unchanged for an empty query', () => {
    expect(rankItems('', items)).toEqual(items);
  });

  it('drops non-matches and orders best first', () => {
    const r = rankItems('err', items);
    expect(r.map(i => i.label)).toEqual(['Go to Errors']);
  });

  it('ranks a prefix hit above a keyword-only hit', () => {
    const r = rankItems('ev', items);
    // "Go to Events" — 'ev' hits at the "Events" word start; ordering is
    // deterministic and events should surface.
    expect(r[0].label).toBe('Go to Events');
  });

  it('keeps input order on ties (stable)', () => {
    const tie = [{ label: 'aa' }, { label: 'ab' }];
    // both match 'a'; original order preserved when scores are equal-ish
    const r = rankItems('a', tie);
    expect(r.map(i => i.label)).toEqual(['aa', 'ab']);
  });
});

describe('recents (M157)', () => {
  const nav = (route: string): RecentEntry => ({ label: 'Go ' + route, route, icon: 'x' });

  it('adds to the front and caps at max', () => {
    let list: RecentEntry[] = [];
    for (const r of ['/a', '/b', '/c', '/d', '/e', '/f', '/g']) list = rememberRecent(list, nav(r), 6);
    expect(list.map(r => r.route)).toEqual(['/g', '/f', '/e', '/d', '/c', '/b']);
  });

  it('de-duplicates by route, moving a re-selection to the top', () => {
    let list = [nav('/a'), nav('/b'), nav('/c')];
    list = rememberRecent(list, nav('/c'), 6);
    expect(list.map(r => r.route)).toEqual(['/c', '/a', '/b']);
  });

  it('parseRecents tolerates junk and non-arrays', () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents('not json')).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
    expect(parseRecents(JSON.stringify([{ label: 'x', route: '/x', icon: 'i' }, { bad: true }]))).toEqual([
      { label: 'x', route: '/x', icon: 'i' },
    ]);
  });
});

describe('unified search kinds (M180, v1.16)', () => {
  it('groupHitsByKind slots error-groups and tests in alongside their nearest relative', () => {
    const hits = [
      hit({ kind: 'logs', ref: 'log:1' }),
      hit({ kind: 'error-groups', ref: 'errgroup:a' }),
      hit({ kind: 'tests', ref: 'test:1' }),
      hit({ kind: 'errors', ref: 'event:1' }),
      hit({ kind: 'events', ref: 'event:2' }),
    ];
    const groups = groupHitsByKind(hits);
    expect(groups.map(g => g.kind)).toEqual(['errors', 'error-groups', 'events', 'tests', 'logs']);
  });

  it('routeForHit sends tests to /tests and error-groups to /errors, without touching existing kinds', () => {
    expect(routeForHit(hit({ kind: 'tests', app: 'web' }))).toBe('/tests');
    expect(routeForHit(hit({ kind: 'error-groups', app: 'web' }))).toBe('/errors');
    // Unchanged from v1.15 — the deep-link back-compat rule.
    expect(routeForHit(hit({ kind: 'logs', app: 'web' }))).toBe('/logs/web?from=search');
    expect(routeForHit(hit({ kind: 'errors', app: 'api' }))).toBe('/apps/api?tab=errors');
    expect(routeForHit(hit({ kind: 'events', app: 'api', ts: 12345 }))).toBe('/timeline?at=12345&app=api');
  });
});

describe('isSearchSyntaxError (M179, v1.16)', () => {
  it('is true only when the API result carries a non-empty error string', () => {
    expect(isSearchSyntaxError({ error: "unknown field 'lvl:'" })).toBe(true);
    expect(isSearchSyntaxError({})).toBe(false);
    expect(isSearchSyntaxError({ error: '' })).toBe(false);
    expect(isSearchSyntaxError({ error: undefined })).toBe(false);
  });
});

describe('formatFacetSummary (M180, v1.16)', () => {
  it('returns null when there are no facets', () => {
    expect(formatFacetSummary(undefined)).toBeNull();
    expect(formatFacetSummary(null)).toBeNull();
  });

  it('returns null when every facet is zero', () => {
    expect(formatFacetSummary({ logs: 0, errors: 0 })).toBeNull();
  });

  it('formats non-zero facets in KIND_ORDER, singular for a count of 1', () => {
    expect(formatFacetSummary({ logs: 2, errors: 1, tests: 0, 'error-groups': 3 })).toBe(
      '1 error · 3 error groups · 2 logs',
    );
  });

  it('pluralizes counts above 1', () => {
    expect(formatFacetSummary({ events: 5 })).toBe('5 events');
  });
});

describe('saved searches (M181, v1.16)', () => {
  const saved = (over: Partial<SavedSearch> = {}): SavedSearch => ({
    name: 'flaky', query: 'kind:tests app:web', createdMs: 0, updatedMs: 0, ...over,
  });

  it('savedSearchQueryText prepends the > search-mode trigger', () => {
    expect(savedSearchQueryText(saved({ query: 'level:error after:24h' }))).toBe('> level:error after:24h');
  });

  it('sortSavedSearches orders most-recently-updated first, then by name', () => {
    const list = [
      saved({ name: 'b', updatedMs: 100 }),
      saved({ name: 'a', updatedMs: 200 }),
      saved({ name: 'c', updatedMs: 200 }),
    ];
    expect(sortSavedSearches(list).map(s => s.name)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const list = [saved({ name: 'z', updatedMs: 1 }), saved({ name: 'a', updatedMs: 2 })];
    const copy = [...list];
    sortSavedSearches(list);
    expect(list).toEqual(copy);
  });
});
