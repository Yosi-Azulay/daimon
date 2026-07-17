import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_CHORD_KEY,
  GROUP_CHORD_HELP,
  cycleGroupFilter,
  appMatchesGroup,
  filterByGroup,
  computeGroupHealth,
  formatGroupHeader,
} from '../dist/tui/groupChord.js';

test('chord key is a single free letter and is advertised in the help ribbon', () => {
  assert.equal(GROUP_CHORD_KEY, 'G');
  assert.equal(GROUP_CHORD_KEY.length, 1);
  assert.match(GROUP_CHORD_HELP, /\[G\]/);
  assert.match(GROUP_CHORD_HELP.toLowerCase(), /group/);
});

test('cycleGroupFilter: none -> each group in config order -> none', () => {
  const names = ['web', 'infra', 'workers'];
  let cur = null;
  cur = cycleGroupFilter(names, cur);
  assert.equal(cur, 'web');
  cur = cycleGroupFilter(names, cur);
  assert.equal(cur, 'infra');
  cur = cycleGroupFilter(names, cur);
  assert.equal(cur, 'workers');
  cur = cycleGroupFilter(names, cur);
  assert.equal(cur, null);
  // and it repeats
  cur = cycleGroupFilter(names, cur);
  assert.equal(cur, 'web');
});

test('cycleGroupFilter: empty groups config makes the chord a permanent no-op', () => {
  assert.equal(cycleGroupFilter([], null), null);
  assert.equal(cycleGroupFilter([], 'anything'), null);
});

test('cycleGroupFilter: an active group that vanished from config resets to none', () => {
  assert.equal(cycleGroupFilter(['web', 'infra'], 'stale-group'), null);
});

test('appMatchesGroup: matches by name or baseName', () => {
  const members = ['web', 'api'];
  assert.equal(appMatchesGroup({ name: 'web', baseName: 'web' }, members), true);
  assert.equal(appMatchesGroup({ name: 'api@ws2', baseName: 'api' }, members), true);
  assert.equal(appMatchesGroup({ name: 'worker', baseName: 'worker' }, members), false);
});

test('filterByGroup: null members passes every app through unchanged', () => {
  const apps = [{ name: 'a', baseName: 'a' }, { name: 'b', baseName: 'b' }];
  assert.deepEqual(filterByGroup(apps, null), apps);
});

test('filterByGroup: filters down to members by name or baseName', () => {
  const apps = [
    { name: 'web', baseName: 'web' },
    { name: 'api@ws2', baseName: 'api' },
    { name: 'worker', baseName: 'worker' },
  ];
  const filtered = filterByGroup(apps, ['web', 'api']);
  assert.deepEqual(filtered.map(a => a.name), ['web', 'api@ws2']);
});

test('filterByGroup: an empty member list filters everything out', () => {
  const apps = [{ name: 'a', baseName: 'a' }];
  assert.deepEqual(filterByGroup(apps, []), []);
});

test('computeGroupHealth: healthy = serving+healthy members, total = declared member count', () => {
  const apps = [
    { name: 'web', baseName: 'web', status: 'serving', health: 'healthy' },
    { name: 'api', baseName: 'api', status: 'serving', health: 'unhealthy' },
    { name: 'worker', baseName: 'worker', status: 'error', health: 'unknown' },
  ];
  const { healthy, total } = computeGroupHealth(apps, ['web', 'api', 'worker']);
  assert.equal(healthy, 1);
  assert.equal(total, 3);
});

test('computeGroupHealth: an unresolvable member counts toward total but not healthy', () => {
  const apps = [{ name: 'web', baseName: 'web', status: 'serving', health: 'healthy' }];
  const { healthy, total } = computeGroupHealth(apps, ['web', 'missing']);
  assert.equal(healthy, 1);
  assert.equal(total, 2);
});

test('computeGroupHealth: matches members by baseName too', () => {
  const apps = [{ name: 'api@ws2', baseName: 'api', status: 'serving', health: 'healthy' }];
  const { healthy, total } = computeGroupHealth(apps, ['api']);
  assert.equal(healthy, 1);
  assert.equal(total, 1);
});

test('formatGroupHeader renders the documented shape', () => {
  assert.equal(formatGroupHeader('web', 3, 4), 'group: web · 3/4 healthy');
  assert.equal(formatGroupHeader('infra', 0, 0), 'group: infra · 0/0 healthy');
});
