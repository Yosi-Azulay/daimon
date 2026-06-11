import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { detectCompileRegression, detectBundleRegression, detectErrorFlapRegression, suspectCommitForDir } = await import('../dist/regressions.js');
const { Registry } = await import('../dist/registry.js');
const { History } = await import('../dist/history.js');

test('detectCompileRegression flags the planned 20-fast + 1-slow scenario with the exact factor', () => {
  const prior = Array.from({ length: 20 }, () => 1000); // 1s median
  const r = detectCompileRegression(prior, 2500, 2.0);
  assert.ok(r);
  assert.equal(r.kind, 'compile');
  assert.equal(r.baseline, 1000);
  assert.equal(r.current, 2500);
  assert.equal(r.factor, 2.5);
});

test('detectCompileRegression uses a true median (average of the two middles)', () => {
  const prior = [...Array.from({ length: 10 }, () => 1000), ...Array.from({ length: 10 }, () => 2000)];
  const r = detectCompileRegression(prior, 4500, 2.0);
  assert.ok(r);
  assert.equal(r.baseline, 1500);
  assert.equal(r.factor, 3);
});

test('detectCompileRegression returns null when sample size is too small', () => {
  const r = detectCompileRegression([1000, 1100, 1050], 2500, 2.0);
  assert.equal(r, null);
});

test('detectCompileRegression returns null when current is within budget', () => {
  const prior = Array.from({ length: 20 }, () => 1000);
  const r = detectCompileRegression(prior, 1500, 2.0);
  assert.equal(r, null);
});

test('detectCompileRegression honors a per-app factor override', () => {
  const prior = Array.from({ length: 20 }, () => 1000);
  assert.equal(detectCompileRegression(prior, 2500, 3.0), null);
  assert.ok(detectCompileRegression(prior, 3500, 3.0));
});

test('detectBundleRegression flags a >10% jump over the rolling median', () => {
  const r = detectBundleRegression([400, 410, 390, 405, 400], 500, 1.1);
  assert.ok(r);
  assert.equal(r.kind, 'bundle');
  assert.equal(r.baseline, 400);
  assert.equal(r.current, 500);
});

test('detectBundleRegression one outlier build does not poison the median baseline', () => {
  // A single huge prior build must not raise the baseline enough to mask a real jump.
  const r = detectBundleRegression([400, 400, 400, 400, 4000], 500, 1.1);
  assert.ok(r);
  assert.equal(r.baseline, 400);
});

test('detectBundleRegression still accepts a single prior number (v0.10.0 callers)', () => {
  const r = detectBundleRegression(400, 500, 1.1);
  assert.ok(r);
  assert.equal(r.baseline, 400);
});

test('detectBundleRegression returns null for small drift', () => {
  assert.equal(detectBundleRegression([400], 410, 1.1), null);
});

test('detectBundleRegression handles missing baseline gracefully', () => {
  assert.equal(detectBundleRegression(undefined, 500, 1.1), null);
  assert.equal(detectBundleRegression([], 500, 1.1), null);
  assert.equal(detectBundleRegression(0, 500, 1.1), null);
});

test('detectErrorFlapRegression flags a 3x spike over the 24h baseline', () => {
  // Last 1h: 30 errors. Prior 23h: 23 errors -> per-hour baseline = 1.
  const r = detectErrorFlapRegression(30, 23, 'abc123');
  assert.ok(r);
  assert.equal(r.kind, 'error-flap');
  assert.equal(r.fingerprint, 'abc123');
});

test('detectErrorFlapRegression fires on a spike from a zero baseline (capped factor)', () => {
  const r = detectErrorFlapRegression(20, 0, 'fresh-fp');
  assert.ok(r);
  assert.equal(r.factor, 99);
  assert.equal(r.baseline, 0);
  assert.equal(r.current, 20);
});

test('detectErrorFlapRegression respects the minimum hour-events floor', () => {
  assert.equal(detectErrorFlapRegression(4, 23, 'fp'), null);
  assert.equal(detectErrorFlapRegression(4, 0, 'fp'), null);
});

