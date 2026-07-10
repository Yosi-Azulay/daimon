import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// M84 — notification polish + scheduled digest: kind routing, same-fingerprint
// batching, quiet hours + exit summary, per-app mute (persisted, visible), and
// the DigestScheduler's fire/catch-up/once-per-day semantics.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-notif-'));
process.env.DAIMON_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.DAIMON_HOME, { recursive: true });

const { Notifier, inQuietHours } = await import('../dist/notifier.js');
const { Registry } = await import('../dist/registry.js');
const { DigestScheduler, shapeDigestPayload } = await import('../dist/webhooks.js');
const { loadPersistedState, savePersistedState, flushPersistedState } = await import('../dist/stateFile.js');

class FakeRegistry extends EventEmitter {}

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43700, 43790], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: path.join(tmp, 'h.db'), retentionDays: 7 },
    notifications: { enabled: true, onError: true, onUnhealthy: true, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 }, restartStorm: { perHour: 20 },
    ...overrides,
  };
}

function localTs(hours, minutes = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

test('batching: 5 same-fingerprint errors in a window → 1 notification with count 5', async () => {
  const reg = new FakeRegistry();
  const got = [];
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false, kinds: ['error-new'], batchMs: 250 }, { sink: p => got.push(p) });
  for (let i = 0; i < 5; i++) {
    reg.emit('event', { ts: Date.now(), app: 'web', type: 'error-new', message: 'TS2304: Cannot find name x' });
  }
  await new Promise(r => setTimeout(r, 450));
  assert.equal(got.length, 1, `exactly one notification (got ${JSON.stringify(got)})`);
  assert.ok(got[0].message.includes('×5'), `count carried (${got[0].message})`);
  n.stop();
});

test('batching: different fingerprints batch separately', async () => {
  const reg = new FakeRegistry();
  const got = [];
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false, kinds: ['error-new'], batchMs: 200 }, { sink: p => got.push(p) });
  reg.emit('event', { ts: Date.now(), app: 'web', type: 'error-new', message: 'error A' });
  reg.emit('event', { ts: Date.now(), app: 'web', type: 'error-new', message: 'error B' });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(got.length, 2, JSON.stringify(got));
  n.stop();
});

test('routing: kinds filters notifications; absent = legacy set', async () => {
  const reg = new FakeRegistry();
  const got = [];
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false, kinds: ['crash'] }, { sink: p => got.push(p) });
  reg.emit('event', { ts: Date.now(), app: 'web', type: 'status', from: 'serving', to: 'error', message: 'boom' });
  reg.emit('event', { ts: Date.now(), app: 'web', type: 'crash', message: 'exited code=1' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.ok(got[0].title.includes('crashed'));

  // Legacy: no kinds → status→error notifies (current behavior), crash doesn't.
  const got2 = [];
  const reg2 = new FakeRegistry();
  const n2 = new Notifier(reg2, { enabled: true, onError: true, onUnhealthy: true, tray: false }, { sink: p => got2.push(p) });
  reg2.emit('event', { ts: Date.now(), app: 'web', type: 'status', from: 'serving', to: 'error', message: 'boom' });
  reg2.emit('event', { ts: Date.now(), app: 'web', type: 'crash', message: 'exited code=1' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(got2.length, 1, JSON.stringify(got2));
  assert.ok(got2[0].title.includes('→ error'));
  n.stop();
  n2.stop();
});

test('quiet hours: suppression + one exit summary', () => {
  let now = localTs(23, 30); // inside 22:00-08:00
  const reg = new FakeRegistry();
  const got = [];
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false, quietHours: '22:00-08:00' }, { sink: p => got.push(p), now: () => now });
  reg.emit('event', { ts: now, app: 'web', type: 'status', from: 'serving', to: 'error', message: 'boom' });
  reg.emit('event', { ts: now, app: 'api', type: 'status', from: 'serving', to: 'error', message: 'boom2' });
  assert.equal(got.length, 0, 'suppressed during quiet hours');
  // Window ends → summary fires exactly once.
  now = localTs(9, 0, 1);
  n.checkQuietWindow();
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.ok(got[0].message.includes('2 notifications suppressed'), got[0].message);
  n.checkQuietWindow();
  assert.equal(got.length, 1, 'summary fires only once');
  n.stop();
});

