// The TUI re-render budget (v1.13 "Terminal Native", M166).
//
// Every release through v1.12 ran an unconditional 1-second interval that
// re-rendered the entire component tree — 60 full-tree renders a minute on a
// completely idle registry, which is what made the panes flicker over SSH. The
// registry already emits 'change' and 'event', so updates are change-driven now
// and the only surviving timer refreshes derived clock values (uptime).
//
// This file pins that so a future edit cannot quietly walk the tick back down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IDLE_TICK_MS, LEGACY_TICK_MS, IDLE_RENDER_BUDGET_PER_MIN,
  idleRendersPerMinute, withinIdleBudget,
} from '../dist/tui/renderBudget.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the idle tick is within budget and strictly better than what v1.12 shipped', () => {
  assert.ok(withinIdleBudget(IDLE_TICK_MS), `idle tick ${IDLE_TICK_MS}ms exceeds the render budget`);
  assert.ok(
    idleRendersPerMinute(IDLE_TICK_MS) < idleRendersPerMinute(LEGACY_TICK_MS),
    'the new tick must be slower than v1.12’s 1s full-tree interval',
  );
  assert.equal(idleRendersPerMinute(LEGACY_TICK_MS), 60, 'v1.12 baseline: 60 idle renders/min');
  assert.ok(
    idleRendersPerMinute(IDLE_TICK_MS) <= IDLE_RENDER_BUDGET_PER_MIN,
    `idle renders/min is ${idleRendersPerMinute(IDLE_TICK_MS)}, budget is ${IDLE_RENDER_BUDGET_PER_MIN}`,
  );
});

test('the budget is a real improvement, not a rounding error', () => {
  const before = idleRendersPerMinute(LEGACY_TICK_MS);
  const after = idleRendersPerMinute(IDLE_TICK_MS);
  assert.ok(after * 4 <= before, `expected at least a 4× reduction, got ${before} → ${after}`);
});

test('idleRendersPerMinute is honest about a disabled timer', () => {
  assert.equal(idleRendersPerMinute(0), Infinity);
  assert.equal(idleRendersPerMinute(-1), Infinity);
  assert.equal(idleRendersPerMinute(60_000), 1);
});

test('the TUI actually uses the budgeted constant — not a literal of its own', () => {
  // The budget is only meaningful if App.tsx's interval is IDLE_TICK_MS. Grep
  // the compiled root: it must import the constant and must NOT re-introduce a
  // bare 1000ms interval.
  const app = fs.readFileSync(path.join(repoRoot, 'dist', 'tui', 'App.js'), 'utf8');
  assert.match(app, /IDLE_TICK_MS/, 'App.js no longer references IDLE_TICK_MS — the budget is decorative');
  assert.match(app, /renderBudget\.js/, 'App.js does not import the render-budget policy');
  assert.doesNotMatch(
    app, /setInterval\([^,]+,\s*1000\s*\)/,
    'App.js re-introduced a 1s full-tree interval — that is the flicker bug v1.13 fixed',
  );
});

test('the TUI keeps exactly one interval', () => {
  // "The digest is not a cron engine" applied to the TUI: one timer, not a
  // family of them. (setTimeout is fine — those are one-shot flash/chord
  // expiries, not repeating render drivers.)
  const app = fs.readFileSync(path.join(repoRoot, 'dist', 'tui', 'App.js'), 'utf8');
  const intervals = app.match(/setInterval\(/g) ?? [];
  assert.equal(intervals.length, 1, `App.js has ${intervals.length} intervals; the TUI budget allows exactly 1`);
});

test('updates are change-driven: the TUI still subscribes to the registry', () => {
  // The tick got slower, so correctness now depends on the event subscriptions
  // actually being there. If someone removes them, the UI would go stale for up
  // to IDLE_TICK_MS instead of updating instantly.
  const app = fs.readFileSync(path.join(repoRoot, 'dist', 'tui', 'App.js'), 'utf8');
  assert.match(app, /registry\.on\(['"]change['"]/, 'the TUI must re-render on registry change');
  assert.match(app, /registry\.on\(['"]event['"]/, 'the TUI must re-render on registry events');
  assert.match(app, /registry\.off\(['"]change['"]/, 'the change listener must be cleaned up');
  assert.match(app, /registry\.off\(['"]event['"]/, 'the event listener must be cleaned up');
});

test('resize re-layouts immediately rather than waiting for the tick', () => {
  // With a 5s tick, waiting for it after a resize would leave the panes wrong
  // for whole seconds. The TUI listens for the resize signal directly.
  const app = fs.readFileSync(path.join(repoRoot, 'dist', 'tui', 'App.js'), 'utf8');
  assert.match(app, /['"]resize['"]/, 'the TUI does not listen for terminal resize');
});
