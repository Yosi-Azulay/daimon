import { describe, expect, it } from 'vitest';
import {
  isSearchQuery,
  searchQueryText,
  groupHitsByKind,
  flattenGroups,
  routeForHit,
  fmtHitAgo,
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
