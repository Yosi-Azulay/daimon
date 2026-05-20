import { test } from 'node:test';
import assert from 'node:assert/strict';

const { SelfMetricsCollector } = await import('../dist/selfMetrics.js');

test('SelfMetricsCollector.snapshot returns plausible runtime metrics', () => {
  const c = new SelfMetricsCollector(null);
  try {
    const s = c.snapshot();
    assert.equal(s.pid, process.pid);
    assert.ok(typeof s.version === 'string' && s.version.length > 0);
    assert.ok(s.uptimeMs >= 0);
    assert.ok(s.rssMB > 0, `rssMB should be >0 (got ${s.rssMB})`);
    assert.ok(s.heapUsedMB > 0, `heapUsedMB should be >0 (got ${s.heapUsedMB})`);
    assert.ok(s.heapTotalMB >= s.heapUsedMB);
    assert.ok(s.eventLoopLagMs >= 0);
    assert.ok(s.historyDbQueryMs && typeof s.historyDbQueryMs.p95 === 'number');
    assert.ok(s.tickIntervalMs > 0);
  } finally {
    c.stop();
  }
});

test('recordQueryMs feeds the p50/p95/p99 percentiles', () => {
  const c = new SelfMetricsCollector(null);
  try {
    for (let i = 1; i <= 100; i++) c.recordQueryMs(i);
    const s = c.snapshot();
    assert.ok(s.historyDbQueryMs.p50 >= 49 && s.historyDbQueryMs.p50 <= 51);
    assert.ok(s.historyDbQueryMs.p95 >= 94 && s.historyDbQueryMs.p95 <= 96);
    assert.ok(s.historyDbQueryMs.p99 >= 98 && s.historyDbQueryMs.p99 <= 100);
  } finally {
    c.stop();
  }
});

test('SelfMetricsCollector setSelfWarnHandler is wired (smoke)', () => {
  const c = new SelfMetricsCollector(null);
  let called = false;
  c.setSelfWarnHandler(() => { called = true; });
  // We can't easily simulate event-loop lag in a unit test without async churn, so this is
  // just a smoke test that the setter does not throw and the snapshot still works after.
  void called;
  assert.equal(typeof c.snapshot().eventLoopLagP95Ms, 'number');
  c.stop();
});
