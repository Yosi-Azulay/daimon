import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M135 (v1.8 "Rewind") — "while you were away". Gap detection derives the
// baseline from the session list + last acknowledgement; the summary is a strict
// SUBSET of the M83 report composition (reuse, not a new engine). Verifies: a
// >4h gap produces a summary whose counts match an independent report --since; a
// <4h gap shows nothing; a dismissal (ack) suppresses re-nag; an empty-window
// gap shows nothing.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-away-'));
process.env.DAIMON_HOME = path.join(tmp, 'home');

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { listSessions } = await import('../dist/sessions.js');
const { buildReport } = await import('../dist/report.js');
const { awayBaseline, awayGap, extractAwaySummary, AWAY_GAP_MS } = await import('../dist/away.js');

const HOUR = 3600_000;
const D = '__daemon__';

function baseCfg(dbPath) {
  return {
    searchRoots: [], portRange: [43910, 43990], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: dbPath, retentionDays: 365 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 }, restartStorm: { perHour: 20 },
  };
}
function app(name) {
  return { name, baseName: name, workspaceRoot: tmp, workspaceType: 'polyglot', command: 'echo x', hidden: false, tags: [] };
}

// Session A ended `prevEndHrs`h before now (clean); session B is current and
// carries the "while you were away" activity (errors + a crash).
function seed(dbPath, now, prevEndHrs) {
  const h = new History({ enabled: true, path: dbPath, retentionDays: 365 });
  const aStart = now - (prevEndHrs + 1) * HOUR;
  const aEnd = now - prevEndHrs * HOUR;
  h.recordEvent({ ts: aStart, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: aEnd, app: D, type: 'daemon-stop' });
  // Current session B opens right after A closes and stays open.
  const bStart = aEnd + 60_000;
  h.recordEvent({ ts: bStart, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: bStart + 1000, app: 'web', type: 'error-new', message: 'boom while away' });
  h.recordEvent({ ts: bStart + 2000, app: 'web', type: 'error-new', message: 'second boom' });
  h.recordCrash({ app: 'api', ts: bStart + 3000, exitCode: 1, signal: null, uptimeMs: 10, lastLines: ['died'], gitHead: 'x' });
  h._flushForTest();
  return h;
}

test('baseline is the later of ack and the previous session last-event', () => {
  const now = Date.now();
  const h = seed(path.join(tmp, 'b.db'), now, 5);
  const sessions = listSessions(h, { now });
  const prevEnd = sessions.find(s => !s.current).end;
  assert.equal(awayBaseline(sessions, undefined), prevEnd);
  // A later ack wins.
  assert.equal(awayBaseline(sessions, prevEnd + 10_000), prevEnd + 10_000);
  // An older ack loses to the session boundary.
  assert.equal(awayBaseline(sessions, prevEnd - 10_000), prevEnd);
  h.close();
});

test('a >4h gap yields a summary whose counts match an independent report', () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'gap.db');
  const h = seed(dbPath, now, 5);
  const reg = new Registry(baseCfg(dbPath), [app('web'), app('api')]);
  reg.setHistory(h);
  const sessions = listSessions(h, { now });

  const baseline = awayGap(sessions, now, undefined);
  assert.ok(baseline != null, '5h gap is over threshold');

  const report = buildReport({ registry: reg, history: h }, { since: baseline, until: now });
  const summary = extractAwaySummary(report, baseline, now);
  assert.ok(summary, 'summary present');
  assert.equal(summary.errors.newCount, report.sections.errors.newCount);
  assert.equal(summary.crashes.total, report.sections.crashes.total);
  assert.equal(summary.crashes.total, 1);
  assert.ok(summary.errors.newCount >= 2);
  h.close();
});

test('a <4h gap shows nothing', () => {
  const now = Date.now();
  const h = seed(path.join(tmp, 'small.db'), now, 1); // 1h gap
  const sessions = listSessions(h, { now });
  assert.equal(awayGap(sessions, now, undefined), null);
  h.close();
});

test('a dismissal (ack = now) suppresses re-nag even with an old session boundary', () => {
  const now = Date.now();
  const h = seed(path.join(tmp, 'ack.db'), now, 5);
  const sessions = listSessions(h, { now });
  assert.equal(awayGap(sessions, now, now), null, 'ack at now closes the gap');
  h.close();
});

test('an empty-window gap shows nothing (no 0-events noise)', () => {
  const now = Date.now();
  const dbPath = path.join(tmp, 'empty.db');
  // Session A ended 6h ago; the current session opened but recorded no activity.
  const h = new History({ enabled: true, path: dbPath, retentionDays: 365 });
  h.recordEvent({ ts: now - 7 * HOUR, app: D, type: 'daemon-start' });
  h.recordEvent({ ts: now - 6 * HOUR, app: D, type: 'daemon-stop' });
  h.recordEvent({ ts: now - 6 * HOUR + 60_000, app: D, type: 'daemon-start' });
  h._flushForTest();
  const reg = new Registry(baseCfg(dbPath), [app('web')]);
  reg.setHistory(h);
  const sessions = listSessions(h, { now });
  const baseline = awayGap(sessions, now, undefined);
  assert.ok(baseline != null, 'gap exceeds threshold');
  const report = buildReport({ registry: reg, history: h }, { since: baseline, until: now });
  assert.equal(extractAwaySummary(report, baseline, now), null, 'nothing happened → nothing shown');
  h.close();
});

test('AWAY_GAP_MS is the fixed 4h constant (no config key)', () => {
  assert.equal(AWAY_GAP_MS, 4 * HOUR);
});
