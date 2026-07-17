// M109 — the surfacing wave: rss/cpu Trends series, the `why` resourceNote,
// the doctor cpu-storm-active rule (advise-only), and the report `resources`
// section. All module-level against seeded history — no real daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-ressurf-'));
process.env.DAIMON_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.DAIMON_HOME, { recursive: true });

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { runDoctor } = await import('../dist/doctor.js');
const { buildReport, renderReportMd } = await import('../dist/report.js');

const MB = 1024 * 1024;
const HOUR = 3600_000;

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43900, 43990], apiPort: 0, overrides: {}, autoStart: [],
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
const app = name => ({ name, baseName: name, workspaceRoot: tmp, workspaceType: 'polyglot', command: 'echo x', hidden: false, tags: [] });

// ── Trends series ───────────────────────────────────────────────────────────

test('history.trends: rss/cpu bucket-averaged series from resource_samples', () => {
  const h = new History({ enabled: true, path: path.join(tmp, 'trends.db'), retentionDays: 60 });
  const now = Date.now();
  // Two buckets: 3h ago at ~200MB/10%, 1h ago at ~400MB/50%.
  for (const [dtH, rssMB, cpu] of [[3, 190, 8], [3, 210, 12], [1, 380, 45], [1, 420, 55]]) {
    h.recordResourceSample('web', rssMB * MB, cpu, now - dtH * HOUR - 60_000);
  }
  h._flushForTest();
  const rss = h.trends({ app: 'web', metric: 'rss', sinceMs: 24 * HOUR, bucketMs: HOUR });
  assert.equal(rss.count, 4);
  assert.equal(rss.points.length, 2);
  assert.deepEqual(rss.points.map(p => p.v), [200, 400], 'bucket-averaged MB');
  const cpu = h.trends({ app: 'web', metric: 'cpu', sinceMs: 24 * HOUR, bucketMs: HOUR });
  assert.deepEqual(cpu.points.map(p => p.v), [10, 50], 'bucket-averaged percent');
  // Empty series degrades to points: [], never an error.
  const empty = h.trends({ app: 'ghost', metric: 'rss', sinceMs: 24 * HOUR, bucketMs: HOUR });
  assert.deepEqual(empty, { points: [], count: 0 });
  h.close();
});

test('GET /api/history/trends accepts rss+cpu in both metric= and metrics= forms', async () => {
  const cfg = baseCfg({ history: { enabled: true, path: path.join(tmp, 'trends2.db'), retentionDays: 60 } });
  const reg = new Registry(cfg, [app('web')]);
  const h = new History(cfg.history);
  reg.setHistory(h);
  h.recordResourceSample('web', 300 * MB, 20, Date.now() - HOUR);
  h._flushForTest();
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const single = await (await fetch(`${base}/api/history/trends?app=web&metric=rss`)).json();
    assert.equal(single.metric, 'rss');
    assert.equal(single.points.length, 1);
    assert.equal(single.points[0].v, 300);
    const multi = await (await fetch(`${base}/api/history/trends?app=web&metrics=rss,cpu`)).json();
    assert.ok(multi.metrics.rss && multi.metrics.cpu, 'both series in one round-trip');
    assert.equal(multi.metrics.cpu.points[0].v, 20);
  } finally {
    server.close();
    h.close();
  }
});

// ── `why` resourceNote ──────────────────────────────────────────────────────

async function whyFor(seed) {
  const dbPath = path.join(tmp, `why-${Math.random().toString(36).slice(2)}.db`);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('web')]);
  const h = new History(cfg.history);
  reg.setHistory(h);
  seed(h);
  h._flushForTest();
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return await (await fetch(`${base}/api/why/web`)).json();
  } finally {
    server.close();
    h.close();
  }
}

test('why: crash inside an open leak-suspect window → resourceNote names baseline, current, and span', async () => {
  const now = Date.now();
  const body = await whyFor(h => {
    h.recordEvent({
      ts: now - 20 * 60_000, app: 'web', type: 'resource-leak-suspect',
      message: JSON.stringify({ baselineRssMB: 200, currentRssMB: 620, growthMB: 420, growthPerMinMB: 10, windowMs: 900_000, remedy: 'restart' }),
    });
    h.recordCrash({ app: 'web', ts: now - 5 * 60_000, exitCode: 137, signal: null, uptimeMs: 3 * HOUR, lastLines: ['out of memory'], gitHead: null });
  });
  assert.ok(body.resourceNote, 'note present');
  assert.match(body.resourceNote, /200MB/);
  assert.match(body.resourceNote, /620MB/);
  assert.match(body.resourceNote, /3\.1× baseline/);
  assert.ok(body.resources && body.resources.leak, 'open-episode state exposed');
});

test('why: no suspicion events → resourceNote omitted (null)', async () => {
  const now = Date.now();
  const body = await whyFor(h => {
    h.recordCrash({ app: 'web', ts: now - 5 * 60_000, exitCode: 1, signal: null, uptimeMs: HOUR, lastLines: ['boom'], gitHead: null });
  });
  assert.equal(body.resourceNote, null);
});

