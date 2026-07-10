import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M78 — `GET /api/context/<app>`: the agent context pack. Composition only;
// budget drops sections lowest-priority-first and reports them in truncated[].

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-ctx-'));

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');

const cfg = {
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
};
const app = { name: 'web', baseName: 'web', workspaceRoot: process.cwd(), workspaceType: 'vite', serverProfile: 'vite', command: 'noop', hidden: false, tags: [] };

function seededRegistry() {
  const reg = new Registry(cfg, [app]);
  const history = new History(cfg.history);
  reg.setHistory(history);
  const now = Date.now();
  // errors (in-memory, recent)
  const state = reg.getState('web');
  for (let i = 0; i < 8; i++) {
    state.errors.set(`err-${i}`, {
      message: `TS2345: Argument of type 'X${i}' is not assignable in src/app/cmp${i}.ts — a reasonably long compiler diagnostic message to give the budget something to trim`,
      count: i + 1, firstSeen: now - 60_000, lastSeen: now,
      parsed: { file: `src/app/cmp${i}.ts`, line: 10 + i, message: 'not assignable' },
    });
  }
  // last test run + failures
  history.recordTestRun(
    { app: 'web', ts: now - 5000, runner: 'vitest-jest', durationMs: 1234, total: 10, passed: 8, failed: 2, skipped: 0, exitCode: 1, gitHead: 'abc1234' },
    [
      { suite: 'math', test: 'adds', file: 'src/math.test.ts', line: 11, message: 'expected 4 to be 3', fingerprint: 'src/math.test.ts:11' },
      { suite: 'calc', test: 'divides', file: 'src/calc.test.ts', line: 7, message: 'division by zero', fingerprint: 'src/calc.test.ts:7' },
    ],
  );
  // last crash
  history.recordCrash({ app: 'web', ts: now - 9000, exitCode: 1, signal: null, uptimeMs: 60_000, lastLines: Array.from({ length: 30 }, (_, i) => `log line ${i} with some content`), gitHead: 'abc1234' });
  // compile stats + regression
  for (let i = 0; i < 12; i++) history.recordCompile('web', 900 + i * 10, now - (12 - i) * 60_000);
  reg.recordEvent({ app: 'web', type: 'regression-detected', message: JSON.stringify({ kind: 'compile', factor: 2.4, baseline: 950, current: 2280, suspectCommit: 'abc1234:feat: slow thing' }) });
  history._flushForTest();
  return { reg, history };
}

test('context: every section populated on a seeded app', async () => {
  const { reg, history } = seededRegistry();
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/context/web`, { headers: { 'x-daimon-agent': 'ctx-test-abcd' } });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.app, 'web');
    assert.equal(b.status.name, 'web');
    assert.equal(b.status.framework, 'vite');
    assert.ok(b.status.workspaceRoot);
    assert.equal(b.errors.length, 5, 'top 5 error groups only');
    assert.ok(b.errors[0].fingerprint);
    assert.equal(b.tests.runner, 'vitest-jest');
    assert.equal(b.tests.failed, 2);
    assert.equal(b.tests.failures.length, 2);
    assert.equal(b.tests.failures[0].file, 'src/math.test.ts');
    assert.equal(b.crashes.exitCode, 1);
    assert.ok(b.crashes.lastLines.length <= 15, 'crash tail capped for the pack');
    assert.equal(b.compile.p50 !== null, true);
    assert.equal(b.compile.lastRegression.kind, 'compile');
    assert.ok(b.suspectCommits.includes('abc1234:feat: slow thing'));
    assert.ok(b.agents);
    assert.deepEqual(b.truncated, []);
    const missing = await fetch(`${base}/api/context/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    history.close();
  }
});

test('context: --budget 2000 drops sections in documented order and stays under budget', async () => {
  const { reg, history } = seededRegistry();
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const full = await fetch(`${base}/api/context/web`).then(r => r.json());
    const fullLen = JSON.stringify(full).length;
    assert.ok(fullLen > 2000, `seeded pack is big enough to force drops (${fullLen} chars)`);

    const r = await fetch(`${base}/api/context/web?budget=2000`);
    const b = await r.json();
    const len = JSON.stringify(b).length;
    assert.ok(len <= 2000, `payload ${len} chars <= 2000`);
    assert.ok(b.truncated.length > 0, 'sections were dropped');
    // Drop order is a contract: compile → agents → crashes → tests → errors.
    const documented = ['compile', 'agents', 'crashes', 'tests', 'errors'];
    assert.deepEqual(b.truncated, documented.slice(0, b.truncated.length), `drop order (got ${b.truncated})`);
    assert.ok(b.status, 'status is never dropped');
    for (const dropped of b.truncated) assert.ok(!(dropped in b), `${dropped} removed from payload`);

    // A tiny budget still returns status.
    const tiny = await fetch(`${base}/api/context/web?budget=300`).then(x => x.json());
    assert.ok(tiny.status, 'status survives even a tiny budget');
    assert.deepEqual(tiny.truncated, documented);
  } finally {
    await new Promise(resolve => server.close(resolve));
    history.close();
  }
});

test('claude templates teach the context-first workflow', async () => {
  const skill = fs.readFileSync(path.join(process.cwd(), 'src', 'templates', 'claude', 'skill.md.tmpl'), 'utf8');
  const agent = fs.readFileSync(path.join(process.cwd(), 'src', 'templates', 'claude', 'agent.md.tmpl'), 'utf8');
  assert.match(skill, /daimon context/, 'skill mentions daimon context');
  assert.match(skill, /daimon test /, 'skill mentions daimon test');
  assert.match(skill, /daimon search/, 'skill mentions daimon search');
  assert.match(agent, /daimon context/, 'agent mentions daimon context');
});

test('cleanup tmp', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
