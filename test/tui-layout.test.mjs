// TUI layout, narrow-terminal degradation, list windowing, status bar
// (v1.13 "Terminal Native", M162 + M166).
//
// All pure geometry — no ink, no terminal — which is the point: the behaviour
// that used to be provable only by squinting at a resized window is now a unit
// test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLayout, windowSlice, positionLabel, statusSegments, renderStatusLine,
  NARROW_COLS, BADGE_MIN_COLS, MINIMAL_COLS,
} from '../dist/tui/layout.js';

// ── pane geometry ─────────────────────────────────────────────────────────────

test('a roomy terminal shows all three panes', () => {
  const l = computeLayout(160, 50, 'list', false);
  assert.equal(l.mode, 'full');
  assert.ok(l.showList && l.showDetail && l.showLog);
  assert.ok(l.leftWidth > 0 && l.leftWidth <= 36, 'list pane keeps its 36-column ceiling');
  assert.ok(l.logRows >= 3, 'the log pane always gets usable rows');
});

test('the list pane never exceeds 36 columns or 40% of the width', () => {
  assert.equal(computeLayout(1000, 50).leftWidth, 36, 'ceiling holds on a very wide terminal');
  assert.equal(computeLayout(100, 50).leftWidth, 40 > 36 ? 36 : 40);
  const narrow = computeLayout(80, 50);
  assert.ok(narrow.leftWidth <= 32, `80 cols should give the list ~40%, got ${narrow.leftWidth}`);
});

test('resize is a pure recompute — the same size always yields the same layout', () => {
  assert.deepEqual(computeLayout(120, 40, 'list', false), computeLayout(120, 40, 'list', false));
  assert.notDeepEqual(computeLayout(120, 40, 'list', false), computeLayout(80, 40, 'list', false));
});

// ── narrow-terminal column priority (M166) ────────────────────────────────────

test('80 columns is a first-class width: cpu/mem drop, nothing else', () => {
  const l = computeLayout(80, 40);
  assert.equal(l.mode, 'narrow');
  assert.equal(l.columns.cpu, false, 'cpu/mem are the first columns to go');
  assert.equal(l.columns.badge, true, 'the framework badge survives at 80 columns');
  assert.equal(l.columns.port, true);
  assert.equal(l.columns.status, true);
  assert.equal(l.columns.ribbon, true);
});

test('columns drop in a fixed priority order as the terminal narrows', () => {
  // 100+: everything. This is the exact `cols >= 100` guard the TUI has shipped
  // since v0.x, kept so existing terminals look identical.
  assert.equal(computeLayout(NARROW_COLS, 40).columns.cpu, true);
  assert.equal(computeLayout(NARROW_COLS - 1, 40).columns.cpu, false);
  // Badge goes next, below 80.
  assert.equal(computeLayout(BADGE_MIN_COLS, 40).columns.badge, true);
  assert.equal(computeLayout(BADGE_MIN_COLS - 1, 40).columns.badge, false);
  // Status is never dropped — it is the reason the row exists.
  for (const c of [200, 100, 80, 70, 60, 50, 40, 24]) {
    assert.equal(computeLayout(c, 40).columns.status, true, `status column dropped at ${c} cols`);
  }
});

test('below 60 columns the layout collapses to one pane instead of corrupting two', () => {
  const l = computeLayout(MINIMAL_COLS - 1, 40, 'list', false);
  assert.equal(l.mode, 'minimal');
  assert.equal(l.showList, true);
  assert.equal(l.showDetail, false);
  assert.equal(l.showLog, false);
  // ...and the focused pane is the one that shows, so Tab still reaches all three.
  assert.equal(computeLayout(50, 40, 'log', false).showLog, true);
  assert.equal(computeLayout(50, 40, 'log', false).showList, false);
  assert.equal(computeLayout(50, 40, 'detail', false).showDetail, true);
});

test('minimal mode shrinks the name column rather than letting rows wrap', () => {
  // A row costs roughly: marker(2) + name + status(9) + health(1) + port(6).
  // The name column is what gives, and only once the row would actually
  // overflow — at 50 columns a full 20-char name still fits.
  const FIXED = 18;
  for (const cols of [50, 44, 38, 32, 24]) {
    const l = computeLayout(cols, 40, 'list', false);
    assert.ok(l.nameWidth >= 8, `name column collapsed to ${l.nameWidth} at ${cols} cols`);
    assert.ok(
      l.nameWidth + FIXED <= Math.max(cols, 26),
      `at ${cols} cols the row needs ${l.nameWidth + FIXED} columns and would wrap`,
    );
  }
  // It genuinely shrinks once the terminal is narrow enough to demand it.
  assert.ok(
    computeLayout(30, 40, 'list', false).nameWidth < computeLayout(50, 40, 'list', false).nameWidth,
    'the name column must shrink as the terminal narrows',
  );
  assert.equal(computeLayout(50, 40, 'list', false).columns.ribbon, false,
    'the sparkline row is dropped in minimal mode');
});

test('degenerate sizes never produce a negative or zero-row pane', () => {
  for (const [c, r] of [[0, 0], [1, 1], [10, 4], [-5, -5], [NaN, NaN]]) {
    const l = computeLayout(c, r);
    assert.ok(l.cols >= 20, `cols floor breached at ${c}`);
    assert.ok(l.rows >= 8, `rows floor breached at ${r}`);
    assert.ok(l.logRows >= 3, 'log pane starved');
    assert.ok(l.listRows >= 3, 'list pane starved');
  }
});

