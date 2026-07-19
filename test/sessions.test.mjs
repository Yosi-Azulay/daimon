import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M134 (v1.8 "Rewind") — session derivation. Sessions are DERIVED from the
// __daemon__ daemon-start/daemon-stop lifecycle events: exact boundaries,
// unclean (crash) closure at the last observed event, deterministic
// s-<startTsMs> ids, an open current session, per-slice counts that exclude
// daemon-down gaps, `show` block degradation, and the <300ms 100k-corpus bench.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-sessions-'));
process.env.DAIMON_HOME = path.join(tmp, 'home');

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { listSessions, deriveBoundaries, showSession, findSession, buildSessionContext } = await import('../dist/sessions.js');

const D = '__daemon__';

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43810, 43890], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: '', retentionDays: 365 },
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
function app(name) {
  return { name, baseName: name, workspaceRoot: tmp, workspaceType: 'polyglot', command: 'echo x', hidden: false, tags: [] };
}

function freshHistory(name) {
  return new History({ enabled: true, path: path.join(tmp, name), retentionDays: 365 });
}

// A fixture with three clean start/stop pairs plus one crash-bounded slice.
// Timeline (ms, absolute-ish small numbers so boundaries are trivial to check):
//   A: start 1000 .. stop 2000            (clean)
//   (gap event at 2500 — belongs to NO session)
//   B: start 3000 .. last event 3500 .. (no stop) -> closed unclean at 3500
//   C: start 4000 .. stop 5000            (clean)
//   D: start 6000 .. stop 7000            (clean)
function seedFourSessions(h) {
  // Session A — alpha, 2 errors, 1 compile, 1 test run.
  h.recordEvent({ ts: 1000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 1100, app: 'alpha', type: 'status', from: 'stopped', to: 'starting' });
  h.recordEvent({ ts: 1200, app: 'alpha', type: 'error-new', message: 'boom A1' });
  h.recordEvent({ ts: 1300, app: 'alpha', type: 'error-recur', message: 'boom A1' });
  h.recordCompile('alpha', 120, 1400);
  h.recordTestRun({ app: 'alpha', ts: 1500, runner: 'vitest', durationMs: 100, total: 5, passed: 5, failed: 0, skipped: 0, exitCode: 0, gitHead: 'a' }, []);
  h.recordEvent({ ts: 2000, app: D, type: 'daemon-stop' });

  // Gap — must be attributed to no session.
  h.recordEvent({ ts: 2500, app: 'alpha', type: 'error-new', message: 'GAP error (uncounted)' });

  // Session B — beta, 1 error, 1 crash; unclean (no stop). Last event 3500.
  h.recordEvent({ ts: 3000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 3100, app: 'beta', type: 'status', from: 'stopped', to: 'starting' });
  h.recordEvent({ ts: 3200, app: 'beta', type: 'error-new', message: 'boom B1' });
  h.recordCrash({ app: 'beta', ts: 3400, exitCode: 1, signal: null, uptimeMs: 300, lastLines: ['dying'], gitHead: 'b' });
  h.recordEvent({ ts: 3500, app: 'beta', type: 'status', from: 'serving', to: 'error', message: 'last sign of life' });

  // Session C — alpha, 1 compile, NO test runs (so `show` emits a tests note).
  h.recordEvent({ ts: 4000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 4100, app: 'alpha', type: 'status', from: 'stopped', to: 'starting' });
  h.recordCompile('alpha', 200, 4200);
  h.recordEvent({ ts: 5000, app: D, type: 'daemon-stop' });

  // Session D — gamma, 1 test run.
  h.recordEvent({ ts: 6000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 6100, app: 'gamma', type: 'status', from: 'stopped', to: 'starting' });
  h.recordTestRun({ app: 'gamma', ts: 6200, runner: 'vitest', durationMs: 90, total: 3, passed: 2, failed: 1, skipped: 0, exitCode: 1, gitHead: 'd' }, [
    { suite: 's', test: 't', message: 'nope', fingerprint: 'fp' },
  ]);
  h.recordEvent({ ts: 7000, app: D, type: 'daemon-stop' });
  h._flushForTest();
}

