import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_CHORD_KEY,
  TEST_CHORD_HELP,
  canStartTestRun,
  formatTestSummary,
} from '../dist/tui/testChord.js';

test('chord key is a single free letter and is advertised in the help ribbon', () => {
  assert.equal(TEST_CHORD_KEY, 'T');
  assert.equal(TEST_CHORD_KEY.length, 1);
  assert.match(TEST_CHORD_HELP, /\[T\]/);
  assert.match(TEST_CHORD_HELP.toLowerCase(), /test/);
});

test('canStartTestRun: no-op guard while a run is already in flight', () => {
  assert.equal(canStartTestRun(false), true);
  assert.equal(canStartTestRun(true), false);
});

test('formatTestSummary: all-pass summary', () => {
  const s = formatTestSummary({
    exitCode: 0,
    timedOut: false,
    durationMs: 3100,
    totals: { total: 42, passed: 42, failed: 0, skipped: 0, durationMs: 3100 },
  });
  assert.equal(s, '✓ 42/42 in 3.1s');
});

test('formatTestSummary: failing summary', () => {
  const s = formatTestSummary({
    exitCode: 1,
    timedOut: false,
    durationMs: 12400,
    totals: { total: 42, passed: 39, failed: 3, skipped: 0, durationMs: 12400 },
  });
  assert.equal(s, '✗ 3 failed / 42 in 12.4s');
});

test('formatTestSummary: resolver/runner error', () => {
  const s = formatTestSummary({ error: 'no test runner detected', hint: 'add a test script' });
  assert.equal(s, 'tests: no test runner detected');
});

test('formatTestSummary: timeout with no totals falls back cleanly', () => {
  const s = formatTestSummary({ exitCode: null, timedOut: true, durationMs: 300000, totals: null });
  assert.equal(s, 'tests: timed out after 300.0s');
});

test('formatTestSummary: exit code fallback when a runner reports no totals', () => {
  const pass = formatTestSummary({ exitCode: 0, timedOut: false, durationMs: 800, totals: null });
  const fail = formatTestSummary({ exitCode: 1, timedOut: false, durationMs: 800, totals: null });
  assert.equal(pass, '✓ exit 0 in 0.8s');
  assert.equal(fail, '✗ exit 1 in 0.8s');
});
