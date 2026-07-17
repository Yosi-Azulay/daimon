import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M83 — `daimon report`: composition correctness against independently
// queried values, empty-history degradation (notes, never errors), --md
// rendering, the HTTP route, and the 100k-corpus <500ms bench budget.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-report-'));
process.env.DAIMON_HOME = path.join(tmp, 'home');

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { buildReport, renderReportMd } = await import('../dist/report.js');
const { snapshotEnvFiles } = await import('../dist/envFiles.js');

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43600, 43690], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: path.join(tmp, 'history.db'), retentionDays: 60 },
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

function app(name, extra = {}) {
  return { name, baseName: name, workspaceRoot: tmp, workspaceType: 'polyglot', command: 'echo x', hidden: false, tags: [], ...extra };
}

const HOUR = 3600_000;

function seededHistory(dbPath, now) {
  const h = new History({ enabled: true, path: dbPath, retentionDays: 60 });
  // Uptime: alpha serving from now-10h to now-4h (6h of the 24h window = 25%),
  // one restart cycle.
  h.recordEvent({ ts: now - 10 * HOUR, app: 'alpha', type: 'status', from: 'compiling', to: 'serving' });
  h.recordEvent({ ts: now - 4 * HOUR, app: 'alpha', type: 'status', from: 'serving', to: 'error', message: 'boom' });
  h.recordEvent({ ts: now - 3 * HOUR, app: 'alpha', type: 'status', from: 'error', to: 'starting' });
  // Errors: one new group (2 hits), one recurring-only group (3 hits).
  h.recordEvent({ ts: now - 9 * HOUR, app: 'alpha', type: 'error-new', message: 'TS2304: Cannot find name' });
  h.recordEvent({ ts: now - 8 * HOUR, app: 'alpha', type: 'error-recur', message: 'TS2304: Cannot find name' });
  for (const dt of [7, 6, 5]) h.recordEvent({ ts: now - dt * HOUR, app: 'beta', type: 'error-recur', message: 'ECONNREFUSED upstream' });
  // Regression + storm events.
  h.recordEvent({ ts: now - 5 * HOUR, app: 'alpha', type: 'regression-detected', message: JSON.stringify({ kind: 'compile-time', suspectCommit: 'abc123:msg' }) });
  h.recordEvent({ ts: now - 2 * HOUR, app: 'beta', type: 'restart-storm', message: JSON.stringify({ app: 'beta', count: 25, windowMs: HOUR, lastExitCode: 1 }) });
  // Compiles: alpha 100..500ms.
  for (const [i, ms] of [100, 200, 300, 400, 500].entries()) {
    h.recordCompile('alpha', ms, now - (8 - i) * HOUR);
  }
  // Crashes.
  h.recordCrash({ app: 'beta', ts: now - 6 * HOUR, exitCode: 1, signal: null, uptimeMs: 1234, lastLines: ['x'], gitHead: 'abc' });
  h.recordCrash({ app: 'beta', ts: now - 5 * HOUR, exitCode: 1, signal: null, uptimeMs: 999, lastLines: ['y'], gitHead: 'abc' });
  // Tests: 2 runs — 8/10 then 10/10 → pass rate 90%.
  h.recordTestRun({ app: 'alpha', ts: now - 7 * HOUR, runner: 'vitest', durationMs: 1000, total: 10, passed: 8, failed: 2, skipped: 0, exitCode: 1, gitHead: 'abc' }, [
    { suite: 's', test: 'flappy', file: 'a.ts', line: 1, message: 'nope', fingerprint: 'fp1' },
    { suite: 's', test: 'other', file: 'a.ts', line: 2, message: 'nope', fingerprint: 'fp2' },
  ]);
  h.recordTestRun({ app: 'alpha', ts: now - 6 * HOUR, runner: 'vitest', durationMs: 900, total: 10, passed: 10, failed: 0, skipped: 0, exitCode: 0, gitHead: 'abc' }, []);
  // Task runs (agent activity).
  h.recordTaskRun('alpha', 'lint', 0, 400, null, now - 3 * HOUR);
  h.recordTaskRun('beta', 'build', 1, 900, null, now - 2 * HOUR);
  // Env snapshots: baseline before window edge + changed one in-window.
  const root = fs.mkdtempSync(path.join(tmp, 'env-'));
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=one\n');
  const snapA = snapshotEnvFiles(root, ['.env']);
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=two\n');
  const snapB = snapshotEnvFiles(root, ['.env']);
  h.recordEnvSnapshot('alpha', snapA, now - 20 * HOUR);
  h.recordEnvSnapshot('alpha', snapB, now - 1 * HOUR);
  h._flushForTest();
  return h;
}

