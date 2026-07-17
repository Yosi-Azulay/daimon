import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M101 — log-storm detection: per-app rolling baseline, one log-storm event
// on a sustained spike, one log-storm-end on recovery (hysteresis), no
// baseline = no storms, opt-in notification kind, doctor rule, status/why
// surfacing.

const { LogStormDetector } = await import('../dist/logStorm.js');
const { Registry } = await import('../dist/registry.js');
const { Notifier } = await import('../dist/notifier.js');
const { History } = await import('../dist/history.js');
const { runDoctor } = await import('../dist/doctor.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-logstorm-'));
process.env.DAIMON_HOME = tmp;

const T0 = 1_700_000_000_000;

function makeDetector(cfg, clockRef) {
  const storms = [];
  const ends = [];
  const det = new LogStormDetector(cfg, {
    onStorm: i => storms.push(i),
    onStormEnd: i => ends.push(i),
    now: () => clockRef.now,
  });
  return { det, storms, ends };
}

// Feed `perMin` lines/min into [from, to) using evenly spaced notes.
function feed(det, app, from, to, perMin, clockRef) {
  const gap = 60_000 / perMin;
  for (let ts = from; ts < to; ts += gap) {
    clockRef.now = ts;
    det.note(app, ts);
  }
  clockRef.now = to;
}

test('20x spike over a learned baseline: exactly one log-storm, one log-storm-end after recovery', () => {
  const clock = { now: T0 };
  const { det, storms, ends } = makeDetector(undefined, clock);
  // 6 minutes at 30 lines/min -> baseline learned.
  feed(det, 'web', T0, T0 + 360_000, 30, clock);
  // 20x: 600 lines/min for the 60s window.
  feed(det, 'web', T0 + 360_000, T0 + 420_000, 600, clock);
  assert.equal(storms.length, 1, 'exactly one log-storm event for a sustained spike');
  assert.equal(ends.length, 0, 'no end while the storm holds');
  const info = storms[0];
  assert.equal(info.app, 'web');
  assert.ok(info.observedPerMin >= 10 * Math.max(info.baselinePerMin, 1), `observed ${info.observedPerMin} vs baseline ${info.baselinePerMin}`);
  assert.equal(info.windowSec, 60);
  // Keep storming: still no second event.
  feed(det, 'web', T0 + 420_000, T0 + 480_000, 600, clock);
  assert.equal(storms.length, 1, 'active storm never re-fires');
  // Recovery: the app goes quiet; a state() read (what the 15s tick and any
  // status/doctor call do) ends the storm exactly once.
  clock.now = T0 + 480_000 + 120_000;
  const s = det.state('web');
  assert.equal(s.active, false);
  assert.equal(ends.length, 1, 'exactly one log-storm-end');
  assert.ok(ends[0].durationMs > 0);
  det.state('web');
  assert.equal(ends.length, 1, 'end never re-fires');
});

test('an app with no baseline yet never storms, regardless of volume', () => {
  const clock = { now: T0 };
  const { det, storms } = makeDetector(undefined, clock);
  // Brand-new app immediately blasting 6000 lines/min for 2 minutes.
  feed(det, 'fresh', T0, T0 + 120_000, 6000, clock);
  assert.equal(storms.length, 0, 'no baseline -> no storm');
  const s = det.state('fresh');
  assert.equal(s.active, false);
  assert.equal(s.baselinePerMin, null);
});

test('hysteresis: a rate flapping between exit and entry thresholds does not spam events', () => {
  const clock = { now: T0 };
  const { det, storms, ends } = makeDetector(undefined, clock);
  feed(det, 'flappy', T0, T0 + 360_000, 30, clock);            // baseline 30/min
  feed(det, 'flappy', T0 + 360_000, T0 + 420_000, 600, clock); // entry (threshold 300/min)
  assert.equal(storms.length, 1);
  // Drop to 200/min: below entry (300) but above exit (150) -> still active.
  feed(det, 'flappy', T0 + 420_000, T0 + 540_000, 200, clock);
  assert.equal(ends.length, 0, 'above the exit threshold the storm holds');
  assert.equal(storms.length, 1);
  // Fall below half the entry threshold -> one end.
  feed(det, 'flappy', T0 + 540_000, T0 + 660_000, 30, clock);
  assert.equal(ends.length, 1);
  assert.equal(storms.length, 1);
});

