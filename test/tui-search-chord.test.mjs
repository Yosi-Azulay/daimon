import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';

// M182 (v1.16 "Recall") — the TUI search pane.
//
// Two layers, the repo's TUI test pattern: pure modules for the logic, plus ONE
// real ink render for what pure modules cannot see (a component that throws on
// mount, an empty pane, keys leaking to the app underneath a modal).
//
// The milestone's claim is PARITY: the pane runs the daemon's parser and prints
// the daemon's error text. The render test checks the text a user actually sees.

const { CHORDS, resolveChord, chordsForPane, footerChords, MAIN_CHORD_IDS } = await import('../dist/tui/chords.js');
const {
  jumpTargetFor, clampSel, kindLabel, formatHitRow, savedRows, resultSummary, timeLabel,
} = await import('../dist/tui/searchChord.js');
const { History } = await import('../dist/history.js');
const { parseSearchQuery } = await import('../dist/searchQuery.js');
const { groupErrors, searchErrorGroups } = await import('../dist/errorGroups.js');
const App = (await import('../dist/tui/App.js')).default;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-tuisearch-'));
const now = Date.now();

// ── the chord map ─────────────────────────────────────────────────────────────

test('the search chord is in the map, in the main dispatch table, and collides with nothing', () => {
  const open = CHORDS.find(c => c.id === 'searchOpen');
  assert.ok(open, 'searchOpen is missing from the chord map');
  assert.equal(open.key, 'F');
  assert.deepEqual([...open.panes].sort(), ['detail', 'list']);
  assert.ok(MAIN_CHORD_IDS.includes('searchOpen'), 'App must own the chord (tsc exhaustiveness)');
  // It resolves from both panes, and F meant nothing before v1.16.
  assert.equal(resolveChord('list', 'F', {})?.id, 'searchOpen');
  assert.equal(resolveChord('detail', 'F', {})?.id, 'searchOpen');
  // Muscle memory: lowercase f is still `focus`.
  assert.equal(resolveChord('list', 'f', {})?.id, 'focus');

  // The modal pane's chords exist and no two claim the same key.
  const ids = chordsForPane('search').map(c => c.id);
  for (const id of ['seRun', 'seMove', 'seEdit', 'seClose']) assert.ok(ids.includes(id), `${id} missing`);
  assert.equal(resolveChord('search', '', { escape: true })?.id, 'seClose');
  assert.equal(resolveChord('search', '', { return: true })?.id, 'seRun');
  assert.equal(resolveChord('search', '', { tab: true })?.id, 'seEdit');
  assert.equal(resolveChord('search', '', { upArrow: true })?.id, 'seMove');
  assert.ok(footerChords('search').length >= 4, 'the pane footer renders from the map');
});

// ── pure logic ────────────────────────────────────────────────────────────────

test('every ref shape maps to the surface that can show it; unknown refs degrade', () => {
  const hit = (ref, extra = {}) => ({ kind: 'events', app: 'web', ts: now, snippet: 's', ref, ...extra });
  assert.deepEqual(jumpTargetFor(hit('event:12')), { kind: 'event', id: '12', app: 'web', ts: now, surface: 'timeline' });
  assert.equal(jumpTargetFor(hit('log:7')).surface, 'log');
  assert.equal(jumpTargetFor(hit('test:3')).surface, 'detail');
  assert.equal(jumpTargetFor(hit('errgroup:src/a.ts:4')).id, 'src/a.ts:4', 'a fingerprint with colons survives');
  assert.equal(jumpTargetFor(hit('errgroup:src/a.ts:4')).surface, 'detail');
  // A ref shape from a NEWER daemon must never throw an older TUI.
  assert.equal(jumpTargetFor(hit('galaxy:9')).kind, 'unknown');
  assert.equal(jumpTargetFor(hit('bare')).surface, 'detail');
});

test('rows are width-bounded and control characters can never repaint the pane', () => {
  const hit = { kind: 'logs', app: 'a-very-long-app-name', ts: now, ref: 'log:1', snippet: 'x'.repeat(400) };
  const row = formatHitRow(hit, 80);
  assert.ok(row.length <= 80, `row overflowed: ${row.length}`);
  assert.ok(row.endsWith('…'));
  const nasty = formatHitRow({ ...hit, snippet: 'a\u001b[2Jb\nc' }, 80);
  assert.ok(!/[\u0000-\u001f]/.test(nasty), 'a control character reached the frame');
  assert.equal(kindLabel('error-groups'), 'group');
  assert.equal(timeLabel(Date.UTC(2026, 0, 2, 3, 4, 5)), '03:04:05');
  assert.equal(clampSel(9, 3), 2);
  assert.equal(clampSel(0, 0), -1);
  const rows = savedRows([{ name: 'today', query: 'level:error after:24h', createdMs: 0, updatedMs: 0 }], 60);
  assert.match(rows[0], /^today\s+level:error after:24h$/);
});

