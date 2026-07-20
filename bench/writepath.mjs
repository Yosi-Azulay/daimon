#!/usr/bin/env node
// M147 (v1.10) — write-path audit under sustained load.
//
// Reads are certified by scale.mjs; this proves the other direction: ingest
// never falls behind, the queue never grows without bound, retention never
// blocks the loop, and FTS indexing stays OFF the write path no matter how
// hard we push.
//
// Same discipline as every other v1.10 gate: `--write` records the measured
// baseline on a quiet machine, later runs derive budget = baseline p95 x class
// headroom and check both the absolute and the contention axis.
//
// Usage:
//   node bench/writepath.mjs --write     # record the baseline (quiet only)
//   node bench/writepath.mjs             # gate against it

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { repoRoot } from './lib/daemonHarness.mjs';
import { ensureCorpus } from './lib/corpus.mjs';
import { probeMachine, deriveBudget, checkBudget, percentile, median, round, cpuReferenceMs } from './lib/machine.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => {
  const hit = argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};

const SCALE = Number(opt('scale') || 1_000_000);
export const WRITE_BASELINE_PATH = path.join(repoRoot, 'bench', 'BASELINE-v1.10-write.json');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const CLASSES = {
  'event-ingest': ['write', 'per-call recordEvent latency under a sustained storm'],
  'logline-ingest': ['write', 'per-call recordLogLine latency — the hottest insert daimon has'],
  'retention-prune': ['batch', 'the pruning pass over a full corpus; must not block the loop'],
};

// Storm rates. Chosen to exceed anything a real dev server produces: the M101
// log-storm detector fires in the hundreds of lines/min, so tens of thousands
// of inserts in a tight loop is far past the worst real case.
const STORM_EVENTS = 50_000;
const STORM_LOGLINES = 100_000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-bench-write-'));
}

/**
 * Sustained ingest with per-call timing. Records the p95 of the INDIVIDUAL
 * call (what a caller on the daemon's event loop actually waits for), plus the
 * peak queue depth — a queue that grows monotonically means ingest is losing.
 */
async function measureIngest() {
  const { History } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'history.js')).href);
  const dir = tmpDir();
  const out = {};
  try {
    for (const [name, n, call] of [
      ['event-ingest', STORM_EVENTS, (h, i) => h.recordEvent({
        ts: Date.now(), app: 'app' + (i % 10), type: i % 5 === 0 ? 'error-new' : 'status',
        message: `Error: Cannot resolve module './cmp${i % 500}' ECONNREFUSED 127.0.0.1:${4200 + (i % 50)} #${i}`,
      })],
      ['logline-ingest', STORM_LOGLINES, (h, i) => h.recordLogLine(
        'app' + (i % 10), `[info] chunk ${i % 900} built in ${100 + (i % 800)}ms src/app/f${i % 200}.ts`, Date.now(), 'info',
      )],
    ]) {
      const h = new History({ enabled: true, path: path.join(dir, name + '.db'), retentionDays: 3650 });
      try {
        // Warm up prepared statements so the first call's compile cost is not
        // reported as the storm's p95.
        for (let i = 0; i < 500; i++) call(h, i);
        h._flushForTest();

        const times = [];
        const refs = [cpuReferenceMs()];
        let peakQueue = 0;
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          call(h, i);
          times.push(performance.now() - t0);
          // The flush queue is the backpressure signal: it is drained on a
          // timer, so a storm that outruns the drain shows up here first.
          const depth = h._queueDepthForTest?.() ?? 0;
          if (depth > peakQueue) peakQueue = depth;
          if (i % 20_000 === 19_999) { h._flushForTest(); refs.push(cpuReferenceMs()); }
        }
        h._flushForTest();
        refs.push(cpuReferenceMs());
        const finalDepth = h._queueDepthForTest?.() ?? 0;
        out[name] = {
          p50: round(percentile(times, 0.5), 4),
          p95: round(percentile(times, 0.95), 4),
          p99: round(percentile(times, 0.99), 4),
          max: round(Math.max(...times), 3),
          samples: times.length,
          peakQueue,
          finalDepth,
          cpuRefMedianMs: round(median(refs)),
          method: `${n} sequential ${name === 'event-ingest' ? 'recordEvent' : 'recordLogLine'} calls, per-call timing, flushed every 20k`,
        };
      } finally {
        h.close();
      }
    }
    return out;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Retention pass over a real corpus. Runs against a COPY so the shared corpus
 * keeps its rows — a prune that actually deleted them would make every later
 * run measure a smaller database.
 */
