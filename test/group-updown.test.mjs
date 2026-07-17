import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// `daimon up <group>` / `stop <group>` (M94, v1.1): depends-aware topo start
// order, readiness summary + exit codes, reverse-order stop, app-name
// precedence on the frozen stop verb, per-member soft-lock gating, and
// unchanged legacy-profile behavior — against a real startServer() over a
// fake (duck-typed) Registry that records call order.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-groupud-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { startServer } = await import('../dist/server.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

// ---------------------------------------------------------------------------
// Fake registry: only the methods the exercised routes touch. `calls` records
// every start/stop in order so ordering asserts are exact.

function makeFakeRegistry(appNames, opts = {}) {
  const ee = new EventEmitter();
  const states = new Map();
  for (const n of appNames) {
    states.set(n, { status: opts.initial?.[n]?.status ?? 'stopped', health: opts.initial?.[n]?.health ?? 'unknown' });
  }
  const calls = [];
  const summaryOf = (n) => {
    const s = states.get(n);
    if (!s) return null;
    return {
      name: n, baseName: n, status: s.status, health: s.health, port: null, url: null,
      errorCount: 0, uptimeMs: null, lastCompileMs: null, lastHealthAt: null, cpu: null,
      memMB: null, compileHistoryMs: [], tags: [], restartAttempts: 0, nextRestartAt: null,
      announcedUrl: null, lastHealthError: null, stale: false, bundle: null,
      bundleRegressionPct: null, dependsOn: [], activeEnvFile: null,
      workspaceLabel: 'main', workspaceRoot: fakeHome, lastChangeMs: null,
    };
  };
  const reg = {
    calls,
    _states: states,
    names: () => [...states.keys()],
    list: () => [...states.keys()].map(summaryOf),
    summary: summaryOf,
    getApp: (n) => (states.has(n) ? { name: n, workspaceRoot: fakeHome } : null),
    resolveByCwd: (n) => (states.has(n) ? { kind: 'unique', key: n } : { kind: 'none' }),
    on: (ev, fn) => ee.on(ev, fn),
    off: (ev, fn) => ee.off(ev, fn),
    start: async (n) => {
      calls.push(`start:${n}`);
      const s = states.get(n);
      if (!s) return { ok: false, status: 'unknown' };
      const target = opts.startWillReach?.[n] ?? { status: 'serving', health: 'healthy' };
      setTimeout(() => { Object.assign(s, target); ee.emit('change'); }, 5);
      return { ok: true, status: 'starting' };
    },
    startWithDeps: async (n) => {
      calls.push(`startWithDeps:${n}`);
      const s = states.get(n);
      if (!s) return { ok: false, results: [] };
      setTimeout(() => { Object.assign(s, { status: 'serving', health: 'healthy' }); ee.emit('change'); }, 5);
      return { ok: true, results: [{ name: n, status: 'starting', health: 'unknown' }] };
    },
    stop: async (n) => {
      calls.push(`stop:${n}`);
      const s = states.get(n);
      if (!s) return { ok: false, status: 'unknown' };
      setTimeout(() => { Object.assign(s, { status: 'stopped', health: 'unknown' }); ee.emit('change'); }, 5);
      return { ok: true, status: 'stopped' };
    },
    waitFor: (name, until, timeoutMs) => new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        const s = states.get(name);
        if (!s) return false;
        if (until === 'serving' && s.status === 'serving') return true;
        if (until === 'healthy' && s.status === 'serving' && s.health === 'healthy') return true;
        if (until === 'stopped' && s.status === 'stopped') return true;
        return false;
      };
      const done = (timedOut) => {
        ee.off('change', onChange);
        clearTimeout(timer);
        const s = states.get(name);
        resolve({ name, status: s?.status ?? 'unknown', health: s?.health ?? 'unknown', timedOut, waitedMs: Date.now() - start });
      };
      const onChange = () => { if (check()) done(false); };
      if (check()) {
        const s = states.get(name);
        resolve({ name, status: s?.status ?? 'unknown', health: s?.health ?? 'unknown', timedOut: false, waitedMs: 0 });
        return;
      }
      const timer = setTimeout(() => done(true), timeoutMs);
      ee.on('change', onChange);
    }),
    errors: () => [],
    events: () => [],
    getHistory: () => null,
  };
  return reg;
}

