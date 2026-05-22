import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectCompileRegression, detectBundleRegression, detectErrorFlapRegression, suspectCommitForDir } = await import('../dist/regressions.js');

test('detectCompileRegression flags a >2× spike off the rolling median', () => {
  const prior = Array.from({ length: 15 }, () => 1000); // 1s median
  const r = detectCompileRegression(prior, 2500, 2.0);
  assert.ok(r);
  assert.equal(r.kind, 'compile');
  assert.equal(r.baseline, 1000);
  assert.equal(r.current, 2500);
  assert.ok(r.factor >= 2.0);
});

test('detectCompileRegression returns null when sample size is too small', () => {
  const r = detectCompileRegression([1000, 1100, 1050], 2500, 2.0);
  assert.equal(r, null);
});

test('detectCompileRegression returns null when current is within budget', () => {
  const prior = Array.from({ length: 15 }, () => 1000);
  const r = detectCompileRegression(prior, 1500, 2.0);
  assert.equal(r, null);
});

test('detectBundleRegression flags a >10% jump', () => {
  const r = detectBundleRegression(400, 500, 1.1);
  assert.ok(r);
  assert.equal(r.kind, 'bundle');
  assert.equal(r.baseline, 400);
  assert.equal(r.current, 500);
});

test('detectBundleRegression returns null for small drift', () => {
  assert.equal(detectBundleRegression(400, 410, 1.1), null);
});

test('detectBundleRegression handles missing baseline gracefully', () => {
  assert.equal(detectBundleRegression(undefined, 500, 1.1), null);
  assert.equal(detectBundleRegression(0, 500, 1.1), null);
});

test('detectErrorFlapRegression flags a 3× spike over the 24h baseline', () => {
  // Last 1h: 30 errors. Prior 23h: 23 errors → per-hour baseline = 1.
  const r = detectErrorFlapRegression(30, 23, 'abc123');
  assert.ok(r);
  assert.equal(r.kind, 'error-flap');
  assert.equal(r.fingerprint, 'abc123');
});

test('detectErrorFlapRegression respects the minimum hour-events floor', () => {
  // Only 4 errors this hour — below the 5-event floor.
  assert.equal(detectErrorFlapRegression(4, 23, 'fp'), null);
});

test('suspectCommitForDir returns null for missing dir', () => {
  assert.equal(suspectCommitForDir(null), null);
  assert.equal(suspectCommitForDir(''), null);
  assert.equal(suspectCommitForDir('/this/path/does/not/exist/anywhere'), null);
});
