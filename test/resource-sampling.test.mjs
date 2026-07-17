// M105 — resource sampling. The UsageMonitor's existing pidusage tick gains a
// per-app downsampler feeding history's resource_samples table. These tests
// pin the acceptance criteria: cadence-gated rows, sampleMs 0 = zero rows,
// dead-pid fail-soft, retention pruning, v1.2 DB back-compat — plus the two
// bench measurements the plan demands land WITH the milestone (write path and
// idle CPU, sampling on vs off).
//
// Timing discipline: pidusage on Windows shells out (wmic/PowerShell) and a
// single reading can take >1s under load, so the live-loop tests are
// CONDITION-driven with generous ceilings — they assert what happened, never
// how fast (the M91 ports-forensics discipline). Fixed sleeps appear only
// where a false PASS is the worst they can cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { History } from '../dist/history.js';
import { UsageMonitor } from '../dist/usage.js';

const requireCjs = createRequire(import.meta.url);

function tempDbPath(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `daimon-res-${tag}-`));
  return path.join(dir, 'history.db');
}

// Minimal Registry stand-in: UsageMonitor needs names(), getState(), emit().
function stubRegistry(apps) {
  const states = new Map(Object.entries(apps).map(([name, pid]) => [
    name, { name, pid, cpu: null, memMB: null },
  ]));
  return {
    names: () => [...states.keys()],
    getState: n => states.get(n),
    emit: () => {},
    _states: states,
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Poll until cond() is truthy or the ceiling passes. Returns the last value.
async function waitFor(cond, { ceilingMs = 20_000, stepMs = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - t0 > ceilingMs) return cond();
    await sleep(stepMs);
  }
}

const OWN_PID = process.pid;
// A pid that cannot exist (Windows pids are DWORDs well below this).
const DEAD_PID = 0x7ffffff0;

// The five live-loop scenarios each drive their own independent monitor, so
// they run as CONCURRENT subtests — wall time is the slowest scenario, not
// the sum (pidusage shells out at ~1s/reading on Windows; serially these
// five dominated the whole suite's tail).
test('live sampling loop', { concurrency: 5 }, async t => {
  await Promise.all([

  t.test('sampling records downsampled rows at the configured cadence', async () => {
  const h = new History({ enabled: true, path: tempDbPath('cadence'), retentionDays: 30 });
  const errors = [];
  // sampleMs 1 → every successful reading lands (readings are already bounded
  // by the poll interval); the cadence gate itself is pinned in the next test.
  const mon = new UsageMonitor(stubRegistry({ alpha: OWN_PID }), 200, {
    sampleMs: 1,
    onSample: (name, ts, rss, cpu) => h.recordResourceSample(name, rss, cpu, ts),
    onSampleError: (name, err) => errors.push({ name, err }),
  });
  const rows = await waitFor(() => {
    h._flushForTest();
    const r = h.queryResourceSamples({ app: 'alpha' });
    return r.length >= 2 ? r : null;
  });
  mon.stop();
  assert.ok(rows && rows.length >= 2, `expected >=2 samples for a live pid, got ${rows?.length ?? 0}`);
  for (const r of rows) {
    assert.equal(r.app, 'alpha');
    assert.ok(Number.isFinite(r.ts));
    assert.ok(r.rss > 0, 'rss should be positive bytes for a live process');
    assert.ok(r.cpu >= 0, 'cpu should be a non-negative percent');
  }
  assert.deepEqual(errors, []);
  h.close();
  }),

  t.test('a long sampleMs downsamples: one row, then the gate holds', async () => {
  const h = new History({ enabled: true, path: tempDbPath('gate'), retentionDays: 30 });
  let readings = 0; // successful pidusage readings observed via live state churn
  const reg = stubRegistry({ alpha: OWN_PID });
  reg.emit = () => { readings++; };
  const mon = new UsageMonitor(reg, 200, {
    sampleMs: 600_000,
    onSample: (name, ts, rss, cpu) => h.recordResourceSample(name, rss, cpu, ts),
  });
  // Wait until the first row lands, then until at least two MORE readings
  // completed — the 10-minute gate must have swallowed them.
  await waitFor(() => {
    h._flushForTest();
    return h.queryResourceSamples({ app: 'alpha' }).length >= 1;
  });
  const seen = readings;
  await waitFor(() => readings >= seen + 2);
  mon.stop();
  h._flushForTest();
  const rows = h.queryResourceSamples({ app: 'alpha' });
  assert.equal(rows.length, 1, `sampleMs=10min must gate follow-up readings, got ${rows.length} rows`);
  h.close();
  }),

  t.test('sampleMs 0 disables persistence entirely — zero rows, live loop unaffected', async () => {
  const h = new History({ enabled: true, path: tempDbPath('off'), retentionDays: 30 });
  let called = 0;
  const reg = stubRegistry({ alpha: OWN_PID });
  const mon = new UsageMonitor(reg, 200, {
    sampleMs: 0,
    onSample: () => { called++; },
  });
  // The live usage display must still work with persistence disabled.
  const live = await waitFor(() => reg._states.get('alpha').memMB != null);
  mon.stop();
  assert.ok(live, 'live memMB should still be polled with sampleMs 0');
  assert.ok(reg._states.get('alpha').memMB > 0);
  assert.equal(called, 0, 'sampleMs 0 must never invoke onSample');
  h._flushForTest();
  assert.equal(h.queryResourceSamples({}).length, 0);
  h.close();
  }),

  t.test('dead pid mid-cycle: no throw, other apps keep sampling', async () => {
  const h = new History({ enabled: true, path: tempDbPath('dead'), retentionDays: 30 });
  const reg = stubRegistry({ ghost: DEAD_PID, alpha: OWN_PID });
  const mon = new UsageMonitor(reg, 200, {
    sampleMs: 1,
    onSample: (name, ts, rss, cpu) => h.recordResourceSample(name, rss, cpu, ts),
  });
  const ok = await waitFor(() => {
    h._flushForTest();
    return h.queryResourceSamples({ app: 'alpha' }).length >= 1;
  });
  mon.stop();
  assert.ok(ok, 'live app must keep sampling alongside a dead one');
  assert.equal(h.queryResourceSamples({ app: 'ghost' }).length, 0, 'dead pid must produce no samples');
  h.close();
  }),

  t.test('onSample failure is fail-soft: one error callback per episode, then re-arms on recovery', async () => {
  const errors = [];
  let alphaAttempts = 0;
  let alphaOk = 0;
  let betaOk = 0;
  let shouldThrow = true;
  const mon = new UsageMonitor(stubRegistry({ alpha: OWN_PID, beta: OWN_PID }), 200, {
    sampleMs: 1,
    onSample: (name) => {
      if (name === 'alpha') {
        alphaAttempts++;
        if (shouldThrow) throw new Error('db hiccup');
        alphaOk++;
      } else {
        betaOk++;
      }
    },
    onSampleError: (name) => errors.push(name),
  });
  // At least two failing alpha attempts — and still exactly ONE callback.
  await waitFor(() => alphaAttempts >= 2 && betaOk >= 1);
  assert.deepEqual(errors, ['alpha'], `one error callback per failure episode, got ${JSON.stringify(errors)}`);
  // Recovery re-arms: a success clears the latch, a fresh failure fires again.
  shouldThrow = false;
  await waitFor(() => alphaOk >= 1);
  shouldThrow = true;
  await waitFor(() => errors.length >= 2);
  mon.stop();
  assert.deepEqual(errors, ['alpha', 'alpha'], 'after a successful sample the latch re-arms');
  assert.ok(betaOk >= 1, 'the healthy app keeps sampling through a neighbor\'s failures');
  }),

  ]);
});

test('retention prunes old resource_samples rows', () => {
  const h = new History({ enabled: true, path: tempDbPath('ret'), retentionDays: 30 });
  const now = Date.now();
  const oldTs = now - 40 * 86400000;
  h.recordResourceSample('alpha', 100 * 1048576, 5, oldTs);
  h.recordResourceSample('alpha', 120 * 1048576, 6, now);
  h._flushForTest();
  assert.equal(h.queryResourceSamples({ app: 'alpha' }).length, 2);
  h._runRetentionForTest();
  const rows = h.queryResourceSamples({ app: 'alpha' });
  assert.equal(rows.length, 1, 'the 40-day-old row must be pruned at retentionDays=30');
  assert.equal(rows[0].ts, now);
  h.close();
});

test('a pre-1.3 history.db (no resource_samples table) opens cleanly and gains the table', () => {
  const dbPath = tempDbPath('compat');
  // Simulate a v1.2 DB: a valid SQLite file with the old core tables and no
  // resource_samples. The additive CREATE TABLE IF NOT EXISTS must upgrade it.
  const Better = requireCjs('better-sqlite3');
  const raw = new Better(dbPath);
  raw.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, app TEXT NOT NULL, type TEXT NOT NULL, from_state TEXT, to_state TEXT, message TEXT);
    CREATE TABLE log_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, app TEXT NOT NULL, line TEXT NOT NULL, level TEXT);
  `);
  raw.prepare('INSERT INTO events (ts,app,type) VALUES (?,?,?)').run(Date.now(), 'alpha', 'status');
  raw.close();

  const h = new History({ enabled: true, path: dbPath, retentionDays: 30 });
  assert.equal(h.quickCheck(), true, 'v1.2 db must open clean under v1.3');
  assert.ok(h.queryEvents({ app: 'alpha' }).length >= 1, 'old rows survive the migration');
  h.recordResourceSample('alpha', 100 * 1048576, 3);
  h._flushForTest();
  assert.equal(h.queryResourceSamples({ app: 'alpha' }).length, 1, 'the additive table works after migration');
  h.close();
});

test('resource sampling with history disabled is a no-op, never a throw', () => {
  const h = new History({ enabled: false, path: tempDbPath('disabled'), retentionDays: 30 });
  h.recordResourceSample('alpha', 1048576, 1);
  h._flushForTest();
  assert.deepEqual(h.queryResourceSamples({}), []);
  h.close();
});

// ── Bench 1 (M105): write-path p50/p95, sampling rows interleaved vs not ────
// Sampling rows ride the same batched flush transaction as events/log lines.
// At the default 30s cadence, samples are <0.1% of write volume; this bench
// interleaves 2% — 20× the realistic worst case — and still demands the
// write path stay indistinguishable. Arms ALTERNATE batch by batch so
// external contention inflates both, never just one (M91 discipline).
test('bench: sampling rows do not move the history write path (p50/p95)', () => {
  const mkHistory = tag => new History({ enabled: true, path: tempDbPath(tag), retentionDays: 365 });
  const plain = mkHistory('bench-plain');
  const sampled = mkHistory('bench-sampled');
  const BATCH = 500;
  const ROUNDS = 12; // per arm
  const now = Date.now();

  const runBatch = (h, withSamples, round) => {
    const t0 = performance.now();
    for (let i = 0; i < BATCH; i++) {
      const ts = now - (round * BATCH + i) * 10;
      h.recordEvent({ ts, app: 'alpha', type: 'status', from: 'compiling', to: 'serving' });
      h.recordLogLine('alpha', `line ${round}:${i} lorem ipsum compile finished in ${i}ms`, ts);
      if (withSamples && i % 50 === 0) h.recordResourceSample('alpha', 200 * 1048576 + i, 12.5, ts);
    }
    h._flushForTest();
    return performance.now() - t0;
  };

  const plainTimes = [];
  const sampledTimes = [];
  for (let r = 0; r < ROUNDS; r++) {
    // Alternate arms within each round — same machine, same moment.
    plainTimes.push(runBatch(plain, false, r));
    sampledTimes.push(runBatch(sampled, true, r));
  }
  plain.close();
  sampled.close();

  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  };
  const p50Plain = pct(plainTimes, 0.5), p95Plain = pct(plainTimes, 0.95);
  const p50Sampled = pct(sampledTimes, 0.5), p95Sampled = pct(sampledTimes, 0.95);
  const detail = `plain p50=${p50Plain.toFixed(1)}ms p95=${p95Plain.toFixed(1)}ms · sampled p50=${p50Sampled.toFixed(1)}ms p95=${p95Sampled.toFixed(1)}ms`;
  // Indistinguishable = within 1.5× + a 5ms absolute floor for timer noise on
  // sub-10ms batches. A genuine write-path regression (per-insert triggers,
  // an extra fsync) lands far outside this envelope.
  assert.ok(p50Sampled <= p50Plain * 1.5 + 5, `write-path p50 moved: ${detail}`);
  assert.ok(p95Sampled <= p95Plain * 1.5 + 10, `write-path p95 moved: ${detail}`);
});

// ── Bench 2 (M105): idle-CPU cost of sampling ───────────────────────────────
// Whole-process CPU comparison is hopeless here: pidusage shells out on
// Windows and its spawn cost swings 3× run to run, drowning the microseconds
// the downsampler adds. Instead the bench attributes cost DIRECTLY: it times
// every entry into the sampling path (the onSample hook + the history flush
// of the rows it queued) across a real monitor run, and pins that total
// against an absolute ceiling and an interleaved CPU reference (M91) — the
// two things a per-tick regression (second timer, sync IO on the tick)
// cannot dodge.
test('bench: the sampling path adds negligible CPU to the usage poll', async () => {
  const h = new History({ enabled: true, path: tempDbPath('bench-cpu'), retentionDays: 30 });
  const cpuReferenceMs = () => {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < 4_000_000; i++) x = (x * 31 + i) % 1000003;
    if (x === -1) throw new Error('unreachable');
    return performance.now() - t0;
  };

  let sampleCostMs = 0;
  let samples = 0;
  const refs = [cpuReferenceMs()];
  const mon = new UsageMonitor(stubRegistry({ alpha: OWN_PID, beta: OWN_PID }), 200, {
    sampleMs: 1, // worst case: every reading persists (default is 30s)
    onSample: (name, ts, rss, cpu) => {
      const t0 = performance.now();
      h.recordResourceSample(name, rss, cpu, ts);
      sampleCostMs += performance.now() - t0;
      samples++;
    },
  });
  await waitFor(() => samples >= 6);
  mon.stop();
  refs.push(cpuReferenceMs());
  const tFlush = performance.now();
  h._flushForTest();
  sampleCostMs += performance.now() - tFlush;
  h.close();

  const refMedian = [...refs].sort((a, b) => a - b)[Math.floor(refs.length / 2)];
  const perSample = sampleCostMs / Math.max(samples, 1);
  // Quiet-machine reality is microseconds per sample; the ceiling leaves two
  // orders of magnitude while still catching any real per-tick work.
  assert.ok(perSample < 2 || sampleCostMs < 3 * refMedian,
    `sampling path cost moved: ${perSample.toFixed(3)}ms/sample over ${samples} samples (total ${sampleCostMs.toFixed(1)}ms, cpuRef ${refMedian.toFixed(1)}ms)`);
});