test('the summary states the engine honestly — a fallback is never hidden', () => {
  const hits = [{ kind: 'logs', app: 'a', ts: now, ref: 'log:1', snippet: 's' }];
  assert.match(resultSummary(hits, false, { logs: 1 }), /^1 hit {2}log 1$/);
  assert.match(resultSummary(hits, true, { logs: 1 }), /index unavailable/);
  assert.equal(resultSummary([], false), 'no hits');
  assert.match(resultSummary([], true), /index unavailable/);
});

// ── one real render ───────────────────────────────────────────────────────────

class FakeStdout extends EventEmitter {
  constructor(columns = 120, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.frames = [];
    this.isTTY = true;
  }
  write(chunk) { this.frames.push(String(chunk)); return true; }
  get text() { return this.frames.join('').replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.queue = [];
    this.setRawMode = () => this;
    this.resume = () => this;
    this.pause = () => this;
    this.ref = () => this;
    this.unref = () => this;
    this.setEncoding = () => this;
  }
  read() { return this.queue.length ? this.queue.shift() : null; }
  press(seq) { this.queue.push(seq); this.emit('readable'); }
}

const ESC = String.fromCharCode(27);
const KEY = { esc: ESC, enter: '\r', up: ESC + '[A', down: ESC + '[B', tab: '\t' };

const history = new History({ enabled: true, path: path.join(tmp, 'h.db'), retentionDays: 30 });
history.recordEvent({ ts: now - 1000, app: 'web', type: 'error-new', message: 'quokka-marker chunk failed to load' });
history.recordLogLine('web', 'quokka-marker ERROR boom in main.js', now - 900, 'error');
history._flushForTest();

const APP = {
  name: 'web', baseName: 'web', status: 'serving', port: 4200, url: 'http://127.0.0.1:4200',
  errorCount: 1, uptimeMs: 65_000, lastCompileMs: null, health: 'healthy',
  lastHealthAt: null, cpu: 3, memMB: 210, compileHistoryMs: [], tags: [],
  restartAttempts: 0, nextRestartAt: null, announcedUrl: null, lastHealthError: null,
  stale: false, bundle: null, bundleRegressionPct: null, dependsOn: [],
  activeEnvFile: null, workspaceLabel: 'demo', workspaceRoot: 'D:/demo', serverProfile: 'vite',
};

function mount(opts = {}) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const started = [];
  const emitter = new EventEmitter();
  const registry = {
    list: () => [APP],
    events: () => [],
    on: (e, f) => emitter.on(e, f),
    off: (e, f) => emitter.off(e, f),
    getState: () => ({ logBuffer: [], lastStatusMessage: null, sessionOverrides: null, activeEnvFile: null }),
    getConfig: () => ({}),
    getApp: () => APP,
    summary: () => APP,
    isMuted: () => false,
    logStormState: () => ({ active: false, since: null, observedPerMin: 0, baselinePerMin: null, windowSec: 60, multiplier: 10 }),
    activeLogStorms: () => [],
    getHistory: () => history,
    errors: () => [{ message: 'quokka-marker TS2304 boom', count: 2, firstSeen: now - 5000, lastSeen: now - 300, level: 'error' }],
    start: (n) => { started.push(n); },
    stop: () => {}, restart: () => {},
    runTests: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, totals: null }),
    setSessionOverride: () => {}, setActiveEnvFile: () => {},
  };
  const instance = render(
    React.createElement(App, {
      registry, apiPort: 4999, onQuit: () => {},
      getSavedSearches: () => opts.saved ?? [],
    }),
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  return { stdout, stdin, instance, started };
}

const settle = () => new Promise(r => setTimeout(r, 60));