test('derives exactly four sessions with correct boundaries; unclean one flagged', () => {
  const h = freshHistory('four.db');
  seedFourSessions(h);
  const now = 8000;
  const sessions = listSessions(h, { now });
  assert.equal(sessions.length, 4, 'four sessions');

  // Newest first.
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
  const A = byId['s-1000'], B = byId['s-3000'], C = byId['s-4000'], Dd = byId['s-6000'];
  assert.ok(A && B && C && Dd, 'ids are s-<startTsMs>');

  assert.deepEqual([A.start, A.end, A.endedCleanly, A.current], [1000, 2000, true, false]);
  // Unclean: closed at the last observed event (3500), NOT at the next boot.
  assert.deepEqual([B.start, B.end, B.endedCleanly, B.current], [3000, 3500, false, false]);
  assert.deepEqual([C.start, C.end, C.endedCleanly, C.current], [4000, 5000, true, false]);
  assert.deepEqual([Dd.start, Dd.end, Dd.endedCleanly, Dd.current], [6000, 7000, true, false]);

  assert.equal(A.durationMs, 1000);
  assert.equal(B.durationMs, 500);
  h.close();
});

test('per-session counts match, and daemon-down gap events are excluded', () => {
  const h = freshHistory('counts.db');
  seedFourSessions(h);
  const sessions = listSessions(h, { now: 8000 });
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));

  // A: 2 errors (the 2500 gap error is NOT counted), 1 compile, 1 run, alpha.
  assert.deepEqual([byId['s-1000'].errorCount, byId['s-1000'].compileCount, byId['s-1000'].testRunCount], [2, 1, 1]);
  assert.deepEqual(byId['s-1000'].apps, ['alpha']);
  // B: 1 error, beta.
  assert.deepEqual([byId['s-3000'].errorCount, byId['s-3000'].compileCount, byId['s-3000'].testRunCount], [1, 0, 0]);
  assert.deepEqual(byId['s-3000'].apps, ['beta']);
  // C: 1 compile, alpha.
  assert.deepEqual([byId['s-4000'].errorCount, byId['s-4000'].compileCount, byId['s-4000'].testRunCount], [0, 1, 0]);
  assert.deepEqual(byId['s-4000'].apps, ['alpha']);
  // D: 1 run, gamma.
  assert.deepEqual([byId['s-6000'].errorCount, byId['s-6000'].compileCount, byId['s-6000'].testRunCount], [0, 0, 1]);
  assert.deepEqual(byId['s-6000'].apps, ['gamma']);

  // Cross-check A's error count against an independent windowed query.
  const indepErrors = h.queryEvents({ since: 1000, until: 2000, limit: 1000 })
    .filter(e => e.type === 'error-new' || e.type === 'error-recur').length;
  assert.equal(byId['s-1000'].errorCount, indepErrors);
  h.close();
});

test('ids are identical across two derivation runs (deep links never rot)', () => {
  const h = freshHistory('stable.db');
  seedFourSessions(h);
  const ids1 = deriveBoundaries(h, 8000).map(b => b.id);
  const ids2 = deriveBoundaries(h, 9999).map(b => b.id);
  assert.deepEqual(ids1, ids2);
  h.close();
});

test('a same-ms restart closes the old session cleanly (stop sorts before start)', () => {
  const h = freshHistory('samems.db');
  h.recordEvent({ ts: 1000, app: D, type: 'daemon-start' });
  // Old daemon stops and new daemon starts at the identical ms.
  h.recordEvent({ ts: 2000, app: D, type: 'daemon-stop' });
  h.recordEvent({ ts: 2000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 3000, app: D, type: 'daemon-stop' });
  h._flushForTest();
  const sessions = listSessions(h, { now: 4000 });
  assert.equal(sessions.length, 2);
  // Both must be clean — the restart is not a crash.
  assert.ok(sessions.every(s => s.endedCleanly === true), 'both sessions ended cleanly');
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
  assert.deepEqual([byId['s-1000'].start, byId['s-1000'].end], [1000, 2000]);
  assert.deepEqual([byId['s-2000'].start, byId['s-2000'].end], [2000, 3000]);
  h.close();
});