function baseConfig(overrides = {}) {
  return {
    searchRoots: [], portRange: [4210, 4260], apiPort: 0,
    overrides: {}, autoStart: [], profiles: {}, tags: {},
    autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    ...overrides,
  };
}

async function listen(reg, config) {
  const server = startServer(reg, 0, { getConfig: () => config, onShutdown: () => {} });
  await new Promise(r => server.on('listening', r));
  return { server, port: server.address().port };
}

function cli(args, { port, cwd }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: cwd ?? fakeHome,
      env: { ...process.env, DAIMON_HOME: fakeHome, DAIMON_NO_SPAWN: '1', DAIMON_PORT: String(port), NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 20_000);
    child.on('close', code => {
      clearTimeout(killer);
      let body = null;
      try { body = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch {}
      resolve({ code, body, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP: /api/groups/:name/up

test('group up starts the depends closure in topo order and reports all healthy', async () => {
  const reg = makeFakeRegistry(['web', 'admin', 'api']);
  const config = baseConfig({
    groups: { day: { apps: ['web', 'admin'], autoStart: false } },
    depends: { web: ['api'], admin: ['api'] },
  });
  const { server, port } = await listen(reg, config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/day/up?timeoutMs=5000`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    // api is a dependency of both members: it joins the plan and starts first.
    const startOrder = reg.calls.filter(c => c.startsWith('start:'));
    assert.equal(startOrder[0], 'start:api', `api first, got ${startOrder}`);
    assert.equal(startOrder.length, 3);
    assert.equal(body.group, 'day');
    assert.equal(body.total, 3);
    assert.equal(body.healthy, 3);
    assert.equal(body.summary, '3/3 healthy');
    assert.equal(body.allReached, true);
    assert.equal(body.apps[0].name, 'api', 'response rows follow the plan order');
    // healthProbe disabled → until degrades to serving, like ensure-up.
    assert.equal(body.until, 'serving');
  } finally {
    server.close();
  }
});

test('one member failing → "2/3 healthy", allReached false', async () => {
  const reg = makeFakeRegistry(['web', 'admin', 'api'], {
    startWillReach: { admin: { status: 'error', health: 'unknown' } },
  });
  const config = baseConfig({
    groups: { day: { apps: ['web', 'admin', 'api'], autoStart: false } },
  });
  const { server, port } = await listen(reg, config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/day/up?timeoutMs=1500`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.summary, '2/3 healthy');
    assert.equal(body.allReached, false);
    const admin = body.apps.find(a => a.name === 'admin');
    assert.equal(admin.reached, false);
    assert.equal(admin.timedOut, true);
  } finally {
    server.close();
  }
});

test('unknown members are reported and skipped; the rest start', async () => {
  const reg = makeFakeRegistry(['web']);
  const config = baseConfig({ groups: { day: { apps: ['web', 'ghost'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/day/up?timeoutMs=3000`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.summary, '1/2 healthy');
    const ghost = body.apps.find(a => a.name === 'ghost');
    assert.equal(ghost.reached, false);
    assert.match(ghost.error, /unknown app/);
    assert.ok(reg.calls.includes('start:web'));
    assert.ok(!reg.calls.some(c => c.includes('ghost')));
  } finally {
    server.close();
  }
});

test('cyclic members are reported, not started', async () => {
  const reg = makeFakeRegistry(['a', 'b', 'c']);
  const config = baseConfig({
    groups: { g: { apps: ['a', 'b', 'c'], autoStart: false } },
    depends: { a: ['b'], b: ['a'] },
  });
  const { server, port } = await listen(reg, config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/g/up?timeoutMs=3000`, { method: 'POST' });
    const body = await res.json();
    const a = body.apps.find(x => x.name === 'a');
    assert.match(a.error, /dependency cycle/);
    assert.ok(!reg.calls.includes('start:a'));
    assert.ok(!reg.calls.includes('start:b'));
    assert.ok(reg.calls.includes('start:c'));
  } finally {
    server.close();
  }
});

test('unknown group → 404 naming the known groups', async () => {
  const reg = makeFakeRegistry(['web']);
  const config = baseConfig({ groups: { day: { apps: ['web'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/nope/up`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'unknown group');
    assert.deepEqual(body.known, ['day']);
    assert.ok(body.hint.includes('day'));
  } finally {
    server.close();
  }
});

test('lock-refused member counts unhealthy and never aborts the rest', async () => {
  const reg = makeFakeRegistry(['web', 'api']);
  const config = baseConfig({ groups: { day: { apps: ['web', 'api'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  try {
    // Agent A takes the soft-lock on web via a normal start.
    await fetch(`http://127.0.0.1:${port}/api/apps/web/start`, { method: 'POST', headers: { 'x-daimon-agent': 'agent-A' } });
    reg._states.get('web').status = 'stopped'; // so the group would try to start it
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/day/up?timeoutMs=3000`, { method: 'POST', headers: { 'x-daimon-agent': 'agent-B' } });
    const body = await res.json();
    const web = body.apps.find(a => a.name === 'web');
    assert.equal(web.reached, false);
    assert.equal(web.lockedBy, 'agent-A');
    assert.match(web.error, /steal=1/);
    const api = body.apps.find(a => a.name === 'api');
    assert.equal(api.reached, true, 'the unlocked member still started');
    assert.equal(body.summary, '1/2 healthy');
    // ?steal=1 overrides.
    const res2 = await fetch(`http://127.0.0.1:${port}/api/groups/day/up?timeoutMs=3000&steal=1`, { method: 'POST', headers: { 'x-daimon-agent': 'agent-B' } });
    const body2 = await res2.json();
    assert.equal(body2.allReached, true);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// HTTP: /api/groups/:name/stop

test('group stop stops members in reverse depends order, members only', async () => {
  const reg = makeFakeRegistry(['web', 'admin', 'api', 'shared-db'], {
    initial: {
      web: { status: 'serving', health: 'healthy' },
      admin: { status: 'serving', health: 'healthy' },
      api: { status: 'serving', health: 'healthy' },
      'shared-db': { status: 'serving', health: 'healthy' },
    },
  });
  const config = baseConfig({
    groups: { day: { apps: ['web', 'admin', 'api'], autoStart: false } },
    depends: { web: ['api'], admin: ['api'], api: ['shared-db'] },
  });
  const { server, port } = await listen(reg, config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/day/stop`, { method: 'POST' });
    const body = await res.json();
    const stops = reg.calls.filter(c => c.startsWith('stop:'));
    assert.equal(stops[stops.length - 1], 'stop:api', 'the dependency stops last');
    assert.ok(!stops.includes('stop:shared-db'), 'external deps are never stopped implicitly');
    assert.equal(body.summary, '3/3 stopped');
    assert.equal(body.allStopped, true);
  } finally {
    server.close();
  }
});

test('already-stopped members are no-ops in the stop summary', async () => {
  const reg = makeFakeRegistry(['web', 'api'], {
    initial: { web: { status: 'serving', health: 'healthy' } },
  });
  const config = baseConfig({ groups: { day: { apps: ['web', 'api'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/day/stop`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.allStopped, true);
    assert.ok(!reg.calls.includes('stop:api'), 'stopped member never gets a stop call');
    assert.ok(reg.calls.includes('stop:web'));
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// CLI: up/down/stop with groups

function writeConfig(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'daimon.config.json'), JSON.stringify(cfg), 'utf8');
}

test('CLI: daimon up <group> exits 0 and prints the readiness summary', async () => {
  const reg = makeFakeRegistry(['web', 'api']);
  const config = baseConfig({ groups: { day: { apps: ['web', 'api'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-cliup-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web', 'api'] } });
  try {
    const r = await cli(['up', 'day', '--timeout', '5s'], { port, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.body?.group, 'day');
    assert.equal(r.body?.allReached, true);
    assert.equal(r.body?.summary, '2/2 healthy');
  } finally {
    server.close();
  }
});

test('CLI: daimon up <group> exits 2 when a member misses the target', async () => {
  const reg = makeFakeRegistry(['web', 'api'], {
    startWillReach: { api: { status: 'error', health: 'unknown' } },
  });
  const config = baseConfig({ groups: { day: { apps: ['web', 'api'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-cliup2-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web', 'api'] } });
  try {
    const r = await cli(['up', 'day', '--timeout', '2s'], { port, cwd: dir });
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.body?.allReached, false);
  } finally {
    server.close();
  }
});

test('CLI: group wins over a legacy profile with the same name', async () => {
  const reg = makeFakeRegistry(['web', 'api', 'other']);
  const config = baseConfig({
    groups: { day: { apps: ['web'], autoStart: false } },
    profiles: { day: ['other'] },
  });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-cliup3-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web'] }, profiles: { day: ['other'] } });
  try {
    const r = await cli(['up', 'day', '--timeout', '5s'], { port, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(reg.calls.includes('start:web'), `group member started: ${reg.calls}`);
    assert.ok(!reg.calls.some(c => c.includes('other')), `profile member untouched: ${reg.calls}`);
  } finally {
    server.close();
  }
});

test('CLI: legacy profile up output is unchanged (array of {name,status,health})', async () => {
  const reg = makeFakeRegistry(['web', 'api']);
  const config = baseConfig({ profiles: { legacy: ['web', 'api'] } });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-cliup4-'));
  writeConfig(dir, { searchRoots: [], profiles: { legacy: ['web', 'api'] } });
  try {
    const r = await cli(['up', 'legacy'], { port, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Array.isArray(r.body), `legacy shape is a bare array, got ${r.stdout}`);
    for (const row of r.body) {
      assert.deepEqual(Object.keys(row).sort(), ['health', 'name', 'status'], 'legacy row shape untouched');
    }
    assert.ok(reg.calls.includes('startWithDeps:web'), `legacy path uses start?withDeps=1: ${reg.calls}`);
  } finally {
    server.close();
  }
});

test('CLI: stop prefers the app when an app and a group share the name', async () => {
  const reg = makeFakeRegistry(['day', 'web'], {
    initial: { day: { status: 'serving', health: 'healthy' }, web: { status: 'serving', health: 'healthy' } },
  });
  const config = baseConfig({ groups: { day: { apps: ['web'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-clistop-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web'] } });
  try {
    const r = await cli(['stop', 'day'], { port, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(reg.calls.filter(c => c.startsWith('stop:')), ['stop:day'], 'only the app stops — never the group members');
  } finally {
    server.close();
  }
});

test('CLI: stop falls back to the group when no app matches', async () => {
  const reg = makeFakeRegistry(['web', 'api'], {
    initial: { web: { status: 'serving', health: 'healthy' }, api: { status: 'serving', health: 'healthy' } },
  });
  const config = baseConfig({
    groups: { day: { apps: ['web', 'api'], autoStart: false } },
    depends: { web: ['api'] },
  });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-clistop2-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web', 'api'] }, depends: { web: ['api'] } });
  try {
    const r = await cli(['stop', 'day'], { port, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.body?.group, 'day');
    assert.equal(r.body?.allStopped, true);
    const stops = reg.calls.filter(c => c.startsWith('stop:'));
    assert.deepEqual(stops, ['stop:web', 'stop:api'], 'reverse depends order');
  } finally {
    server.close();
  }
});

test('CLI: group stop with a lock-blocked member exits 5 (review finding)', async () => {
  const reg = makeFakeRegistry(['web', 'api'], {
    initial: { web: { status: 'serving', health: 'healthy' }, api: { status: 'serving', health: 'healthy' } },
  });
  const config = baseConfig({ groups: { day: { apps: ['web', 'api'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-clistop5-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web', 'api'] } });
  try {
    // Another agent locks 'web'; the group stop must surface it as exit 5.
    await fetch(`http://127.0.0.1:${port}/api/apps/web/restart`, { method: 'POST', headers: { 'x-daimon-agent': 'agent-A' } });
    reg._states.get('web').status = 'serving';
    const r = await cli(['stop', 'day'], { port, cwd: dir });
    assert.equal(r.code, 5, `exit 5 on locked member: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /locked by agent agent-A/);
    assert.match(r.stderr, /--steal/);
  } finally {
    server.close();
  }
});

test('CLI: down <group> exits 1 when a member stays running (review finding)', async () => {
  const reg = makeFakeRegistry(['web', 'api'], {
    initial: { web: { status: 'serving', health: 'healthy' }, api: { status: 'serving', health: 'healthy' } },
  });
  const config = baseConfig({ groups: { day: { apps: ['web', 'api'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-clidown1-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web', 'api'] } });
  try {
    await fetch(`http://127.0.0.1:${port}/api/apps/api/restart`, { method: 'POST', headers: { 'x-daimon-agent': 'agent-A' } });
    reg._states.get('api').status = 'serving';
    const r = await cli(['down', 'day'], { port, cwd: dir });
    assert.equal(r.code, 1, `exit 1 when allStopped=false: ${r.stdout} ${r.stderr}`);
    assert.equal(r.body?.allStopped, false);
  } finally {
    server.close();
  }
});

test('CLI: stop of a name that is neither app nor group errors like before', async () => {
  const reg = makeFakeRegistry(['web']);
  const config = baseConfig({});
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-clistop3-'));
  writeConfig(dir, { searchRoots: [] });
  try {
    const r = await cli(['stop', 'ghost'], { port, cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown app/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// MCP (M98): ensure_up resolves groups first; stop_app falls back to the
// group only on unknown app; daimon_groups enumerates. Same fake daemon.

async function mcpClient() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { buildServer } = await import('../dist/mcp.js');
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'group-updown-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function mcpJson(result) {
  return JSON.parse(result.content[0].text);
}

test('MCP: ensure_up resolves a group first, profile fallback intact', async () => {
  const reg = makeFakeRegistry(['web', 'api', 'other']);
  const config = baseConfig({
    groups: { day: { apps: ['web'], autoStart: false } },
    profiles: { day: ['other'], legacy: ['api'] },
  });
  const { server, port } = await listen(reg, config);
  process.env.DAIMON_PORT = String(port);
  try {
    const client = await mcpClient();
    const viaGroup = mcpJson(await client.callTool({ name: 'ensure_up', arguments: { profile: 'day', timeoutMs: 5000 } }));
    assert.equal(viaGroup.group, 'day', 'group summary shape (group wins the collision)');
    assert.equal(viaGroup.allReached, true);
    assert.ok(!reg.calls.some(c => c.includes('other')), 'profile of the same name untouched');
    const viaProfile = mcpJson(await client.callTool({ name: 'ensure_up', arguments: { profile: 'legacy', timeoutMs: 5000 } }));
    assert.equal(viaProfile.profile, 'legacy', 'legacy profile shape unchanged');
    assert.ok(Array.isArray(viaProfile.apps));
  } finally {
    delete process.env.DAIMON_PORT;
    server.close();
  }
});

test('MCP: stop_app prefers the app; group only where the app 404s', async () => {
  const reg = makeFakeRegistry(['day', 'web', 'api'], {
    initial: {
      day: { status: 'serving', health: 'healthy' },
      web: { status: 'serving', health: 'healthy' },
      api: { status: 'serving', health: 'healthy' },
    },
  });
  const config = baseConfig({ groups: { day: { apps: ['web'], autoStart: false }, all: { apps: ['web', 'api'], autoStart: false } } });
  const { server, port } = await listen(reg, config);
  process.env.DAIMON_PORT = String(port);
  try {
    const client = await mcpClient();
    mcpJson(await client.callTool({ name: 'stop_app', arguments: { name: 'day' } }));
    assert.deepEqual(reg.calls.filter(c => c.startsWith('stop:')), ['stop:day'], 'app-name precedence');
    const viaGroup = mcpJson(await client.callTool({ name: 'stop_app', arguments: { name: 'all' } }));
    assert.equal(viaGroup.group, 'all');
    assert.equal(viaGroup.allStopped, true);
  } finally {
    delete process.env.DAIMON_PORT;
    server.close();
  }
});

test('MCP: daimon_groups returns the group map', async () => {
  const reg = makeFakeRegistry(['web']);
  const config = baseConfig({ groups: { day: { apps: ['web'], autoStart: true } } });
  const { server, port } = await listen(reg, config);
  process.env.DAIMON_PORT = String(port);
  try {
    const client = await mcpClient();
    const groups = mcpJson(await client.callTool({ name: 'daimon_groups', arguments: {} }));
    assert.deepEqual(Object.keys(groups), ['day']);
    assert.equal(groups.day.autoStart, true);
    assert.equal(groups.day.total, 1);
  } finally {
    delete process.env.DAIMON_PORT;
    server.close();
  }
});

test('CLI: daimon down <group> stops the group members', async () => {
  const reg = makeFakeRegistry(['web', 'api'], {
    initial: { web: { status: 'serving', health: 'healthy' }, api: { status: 'serving', health: 'healthy' } },
  });
  const config = baseConfig({ groups: { day: { apps: ['web', 'api'], autoStart: false } }, depends: { web: ['api'] } });
  const { server, port } = await listen(reg, config);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-clidown-'));
  writeConfig(dir, { searchRoots: [], groups: { day: ['web', 'api'] }, depends: { web: ['api'] } });
  try {
    const r = await cli(['down', 'day'], { port, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.body?.allStopped, true);
    assert.deepEqual(reg.calls.filter(c => c.startsWith('stop:')), ['stop:web', 'stop:api']);
  } finally {
    server.close();
  }
});
