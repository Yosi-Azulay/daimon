// Bench machine primitives (M145, v1.10) — the measurement substrate every
// daimon budget is derived from.
//
// THE BUDGET-DERIVATION RULE (v1.10, binding for every perf gate):
//
//   budget = measured quiet-machine baseline p95 × headroom factor
//
// The factor is chosen per metric CLASS and justified at its call site — never
// a magic absolute typed in by hand, never widened to make a red run pass. A
// budget that goes red means investigate; the only legitimate edits are
// (a) re-derivation from a NEW committed baseline after a deliberate change,
// or (b) tightening.
//
// Every budget carries a SECOND axis so external load cannot fake a regression
// (the M91 contention-immune discipline): a sample passes on the absolute
// budget OR on its ratio to an interleaved CPU reference workload. Outside load
// inflates the measurement and the reference together, so the ratio holds; a
// genuine regression inflates only the numerator and fails both axes. The ratio
// ceiling is DERIVED from the same baseline (budget ÷ baseline CPU reference ×
// CONTENTION_HEADROOM) — it is not a second hand-picked number.

import os from 'node:os';

// ---------------------------------------------------------------------------
// Headroom factors. One row per metric class, each with the reason it differs.
// These are the ONLY tunables in the derivation, and they are policy (how much
// slack a class of work is allowed), not measurements.
// ---------------------------------------------------------------------------
export const HEADROOM = {
  // A human is waiting on the keystroke. Little slack: a 2× slip is felt.
  interactive: 2,
  // Process launch — dominated by module load + OS scheduling, which are
  // noisier than in-process work, so a wider band before we call it a change.
  startup: 2.5,
  // Read queries over the corpus. Disk cache state swings these legitimately.
  query: 3,
  // Batch composition (report/export/sessions) — nobody blocks on it
  // keystroke-wise, and it fans out over many queries whose noise compounds.
  batch: 3,
  // Per-insert write-path latency: microsecond-scale numbers where timer
  // granularity itself is a large share of the measurement.
  write: 4,
};

// Extra multiplier applied when converting an absolute budget into its
// contention ratio ceiling. Matches the ~3× documented in the M91 tests: the
// ratio axis exists to survive a parallel build, not to be a soft budget.
export const CONTENTION_HEADROOM = 3;

// ---------------------------------------------------------------------------
// CPU reference workload. A fixed-cost spin whose runtime inflates under
// exactly the external load (parallel builds, sibling test processes) that
// inflates real measurements. Quiet-machine cost is ~5-15ms; it is interleaved
// with real samples so both see the same machine at the same instant.
// ---------------------------------------------------------------------------
export function cpuReferenceMs() {
  const t0 = performance.now();
  let x = 0;
  for (let i = 0; i < 4_000_000; i++) x = (x * 31 + i) % 1000003;
  if (x === -1) throw new Error('unreachable');
  return performance.now() - t0;
}

export function percentile(values, p) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

export function median(values) {
  return percentile(values, 0.5);
}

// Median absolute deviation, expressed relative to the median. Scale-free, so
// it means the same thing on a fast laptop and a slow CI box.
export function relativeMad(values) {
  const m = median(values);
  if (!(m > 0)) return Infinity;
  return median(values.map(v => Math.abs(v - m))) / m;
}

// ---------------------------------------------------------------------------
// Quiet-machine detection.
//
// TWO independent signals, because either alone is fooled:
//
//  1. DISPERSION of the CPU reference (relative MAD). Catches a machine whose
//     scheduler is descheduling us unpredictably.
//  2. SYSTEM-WIDE busy fraction from os.cpus() time deltas. Catches the case
//     dispersion misses entirely: on a many-core box a single spin keeps a
//     dedicated core and runs at a rock-steady — but inflated — cost while a
//     parallel build saturates the other fifteen. Measured during a sleep, so
//     our own process contributes ~nothing.
//
// This is not hypothetical: the first v1.10 baseline attempt reported
// quiet=true on dispersion alone while the full test suite was running, and
// its cold-start p50 was 72% higher than the real quiet number. Recording that
// as the baseline would have inflated every budget derived from it.
//
// loadavg is deliberately NOT used — it is always 0 on Windows, the primary
// dev platform. A contended run is LABELLED, never silently folded into a
// baseline.
// ---------------------------------------------------------------------------
export const QUIET_MAD_CEILING = 0.15; // 15% spread on the reference spin

// Busy-fraction ceiling, grounded in measurement on the v1.10 dev box rather
// than picked: the idle median over ten samples was 0.13, a single parallel
// `npm run build` pushed it to 0.46, and the full test suite higher still. 0.35
// sits ~2.5x above the idle floor and below anything a real competing job
// produces. It is an ENVIRONMENT gate, not a performance budget — its only
// power is to refuse to record a baseline, which fails safe.
export const QUIET_BUSY_CEILING = 0.35;