test('seeded report: every section matches independently-queried values', () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'seeded.db');
  const h = seededHistory(dbPath, now);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta')]);
  reg.setHistory(h);

  const r = buildReport({ registry: reg, history: h, agents: [{ id: 'host-1-abcd', lastSeen: now - HOUR }], flakyThreshold: 3 }, { since: now - 24 * HOUR, until: now });
  const S = r.sections;

  // uptime: alpha served 6h of 24h = 25%, one restart (error→starting).
  const alphaUp = S.uptime.apps.find(a => a.app === 'alpha');
  assert.ok(Math.abs(alphaUp.uptimePct - 25) < 1, `uptime ~25% (got ${alphaUp.uptimePct})`);
  assert.equal(alphaUp.restarts, 1);

  // errors: 5 events, 2 groups — 1 new, 1 recurring; both resolved (no live errors).
  assert.equal(S.errors.total, 5);
  assert.equal(S.errors.groups.length, 2);
  assert.equal(S.errors.newCount, 1);
  assert.equal(S.errors.recurringCount, 1);
  assert.equal(S.errors.resolvedCount, 2);
  const top = S.errors.groups[0];
  assert.equal(top.message, 'ECONNREFUSED upstream');
  assert.equal(top.count, 3);
  assert.equal(top.kind, 'recurring');

  // tests: 18/20 = 90%.
  assert.equal(S.tests.runs, 2);
  assert.equal(S.tests.failedRuns, 1);
  assert.equal(S.tests.passRatePct, 90);

  // compiles: [100..500] → p50 300, p95 400 (floor((n-1)*p) convention,
  // matching history.summary()), slowest 500 by alpha; 1 regression.
  assert.equal(S.compiles.count, 5);
  assert.equal(S.compiles.p50Ms, 300);
  assert.equal(S.compiles.p95Ms, 400);
  assert.equal(S.compiles.slowest.app, 'alpha');
  assert.equal(S.compiles.slowest.ms, 500);
  assert.equal(S.compiles.regressions.length, 1);
  assert.equal(S.compiles.regressions[0].suspectCommit, 'abc123:msg');

  // crashes: 2 for beta + 1 storm event.
  assert.equal(S.crashes.total, 2);
  assert.deepEqual(S.crashes.byApp, [{ app: 'beta', count: 2 }]);
  assert.equal(S.crashes.storms.length, 1);

  // agents: 1 active + 2 task runs.
  assert.equal(S.agents.active.length, 1);
  assert.equal(S.agents.taskRuns, 2);

  // env: TOKEN changed for alpha (baseline outside window vs in-window).
  assert.equal(S.env.changes.length, 1);
  assert.equal(S.env.changes[0].app, 'alpha');
  assert.deepEqual(S.env.changes[0].keysChanged, [{ file: '.env', key: 'TOKEN' }]);

  h.close();
});

test('app filter narrows every section', () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'filtered.db');
  const h = seededHistory(dbPath, now);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta')]);
  reg.setHistory(h);
  const r = buildReport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now, app: 'beta' });
  const S = r.sections;
  assert.equal(S.uptime.apps.length, 1);
  assert.equal(S.uptime.apps[0].app, 'beta');
  assert.ok(S.errors.groups.every(g => g.app === 'beta'));
  assert.ok(S.tests.note, 'beta has no test runs → note');
  assert.equal(S.crashes.total, 2);
  h.close();
});