test('logs.storm config tunes multiplier and window; bad values fall back to defaults', () => {
  const clock = { now: T0 };
  const { det, storms } = makeDetector({ multiplier: 3, windowSec: 30 }, clock);
  feed(det, 'tuned', T0, T0 + 360_000, 30, clock);
  // 4x baseline: under the default 10x, over the tuned 3x.
  feed(det, 'tuned', T0 + 360_000, T0 + 390_000, 120, clock);
  assert.equal(storms.length, 1, 'tuned multiplier catches a 4x spike');
  assert.equal(storms[0].windowSec, 30);
  assert.equal(storms[0].multiplier, 3);

  const bad = makeDetector({ multiplier: 0, windowSec: 1 }, { now: T0 });
  assert.equal(bad.det.state('x').multiplier, 10, 'multiplier < 2 falls back to 10');
  assert.equal(bad.det.state('x').windowSec, 60, 'windowSec < 10 falls back to 60');
});

test('reset() clears rate history (fresh process, fresh baseline)', () => {
  const clock = { now: T0 };
  const { det, storms } = makeDetector(undefined, clock);
  feed(det, 'web', T0, T0 + 360_000, 30, clock);
  det.reset('web');
  feed(det, 'web', T0 + 360_000, T0 + 420_000, 600, clock);
  assert.equal(storms.length, 0, 'post-reset burst has no baseline to storm against');
});

test('every episode closes: reset() and endAll() emit the log-storm-end for an active storm', () => {
  // reset() mid-storm (app restart): the episode must not stay open in the
  // event log — an unmatched log-storm keeps doctor red for hours.
  const clock = { now: T0 };
  const { det, storms, ends } = makeDetector(undefined, clock);
  feed(det, 'web', T0, T0 + 360_000, 30, clock);
  feed(det, 'web', T0 + 360_000, T0 + 420_000, 600, clock);
  assert.equal(storms.length, 1);
  det.reset('web');
  assert.equal(ends.length, 1, 'reset() closes the active episode');
  assert.ok(ends[0].durationMs > 0);
  det.reset('web');
  assert.equal(ends.length, 1, 'a second reset has nothing to close');

  // endAll() (daemon shutdown) closes every active storm exactly once.
  const clock2 = { now: T0 };
  const d2 = makeDetector(undefined, clock2);
  feed(d2.det, 'a', T0, T0 + 360_000, 30, clock2);
  feed(d2.det, 'a', T0 + 360_000, T0 + 420_000, 600, clock2);
  feed(d2.det, 'b', T0, T0 + 360_000, 30, clock2);
  feed(d2.det, 'b', T0 + 360_000, T0 + 420_000, 600, clock2);
  assert.equal(d2.storms.length, 2);
  d2.det.endAll();
  assert.equal(d2.ends.length, 2, 'endAll closes both episodes');
  d2.det.endAll();
  assert.equal(d2.ends.length, 2, 'idempotent');
});

// ---------------------------------------------------------------------------
// Registry integration: events recorded, status marker, why surface.
// ---------------------------------------------------------------------------

const baseCfg = {
  searchRoots: [], portRange: [4210, 4260], apiPort: 0,
  overrides: {}, autoStart: [], profiles: {}, tags: {},
  autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
  healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
  logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
  depends: {}, cascadeRestart: false,
  history: { enabled: false, path: path.join(tmp, 'unused.db'), retentionDays: 7 },
  notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
  requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
  editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
  doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
  errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
};
const webApp = { name: 'web', baseName: 'web', workspaceRoot: tmp, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [], workspaceLabel: 'main' };

