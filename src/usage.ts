import pidusage from 'pidusage';
import type { Registry } from './registry.js';

export class UsageMonitor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly registry: Registry, private readonly intervalMs = 2000) {
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
        } catch {
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
}