test('suspectCommitForDir resolves null for missing dir', async () => {
  assert.equal(await suspectCommitForDir(null), null);
  assert.equal(await suspectCommitForDir(''), null);
  assert.equal(await suspectCommitForDir('/this/path/does/not/exist/anywhere'), null);
});

function makeRegistry(history) {
  const config = {
    searchRoots: [], portRange: [4000, 4099], apiPort: 4999, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: '', retentionDays: 0 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null },
  };
  const app = { name: 'web', workspaceRoot: path.join(os.tmpdir(), 'no-git-here'), workspaceType: 'vite', command: 'echo', hidden: false, tags: [] };
  const reg = new Registry(config, [app]);
  reg.setHistory(history);
  return reg;
}

test('Registry emits regression-detected through the compile path (20 fast + 1 slow)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-regev-'));
  const h = new History({ enabled: true, path: path.join(dir, 'history.db'), retentionDays: 30 });
  const reg = makeRegistry(h);
  const now = Date.now();
  for (let i = 0; i < 20; i++) h.recordCompile('web', 1000, now - (i + 1) * 60_000);
  h._flushForTest?.();
  reg.checkCompileRegression('web', 2500, now);
  // suspect-commit resolution is async; give the fire-and-forget chain a beat.
  await new Promise(r => setTimeout(r, 300));
  const events = reg.events({ sinceMs: 60_000 });
  const reg1 = events.find(e => e.type === 'regression-detected');
  assert.ok(reg1, 'regression-detected event recorded');
  const payload = JSON.parse(reg1.message);
  assert.equal(payload.kind, 'compile');
  assert.equal(payload.baseline, 1000);
  assert.equal(payload.current, 2500);
  assert.equal(payload.factor, 2.5);
  assert.ok('suspectCommit' in payload);
  assert.ok(events.find(e => e.type === 'compile-regression'), 'legacy event also recorded');
  h.close();
});

test('Registry compile baseline excludes only the just-recorded row, not equal durations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-regeq-'));
  const h = new History({ enabled: true, path: path.join(dir, 'history.db'), retentionDays: 30 });
  const reg = makeRegistry(h);
  const now = Date.now();
  // All priors share the duration of the current compile -- under the old
  // value-based filter the baseline emptied out and detection was suppressed
  // for a genuinely identical-duration run; with ts-based exclusion the
  // baseline survives and a 2500ms outlier still fires.
  for (let i = 0; i < 20; i++) h.recordCompile('web', 2500, now - (i + 1) * 60_000);
  h.recordCompile('web', 2500, now);
  h._flushForTest?.();
  reg.checkCompileRegression('web', 2500, now);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(reg.events({ sinceMs: 60_000 }).find(e => e.type === 'regression-detected'), undefined,
    'identical duration is not a regression');
  // Now a real spike on the same corpus must fire even though equal-valued priors exist.
  const ts2 = now + 1;
  h.recordCompile('web', 6000, ts2);
  h._flushForTest?.();
  reg.checkCompileRegression('web', 6000, ts2);
  await new Promise(r => setTimeout(r, 300));
  const ev = reg.events({ sinceMs: 60_000 }).find(e => e.type === 'regression-detected');
  assert.ok(ev, 'spike over equal-valued baseline fires');
  assert.equal(JSON.parse(ev.message).baseline, 2500);
  h.close();
});

test('Registry emits regression-detected for an error flap (spike from zero baseline)', async () => {
  const reg = makeRegistry(null);
  for (let i = 0; i < 6; i++) reg.checkErrorFlapRegression('web', 'NG0100: ExpressionChanged');
  await new Promise(r => setTimeout(r, 300));
  const events = reg.events({ sinceMs: 60_000 }).filter(e => e.type === 'regression-detected');
  assert.equal(events.length, 1, 'exactly one alert (throttled)');
  const payload = JSON.parse(events[0].message);
  assert.equal(payload.kind, 'error-flap');
  assert.equal(payload.fingerprint, 'NG0100: ExpressionChanged');
  assert.equal(payload.factor, 99);
});
