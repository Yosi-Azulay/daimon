// Log-storm detection (M101). A volume spike should be an event, not a
// discovery: every ingested line feeds a per-app rolling lines-per-minute
// baseline (in memory only — no new tables), and a sustained spike against
// the app's OWN baseline raises exactly one `log-storm` event, with one
// `log-storm-end` on recovery.
//
// Mechanics:
//   - 10s counting buckets per app, pruned to the baseline horizon.
//   - observed  = lines in the last `windowSec`, scaled to lines/minute.
//   - baseline  = lines/minute over the 10 minutes BEFORE the window; an app
//     needs ≥3 minutes of history before it has a baseline at all — new apps
//     never storm.
//   - entry     = observed ≥ multiplier × max(baseline, 1 line/min); the
//     1-line/min floor keeps a near-silent app from "storming" on a handful
//     of lines.
//   - hysteresis: the baseline is FROZEN at entry, and the storm ends only
//     when observed falls to half the entry threshold — a rate flapping
//     around the threshold cannot spam events. After recovery, the storm's
//     own lines sit in the baseline horizon for a while, which raises the
//     re-entry bar further (a natural cooldown).
//
// `logs.storm { multiplier?: 10, windowSec?: 60 }` tunes detection; the
// config is optional and detection always runs with the defaults (the
// OS-notification kind is opt-in separately via notifications.kinds — see
// notifier.ts). Not a cron engine: one 15s unref'd tick, used ONLY to end
// storms of apps that went silent; entry evaluation rides the ingest path.

export interface LogStormConfig {
  multiplier?: number;
  windowSec?: number;
}

export interface LogStormInfo {
  app: string;
  observedPerMin: number;
  baselinePerMin: number;
  windowSec: number;
  multiplier: number;
  since: number;
  durationMs?: number;
}

export interface LogStormState {
  active: boolean;
  since: number | null;
  observedPerMin: number;
  baselinePerMin: number | null;
  windowSec: number;
  multiplier: number;
}

const BUCKET_MS = 10_000;
const BASELINE_HORIZON_MS = 600_000; // 10 min of pre-window history
const MIN_BASELINE_MS = 180_000;     // no baseline (=> no storms) before 3 min
const MIN_BASELINE_PER_MIN = 1;      // threshold floor for near-silent apps
const EVAL_THROTTLE_MS = 1_000;      // ingest-path evaluation at most 1/s/app
const TICK_MS = 15_000;              // silent-app recovery sweep

interface AppTrack {
  buckets: Map<number, number>;
  firstTs: number;
  lastEvalTs: number;
  storm: { since: number; entryBaseline: number } | null;
}

export class LogStormDetector {
  private readonly perApp = new Map<string, AppTrack>();
  private readonly multiplier: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private tick: NodeJS.Timeout | null = null;

  constructor(
    cfg: LogStormConfig | undefined,
    private readonly hooks: {
      onStorm?: (info: LogStormInfo) => void;
      onStormEnd?: (info: LogStormInfo) => void;
      now?: () => number;
    } = {},
  ) {
    const mult = cfg?.multiplier;
    const winSec = cfg?.windowSec;
    this.multiplier = typeof mult === 'number' && Number.isFinite(mult) && mult >= 2 ? mult : 10;
    this.windowMs = typeof winSec === 'number' && Number.isFinite(winSec) && winSec >= 10 && winSec <= 3600
      ? winSec * 1000 : 60_000;
    this.now = hooks.now ?? (() => Date.now());
  }

  // One 15s unref'd sweep so a storm whose app went completely silent still
  // gets its log-storm-end. Entry detection never needs the tick.
  start(): void {
    if (this.tick) return;
    this.tick = setInterval(() => {
      const now = this.now();
      for (const [app, t] of this.perApp) {
        if (t.storm) this.evaluate(app, now);
      }
    }, TICK_MS);
    this.tick.unref?.();
  }

  stop(): void {
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
  }

  note(app: string, ts = this.now()): void {
    let t = this.perApp.get(app);
    if (!t) {
      t = { buckets: new Map(), firstTs: ts, lastEvalTs: 0, storm: null };
      this.perApp.set(app, t);
    }
    const b = Math.floor(ts / BUCKET_MS);
    t.buckets.set(b, (t.buckets.get(b) ?? 0) + 1);
    if (ts - t.lastEvalTs >= EVAL_THROTTLE_MS) this.evaluate(app, ts);
  }

  // App restarted: its rate history belongs to the previous process. An
  // active storm ends — WITH its log-storm-end event (every episode closes;
  // an unmatched log-storm would keep doctor's rule red for hours) — and
  // counting restarts from zero.
  reset(app: string): void {
    this.endIfActive(app, this.now());
    this.perApp.delete(app);
  }

