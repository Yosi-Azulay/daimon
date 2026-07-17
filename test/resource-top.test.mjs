// M106 — `daimon top` / GET /api/top. Shape contract for the experimental
// surface: RSS-descending sort, nulls (never errors) for apps whose first
// usage reading hasn't arrived, stopped apps excluded. Module-level against
// synthetic state, per the repo convention — no real daemon, no real pids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-top-'));
process.env.DAIMON_HOME = fakeHome;

const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');

const config = {
  searchRoots: [], portRange: [4000, 4099], apiPort: 0,
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
};
const apps = ['fat', 'thin', 'fresh', 'idle'].map(name => ({
  name, baseName: name, workspaceRoot: fakeHome, workspaceType: 'polyglot',
  command: 'noop', hidden: false, tags: [],
}));

async function getJson(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

test('GET /api/top: rss-descending live table; nulls for missing readings; stopped apps excluded', async () => {
  const reg = new Registry(config, apps);
  const now = Date.now();
  // Two live apps with readings, one running app the poll hasn't reached,
  // one stopped app that must not appear.
  Object.assign(reg.getState('fat'), { pid: 1111, status: 'serving', startedAt: now - 60_000, memMB: 512, cpu: 3.5 });
  Object.assign(reg.getState('thin'), { pid: 2222, status: 'serving', startedAt: now - 120_000, memMB: 128, cpu: 12 });
  Object.assign(reg.getState('fresh'), { pid: 3333, status: 'starting', startedAt: now - 1_000 });
  const server = startServer(reg, 0, { getConfig: () => config });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { status, body } = await getJson(base, '/api/top');
    assert.equal(status, 200);
    assert.ok(Number.isFinite(body.ts));
    assert.deepEqual(body.apps.map(a => a.name), ['fat', 'thin', 'fresh'],
      'sorted by rssMB descending, reading-less apps last, stopped apps excluded');

    const fat = body.apps[0];
    assert.deepEqual(Object.keys(fat).sort(), ['cpu', 'name', 'pid', 'rssMB', 'status', 'uptimeMs'],
      'the row shape is exactly {name,pid,rssMB,cpu,uptimeMs,status}');
    assert.equal(fat.pid, 1111);
    assert.equal(fat.rssMB, 512);
    assert.equal(fat.cpu, 3.5);
    assert.ok(fat.uptimeMs >= 55_000, 'uptime derives from startedAt');
    assert.equal(fat.status, 'serving');

    const fresh = body.apps[2];
    assert.equal(fresh.rssMB, null, 'no reading → null, never an error');
    assert.equal(fresh.cpu, null);
    assert.equal(fresh.status, 'starting');
  } finally {
    server.close();
  }
});

test('GET /api/top with nothing running: empty apps array, still 200', async () => {
  const reg = new Registry(config, apps);
  const server = startServer(reg, 0, { getConfig: () => config });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { status, body } = await getJson(base, '/api/top');
    assert.equal(status, 200);
    assert.deepEqual(body.apps, []);
  } finally {
    server.close();
  }
});

test('cliSurface declares `top` as experimental with --json and stdExit', async () => {
  const { CLI_SUBCOMMANDS } = await import('../dist/cliSurface.js');
  const top = CLI_SUBCOMMANDS.find(c => c.name === 'top');
  assert.ok(top, '`top` is declared in cliSurface');
  assert.equal(top.stability, 'experimental');
  assert.equal(top.needsDaemon, true);
  assert.ok(top.options.some(o => o.flag === '--json'));
  assert.deepEqual(top.exitCodes.map(e => e.code), [0, 1]);
});

test('httpSurface declares GET /api/top as experimental', async () => {
  const { HTTP_ENDPOINTS } = await import('../dist/httpSurface.js');
  const row = HTTP_ENDPOINTS.find(e => e.path === '/api/top');
  assert.ok(row, '/api/top is catalogued');
  assert.equal(row.method, 'GET');
  assert.equal(row.stability, 'experimental');
});
