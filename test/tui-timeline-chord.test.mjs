import { test } from 'node:test';
import assert from 'node:assert/strict';

// M136 (v1.8 "Rewind") — TUI timeline chord pure logic: hour/day bucketing,
// drill day→hour, per-app state-change jumps landing on a crash, Home/End edges,
// empty history, and the density sparkline scaling. No ink, no terminal.

const {
  TIMELINE_CHORD_KEY, bucketStart, bucketSpan, bucketize, isStateChange,
  findStateChange, bucketIndexForTs, clampIndex, densityGlyph,
} = await import('../dist/tui/timelineChord.js');

const DAY = 86_400_000;
const HOUR = 3_600_000;

// Three distinct UTC days, a few events each.
function threeDays() {
  const d0 = bucketStart(Date.UTC(2026, 6, 10, 9, 0, 0), 'day'); // day A
  const events = [];
  events.push({ ts: d0 + 9 * HOUR, app: 'web', type: 'status', to_state: 'starting' });
  events.push({ ts: d0 + 10 * HOUR, app: 'web', type: 'error-new' });
  events.push({ ts: d0 + DAY + 8 * HOUR, app: 'web', type: 'status', to_state: 'serving' }); // day B
  events.push({ ts: d0 + DAY + 8 * HOUR + 30 * 60_000, app: 'api', type: 'error-new' });      // day B
  events.push({ ts: d0 + DAY + 9 * HOUR, app: 'web', type: 'crash' });                         // day B
  events.push({ ts: d0 + 2 * DAY + 12 * HOUR, app: 'web', type: 'status', to_state: 'stopped' }); // day C
  return { d0, events };
}

test('chord key is stable', () => {
  assert.equal(TIMELINE_CHORD_KEY, 'i');
});

test('events across three days render three day buckets with correct counts', () => {
  const { events } = threeDays();
  const buckets = bucketize(events, 'day');
  assert.equal(buckets.length, 3);
  assert.deepEqual(buckets.map(b => b.count), [2, 3, 1]);
  assert.equal(buckets[0].end - buckets[0].start, bucketSpan('day'));
});

test('drilling a day re-buckets that day into hour buckets', () => {
  const { events } = threeDays();
  const days = bucketize(events, 'day');
  const dayB = days[1]; // the 3-event day
  const hours = bucketize(events, 'hour', { from: dayB.start, to: dayB.end });
  // Day B has events at 08:00, 08:30 (same hour) and 09:00 → 2 hour buckets.
  assert.equal(hours.length, 2);
  assert.deepEqual(hours.map(h => h.count), [2, 1]);
});

test('state-change jump lands on the app crash event', () => {
  const { events } = threeDays();
  // From the very start, the next web state change is the 'starting' event; the
  // one after that is the crash. Walk forward twice to reach the crash.
  const first = findStateChange(events, 'web', 0, 1);
  const crashTs = events.find(e => e.type === 'crash').ts;
  const second = findStateChange(events, 'web', first, 1);
  assert.equal(second, crashTs);
  // Previous from the very end lands on the last web state change (stopped).
  const stoppedTs = events.find(e => e.to_state === 'stopped').ts;
  assert.equal(findStateChange(events, 'web', Infinity, -1), stoppedTs);
  // api never starts/stops/crashes → no state change.
  assert.equal(findStateChange(events, 'api', 0, 1), null);
});

test('isStateChange only fires for the app on start/stop/crash', () => {
  assert.equal(isStateChange({ app: 'web', type: 'status', to_state: 'starting' }, 'web'), true);
  assert.equal(isStateChange({ app: 'web', type: 'status', to_state: 'stopped' }, 'web'), true);
  assert.equal(isStateChange({ app: 'web', type: 'crash' }, 'web'), true);
  assert.equal(isStateChange({ app: 'web', type: 'status', to_state: 'serving' }, 'web'), false);
  assert.equal(isStateChange({ app: 'web', type: 'error-new' }, 'web'), false);
  assert.equal(isStateChange({ app: 'other', type: 'crash' }, 'web'), false);
});

test('bucketIndexForTs finds the containing bucket, then nearest', () => {
  const { events } = threeDays();
  const days = bucketize(events, 'day');
  const crashTs = events.find(e => e.type === 'crash').ts;
  assert.equal(bucketIndexForTs(days, crashTs), 1); // crash is on day B
  assert.equal(bucketIndexForTs([], 123), -1);
});

test('Home/End edges via clampIndex', () => {
  assert.equal(clampIndex(-5, 3), 0);   // Home
  assert.equal(clampIndex(99, 3), 2);   // End
  assert.equal(clampIndex(1, 3), 1);
  assert.equal(clampIndex(0, 0), -1);   // empty history
});

test('empty history yields no buckets, no crash', () => {
  assert.deepEqual(bucketize([], 'day'), []);
  assert.deepEqual(bucketize([], 'hour'), []);
});

test('density sparkline scales to the busiest bucket', () => {
  assert.equal(densityGlyph(0, 10), '▁');
  assert.equal(densityGlyph(10, 10), '█');
  assert.equal(densityGlyph(5, 10), '▅'); // round(0.5 * 7) = 4
  assert.equal(densityGlyph(3, 0), '▁'); // guard against divide-by-zero
});
