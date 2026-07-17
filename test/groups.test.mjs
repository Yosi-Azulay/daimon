import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Named app groups (M93, v1.1): config normalization (shorthand + object
// forms), depends-aware resolution, validate warnings (unknown app /
// dual-autoStart / group-profile collision), boot autoStart dedup plan, and
// the GET /api/groups shape against a synthetic Registry + startServer.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-groups-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { validateConfig, configValidationWarnings } = await import('../dist/config.js');
const {
  resolveGroup, groupUpPlan, groupStopOrder, autoStartPlan, validateGroups, nearestName, groupNames,
} = await import('../dist/groups.js');

// ---------------------------------------------------------------------------
// Config normalization

test('shorthand form normalizes to { apps, autoStart: false }', () => {
  const cfg = validateConfig({ groups: { web: ['a', 'b'] } }, 'test');
  assert.deepEqual(cfg.groups, { web: { apps: ['a', 'b'], autoStart: false } });
});

test('object form keeps apps and autoStart', () => {
  const cfg = validateConfig({ groups: { day: { apps: ['api', 'web'], autoStart: true } } }, 'test');
  assert.deepEqual(cfg.groups, { day: { apps: ['api', 'web'], autoStart: true } });
});

test('object form without autoStart defaults to false', () => {
  const cfg = validateConfig({ groups: { day: { apps: ['api'] } } }, 'test');
  assert.deepEqual(cfg.groups, { day: { apps: ['api'], autoStart: false } });
});

test('groups-free config gains no groups key (zero behavior change)', () => {
  const cfg = validateConfig({ apiPort: 5000 }, 'test');
  assert.equal(cfg.groups, undefined);
});

test('broken group entry warns and is skipped; the rest survive', () => {
  const cfg = validateConfig({ groups: { ok: ['a'], bad: 42, alsobad: { apps: 'nope' } } }, 'test');
  assert.deepEqual(Object.keys(cfg.groups), ['ok']);
  const warnings = configValidationWarnings();
  assert.ok(warnings.some(w => w.includes('"groups.bad"')), `warned on bad: ${warnings}`);
  assert.ok(warnings.some(w => w.includes('"groups.alsobad"')), `warned on alsobad: ${warnings}`);
});

test('non-boolean autoStart warns and falls back to false', () => {
  const cfg = validateConfig({ groups: { g: { apps: ['a'], autoStart: 'yes' } } }, 'test');
  assert.deepEqual(cfg.groups, { g: { apps: ['a'], autoStart: false } });
  assert.ok(configValidationWarnings().some(w => w.includes('"groups.g.autoStart"')));
});

test('non-object groups value warns and is ignored', () => {
  const cfg = validateConfig({ groups: ['not', 'a', 'map'] }, 'test');
  assert.equal(cfg.groups, undefined);
  assert.ok(configValidationWarnings().some(w => w.includes('"groups" must be an object')));
});

// ---------------------------------------------------------------------------
// Resolution

const cfgWithDeps = {
  groups: {
    day: { apps: ['web', 'admin', 'api'], autoStart: false },
    solo: { apps: ['web'], autoStart: false },
  },
  depends: { web: ['api'], admin: ['api'] },
};

test('resolveGroup orders members dependencies-first', () => {
  const r = resolveGroup(cfgWithDeps, 'day');
  assert.equal(r.apps[0], 'api', `api first, got ${r.apps}`);
  assert.deepEqual([...r.apps].sort(), ['admin', 'api', 'web']);
  assert.deepEqual(r.cyclic, []);
});

test('resolveGroup returns null for an unknown group', () => {
  assert.equal(resolveGroup(cfgWithDeps, 'nope'), null);
});

test('resolveGroup skips unknown members, keeps the rest', () => {
  const known = new Set(['api', 'web']);
  const r = resolveGroup(cfgWithDeps, 'day', known);
  assert.deepEqual(r.unknown, ['admin']);
  assert.deepEqual(r.apps, ['api', 'web']);
});

test('resolveGroup reports cyclic members instead of ordering them', () => {
  const cfg = { groups: { g: { apps: ['a', 'b', 'c'], autoStart: false } }, depends: { a: ['b'], b: ['a'] } };
  const r = resolveGroup(cfg, 'g');
  assert.deepEqual(r.apps, ['c']);
  assert.deepEqual([...r.cyclic].sort(), ['a', 'b']);
});

test('groupUpPlan expands to the depends closure in topo levels', () => {
  // Group names only web; its dep api must join the plan, in an earlier level.
  const cfg = { groups: { g: { apps: ['web'], autoStart: false } }, depends: { web: ['api'] } };
  const plan = groupUpPlan(cfg, 'g', new Set(['web', 'api']));
  assert.deepEqual(plan.levels, [['api'], ['web']]);
  assert.deepEqual(plan.closure, ['api', 'web']);
});

test('groupUpPlan filters unknown members but keeps known deps', () => {
  const cfg = { groups: { g: { apps: ['web', 'ghost'], autoStart: false } }, depends: { web: ['api'] } };
  const plan = groupUpPlan(cfg, 'g', new Set(['web', 'api']));
  assert.deepEqual(plan.unknown, ['ghost']);
  assert.deepEqual(plan.closure, ['api', 'web']);
});

test('groupStopOrder is reverse depends order, members only', () => {
  const r = groupStopOrder(cfgWithDeps, 'day', new Set(['web', 'admin', 'api']));
  // api is a dependency — it must stop LAST; external deps never join.
  assert.equal(r.order[r.order.length - 1], 'api');
  assert.deepEqual([...r.order].sort(), ['admin', 'api', 'web']);
});

test('groupStopOrder appends cyclic members so none stay running', () => {
  const cfg = { groups: { g: { apps: ['a', 'b'], autoStart: false } }, depends: { a: ['b'], b: ['a'] } };
  const r = groupStopOrder(cfg, 'g', new Set(['a', 'b']));
  assert.deepEqual([...r.order].sort(), ['a', 'b']);
});

test('groupNames lists configured groups', () => {
  assert.deepEqual(groupNames(cfgWithDeps), ['day', 'solo']);
  assert.deepEqual(groupNames({}), []);
});

// ---------------------------------------------------------------------------
// validate warnings

test('unknown app in a group warns with nearest-name suggestion', () => {
  const cfg = { groups: { g: { apps: ['web-adminn'], autoStart: false } }, profiles: {}, autoStart: [] };
  const w = validateGroups(cfg, ['web-admin', 'api']);
  const hit = w.find(x => x.includes('unknown app "web-adminn"'));
  assert.ok(hit, `expected unknown-app warning, got ${w}`);
  assert.ok(hit.includes('did you mean "web-admin"'), hit);
});

test('null knownAppNames skips the unknown-app check (discovery degraded)', () => {
  const cfg = { groups: { g: { apps: ['ghost'], autoStart: false } }, profiles: {}, autoStart: [] };
  assert.deepEqual(validateGroups(cfg, null).filter(x => x.includes('unknown app')), []);
});

test('group/profile name collision warns that the group wins', () => {
  const cfg = { groups: { fullstack: { apps: ['a'], autoStart: false } }, profiles: { fullstack: ['a'] }, autoStart: [] };
  const w = validateGroups(cfg, ['a']);
  assert.ok(w.some(x => x.includes('group "fullstack" also exists in profiles') && x.includes('group wins')), `${w}`);
});

test('app in two autoStart groups notes "starts once"', () => {
  const cfg = {
    groups: { g1: { apps: ['api'], autoStart: true }, g2: { apps: ['api'], autoStart: true } },
    profiles: {}, autoStart: [],
  };
  const w = validateGroups(cfg, ['api']);
  assert.ok(w.some(x => x.includes('"api"') && x.includes('starts once')), `${w}`);
});

test('app in autoStart list AND an autoStart group notes "starts once"', () => {
  const cfg = { groups: { g1: { apps: ['api'], autoStart: true } }, profiles: {}, autoStart: ['api'] };
  const w = validateGroups(cfg, ['api']);
  assert.ok(w.some(x => x.includes('"api"') && x.includes('starts once')), `${w}`);
});

test('empty group warns', () => {
  const cfg = { groups: { g: { apps: [], autoStart: false } }, profiles: {}, autoStart: [] };
  assert.ok(validateGroups(cfg, ['a']).some(x => x.includes('empty group')));
});

test('nearestName suggests within 2 edits, null beyond', () => {
  assert.equal(nearestName('wep', ['web', 'api']), 'web');
  assert.equal(nearestName('completely-unrelated', ['web', 'api']), null);
});

// ---------------------------------------------------------------------------
// autoStart plan (M96 core dedup — resolution happens before any spawn)

test('autoStartPlan: app in two autoStart groups appears once with both sources', () => {
  const cfg = {
    autoStart: [],
    groups: { g1: { apps: ['api', 'web'], autoStart: true }, g2: { apps: ['api'], autoStart: true } },
    depends: {},
  };
  const plan = autoStartPlan(cfg);
  const api = plan.find(e => e.app === 'api');
  assert.deepEqual(api.sources, ['group:g1', 'group:g2']);
  assert.equal(plan.filter(e => e.app === 'api').length, 1);
});

test('autoStartPlan: per-app list + group dedups with both sources, list first', () => {
  const cfg = { autoStart: ['api'], groups: { g: { apps: ['api'], autoStart: true } }, depends: {} };
  const plan = autoStartPlan(cfg);
  assert.deepEqual(plan, [{ app: 'api', sources: ['autoStart', 'group:g'] }]);
});

test('autoStartPlan: non-autoStart groups contribute nothing', () => {
  const cfg = { autoStart: ['a'], groups: { g: { apps: ['b'], autoStart: false } }, depends: {} };
  assert.deepEqual(autoStartPlan(cfg).map(e => e.app), ['a']);
});

test('autoStartPlan: group members come out dependencies-first', () => {
  const cfg = { autoStart: [], groups: { g: { apps: ['web', 'api'], autoStart: true } }, depends: { web: ['api'] } };
  assert.deepEqual(autoStartPlan(cfg).map(e => e.app), ['api', 'web']);
});

test('autoStartPlan: cyclic members still get a start attempt', () => {
  const cfg = { autoStart: [], groups: { g: { apps: ['a', 'b'], autoStart: true } }, depends: { a: ['b'], b: ['a'] } };
  assert.deepEqual(autoStartPlan(cfg).map(e => e.app).sort(), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// CLI wiring: `daimon config validate` surfaces group warnings

test('config validate CLI reports group/profile collision + autoStart overlap', async () => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-groups-cli-'));
  const cfgPath = path.join(dir, 'daimon.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    searchRoots: [],
    profiles: { day: ['web'] },
    autoStart: ['web'],
    groups: { day: { apps: ['web'], autoStart: true } },
  }), 'utf8');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliJs = path.join(repoRoot, 'dist', 'cli.js');
  const r = await new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, 'config', 'validate', cfgPath], {
      cwd: dir,
      env: { ...process.env, DAIMON_HOME: fakeHome, DAIMON_NO_SPAWN: '1', NO_COLOR: '1' },
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 15_000);
    child.on('close', code => {
      clearTimeout(killer);
      let body = null;
      try { body = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch {}
      resolve({ code, body });
    });
  });
  assert.equal(r.code, 0, 'warnings never block validate');
  assert.equal(r.body?.ok, true);
  const warnings = r.body?.warnings ?? [];
  assert.ok(warnings.some(w => w.includes('group "day" also exists in profiles')), `${warnings}`);
  assert.ok(warnings.some(w => w.includes('"web"') && w.includes('starts once')), `${warnings}`);
});

