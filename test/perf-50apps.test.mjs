import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History } from '../dist/history.js';

// M54 — perf at scale. Synthesises a power-user workspace (50 apps, 100k
// events, 30d retention) and measures the hot paths the dashboard + agents
// hammer. Budgets come from the v0.10 plan: apps<200ms, cwd<250ms,
// timeline<300ms, doctor<500ms, SSE catchup<1s, RSS<150MB.

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-perf-50apps-'));
  return path.join(dir, 'history.db');
}

const APPS_N = 50;
const EVENTS_N = 100_000;
const COMPILES_N = 20_000;
const BUNDLES_N = 5_000;
const dayMs = 24 * 60 * 60 * 1000;

function seedCorpus(h) {
  const apps = Array.from({ length: APPS_N }, (_, i) => `app-${String(i).padStart(2, '0')}`);
  const types = ['status', 'error-new', 'error-recur', 'warning-new', 'health'];
  const states = ['serving', 'compiling', 'error', 'starting', 'stopped'];
  const now = Date.now();
  for (let i = 0; i < EVENTS_N; i++) {
    const ts = now - Math.floor((i / EVENTS_N) * 30 * dayMs);
    h.recordEvent({
      ts,
      app: apps[i % APPS_N],
      type: types[i % types.length],
      from: states[i % states.length],
      to: states[(i + 1) % states.length],
      message: i % 11 === 0 ? `note ${i % 17}` : undefined,
    });
    if (i % 5000 === 0) h._flushForTest?.();
  }
  for (let i = 0; i < COMPILES_N; i++) {
    const ts = now - Math.floor((i / COMPILES_N) * 30 * dayMs);
    h.recordCompile(apps[i % APPS_N], 800 + (i % 4000), ts);
    if (i % 5000 === 0) h._flushForTest?.();
  }
  for (let i = 0; i < BUNDLES_N; i++) {
    const ts = now - Math.floor((i / BUNDLES_N) * 30 * dayMs);
    h.recordBundle(apps[i % APPS_N], 300 + (i % 200), 80 + (i % 60), 24, ts);
    if (i % 1000 === 0) h._flushForTest?.();
  }
  h._flushForTest?.();
  return apps;
}

function rssMB() {
  return process.memoryUsage().rss / (1024 * 1024);
}

test('perf-50apps: history hot paths fit the v0.10 budgets', () => {
  const dbPath = tempDbPath();
  const h = new History({ enabled: true, path: dbPath, retentionDays: 30 });
  try {
    const apps = seedCorpus(h);

    // Per-app events query (filtered by ts+app) approximates GET /api/apps?cwd=
    // and GET /api/history/timeline?since=24h. Budget: 250ms.
    const samples = [];
    for (let pass = 0; pass < 5; pass++) {
      for (const a of apps) {
        const t0 = performance.now();
        const rows = h.queryEvents({ app: a, since: Date.now() - dayMs, limit: 500 });
        const dt = performance.now() - t0;
        samples.push(dt);
        assert.ok(Array.isArray(rows));
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor((samples.length - 1) * 0.95)];
    assert.ok(p95 < 250, `events query p95 ${p95.toFixed(1)}ms should be <250ms`);

    // Timeline assemble for the 24h window across ALL apps. Budget: 300ms.
    const tl0 = performance.now();
    const timeline = h.queryTimeline({ since: Date.now() - dayMs, limit: 5000 });
    const tlMs = performance.now() - tl0;
    assert.ok(Array.isArray(timeline));
    assert.ok(tlMs < 300, `timeline 24h ${tlMs.toFixed(1)}ms should be <300ms`);

    // Summary-style queries (used by daimon doctor + dashboard cards). Budget: 500ms total.
    const dr0 = performance.now();
    for (const a of apps) {
      const s = h.summary(a);
      assert.ok(s);
    }
    const drMs = performance.now() - dr0;
    assert.ok(drMs < 500, `50× summary() doctor-ish pass ${drMs.toFixed(1)}ms should be <500ms`);

    // SSE catch-up: simulate fetching the last 5s of events + serializing
    // (what `?stream=ndjson` does on reconnect). Budget: 1s.
    const sse0 = performance.now();
    const recent = h.queryEvents({ since: Date.now() - 5000, limit: 1000 });
    for (const r of recent) JSON.stringify(r);
    const sseMs = performance.now() - sse0;
    assert.ok(sseMs < 1000, `SSE catchup ${sseMs.toFixed(1)}ms should be <1000ms`);

    // RSS budget: 150MB total after seeding the corpus and exercising the hot
    // paths. Generous; meant to catch obvious leaks.
    const rss = rssMB();
    assert.ok(rss < 150, `RSS ${rss.toFixed(1)}MB should be <150MB`);
  } finally {
    h.close();
  }
});
