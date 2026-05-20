import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History } from '../dist/history.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-history-'));
  return { dir, file: path.join(dir, 'history.db') };
}

function flushSync(h) {
  return new Promise(r => setTimeout(r, 250));
}

test('bundles table accepts inserts and roundtrips through queryBundles', async () => {
  const { file } = tempDb();
  const h = new History({ enabled: true, path: file, retentionDays: 30 });
  const now = Date.now();
  h.recordBundle('app-a', 120, 80, 12, now - 3600_000);
  h.recordBundle('app-a', 130, 85, 13, now - 1800_000);
  h.recordBundle('app-b', 50, 0, 4, now - 600_000);
  await flushSync(h);
  const all = h.queryBundles({ limit: 100 });
  assert.equal(all.length, 3);
  const appA = h.queryBundles({ app: 'app-a' });
  assert.equal(appA.length, 2);
  assert.equal(appA[0].initialKB, 130);
  h.close();
});

test('trends() aggregates bundle metric into stacked initialKB/lazyKB points', async () => {
  const { file } = tempDb();
  const h = new History({ enabled: true, path: file, retentionDays: 30 });
  const now = Date.now();
  h.recordBundle('app-a', 100, 50, 5, now - 2 * 3600_000);
  h.recordBundle('app-a', 110, 55, 6, now - 1 * 3600_000);
  await flushSync(h);
  const r = h.trends({ app: 'app-a', metric: 'bundle', sinceMs: 24 * 3600_000, bucketMs: 3600_000 });
  assert.ok(r.points.length >= 2);
  assert.ok(typeof r.points[0].v === 'number');
  assert.ok(typeof r.points[0].v2 === 'number');
  h.close();
});

test('trends() counts errors per bucket', async () => {
  const { file } = tempDb();
  const h = new History({ enabled: true, path: file, retentionDays: 30 });
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    h.recordEvent({ ts: now - 30 * 60_000, app: 'x', type: 'error-new', message: 'm' + i });
  }
  for (let i = 0; i < 2; i++) {
    h.recordEvent({ ts: now - 90 * 60_000, app: 'x', type: 'error-recur', message: 'r' + i });
  }
  await flushSync(h);
  const r = h.trends({ app: 'x', metric: 'errors', sinceMs: 24 * 3600_000, bucketMs: 3600_000 });
  const total = r.points.reduce((a, b) => a + b.v, 0);
  assert.equal(total, 7);
  h.close();
});

test('trends() counts restart transitions (error->starting, serving->starting)', async () => {
  const { file } = tempDb();
  const h = new History({ enabled: true, path: file, retentionDays: 30 });
  const now = Date.now();
  h.recordEvent({ ts: now - 60_000, app: 'x', type: 'status', from: 'error', to: 'starting' });
  h.recordEvent({ ts: now - 30_000, app: 'x', type: 'status', from: 'serving', to: 'starting' });
  h.recordEvent({ ts: now - 20_000, app: 'x', type: 'status', from: 'stopped', to: 'starting' });
  await flushSync(h);
  const r = h.trends({ app: 'x', metric: 'restarts', sinceMs: 24 * 3600_000, bucketMs: 3600_000 });
  const total = r.points.reduce((a, b) => a + b.v, 0);
  assert.equal(total, 2);
  h.close();
});
