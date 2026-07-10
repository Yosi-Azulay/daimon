// Outbound webhook delivery. Subscribes to the Registry's `event` stream,
// filters per-config, shapes payloads per known host (Slack/Discord), and
// posts with bounded retries. Never blocks the registry loop — every send is
// fire-and-forget — and the global budget caps outbound to 1 req/sec to keep
// daimon polite when an event storm hits a webhook endpoint.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { Registry } from './registry.js';
import type { AppEvent } from './types.js';

export interface WebhookConfig {
  url: string;
  events?: string[];
  headers?: Record<string, string>;
  filter?: { to?: string[]; from?: string[]; app?: string[] };
  // Per-app scoping (M72): when present, only events from these apps fire.
  // Absent = all apps (the pre-v0.11 behavior).
  apps?: string[];
  // Scheduled digest (M84): "HH:MM" local time.
  digest?: string;
}

// Merge the global webhook list with per-app override blocks (M72):
// `overrides.<app>.webhooks` entries fire only for that app's events. The
// config stays backward compatible — with no overrides this returns the
// global list unchanged.
export function effectiveWebhooks(config: {
  webhooks?: WebhookConfig[];
  overrides?: Record<string, { webhooks?: WebhookConfig[] } | undefined>;
}): WebhookConfig[] {
  const out: WebhookConfig[] = [...(config.webhooks ?? [])];
  for (const [app, ov] of Object.entries(config.overrides ?? {})) {
    for (const w of ov?.webhooks ?? []) {
      if (!w || typeof w.url !== 'string' || !w.url.trim()) continue;
      out.push({ ...w, apps: [app] });
    }
  }
  return out;
}

interface QueueItem {
  cfg: WebhookConfig;
  // Regular event deliveries shape at send time; digest deliveries (M84)
  // arrive pre-shaped via enqueuePayload.
  event?: AppEvent;
  payload?: unknown;
  enqueuedAt: number;
}

const MAX_RETRIES = 3;
const RATE_LIMIT_PER_SEC = 1;
const MAX_QUEUE = 64;
const FIRE_INTERVAL_MS = 1000 / RATE_LIMIT_PER_SEC;
const DELIVERY_TIMEOUT_MS = 5000;

export class WebhookDispatcher {
  private readonly queue: QueueItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private droppedCount = 0;
  private deliveries = 0;
  private failures = 0;
  private readonly listener: (ev: AppEvent) => void;

  constructor(
    private readonly registry: Registry,
    private webhooks: WebhookConfig[],
    private readonly opts: { sendFn?: typeof postJson; onLog?: (msg: string) => void } = {},
  ) {
    this.listener = (ev: AppEvent) => this.handleEvent(ev);
    registry.on('event', this.listener);
    this.timer = setInterval(() => this.tick(), FIRE_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  setWebhooks(next: WebhookConfig[]): void {
    this.webhooks = next;
  }

  stats(): { queued: number; dropped: number; deliveries: number; failures: number } {
    return { queued: this.queue.length, dropped: this.droppedCount, deliveries: this.deliveries, failures: this.failures };
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.registry.off('event', this.listener);
  }

  private handleEvent(ev: AppEvent): void {
    for (const cfg of this.webhooks) {
      if (!this.matches(cfg, ev)) continue;
      if (this.queue.length >= MAX_QUEUE) {
        this.queue.shift();
        this.droppedCount++;
        this.opts.onLog?.(`webhooks: dropped oldest (queue full, total dropped=${this.droppedCount})`);
      }
      this.queue.push({ cfg, event: ev, enqueuedAt: Date.now() });
    }
  }

  private matches(cfg: WebhookConfig, ev: AppEvent): boolean {
    if (cfg.events && cfg.events.length) {
      const kindAlias = aliasKind(ev.type);
      if (!cfg.events.includes(ev.type) && !cfg.events.includes(kindAlias)) return false;
    }
    if (cfg.apps && cfg.apps.length && !cfg.apps.includes(ev.app)) return false;
    if (cfg.filter) {
      if (cfg.filter.app && cfg.filter.app.length && !cfg.filter.app.includes(ev.app)) return false;
      if (cfg.filter.to && cfg.filter.to.length && (!ev.to || !cfg.filter.to.includes(ev.to))) return false;
      if (cfg.filter.from && cfg.filter.from.length && (!ev.from || !cfg.filter.from.includes(ev.from))) return false;
    }
    return true;
  }

  // Pre-shaped delivery through the SAME queue/rate-limit/retry path the
  // event stream uses (M84 scheduled digest).
  enqueuePayload(cfg: WebhookConfig, payload: unknown): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.droppedCount++;
      this.opts.onLog?.(`webhooks: dropped oldest (queue full, total dropped=${this.droppedCount})`);
    }
    this.queue.push({ cfg, payload, enqueuedAt: Date.now() });
  }

