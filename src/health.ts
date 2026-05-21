import http from 'node:http';
import https from 'node:https';
import type { Registry } from './registry.js';
import type { AppmanConfig, HealthProbeConfig } from './types.js';
import { isFatalProbeError, isHealthyHttpStatus, profileProbePath } from './healthProfiles.js';

const FRESH_SERVING_RETRY_MS = 1000;
const INITIAL_DELAY_MS = 500;

export const HEALTH_PROBE_CANDIDATES = ['/', '/health', '/-/health', '/api/health', '/ready', '/healthz'];

interface FreshState {
  retried: boolean;
}

export function resolveProbeUrls(
  cfg: HealthProbeConfig,
  override: string | undefined,
  announced: string | null,
  port: number | null,
  cachedHost: string | null,
): string[] {
  if (override) return [override];
  const path = cfg.path || '/';
  const fallbacks = cfg.fallbackHosts && cfg.fallbackHosts.length ? cfg.fallbackHosts : ['127.0.0.1'];

  if (cfg.host || cfg.scheme) {
    const base = announced ? safeUrl(announced) : null;
    const scheme = cfg.scheme || base?.protocol?.replace(':', '') || 'http';
    const host = cfg.host || base?.hostname || (port ? fallbacks[0] : '127.0.0.1');
    const p = port ?? (base?.port ? Number(base.port) : null);
    return [buildUrl(scheme, host, p, path)];
  }

  if (announced) {
    const u = safeUrl(announced);
    if (u) {
      u.pathname = path;
      return [u.toString()];
    }
  }

  const order: string[] = [];
  if (cachedHost) order.push(cachedHost);
  for (const h of fallbacks) if (!order.includes(h)) order.push(h);
  return order.map(h => buildUrl('http', h, port, path));
}

function safeUrl(s: string): URL | null {
  try { return new URL(s); } catch { return null; }
}

function buildUrl(scheme: string, host: string, port: number | null, path: string): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const portPart = port ? `:${port}` : '';
  return `${scheme}://${bracketed}${portPart}${path.startsWith('/') ? path : '/' + path}`;
}

export class HealthMonitor {
  private timers = new Map<string, NodeJS.Timeout>();
  private starting = new Map<string, NodeJS.Timeout>();
  private freshness = new Map<string, FreshState>();
  private stopped = false;