// ---------------------------------------------------------------------------
// GET /api/groups against a synthetic Registry + startServer

const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');

const serverConfig = {
  searchRoots: [], portRange: [4210, 4260], apiPort: 0,
  overrides: {}, autoStart: [], profiles: { legacy: ['web'] }, tags: {},
  autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
  healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
  logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
  depends: { web: ['api'] }, cascadeRestart: false,
  history: { enabled: false, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
  notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
  requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
  editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
  doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
  errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
  groups: {
    day: { apps: ['web', 'api', 'ghost'], autoStart: true },
    empty: { apps: [], autoStart: false },
  },
};
const apps = [
  { name: 'web', baseName: 'web', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [], workspaceLabel: 'main' },
  { name: 'api', baseName: 'api', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [], workspaceLabel: 'main' },
];

test('GET /api/groups returns name → { apps, autoStart, statusCounts, healthy, total }', async () => {
  const reg = new Registry(serverConfig, apps);
  const s = reg.getState('web');
  s.status = 'serving';
  reg.setHealth('web', 'healthy');
  const server = startServer(reg, 0, { getConfig: () => serverConfig, onShutdown: () => {} });
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('x-daimon-version'), 'version header present');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['day', 'empty']);
    const day = body.day;
    assert.deepEqual(day.apps, ['web', 'api', 'ghost'], 'member order preserved (config order, not topo)');
    assert.equal(day.autoStart, true);
    assert.equal(day.total, 3);
    assert.equal(day.healthy, 1);
    assert.equal(day.statusCounts.serving, 1);
    assert.equal(day.statusCounts.stopped, 1);
    assert.equal(day.statusCounts.unknown, 1, 'ghost counts as unknown, never vanishes');
    assert.deepEqual(body.empty, { apps: [], autoStart: false, statusCounts: {}, healthy: 0, total: 0 });
  } finally {
    server.close();
  }
});

test('GET /api/groups with no groups configured returns {}', async () => {
  const cfg = { ...serverConfig };
  delete cfg.groups;
  const reg = new Registry(cfg, apps);
  const server = startServer(reg, 0, { getConfig: () => cfg, onShutdown: () => {} });
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  } finally {
    server.close();
  }
});