  private tick(): void {
    const item = this.queue.shift();
    if (!item) return;
    const send = this.opts.sendFn ?? postJson;
    const payload = item.payload !== undefined ? item.payload : shapePayload(item.cfg.url, item.event!);
    void this.attemptDelivery(send, item.cfg, payload, 0).then(ok => {
      if (ok) this.deliveries++;
      else this.failures++;
    });
  }

  private async attemptDelivery(
    send: typeof postJson,
    cfg: WebhookConfig,
    payload: unknown,
    attempt: number,
  ): Promise<boolean> {
    try {
      const r = await send(cfg.url, payload, cfg.headers ?? {});
      if (r.status >= 200 && r.status < 300) return true;
      if (attempt >= MAX_RETRIES) {
        this.opts.onLog?.(`webhooks: ${redactWebhookUrl(cfg.url)} -> HTTP ${r.status} (after ${attempt + 1} attempts)`);
        return false;
      }
      const backoff = 500 * Math.pow(2, attempt);
      await new Promise(res => setTimeout(res, backoff));
      return this.attemptDelivery(send, cfg, payload, attempt + 1);
    } catch (err: any) {
      if (attempt >= MAX_RETRIES) {
        this.opts.onLog?.(`webhooks: ${redactWebhookUrl(cfg.url)} -> ${err?.message || err} (after ${attempt + 1} attempts)`);
        return false;
      }
      const backoff = 500 * Math.pow(2, attempt);
      await new Promise(res => setTimeout(res, backoff));
      return this.attemptDelivery(send, cfg, payload, attempt + 1);
    }
  }
}