test('inQuietHours handles wrap and non-wrap windows', () => {
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  assert.equal(inQuietHours('22:00-08:00', at(23, 0)), true);
  assert.equal(inQuietHours('22:00-08:00', at(7, 59)), true);
  assert.equal(inQuietHours('22:00-08:00', at(12, 0)), false);
  assert.equal(inQuietHours('09:00-17:00', at(12, 0)), true);
  assert.equal(inQuietHours('09:00-17:00', at(18, 0)), false);
  assert.equal(inQuietHours(null, at(12, 0)), false);
});

test('mute: honored by the notifier, visible in status, expires with --for', async () => {
  const cfg = baseCfg();
  const app = { name: 'web', baseName: 'web', workspaceRoot: tmp, workspaceType: 'polyglot', command: 'echo x', hidden: false, tags: [] };
  const reg = new Registry(cfg, [app]);
  const snapshots = [];
  reg.onMutesChanged = s => snapshots.push(s);
  const got = [];
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false }, { sink: p => got.push(p) });

  reg.mute('web', null);
  assert.equal(reg.summary('web').muted, true, 'muted visible in summary');
  assert.equal(snapshots.length, 1, 'persist callback fired');
  reg.recordEvent({ app: 'web', type: 'status', from: 'serving', to: 'error', message: 'boom' });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(got.length, 0, 'muted app does not notify');

  reg.unmute('web');
  assert.equal(reg.summary('web').muted, false);
  reg.recordEvent({ app: 'web', type: 'status', from: 'serving', to: 'error', message: 'boom again' });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(got.length, 1, 'unmuted app notifies');

  // Timed mute expires.
  reg.mute('web', 40);
  assert.equal(reg.isMuted('web'), true);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(reg.isMuted('web'), false, 'mute expired');
  n.stop();
});

test('persisted state merges ports/mutes/digests without clobbering', () => {
  savePersistedState({ ports: { web: 4310 } });
  savePersistedState({ mutes: { web: null } });
  savePersistedState({ digests: { 'https://x': 123 } });
  flushPersistedState();
  const loaded = loadPersistedState();
  assert.deepEqual(loaded.ports, { web: 4310 });
  assert.deepEqual(loaded.mutes, { web: null });
  assert.deepEqual(loaded.digests, { 'https://x': 123 });
});

test('digest: fires at the scheduled time, once per day, Slack-shaped', () => {
  const sent = [];
  const state = new Map([['https://hooks.slack.com/services/T/B/X', localTs(9, 0, -1)]]);
  const sched = new DigestScheduler({
    webhooks: [{ url: 'https://hooks.slack.com/services/T/B/X', digest: '09:00' }],
    dispatcher: { enqueuePayload: (cfg, payload) => sent.push({ cfg, payload }) },
    buildReport: sinceTs => ({ json: { since: sinceTs }, md: `# daimon report — test (${sinceTs})` }),
    state: { get: url => state.get(url) ?? 0, set: (url, ts) => state.set(url, ts) },
  });
  // Before today's 09:00 → nothing.
  assert.equal(sched.tick(localTs(8, 59)), 0);
  // At 09:01 → one send, Slack-shaped text.
  assert.equal(sched.tick(localTs(9, 1)), 1);
  assert.equal(sent.length, 1);
  assert.ok(typeof sent[0].payload.text === 'string' && sent[0].payload.text.startsWith('# daimon report'), JSON.stringify(sent[0].payload));
  // Later the same day → nothing more (once per day per webhook).
  assert.equal(sched.tick(localTs(9, 2)), 0);
  assert.equal(sched.tick(localTs(18, 0)), 0);
});