function cpuTimeTotals() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus() ?? []) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

async function busyOnce(ms) {
  const a = cpuTimeTotals();
  await new Promise(r => setTimeout(r, ms));
  const b = cpuTimeTotals();
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - dIdle / dTotal));
}

/**
 * Median fraction of system CPU time spent non-idle. 0 = fully idle.
 *
 * MEDIAN OF SEVERAL, never a single sample: an idle Windows dev box was
 * measured swinging 0.09-0.34 across consecutive 1s samples (background
 * service wake-ups), so one sample decides nothing. The median over ~2s of
 * wall clock is stable enough to separate idle from load.
 */
export async function systemBusyFraction({ samples = 5, ms = 400 } = {}) {
  const vals = [];
  for (let i = 0; i < samples; i++) vals.push(await busyOnce(ms));
  return median(vals);
}

export async function probeMachine(samples = 9) {
  const busy = await systemBusyFraction();
  const refs = [];
  for (let i = 0; i < samples; i++) refs.push(cpuReferenceMs());
  const mad = relativeMad(refs);
  return {
    cpuRefMedianMs: round(median(refs)),
    cpuRefMadRatio: round(mad, 4),
    systemBusyFraction: round(busy, 4),
    quiet: mad < QUIET_MAD_CEILING && busy < QUIET_BUSY_CEILING,
    cores: os.cpus()?.length ?? 0,
    platform: process.platform,
    nodeVersion: process.version,
  };
}

// ---------------------------------------------------------------------------
// Budget derivation + the two-axis check.
// ---------------------------------------------------------------------------

/**
 * Derive a budget from a committed baseline entry.
 *
 * @param baseline  { p95, cpuRefMedianMs } row from BASELINE-v1.10.json
 * @param klass     key of HEADROOM
 * @param why       one-line justification, carried into failure messages
 */
export function deriveBudget(baseline, klass, why) {
  const factor = HEADROOM[klass];
  if (!factor) throw new Error(`unknown headroom class '${klass}'`);
  if (!(baseline?.p95 >= 0)) throw new Error(`baseline missing p95 for budget: ${why}`);
  const absMs = baseline.p95 * factor;
  // Ratio ceiling is derived, not chosen: how many CPU references the budget was
  // worth on the baseline machine, times the contention allowance.
  const ratio = baseline.cpuRefMedianMs > 0
    ? (absMs / baseline.cpuRefMedianMs) * CONTENTION_HEADROOM
    : Infinity;
  return { absMs, ratio, factor, klass, why, baselineP95: baseline.p95 };
}

/**
 * Two-axis budget check. Passes on the absolute budget OR on the contention
 * ratio. Returns a structured verdict so callers can print the full detail
 * (both axes, always) rather than only the one that failed.
 */
export function checkBudget(budget, observedMs, cpuRefMedianMs) {
  const byAbs = observedMs < budget.absMs;
  const byRatio = cpuRefMedianMs > 0 && observedMs < budget.ratio * cpuRefMedianMs;
  return {
    ok: byAbs || byRatio,
    byAbs,
    byRatio,
    observedMs: round(observedMs),
    budgetMs: round(budget.absMs),
    ratioCeiling: round(budget.ratio, 1),
    observedRatio: cpuRefMedianMs > 0 ? round(observedMs / cpuRefMedianMs, 2) : null,
    detail: `${round(observedMs)}ms vs budget ${round(budget.absMs)}ms `
      + `(= baseline p95 ${round(budget.baselineP95)}ms × ${budget.factor} ${budget.klass}) `
      + `| contention axis ${cpuRefMedianMs > 0 ? round(observedMs / cpuRefMedianMs, 2) : 'n/a'}× `
      + `vs ceiling ${round(budget.ratio, 1)}× cpuRef(${round(cpuRefMedianMs)}ms)`,
  };
}

/**
 * Run a sampler repeatedly, interleaving CPU references, and return
 * { p50, p95, samples, cpuRefMedianMs }. This is the ONE way bench numbers are
 * produced — baselines and gates use the identical path, so a budget is always
 * compared against a like-for-like measurement.
 */
export async function sample(fn, { runs = 30, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  const refs = [];
  refs.push(cpuReferenceMs());
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
    if (i % 10 === 9) refs.push(cpuReferenceMs());
  }
  refs.push(cpuReferenceMs());
  return {
    p50: round(percentile(times, 0.5)),
    p95: round(percentile(times, 0.95)),
    min: round(Math.min(...times)),
    max: round(Math.max(...times)),
    samples: times.length,
    cpuRefMedianMs: round(median(refs)),
  };
}

export function round(n, digits = 1) {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