// Slack/Discord webhook URLs carry the auth token in their path, so logging the
// full URL on a delivery failure leaks a secret into daimon's logs. Reduce it to
// origin + a redacted path so the log still identifies the endpoint.
export function redactWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}/…`;
  } catch {
    return '<webhook>';
  }
}

function aliasKind(type: string): string {
  if (type === 'error-new' || type === 'error-recur') return 'error';
  if (type === 'warning-new' || type === 'warning-recur') return 'warning';
  if (type === 'lint-new' || type === 'lint-recur') return 'lint';
  return type;
}

// Per-host payload shaping. Slack & Discord both accept a generic `text` field;
// shaping into their native attachment formats keeps notifications readable.
// Anything else gets a generic envelope.
export function shapePayload(url: string, event: AppEvent): unknown {
  // Documented contract: { event, app, ts, payload } where `payload` carries
  // the event-specific fields. The flattened from/to/message stay for
  // back-compat with pre-v0.10 consumers.
  const payload: Record<string, unknown> = {};
  if (event.from !== undefined) payload.from = event.from;
  if (event.to !== undefined) payload.to = event.to;
  if (event.message !== undefined) payload.message = event.message;
  const generic = {
    event: event.type,
    app: event.app,
    ts: event.ts,
    payload,
    from: event.from ?? null,
    to: event.to ?? null,
    message: event.message ?? null,
  };
  let host = '';
  try { host = new URL(url).hostname; } catch { return generic; }
  if (host.endsWith('slack.com')) {
    const headline = `*[${event.app}]* ${event.type}${event.to ? ` → ${event.to}` : ''}`;
    const detail = event.message ?? '';
    return {
      text: detail ? `${headline}\n${detail}` : headline,
      attachments: [
        {
          color: colorFor(event.type),
          fields: [
            { title: 'app', value: event.app, short: true },
            { title: 'type', value: event.type, short: true },
            ...(event.from ? [{ title: 'from', value: event.from, short: true }] : []),
            ...(event.to ? [{ title: 'to', value: event.to, short: true }] : []),
            ...(detail ? [{ title: 'message', value: detail, short: false }] : []),
          ],
          ts: Math.round(event.ts / 1000),
        },
      ],
    };
  }
  if (host.endsWith('discord.com') || host.endsWith('discordapp.com')) {
    const title = `${event.app} · ${event.type}${event.to ? ` → ${event.to}` : ''}`;
    return {
      content: title,
      embeds: [
        {
          title,
          description: event.message ?? undefined,
          color: parseInt(colorFor(event.type).replace('#', ''), 16) || undefined,
          timestamp: new Date(event.ts).toISOString(),
        },
      ],
    };
  }
  return generic;
}

// Digest payload shaping (M84): Slack gets the markdown as `text`, Discord a
// truncated `content`, anything else the JSON report in a generic envelope.
export function shapeDigestPayload(url: string, report: unknown, md: string): unknown {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (host.endsWith('slack.com')) {
    return { text: md.length > 39_000 ? md.slice(0, 39_000) + '\n…(truncated)' : md };
  }
  if (host.endsWith('discord.com') || host.endsWith('discordapp.com')) {
    return { content: md.length > 1900 ? md.slice(0, 1900) + '…' : md };
  }
  return { event: 'digest', ts: Date.now(), report };
}

// Scheduled digest (M84). NOT a cron engine — one interval check at 1-minute
// granularity plus a single catch-up: if the daemon was down at the scheduled
// time, the next tick sends once (never more than one per day per webhook,
// enforced by the persisted last-sent timestamp).
export interface DigestSchedulerDeps {
  webhooks: WebhookConfig[];
  dispatcher: WebhookDispatcher;
  buildReport: (sinceTs: number) => { json: unknown; md: string };
  state: { get: (url: string) => number; set: (url: string, ts: number) => void };
  onDigestSent?: (url: string, ts: number) => void;
  now?: () => number;
}

const DAY_MS = 86_400_000;

export class DigestScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DigestSchedulerDeps) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref?.();
    // Boot-time tick doubles as the catch-up pass.
    this.tick();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // Returns how many digests were sent this tick (test observability).
  tick(now = this.deps.now?.() ?? Date.now()): number {
    let sent = 0;
    for (const cfg of this.deps.webhooks) {
      const m = cfg.digest ? /^(\d{2}):(\d{2})$/.exec(cfg.digest) : null;
      if (!m) continue;
      // Most recent occurrence of HH:MM (local) at or before `now`.
      const d = new Date(now);
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      let occurrence = d.getTime();
      if (occurrence > now) occurrence -= DAY_MS;
      const lastSent = this.deps.state.get(cfg.url);
      // First sight of this webhook: baseline only — a freshly configured
      // digest must not fire retroactively for yesterday's slot.
      if (!lastSent) { this.deps.state.set(cfg.url, now); continue; }
      if (lastSent >= occurrence) continue; // this occurrence already covered
      try {
        const since = lastSent > 0 ? lastSent : occurrence - DAY_MS;
        const { json, md } = this.deps.buildReport(since);
        this.deps.dispatcher.enqueuePayload(cfg, shapeDigestPayload(cfg.url, json, md));
        this.deps.state.set(cfg.url, now);
        this.deps.onDigestSent?.(cfg.url, now);
        sent++;
      } catch {
        // buildReport failing must not kill the timer; next tick retries.
      }
    }
    return sent;
  }
}

function colorFor(type: string): string {
  if (type === 'error-new' || type === 'error-recur' || type === 'regression-detected') return '#ef4444';
  if (type === 'warning-new' || type === 'warning-recur') return '#f59e0b';
  if (type === 'status') return '#3b82f6';
  return '#94a3b8';
}

// Plain Node http POST so we don't have to take on fetch / undici timing
// quirks. Returns { status }. Throws on network error.
export function postJson(url: string, payload: unknown, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch (err) { reject(err); return; }
    const body = Buffer.from(JSON.stringify(payload));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'user-agent': 'daimon-webhooks/1',
        ...headers,
      },
      timeout: DELIVERY_TIMEOUT_MS,
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.on('timeout', () => req.destroy(new Error('delivery timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
