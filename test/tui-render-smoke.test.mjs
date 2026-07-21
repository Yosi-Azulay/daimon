// A real render of the redesigned TUI (v1.13 "Terminal Native", M162).
//
// Every other TUI test in this repo is a pure-module test — deliberately, since
// that is the pattern that avoids an ink test harness dependency. But pure
// modules cannot catch a component that throws on mount, a prop spread that
// ink rejects, or a pane that renders empty. This file mounts the ACTUAL App
// with ink against a fake stdout and reads the frame back, so "the layout
// works" is a verified claim rather than an inferred one.
//
// No new dependency: ink is already a runtime dependency, and a fake stdout is
// a dozen lines of EventEmitter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';

import App from '../dist/tui/App.js';

// ── a fake terminal ───────────────────────────────────────────────────────────

class FakeStdout extends EventEmitter {
  constructor(columns = 120, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.frames = [];
    this.isTTY = true;
  }
  write(chunk) { this.frames.push(String(chunk)); return true; }
  get lastFrame() { return this.frames[this.frames.length - 1] ?? ''; }
  get text() { return stripAnsi(this.frames.join('')); }
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

// A fake TTY stdin so chords can actually be pressed.
//
// ink gates useInput on `stdin.isTTY`, and then reads input the pull way: it
// attaches a 'readable' listener and drains `stdin.read()` in a loop (see
// ink/build/components/App.js handleSetRawMode / handleReadable). Emitting
// 'data' does nothing — hence the queue below.
class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.queue = [];
    this.encoding = null;
    this.setRawMode = () => this;
    this.resume = () => this;
    this.pause = () => this;
    this.ref = () => this;
    this.unref = () => this;
    this.setEncoding = enc => { this.encoding = enc; return this; };
  }
  read() { return this.queue.length ? this.queue.shift() : null; }
  press(seq) { this.queue.push(seq); this.emit('readable'); }
}

const ESC = String.fromCharCode(27);
const KEY = { tab: '\t', esc: ESC, up: ESC + '[A', down: ESC + '[B' };

// ── a synthetic registry ──────────────────────────────────────────────────────
// The same shape App consumes, with none of the daemon behind it. Tests never
// start a real daemon (the repo rule) — this keeps that true.

function makeRegistry(apps, opts = {}) {
  const emitter = new EventEmitter();
  const states = new Map();
  for (const a of apps) {
    states.set(a.name, {
      logBuffer: opts.logBuffer ?? [],
      lastStatusMessage: null,
      sessionOverrides: null,
      activeEnvFile: null,
    });
  }
  return {
    list: () => apps,
    events: () => opts.events ?? [],
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
    getState: name => states.get(name) ?? null,
    getConfig: () => opts.config ?? {},
    getApp: name => apps.find(a => a.name === name) ?? null,
    summary: name => apps.find(a => a.name === name) ?? null,
    isMuted: name => (opts.muted ?? []).includes(name),
    logStormState: name => ({
      active: (opts.storming ?? []).includes(name),
      since: null, observedPerMin: 0, baselinePerMin: null, windowSec: 60, multiplier: 10,
    }),
    activeLogStorms: () => (opts.storming ?? []).map(app => ({ app, state: { active: true } })),
    getHistory: () => null,
    start: () => {}, stop: () => {}, restart: () => {},
    runTests: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, totals: null }),
    setSessionOverride: () => {}, setActiveEnvFile: () => {},
    _emit: (ev, payload) => emitter.emit(ev, payload),
  };
}

function app(name, over = {}) {
  return {
    name, baseName: name, status: 'serving', port: 4200, url: `http://127.0.0.1:4200`,
    errorCount: 0, uptimeMs: 65_000, lastCompileMs: null, health: 'healthy',
    lastHealthAt: null, cpu: 3, memMB: 210, compileHistoryMs: [], tags: [],
    restartAttempts: 0, nextRestartAt: null, announcedUrl: null, lastHealthError: null,
    stale: false, bundle: null, bundleRegressionPct: null, dependsOn: [],
    activeEnvFile: null, workspaceLabel: 'demo', workspaceRoot: 'D:/demo',
    serverProfile: 'vite', ...over,
  };
}

// Mount, let ink flush a frame, unmount, return what the terminal saw.
async function renderApp(apps, { cols = 120, rows = 40, registryOpts = {} } = {}) {
  const stdout = new FakeStdout(cols, rows);
  const registry = makeRegistry(apps, registryOpts);
  const instance = render(
    React.createElement(App, { registry, apiPort: 4999, onQuit: () => {} }),
    { stdout, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 60));
  const text = stdout.text;
  instance.unmount();
  await new Promise(r => setTimeout(r, 10));
  return { text, stdout, registry };
}