async function measureRetention(corpusDb) {
  const { History } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'history.js')).href);
  const work = corpusDb.replace(/\.db$/, '.prune.db');
  fs.copyFileSync(corpusDb, work);
  try {
    // retentionDays 30 against a 90-day corpus: roughly two thirds of every
    // table is eligible, which is the expensive case rather than a no-op.
    const h = new History({ enabled: true, path: work, retentionDays: 30 });
    try {
      const refs = [cpuReferenceMs()];
      const { slices, totalMs } = h._runRetentionForTest();
      refs.push(cpuReferenceMs());
      const maxSlice = slices.length ? Math.max(...slices) : 0;
      return {
        // The budgeted figure is the p95 SLICE — not the total, and not the max.
        //
        // Total wall-clock for a huge prune is allowed to be tens of seconds: it
        // is background work that now yields between slices. What may never
        // happen again is a single uninterruptible span long enough to freeze
        // the TUI and stall the HTTP API, which is exactly what the unsliced
        // prune did for 28.8s on this corpus.
        //
        // Max is recorded but NOT budgeted, because measurement showed it is
        // not controlled by the chunk size: shrinking chunks 5000 -> 1000 -> 400
        // left p95 flat (158/164/135ms) while max swung 459/3050/494ms. Those
        // outliers are SQLite WAL checkpoint stalls landing inside a slice, not
        // deletion cost. Budgeting the max would gate on checkpoint noise.
        'retention-prune': {
          p50: round(percentile(slices, 0.5)),
          p95: round(percentile(slices, 0.95)),
          maxSliceMs: round(maxSlice),
          totalMs: round(totalMs),
          slices: slices.length,
          samples: slices.length,
          cpuRefMedianMs: round(median(refs)),
          method: `retentionDays=30 over the ${SCALE}-event, 90-day corpus (~2/3 eligible); `
            + 'budgeted figure is the p95 SINGLE synchronous slice, not the total',
        },
      };
    } finally {
      h.close();
    }
  } finally {
    try { fs.rmSync(work, { force: true }); } catch {}
    for (const sfx of ['-wal', '-shm']) { try { fs.rmSync(work + sfx, { force: true }); } catch {} }
  }
}

/**
 * The standing invariant, re-asserted at v1.10 scale: FTS indexing must never
 * be attached to INSERT. Checked structurally (no AFTER/BEFORE INSERT trigger
 * exists) AND behaviourally (an FTS-enabled history must not cost materially
 * more per insert than one whose FTS is unavailable).
 */
async function measureFtsOverhead() {
  const { History } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'history.js')).href);
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const dir = tmpDir();
  try {
    const squat = path.join(dir, 'nofts.db');
    const raw = new Database(squat);
    raw.exec('CREATE TABLE events_fts (rowid INTEGER, message TEXT)');
    raw.close();

    const withFts = new History({ enabled: true, path: path.join(dir, 'fts.db'), retentionDays: 3650 });
    const noFts = new History({ enabled: true, path: squat, retentionDays: 3650 });
    try {
      if (!withFts.ftsAvailable()) throw new Error('expected FTS to be available');
      if (noFts.ftsAvailable()) throw new Error('expected the squatted db to have no usable FTS');
      const writeN = (hist, n) => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) hist.recordEvent({ ts: Date.now(), app: 'a', type: 'status', message: 'msg line number ' + i });
        hist._flushForTest();
        return performance.now() - t0;
      };
      writeN(withFts, 2000); writeN(noFts, 2000); // warm
      let bestRatio = Infinity;
      for (let round = 0; round < 3; round++) {
        const tNo = writeN(noFts, 15_000);
        const tYes = writeN(withFts, 15_000);
        bestRatio = Math.min(bestRatio, tYes / tNo);
      }
      return { ratio: round(bestRatio, 3) };
    } finally {
      withFts.close();
      noFts.close();
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function assertNoInsertTriggers() {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'history.ts'), 'utf8');
  const triggers = [...src.matchAll(/CREATE\s+TRIGGER[^;]*?(AFTER|BEFORE)\s+(INSERT|UPDATE|DELETE)\s+ON\s+(\w+)/gi)];
  const offenders = triggers.filter(t => t[2].toUpperCase() !== 'DELETE');
  if (offenders.length) {
    throw new Error(`FTS indexing must stay off the write path — found ${offenders.map(o => `${o[1]} ${o[2]} ON ${o[3]}`).join(', ')}`);
  }
  return { triggers: triggers.length, insertTriggers: 0 };
}

