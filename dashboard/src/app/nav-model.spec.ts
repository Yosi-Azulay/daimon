import { describe, it, expect } from 'vitest';
import { NAV_GROUPS, NAV_ENTRIES, contextForUrl } from './nav-model';

describe('nav-model grouping', () => {
  it('has exactly the three task groups in order', () => {
    expect(NAV_GROUPS.map(g => g.label)).toEqual(['Observe', 'Investigate', 'Configure']);
  });

  it('covers all 15 nav destinations, each exactly once', () => {
    const paths = NAV_ENTRIES.map(e => e.path);
    expect(paths.length).toBe(15);
    expect(new Set(paths).size).toBe(15);
  });

  it('groups the pages by task as specified', () => {
    const byGroup = Object.fromEntries(NAV_GROUPS.map(g => [g.label, g.entries.map(e => e.label)]));
    expect(byGroup['Observe']).toEqual(['Apps', 'Events', 'Logs', 'Timeline', 'Graph', 'Sessions']);
    expect(byGroup['Investigate']).toEqual(['Errors', 'History', 'Trends', 'Tests', 'Regressions', 'Report', 'Agents']);
    expect(byGroup['Configure']).toEqual(['Settings', 'Doctor']);
  });

  it('gives every entry a unique g-chord', () => {
    const chords = NAV_ENTRIES.map(e => e.shortcut);
    expect(new Set(chords).size).toBe(chords.length);
    expect(chords.every(c => /^g [a-z]$/.test(c))).toBe(true);
  });

  it('points Apps at /apps (moved off / in v1.12)', () => {
    expect(NAV_ENTRIES.find(e => e.label === 'Apps')!.path).toBe('/apps');
  });
});

describe('contextForUrl', () => {
  it('maps the root to the overview (no group)', () => {
    expect(contextForUrl('/')).toEqual({ group: null, page: 'Overview' });
    expect(contextForUrl('')).toEqual({ group: null, page: 'Overview' });
  });

  it('maps a top-level page to its group and label', () => {
    expect(contextForUrl('/errors')).toEqual({ group: 'Investigate', page: 'Errors' });
    expect(contextForUrl('/logs')).toEqual({ group: 'Observe', page: 'Logs' });
    expect(contextForUrl('/config')).toEqual({ group: 'Configure', page: 'Settings' });
    expect(contextForUrl('/graph')).toEqual({ group: 'Observe', page: 'Graph' });
  });

  it('ignores query and fragment', () => {
    expect(contextForUrl('/timeline?ts=1&app=web')).toEqual({ group: 'Observe', page: 'Timeline' });
    expect(contextForUrl('/errors#top')).toEqual({ group: 'Investigate', page: 'Errors' });
    expect(contextForUrl('/?group=web')).toEqual({ group: null, page: 'Overview' });
  });

  it('carries the entity name on detail routes', () => {
    expect(contextForUrl('/apps/web-ui')).toEqual({ group: 'Observe', page: 'Apps', detail: 'web-ui' });
    expect(contextForUrl('/logs/api?from=search')).toEqual({ group: 'Observe', page: 'Logs', detail: 'api' });
    expect(contextForUrl('/history/api')).toEqual({ group: 'Investigate', page: 'History', detail: 'api' });
    expect(contextForUrl('/requests/api')).toEqual({ group: 'Investigate', page: 'Requests', detail: 'api' });
  });

  it('decodes an encoded entity name', () => {
    expect(contextForUrl('/apps/web%20ui')?.detail).toBe('web ui');
  });

  it('returns null for an unknown path rather than a wrong crumb', () => {
    expect(contextForUrl('/nope')).toBeNull();
  });
});