test('why: a restart between the suspicion and the crash closes the episode → no note', async () => {
  const now = Date.now();
  const body = await whyFor(h => {
    h.recordEvent({
      ts: now - 40 * 60_000, app: 'web', type: 'resource-leak-suspect',
      message: JSON.stringify({ baselineRssMB: 200, currentRssMB: 300, growthMB: 100, growthPerMinMB: 5, windowMs: 900_000, remedy: 'restart' }),
    });
    h.recordEvent({ ts: now - 30 * 60_000, app: 'web', type: 'status', from: 'serving', to: 'starting' });
    h.recordCrash({ app: 'web', ts: now - 5 * 60_000, exitCode: 1, signal: null, uptimeMs: HOUR, lastLines: ['boom'], gitHead: null });
  });
  assert.equal(body.resourceNote, null, 'restart recalibrated the baseline — the old suspicion is stale');
});

test('why: cpu-storm before the crash → CPU-flavored note', async () => {
  const now = Date.now();
  const body = await whyFor(h => {
    h.recordEvent({
      ts: now - 20 * 60_000, app: 'web', type: 'cpu-storm',
      message: JSON.stringify({ baselineCpuPct: 5, baselineP95Pct: 8, windowMeanPct: 85, windowMs: 900_000, remedy: 'check' }),
    });
    h.recordCrash({ app: 'web', ts: now - 5 * 60_000, exitCode: 1, signal: null, uptimeMs: HOUR, lastLines: ['boom'], gitHead: null });
  });
  assert.ok(body.resourceNote);
  assert.match(body.resourceNote, /85% vs baseline 5%/);
});

// ── Doctor: cpu-storm-active (advise-only) ──────────────────────────────────

test('doctor flags cpu-storm-active with no fix offered; a restart since clears it', async () => {
  const histPath = path.join(tmp, 'doc.db');
  const cfg = baseCfg({ history: { enabled: true, path: histPath, retentionDays: 7 } });
  const now = Date.now();
  {
    const h = new History(cfg.history);
    h.recordEvent({ ts: now - 10 * 60_000, app: 'web', type: 'cpu-storm', message: JSON.stringify({ baselineCpuPct: 5, baselineP95Pct: 8, windowMeanPct: 90, windowMs: 900_000 }) });
    h._flushForTest();
    h.close();
  }
  const flagged = await runDoctor(cfg, []);
  const hit = flagged.checks.find(c => c.name === 'cpu-storm-active: web');
  assert.ok(hit, `doctor flags the storming app (got ${JSON.stringify(flagged.checks.map(c => c.name))})`);
  assert.equal(hit.ok, false);
  assert.match(hit.detail, /daimon why web/);
  assert.match(hit.detail, /never kills/i, 'advise-only, warn-never-kill restated');
  assert.ok(!flagged.checks.some(c => c.name === `autofix: cpu-storm-active: web`), 'no auto-fix exists for storms');
  {
    const h = new History(cfg.history);
    h.recordEvent({ ts: now - 5 * 60_000, app: 'web', type: 'status', from: 'error', to: 'starting' });
    h._flushForTest();
    h.close();
  }
  const clean = await runDoctor(cfg, []);
  assert.ok(!clean.checks.some(c => c.name.startsWith('cpu-storm-active')), 'restart closes the episode');
  assert.ok(clean.checks.some(c => c.name === 'cpu-storm' && c.ok), 'clean cpu-storm check present');
});

// ── Report `resources` section ──────────────────────────────────────────────

test('report: resources section rolls up peak rss, avg cpu, and suspicion/budget counts', () => {
  const dbPath = path.join(tmp, 'report.db');
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta')]);
  const h = new History(cfg.history);
  reg.setHistory(h);
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    h.recordResourceSample('alpha', (300 + i * 50) * MB, 10 + i * 10, now - (5 - i) * HOUR);
    h.recordResourceSample('beta', 100 * MB, 5, now - (5 - i) * HOUR);
  }
  h.recordEvent({ ts: now - 2 * HOUR, app: 'alpha', type: 'resource-leak-suspect', message: JSON.stringify({ baselineRssMB: 300, currentRssMB: 500, remedy: 'r' }) });
  h.recordEvent({ ts: now - HOUR, app: 'alpha', type: 'resource-budget-exceeded', message: JSON.stringify({ metric: 'rss', observed: 500, budget: 400, remedy: 'r' }) });
  h._flushForTest();

  const r = buildReport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now });
  const rows = r.sections.resources.apps;
  assert.ok(rows, `section has rows (${JSON.stringify(r.sections.resources)})`);
  const alpha = rows.find(x => x.app === 'alpha');
  assert.equal(alpha.peakRssMB, 500);
  assert.equal(alpha.leakSuspects, 1);
  assert.equal(alpha.budgetExceeded, 1);
  assert.equal(alpha.cpuStorms, 0);
  assert.equal(rows[0].app, 'alpha', 'sorted by peak rss');
  const md = renderReportMd(r);
  assert.match(md, /## Resources/);
  assert.match(md, /\*\*alpha\*\* — peak 500MB/);
  assert.match(md, /1 leak suspicion/);
  h.close();
});

test('report: empty resource data degrades to a note, never an error', () => {
  const dbPath = path.join(tmp, 'report-empty.db');
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha')]);
  const h = new History(cfg.history);
  reg.setHistory(h);
  const now = Date.now();
  const r = buildReport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now });
  assert.deepEqual(r.sections.resources, { note: 'no resource samples in the window' });
  const noHist = buildReport({ registry: reg, history: null }, { since: now - 24 * HOUR, until: now });
  assert.match(noHist.sections.resources.note, /history disabled/);
  assert.match(renderReportMd(r), /## Resources\n> no resource samples/);
  h.close();
});
