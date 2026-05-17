import { createRequire } from 'node:module';
import type { Registry } from './registry.js';
import type { NotificationsConfig } from './types.js';

const requireCjs = createRequire(import.meta.url);

interface ThrottleKey { app: string; category: string; }
const THROTTLE_MS = 60_000;

export class Notifier {
  private notifier: any = null;
  private lastSent = new Map<string, number>();
  private warned = false;

  constructor(private readonly registry: Registry, private readonly cfg: NotificationsConfig) {
    if (!cfg.enabled) return;
    try {
      this.notifier = requireCjs('node-notifier');
    } catch (err: any) {
      this.warnOnce(`node-notifier unavailable: ${err?.message || err}`);
      return;
    }
    registry.on('event', this.onEvent);
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[appman] notifier: ${msg}\n`);
  }

  stop(): void {
    this.registry.off('event', this.onEvent);
  }

  private onEvent = (ev: any) => {
    if (!this.notifier) return;
    if (ev.type === 'status' && ev.to === 'error' && this.cfg.onError) {
      this.fire(ev.app, 'error', `${ev.app} → error`, ev.message || 'app entered error state');
    } else if (ev.type === 'health' && ev.to === 'unhealthy' && this.cfg.onUnhealthy) {
      this.fire(ev.app, 'unhealthy', `${ev.app} unhealthy`, 'health probe failing');
    } else if (ev.type === 'stale') {
      this.fire(ev.app, 'stale', `${ev.app} stale`, ev.message || 'no output despite source changes');
    } else if (ev.type === 'compile-regression') {
      this.fire(ev.app, 'compile-regression', `${ev.app} slow compile`, ev.message || 'compile time regression');
    } else if (ev.type === 'bundle-regression') {
      this.fire(ev.app, 'bundle-regression', `${ev.app} bundle grew`, ev.message || 'bundle size regression');
    } else if (ev.type === 'task-run' && /exit=[1-9]/.test(ev.message || '')) {
      this.fire(ev.app, 'task-fail', `${ev.app} task failed`, ev.message || '');
    }
  };

  fire(app: string, category: string, title: string, message: string): void {
    if (!this.notifier) return;
    const key = `${app}::${category}`;
    const last = this.lastSent.get(key) ?? 0;
    if (Date.now() - last < THROTTLE_MS) return;
    this.lastSent.set(key, Date.now());
    try {
      this.notifier.notify({ title: `appman: ${title}`, message, wait: false });
    } catch (err: any) {
      this.warnOnce(`notify failed: ${err?.message || err}`);
    }
  }
}
