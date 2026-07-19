import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// M130 (v1.7) — flaky quarantine. Quarantined tests still run + record; they're
// annotated, excluded from flaky detection + alert noise, and dated so a parked
// test can't rot invisibly.

const {
  compileQuarantine,
  quarantineTestName,
  reconcileFirstSeen,
  quarantineSummary,
} = await import('../dist/quarantine.js');
const { findFlakyTests } = await import('../dist/testRunners.js');
const { validateConfig, configValidationWarnings } = await import('../dist/config.js');

// --- pure matcher -----------------------------------------------------------

test('quarantineTestName joins suite + test, falls back to test alone', () => {
  assert.equal(quarantineTestName('math', 'adds'), 'math > adds');
  assert.equal(quarantineTestName('', 'adds'), 'adds');
  assert.equal(quarantineTestName(null, 'adds'), 'adds');
});

test('compileQuarantine: * glob, exact, and non-match', () => {
  const m = compileQuarantine(['math > *', 'exact name', 'api*flaky']);
  assert.equal(m.matches('math > adds numbers'), true);
  assert.equal(m.matches('exact name'), true);
  assert.equal(m.matches('api integration flaky'), true);
  assert.equal(m.matches('other > test'), false);
  assert.equal(m.matches('exact name extra'), false, 'anchored — no partial match');
});

test('compileQuarantine: empty/invalid entries are dropped, never throw', () => {
  const m = compileQuarantine(['', '   ', 42, null, 'ok']);
  assert.deepEqual(m.patterns, ['ok']);
  assert.equal(m.matches('ok'), true);
});

test('compileQuarantine: regex metacharacters in a pattern are literal', () => {
  const m = compileQuarantine(['a.b (c)']);
  assert.equal(m.matches('a.b (c)'), true);
  assert.equal(m.matches('axb (c)'), false, 'the dot is literal, not any-char');
});

// --- first-seen reconciliation ---------------------------------------------

test('reconcileFirstSeen: new patterns dated now, existing preserved, removed dropped', () => {
  const prev = { 'old > a': 1000, 'gone > b': 2000 };
  const r = reconcileFirstSeen(prev, ['old > a', 'new > c'], 5000);
  assert.equal(r.firstSeen['old > a'], 1000, 'existing preserved');
  assert.equal(r.firstSeen['new > c'], 5000, 'new dated now');
  assert.equal(r.firstSeen['gone > b'], undefined, 'removed dropped');
  assert.equal(r.changed, true);
});

test('reconcileFirstSeen: no delta → changed false', () => {
  const prev = { 'a': 100 };
  const r = reconcileFirstSeen(prev, ['a'], 9999);
  assert.equal(r.changed, false);
  assert.equal(r.firstSeen['a'], 100);
});

test('quarantineSummary: oldestSince is the minimum first-seen', () => {
  assert.deepEqual(quarantineSummary({ a: 300, b: 100, c: 200 }), { patterns: ['a', 'b', 'c'], count: 3, oldestSince: 100 });
  assert.deepEqual(quarantineSummary({}), { patterns: [], count: 0, oldestSince: null });
});

// --- flaky exclusion --------------------------------------------------------

test('findFlakyTests: a quarantined fingerprint is never flagged flaky', () => {
  const runs = [true, false, true, false].map((_, i) => ({ id: i + 1, ts: 1000 + i, gitHead: 'h' }));
  // Same flip pattern as the flaky base case, but every row is quarantined.
  const failures = [true, false, true, false].flatMap((failing, i) => failing
    ? [{ runId: i + 1, fingerprint: 'fp1', test: 'flappy', suite: 's', quarantined: 1 }]
    : []);
  assert.equal(findFlakyTests(runs, () => failures, 'h', 3).length, 0);
  // Un-quarantined, the identical pattern IS flaky — proving the flag is the cause.
  const live = failures.map(f => ({ ...f, quarantined: null }));
  assert.equal(findFlakyTests(runs, () => live, 'h', 3).length, 1);
});

// --- config validation ------------------------------------------------------

function baseRaw(tests) {
  return { searchRoots: [], tests };
}

test('config: valid quarantine array is kept trimmed', () => {
  const cfg = validateConfig(baseRaw({ flakyThreshold: 3, quarantine: ['  a > b ', 'c*'] }), 'test');
  assert.deepEqual(cfg.tests.quarantine, ['a > b', 'c*']);
});

test('config: invalid quarantine entries warn and are skipped; config still loads', () => {
  const cfg = validateConfig(baseRaw({ flakyThreshold: 3, quarantine: ['ok', '', 5] }), 'test');
  assert.deepEqual(cfg.tests.quarantine, ['ok']);
  assert.ok(configValidationWarnings().some(w => /quarantine/.test(w)), 'warned on the bad entries');
});

test('config: non-array quarantine warns and is ignored', () => {
  const cfg = validateConfig(baseRaw({ flakyThreshold: 3, quarantine: 'a>b' }), 'test');
  assert.equal(cfg.tests.quarantine, undefined);
  assert.ok(configValidationWarnings().some(w => /quarantine/.test(w)));
});

// --- notification suppression ----------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-quar-'));
process.env.DAIMON_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.DAIMON_HOME, { recursive: true });
const { Notifier } = await import('../dist/notifier.js');

test('notifier: a quarantinedOnly test-failed event is suppressed; a real one notifies', async () => {
  const reg = new EventEmitter();
  const got = [];
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false, kinds: ['test-failed'], batchMs: 0 }, { sink: p => got.push(p) });
  reg.emit('event', { ts: Date.now(), app: 'web', type: 'test-failed', message: JSON.stringify({ app: 'web', failed: 1, quarantinedOnly: true }) });
  reg.emit('event', { ts: Date.now(), app: 'web', type: 'test-failed', message: JSON.stringify({ app: 'web', failed: 2, quarantinedOnly: false }) });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(got.length, 1, `only the real failure notifies (got ${JSON.stringify(got)})`);
  n.stop();
});

// --- why deepening (M132) ---------------------------------------------------

const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');

function fullCfg(quarantine) {
  return {
    searchRoots: [], portRange: [43810, 43890], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: path.join(tmp, 'why.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3, quarantine }, restartStorm: { perHour: 20 },
  };
}

test('why: surfaces the quarantine summary when patterns are parked; null when none', async () => {
  // With patterns parked.
  const cfg = fullCfg(['flappy > *']);
  const reg = new Registry(cfg, [{ name: 'web', baseName: 'web', workspaceRoot: tmp, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] }]);
  reg.reconcileQuarantine(1000);
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;
    const why = await (await fetch(`http://127.0.0.1:${port}/api/why/web`)).json();
    assert.ok(why.quarantine, 'quarantine present');
    assert.equal(why.quarantine.count, 1);
    assert.equal(why.quarantine.oldestSince, 1000);
  } finally { server.close(); reg.endActiveLogStorms?.(); }

  // With none configured.
  const cfg2 = fullCfg(undefined);
  const reg2 = new Registry(cfg2, [{ name: 'web', baseName: 'web', workspaceRoot: tmp, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] }]);
  reg2.reconcileQuarantine(1000);
  const server2 = startServer(reg2, 0, { getConfig: () => cfg2 });
  try {
    await new Promise(r => server2.once('listening', r));
    const port2 = server2.address().port;
    const why2 = await (await fetch(`http://127.0.0.1:${port2}/api/why/web`)).json();
    assert.equal(why2.quarantine, null, 'null when nothing parked');
  } finally { server2.close(); reg2.endActiveLogStorms?.(); }
});