export async function runWritePath({ scale = SCALE } = {}) {
  const machineBefore = await probeMachine();
  const { dbPath, meta } = await ensureCorpus(scale);

  log('· sustained event + log-line ingest …');
  const metrics = await measureIngest();
  log('· retention pass over the corpus …');
  Object.assign(metrics, await measureRetention(dbPath));
  log('· deferred-FTS discipline under load …');
  const fts = await measureFtsOverhead();
  const triggers = assertNoInsertTriggers();

  // Settle before re-probing — the bench's own teardown is not foreign load.
  await new Promise(r => setTimeout(r, 5000));
  const machineAfter = await probeMachine();
  return {
    schemaVersion: 1,
    release: 'v1.10.0',
    scale,
    corpus: { rows: meta.rows, dbBytes: meta.dbBytes },
    machineQuiet: machineBefore.quiet && machineAfter.quiet,
    machine: { before: machineBefore, after: machineAfter },
    fts: { ...fts, ...triggers },
    metrics,
  };
}

export function gate(fresh, baseline) {
  const rows = [];
  for (const [name, m] of Object.entries(fresh.metrics)) {
    const [klass, why] = CLASSES[name] ?? [];
    const base = baseline.metrics?.[name];
    if (!klass || !base || base.p95 == null) { rows.push({ name, status: 'skipped', detail: 'no class or baseline' }); continue; }
    const budget = deriveBudget(base, klass, why);
    const verdict = checkBudget(budget, m.p95, m.cpuRefMedianMs);
    rows.push({ name, status: verdict.ok ? 'ok' : 'OVER BUDGET', detail: verdict.detail });
  }
  // Backpressure is a hard invariant, not a budget: the queue must be empty
  // once the storm has been flushed. A non-empty tail means ingest lost.
  for (const name of ['event-ingest', 'logline-ingest']) {
    const m = fresh.metrics[name];
    if (!m) continue;
    rows.push({
      name: `${name}:drain`,
      status: m.finalDepth === 0 ? 'ok' : 'OVER BUDGET',
      detail: `queue drained to ${m.finalDepth} after flush (peak ${m.peakQueue})`,
    });
  }
  rows.push({
    name: 'fts-off-write-path',
    status: fresh.fts.ratio < 1.10 ? 'ok' : 'OVER BUDGET',
    detail: `FTS-enabled inserts cost x${fresh.fts.ratio} vs FTS-unavailable (ceiling 1.10), ${fresh.fts.insertTriggers} insert triggers`,
  });
  return rows;
}

function printMetrics(r) {
  log('');
  log(`scale ${r.scale.toLocaleString()} · machineQuiet ${r.machineQuiet}`);
  for (const [name, m] of Object.entries(r.metrics)) {
    const extra = m.peakQueue != null ? ` peakQueue ${m.peakQueue} finalDepth ${m.finalDepth}` : (m.maxSliceMs != null ? ` maxSlice ${m.maxSliceMs}ms over ${m.slices} slices, total ${m.totalMs}ms` : '');
    log(`  ${name.padEnd(18)} p50 ${m.p50}ms  p95 ${m.p95}ms${m.p99 != null ? `  p99 ${m.p99}ms` : ''}${extra}`);
  }
  log(`  ${'fts-overhead'.padEnd(18)} x${r.fts.ratio} (ceiling 1.10) · ${r.fts.insertTriggers} insert triggers`);
  log('');
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
})();

if (invokedDirectly) {
  const result = await runWritePath();
  printMetrics(result);
  if (flag('write')) {
    if (!result.machineQuiet) {
      process.stderr.write('[bench] refusing --write: machine was not quiet.\n');
      process.exit(2);
    }
    fs.writeFileSync(WRITE_BASELINE_PATH, JSON.stringify(result, null, 2) + '\n');
    log(`[bench] wrote ${path.relative(repoRoot, WRITE_BASELINE_PATH)}`);
  } else {
    if (!fs.existsSync(WRITE_BASELINE_PATH)) {
      process.stderr.write('[bench] no write-path baseline committed yet — run with --write on a quiet machine first.\n');
      process.exit(2);
    }
    const rows = gate(result, JSON.parse(fs.readFileSync(WRITE_BASELINE_PATH, 'utf8')));
    let failed = 0;
    for (const row of rows) {
      if (row.status === 'OVER BUDGET') failed++;
      log(`  ${row.status === 'ok' ? 'PASS' : row.status === 'skipped' ? 'SKIP' : 'FAIL'}  ${row.name.padEnd(22)} ${row.detail}`);
    }
    log('');
    if (failed) {
      process.stderr.write(`[bench] ${failed} write-path budget(s) over. Investigate — budgets are never loosened to pass.\n`);
      process.exit(1);
    }
    log('[bench] all write-path budgets green.');
  }
}
