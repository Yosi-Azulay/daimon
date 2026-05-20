import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRibbon, renderRibbon, ribbonCounts, RIBBON_BUCKETS, RIBBON_WINDOW_MS } from '../dist/tui/ribbon.js';

const now = 1_700_000_000_000;

function ev(t, app, to, from = 'stopped') {
  return { ts: t, app, type: 'status', from, to };
}

test('ribbon has RIBBON_BUCKETS cells', () => {
  const ticks = computeRibbon([], 'x', now);
  assert.equal(ticks.length, RIBBON_BUCKETS);
  for (const t of ticks) assert.equal(t, '');
});

test('events outside the 60-min window are excluded', () => {
  const old = ev(now - 2 * RIBBON_WINDOW_MS, 'x', 'serving');
  const future = ev(now + 1000, 'x', 'error');
  const inWindow = ev(now - 1000, 'x', 'serving');
  const ticks = computeRibbon([old, future, inWindow], 'x', now);
  assert.equal(ticks.filter(t => t).length, 1);
  assert.equal(ticks[RIBBON_BUCKETS - 1], 'serving');
});

test('error wins over serving when same bucket', () => {
  const a = ev(now - 1000, 'x', 'serving');
  const b = ev(now - 500, 'x', 'error');
  const ticks = computeRibbon([a, b], 'x', now);
  assert.equal(ticks[RIBBON_BUCKETS - 1], 'error');
});

test('only events for the requested app are counted', () => {
  const ev1 = ev(now - 1000, 'a', 'serving');
  const ev2 = ev(now - 1000, 'b', 'error');
  const ticksA = computeRibbon([ev1, ev2], 'a', now);
  const ticksB = computeRibbon([ev1, ev2], 'b', now);
  assert.equal(ticksA.filter(t => t).length, 1);
  assert.equal(ticksB.filter(t => t).length, 1);
  assert.equal(ticksA[RIBBON_BUCKETS - 1], 'serving');
  assert.equal(ticksB[RIBBON_BUCKETS - 1], 'error');
});

test('renderRibbon produces RIBBON_BUCKETS glyphs', () => {
  const ticks = new Array(RIBBON_BUCKETS).fill('');
  ticks[0] = 'serving';
  ticks[1] = 'error';
  ticks[2] = 'compiling';
  const s = renderRibbon(ticks);
  assert.equal(s.length, RIBBON_BUCKETS);
  assert.equal(s[0], '▓');
  assert.equal(s[1], '█');
  assert.equal(s[2], '▒');
  assert.equal(s[3], '·');
});

test('ribbonCounts sums states', () => {
  const c = ribbonCounts(['serving', 'serving', 'error', '', 'compiling']);
  assert.equal(c.serving, 2);
  assert.equal(c.error, 1);
  assert.equal(c.compiling, 1);
});