test('an open current session: last start with no stop', () => {
  const h = freshHistory('current.db');
  h.recordEvent({ ts: 1000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 1100, app: 'alpha', type: 'status', from: 'starting', to: 'serving' });
  h._flushForTest();
  const sessions = listSessions(h, { now: 5000 });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, 's-1000');
  assert.equal(s.end, null);
  assert.equal(s.current, true);
  assert.equal(s.endedCleanly, null);
  assert.equal(s.durationMs, 4000);
  h.close();
});

test('empty history yields an empty list, not an error', () => {
  const h = freshHistory('empty.db');
  assert.deepEqual(listSessions(h, { now: 1000 }), []);
  assert.deepEqual(deriveBoundaries(h, 1000), []);
  assert.equal(showSession(h, 's-1', 1000), null);
  assert.equal(findSession(h, 's-1', 1000), null);
  assert.deepEqual(listSessions(null, {}), []); // history disabled
  h.close();
});

test('--since filters to sessions overlapping the window', () => {
  const h = freshHistory('since.db');
  seedFourSessions(h);
  // since 4000 keeps C (4000..5000) and D (6000..7000) only.
  const sessions = listSessions(h, { now: 8000, since: 4000 });
  assert.deepEqual(sessions.map(s => s.id).sort(), ['s-4000', 's-6000']);
  h.close();
});

test('show composes blocks scoped to the slice; empty block degrades to a note', () => {
  const h = freshHistory('show.db');
  seedFourSessions(h);
  const now = 8000;

  const b = showSession(h, 's-3000', now); // unclean beta session
  assert.equal(b.id, 's-3000');
  assert.equal(b.endedCleanly, false);
  assert.equal(b.blocks.errors.total, 1);
  assert.equal(b.blocks.crashes.total, 1);
  assert.equal(b.blocks.crashes.last.app, 'beta');
  // No test runs in B → tests block is a note, never an error.
  assert.ok(b.blocks.tests.note, 'tests block degrades to a note');
  assert.ok(b.blocks.compiles.note, 'compiles block degrades to a note');

  // Session C has a compile but no tests.
  const c = showSession(h, 's-4000', now);
  assert.equal(c.blocks.compiles.count, 1);
  assert.ok(c.blocks.tests.note);
  assert.deepEqual(c.blocks.apps.started, ['alpha']);

  // Unknown id → null.
  assert.equal(showSession(h, 's-999999', now), null);
  h.close();
});

test('GET /api/sessions and /api/sessions/<id> serve the derived shapes', async () => {
  const dbPath = path.join(tmp, 'route.db');
  const h = freshHistory('route.db');
  seedFourSessions(h);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 365 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta'), app('gamma')]);
  reg.setHistory(h);
  const server = startServer(reg, 0, { getConfig: () => cfg });
  await new Promise(res => server.once('listening', res));
  const apiPort = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.total, 4);
    assert.ok(body.sessions.every(s => /^s-\d+$/.test(s.id)));

    const show = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/s-3000`);
    assert.equal(show.status, 200);
    const detail = await show.json();
    assert.equal(detail.id, 's-3000');
    assert.equal(detail.blocks.crashes.total, 1);

    const missing = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/s-999999`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).remedy, /lists valid ids/);
  } finally {
    server.close();
    h.close();
  }
});

