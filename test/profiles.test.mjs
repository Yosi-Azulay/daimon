import { test } from 'node:test';
import assert from 'node:assert/strict';

const { suggestProfiles, analyseRestartCadence } = await import('../dist/profiles.js');

function startEv(ts, app) {
  return { ts, app, type: 'status', to_state: 'starting' };
}

test('suggestProfiles ignores clusters below the minimum occurrence threshold', () => {
  const events = [
    startEv(100, 'web'),
    startEv(110, 'api'),
    startEv(200_000, 'web'),
    startEv(200_010, 'api'),
  ];
  const out = suggestProfiles(events, { minOccurrences: 5 });
  assert.deepEqual(out, []);
});

test('suggestProfiles surfaces a co-start cluster seen ≥5 times', () => {
  const events = [];
  for (let i = 0; i < 5; i++) {
    const base = i * 10 * 60_000;
    events.push(startEv(base, 'web'));
    events.push(startEv(base + 1000, 'api'));
  }
  const out = suggestProfiles(events, { minOccurrences: 5 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].apps, ['api', 'web']);
  assert.equal(out[0].cooccurrences, 5);
});

test('suggestProfiles skips clusters that already exist as profiles', () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    const base = i * 10 * 60_000;
    events.push(startEv(base, 'web'));
    events.push(startEv(base + 1000, 'api'));
  }
  const out = suggestProfiles(events, { minOccurrences: 5, existingProfiles: { dev: ['web', 'api'] } });
  assert.deepEqual(out, []);
});

test('suggestProfiles does not merge clusters separated by more than the window', () => {
  const events = [
    startEv(0, 'web'),
    startEv(120_000, 'api'), // 2 minutes later — outside default 60s window
  ];
  const out = suggestProfiles(events, { minOccurrences: 1 });
  assert.deepEqual(out, []); // each session has < minApps
});

test('analyseRestartCadence flags apps with restart storms', () => {
  // 50 transitions from serving -> starting over 7 days for "flapper"
  const events = [];
  for (let i = 0; i < 50; i++) {
    events.push({ ts: Date.now() - i * 60_000, app: 'flapper', type: 'status', to_state: 'starting', from_state: 'serving' });
  }
  for (let i = 0; i < 5; i++) {
    events.push({ ts: Date.now() - i * 60_000, app: 'calm', type: 'status', to_state: 'starting', from_state: 'serving' });
  }
  const out = analyseRestartCadence(events, 7, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].app, 'flapper');
  assert.ok(out[0].restartsPerDay >= 5);
});

test('analyseRestartCadence treats stopped->starting as a fresh start, not a restart', () => {
  const events = [];
  for (let i = 0; i < 40; i++) {
    events.push({ ts: Date.now() - i * 60_000, app: 'web', type: 'status', to_state: 'starting', from_state: 'stopped' });
  }
  const out = analyseRestartCadence(events, 7, 5);
  assert.deepEqual(out, []);
});
