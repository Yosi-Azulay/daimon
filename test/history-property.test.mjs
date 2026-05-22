import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { History } = await import('../dist/history.js');

function tempDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `daimon-hprop-${label}-`));
  return path.join(dir, 'history.db');
}

// Property: every event recorded should be retrievable for the same app and
// not leak into a sibling app's filter. Scan a small random corpus.
test('history.queryEvents respects the app filter (no leaks)', () => {
  const h = new History({ enabled: true, path: tempDbPath('leak'), retentionDays: 30 });
  const apps = ['alpha', 'beta', 'gamma'];
  const counts = { alpha: 0, beta: 0, gamma: 0 };
  for (let i = 0; i < 200; i++) {
    const a = apps[i % apps.length];
    h.recordEvent({ ts: Date.now() - i, app: a, type: i % 2 ? 'status' : 'error-new', message: `msg-${i}` });
    counts[a]++;
  }
  h._flushForTest?.();
  for (const a of apps) {
    const rows = h.queryEvents({ app: a, limit: 500 });
    assert.equal(rows.length, counts[a], `app ${a} count`);
    assert.ok(rows.every(r => r.app === a), `every row for ${a} is scoped to ${a}`);
  }
  h.close();
});

test('history.queryCompiles respects the app filter', () => {
  const h = new History({ enabled: true, path: tempDbPath('compiles'), retentionDays: 30 });
  for (let i = 0; i < 100; i++) {
    h.recordCompile(i % 2 ? 'a' : 'b', 500 + i, Date.now() - i);
  }
  h._flushForTest?.();
  const a = h.queryCompiles({ app: 'a', limit: 500 });
  const b = h.queryCompiles({ app: 'b', limit: 500 });
  assert.equal(a.length, 50);
  assert.equal(b.length, 50);
  assert.ok(a.every(r => r.app === 'a'));
  assert.ok(b.every(r => r.app === 'b'));
  h.close();
});

test('history.queryBundles respects the app filter', () => {
  const h = new History({ enabled: true, path: tempDbPath('bundles'), retentionDays: 30 });
  for (let i = 0; i < 60; i++) h.recordBundle(i % 2 ? 'a' : 'b', 200 + i, 30, 5, Date.now() - i);
  h._flushForTest?.();
  const a = h.queryBundles({ app: 'a' });
  const b = h.queryBundles({ app: 'b' });
  assert.ok(a.every(r => r.app === 'a'));
  assert.ok(b.every(r => r.app === 'b'));
  h.close();
});

test('history.queryTimeline contains rows for every kind that was recorded', () => {
  const h = new History({ enabled: true, path: tempDbPath('tl'), retentionDays: 30 });
  const now = Date.now();
  h.recordEvent({ ts: now, app: 'a', type: 'status', from: 'starting', to: 'serving' });
  h.recordEvent({ ts: now - 1, app: 'a', type: 'error-new', message: 'oops' });
  h.recordEvent({ ts: now - 2, app: 'a', type: 'health', from: 'unknown', to: 'healthy' });
  h.recordCompile('a', 1500, now - 3);
  h.recordBundle('a', 320, 80, 12, now - 4);
  h._flushForTest?.();
  const tl = h.queryTimeline({ app: 'a', since: now - 1000, limit: 100 });
  const kinds = new Set(tl.map(r => r.kind));
  assert.ok(kinds.has('status'));
  assert.ok(kinds.has('error'));
  assert.ok(kinds.has('health'));
  assert.ok(kinds.has('compile'));
  assert.ok(kinds.has('bundle'));
  h.close();
});

test('history.trends bucket boundaries are stable (24h hourly)', () => {
  const h = new History({ enabled: true, path: tempDbPath('trends'), retentionDays: 30 });
  const hour = 3600 * 1000;
  const now = Date.now();
  for (let k = 0; k < 24; k++) {
    h.recordCompile('a', 1000 + k, now - k * hour);
  }
  h._flushForTest?.();
  const r = h.trends({ app: 'a', metric: 'compile', sinceMs: 24 * hour, bucketMs: hour });
  // Each bucket should be aligned to hour-of-epoch boundaries.
  for (const p of r.points) assert.equal(p.t % hour, 0, `bucket ${p.t} not aligned to ${hour}`);
  h.close();
});

test('history.queryEvents respects since/until window', () => {
  const h = new History({ enabled: true, path: tempDbPath('window'), retentionDays: 30 });
  const now = Date.now();
  for (let i = 0; i < 100; i++) {
    h.recordEvent({ ts: now - i * 1000, app: 'a', type: 'status' });
  }
  h._flushForTest?.();
  const last30 = h.queryEvents({ app: 'a', since: now - 30_000, limit: 500 });
  assert.ok(last30.length <= 31);
  assert.ok(last30.every(r => r.ts >= now - 30_000));
  h.close();
});

test('history.summary returns sensible numeric fields', () => {
  const h = new History({ enabled: true, path: tempDbPath('summary'), retentionDays: 30 });
  const now = Date.now();
  for (let i = 0; i < 50; i++) h.recordCompile('a', 800 + (i % 200), now - i * 1000);
  for (let i = 0; i < 10; i++) h.recordEvent({ ts: now - i, app: 'a', type: 'error-new', message: 'x' });
  h._flushForTest?.();
  const s = h.summary('a');
  assert.ok(typeof s.uptimePct24h === 'number');
  assert.ok(typeof s.restartCount24h === 'number');
  assert.ok(s.compileP50 != null);
  assert.ok(s.compileP95 != null);
  assert.ok(Array.isArray(s.topErrors));
  h.close();
});

test('history.queryTimeline kinds filter narrows result', () => {
  const h = new History({ enabled: true, path: tempDbPath('kinds'), retentionDays: 30 });
  const now = Date.now();
  h.recordEvent({ ts: now, app: 'a', type: 'status', from: 'starting', to: 'serving' });
  h.recordEvent({ ts: now - 1, app: 'a', type: 'error-new', message: 'err' });
  h.recordCompile('a', 1000, now - 2);
  h._flushForTest?.();
  const justStatus = h.queryTimeline({ app: 'a', since: now - 1000, kinds: new Set(['status']) });
  assert.ok(justStatus.every(r => r.kind === 'status'));
  const justCompile = h.queryTimeline({ app: 'a', since: now - 1000, kinds: new Set(['task']) });
  // 'task' kind in queryTimeline includes both task-runs and compiles
  assert.ok(justCompile.some(r => r.kind === 'compile' || r.kind === 'task'));
  h.close();
});

test('history.queryEvents type filter scopes to one event type', () => {
  const h = new History({ enabled: true, path: tempDbPath('typef'), retentionDays: 30 });
  h.recordEvent({ ts: Date.now(), app: 'a', type: 'error-new', message: 'e' });
  h.recordEvent({ ts: Date.now() - 1, app: 'a', type: 'status', to: 'serving' });
  h._flushForTest?.();
  const errs = h.queryEvents({ app: 'a', type: 'error-new', limit: 50 });
  assert.ok(errs.length >= 1);
  assert.ok(errs.every(r => r.type === 'error-new'));
  h.close();
});

test('history rejects retention pruning on closed db without throwing', () => {
  const h = new History({ enabled: true, path: tempDbPath('closed'), retentionDays: 30 });
  h.recordEvent({ ts: Date.now(), app: 'a', type: 'status' });
  h._flushForTest?.();
  h.close();
  // Subsequent queries return empty arrays, no throw.
  assert.deepEqual(h.queryEvents({ app: 'a' }), []);
});
