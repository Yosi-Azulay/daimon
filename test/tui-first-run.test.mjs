// M170 (v1.14) — the TUI's first-attach hint.
//
// Shown once, on the first attach this machine has ever had, pointing at the
// v1.13 `?` overlay; acknowledged in ~/.daimon/state.json so the second attach
// is clean. Pure-module assertions plus one real mount, per the v1.13 rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';

const { firstRunHintText, CHORDS } = await import('../dist/tui/chords.js');

test('the hint names the help chord as the map defines it (no hand-listed key)', () => {
  const help = CHORDS.find(c => c.id === 'help');
  assert.ok(help, 'the chord map must still have a help chord');
  const text = firstRunHintText();
  assert.ok(text.includes(`[${help.key}]`), `hint must render the map's key: ${text}`);
  assert.match(text, /help|understands|keys?/i, `hint should say what the key does: ${text}`);
});

test('the hint is acknowledged in state.json and never shown twice', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-hint-'));
  const prev = process.env.DAIMON_HOME;
  process.env.DAIMON_HOME = home;
  try {
    // Fresh import so the module picks up this DAIMON_HOME.
    const { loadPersistedState, savePersistedState, flushPersistedState } = await import(
      `../dist/stateFile.js?first-run=${Date.now()}`
    );
    const before = loadPersistedState();
    assert.equal(before.tuiHintSeen, undefined, 'a fresh machine has never attached');

    // Something else already owns a key — the ack must merge, not clobber.
    savePersistedState({ ports: { web: 4200 }, awayAck: 111 });
    savePersistedState({ tuiHintSeen: 222 });
    flushPersistedState(); // writes are debounced 500ms; force the disk round-trip

    const after = loadPersistedState();
    assert.equal(after.tuiHintSeen, 222, 'the ack persisted');
    assert.equal(after.awayAck, 111, 'the ack must not clobber a sibling key');
    assert.deepEqual(after.ports, { web: 4200 }, 'ports survived the merge-write');

    // Which is exactly what main.ts reads to decide whether to show it.
    assert.equal(after.tuiHintSeen == null, false, 'second attach shows no hint');
  } finally {
    if (prev === undefined) delete process.env.DAIMON_HOME; else process.env.DAIMON_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── one real mount (the v1.13 exception to pure-module TUI testing) ───────────

class FakeStdout extends EventEmitter {
  constructor(columns = 120, rows = 40) {
    super();
    this.columns = columns; this.rows = rows; this.frames = []; this.isTTY = true;
  }
  write(chunk) { this.frames.push(String(chunk)); return true; }
  get text() { return this.frames.join('').replace(/\[[0-9;]*[A-Za-z]/g, ''); }
}

function makeRegistry(apps) {
  const emitter = new EventEmitter();
  return {
    list: () => apps,
    events: () => [],
    on: (e, f) => emitter.on(e, f),
    off: (e, f) => emitter.off(e, f),
    getState: () => ({ logBuffer: [], lastStatusMessage: null, sessionOverrides: null, activeEnvFile: null }),
    getConfig: () => ({}),
    getApp: name => apps.find(a => a.name === name) ?? null,
    summary: name => apps.find(a => a.name === name) ?? null,
    isMuted: () => false,
    logStormState: () => ({ active: false, since: null, observedPerMin: 0, baselinePerMin: null, windowSec: 60, multiplier: 10 }),
    activeLogStorms: () => [],
    getHistory: () => null,
    start: () => {}, stop: () => {}, restart: () => {},
    runTests: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, totals: null }),
    setSessionOverride: () => {}, setActiveEnvFile: () => {},
  };
}

const sampleApp = {
  name: 'web', baseName: 'web', status: 'serving', port: 4200, url: 'http://127.0.0.1:4200',
  errorCount: 0, uptimeMs: 1000, lastCompileMs: null, health: 'healthy', lastHealthAt: null,
  cpu: 1, memMB: 100, compileHistoryMs: [], tags: [], restartAttempts: 0, nextRestartAt: null,
  announcedUrl: null, lastHealthError: null, stale: false, bundle: null, bundleRegressionPct: null,
  dependsOn: [], activeEnvFile: null, workspaceLabel: 'demo', workspaceRoot: 'D:/demo',
  serverProfile: 'vite',
};

async function mount(props) {
  const App = (await import('../dist/tui/App.js')).default;
  const stdout = new FakeStdout();
  const instance = render(
    React.createElement(App, { registry: makeRegistry([sampleApp]), apiPort: 4999, onQuit: () => {}, ...props }),
    { stdout, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 60));
  const text = stdout.text;
  instance.unmount();
  await new Promise(r => setTimeout(r, 10));
  return text;
}

test('first attach renders the hint and acks it on mount', async () => {
  let acked = 0;
  const text = await mount({ firstRunHint: true, onAckFirstRunHint: () => { acked++; } });
  assert.match(text, /New here\?/, 'the hint should be on screen');
  assert.ok(text.includes('[?]'), `the hint should name the help key: ${text.slice(0, 300)}`);
  assert.equal(acked, 1, 'the ack fires on mount, not on quit — a crash must not re-show it');
});

test('a second attach renders no hint', async () => {
  const text = await mount({ firstRunHint: false });
  assert.ok(!/New here\?/.test(text), 'the hint must not reappear once acknowledged');
});