test('buildSessionContext (M138): same-session other-app errors + env, excludes own', () => {
  const h = freshHistory('ctx.db');
  // One session: web crashes; api errored and env changed before it.
  h.recordEvent({ ts: 1000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 1100, app: 'web', type: 'error-new', message: 'web self error (excluded)' });
  h.recordEvent({ ts: 1200, app: 'api', type: 'error-new', message: 'api upstream down' });
  h.recordEvent({ ts: 1250, app: 'api', type: 'regression-detected', message: JSON.stringify({ kind: 'compile', factor: 3 }) });
  h._flushForTest();
  // Anchor the failure at ts 1300 (web's crash time), inside the open session.
  const ctx = buildSessionContext(h, { app: 'web', ts: 1300, now: 2000 });
  assert.equal(ctx.sessionId, 's-1000');
  assert.equal(ctx.otherAppErrors.length, 1);
  assert.equal(ctx.otherAppErrors[0].app, 'api');
  assert.equal(ctx.regressions.length, 1);
  // web's own error is NOT in the context (it's the rest of the why response).
  assert.ok(!ctx.otherAppErrors.some(e => e.app === 'web'));
  h.close();
});

test('buildSessionContext: quiet session gets a brief note, not fabricated relevance', () => {
  const h = freshHistory('quiet.db');
  h.recordEvent({ ts: 1000, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: 1100, app: 'web', type: 'error-new', message: 'only web' });
  h._flushForTest();
  const ctx = buildSessionContext(h, { app: 'web', ts: 1200, now: 2000 });
  assert.equal(ctx.sessionId, 's-1000');
  assert.ok(!ctx.otherAppErrors);
  assert.match(ctx.note, /nothing else/);
  h.close();
});

test('buildSessionContext: a failure before any session omits with a note', () => {
  const h = freshHistory('pre.db');
  h.recordEvent({ ts: 5000, app: D, type: 'daemon-start' });
  h._flushForTest();
  const ctx = buildSessionContext(h, { app: 'web', ts: 1000, now: 6000 }); // before first start
  assert.equal(ctx.sessionId, null);
  assert.match(ctx.note, /no derivable session/);
  // history disabled → null
  assert.equal(buildSessionContext(null, { app: 'web', ts: 1 }), null);
  h.close();
});

test('bench: session list over a 100k-event corpus in < 300ms', () => {
  const h = freshHistory('bench.db');
  const apps = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const now = Date.now();
  const dayMs = 24 * 3600_000;
  const spanMs = dayMs * 30;
  const types = ['status', 'error-new', 'error-recur'];
  const states = ['serving', 'compiling', 'error', 'starting'];
  // ~50 daemon sessions across the span: a stop+start boundary every ~14.4h.
  const sessionMs = spanMs / 50;
  let nextBoundary = now - spanMs;
  // Open the first session before the corpus begins.
  h.recordEvent({ ts: now - spanMs - 10, app: D, type: 'daemon-start' });
  for (let i = 0; i < 100_000; i++) {
    const ts = now - spanMs + Math.floor((i / 100_000) * spanMs);
    if (ts >= nextBoundary) {
      h.recordEvent({ ts: ts - 2, app: D, type: 'daemon-stop' });
      h.recordEvent({ ts: ts - 1, app: D, type: 'daemon-start' });
      nextBoundary += sessionMs;
    }
    h.recordEvent({
      ts, app: apps[i % apps.length], type: types[i % types.length],
      from: states[i % states.length], to: states[(i + 1) % states.length],
      message: i % 3 === 0 ? `err message ${i % 13}` : undefined,
    });
    if (i % 5000 === 0) h._flushForTest();
  }
  for (let i = 0; i < 10_000; i++) {
    h.recordCompile(apps[i % apps.length], 50 + (i % 5000), now - spanMs + Math.floor((i / 10_000) * spanMs));
    if (i % 2000 === 0) h._flushForTest();
  }
  h._flushForTest();

  // Warm the statement cache, then median of 3 full list passes.
  const warm = listSessions(h, { now });
  assert.ok(warm.length >= 40, `bench corpus derived ${warm.length} sessions`);
  const samples = [];
  for (let pass = 0; pass < 3; pass++) {
    const t0 = performance.now();
    listSessions(h, { now });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[1];
  assert.ok(median < 300, `session-derivation budget: median ${median.toFixed(1)}ms < 300ms (samples: ${samples.map(s => s.toFixed(0)).join(',')})`);
  h.close();
});
