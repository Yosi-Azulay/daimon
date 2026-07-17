import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// `--group <g>` read filters (M95, v1.1): /api/apps, /api/errors, /api/report
// gain ?group=; /api/groups/:name/{status,logs} serve the per-group views.
// Every filter is additive — absent flag/param → byte-identical output — and
// an unknown group errors naming the valid ones (M90 remedy rule).

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-gfilters-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { startServer } = await import('../dist/server.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

const now = Date.now();

function makeFakeRegistry() {
  const ee = new EventEmitter();
  const apps = {
    web: {
      status: 'serving', health: 'healthy',
      errors: [{ message: 'web boom', count: 1, firstSeen: now - 1000, lastSeen: now - 500, level: 'error' }],
      logBuffer: [{ ts: now - 3000, line: 'web line one' }, { ts: now - 1000, line: 'web ERROR two' }],
    },
    api: {
      status: 'serving', health: 'healthy',
      errors: [{ message: 'api boom', count: 2, firstSeen: now - 900, lastSeen: now - 400, level: 'error' }],
      logBuffer: [{ ts: now - 2000, line: 'api line one' }],
    },
    other: {
      status: 'stopped', health: 'unknown',
      errors: [{ message: 'other boom', count: 1, firstSeen: now - 800, lastSeen: now - 300, level: 'error' }],
      logBuffer: [{ ts: now - 1500, line: 'other line one' }],
    },
  };
  const summaryOf = (n) => {
    const a = apps[n];
    if (!a) return null;
    return {
      name: n, baseName: n, status: a.status, health: a.health, port: null, url: null,
      errorCount: a.errors.length, uptimeMs: null, lastCompileMs: null, lastHealthAt: null,
      cpu: null, memMB: null, compileHistoryMs: [], tags: [], restartAttempts: 0,
      nextRestartAt: null, announcedUrl: null, lastHealthError: null, stale: false,
      bundle: null, bundleRegressionPct: null, dependsOn: [], activeEnvFile: null,
      workspaceLabel: 'main', workspaceRoot: fakeHome, lastChangeMs: null,
    };
  };
  return {
    names: () => Object.keys(apps),
    list: () => Object.keys(apps).map(summaryOf),
    summary: summaryOf,
    getApp: (n) => (apps[n] ? { name: n, workspaceRoot: fakeHome } : null),
    getState: (n) => (apps[n] ? { logBuffer: apps[n].logBuffer } : null),
    resolveByCwd: (n) => (apps[n] ? { kind: 'unique', key: n } : { kind: 'none' }),
    errors: (n) => apps[n]?.errors ?? [],
    events: () => [],
    on: (e, f) => ee.on(e, f),
    off: (e, f) => ee.off(e, f),
    getHistory: () => null,
  };
}

const config = {
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
  groups: { day: { apps: ['web', 'api'], autoStart: false } },
};

const reg = makeFakeRegistry();
const server = startServer(reg, 0, { getConfig: () => config, onShutdown: () => {} });
await new Promise(r => server.on('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

function cli(args, cwd) {
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

const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-gfilters-cli-'));
fs.writeFileSync(path.join(cliDir, 'daimon.config.json'), JSON.stringify({
  searchRoots: [],
  groups: { day: ['web', 'api'] },
}), 'utf8');

// ---------------------------------------------------------------------------
// /api/apps ?group=

test('GET /api/apps?group= filters to members; shape identical to unfiltered rows', async () => {
  const unfiltered = await (await fetch(`${base}/api/apps`)).json();
  const filtered = await (await fetch(`${base}/api/apps?group=day`)).json();
  assert.equal(unfiltered.length, 3);
  assert.deepEqual(filtered.map(a => a.name).sort(), ['api', 'web'], 'manual set intersection');
  const wanted = new Set(['web', 'api']);
  const manual = unfiltered.filter(a => wanted.has(a.name));
  assert.deepEqual(filtered, manual, 'filtered = unfiltered ∩ members, row-for-row');
});

test('GET /api/apps?group=unknown → 400 naming the valid groups', async () => {
  const res = await fetch(`${base}/api/apps?group=nope`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown group/);
  assert.deepEqual(body.known, ['day']);
  assert.match(body.hint, /day/);
});

// ---------------------------------------------------------------------------
// /api/errors ?group=

test('GET /api/errors?group=day filters member errors; absent param unchanged; fingerprint keeps grouping', async () => {
  const flat = await (await fetch(`${base}/api/errors`)).json();
  assert.deepEqual(flat.map(e => e.app).sort(), ['api', 'other', 'web'], 'unfiltered shape untouched');
  const filtered = await (await fetch(`${base}/api/errors?group=day`)).json();
  assert.deepEqual(filtered.map(e => e.app).sort(), ['api', 'web']);
  const manual = flat.filter(e => e.app === 'web' || e.app === 'api');
  assert.deepEqual(filtered, manual, 'filtered = unfiltered ∩ members');
  const grouped = await (await fetch(`${base}/api/errors?group=fingerprint`)).json();
  assert.ok(Array.isArray(grouped.groups), 'group=fingerprint keeps its historical meaning');
});

test('GET /api/errors?group=unknown → 400 with the known groups', async () => {
  const res = await fetch(`${base}/api/errors?group=nope`);
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).known, ['day']);
});

// ---------------------------------------------------------------------------
// /api/report ?group=

test('GET /api/report?group= names the group; unscoped stays null', async () => {
  // Section-level scoping is proven in report.test.mjs against a seeded
  // History; this fake registry has none, so assert the wiring only.
  const r = await (await fetch(`${base}/api/report?group=day`)).json();
  assert.equal(r.group, 'day');
  const unscoped = await (await fetch(`${base}/api/report`)).json();
  assert.equal(unscoped.group, null);
});

test('report md header names the group', async () => {
  const md = await (await fetch(`${base}/api/report?group=day&md=1`)).text();
  assert.match(md.split('\n')[0], /group `day`/);
});

test('GET /api/report?group=unknown → 400', async () => {
  const res = await fetch(`${base}/api/report?group=nope`);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// /api/groups/:name/status + /logs

test('GET /api/groups/:name/status returns per-member compact statuses + summary', async () => {
  const r = await (await fetch(`${base}/api/groups/day/status`)).json();
  assert.equal(r.group, 'day');
  assert.equal(r.total, 2);
  assert.deepEqual(r.apps.map(a => a.name), ['web', 'api'], 'member order');
  assert.equal(r.summary, `${r.healthy}/2 healthy`);
});

test('GET /api/groups/:name/logs merges member tails by ts with app attribution', async () => {
  const r = await (await fetch(`${base}/api/groups/day/logs`)).json();
  assert.equal(r.group, 'day');
  assert.deepEqual(r.lines.map(l => l.app), ['web', 'api', 'web'], 'ts-sorted merge');
  for (const l of r.lines) {
    assert.equal(typeof l.ts, 'number');
    assert.equal(typeof l.line, 'string');
  }
  const grepped = await (await fetch(`${base}/api/groups/day/logs?grep=ERROR`)).json();
  assert.deepEqual(grepped.lines.map(l => l.line), ['web ERROR two']);
  const tailed = await (await fetch(`${base}/api/groups/day/logs?tail=1`)).json();
  assert.equal(tailed.lines.length, 1);
  assert.equal(tailed.lines[0].line, 'web ERROR two', 'tail keeps the newest');
});

test('GET /api/groups/:name/{status,logs} on unknown group → 404 with known names', async () => {
  for (const view of ['status', 'logs']) {
    const res = await fetch(`${base}/api/groups/nope/${view}`);
    assert.equal(res.status, 404);
    assert.deepEqual((await res.json()).known, ['day']);
  }
});

// ---------------------------------------------------------------------------
// CLI

test('CLI: daimon list --group day filters; row shape unchanged', async () => {
  const all = await cli(['list', '--all'], cliDir);
  const grouped = await cli(['list', '--group', 'day'], cliDir);
  assert.equal(grouped.code, 0, grouped.stderr);
  assert.deepEqual(grouped.body.map(a => a.name).sort(), ['api', 'web']);
  const wanted = new Set(['web', 'api']);
  assert.deepEqual(grouped.body, all.body.filter(a => wanted.has(a.name)));
});

test('CLI: unknown group exits 1 listing the valid names', async () => {
  const r = await cli(['list', '--group', 'nope'], cliDir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown group/);
  assert.match(r.stderr, /day/);
});

test('CLI: daimon status --group day returns the group status view', async () => {
  const r = await cli(['status', '--group', 'day'], cliDir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.body.group, 'day');
  assert.deepEqual(r.body.apps.map(a => a.name), ['web', 'api']);
});

test('CLI: status with both a name and --group fails with usage', async () => {
  const r = await cli(['status', 'web', '--group', 'day'], cliDir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /either an app name or --group/);
});

test('CLI: daimon logs --group day returns the merged tail', async () => {
  const r = await cli(['logs', '--group', 'day'], cliDir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.body.lines.length, 3);
  assert.equal(r.body.lines[0].app, 'web');
});

test('CLI: daimon errors --group day filters; bare --group keeps fingerprint grouping', async () => {
  const filtered = await cli(['errors', '--group', 'day'], cliDir);
  assert.equal(filtered.code, 0, filtered.stderr);
  assert.deepEqual(filtered.body.map(e => e.app).sort(), ['api', 'web']);
  const grouped = await cli(['errors', '--group'], cliDir);
  assert.equal(grouped.code, 0, grouped.stderr);
  assert.ok(Array.isArray(grouped.body.groups), `bare --group unchanged: ${grouped.stdout}`);
});

test('CLI: daimon report --group day carries the group in the header', async () => {
  const r = await cli(['report', '--group', 'day'], cliDir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.body.group, 'day');
});

// ---------------------------------------------------------------------------
// Frozen-verb guard (review finding): with NO groups configured, the v0.14
// parse of `--group <token>` (token = positional, flag = bare boolean) is
// restored byte-for-byte — defining groups is the opt-in to the value form.

const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-gfilters-legacy-'));
fs.writeFileSync(path.join(legacyDir, 'daimon.config.json'), JSON.stringify({ searchRoots: [] }), 'utf8');

test('CLI: no groups configured → list --group <x> ignores it like v0.14', async () => {
  // --all keeps v0.14's cwd scoping out of the comparison; the point is that
  // the --group token falls back to a (list-ignored) positional.
  const r = await cli(['list', '--group', 'web', '--all'], legacyDir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.body.length, 3, 'unfiltered — the token fell back to a (list-ignored) positional');
});

test('CLI: no groups configured → errors --group <app> means that app, like v0.14', async () => {
  const r = await cli(['errors', '--group', 'web'], legacyDir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Array.isArray(r.body), `per-app errors for 'web': ${r.stdout}`);
  assert.ok(r.body.some(e => e.message === 'web boom'), `web's errors returned: ${r.stdout}`);
});

test('CLI: no groups configured → status --group <app> shows the app, like v0.14', async () => {
  const r = await cli(['status', '--group', 'web'], legacyDir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.body.name, 'web');
});