test('F opens the search pane, a syntax query returns the same hits the API would', async () => {
  const { stdout, stdin, instance } = mount();
  await settle();
  stdin.press('F');
  await settle();
  assert.match(stdout.text, /search/, 'the pane did not open');
  assert.match(stdout.text, /app: kind: level: before: after:/, 'the grammar is not offered');

  stdout.frames.length = 0;
  stdin.press('app:web level:error quokka-marker');
  await settle();
  stdin.press(KEY.enter);
  await settle();
  const text = stdout.text;
  instance.unmount();

  // The pane's hits are the daemon's hits: same parser, same compilation, and
  // the same live error-group fold the HTTP route performs.
  const parsed = parseSearchQuery('app:web level:error quokka-marker');
  const fromHistory = history.search({ q: 'app:web level:error quokka-marker', query: parsed.query, scope: 'all', limit: 100 });
  const fromGroups = searchErrorGroups(
    groupErrors([{ app: 'web', errors: [{ message: 'quokka-marker TS2304 boom', count: 2, firstSeen: now - 5000, lastSeen: now - 300, level: 'error' }] }]),
    parsed.query, 100,
  );
  const expectedCount = fromHistory.hits.length + fromGroups.length;
  assert.ok(expectedCount >= 3, 'fixture sanity');
  assert.match(text, new RegExp(`(^|[^0-9])${expectedCount} hits`), `summary missing from:\n${text}`);
  assert.match(text, /quokka-marker/, 'no hit text rendered');
});

test('an unknown field renders the daemon\'s own error inline, and does not crash the pane', async () => {
  const { stdout, stdin, instance } = mount();
  await settle();
  stdin.press('F');
  await settle();
  stdout.frames.length = 0;
  stdin.press('lvl:error boom');
  await settle();
  stdin.press(KEY.enter);
  await settle();
  const text = stdout.text;
  instance.unmount();
  assert.match(text, /unknown field 'lvl:'/, `the parser error is not shown:\n${text}`);
  assert.match(text, /valid fields: app, kind, level, before, after/);
  assert.match(text, /quote the token/, 'the remedy line is missing');
});

test('saved searches are listed and runnable — by a keystroke, never on their own', async () => {
  const saved = [{ name: 'today-errors', query: 'level:error quokka-marker', createdMs: now, updatedMs: now }];
  const { stdout, stdin, instance } = mount({ saved });
  await settle();
  stdin.press('F');
  await settle();
  assert.match(stdout.text, /saved searches/, 'the saved list is not offered');
  assert.match(stdout.text, /today-errors/);
  // Nothing has run yet: a saved search is inert until a human picks it.
  assert.ok(!/hits/.test(stdout.text), 'a saved search ran without being chosen');

  stdout.frames.length = 0;
  stdin.press(KEY.enter);   // run the highlighted saved search
  await settle();
  const text = stdout.text;
  instance.unmount();
  // NOT `/hit/` — that also matches "no hits" — and not the marker alone,
  // which the echoed query line already contains. Assert the real count and a
  // string that appears ONLY in a rendered hit row.
  const savedParsed = parseSearchQuery('level:error quokka-marker');
  const savedFromHistory = history.search({ q: 'level:error quokka-marker', query: savedParsed.query, scope: 'all', limit: 100 });
  const savedFromGroups = searchErrorGroups(
    groupErrors([{ app: 'web', errors: [{ message: 'quokka-marker TS2304 boom', count: 2, firstSeen: now - 5000, lastSeen: now - 300, level: 'error' }] }]),
    savedParsed.query, 100,
  );
  const savedExpected = savedFromHistory.hits.length + savedFromGroups.length;
  assert.ok(savedExpected >= 2, 'fixture sanity');
  assert.match(text, new RegExp(`(^|[^0-9])${savedExpected} hits`), `expected ${savedExpected} hits:\n${text}`);
  assert.match(text, /boom in main|TS2304/, 'no hit ROW rendered — only the echoed query');
});

test('while the search pane is open, its keys never reach the app underneath', async () => {
  const { stdin, instance, started } = mount();
  await settle();
  stdin.press('F');
  await settle();
  // `s` is the START chord in the list pane. Typed into a query it must be a
  // letter and nothing else — this is the bug the modal guard fixes.
  stdin.press('s');
  await settle();
  assert.deepEqual(started, [], 'typing into the search box started an app');

  // POSITIVE CONTROL: without it this also passes if `s` never reaches the
  // list pane's start chord for some unrelated reason.
  stdin.press(KEY.esc);
  await settle();
  stdin.press('s');
  await settle();
  assert.deepEqual(started, ['web'], 'the start chord must work once the modal is closed');
  stdin.press(KEY.esc);
  await settle();
  instance.unmount();
});

test('cleanup', () => {
  history.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
