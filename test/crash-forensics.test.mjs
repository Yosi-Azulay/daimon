import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M76 — crash forensics: crash ring buffer, restart-storm events, doctor
// rules, and the `GET /api/why/<app>` composition.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-crash-'));

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { runDoctor, suspiciousRootReason } = await import('../dist/doctor.js');

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [4210, 4290], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: path.join(tmp, 'history.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 }, restartStorm: { perHour: 20 },
    ...overrides,
  };
}

test('crash ring: never exceeds 10 rows per app, keeps the newest', () => {
  const h = new History({ enabled: true, path: path.join(tmp, 'ring.db'), retentionDays: 7 });
  for (let i = 1; i <= 13; i++) {
    h.recordCrash({ app: 'web', ts: 1000 + i, exitCode: i, signal: null, uptimeMs: i * 10, lastLines: [`line ${i}`], gitHead: null });
  }
  h.recordCrash({ app: 'other', ts: 5000, exitCode: 1, signal: null, uptimeMs: 5, lastLines: ['x'], gitHead: null });
  const rows = h.queryCrashes({ app: 'web', limit: 50 });
  assert.equal(rows.length, 10, 'ring caps at 10 per app');
  assert.equal(rows[0].exitCode, 13, 'newest kept');
  assert.equal(rows[9].exitCode, 4, 'oldest pruned');
  assert.equal(h.queryCrashes({ app: 'other', limit: 50 }).length, 1, 'other apps unaffected');
  h.close();
});

test('unrequested child exit persists a crash row with exit info + last lines', async () => {
  const cfg = baseCfg();
  const app = {
    name: 'crashy', baseName: 'crashy', workspaceRoot: tmp, workspaceType: 'polyglot',
    // Trailing `--` so the daemon-appended `--port N` lands in argv instead of
    // being parsed as a (bad) node option.
    command: `node -e "console.log('hello from child'); setTimeout(() => process.exit(3), 400)" --`,
    hidden: false, tags: [],
  };
  const reg = new Registry(cfg, [app]);
  const history = new History(cfg.history);
  reg.setHistory(history);
  const events = [];
  reg.on('event', ev => events.push(ev));
  const exited = new Promise(resolve => reg.once('childExit', resolve));
  const r = await reg.start('crashy');
  assert.equal(r.ok, true);
  await exited;
  // Crash row lands after the async gitHead probe — poll briefly.
  let row = null;
  for (let i = 0; i < 80 && !row; i++) {
    await new Promise(res => setTimeout(res, 100));
    row = history.queryCrashes({ app: 'crashy', limit: 1 })[0] ?? null;
  }
  assert.ok(row, 'crash row persisted');
  assert.equal(row.exitCode, 3);
  assert.ok(typeof row.uptimeMs === 'number' && row.uptimeMs >= 0);
  assert.ok((row.lastLines ?? '').includes('hello from child'), `lastLines carries the tail (got: ${row.lastLines})`);
  assert.ok(events.some(e => e.type === 'crash' && e.app === 'crashy'), 'crash event emitted');
  history.close();
});

test('user-requested stop does NOT record a crash', async () => {
  const cfg = baseCfg();
  const app = {
    name: 'longlived', baseName: 'longlived', workspaceRoot: tmp, workspaceType: 'polyglot',
    command: `node -e "console.log('up'); setTimeout(() => {}, 8000)" --`,
    hidden: false, tags: [],
  };
  const reg = new Registry(cfg, [app]);
  const history = new History({ enabled: true, path: path.join(tmp, 'stop.db'), retentionDays: 7 });
  reg.setHistory(history);
  await reg.start('longlived');
  await new Promise(res => setTimeout(res, 500));
  await reg.stop('longlived');
  await new Promise(res => setTimeout(res, 500));
  assert.equal(history.queryCrashes({ app: 'longlived', limit: 10 }).length, 0, 'requested stop is not a crash');
  history.close();
});

test('restart-storm: 21 exits in an hour fire exactly ONE event; re-arms after the window clears', () => {
  const cfg = baseCfg();
  const reg = new Registry(cfg, [{ name: 'stormy', baseName: 'stormy', workspaceRoot: tmp, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] }]);
  const storms = [];
  reg.on('event', ev => { if (ev.type === 'restart-storm') storms.push(ev); });
  const t0 = Date.now();
  for (let i = 0; i < 21; i++) reg.noteCrashForStorm('stormy', 1, t0 + i * 1000);
  assert.equal(storms.length, 1, 'exactly one storm event at threshold crossing');
  const payload = JSON.parse(storms[0].message);
  assert.equal(payload.count, 21);
  assert.equal(payload.lastExitCode, 1);
  assert.equal(payload.windowMs, 3600_000);
  // More crashes inside the same storm: still one event.
  for (let i = 21; i < 30; i++) reg.noteCrashForStorm('stormy', 1, t0 + i * 1000);
  assert.equal(storms.length, 1, 'no per-restart re-fire');
  const st = reg.stormState('stormy', t0 + 30_000);
  assert.equal(st.active, true);
  assert.equal(st.countLastHour, 30);
  // Window empties (an hour later, few crashes): storm clears, next burst re-fires.
  const t1 = t0 + 2 * 3600_000;
  reg.noteCrashForStorm('stormy', 2, t1);
  assert.equal(reg.stormState('stormy', t1).active, false, 'storm cleared once below threshold');
  for (let i = 1; i <= 21; i++) reg.noteCrashForStorm('stormy', 2, t1 + i * 1000);
  assert.equal(storms.length, 2, 'a fresh storm fires once more');
});

