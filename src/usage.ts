import pidusage from 'pidusage';
import type { Registry } from './registry.js';

// Resource sampling (M105): the existing 2s pidusage tick gains a per-app
// downsampler that hands one reading per app per `sampleMs` to the daemon
// (history persistence + resource guards). One timer total — sampling rides
// this poll, never a second one. Live TUI numbers are untouched.
export interface UsageSampling {
  // Downsample cadence in ms. 0 disables sampling entirely (the live
  // usage display is unaffected); readings can never arrive faster than
  // the poll interval regardless of this value.
  sampleMs: number;
  onSample: (name: string, ts: number, rssBytes: number, cpuPct: number) => void;
  // Called on the FIRST onSample failure per app only, then silence until
  // that app's sampling recovers — fail-soft, never per-tick noise.
  onSampleError?: (name: string, err: unknown) => void;
}

export class UsageMonitor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly lastSampleTs = new Map<string, number>();
  private readonly sampleFailed = new Set<string>();

  constructor(
    private readonly registry: Registry,
    private readonly intervalMs = 2000,
    private readonly sampling?: UsageSampling,
  ) {
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const targets: Array<{ name: string; pid: number }> = [];
    for (const name of this.registry.names()) {
      const s = this.registry.getState(name);
      if (s?.pid) targets.push({ name, pid: s.pid });
    }
    if (!targets.length) return;
    let changed = false;
    await Promise.all(
      targets.map(async ({ name, pid }) => {
        try {
          const u: any = await pidusage(pid);
          const s = this.registry.getState(name);
          if (!s) return;
          const cpu = Math.round(u.cpu * 10) / 10;
          const memMB = Math.round(u.memory / (1024 * 1024));
          if (s.cpu !== cpu || s.memMB !== memMB) {
            s.cpu = cpu;
            s.memMB = memMB;
            changed = true;
          }
          this.maybeSample(name, u.memory, cpu);
        } catch {
          // Dead pid / pidusage error: clear the live reading and skip the
          // sample. Sampling for the other apps continues untouched.
          const s = this.registry.getState(name);
          if (s && (s.cpu != null || s.memMB != null)) {
            s.cpu = null;
            s.memMB = null;
            changed = true;
          }
        }
      })
    );
    if (changed) this.registry.emit('change');
  }

  private maybeSample(name: string, rssBytes: number, cpuPct: number): void {
    if (!this.sampling || !(this.sampling.sampleMs > 0)) return;
    const now = Date.now();
    const last = this.lastSampleTs.get(name) ?? 0;
    if (now - last < this.sampling.sampleMs) return;
    this.lastSampleTs.set(name, now);
    try {
      this.sampling.onSample(name, now, rssBytes, cpuPct);
      this.sampleFailed.delete(name);
    } catch (err) {
      // Per-app fail-soft: one error callback on entry into the failed state,
      // then silence until a sample for this app succeeds again.
      if (!this.sampleFailed.has(name)) {
        this.sampleFailed.add(name);
        try { this.sampling.onSampleError?.(name, err); } catch {}
      }
    }
  }
}
