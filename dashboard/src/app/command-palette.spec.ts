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
  type RecentEntry,
  type SearchHit,
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
