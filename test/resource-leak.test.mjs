// M107 — leak suspicion, the trust-critical detector. Verdicts are pure
// functions of a synthetic sample series: no real processes, no wall clock
// (episode bookkeeping keys off sample timestamps). The acceptance list from
// the plan is pinned one test per row — a false accusation here is the bug
// that gets the whole feature turned off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Isolation (M91 rule, enforced in v1.13): the Notifier below writes a
// notifications.log under daimonDir(). Without DAIMON_HOME that lands in the
// user's REAL ~/.daimon, which made test/demo-script.test.mjs — it asserts the
// real state dir is untouched — fail whenever the two ran in parallel. Set
// before importing the notifier so its constructor resolves the temp dir.
const TMP_HOME = path.join(os.tmpdir(), `daimon-resource-leak-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.DAIMON_HOME = TMP_HOME;

const { ResourceGuard, computeBaseline, evaluateLeakWindow } = await import('../dist/resources.js');
const { Notifier } = await import('../dist/notifier.js');

const MB = 1024 * 1024;
const STEP = 30_000; // default sampleMs cadence

// Deterministic PRNG — contention-shaped noise with reproducible runs.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Drive a guard with a generated series: fn(i, ts) → { rss, cpu }.
function drive(guard, app, count, fn, { startTs = 0, step = STEP } = {}) {
  for (let i = 0; i < count; i++) {
    const ts = startTs + i * step;
    const { rss, cpu } = fn(i, ts);
    guard.note(app, ts, rss, cpu);
  }
  return startTs + count * step;
}

function leakCollector() {
  const events = [];
  const guard = new ResourceGuard({ onLeakSuspect: info => events.push(info) });
  return { guard, events };
}

// 2h of samples = 240 steps; warm-up is the first 10, window fires from ~40.
const LONG = 240;

test('steady RSS with jitter → no leak event, ever', () => {
  const { guard, events } = leakCollector();
  const rnd = mulberry32(1);
  drive(guard, 'web', LONG, () => ({ rss: 200 * MB + (rnd() - 0.5) * 4 * MB, cpu: 5 }));
  assert.deepEqual(events, []);
});

test('monotonic growth beyond tolerance across a full window → exactly one event, with remedy text', () => {
  const { guard, events } = leakCollector();
  const rnd = mulberry32(2);
  // Stable 200MB warm-up, then +1MB per sample forever (a classic slow leak).
  drive(guard, 'web', LONG, i => ({
    rss: (i < 11 ? 200 : 200 + (i - 10)) * MB + (rnd() - 0.5) * 0.5 * MB,
    cpu: 5,
  }));
  assert.equal(events.length, 1, `exactly one event per episode, got ${events.length}`);
  const ev = events[0];
  assert.equal(ev.app, 'web');
  assert.ok(ev.currentRssMB > ev.baselineRssMB, 'payload carries baseline vs current');
  assert.ok(ev.growthMB > 0 && ev.growthPerMinMB > 0, 'payload carries growth rate');
  assert.ok(ev.remedy.includes('restart') || ev.remedy.includes('Restart'), 'remedy says what to do next');
  assert.ok(ev.remedy.includes('never kills'), 'remedy restates warn-never-kill');
});

test('growth resuming after re-arm → a second event', () => {
  const { guard, events } = leakCollector();
  let end = drive(guard, 'web', 60, i => ({
    rss: (i < 11 ? 200 : 200 + (i - 10) * 2) * MB, cpu: 5,
  }));
  assert.equal(events.length, 1, 'first episode fired');
  // Back to baseline: the drop re-arms the episode (and structurally breaks
  // monotonicity for the next full window).
  end = drive(guard, 'web', 10, () => ({ rss: 200 * MB, cpu: 5 }), { startTs: end });
  // Second leak, long enough for a full fresh window past the drop.
  drive(guard, 'web', 60, i => ({ rss: (200 + i * 2) * MB, cpu: 5 }), { startTs: end });
  assert.equal(events.length, 2, `re-armed episode fires again, got ${events.length}`);
});

test('plateau after a leak event → still one event (no re-fire without return to baseline)', () => {
  const { guard, events } = leakCollector();
  const end = drive(guard, 'web', 60, i => ({
    rss: (i < 11 ? 200 : 200 + (i - 10) * 2) * MB, cpu: 5,
  }));
  // High plateau for another hour: episode stays open, no second accusation.
  drive(guard, 'web', 120, () => ({ rss: 300 * MB, cpu: 5 }), { startTs: end });
  assert.equal(events.length, 1);
});

test('noisy-but-flat (contention-shaped) series → no event', () => {
  const { guard, events } = leakCollector();
  const rnd = mulberry32(3);
  // ±10MB swings around a flat 200MB — exactly what a busy machine looks like.
  drive(guard, 'web', LONG, () => ({ rss: 200 * MB + (rnd() - 0.5) * 20 * MB, cpu: 5 }));
  assert.deepEqual(events, []);
});

test('sawtooth GC pattern (grow, drop, grow) → no event', () => {
  const { guard, events } = leakCollector();
  // Climb 1.5MB/sample for 10 samples, GC drops 15MB, repeat. Net flat.
  drive(guard, 'web', LONG, i => ({ rss: (200 + (i % 10) * 1.5) * MB, cpu: 5 }));
  assert.deepEqual(events, []);
});

test('slow upward drift within noise → no event (growth below threshold)', () => {
  const { guard, events } = leakCollector();
  const rnd = mulberry32(4);
  // +0.1MB/sample drift on a 500MB app: 3MB per window ≪ max(4×jitter, 10%).
  drive(guard, 'web', LONG, i => ({ rss: 500 * MB + i * 0.1 * MB + (rnd() - 0.5) * 2 * MB, cpu: 5 }));
  assert.deepEqual(events, []);
});

test('too few warm-up samples → no baseline → no verdicts, ever', () => {
  const { guard, events } = leakCollector();
  // 2-minute cadence: only 3 samples inside the 5-minute warm-up.
  drive(guard, 'web', 120, i => ({ rss: (200 + i * 5) * MB, cpu: 5 }), { step: 120_000 });
  assert.deepEqual(events, [], 'no baseline must mean no accusations');
  assert.equal(guard.state('web').baseline, null);
});

test('warm-up climb of a normally-starting app never reads as a leak', () => {
  const { guard, events } = leakCollector();
  // Startup allocations: steep climb through warm-up, flat afterwards.
  drive(guard, 'web', LONG, i => ({ rss: (i < 11 ? 100 + i * 20 : 320) * MB, cpu: 5 }));
  assert.deepEqual(events, []);
});

test('restart recalibrates: reset() clears baseline, episodes re-arm silently', () => {
  const { guard, events } = leakCollector();
  drive(guard, 'web', 60, i => ({ rss: (i < 11 ? 200 : 200 + (i - 10) * 2) * MB, cpu: 5 }));
  assert.equal(events.length, 1);
  assert.equal(guard.state('web').leak.active, true);
  guard.reset('web');
  const s = guard.state('web');
  assert.equal(s.leak.active, false);
  assert.equal(s.baseline, null);
  // The new process is HEAVIER but stable — against ITS OWN fresh baseline
  // that's healthy, not a leak.
  drive(guard, 'web', LONG, () => ({ rss: 400 * MB, cpu: 5 }));
  assert.equal(events.length, 1, 'stable-after-restart must not re-accuse');
});

test('a sampling gap voids the window (no verdict across a suspend/resume)', () => {
  const { guard, events } = leakCollector();
  // Warm-up + some flat samples, a 20-minute hole (laptop lid), then higher
  // flat RSS. first-after-gap to last spans < 80% of the window → silent.
  let end = drive(guard, 'web', 20, () => ({ rss: 200 * MB, cpu: 5 }));
  drive(guard, 'web', 8, i => ({ rss: (260 + i) * MB, cpu: 5 }), { startTs: end + 20 * 60_000 });
  assert.deepEqual(events, []);
});

test('per-app isolation: a leaking neighbor never marks a healthy app', () => {
  const { guard, events } = leakCollector();
  for (let i = 0; i < LONG; i++) {
    const ts = i * STEP;
    guard.note('leaky', ts, (i < 11 ? 200 : 200 + (i - 10)) * MB, 5);
    guard.note('healthy', ts, 300 * MB, 5);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].app, 'leaky');
  assert.equal(guard.state('healthy').leak.active, false);
});

// ── Pure-function edges ─────────────────────────────────────────────────────

test('computeBaseline: median + MAD, null under the minimum sample count', () => {
  const mk = rss => ({ ts: 0, rss, cpu: 0 });
  assert.equal(computeBaseline([mk(1), mk(2), mk(3), mk(4)]), null, '4 samples < minimum');
  const b = computeBaseline([100, 102, 98, 101, 99].map(mk));
  assert.equal(b.rssMedian, 100);
  assert.equal(b.rssJitter, 1, 'MAD of [0,2,2,1,1] around 100 is 1');
  assert.equal(b.samples, 5);
});

test('evaluateLeakWindow: dips within jitter tolerated, beyond break monotonicity', () => {
  const base = { rssMedian: 200 * MB, rssJitter: 2 * MB };
  const mk = (i, rss) => ({ ts: i * STEP, rss: rss * MB, cpu: 0 });
  // Growth with small dips (≤ jitter): still monotonic, still suspect.
  const dippy = [200, 205, 204, 210, 209, 215, 214, 220, 226, 232].map((r, i) => mk(i, r));
  const v1 = evaluateLeakWindow(dippy, base);
  assert.equal(v1.monotonic, true);
  assert.equal(v1.suspect, true, '32MB growth beats max(4×2MB, 10%×200MB=20MB)');
  // One GC-sized drop: not monotonic, never suspect regardless of growth.
  const gc = [200, 210, 220, 205, 230, 240, 250, 260, 270, 280].map((r, i) => mk(i, r));
  const v2 = evaluateLeakWindow(gc, base);
  assert.equal(v2.monotonic, false);
  assert.equal(v2.suspect, false);
});

test('evaluateLeakWindow: growth below max(4×jitter, 10% of median) is not suspect', () => {
  const base = { rssMedian: 1000 * MB, rssJitter: 1 * MB };
  const mk = (i, rss) => ({ ts: i * STEP, rss: rss * MB, cpu: 0 });
  // Perfectly monotonic +50MB on a 1GB app — under the 100MB (10%) bar.
  const series = Array.from({ length: 10 }, (_, i) => mk(i, 1000 + i * 5.5));
  const v = evaluateLeakWindow(series, base);
  assert.equal(v.monotonic, true);
  assert.equal(v.suspect, false, 'threshold must scale with the app, not a magic MB figure');
});

// ── Notification kind: opt-in only (M107) ───────────────────────────────────

test('resource-leak-suspect notification fires only when opted into notifications.kinds', async () => {
  const payload = JSON.stringify({ baselineRssMB: 200, currentRssMB: 260, growthMB: 60, growthPerMinMB: 4, windowMs: 900000, remedy: 'restart' });
  // Opted in → notification.
  const reg1 = new (class extends EventEmitter {})();
  const got1 = [];
  const n1 = new Notifier(reg1, { enabled: true, onError: true, onUnhealthy: true, tray: false, kinds: ['resource-leak-suspect'] }, { sink: p => got1.push(p) });
  reg1.emit('event', { ts: Date.now(), app: 'web', type: 'resource-leak-suspect', message: payload });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(got1.length, 1, JSON.stringify(got1));
  assert.ok(got1[0].title.includes('possible memory leak'));
  n1.stop();
  // Absent kinds (legacy set) → zero new noise.
  const reg2 = new (class extends EventEmitter {})();
  const got2 = [];
  const n2 = new Notifier(reg2, { enabled: true, onError: true, onUnhealthy: true, tray: false }, { sink: p => got2.push(p) });
  reg2.emit('event', { ts: Date.now(), app: 'web', type: 'resource-leak-suspect', message: payload });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(got2, [], 'absent notifications.kinds = zero new noise');
  n2.stop();
});