test('doctor: suspiciousRootReason flags drive roots, home, and system dirs — but not projects', () => {
  assert.ok(suspiciousRootReason(os.homedir()), 'home dir flagged');
  assert.ok(suspiciousRootReason(path.parse(process.cwd()).root), 'drive root flagged');
  if (process.platform === 'win32') {
    assert.ok(suspiciousRootReason('C:\\Windows\\System32'), 'system dir flagged');
  } else {
    assert.ok(suspiciousRootReason('/usr/lib'), 'system dir flagged');
  }
  assert.equal(suspiciousRootReason(tmp), null, 'a temp project dir is fine');
  assert.equal(suspiciousRootReason(path.join(os.homedir(), 'projects')), null, 'a folder under home is fine');
});

test('doctor: restart-storm rule surfaces stormy apps from the crashes table; hygiene is suggest-only', async () => {
  const dbPath = path.join(tmp, 'doctor.db');
  const h = new History({ enabled: true, path: dbPath, retentionDays: 7 });
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    // Ring keeps 10 rows but the doctor rule counts what's there vs threshold —
    // use a low threshold to stay observable through the ring.
    h.recordCrash({ app: 'stormy', ts: now - i * 1000, exitCode: 137, signal: null, uptimeMs: 100, lastLines: ['x'], gitHead: null });
  }
  h.close();
  const cfg = baseCfg({
    history: { enabled: true, path: dbPath, retentionDays: 7 },
    restartStorm: { perHour: 5 },
    searchRoots: [os.homedir()],
  });
  const result = await runDoctor(cfg, []);
  const storm = result.checks.find(c => c.name === 'restart-storm: stormy');
  assert.ok(storm, 'storm check present');
  assert.equal(storm.ok, false);
  assert.match(storm.detail, /top exit code 137/);
  assert.match(storm.detail, /daimon why stormy/);
  const hygiene = result.checks.find(c => c.name.startsWith('searchroot-hygiene:'));
  assert.ok(hygiene, 'hygiene check present');
  assert.equal(hygiene.ok, true, 'suggest-only: never fails doctor');
  assert.match(hygiene.detail, /consider narrowing/);
});

test('GET /api/why/<app>: every section populated on a seeded app', async () => {
  const dbPath = path.join(tmp, 'why.db');
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 7 }, restartStorm: { perHour: 3 } });
  const app = { name: 'web', baseName: 'web', workspaceRoot: process.cwd(), workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] };
  const reg = new Registry(cfg, [app]);
  const history = new History(cfg.history);
  reg.setHistory(history);

  // Seed: a crash, in-memory errors, a regression event, an active storm.
  history.recordCrash({ app: 'web', ts: Date.now(), exitCode: 137, signal: 'SIGKILL', uptimeMs: 4200, lastLines: ['boom', 'stack trace here'], gitHead: 'abc1234' });
  const state = reg.getState('web');
  state.errors.set('TypeError: x is not a function', {
    message: 'TypeError: x is not a function', count: 4, firstSeen: Date.now() - 60_000, lastSeen: Date.now(),
    parsed: { file: 'src/app.ts', line: 10, message: 'x is not a function' },
  });
  reg.recordEvent({ app: 'web', type: 'regression-detected', message: JSON.stringify({ kind: 'compile', factor: 2.5, baseline: 1000, current: 2500, suspectCommit: 'abc1234:msg' }) });
  history._flushForTest();
  for (let i = 0; i < 4; i++) reg.noteCrashForStorm('web', 137);

  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/why/web`);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.app, 'web');
    assert.equal(b.status.name, 'web');
    assert.equal(b.lastCrash.exitCode, 137);
    assert.equal(b.lastCrash.signal, 'SIGKILL');
    assert.deepEqual(b.lastCrash.lastLines, ['boom', 'stack trace here']);
    assert.equal(b.errorGroups.length, 1);
    assert.equal(b.errorGroups[0].count, 4);
    assert.equal(b.regressions.length, 1);
    assert.equal(b.regressions[0].kind, 'compile');
    assert.equal(b.storm.active, true);
    assert.equal(b.storm.lastExitCode, 137);
    // Repo cwd is a git checkout — suspect commit usually resolves
    // "<sha>:<subject>", but the probe has a hard 1.5s budget and may return
    // null on a loaded machine. Assert the section + shape, not git's timing.
    assert.ok('suspectCommit' in b, 'suspectCommit section present');
    if (b.suspectCommit != null) assert.match(b.suspectCommit, /:/);
    assert.ok(Array.isArray(b.doctor));
    const unknown = await fetch(`${base}/api/why/nope`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    history.close();
  }
});

test('cleanup tmp', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
