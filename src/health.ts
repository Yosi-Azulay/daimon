import http from 'node:http';
import type { Registry } from './registry.js';
import type { HealthProbeConfig } from './types.js';

export class HealthMonitor {
  private timers = new Map<string, NodeJS.Timeout>();
  private starting = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private readonly initialDelayMs = 500;

  constructor(private readonly registry: Registry, private readonly cfg: HealthProbeConfig) {
    if (!cfg.enabled) return;
    registry.on('change', this.onChange);
    for (const name of registry.names()) this.evaluate(name);
  }

  stop(): void {
    this.stopped = true;
    this.registry.off('change', this.onChange);
    for (const t of this.timers.values()) clearInterval(t);
    for (const t of this.starting.values()) clearTimeout(t);
    this.timers.clear();
    this.starting.clear();
  }

  private onChange = () => {
    if (this.stopped) return;
    for (const name of this.registry.names()) this.evaluate(name);
  };

  private evaluate(name: string): void {
    const s = this.registry.getState(name);
    if (!s) return;
    if (s.status === 'serving') {
      if (this.timers.has(name) || this.starting.has(name)) return;
      const delay = setTimeout(() => {
        this.starting.delete(name);
        this.probe(name);
        const t = setInterval(() => this.probe(name), this.cfg.intervalMs);
        this.timers.set(name, t);
      }, this.initialDelayMs);
      this.starting.set(name, delay);
    } else {
      const t = this.timers.get(name);
      if (t) { clearInterval(t); this.timers.delete(name); }
      const d = this.starting.get(name);
      if (d) { clearTimeout(d); this.starting.delete(name); }
      if (s.health !== 'unknown' && (s.status === 'stopped' || s.status === 'error')) {
        this.registry.setHealth(name, 'unknown');
      }
    }
  }

  private probe(name: string): void {
    const s = this.registry.getState(name);
    if (!s || s.status !== 'serving' || !s.port) return;
    const url = `http://127.0.0.1:${s.port}${this.cfg.path}`;
    const req = http.get(url, { timeout: this.cfg.timeoutMs }, res => {
      const code = res.statusCode ?? 0;
      res.resume();
      this.registry.setHealth(name, code >= 200 && code < 500 ? 'healthy' : 'unhealthy');
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => { this.registry.setHealth(name, 'unhealthy'); });
  }
}
