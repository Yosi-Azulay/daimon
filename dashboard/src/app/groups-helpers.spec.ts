import { describe, expect, it } from 'vitest';
import {
  appMatchesGroup,
  filterByGroup,
  groupChips,
  groupSections,
  groupsForApp,
  sectionOffsets,
  type GroupInfo,
} from './groups-helpers';

function app(name: string, baseName?: string) {
  return { name, baseName };
}

function groups(over: Record<string, Partial<GroupInfo>> = {}): Record<string, GroupInfo> {
  const out: Record<string, GroupInfo> = {};
  for (const [name, g] of Object.entries(over)) {
    out[name] = { apps: [], autoStart: false, statusCounts: {}, healthy: 0, total: 0, ...g };
  }
  return out;
}

describe('groups-helpers', () => {
  it('groupChips returns [] for an empty/missing groups map (pre-v1.1 daemon fallback)', () => {
    expect(groupChips({})).toEqual([]);
  });

  it('groupChips preserves config (object key) order, not alphabetical', () => {
    const g = groups({ day: { healthy: 1, total: 2 }, web: { healthy: 2, total: 2 } });
    expect(groupChips(g).map(c => c.name)).toEqual(['day', 'web']);
    expect(groupChips(g)[0]).toEqual({ name: 'day', healthy: 1, total: 2 });
  });

  it('appMatchesGroup matches by name or baseName', () => {
    expect(appMatchesGroup(app('web-3000', 'web'), ['web'])).toBe(true);
    expect(appMatchesGroup(app('web'), ['web'])).toBe(true);
    expect(appMatchesGroup(app('api'), ['web'])).toBe(false);
    expect(appMatchesGroup(app('api', null as any), ['web'])).toBe(false);
  });

  it('filterByGroup returns the full list when no group is active', () => {
    const apps = [app('web'), app('api')];
    expect(filterByGroup(apps, null, groups({ web: { apps: ['web'] } }))).toEqual(apps);
  });

  it('filterByGroup returns the full list when the named group no longer exists (stale deep-link)', () => {
    const apps = [app('web'), app('api')];
    expect(filterByGroup(apps, 'ghost', groups({ web: { apps: ['web'] } }))).toEqual(apps);
  });

  it('filterByGroup restricts to a group\'s members by name or baseName', () => {
    const apps = [app('web'), app('api'), app('worker-1', 'worker')];
    const g = groups({ web: { apps: ['web', 'worker'] } });
    expect(filterByGroup(apps, 'web', g).map(a => a.name)).toEqual(['web', 'worker-1']);
  });

  it('groupSections returns [] when there are no groups (fallback to flat list)', () => {
    expect(groupSections([app('web')], {})).toEqual([]);
  });

  it('groupSections splits into one section per group (config order, members in group order) plus a trailing ungrouped section', () => {
    const apps = [app('api'), app('web'), app('worker')];
    const g = groups({ web: { apps: ['web'] }, day: { apps: ['worker', 'web'] } });
    const sections = groupSections(apps, g);
    expect(sections.map(s => s.name)).toEqual(['web', 'day', null]);
    expect(sections[0].apps.map(a => a.name)).toEqual(['web']);
    // 'day' lists worker before web in config -- section order follows it, not registry order.
    expect(sections[1].apps.map(a => a.name)).toEqual(['worker', 'web']);
    expect(sections[2].apps.map(a => a.name)).toEqual(['api']);
  });

  it('groupSections puts a multi-group app under every group it belongs to', () => {
    const apps = [app('web')];
    const g = groups({ a: { apps: ['web'] }, b: { apps: ['web'] } });
    const sections = groupSections(apps, g);
    expect(sections.map(s => s.apps.map(a => a.name))).toEqual([['web'], ['web']]);
  });

  it('groupSections omits the ungrouped section when every app is grouped', () => {
    const apps = [app('web')];
    const sections = groupSections(apps, groups({ web: { apps: ['web'] } }));
    expect(sections.some(s => s.name === null)).toBe(false);
  });

  it('groupSections still emits a group section (empty apps) when the config lists apps not present in the registry', () => {
    const sections = groupSections([app('web')], groups({ ghost: { apps: ['does-not-exist'] } }));
    expect(sections).toEqual([
      { name: 'ghost', apps: [] },
      { name: null, apps: [app('web')] },
    ]);
  });

  it('sectionOffsets returns cumulative counts before each section', () => {
    const sections = [
      { name: 'a', apps: [1, 2] },
      { name: 'b', apps: [3] },
      { name: null, apps: [4, 5, 6] },
    ];
    expect(sectionOffsets(sections)).toEqual([0, 2, 3]);
  });

  it('sectionOffsets returns [] for no sections', () => {
    expect(sectionOffsets([])).toEqual([]);
  });

  it('groupsForApp lists the config-ordered group names an app belongs to', () => {
    const g = groups({ b: { apps: ['web'] }, a: { apps: ['web'] }, c: { apps: ['other'] } });
    expect(groupsForApp(app('web'), g)).toEqual(['b', 'a']);
  });

  it('groupsForApp returns [] for an app in no group', () => {
    expect(groupsForApp(app('lonely'), groups({ web: { apps: ['other'] } }))).toEqual([]);
  });
});