test('group scope narrows sections and names the group (M95)', () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'group-filtered.db');
  const h = seededHistory(dbPath, now);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta'), app('gamma')]);
  reg.setHistory(h);
  const r = buildReport(
    { registry: reg, history: h },
    { since: now - 24 * HOUR, until: now, group: 'day', groupApps: ['beta'] },
  );
  assert.equal(r.group, 'day');
  const S = r.sections;
  assert.equal(S.uptime.apps.length, 1);
  assert.equal(S.uptime.apps[0].app, 'beta');
  assert.ok(S.errors.groups.every(g => g.app === 'beta'));
  const md = renderReportMd(r);
  assert.match(md.split('\n')[0], /group `day`/);
  // Unscoped report is untouched: group renders null, sections keep all apps.
  const r2 = buildReport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now });
  assert.equal(r2.group, null);
  assert.ok(r2.sections.uptime.apps.length >= 2);
  h.close();
});

test('empty history: every section degrades to a note, never an error', () => {
  const dbPath = path.join(tmp, 'empty.db');
  const h = new History({ enabled: true, path: dbPath, retentionDays: 7 });
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 7 } });
  const reg = new Registry(cfg, [app('lonely')]);
  reg.setHistory(h);
  const r = buildReport({ registry: reg, history: h }, { since: Date.now() - 24 * HOUR });
  for (const key of ['errors', 'tests', 'compiles', 'crashes', 'agents', 'env']) {
    assert.ok(r.sections[key]?.note, `${key} has a note (${JSON.stringify(r.sections[key])})`);
  }
  // uptime with a known app but no events → row with null uptime, no throw.
  assert.ok(r.sections.uptime.apps || r.sections.uptime.note);
  // M103: empty log history degrades the log-volume line to its own note.
  assert.ok(r.sections.errors.logVolume?.note, `logVolume note (${JSON.stringify(r.sections.errors.logVolume)})`);
  h.close();
});

test('log volume line (M103): matches independently-queried counts; renders in --md', () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'logvolume.db');
  const h = new History({ enabled: true, path: dbPath, retentionDays: 7 });
  // 10 lines: 3 error, 2 warn, 5 unclassified — plus one storm event.
  for (let i = 0; i < 3; i++) h.recordLogLine('alpha', `ERROR boom ${i}`, now - (i + 1) * 60_000, 'error');
  for (let i = 0; i < 2; i++) h.recordLogLine('alpha', `WARN careful ${i}`, now - (i + 1) * 30_000, 'warn');
  for (let i = 0; i < 5; i++) h.recordLogLine('beta', `plain ${i}`, now - (i + 1) * 45_000, null);
  h.recordEvent({ ts: now - HOUR, app: 'alpha', type: 'log-storm', message: JSON.stringify({ observedPerMin: 600, baselinePerMin: 30 }) });
  h._flushForTest();
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 7 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta')]);
  reg.setHistory(h);

  const r = buildReport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now });
  const lv = r.sections.errors.logVolume;
  assert.equal(lv.totalLines, 10);
  assert.equal(lv.errorLines, 3);
  assert.equal(lv.errorSharePct, 30);
  assert.equal(lv.storms, 1);

  // App scope narrows the volume.
  const rAlpha = buildReport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now, app: 'alpha' });
  assert.equal(rAlpha.sections.errors.logVolume.totalLines, 5);
  assert.equal(rAlpha.sections.errors.logVolume.errorSharePct, 60);

  const md = renderReportMd(r);
  assert.ok(md.includes('log volume: 10 lines · 30% error-level · 1 storm'), `md line rendered (${md.split('\n').find(l => l.startsWith('log volume'))})`);
  h.close();
});