// ── the smoke tests ───────────────────────────────────────────────────────────

test('the TUI mounts and renders without throwing', async () => {
  const { text } = await renderApp([app('web'), app('api', { port: 3000 })]);
  assert.ok(text.length > 0, 'the TUI rendered nothing at all');
  assert.match(text, /daimon/, 'the header is missing');
});

test('all three panes render, and the app list shows its apps', async () => {
  const { text } = await renderApp([app('web'), app('api', { port: 3000 })]);
  assert.match(text, /Apps/, 'the list pane is missing');
  assert.match(text, /web/, 'the app list does not show its apps');
  assert.match(text, /api/);
  assert.match(text, /log/, 'the log pane is missing');
});

test('the status bar reports the daemon, port, app count and workspace', async () => {
  const { text } = await renderApp([app('web'), app('api')]);
  assert.match(text, /4999/, 'the status bar does not name the api port');
  assert.match(text, /2 apps/, 'the status bar does not report the app count');
  assert.match(text, /demo/, 'the status bar does not name the workspace');
});

test('the focus marker and the position indicator render', async () => {
  const { text } = await renderApp([app('web'), app('api')]);
  assert.match(text, /▸/, 'nothing shows which pane/row has focus');
  assert.match(text, /1\/2/, 'the list pane has no position indicator');
});

test('the footer renders chord hints from the map', async () => {
  const { text } = await renderApp([app('web')]);
  assert.match(text, /\[\?\] help/, 'the footer does not advertise the help overlay');
  assert.match(text, /\[Tab\] pane/, 'the footer does not advertise pane cycling');
  assert.match(text, /\[s\] start/, 'the footer lost the lifecycle chords');
});

test('an empty registry renders a guiding note instead of a broken frame', async () => {
  const { text } = await renderApp([]);
  assert.match(text, /no apps discovered/, 'an empty registry should say so');
  assert.match(text, /daimon/, 'the frame should still render');
});

test('log lines render, and an unclassified line is not tinted as a level', async () => {
  const { text } = await renderApp([app('web')], {
    registryOpts: {
      logBuffer: [
        { line: 'vite ready in 300ms', level: 'info' },
        { line: 'EADDRINUSE 4200', level: 'error' },
        { line: 'a line with no level at all' },
      ],
    },
  });
  assert.match(text, /vite ready in 300ms/);
  assert.match(text, /EADDRINUSE 4200/);
  assert.match(text, /a line with no level at all/);
  assert.match(text, /\[following\]/, 'the log pane does not show its follow state');
});

test('a storming app shows the storm marker', async () => {
  const { text } = await renderApp([app('web')], { registryOpts: { storming: ['web'] } });
  assert.match(text, /storm/i, 'a storming app must be visible in the pane');
});

test('a muted app is marked, and counted in the status bar', async () => {
  const { text } = await renderApp([app('web')], { registryOpts: { muted: ['web'] } });
  assert.match(text, /muted/, 'a muted app must be visible');
});

// ── narrow terminals really render (M166) ─────────────────────────────────────

test('80 columns renders without any row exceeding the width', async () => {
  const { text } = await renderApp([app('web'), app('api', { name: 'api' })], { cols: 80, rows: 30 });
  const tooWide = text.split('\n').filter(l => l.length > 80);
  assert.deepEqual(tooWide, [], `rows overflowed 80 columns:\n${tooWide.join('\n')}`);
  assert.match(text, /web/, 'the app list must survive at 80 columns');
});

test('a 60-column terminal degrades to one pane and still renders the list', async () => {
  const { text } = await renderApp([app('web')], { cols: 56, rows: 24 });
  const tooWide = text.split('\n').filter(l => l.length > 56);
  assert.deepEqual(tooWide, [], `rows overflowed 56 columns:\n${tooWide.join('\n')}`);
  assert.match(text, /web/);
});

test('a long app list renders a window, not every row', async () => {
  const many = Array.from({ length: 100 }, (_, i) => app(`app-${String(i).padStart(3, '0')}`));
  const { text } = await renderApp(many, { cols: 120, rows: 30 });
  assert.match(text, /1\/100/, 'the position indicator should read 1/100');
  assert.match(text, /app-000/, 'the selected app must be in view');
  assert.doesNotMatch(text, /app-099/, 'a windowed list must not render all 100 rows');
});

