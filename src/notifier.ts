import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Registry } from './registry.js';
import type { NotificationsConfig } from './types.js';
import { daimonDir } from './daemon.js';

const requireCjs = createRequire(import.meta.url);

const THROTTLE_MS = 60_000;
const QUIET_CHECK_MS = 30_000;

// The pre-v0.13 notification set — `notifications.kinds` absent routes
// exactly these (M84: absent config = unchanged behavior).
const DEFAULT_KINDS = ['error', 'unhealthy', 'stale', 'compile-regression', 'bundle-regression', 'task-fail'];

// "22:00-08:00" → is `now` inside the window (local time, wraps midnight)?
export function inQuietHours(spec: string | null | undefined, now: Date): boolean {
  if (!spec) return false;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export interface NotifierTestHooks {
  // Replaces node-notifier entirely — every would-be OS notification lands here.
  sink?: (payload: { title: string; message: string }) => void;
  now?: () => number;
}

interface Batch {
  count: number;
  title: string;
  message: string;
  timer: NodeJS.Timeout;
}

export class Notifier {
  private notifier: any = null;
  private toaster: any = null;
  private lastSent = new Map<string, number>();
  private warned = false;
  private logFile: string;
  private readonly sink: ((payload: { title: string; message: string }) => void) | null;
  private readonly now: () => number;
  private readonly batches = new Map<string, Batch>();
  private quietSuppressed = 0;
  private wasQuiet = false;
  private quietTimer: NodeJS.Timeout | null = null;

  constructor(private readonly registry: Registry, private readonly cfg: NotificationsConfig, hooks: NotifierTestHooks = {}) {
    this.sink = hooks.sink ?? null;
    this.now = hooks.now ?? (() => Date.now());
    this.logFile = path.join(daimonDir(), 'notifications.log');
    try { fs.mkdirSync(path.dirname(this.logFile), { recursive: true }); } catch {}
    if (!cfg.enabled) {
      this.audit('init', 'disabled by config');
      return;
    }
    if (!this.sink) {
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
    } else {
      this.audit('init', 'test sink attached');
    }
    registry.on('event', this.onEvent);
    if (cfg.quietHours) {
      this.wasQuiet = inQuietHours(cfg.quietHours, new Date(this.now()));
      this.quietTimer = setInterval(() => this.checkQuietWindow(), QUIET_CHECK_MS);
      this.quietTimer.unref?.();
    }
  }

  private audit(kind: string, detail: string): void {
    const line = `${new Date().toISOString()}\t${kind}\t${detail}\n`;
    try { fs.appendFileSync(this.logFile, line); } catch {}
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[daimon] notifier: ${msg}\n`);
  }

  stop(): void {
    this.registry.off('event', this.onEvent);
    for (const b of this.batches.values()) clearTimeout(b.timer);
    this.batches.clear();
    if (this.quietTimer) { clearInterval(this.quietTimer); this.quietTimer = null; }
  }

  private canNotify(): boolean {
    return !!(this.notifier || this.sink);
  }

  // Routing (M84): map an event to a notification kind, honor `kinds` (or the
  // legacy default set + onError/onUnhealthy gates when absent).
  private onEvent = (ev: any) => {
    if (!this.canNotify()) return;
    const kinds = this.cfg.kinds ?? DEFAULT_KINDS;
    const legacy = !this.cfg.kinds;
    const want = (k: string): boolean => kinds.includes(k);

    if (ev.type === 'status' && ev.to === 'error' && want('error') && (!legacy || this.cfg.onError)) {
      this.route('error', ev.app, `${ev.app} → error`, ev.message || 'app entered error state', ev.message);
    } else if (ev.type === 'health' && ev.to === 'unhealthy' && want('unhealthy') && (!legacy || this.cfg.onUnhealthy)) {
      this.route('unhealthy', ev.app, `${ev.app} unhealthy`, 'health probe failing');
    } else if (ev.type === 'stale' && want('stale')) {
      this.route('stale', ev.app, `${ev.app} stale`, ev.message || 'no output despite source changes');
    } else if (ev.type === 'compile-regression' && want('compile-regression')) {
      this.route('compile-regression', ev.app, `${ev.app} slow compile`, ev.message || 'compile time regression');
    } else if (ev.type === 'bundle-regression' && want('bundle-regression')) {
      this.route('bundle-regression', ev.app, `${ev.app} bundle grew`, ev.message || 'bundle size regression');
    } else if (ev.type === 'task-run' && /exit=[1-9]/.test(ev.message || '') && want('task-fail')) {
      this.route('task-fail', ev.app, `${ev.app} task failed`, ev.message || '');
    } else if ((ev.type === 'error-new' || ev.type === 'error-recur') && want('error-new')) {
      // Opt-in fine-grained error notifications; fingerprint = the message.
      this.route('error-new', ev.app, `${ev.app} error`, ev.message || 'new error', ev.message);
    } else if (ev.type === 'crash' && want('crash')) {
      this.route('crash', ev.app, `${ev.app} crashed`, ev.message || 'unrequested exit');
    } else if (ev.type === 'restart-storm' && want('restart-storm')) {
      this.route('restart-storm', ev.app, `${ev.app} restart storm`, 'crashing repeatedly — see `daimon why`');
    } else if (ev.type === 'test-failed' && want('test-failed')) {
      this.route('test-failed', ev.app, `${ev.app} tests failed`, ev.message || '');
    } else if (ev.type === 'flaky-test-detected' && want('flaky-test-detected')) {
      this.route('flaky-test-detected', ev.app, `${ev.app} flaky test`, ev.message || '');
    } else if (ev.type === 'log-storm' && want('log-storm')) {
      // M101 (v1.2): OPT-IN only — 'log-storm' is not in DEFAULT_KINDS, so a
      // config without notifications.kinds never hears about storms.
      let detail = 'log volume spiking against its own baseline';
      try {
        const d = JSON.parse(ev.message || '{}');
        if (d.observedPerMin != null) detail = `${d.observedPerMin} lines/min vs baseline ${d.baselinePerMin ?? '?'} — daimon logs ${ev.app} --since 5m --level error`;
      } catch {}
      this.route('log-storm', ev.app, `${ev.app} log storm`, detail);
    }
  };

  private route(category: string, app: string, title: string, message: string, fingerprint?: string): void {
    // Mute (M84): per-app, persisted in the registry. Events/webhooks are
    // unaffected — only the OS notification stops here.
    if ((this.registry as any).isMuted?.(app)) {
      this.audit('muted', `${app}::${category}`);
      return;
    }
    // Batching (M84): same-fingerprint error notifications inside batchMs
    // collapse to ONE notification carrying the count (fires at window end).
    const batchMs = this.cfg.batchMs;
    if (batchMs && (category === 'error' || category === 'error-new')) {
      const key = `${app}::${category}::${(fingerprint ?? message).slice(0, 160)}`;
      const existing = this.batches.get(key);
      if (existing) {
        existing.count++;
        this.audit('batched', `${key} (count=${existing.count})`);
        return;
      }
      const timer = setTimeout(() => {
        const b = this.batches.get(key);
        this.batches.delete(key);
        if (!b) return;
        const msg = b.count > 1 ? `${b.message} (×${b.count} in ${Math.round(batchMs / 1000)}s)` : b.message;
        // The batch window already rate-limits this fingerprint — throttle
        // per-fingerprint so a different error isn't swallowed by app::category.
        this.deliver(app, category, b.title, msg, key);
      }, batchMs);
      timer.unref?.();
      this.batches.set(key, { count: 1, title, message, timer });
      this.audit('batch-open', key);
      return;
    }
    this.deliver(app, category, title, message);
  }

  private deliver(app: string, category: string, title: string, message: string, throttleKey?: string): void {
    // Quiet hours (M84): suppress, count, and summarize when the window ends.
    if (inQuietHours(this.cfg.quietHours, new Date(this.now()))) {
      this.quietSuppressed++;
      this.wasQuiet = true;
      this.audit('quiet-suppressed', `${app}::${category} (total=${this.quietSuppressed})`);
      return;
    }
    this.checkQuietWindow();
    this.fire(app, category, title, message, throttleKey);
  }

  // Fires the "while you were away" summary once when the window ends.
  checkQuietWindow(): void {
    if (!this.cfg.quietHours) return;
    const quietNow = inQuietHours(this.cfg.quietHours, new Date(this.now()));
    if (quietNow) { this.wasQuiet = true; return; }
    if (this.wasQuiet && this.quietSuppressed > 0) {
      const n = this.quietSuppressed;
      this.quietSuppressed = 0;
      this.wasQuiet = false;
      this.fire('__daemon__', 'quiet-summary', 'while you were away', `${n} notification${n === 1 ? '' : 's'} suppressed during quiet hours`);
    } else if (this.wasQuiet) {
      this.wasQuiet = false;
    }
  }

  fire(app: string, category: string, title: string, message: string, throttleKey?: string): void {
    if (!this.canNotify()) return;
    const key = throttleKey ?? `${app}::${category}`;
    const last = this.lastSent.get(key) ?? 0;
    const now = this.now();
    if (now - last < THROTTLE_MS) {
      this.audit('throttled', `${key}`);
      return;
    }
    this.lastSent.set(key, now);
    const payload = { title: `daimon: ${title}`, message, wait: false, appID: 'daimon' };
    if (this.sink) {
      this.audit('attempt', `${key} :: ${title}`);
      try { this.sink({ title: payload.title, message }); this.audit('ok', `${key} :: ${title} :: sink`); }
      catch (err: any) { this.audit('throw', `${key} :: ${err?.message || err}`); }
      return;
    }
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