test('digest: catch-up fires exactly once after a simulated down window', () => {
  const sent = [];
  const url = 'https://hooks.slack.com/services/T/B/Y';
  const state = new Map([[url, localTs(9, 5, -3)]]); // last sent 3 days ago
  const sched = new DigestScheduler({
    webhooks: [{ url, digest: '09:00' }],
    dispatcher: { enqueuePayload: (cfg, payload) => sent.push(payload) },
    buildReport: sinceTs => ({ json: { since: sinceTs }, md: 'md' }),
    state: { get: u => state.get(u) ?? 0, set: (u, ts) => state.set(u, ts) },
  });
  // Daemon comes back at 14:23 — one catch-up send, not three.
  assert.equal(sched.tick(localTs(14, 23)), 1);
  assert.equal(sched.tick(localTs(14, 24)), 0);
  assert.equal(sent.length, 1);
});

test('digest: freshly configured webhook baselines without a retroactive send', () => {
  const sent = [];
  const url = 'https://example.com/hook';
  const state = new Map();
  const sched = new DigestScheduler({
    webhooks: [{ url, digest: '09:00' }],
    dispatcher: { enqueuePayload: (cfg, payload) => sent.push(payload) },
    buildReport: () => ({ json: {}, md: 'md' }),
    state: { get: u => state.get(u) ?? 0, set: (u, ts) => state.set(u, ts) },
  });
  assert.equal(sched.tick(localTs(15, 0)), 0, 'no surprise digest at config time');
  assert.ok(state.get(url) > 0, 'baseline recorded');
  // Next day at 09:01 → fires.
  assert.equal(sched.tick(localTs(9, 1, 1)), 1);
  // Generic host gets the JSON envelope.
  assert.equal(sent[0].event, 'digest');
});

test('config validation: notifications kinds/quietHours/batchMs — valid kept, junk dropped with warnings', async () => {
  const { validateConfig, configValidationWarnings } = await import('../dist/config.js');
  const good = validateConfig({ notifications: { enabled: true, kinds: ['error', 'crash'], quietHours: '22:00-08:00', batchMs: 60000 } }, 'test');
  assert.deepEqual(good.notifications.kinds, ['error', 'crash']);
  assert.equal(good.notifications.quietHours, '22:00-08:00');
  assert.equal(good.notifications.batchMs, 60000);
  const bad = validateConfig({ notifications: { kinds: 'error', quietHours: 'late', batchMs: -5 } }, 'test');
  assert.equal(bad.notifications.kinds, undefined, 'non-array kinds dropped');
  assert.equal(bad.notifications.quietHours, undefined, 'malformed window dropped');
  assert.equal(bad.notifications.batchMs, undefined, 'negative batchMs dropped');
  const w = configValidationWarnings();
  assert.ok(w.some(x => x.includes('notifications.kinds')));
  assert.ok(w.some(x => x.includes('notifications.quietHours')));
  assert.ok(w.some(x => x.includes('notifications.batchMs')));
});

test('config validation: webhooks[].digest accepts HH:MM, rejects junk', async () => {
  const { validateConfig, configValidationWarnings } = await import('../dist/config.js');
  const cfg = validateConfig({
    webhooks: [
      { url: 'https://hooks.slack.com/a', digest: '09:30' },
      { url: 'https://hooks.slack.com/b', digest: '25:99' },
    ],
  }, 'test');
  assert.equal(cfg.webhooks[0].digest, '09:30');
  assert.equal(cfg.webhooks[1].digest, undefined, 'invalid time dropped, entry kept');
  assert.ok(configValidationWarnings().some(w => w.includes('digest')));
});

test('shapeDigestPayload: slack text, discord content, generic envelope', () => {
  const slack = shapeDigestPayload('https://hooks.slack.com/services/a/b/c', { x: 1 }, '# md');
  assert.deepEqual(slack, { text: '# md' });
  const discord = shapeDigestPayload('https://discord.com/api/webhooks/1/2', { x: 1 }, 'y'.repeat(3000));
  assert.ok(discord.content.length <= 1901);
  const generic = shapeDigestPayload('https://example.com/h', { x: 1 }, 'md');
  assert.equal(generic.event, 'digest');
  assert.deepEqual(generic.report, { x: 1 });
});
