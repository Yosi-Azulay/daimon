import type { History } from './history.js';
import { DAIMON_VERSION } from './version.js';

export interface SelfMetrics {
  pid: number;
  version: string;
  uptimeMs: number;
  rssMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  eventLoopLagMs: number;
  eventLoopLagP95Ms: number;
  historyDbQueryMs: { p50: number; p95: number; p99: number };
  lockContentionCount: number;
  tickIntervalMs: number;
  lastTickAt: number;
}

const PROBE_INTERVAL_MS = 1000;
const LAG_WINDOW = 60; // 60 samples = ~60s
const QUERY_WINDOW = 256;

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return Math.round(sorted[idx] * 100) / 100;
}

export class SelfMetricsCollector {
  private readonly startMs = Date.now();
  private lagTimer: NodeJS.Timeout | null = null;
  private lagSamples: number[] = [];
  private querySamples: number[] = [];
  private lockContentionCount = 0;
  private lastTickAt = Date.now();
  private highLagStreak = 0;
  private warnedAtStreak = 0;
  private onSelfWarn: ((message: string) => void) | null = null;

  constructor(public readonly history: History | null) {
    this.start();
  }

  private start(): void {
    let prev = performance.now();
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      // setInterval delta minus expected interval → event-loop lag.
      const lag = Math.max(0, now - prev - PROBE_INTERVAL_MS);
      prev = now;
      this.lagSamples.push(lag);
      if (this.lagSamples.length > LAG_WINDOW) this.lagSamples.shift();
      this.lastTickAt = Date.now();

      // Self-warn: 5 consecutive ticks with lag > 100ms.
      if (lag > 100) {
        this.highLagStreak++;
        if (this.highLagStreak >= 5 && this.highLagStreak > this.warnedAtStreak && this.onSelfWarn) {
          this.warnedAtStreak = this.highLagStreak;
          this.onSelfWarn(`event loop lag sustained: ${Math.round(lag)}ms (${this.highLagStreak} consecutive ticks)`);
        }
      } else {
        this.highLagStreak = 0;
        this.warnedAtStreak = 0;
      }
    }, PROBE_INTERVAL_MS);
    // Keep the daemon alive without blocking exit on the timer.
    if (this.lagTimer.unref) this.lagTimer.unref();
  }

  setSelfWarnHandler(fn: (message: string) => void): void {
    this.onSelfWarn = fn;
  }

  recordQueryMs(ms: number): void {
    this.querySamples.push(ms);
    if (this.querySamples.length > QUERY_WINDOW) this.querySamples.shift();
  }

  incLockContention(): void {
    this.lockContentionCount++;
  }

  snapshot(): SelfMetrics {
    const mem = process.memoryUsage();
    const MB = 1024 * 1024;
    return {
      pid: process.pid,
      version: DAIMON_VERSION,
      uptimeMs: Date.now() - this.startMs,
      rssMB: Math.round((mem.rss / MB) * 10) / 10,
      heapUsedMB: Math.round((mem.heapUsed / MB) * 10) / 10,
      heapTotalMB: Math.round((mem.heapTotal / MB) * 10) / 10,
      eventLoopLagMs: this.lagSamples.length ? Math.round(this.lagSamples[this.lagSamples.length - 1] * 100) / 100 : 0,
      eventLoopLagP95Ms: pct(this.lagSamples, 0.95),
      historyDbQueryMs: {
        p50: pct(this.querySamples, 0.5),
        p95: pct(this.querySamples, 0.95),
        p99: pct(this.querySamples, 0.99),
      },
      lockContentionCount: this.lockContentionCount,
      tickIntervalMs: PROBE_INTERVAL_MS,
      lastTickAt: this.lastTickAt,
    };
  }

  stop(): void {
    if (this.lagTimer) clearInterval(this.lagTimer);
    this.lagTimer = null;
  }
}
