import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Registry } from './registry.js';
import type { NotificationsConfig } from './types.js';

const requireCjs = createRequire(import.meta.url);

const THROTTLE_MS = 60_000;

export class Notifier {
  private notifier: any = null;
  private toaster: any = null;
  private lastSent = new Map<string, number>();
  private warned = false;
  private logFile: string;

  constructor(private readonly registry: Registry, private readonly cfg: NotificationsConfig) {
    this.logFile = path.join(os.homedir(), '.bosun', 'notifications.log');
    try { fs.mkdirSync(path.dirname(this.logFile), { recursive: true }); } catch {}
    if (!cfg.enabled) {
      this.audit('init', 'disabled by config');
      return;
    }
    try {
      const mod = requireCjs('node-notifier');
      this.notifier = mod;
      if (process.platform === 'win32') {
        try {
          const WindowsToaster = mod.WindowsToaster;
          if (WindowsToaster) this.toaster = new WindowsToaster({ withFallback: true });
        } catch (err: any) {
          this.audit('init', `WindowsToaster unavailable: ${err?.message || err}`);
        }
      }
      this.audit('init', `node-notifier loaded${this.toaster ? ' (+WindowsToaster fallback)' : ''}`);
    } catch (err: any) {
      this.warnOnce(`node-notifier unavailable: ${err?.message || err}`);
      this.audit('init', `node-notifier load failed: ${err?.message || err}`);
      return;
    }
    registry.on('event', this.onEvent);
  }

  private audit(kind: string, detail: string): void {
    const line = `${new Date().toISOString()}\t${kind}\t${detail}\n`;
    try { fs.appendFileSync(this.logFile, line); } catch {}
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[bosun] notifier: ${msg}\n`);
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
    const now = Date.now();
    if (now - last < THROTTLE_MS) {
      this.audit('throttled', `${key}`);
      return;
    }
    this.lastSent.set(key, now);
    const payload = { title: `bosun: ${title}`, message, wait: false, appID: 'bosun' };
    const cb = (err: any, response: any) => {
      if (err) {
        this.audit('fail', `${key} :: ${err?.message || err}`);
        this.warnOnce(`notify failed: ${err?.message || err}`);
      } else {
        this.audit('ok', `${key} :: ${title} :: ${response ?? '(no response)'}`);
      }
    };
    try {
      this.audit('attempt', `${key} :: ${title}`);
      const target = this.toaster ?? this.notifier;
      target.notify(payload, cb);
    } catch (err: any) {
      this.audit('throw', `${key} :: ${err?.message || err}`);
      this.warnOnce(`notify threw: ${err?.message || err}`);
    }
  }
}
