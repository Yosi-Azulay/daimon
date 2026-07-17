// Resource guardrails (v1.3, M107/M108): self-calibrating leak suspicion,
// CPU-storm suspicion, and warn-only budgets over the downsampled pidusage
// stream (M105).
//
// TRUST CONTRACT — the whole feature stands on it:
//   - WARN, NEVER KILL. This module imports NOTHING (not even node builtins);
//     it turns sample series into verdicts and cannot signal, stop, restart,
//     or throttle a process. No consumer of its events may either — the
//     grep-style suite in test/resource-guardrails.test.mjs enforces both.
//   - SELF-CALIBRATING. Thresholds derive from each app's own warm-up
//     baseline (median + median-absolute-deviation), never from a hard-coded
//     MB or % figure. The multipliers below are internal constants,
//     deliberately not config: a mistunable knob is a false-positive factory.
//     (Budgets are the one absolute comparison — explicit numbers the USER
//     chose to set; absent keys = no budget checks at all.)
//   - DETERMINISTIC. Verdicts are pure functions of the sample stream — no
//     wall clock anywhere (even episode bookkeeping keys off sample
//     timestamps), so tests drive synthetic series with no real processes
//     and no real time. A false leak accusation gets the feature turned off
//     forever; when in doubt every rule here stays silent.
//
// Episode semantics (shared by all three detectors): at most ONE event per
// episode; re-arm only when the signal returns to baseline (or under budget)
// or the app restarts. Hysteresis is structural — the very sample that
// re-arms an episode also breaks the full-window condition, so a flapping
// signal cannot fire again until a complete fresh window qualifies.

export interface ResourceSample {
  ts: number;
  rss: number; // bytes
  cpu: number; // percent
}

export interface ResourceBaseline {
  rssMedian: number; // bytes
  rssJitter: number; // bytes (MAD)
  cpuMedian: number; // percent
  cpuP95: number;    // percent
  cpuJitter: number; // percent (MAD)
  samples: number;
  establishedAt: number; // ts of the sample that completed the warm-up
}

// ── Internal constants (see TRUST CONTRACT above — not config, ever) ────────
const WARMUP_MS = 5 * 60_000;        // baseline = first 5 min after spawn
const WINDOW_MS = 15 * 60_000;       // leak/storm sliding window
const BUDGET_WINDOW_MS = 5 * 60_000; // budgets react faster: user-set absolutes
const MIN_BASELINE_SAMPLES = 5;      // fewer = no baseline = no verdicts, ever
const MIN_WINDOW_SAMPLES = 8;        // sparse windows never fire
const MIN_BUDGET_SAMPLES = 3;
const WINDOW_SPAN_FRAC = 0.8;        // a sampling gap voids the window
const LEAK_JITTER_MULT = 4;          // growth must beat 4× jitter …
const LEAK_GROWTH_FRAC = 0.10;       // … and 10% of baseline median
const RSS_JITTER_FLOOR_FRAC = 0.01;  // jitter floor: 1% of median (MAD can be 0)
const CPU_JITTER_MULT = 4;
const CPU_JITTER_FLOOR_FRAC = 0.05;  // cpu jitter floor: 5% of median
const CPU_P95_FLOOR_PCT = 5;         // near-idle baselines: don't storm on noise
const CPU_MEAN_FLOOR_PCT = 10;       //   (the logStorm 1-line/min floor, in %)