  // Close every active storm (daemon shutdown): the detector's state dies
  // with the process, so the episode must be closed in the event log now.
  endAll(now = this.now()): void {
    for (const app of this.perApp.keys()) this.endIfActive(app, now);
  }

  private endIfActive(app: string, now: number): void {
    const t = this.perApp.get(app);
    if (!t?.storm) return;
    const { since, entryBaseline } = t.storm;
    t.storm = null;
    const { observedPerMin } = this.rates(t, now);
    this.hooks.onStormEnd?.({
      app,
      observedPerMin: Math.round(observedPerMin * 10) / 10,
      baselinePerMin: Math.round(entryBaseline * 10) / 10,
      windowSec: this.windowMs / 1000,
      multiplier: this.multiplier,
      since,
      durationMs: now - since,
    });
  }

  private rates(t: AppTrack, now: number): { observedPerMin: number; baselinePerMin: number | null } {
    const winStart = now - this.windowMs;
    const horizonStart = winStart - BASELINE_HORIZON_MS;
    let inWindow = 0;
    let inBaseline = 0;
    for (const [b, n] of t.buckets) {
      const ts = b * BUCKET_MS;
      if (ts < horizonStart - BUCKET_MS) { t.buckets.delete(b); continue; }
      if (ts >= winStart) inWindow += n;
      else inBaseline += n;
    }
    const observedPerMin = (inWindow * 60_000) / this.windowMs;
    // Baseline needs real elapsed history: at least MIN_BASELINE_MS of
    // pre-window time since the app's first line. New apps never storm.
    const baselineSpan = Math.min(BASELINE_HORIZON_MS, winStart - t.firstTs);
    const baselinePerMin = baselineSpan >= MIN_BASELINE_MS
      ? (inBaseline * 60_000) / baselineSpan
      : null;
    return { observedPerMin, baselinePerMin };
  }

  private evaluate(app: string, now: number): void {
    const t = this.perApp.get(app);
    if (!t) return;
    t.lastEvalTs = now;
    const { observedPerMin, baselinePerMin } = this.rates(t, now);
    if (!t.storm) {
      if (baselinePerMin == null) return;
      const threshold = this.multiplier * Math.max(baselinePerMin, MIN_BASELINE_PER_MIN);
      if (observedPerMin >= threshold) {
        t.storm = { since: now, entryBaseline: baselinePerMin };
        this.hooks.onStorm?.({
          app,
          observedPerMin: Math.round(observedPerMin * 10) / 10,
          baselinePerMin: Math.round(baselinePerMin * 10) / 10,
          windowSec: this.windowMs / 1000,
          multiplier: this.multiplier,
          since: now,
        });
      }
      return;
    }
    // Active: compare against the FROZEN entry baseline at half the entry
    // threshold (hysteresis) — the storm's own lines never move the bar.
    const exitBelow = (this.multiplier * Math.max(t.storm.entryBaseline, MIN_BASELINE_PER_MIN)) / 2;
    if (observedPerMin <= exitBelow) {
      const since = t.storm.since;
      const entryBaseline = t.storm.entryBaseline;
      t.storm = null;
      this.hooks.onStormEnd?.({
        app,
        observedPerMin: Math.round(observedPerMin * 10) / 10,
        baselinePerMin: Math.round(entryBaseline * 10) / 10,
        windowSec: this.windowMs / 1000,
        multiplier: this.multiplier,
        since,
        durationMs: now - since,
      });
    }
  }

  state(app: string, now = this.now()): LogStormState {
    const t = this.perApp.get(app);
    if (!t) {
      return { active: false, since: null, observedPerMin: 0, baselinePerMin: null, windowSec: this.windowMs / 1000, multiplier: this.multiplier };
    }
    // Reads are transition points too: a doctor/status call on a silent
    // stormed app ends the storm right here rather than waiting for the tick.
    this.evaluate(app, now);
    const { observedPerMin, baselinePerMin } = this.rates(t, now);
    return {
      active: !!t.storm,
      since: t.storm?.since ?? null,
      observedPerMin: Math.round(observedPerMin * 10) / 10,
      baselinePerMin: baselinePerMin == null ? null : Math.round(baselinePerMin * 10) / 10,
      windowSec: this.windowMs / 1000,
      multiplier: this.multiplier,
    };
  }

  activeStorms(now = this.now()): { app: string; state: LogStormState }[] {
    const out: { app: string; state: LogStormState }[] = [];
    for (const app of this.perApp.keys()) {
      const s = this.state(app, now);
      if (s.active) out.push({ app, state: s });
    }
    return out;
  }
}
