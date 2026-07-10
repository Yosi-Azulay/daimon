import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M74 — `POST /api/apps/<name>/test` end-to-end against the live HTTP server:
// soft-lock gating (409 for a second agent), run recording, GET /api/tests,
// timeout (tree-kill + timedOut:true), and the unresolvable-runner shape.

// Isolate ~/.daimon (audit.log writes) via DAIMON_HOME (M79) — no
// HOME/USERPROFILE games.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-testverb-'));
process.env.DAIMON_HOME = fakeHome;

const { lockPath } = await import('../dist/daemon.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { History } = await import('../dist/history.js');
const { WebhookDispatcher } = await import('../dist/webhooks.js');
const http = await import('node:http');

if (!lockPath().startsWith(fakeHome)) {
  test('test-verb http tests cannot isolate ~/.daimon on this OS — skipping', () => {});
} else {
  // A fake "runner": prints jest-shaped output after a delay, so a second
  // agent can contend the lock while the suite is "running".
  const slowScript = path.join(fakeHome, 'fake-jest.mjs');
  fs.writeFileSync(slowScript, `
setTimeout(() => {
  console.log('FAIL src/calc.test.ts');
  console.log('  ● calc › multiplies');
  console.log('');
  console.log('    expect(received).toBe(expected)');
  console.log('');
  console.log('      at Object.<anonymous> (src/calc.test.ts:7:19)');
  console.log('Tests:       1 failed, 1 passed, 2 total');
  console.log('Time:        0.1 s');
  process.exit(1);
}, 700);
`);
  const foreverScript = path.join(fakeHome, 'fake-hang.mjs');
  fs.writeFileSync(foreverScript, `setInterval(() => {}, 1000);\n`);

  const config = {
    searchRoots: [], portRange: [4000, 4099], apiPort: 0,
    overrides: {
      web: { testCommand: `node "${slowScript}"` },
      hang: { testCommand: `node "${foreverScript}"` },
    },
    autoStart: [], profiles: {}, tags: {},
    autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 },
  };
  const apps = [
    { name: 'web', baseName: 'web', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] },
    { name: 'hang', baseName: 'hang', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] },
    { name: 'norunner', baseName: 'norunner', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] },
  ];

  test('POST /test: lock-gated run records history; second agent gets 409; GET /api/tests returns the run', async () => {
    const reg = new Registry(config, apps);
    const history = new History(config.history);
    reg.setHistory(history);
    const events = [];
    reg.on('event', ev => events.push(ev));
    const server = startServer(reg, 0, { getConfig: () => config });
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;

      const first = fetch(`${base}/api/apps/web/test?timeoutMs=30000`, {
        method: 'POST', headers: { 'x-daimon-agent': 'agent-one-abcd' },
      });
      await new Promise(r => setTimeout(r, 200));
      const second = await fetch(`${base}/api/apps/web/test`, {
        method: 'POST', headers: { 'x-daimon-agent': 'agent-two-abcd' },
      });
      assert.equal(second.status, 409, 'concurrent test from another agent must 409');
      const blocked = await second.json();
      assert.equal(blocked.error, 'locked-by-other-agent');
      assert.equal(blocked.agent, 'agent-one-abcd');

      const r1 = await first;
      assert.equal(r1.status, 200);
      const body = await r1.json();
      assert.equal(body.exitCode, 1);
      assert.equal(body.totals.failed, 1);
      assert.equal(body.totals.total, 2);
      assert.equal(body.failures.length, 1);
      assert.equal(body.failures[0].file, 'src/calc.test.ts');
      assert.equal(body.failures[0].line, 7);
      assert.ok(typeof body.failures[0].fingerprint === 'string' && body.failures[0].fingerprint.length > 0);
      assert.ok(typeof body.runId === 'number', `run recorded (runId=${body.runId})`);

      // Same agent re-tests freely (lock is theirs), with steal for a third agent.
      const stolen = await fetch(`${base}/api/apps/web/test?steal=1&timeoutMs=30000`, {
        method: 'POST', headers: { 'x-daimon-agent': 'agent-three-abcd' },
      });
      assert.equal(stolen.status, 200);

      const list = await fetch(`${base}/api/tests?app=web`).then(r => r.json());
      assert.equal(list.runs.length, 2);
      assert.equal(list.runs[0].app, 'web');
      assert.equal(list.runs[0].failures.length, 1);
      assert.equal(list.runs[0].failures[0].test, 'multiplies');

      assert.ok(events.some(e => e.type === 'test-run'), 'test-run event emitted');
      assert.ok(events.some(e => e.type === 'test-failed'), 'test-failed event emitted for a failing run');
    } finally {
      await new Promise(resolve => server.close(resolve));
      history.close();
    }
  });

  test('POST /test: timeout tree-kills the runner and reports timedOut', async () => {
    const reg = new Registry(config, apps);
    const server = startServer(reg, 0, { getConfig: () => config });
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const t0 = Date.now();
      const r = await fetch(`${base}/api/apps/hang/test?timeoutMs=800`, {
        method: 'POST', headers: { 'x-daimon-agent': 'agent-timeout-abcd' },
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.timedOut, true);
      assert.ok(Date.now() - t0 < 15_000, 'timeout path returns promptly');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('POST /test: unresolvable runner returns { error, hint } with 422', async () => {
    const reg = new Registry(config, apps);
    const server = startServer(reg, 0, { getConfig: () => config });
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const r = await fetch(`${base}/api/apps/norunner/test`, {
        method: 'POST', headers: { 'x-daimon-agent': 'agent-nr-abcd' },
      });
      assert.equal(r.status, 422);
      const body = await r.json();
      assert.match(body.error, /no test runner resolved/);
      assert.match(body.hint, /testCommand/);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('flaky-test-detected fires exactly once per fingerprint for 3 same-head flips (M75)', () => {
    const reg = new Registry(config, apps);
    const history = new History({ enabled: true, path: path.join(fakeHome, 'flaky.db'), retentionDays: 7 });
    reg.setHistory(history);
    const flakyEvents = [];
    reg.on('event', ev => { if (ev.type === 'flaky-test-detected') flakyEvents.push(ev); });
    const fail = [{ suite: 's', test: 'flappy', file: 'a.ts', line: 5, message: 'boom', fingerprint: 'a.ts:5' }];
    // fail → pass → fail → pass at the same head = 3 flips.
    history.recordTestRun({ app: 'web', ts: 1, runner: 'vitest-jest', durationMs: 1, total: 1, passed: 0, failed: 1, skipped: 0, exitCode: 1, gitHead: 'headX' }, fail);
    history.recordTestRun({ app: 'web', ts: 2, runner: 'vitest-jest', durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, exitCode: 0, gitHead: 'headX' }, []);
    history.recordTestRun({ app: 'web', ts: 3, runner: 'vitest-jest', durationMs: 1, total: 1, passed: 0, failed: 1, skipped: 0, exitCode: 1, gitHead: 'headX' }, fail);
    history.recordTestRun({ app: 'web', ts: 4, runner: 'vitest-jest', durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, exitCode: 0, gitHead: 'headX' }, []);
    reg.checkFlakyTests('web', 'headX');
    reg.checkFlakyTests('web', 'headX'); // repeated runs must not re-fire
    assert.equal(flakyEvents.length, 1, 'exactly one flaky event per fingerprint');
    const payload = JSON.parse(flakyEvents[0].message);
    assert.equal(payload.fingerprint, 'a.ts:5');
    assert.equal(payload.test, 'flappy');
    assert.equal(payload.gitHead, 'headX');
    assert.ok(payload.flips >= 3);
    history.close();
  });

  test('webhook receives test-failed on a local http server (M75)', async () => {
    const received = [];
    const sink = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end('ok'); });
    });
    await new Promise(resolve => { sink.listen(0, '127.0.0.1', resolve); });
    const sinkUrl = `http://127.0.0.1:${sink.address().port}/hook`;
    const reg = new Registry(config, apps);
    const dispatcher = new WebhookDispatcher(reg, [{ url: sinkUrl, events: ['test-failed'] }]);
    try {
      reg.recordEvent({ app: 'web', type: 'status', from: 'stopped', to: 'starting' }); // filtered out
      reg.recordEvent({ app: 'web', type: 'test-failed', message: JSON.stringify({ app: 'web', runId: 1, failed: 2, total: 5 }) });
      for (let i = 0; i < 40 && received.length === 0; i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(received.length, 1, 'exactly the test-failed event delivered');
      assert.equal(received[0].event, 'test-failed');
      assert.equal(received[0].app, 'web');
      assert.match(received[0].message, /"failed":2/);
    } finally {
      dispatcher.stop();
      await new Promise(resolve => sink.close(resolve));
    }
  });

  test('cleanup: restore DAIMON_HOME', () => {
    delete process.env.DAIMON_HOME;
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });
}