test('history disabled entirely: notes, not errors', () => {
  const cfg = baseCfg({ history: { enabled: false, path: path.join(tmp, 'x.db'), retentionDays: 7 } });
  const reg = new Registry(cfg, [app('a')]);
  const r = buildReport({ registry: reg, history: null }, { since: Date.now() - 24 * HOUR });
  for (const key of ['uptime', 'errors', 'tests', 'compiles', 'crashes', 'env']) {
    assert.ok(r.sections[key]?.note, `${key} degraded (${JSON.stringify(r.sections[key])})`);
  }
});

test('--md renders every section header, notes included', () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'md.db');
  const h = seededHistory(dbPath, now);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta')]);
  reg.setHistory(h);
  const md = renderReportMd(buildReport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now }));
  for (const header of ['# daimon report', '## Uptime', '## Errors', '## Tests', '## Compiles', '## Crashes & storms', '## Agents', '## Env changes']) {
    assert.ok(md.includes(header), `${header} present`);
  }
  assert.ok(md.includes('ECONNREFUSED'), 'top error rendered');
  assert.ok(md.includes('values are never included'), 'redaction reminder present');
  h.close();
});

test('GET /api/report returns the digest; ?md=1 returns markdown', async () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'route.db');
  const h = seededHistory(dbPath, now);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta')]);
  reg.setHistory(h);
  const server = startServer(reg, 0, { getConfig: () => cfg });
  await new Promise(res => server.once('listening', res));
  const apiPort = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/report?since=24h`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.sections.uptime.apps.length >= 1);
    assert.equal(body.sections.errors.total, 5);

    const mdRes = await fetch(`http://127.0.0.1:${apiPort}/api/report?since=24h&md=1`);
    assert.equal(mdRes.status, 200);
    assert.match(mdRes.headers.get('content-type') || '', /markdown/);
    const text = await mdRes.text();
    assert.ok(text.startsWith('# daimon report'));
  } finally {
    server.close();
    h.close();
  }
});

test('bench: report over a 100k-event corpus in < 500ms', () => {
  const dbPath = path.join(tmp, 'bench.db');
  const h = new History({ enabled: true, path: dbPath, retentionDays: 365 });
  const apps = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const now = Date.now();
  const dayMs = 24 * HOUR;
  const types = ['status', 'error-new', 'error-recur'];
  const states = ['serving', 'compiling', 'error', 'starting'];
  for (let i = 0; i < 100_000; i++) {
    const ts = now - Math.floor((i / 100_000) * dayMs * 30);
    h.recordEvent({
      ts, app: apps[i % apps.length], type: types[i % types.length],
      from: states[i % states.length], to: states[(i + 1) % states.length],
      message: i % 3 === 0 ? `err message ${i % 13}` : undefined,
    });
    if (i % 5000 === 0) h._flushForTest();
  }
  for (let i = 0; i < 10_000; i++) {
    h.recordCompile(apps[i % apps.length], 50 + (i % 5000), now - Math.floor((i / 10_000) * dayMs * 30));
    if (i % 2000 === 0) h._flushForTest();
  }
  h._flushForTest();

  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 365 } });
  const reg = new Registry(cfg, apps.map(a => app(a)));
  reg.setHistory(h);

  // Warm the statement cache once, then measure 3 passes and take the median.
  buildReport({ registry: reg, history: h }, { since: now - dayMs });
  const samples = [];
  for (let pass = 0; pass < 3; pass++) {
    const t0 = performance.now();
    const r = buildReport({ registry: reg, history: h }, { since: now - dayMs });
    samples.push(performance.now() - t0);
    assert.ok(r.sections.errors.total > 0, 'bench report has data');
  }
  samples.sort((a, b) => a - b);
  const median = samples[1];
  assert.ok(median < 500, `report bench budget: median ${median.toFixed(1)}ms < 500ms (samples: ${samples.map(s => s.toFixed(0)).join(',')})`);
  h.close();
});