// ── NO_COLOR really renders (M165) ────────────────────────────────────────────

// ── chords actually work (M162 + M163) ────────────────────────────────────────
// The pure chord tests prove the MAP is right; these prove the map is WIRED —
// that pressing the key really moves the UI.

async function withKeys(apps, presses, { cols = 120, rows = 40, registryOpts = {} } = {}) {
  const stdout = new FakeStdout(cols, rows);
  const stdin = new FakeStdin();
  const registry = makeRegistry(apps, registryOpts);
  const instance = render(
    React.createElement(App, { registry, apiPort: 4999, onQuit: () => {} }),
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 50));
  for (const seq of presses) {
    stdin.press(seq);
    await new Promise(r => setTimeout(r, 40));
  }
  const text = stripAnsi(stdout.frames.join(''));
  // ink writes cursor-control sequences (e.g. hide-cursor) as their own tiny
  // writes, so the LAST write is often not the last RENDER. Take the last
  // substantial frame instead.
  const rendered = stdout.frames.filter(f => f.length > 80);
  const final = stripAnsi(rendered[rendered.length - 1] ?? '');
  instance.unmount();
  await new Promise(r => setTimeout(r, 10));
  return { text, final };
}

test('[?] opens the help overlay, and it lists chords from the map', async () => {
  const { final } = await withKeys([app('web')], ['?']);
  assert.match(final, /keyboard reference/i, '[?] did not open the help overlay');
  assert.match(final, /cycle focus/, 'the overlay does not list the Tab chord description');
  assert.match(final, /Lifecycle/, 'the overlay is not grouped');
  assert.match(final, /close:/, 'the overlay does not say how to close');
});

test('the help overlay closes again on [?]', async () => {
  // ink skips the write when a render is byte-identical to the previous frame,
  // and the screen after closing the overlay is exactly the screen before
  // opening it — so "no new frame" cannot distinguish closed from stuck. Press
  // `j` afterwards: if the overlay closed, `j` moves the selection and produces
  // a distinguishable frame; if it is still open, `j` is unhandled there and
  // the last rendered frame is still the overlay.
  const { final } = await withKeys([app('web'), app('api'), app('worker')], ['?', '?', 'j']);
  assert.doesNotMatch(final, /keyboard reference/i, 'the overlay did not close');
  assert.match(final, /2\/3/, 'after closing, [j] should move the selection again');
});

test('Tab cycles focus through the panes', async () => {
  // Focus starts on the list; the footer is pane-scoped, so it changes with focus.
  const start = await withKeys([app('web')], []);
  assert.match(start.final, /\[s\] start/, 'the list footer should show lifecycle chords');

  const twice = await withKeys([app('web')], [KEY.tab, KEY.tab]);
  assert.match(twice.final, /\[l\] level|\[\/\] grep/, 'Tab twice should focus the log pane and show log chords');
});

test('[l] focuses the log pane, and Esc returns to the list', async () => {
  const focused = await withKeys([app('web')], ['l']);
  assert.match(focused.final, /\[l\] level|\[\/\] grep/, '[l] did not focus the log pane');

  const back = await withKeys([app('web')], ['l', KEY.esc]);
  assert.match(back.final, /\[s\] start/, 'Esc did not return focus to the list');
});

test('[Shift+L] maximizes the log pane and q restores it', async () => {
  const max = await withKeys([app('web')], ['L'], { registryOpts: { logBuffer: [{ line: 'hello from the log' }] } });
  assert.match(max.final, /log \(full\)/, 'Shift+L did not maximize the log pane');
  assert.doesNotMatch(max.final, /Apps/, 'a maximized log pane should hide the app list');

  // q in the maximized pane returns to the list — the v1.12 full-screen log
  // pane behaviour, deliberately preserved over the global quit chord.
  const restored = await withKeys([app('web')], ['L', 'q']);
  assert.match(restored.final, /Apps/, 'q in the maximized log pane should restore, not quit');
});

test('[j]/[k] move the selection and the indicator follows', async () => {
  const down = await withKeys([app('web'), app('api'), app('worker')], ['j']);
  assert.match(down.final, /2\/3/, 'j did not move the selection');
  const up = await withKeys([app('web'), app('api'), app('worker')], ['j', 'j', 'k']);
  assert.match(up.final, /2\/3/, 'k did not move the selection back');
});