test('registry: a storm records a log-storm event and marks the status summary', () => {
  const reg = new Registry(structuredClone(baseCfg), [webApp]);
  const det = reg.logStormDetector; // TS-private, reachable in JS by design of this test
  const now = Date.now();
  // Baseline 30/min over the 5 minutes before the window, then a 20x minute.
  for (let ts = now - 360_000; ts < now - 60_000; ts += 2000) det.note('web', ts);
  for (let ts = now - 60_000; ts < now; ts += 100) det.note('web', ts);
  const events = reg.events({ app: 'web' });
  const stormEv = events.filter(e => e.type === 'log-storm');
  assert.equal(stormEv.length, 1, `expected one log-storm event, got ${JSON.stringify(events)}`);
  const payload = JSON.parse(stormEv[0].message);
  assert.ok(payload.observedPerMin > payload.baselinePerMin * 10);
  const sum = reg.summary('web');
  assert.ok(sum.logStorm, 'status summary carries the logStorm marker while storming');
  assert.equal(typeof sum.logStorm.observedPerMin, 'number');
  const state = reg.logStormState('web');
  assert.equal(state.active, true);
});

test('notifier: log-storm is OPT-IN via notifications.kinds — absent kinds = silence', () => {
  const mk = kinds => {
    const cfg = structuredClone(baseCfg);
    cfg.notifications = { enabled: true, onError: true, onUnhealthy: true, tray: false, ...(kinds ? { kinds } : {}) };
    const reg = new Registry(cfg, [webApp]);
    const seen = [];
    const notifier = new Notifier(reg, cfg.notifications, { sink: p => seen.push(p) });
    reg.recordEvent({ app: 'web', type: 'log-storm', message: JSON.stringify({ observedPerMin: 600, baselinePerMin: 30, windowSec: 60, multiplier: 10 }) });
    notifier.stop();
    return seen;
  };
  assert.equal(mk(undefined).length, 0, 'no kinds config -> no storm notification (no new noise)');
  assert.equal(mk(['error']).length, 0, 'kinds without log-storm -> silence');
  const seen = mk(['log-storm']);
  assert.equal(seen.length, 1, 'opt-in kind routes the notification');
  assert.match(seen[0].title, /log storm/);
  assert.match(seen[0].message, /lines\/min/);
});

test('doctor: log-storm-active flags a storming app and is clean after log-storm-end', async () => {
  const histPath = path.join(tmp, 'doctor-storm.db');
  const cfg = structuredClone(baseCfg);
  cfg.history = { enabled: true, path: histPath, retentionDays: 7 };
  const now = Date.now();
  {
    const h = new History(cfg.history);
    h.recordEvent({ ts: now - 60_000, app: 'web', type: 'log-storm', message: JSON.stringify({ observedPerMin: 600, baselinePerMin: 30, windowSec: 60, multiplier: 10 }) });
    h._flushForTest();
    h.close();
  }
  const flagged = await runDoctor(cfg, []);
  const hit = flagged.checks.find(c => c.name === 'log-storm-active: web');
  assert.ok(hit, `doctor flags the storming app (got ${JSON.stringify(flagged.checks.map(c => c.name))})`);
  assert.equal(hit.ok, false);
  assert.match(hit.detail, /daimon logs web --since 5m --level error/);
  assert.match(hit.detail, /600 lines\/min/);
  {
    const h = new History(cfg.history);
    h.recordEvent({ ts: now - 30_000, app: 'web', type: 'log-storm-end', message: JSON.stringify({ observedPerMin: 20, baselinePerMin: 30, windowSec: 60, durationMs: 30_000 }) });
    h._flushForTest();
    h.close();
  }
  const clean = await runDoctor(cfg, []);
  assert.ok(!clean.checks.some(c => c.name.startsWith('log-storm-active')), 'recovered app no longer flagged');
  assert.ok(clean.checks.some(c => c.name === 'log-storm' && c.ok), 'clean log-storm check present');
});