function sortedCopy(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

function median(xs: number[]): number {
  const s = sortedCopy(xs);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mad(xs: number[], med: number): number {
  return median(xs.map(x => Math.abs(x - med)));
}

function percentile(xs: number[], p: number): number {
  const s = sortedCopy(xs);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

const MB = 1024 * 1024;
const round1 = (x: number): number => Math.round(x * 10) / 10;

// ── Pure core (exported for direct unit tests) ──────────────────────────────

// Baseline from the warm-up samples. null = not enough data — and the caller
// must never produce a verdict for this run.
export function computeBaseline(warmup: ResourceSample[]): Omit<ResourceBaseline, 'establishedAt'> | null {
  if (warmup.length < MIN_BASELINE_SAMPLES) return null;
  const rss = warmup.map(s => s.rss);
  const cpu = warmup.map(s => s.cpu);
  const rssMedian = median(rss);
  const cpuMedian = median(cpu);
  return {
    rssMedian,
    rssJitter: mad(rss, rssMedian),
    cpuMedian,
    cpuP95: percentile(cpu, 0.95),
    cpuJitter: mad(cpu, cpuMedian),
    samples: warmup.length,
  };
}

export interface LeakVerdict {
  suspect: boolean;
  monotonic: boolean;
  growth: number;      // bytes, first→last across the window
  threshold: number;   // bytes the growth had to beat
  tolerance: number;   // per-step dip tolerance (effective jitter)
}

// Monotonic-with-tolerance growth over one full window. The caller guarantees
// the window is full (span + count); this judges only the shape.
export function evaluateLeakWindow(win: ResourceSample[], baseline: { rssMedian: number; rssJitter: number }): LeakVerdict {
  const tolerance = Math.max(baseline.rssJitter, RSS_JITTER_FLOOR_FRAC * baseline.rssMedian);
  let monotonic = true;
  for (let i = 1; i < win.length; i++) {
    if (win[i].rss < win[i - 1].rss - tolerance) { monotonic = false; break; }
  }
  const growth = win.length ? win[win.length - 1].rss - win[0].rss : 0;
  const threshold = Math.max(LEAK_JITTER_MULT * tolerance, LEAK_GROWTH_FRAC * baseline.rssMedian);
  return { suspect: monotonic && growth >= threshold, monotonic, growth, threshold, tolerance };
}

export interface CpuVerdict {
  storm: boolean;
  allAboveP95: boolean;
  windowMean: number;  // percent
  entryP95: number;    // percent every sample had to beat
  entryMean: number;   // percent the mean had to reach
}

// Every sample above the baseline p95 AND the window mean well above the
// baseline median. A brief spike (one hot sample, a compile burst) breaks
// the every-sample condition and never fires.
export function evaluateCpuWindow(win: ResourceSample[], baseline: { cpuMedian: number; cpuP95: number; cpuJitter: number }): CpuVerdict {
  const jitterEff = Math.max(baseline.cpuJitter, CPU_JITTER_FLOOR_FRAC * baseline.cpuMedian);
  const entryP95 = Math.max(baseline.cpuP95, CPU_P95_FLOOR_PCT);
  const entryMean = Math.max(baseline.cpuMedian + CPU_JITTER_MULT * jitterEff, CPU_MEAN_FLOOR_PCT);
  const allAboveP95 = win.length > 0 && win.every(s => s.cpu > entryP95);
  const windowMean = win.length ? win.reduce((a, s) => a + s.cpu, 0) / win.length : 0;
  return { storm: allAboveP95 && windowMean >= entryMean, allAboveP95, windowMean, entryP95, entryMean };
}

// ── Event payloads ──────────────────────────────────────────────────────────

export interface LeakSuspectInfo {
  app: string;
  baselineRssMB: number;
  currentRssMB: number;
  growthMB: number;
  growthPerMinMB: number;
  windowMs: number;
  since: number;
  remedy: string;
}

export interface CpuStormInfo {
  app: string;
  baselineCpuPct: number;
  baselineP95Pct: number;
  windowMeanPct: number;
  windowMs: number;
  since: number;
  remedy: string;
}

export interface BudgetExceededInfo {
  app: string;
  metric: 'rss' | 'cpu';
  observed: number; // MB for rss, percent for cpu (current sample)
  peak: number;     // window peak, same unit
  budget: number;   // the configured rssMb / cpuPct
  windowMs: number;
  since: number;
  remedy: string;
}

export interface ResourceEpisodeState {
  active: boolean;
  since: number | null;
}

export interface ResourceGuardState {
  baseline: { rssMedianMB: number; rssJitterMB: number; cpuMedianPct: number; cpuP95Pct: number } | null;
  leak: ResourceEpisodeState;
  cpuStorm: ResourceEpisodeState;
  budget: { rss: ResourceEpisodeState; cpu: ResourceEpisodeState };
  lastSample: { ts: number; rssMB: number; cpuPct: number } | null;
}

export interface ResourceGuardHooks {
  // Effective budgets for an app (override wins per key); absent/empty = no
  // budget checks. Resolved per note() so config soft-reloads apply.
  budgets?: (app: string) => { rssMb?: number; cpuPct?: number } | undefined;
  onLeakSuspect?: (info: LeakSuspectInfo) => void;
  onCpuStorm?: (info: CpuStormInfo) => void;
  onBudgetExceeded?: (info: BudgetExceededInfo) => void;
}

interface Episode { since: number; }

interface AppTrack {
  spawnTs: number;
  firstTs: number;
  lastTs: number;
  samples: ResourceSample[];
  baseline: ResourceBaseline | null;
  baselineFailed: boolean; // warm-up ended with too few samples: silent run
  leak: Episode | null;
  cpuStorm: Episode | null;
  budgetRss: Episode | null;
  budgetCpu: Episode | null;
}

// ── Stateful per-app tracker ────────────────────────────────────────────────

export class ResourceGuard {
  private readonly perApp = new Map<string, AppTrack>();

  constructor(private readonly hooks: ResourceGuardHooks = {}) {}

  // App (re)started: its samples and baseline belong to the previous process.
  // Every episode re-arms silently — there are no *-end event kinds here.
  reset(app: string): void {
    this.perApp.delete(app);
  }

  note(app: string, ts: number, rss: number, cpu: number): void {
    let t = this.perApp.get(app);
    if (!t) {
      t = {
        spawnTs: ts, firstTs: ts, lastTs: -Infinity, samples: [],
        baseline: null, baselineFailed: false,
        leak: null, cpuStorm: null, budgetRss: null, budgetCpu: null,
      };
      this.perApp.set(app, t);
    }
    if (ts <= t.lastTs) return; // out-of-order / duplicate tick
    t.lastTs = ts;
    t.samples.push({ ts, rss, cpu });
    // Horizon: enough for the warm-up plus a full window; everything older is
    // dead weight (≈ 40 entries/app at the default 30s cadence).
    const horizon = ts - (WARMUP_MS + WINDOW_MS + BUDGET_WINDOW_MS);
    while (t.samples.length && t.samples[0].ts < horizon) t.samples.shift();

    // Baseline: computed exactly once per run, from the warm-up span, frozen
    // thereafter. Too few warm-up samples = no baseline = no verdicts, ever
    // (this run) — recalibration happens on restart via reset().
    if (!t.baseline && !t.baselineFailed && ts >= t.spawnTs + WARMUP_MS) {
      const warm = t.samples.filter(s => s.ts <= t.spawnTs + WARMUP_MS);
      const b = computeBaseline(warm);
      if (b) t.baseline = { ...b, establishedAt: ts };
      else t.baselineFailed = true;
    }

    this.checkBudgets(app, t, ts, rss, cpu);
    if (!t.baseline) return;
    this.checkLeak(app, t, ts, rss);
    this.checkCpu(app, t, ts, cpu);
  }

  private fullWindow(t: AppTrack, ts: number, windowMs: number, notBefore: number): ResourceSample[] | null {
    if (ts - notBefore < windowMs) return null; // not enough elapsed coverage
    const win = t.samples.filter(s => s.ts > ts - windowMs && s.ts >= notBefore);
    const minCount = windowMs === BUDGET_WINDOW_MS ? MIN_BUDGET_SAMPLES : MIN_WINDOW_SAMPLES;
    if (win.length < minCount) return null;
    if (win[win.length - 1].ts - win[0].ts < windowMs * WINDOW_SPAN_FRAC) return null; // gap
    return win;
  }

  private checkLeak(app: string, t: AppTrack, ts: number, rss: number): void {
    const b = t.baseline!;
    const tolerance = Math.max(b.rssJitter, RSS_JITTER_FLOOR_FRAC * b.rssMedian);
    if (t.leak) {
      // Re-arm only when RSS returns within jitter of baseline. The dip that
      // re-arms also breaks window monotonicity — no flap-spam possible.
      if (rss <= b.rssMedian + tolerance) t.leak = null;
      return;
    }
    // Windows start AFTER the baseline was established: the warm-up climb of
    // a normally-starting app must never read as a leak.
    const win = this.fullWindow(t, ts, WINDOW_MS, b.establishedAt);
    if (!win) return;
    const v = evaluateLeakWindow(win, b);
    if (!v.suspect) return;
    t.leak = { since: ts };
    const spanMin = (win[win.length - 1].ts - win[0].ts) / 60_000;
    this.hooks.onLeakSuspect?.({
      app,
      baselineRssMB: round1(b.rssMedian / MB),
      currentRssMB: round1(rss / MB),
      growthMB: round1(v.growth / MB),
      growthPerMinMB: round1(v.growth / MB / Math.max(spanMin, 1)),
      windowMs: WINDOW_MS,
      since: ts,
      remedy: `RSS has grown monotonically for ${Math.round(spanMin)} min without returning to baseline — likely a leak. Restart the app when convenient (daimon restart ${app}); if it recurs, profile the process (node: --inspect + a heap snapshot). daimon only warns — it never kills.`,
    });
  }

  private checkCpu(app: string, t: AppTrack, ts: number, cpu: number): void {
    const b = t.baseline!;
    const jitterEff = Math.max(b.cpuJitter, CPU_JITTER_FLOOR_FRAC * b.cpuMedian);
    if (t.cpuStorm) {
      if (cpu <= b.cpuMedian + jitterEff) t.cpuStorm = null; // back to baseline
      return;
    }
    const win = this.fullWindow(t, ts, WINDOW_MS, b.establishedAt);
    if (!win) return;
    const v = evaluateCpuWindow(win, b);
    if (!v.storm) return;
    t.cpuStorm = { since: ts };
    this.hooks.onCpuStorm?.({
      app,
      baselineCpuPct: round1(b.cpuMedian),
      baselineP95Pct: round1(b.cpuP95),
      windowMeanPct: round1(v.windowMean),
      windowMs: WINDOW_MS,
      since: ts,
      remedy: `CPU has stayed above the app's own baseline p95 for ${Math.round(WINDOW_MS / 60_000)} min (mean ${round1(v.windowMean)}% vs baseline ${round1(b.cpuMedian)}%) — check for a hot loop or a stuck watcher ('daimon why ${app}', 'daimon logs ${app} --since 15m'). daimon only warns — it never kills.`,
    });
  }

  private checkBudgets(app: string, t: AppTrack, ts: number, rss: number, cpu: number): void {
    const budgets = this.hooks.budgets?.(app);
    const fire = this.hooks.onBudgetExceeded;
    // rss budget
    if (budgets?.rssMb != null && budgets.rssMb > 0) {
      const limit = budgets.rssMb * MB;
      if (t.budgetRss) {
        if (rss < limit) t.budgetRss = null;
      } else {
        const win = this.fullWindow(t, ts, BUDGET_WINDOW_MS, t.firstTs);
        if (win && win.every(s => s.rss >= limit)) {
          t.budgetRss = { since: ts };
          const peak = Math.max(...win.map(s => s.rss));
          fire?.({
            app, metric: 'rss',
            observed: round1(rss / MB), peak: round1(peak / MB), budget: budgets.rssMb,
            windowMs: BUDGET_WINDOW_MS, since: ts,
            remedy: `RSS has been at or above the ${budgets.rssMb}MB budget for ${Math.round(BUDGET_WINDOW_MS / 60_000)} min. If this level is expected, raise resources.rssMb (or overrides.${app}.resources.rssMb); otherwise restart or profile the app. daimon only warns — it never kills.`,
          });
        }
      }
    } else {
      t.budgetRss = null;
    }
    // cpu budget
    if (budgets?.cpuPct != null && budgets.cpuPct > 0) {
      const limit = budgets.cpuPct;
      if (t.budgetCpu) {
        if (cpu < limit) t.budgetCpu = null;
      } else {
        const win = this.fullWindow(t, ts, BUDGET_WINDOW_MS, t.firstTs);
        if (win && win.every(s => s.cpu >= limit)) {
          t.budgetCpu = { since: ts };
          const peak = Math.max(...win.map(s => s.cpu));
          fire?.({
            app, metric: 'cpu',
            observed: round1(cpu), peak: round1(peak), budget: budgets.cpuPct,
            windowMs: BUDGET_WINDOW_MS, since: ts,
            remedy: `CPU has been at or above the ${budgets.cpuPct}% budget for ${Math.round(BUDGET_WINDOW_MS / 60_000)} min. If this level is expected, raise resources.cpuPct (or overrides.${app}.resources.cpuPct); otherwise investigate ('daimon why ${app}'). daimon only warns — it never kills.`,
          });
        }
      }
    } else {
      t.budgetCpu = null;
    }
  }

  state(app: string): ResourceGuardState {
    const t = this.perApp.get(app);
    const ep = (e: Episode | null): ResourceEpisodeState => ({ active: !!e, since: e?.since ?? null });
    if (!t) {
      return {
        baseline: null,
        leak: ep(null), cpuStorm: ep(null),
        budget: { rss: ep(null), cpu: ep(null) },
        lastSample: null,
      };
    }
    const last = t.samples.length ? t.samples[t.samples.length - 1] : null;
    return {
      baseline: t.baseline ? {
        rssMedianMB: round1(t.baseline.rssMedian / MB),
        rssJitterMB: round1(t.baseline.rssJitter / MB),
        cpuMedianPct: round1(t.baseline.cpuMedian),
        cpuP95Pct: round1(t.baseline.cpuP95),
      } : null,
      leak: ep(t.leak),
      cpuStorm: ep(t.cpuStorm),
      budget: { rss: ep(t.budgetRss), cpu: ep(t.budgetCpu) },
      lastSample: last ? { ts: last.ts, rssMB: round1(last.rss / MB), cpuPct: round1(last.cpu) } : null,
    };
  }

  // Apps currently inside any suspicion/budget episode — doctor + `why` food.
  activeEpisodes(): { app: string; kind: 'leak' | 'cpu-storm' | 'budget-rss' | 'budget-cpu'; since: number }[] {
    const out: { app: string; kind: 'leak' | 'cpu-storm' | 'budget-rss' | 'budget-cpu'; since: number }[] = [];
    for (const [app, t] of this.perApp) {
      if (t.leak) out.push({ app, kind: 'leak', since: t.leak.since });
      if (t.cpuStorm) out.push({ app, kind: 'cpu-storm', since: t.cpuStorm.since });
      if (t.budgetRss) out.push({ app, kind: 'budget-rss', since: t.budgetRss.since });
      if (t.budgetCpu) out.push({ app, kind: 'budget-cpu', since: t.budgetCpu.since });
    }
    return out;
  }
}