test('[/] opens the name filter and typing narrows the list', async () => {
  const { final } = await withKeys([app('web'), app('api')], ['/', 'a', 'p', 'i']);
  assert.match(final, /filter/i, 'the filter prompt did not open');
  assert.match(final, /api/, 'the filtered list should still show the match');
});

test('[r] asks before restarting rather than acting immediately', async () => {
  const { final } = await withKeys([app('web')], ['r']);
  assert.match(final, /Restart web\?/, '[r] should prompt for confirmation');
  assert.match(final, /\[y\]es/, 'the confirm prompt should offer y/n');
});

test('an unknown key changes nothing', async () => {
  const { final } = await withKeys([app('web')], ['Z']);
  assert.match(final, /Apps/);
  assert.doesNotMatch(final, /keyboard reference/i);
  assert.doesNotMatch(final, /Restart/);
});

// Count real SGR *color* codes. Foreground 30-38/90-97, background 40-48/
// 100-107; bold/dim/inverse (1/2/7) are attributes, not color, and are expected
// on the monochrome rung. The ESC byte is part of the sequence — omitting it
// (the first cut of this helper did) matches far too much.
function countColorCodes(raw) {
  const seqs = raw.match(new RegExp(ESC + '\[[0-9;]*m', 'g')) ?? [];
  return seqs.filter(seq => {
    const params = seq.slice(2, -1).split(';').filter(Boolean).map(Number);
    return params.some(p =>
      (p >= 30 && p <= 38) || (p >= 40 && p <= 48) || (p >= 90 && p <= 97) || (p >= 100 && p <= 107));
  });
}

async function renderRaw(apps, registryOpts = {}) {
  const stdout = new FakeStdout(120, 40);
  const registry = makeRegistry(apps, registryOpts);
  // A TTY stdin is required: App calls useInput, and ink throws "Raw mode is
  // not supported" when the default process.stdin is a pipe (as it is under
  // `node --test`) — which would dump an error frame into the captured output.
  const instance = render(
    React.createElement(App, { registry, apiPort: 4999, onQuit: () => {} }),
    { stdout, stdin: new FakeStdin(), patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 60));
  const raw = stdout.frames.join('');
  instance.unmount();
  await new Promise(r => setTimeout(r, 10));
  return raw;
}

// ink paints exclusively through the global chalk singleton, and chalk resolves
// to level 0 whenever stdout is a pipe — which it always is under `node --test`.
// So a NO_COLOR assertion on its own passes VACUOUSLY: no color is emitted
// either way, and a regression that made the monochrome rung emit truecolor
// would ship green (exactly what the v1.13 review found). Forcing chalk's level
// here decouples "can the terminal show color" from "does the theme ask for
// color", which is the thing actually under test. chalk is ink's own dependency
// — imported here in a test only, never in shipped code.
const chalk = (await import('chalk')).default;

test('CONTROL: with color available, the TUI really does paint', async () => {
  // Without this control, the NO_COLOR test below proves nothing.
  const prevLevel = chalk.level;
  const prevNo = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  chalk.level = 3;
  try {
    const raw = await renderRaw([app('web'), app('api', { status: 'error', health: 'unhealthy' })]);
    const painted = countColorCodes(raw);
    assert.ok(
      painted.length > 0,
      'the harness cannot detect color at all — the NO_COLOR assertion would be vacuous',
    );
  } finally {
    chalk.level = prevLevel;
    if (prevNo !== undefined) process.env.NO_COLOR = prevNo;
  }
});

test('NO_COLOR renders every feature with no SGR color codes', async () => {
  const prevLevel = chalk.level;
  const prevNo = process.env.NO_COLOR;
  // chalk CAN paint (level 3), so any color in the output would be the theme's
  // doing. NO_COLOR must make the theme ask for none.
  chalk.level = 3;
  process.env.NO_COLOR = '1';
  try {
    const raw = await renderRaw(
      [app('web'), app('api', { status: 'error', health: 'unhealthy' })],
      { logBuffer: [{ line: 'boom', level: 'error' }] },
    );

    // Every feature is still there...
    const text = stripAnsi(raw);
    assert.match(text, /\bweb\b/);
    assert.match(text, /\bapi\b/);
    assert.match(text, /boom/);
    assert.match(text, /\[\?\] help/);

    // ...and nothing painted a color.
    const painted = countColorCodes(raw);
    assert.deepEqual(painted, [], `NO_COLOR still emitted color: ${painted.slice(0, 5).join(' ')}`);
  } finally {
    chalk.level = prevLevel;
    if (prevNo === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNo;
  }
});