  constructor(
    private readonly registry: Registry,
    private readonly cfg: HealthProbeConfig,
    private readonly fullConfig?: AppmanConfig,
  ) {
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
      this.freshness.set(name, { retried: false });
      const delay = setTimeout(() => {
        this.starting.delete(name);
        void this.probe(name);
        const t = setInterval(() => void this.probe(name), this.cfg.intervalMs);
        this.timers.set(name, t);
      }, INITIAL_DELAY_MS);
      this.starting.set(name, delay);
    } else {
      const t = this.timers.get(name);
      if (t) { clearInterval(t); this.timers.delete(name); }
      const d = this.starting.get(name);
      if (d) { clearTimeout(d); this.starting.delete(name); }
      this.freshness.delete(name);
      if (s.health !== 'unknown' && (s.status === 'stopped' || s.status === 'error')) {
        this.registry.setHealth(name, 'unknown');
      }
    }
  }

  private async probe(name: string): Promise<void> {
    const s = this.registry.getState(name);
    if (!s || s.status !== 'serving') return;
    const override = this.fullConfig?.overrides?.[name]?.url;
    // Resolve healthProbePath against (1) user override, (2) prior auto-discovery,
    // (3) framework profile default from M52. The profile default takes effect
    // before discovery runs, so a fresh Rails/FastAPI app probes the right path
    // on the first cycle instead of churning through HEALTH_PROBE_CANDIDATES.
    const app = this.registry.getApp(name);
    const baseName = (s as any).baseName ?? name;
    const overridePath =
      this.fullConfig?.overrides?.[name]?.healthProbePath
      ?? this.fullConfig?.overrides?.[baseName]?.healthProbePath;
    const profilePath = profileProbePath(app?.serverProfile);
    let cfg = this.cfg;
    if (overridePath) cfg = { ...this.cfg, path: overridePath };
    else if (s.discoveredHealthPath) cfg = { ...this.cfg, path: s.discoveredHealthPath };
    else if (profilePath && (this.cfg.path === '/' || !this.cfg.path)) cfg = { ...this.cfg, path: profilePath };
    const candidates = resolveProbeUrls(cfg, override, s.announcedUrl, s.port, s.cachedProbeHost);
    if (
      !override && !overridePath && !s.discoveredHealthPath &&
      (this.cfg.path === '/' || !this.cfg.path) &&
      s.health !== 'healthy'
    ) {
      void this.discoverPath(name);
    }
    if (candidates.length === 0) {
      this.registry.setLastHealthError(name, 'no probe URL available');
      this.registry.setHealth(name, 'unhealthy');
      return;
    }

    let firstError: string | null = null;
    for (const url of candidates) {
      const result = await this.tryProbe(url);
      if (result.ok) {
        const u = safeUrl(url);
        if (u) this.registry.setCachedProbeHost(name, u.hostname.replace(/^\[|\]$/g, ''));
        this.registry.setResolvedUrl(name, url);
        this.registry.setLastHealthError(name, null);
        this.registry.setHealth(name, 'healthy');
        return;
      }
      if (!firstError) firstError = `${result.error} ${url}`;
    }

    const fresh = this.freshness.get(name);
    if (fresh && !fresh.retried) {
      fresh.retried = true;
      setTimeout(() => void this.probe(name), FRESH_SERVING_RETRY_MS);
      return;
    }
    this.registry.setLastHealthError(name, firstError || 'unknown probe failure');
    this.registry.setHealth(name, 'unhealthy');
  }

  private async discoverPath(name: string): Promise<void> {
    const s = this.registry.getState(name);
    if (!s || s.status !== 'serving') return;
    if (s.discoveredHealthPath) return;
    for (const candidate of HEALTH_PROBE_CANDIDATES) {
      const cfg = { ...this.cfg, path: candidate };
      const urls = resolveProbeUrls(cfg, undefined, s.announcedUrl, s.port, s.cachedProbeHost);
      for (const url of urls) {
        const r = await this.tryProbe(url, { strict2xx: true });
        if (r.ok) {
          s.discoveredHealthPath = candidate;
          this.registry.recordEvent({
            app: name,
            type: 'health',
            message: `discovered probe path: ${candidate} (pin via POST /api/apps/${encodeURIComponent(name)}/health/pin or daimon pin-health ${name} --accept)`,
          });
          return;
        }
      }
    }
  }

  private tryProbe(url: string, probeOpts: { strict2xx?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    return new Promise(resolve => {
      let settled = false;
      const done = (v: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const isHttps = url.startsWith('https://');
      const lib = isHttps ? https : http;
      const reqOpts: any = { timeout: this.cfg.timeoutMs };
      if (isHttps) {
        const u = safeUrl(url);
        const host = u?.hostname?.replace(/^\[|\]$/g, '') ?? '';
        const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
        // Dev servers using mkcert / self-signed certs on loopback would otherwise fail with
        // UNABLE_TO_VERIFY_LEAF_SIGNATURE. Strict checks still apply off-loopback.
        reqOpts.rejectUnauthorized = isLoopback ? false : !!this.cfg.rejectUnauthorized;
      }
      const upper = probeOpts.strict2xx ? 300 : 500;
      try {
        const req = lib.get(url, reqOpts, (res: any) => {
          const code = res.statusCode ?? 0;
          res.resume();
          // M52 smart probe outcome: trust isHealthyHttpStatus for the common
          // case (200/302/401) and fall back to the legacy <500 window for
          // anything else 2xx/3xx/4xx — the latter keeps existing fixtures
          // passing. 5xx is unhealthy. `strict2xx` (used by path discovery)
          // still demands a real 2xx.
          if (probeOpts.strict2xx) {
            if (code >= 200 && code < upper) done({ ok: true });
            else done({ ok: false, error: `http ${code}` });
          } else if (isHealthyHttpStatus(code) || (code >= 200 && code < upper)) {
            done({ ok: true });
          } else {
            done({ ok: false, error: `http ${code}` });
          }
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (err: any) => {
          const code = err?.code || err?.message || 'error';
          if (isFatalProbeError(err?.code)) {
            done({ ok: false, error: `${code} (server not responding)` });
          } else {
            done({ ok: false, error: code });
          }
        });
      } catch (err: any) {
        done({ ok: false, error: err?.message || 'throw' });
      }
    });
  }
}