test('maximizing the log gives it every row and hides the other panes', () => {
  const l = computeLayout(120, 40, 'log', true);
  assert.equal(l.showLog, true);
  assert.equal(l.showList, false);
  assert.equal(l.showDetail, false);
  assert.ok(l.logRows > computeLayout(120, 40, 'log', false).logRows, 'maximize must grow the log pane');
});

// ── windowed list scrolling (M166) ────────────────────────────────────────────

test('a list shorter than the viewport renders whole', () => {
  assert.deepEqual(windowSlice(5, 0, 20), { start: 0, end: 5 });
  assert.deepEqual(windowSlice(0, 0, 20), { start: 0, end: 0 });
});

test('a 100-app registry renders one viewport, not 100 rows', () => {
  const w = windowSlice(100, 0, 10);
  assert.equal(w.end - w.start, 10, 'exactly one viewport is rendered');
});

test('the selection is always inside the window, walking 0 → 99', () => {
  const total = 100, vp = 10;
  for (let sel = 0; sel < total; sel++) {
    const w = windowSlice(total, sel, vp);
    assert.ok(sel >= w.start && sel < w.end, `selection ${sel} fell outside window ${w.start}..${w.end}`);
    assert.equal(w.end - w.start, vp, `window changed size at ${sel}`);
    assert.ok(w.start >= 0 && w.end <= total, `window ${w.start}..${w.end} out of bounds`);
  }
});

test('the window pins at both ends rather than scrolling past them', () => {
  assert.deepEqual(windowSlice(100, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(windowSlice(100, 99, 10), { start: 90, end: 100 });
});

test('an out-of-range selection is clamped, not crashed', () => {
  assert.deepEqual(windowSlice(10, 999, 5), { start: 5, end: 10 });
  assert.deepEqual(windowSlice(10, -5, 5), { start: 0, end: 5 });
});

test('positionLabel reads 1-based like a human counts', () => {
  assert.equal(positionLabel(0, 40), '1/40');
  assert.equal(positionLabel(2, 40), '3/40');
  assert.equal(positionLabel(39, 40), '40/40');
  assert.equal(positionLabel(0, 0), '0/0');
  assert.equal(positionLabel(99, 10), '10/10', 'an over-range selection still reads sanely');
});

// ── status bar (M162) ─────────────────────────────────────────────────────────

const BASE = {
  apiPort: 4999, workspace: null, nameFilter: '', tagFilter: [], groupFilter: null,
  mutedCount: 0, stormCount: 0, appCount: 3, visibleCount: 3, flash: null,
};

test('the status bar always names the daemon and its port', () => {
  const segs = statusSegments(BASE);
  assert.match(segs[0].text, /daimon/);
  assert.match(segs[0].text, /4999/);
  assert.equal(segs[0].tone, 'good');
});

test('an erroring app marks the daemon degraded', () => {
  const segs = statusSegments({ ...BASE, degraded: true });
  assert.equal(segs[0].tone, 'warn');
  assert.ok(segs.some(s => s.text === 'degraded'));
});

test('active filters are named, with a visible/total count', () => {
  const segs = statusSegments({
    ...BASE, nameFilter: 'web', tagFilter: ['api', 'ui'], groupFilter: 'stack', visibleCount: 1,
  });
  const text = segs.map(s => s.text).join(' ');
  assert.match(text, /\/web/);
  assert.match(text, /tags:api,ui/);
  assert.match(text, /group:stack/);
  assert.match(text, /1\/3/, 'a filtered list shows how much it is hiding');
});

test('with no filters the bar shows a plain app count, not a x/x fraction', () => {
  const text = statusSegments(BASE).map(s => s.text).join(' ');
  assert.match(text, /3 apps/);
  assert.doesNotMatch(text, /3\/3/);
  assert.match(statusSegments({ ...BASE, appCount: 1, visibleCount: 1 }).map(s => s.text).join(' '), /1 app\b/);
});

test('muted and storm counts appear only when non-zero', () => {
  const quiet = statusSegments(BASE).map(s => s.text).join(' ');
  assert.doesNotMatch(quiet, /muted/);
  assert.doesNotMatch(quiet, /storm/);
  const loud = statusSegments({ ...BASE, mutedCount: 2, stormCount: 1 });
  assert.ok(loud.some(s => s.text === 'muted:2'));
  assert.ok(loud.some(s => /storm:1/.test(s.text) && s.tone === 'warn'));
});

test('a flash message is appended, never replacing the permanent state', () => {
  const segs = statusSegments({ ...BASE, flash: 'restarted web' });
  assert.equal(segs[segs.length - 1].text, 'restarted web');
  assert.match(segs[0].text, /daimon/, 'the daemon segment survives a flash');
});

test('the status line is truncated to the terminal width and never wraps', () => {
  const segs = statusSegments({ ...BASE, workspace: 'a'.repeat(200), flash: 'b'.repeat(200) });
  const line = renderStatusLine(segs, 80);
  assert.ok(line.length <= 80, `status line is ${line.length} chars, would wrap an 80-column terminal`);
  assert.match(line, /…$/, 'truncation is marked');
  // A line that fits is left alone.
  assert.doesNotMatch(renderStatusLine(statusSegments(BASE), 200), /…/);
});
