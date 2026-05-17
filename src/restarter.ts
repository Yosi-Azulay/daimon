import type { AutoRestartConfig } from './types.js';
import type { Registry } from './registry.js';

export class Restarter {
  private timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly registry: Registry, private readonly cfg: AutoRestartConfig) {}

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  onExit(name: string, code: number | null, signal: NodeJS.Signals | null, userStopping: boolean): void {
    if (this.stopped || userStopping || !this.cfg.enabled) return;
    if (code === 0 && !signal) return;
    const s = this.registry.getState(name);
    if (!s) return;
    const now = Date.now();
    if (s.restartWindowStart == null || now - s.restartWindowStart > this.cfg.windowMs) {
      s.restartWindowStart = now;
      s.restartAttempts = 0;
    }
    s.restartAttempts += 1;
    if (s.restartAttempts > this.cfg.maxAttempts) {
      s.lastStatusMessage = `auto-restart aborted (${s.restartAttempts - 1}/${this.cfg.maxAttempts} within window)`;
      s.nextRestartAt = null;
      this.registry.recordEvent({ app: name, type: 'restart-scheduled', message: s.lastStatusMessage });
      this.registry.emit('change');
      return;
    }
    const delayMs = Math.min(2 ** (s.restartAttempts - 1) * 1000, 30000);
    s.nextRestartAt = now + delayMs;
    s.lastStatusMessage = `restarting in ${Math.round(delayMs / 1000)}s (attempt ${s.restartAttempts}/${this.cfg.maxAttempts})`;
    this.registry.recordEvent({ app: name, type: 'restart-scheduled', message: s.lastStatusMessage });
    this.registry.emit('change');
    const t = setTimeout(() => {
      this.timers.delete(name);
      const cur = this.registry.getState(name);
      if (cur) cur.nextRestartAt = null;
      void this.registry.start(name);
    }, delayMs);
    this.timers.set(name, t);
  }

  onUserStop(name: string): void {
    const t = this.timers.get(name);
    if (t) { clearTimeout(t); this.timers.delete(name); }
    const s = this.registry.getState(name);
    if (s) {
      s.restartAttempts = 0;
      s.restartWindowStart = null;
      s.nextRestartAt = null;
    }
  }
}
