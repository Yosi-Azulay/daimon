import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registry } from './registry.js';
import { Cursors } from './cursors.js';
import { buildSnapshot, writeSnapshot } from './snapshot.js';
import { executeClean, planClean } from './clean.js';
import { exportMetrics } from './metrics.js';
import type { RequestLog } from './requestLog.js';
import type { AppmanConfig, AppSummary, ErrorEntry } from './types.js';
import { appendAuditEntry } from './audit.js';
import { listPresets } from './presets.js';
import { writeHandoff } from './stateHandoff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function dashboardPath(): string | null {
  const candidates = [
    path.resolve(__dirname, 'dashboard.html'),
    path.resolve(__dirname, '..', 'src', 'dashboard.html'),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseDuration(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2] || 'ms') {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
  }
  return undefined;
}

function resolveFormat(url: URL, getConfig?: () => AppmanConfig): 'compact' | 'full' {
  const q = (url.searchParams.get('format') || '').toLowerCase();
  if (q === 'full') return 'full';
  if (q === 'compact') return 'compact';
  const def = getConfig?.().output?.format;
  return def === 'full' ? 'full' : 'compact';
}

function compactSummary(s: AppSummary): Record<string, unknown> {
  return {
    name: s.name,
    status: s.status,
    port: s.port,
    health: s.health,
    errCount: s.errorCount,
    lastChangeMs: s.lastChangeMs ?? null,
  };
}

function compactStatus(s: AppSummary): Record<string, unknown> {
  return {
    name: s.name,
    status: s.status,
    port: s.port,
    url: s.url,
    health: s.health,
    errCount: s.errorCount,
    lastChangeMs: s.lastChangeMs ?? null,
    uptime: s.uptimeMs,
  };
}

function compactError(e: ErrorEntry): Record<string, unknown> {
  const p = e.parsed;
  if (p && (p.file || p.code)) {
    return { file: p.file ?? null, line: p.line ?? null, col: p.col ?? null, code: p.code ?? null, message: p.message ?? e.message };
  }
  return { file: null, line: null, col: null, code: null, message: e.message };
}

function parseSinceParam(s: string | null): { sinceMs?: number; sinceTs?: number } {
  if (!s) return {};
  if (/^\d{10,}$/.test(s)) return { sinceTs: Number(s) };
  const dur = parseDuration(s);
  if (dur != null) return { sinceMs: dur };
  return {};
}

export interface ServerOpts {
  metricsEnabled?: boolean;
  requestLog?: RequestLog | null;
  onShutdown?: () => void;
  configPath?: string;
  getConfig?: () => AppmanConfig;
  reloadConfig?: () => Promise<{ ok: boolean; addedApps: string[]; removedApps: string[] }>;
  patchConfig?: (patch: any) => { ok: true; applied: string[]; addedApps?: string[]; removedApps?: string[]; restartRequired?: string[] } | { ok: false; error: string };
}

const REDACT_KEY = /key|secret|token|password|pass/i;

function redactConfig(cfg: AppmanConfig): any {
  const clone: any = JSON.parse(JSON.stringify(cfg));
  if (clone.apiToken) clone.apiToken = '***';
  if (clone.overrides && typeof clone.overrides === 'object') {
    for (const name of Object.keys(clone.overrides)) {
      const env = clone.overrides[name]?.env;
      if (env && typeof env === 'object') {
        for (const k of Object.keys(env)) {
          if (REDACT_KEY.test(k)) env[k] = '***';
        }
      }
    }
  }
  return clone;
}

function configEtag(configPath: string | undefined): string {
  if (!configPath) return '';
  try {
    const buf = fs.readFileSync(configPath);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return '';
  }
}

export function startServer(registry: Registry, port: number, opts: ServerOpts = {}): http.Server {
  const cursors = new Cursors();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const method = req.method || 'GET';
      const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);

      const requireAuth = (): boolean => {
        const cfg = opts.getConfig ? opts.getConfig() : null;
        const token = cfg?.apiToken ?? null;
        if (!token) return true;
        const hdr = req.headers['authorization'];
        if (typeof hdr === 'string' && hdr.toLowerCase().startsWith('bearer ') && hdr.slice(7).trim() === token) return true;
        sendJson(res, 401, { error: 'unauthorized' });
        return false;
      };

      if (method === 'POST' && url.pathname === '/api/shutdown') {
        if (!requireAuth()) return;
        sendJson(res, 200, { ok: true });
        if (opts.onShutdown) setImmediate(() => { try { opts.onShutdown!(); } catch {} });
        return;
      }

      if (url.pathname === '/api/config' && opts.getConfig) {
        if (method === 'GET') {
          const cfg = opts.getConfig();
          const etag = configEtag(opts.configPath);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'etag': etag,
          });
          res.end(JSON.stringify({ etag, config: redactConfig(cfg) }));
          return;
        }
        if (method === 'PATCH' && opts.patchConfig) {
          if (!requireAuth()) return;
          const ifMatch = (req.headers['if-match'] as string | undefined)?.trim();
          const current = configEtag(opts.configPath);
          if (!ifMatch || ifMatch !== current) {
            sendJson(res, 412, { error: 'etag mismatch', current });
            return;
          }
          let body: any = {};
          if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
            await new Promise<void>(resolve => {
              const chunks: Buffer[] = [];
              req.on('data', (c: Buffer) => chunks.push(c));
              req.on('end', () => { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve(); });
            });
          }
          const r = opts.patchConfig(body);
          if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
          const newEtag = configEtag(opts.configPath);
          try {
            const remote = (req.socket as any).remoteAddress || '127.0.0.1';
            appendAuditEntry(remote, body, body, r.applied);
          } catch {}
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'etag': newEtag });
          res.end(JSON.stringify({ etag: newEtag, applied: r.applied, addedApps: r.addedApps, removedApps: r.removedApps, restartRequired: r.restartRequired }));
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (url.pathname === '/api/presets' && method === 'GET') {
        sendJson(res, 200, listPresets());
        return;
      }
      if (url.pathname === '/api/snapshot-state' && method === 'POST') {
        if (!requireAuth()) return;
        const p = writeHandoff(registry);
        sendJson(res, 200, { ok: true, path: p });
        return;
      }
      if (url.pathname === '/api/config/reload' && method === 'POST' && opts.reloadConfig) {
        if (!requireAuth()) return;
        try {
          const r = await opts.reloadConfig();
          sendJson(res, 200, r);
        } catch (err: any) {
          sendJson(res, 400, { error: err?.message || String(err) });
        }
        return;
      }

      if (method === 'GET' && url.pathname === '/metrics' && opts.metricsEnabled) {
        const body = exportMetrics(registry);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      if (method !== 'GET' && url.pathname.startsWith('/api/') && url.pathname !== '/api/shutdown' && url.pathname !== '/api/config' && url.pathname !== '/api/config/reload') {
        if (!requireAuth()) return;
      }

      if (method === 'GET' && url.pathname === '/') {
        const p = dashboardPath();
        if (!p) {
          res.writeHead(404).end('dashboard not found');
          return;
        }
        const body = fs.readFileSync(p);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
        });
        res.end(body);
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'events' && parts.length === 2) {
        if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
        const sinceMs = parseDuration(url.searchParams.get('since'));
        const app = url.searchParams.get('app') || undefined;
        if (url.searchParams.get('stream') === 'ndjson') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
          const seed = registry.events({ sinceMs, app });
          for (const ev of seed) res.write(JSON.stringify(ev) + '\n');
          const onEvent = (ev: any) => {
            if (app && ev.app !== app) return;
            res.write(JSON.stringify(ev) + '\n');
          };
          registry.on('event', onEvent);
          const keepalive = setInterval(() => { try { res.write('\n'); } catch {} }, 30_000);
          req.on('close', () => { registry.off('event', onEvent); clearInterval(keepalive); try { res.end(); } catch {} });
          return;
        }
        const memEvents = registry.events({ sinceMs, app });
        const h = registry.getHistory();
        if (h && sinceMs && memEvents.length < 500) {
          const sinceTs = Date.now() - sinceMs;
          const rows = h.queryEvents({ app, since: sinceTs, limit: 1000 });
          const seen = new Set(memEvents.map(e => `${e.ts}|${e.app}|${e.type}|${e.from ?? ''}|${e.to ?? ''}|${e.message ?? ''}`));
          for (const r of rows) {
            const key = `${r.ts}|${r.app}|${r.type}|${r.from_state ?? ''}|${r.to_state ?? ''}|${r.message ?? ''}`;
            if (seen.has(key)) continue;
            memEvents.push({ ts: r.ts, app: r.app, type: r.type as any, from: r.from_state ?? undefined, to: r.to_state ?? undefined, message: r.message ?? undefined });
          }
          memEvents.sort((a, b) => a.ts - b.ts);
        }
        sendJson(res, 200, memEvents);
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'session') {
        if (parts[2] === 'record' && method === 'POST') {
          const action = url.searchParams.get('action') || 'toggle';
          if (action === 'start' || (action === 'toggle' && !registry.sessionRecorder.isRecording())) {
            const r = registry.sessionRecorder.start();
            sendJson(res, 200, { recording: true, path: r.path });
            return;
          }
          if (action === 'stop' || (action === 'toggle' && registry.sessionRecorder.isRecording())) {
            const r = registry.sessionRecorder.stop();
            sendJson(res, 200, { recording: false, path: r.path });
            return;
          }
          sendJson(res, 400, { error: 'invalid action' });
          return;
        }
        if (parts[2] === 'status' && method === 'GET') {
          sendJson(res, 200, { recording: registry.sessionRecorder.isRecording() });
          return;
        }
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'history') {
        if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
        const h = registry.getHistory();
        if (!h) { sendJson(res, 200, []); return; }
        const sub3 = parts[2];
        const app = url.searchParams.get('app') || undefined;
        const since = url.searchParams.get('since');
        const until = url.searchParams.get('until');
        const limit = url.searchParams.get('limit');
        const sinceMs = since ? (/^\d{10,}$/.test(since) ? Number(since) : Date.now() - (parseDuration(since) ?? 0)) : undefined;
        const untilMs = until ? (/^\d{10,}$/.test(until) ? Number(until) : Date.now() - (parseDuration(until) ?? 0)) : undefined;
        const lim = limit ? Number(limit) : undefined;
        if (sub3 === 'events') {
          sendJson(res, 200, h.queryEvents({ app, since: sinceMs, until: untilMs, type: url.searchParams.get('type') || undefined, limit: lim }));
          return;
        }
        if (sub3 === 'compile-times') {
          sendJson(res, 200, h.queryCompiles({ app, since: sinceMs, until: untilMs, limit: lim }));
          return;
        }
        if (sub3 === 'tasks') {
          sendJson(res, 200, h.queryTasks({ app, task: url.searchParams.get('task') || undefined, since: sinceMs, limit: lim }));
          return;
        }
        if (sub3 === 'summary' && parts.length >= 4) {
          const name = decodeURIComponent(parts[3]);
          sendJson(res, 200, h.summary(name));
          return;
        }
        if (sub3 === 'why' && parts.length >= 4) {
          const name = decodeURIComponent(parts[3]);
          sendJson(res, 200, h.why(name));
          return;
        }
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'profiles' && parts[3] === 'ensure-up' && method === 'POST') {
        const profile = decodeURIComponent(parts[2]);
        const cfg = opts.getConfig?.();
        const list = cfg?.profiles?.[profile];
        if (!list) { sendJson(res, 404, { error: 'unknown profile' }); return; }
        const untilRaw = (url.searchParams.get('until') || 'healthy').toLowerCase();
        if (!['serving', 'healthy'].includes(untilRaw)) { sendJson(res, 400, { error: 'until must be serving|healthy' }); return; }
        const timeoutMsRaw = url.searchParams.get('timeoutMs') || url.searchParams.get('timeout');
        let timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 300_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 300_000;
        timeoutMs = Math.min(timeoutMs, 1_200_000);
        const probeEnabled = cfg?.healthProbe?.enabled ?? true;
        const effectiveUntil = (untilRaw === 'healthy' && !probeEnabled) ? 'serving' : (untilRaw as 'serving' | 'healthy');
        const start = Date.now();
        for (const n of list) {
          const s = registry.summary(n);
          if (!s) continue;
          if (s.status !== 'serving' && s.status !== 'starting' && s.status !== 'compiling') {
            await registry.startWithDeps(n);
          }
        }
        const apps = await Promise.all(list.map(async n => {
          const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
          const summary0 = registry.summary(n);
          if (!summary0) return { name: n, state: null, until: effectiveUntil, reachedTargetMs: null, timedOut: false, error: 'unknown' };
          const r = await registry.waitFor(n, effectiveUntil, remaining);
          const s = registry.summary(n);
          return {
            name: n,
            state: s ? compactStatus(s) : null,
            until: effectiveUntil,
            reachedTargetMs: r.timedOut ? null : r.waitedMs,
            timedOut: r.timedOut,
          };
        }));
        sendJson(res, 200, { profile, apps, _meta: { totalMs: Date.now() - start, until: effectiveUntil } });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'discovery' && parts[2] === 'explain' && method === 'GET') {
        const cfg = opts.getConfig?.();
        if (!cfg) { sendJson(res, 200, { searchRoots: [], scanned: 0, rejected: {}, warnings: [], suggestion: 'no config loaded' }); return; }
        const { discoverApps } = await import('./discovery.js');
        const stats = { scanned: 0, rejected: {} as Record<string, number> };
        const warnings: string[] = [];
        const apps = discoverApps(cfg, { warnings, stats });
        const roots = cfg.searchRoots.map(s => typeof s === 'string' ? s : s.path);
        sendJson(res, 200, {
          searchRoots: roots,
          scanned: stats.scanned,
          rejected: stats.rejected,
          warnings,
          appsFound: apps.length,
          suggestion: apps.length === 0
            ? (roots.length === 0
              ? "no searchRoots configured. Run 'daimon init --auto' from a workspace folder."
              : "discovery returned no apps. Check that searchRoots contain nx.json / angular.json / vite.config.* / .storybook.")
            : `${apps.length} apps discovered`,
        });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'overview' && method === 'GET') {
        const cfg = opts.getConfig?.();
        const all = registry.list();
        const workspace = url.searchParams.get('workspace');
        const profile = url.searchParams.get('profile');
        let filtered = all;
        if (workspace) filtered = filtered.filter(a => a.workspaceLabel === workspace);
        if (profile) {
          const list = cfg?.profiles?.[profile] ?? null;
          if (list) filtered = filtered.filter(a => list.includes(a.name));
        }
        const totals = {
          apps: filtered.length,
          serving: filtered.filter(a => a.status === 'serving').length,
          errors: filtered.filter(a => a.status === 'error').length,
          stopped: filtered.filter(a => a.status === 'stopped').length,
          totalErrCount: filtered.reduce((acc, a) => acc + a.errorCount, 0),
          totalCpuPct: Math.round(filtered.reduce((acc, a) => acc + (a.cpu ?? 0), 0) * 10) / 10,
          totalMemMb: Math.round(filtered.reduce((acc, a) => acc + (a.memMB ?? 0), 0)),
        };
        const byStatus: Record<string, string[]> = {};
        for (const a of filtered) {
          (byStatus[a.status] ??= []).push(a.name);
        }
        const needsAttention = filtered
          .filter(a => a.status === 'error' || a.errorCount > 0)
          .map(a => {
            const errs = registry.errors(a.name) ?? [];
            const first = errs[errs.length - 1];
            const parsed = first?.parsed;
            return {
              name: a.name,
              status: a.status,
              errCount: a.errorCount,
              firstError: parsed
                ? { file: parsed.file ?? null, line: parsed.line ?? null, code: parsed.code ?? null, message: parsed.message ?? first?.message ?? '' }
                : first
                  ? { file: null, line: null, code: null, message: first.message }
                  : null,
            };
          });
        const fiveMinAgo = Date.now() - 5 * 60_000;
        const recentlyChanged = registry
          .events({ sinceMs: 5 * 60_000 })
          .filter(ev => ev.type === 'status' && ev.ts >= fiveMinAgo)
          .filter(ev => (workspace ? filtered.some(a => a.name === ev.app) : true))
          .filter(ev => (profile ? filtered.some(a => a.name === ev.app) : true))
          .slice(-5)
          .map(ev => ({ name: ev.app, transition: `${ev.from ?? '?'}→${ev.to ?? '?'}`, msAgo: Date.now() - ev.ts }));
        const out: any = { ts: Date.now(), totals, byStatus, needsAttention, recentlyChanged };
        if (totals.apps === 0) {
          out._meta = { suggestion: "no apps registered. run 'daimon doctor' for recommended next step, or 'daimon init --auto' from a workspace folder." };
        }
        sendJson(res, 200, out);
        return;
      }

      if (parts[0] !== 'api' || parts[1] !== 'apps') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      if (parts.length === 2) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const fmt = resolveFormat(url, opts.getConfig);
        const all = registry.list();
        const rows = fmt === 'full' ? all : all.map(compactSummary);
        if (url.searchParams.get('stream') === 'ndjson') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
          for (const row of rows) res.write(JSON.stringify(row) + '\n');
          res.end();
          return;
        }
        if (url.searchParams.get('explain') === '1') {
          const cfg = opts.getConfig?.();
          let meta: any = { format: fmt };
          if (cfg) {
            const { discoverApps } = await import('./discovery.js');
            const stats = { scanned: 0, rejected: {} as Record<string, number> };
            const warnings: string[] = [];
            discoverApps(cfg, { warnings, stats });
            const roots = cfg.searchRoots.map(s => typeof s === 'string' ? s : s.path);
            meta = {
              format: fmt,
              searchRoots: roots,
              scanned: stats.scanned,
              rejected: stats.rejected,
              warnings,
              suggestion: rows.length === 0
                ? (roots.length === 0
                  ? "no searchRoots configured. Run 'daimon init --auto' from a workspace folder to add the current cwd."
                  : "discovery returned no apps. Check that searchRoots contain nx.json / angular.json / vite.config.* / .storybook, then run 'daimon doctor'.")
                : 'apps discovered; _meta is informational.',
            };
          }
          sendJson(res, 200, { apps: rows, _meta: meta });
          return;
        }
        sendJson(res, 200, rows);
        return;
      }

      const name = decodeURIComponent(parts[2]);
      const sub = parts[3];
      const sub2 = parts[4];

      if (!sub) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const s = registry.summary(name);
        if (!s) {
          sendJson(res, 404, { error: 'unknown app' });
          return;
        }
        const fmt = resolveFormat(url, opts.getConfig);
        if (fmt === 'full') {
          sendJson(res, 200, { ...s, _meta: { format: 'full' } });
        } else {
          sendJson(res, 200, { ...compactStatus(s), _meta: { format: 'compact' } });
        }
        return;
      }

      if (sub === 'errors' && sub2 === 'since-last' && method === 'GET') {
        const client = url.searchParams.get('client') || 'default';
        const cursor = cursors.getErrorCursor(client, name);
        const errs = registry.errorsSince(name, cursor);
        if (errs == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
        const newest = errs.reduce((acc, e) => Math.max(acc, e.lastSeen), cursor);
        if (newest > cursor) cursors.setErrorCursor(client, name, newest);
        const fmt = resolveFormat(url, opts.getConfig);
        sendJson(res, 200, fmt === 'full' ? errs : errs.map(compactError));
        return;
      }

      if (sub === 'errors' && !sub2 && method === 'GET') {
        const sinceRaw = url.searchParams.get('since');
        const fmt = resolveFormat(url, opts.getConfig);
        if (sinceRaw) {
          const { sinceMs, sinceTs } = parseSinceParam(sinceRaw);
          const cutoff = sinceTs ?? (sinceMs != null ? Date.now() - sinceMs : 0);
          const errs = registry.errorsSince(name, cutoff);
          if (errs == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
          sendJson(res, 200, fmt === 'full' ? errs : errs.map(compactError));
          return;
        }
        const errs = registry.errors(name);
        if (errs == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
        sendJson(res, 200, fmt === 'full' ? errs : errs.map(compactError));
        return;
      }

      if (sub === 'logs' && parts[4] === 'stream' && method === 'GET') {
        if (!registry.summary(name)) { sendJson(res, 404, { error: 'unknown app' }); return; }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });
        const initial = registry.logs(name, { tail: 50 }) ?? [];
        for (const line of initial) {
          res.write(`data: ${JSON.stringify({ ts: Date.now(), line })}\n\n`);
        }
        const buffer: string[] = [];
        let dropped = 0;
        const flush = () => {
          while (buffer.length) {
            const ok = res.write(buffer.shift()!);
            if (!ok) break;
          }
        };
        const onLog = (ev: { name: string; ts: number; line: string }) => {
          if (ev.name !== name) return;
          if (buffer.length >= 200) { dropped++; buffer.shift(); }
          buffer.push(`data: ${JSON.stringify({ ts: ev.ts, line: ev.line })}\n\n`);
          flush();
        };
        registry.on('log', onLog);
        const keepalive = setInterval(() => res.write(': ping\n\n'), 30_000);
        req.on('close', () => { registry.off('log', onLog); clearInterval(keepalive); });
        return;
      }

      if (sub === 'logs' && method === 'GET') {
        const tail = url.searchParams.get('tail');
        const since = url.searchParams.get('since');
        const lines = registry.logs(name, {
          tail: tail ? Number(tail) : undefined,
          sinceMs: parseDuration(since),
        });
        if (lines == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
        sendJson(res, 200, { lines });
        return;
      }

      if (sub === 'wait' && method === 'GET') {
        if (!registry.summary(name)) { sendJson(res, 404, { error: 'unknown app' }); return; }
        const untilRaw = (url.searchParams.get('until') || 'serving').toLowerCase();
        if (!['serving', 'healthy', 'stopped', 'error'].includes(untilRaw)) {
          sendJson(res, 400, { error: 'until must be one of serving|healthy|stopped|error' });
          return;
        }
        const timeoutSecRaw = url.searchParams.get('timeout');
        let timeoutSec = timeoutSecRaw ? Number(timeoutSecRaw) : 120;
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) timeoutSec = 120;
        timeoutSec = Math.min(timeoutSec, 600);
        const result = await registry.waitFor(name, untilRaw as any, timeoutSec * 1000);
        sendJson(res, 200, result);
        return;
      }

      if (sub === 'ensure' && method === 'POST') {
        const s0 = registry.summary(name);
        if (!s0) { sendJson(res, 404, { error: 'unknown app' }); return; }
        const untilRaw = (url.searchParams.get('until') || 'healthy').toLowerCase();
        if (!['serving', 'healthy'].includes(untilRaw)) {
          sendJson(res, 400, { error: 'until must be serving|healthy' });
          return;
        }
        const timeoutMsRaw = url.searchParams.get('timeoutMs') || url.searchParams.get('timeout');
        let timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 180_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 180_000;
        timeoutMs = Math.min(timeoutMs, 600_000);
        const probeEnabled = opts.getConfig?.().healthProbe?.enabled ?? true;
        let effectiveUntil: 'serving' | 'healthy' = untilRaw as any;
        let warning: string | undefined;
        if (effectiveUntil === 'healthy' && !probeEnabled) {
          effectiveUntil = 'serving';
          warning = 'no health probe; treated serving as terminal';
        }
        const alreadyTerminal =
          (effectiveUntil === 'serving' && s0.status === 'serving') ||
          (effectiveUntil === 'healthy' && s0.status === 'serving' && s0.health === 'healthy');
        if (alreadyTerminal) {
          sendJson(res, 200, { ...compactStatus(s0), _meta: { format: 'compact', startedFromState: null, warning, waitedMs: 0 } });
          return;
        }
        const startFromState = s0.status;
        if (s0.status !== 'starting' && s0.status !== 'compiling') {
          await registry.start(name);
        }
        const r = await registry.waitFor(name, effectiveUntil, timeoutMs);
        const sFinal = registry.summary(name);
        const compact = sFinal ? compactStatus(sFinal) : { name, status: r.status, port: null, url: null, health: r.health, errCount: 0, lastChangeMs: null, uptime: null };
        if (r.timedOut) {
          sendJson(res, 200, { error: 'timeout', state: compact, _meta: { format: 'compact', startedFromState: startFromState, warning, waitedMs: r.waitedMs, timedOut: true } });
          return;
        }
        sendJson(res, 200, { ...compact, _meta: { format: 'compact', startedFromState: startFromState, warning, waitedMs: r.waitedMs } });
        return;
      }

      if (sub === 'start' && method === 'POST') {
        const withDeps = url.searchParams.get('withDeps') === '1';
        if (withDeps) {
          const r = await registry.startWithDeps(name);
          sendJson(res, r.ok ? 200 : 400, r);
          return;
        }
        const r = await registry.start(name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }
      if (sub === 'start-with-deps' && method === 'POST') {
        const r = await registry.startWithDeps(name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      if (sub === 'tasks' && method === 'GET' && !sub2) {
        const tasks = registry.listTasks(name);
        if (tasks == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
        sendJson(res, 200, { tasks, watching: registry.listWatchTasks(name) });
        return;
      }

      if (sub === 'run' && sub2 && method === 'POST') {
        let body: any = {};
        if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
          await new Promise<void>(resolve => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve(); });
          });
        }
        const args: string[] = Array.isArray(body.args) ? body.args.map(String) : [];
        if (body.watch) {
          const r = registry.startWatchTask(name, sub2, args);
          sendJson(res, r.ok ? 200 : 400, r);
          return;
        }
        const r = await registry.runTask(name, sub2, args);
        if ('error' in r) { sendJson(res, 404, r); return; }
        sendJson(res, 200, r);
        return;
      }

      if (sub === 'run-stop' && sub2 && method === 'POST') {
        const r = await registry.stopWatchTask(name, sub2);
        sendJson(res, 200, r);
        return;
      }

      if (sub === 'env' && method === 'GET') {
        const cfg = registry.getConfig();
        const candidates = cfg.envFiles?.[name] ?? [];
        const state = registry.getState(name);
        sendJson(res, 200, { candidates, active: state?.activeEnvFile ?? null });
        return;
      }
      if (sub === 'env' && method === 'POST') {
        let body: any = {};
        if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
          await new Promise<void>(resolve => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve(); });
          });
        }
        registry.setActiveEnvFile(name, body.use ?? null);
        const state = registry.getState(name);
        sendJson(res, 200, { active: state?.activeEnvFile ?? null });
        return;
      }

      if (sub === 'requests' && method === 'GET') {
        if (!opts.requestLog) { sendJson(res, 200, []); return; }
        const sinceMs = parseDuration(url.searchParams.get('since'));
        sendJson(res, 200, opts.requestLog.requests(name, sinceMs));
        return;
      }

      if (sub === 'clean' && method === 'POST') {
        const deep = url.searchParams.get('deep') === '1';
        const yes = url.searchParams.get('yes') === '1';
        const plan = planClean(registry, name, deep);
        if (!plan) { sendJson(res, 404, { error: 'unknown app' }); return; }
        if (plan.ranOnServing) { sendJson(res, 409, { error: 'refusing: app is currently running', plan }); return; }
        if (!yes) { sendJson(res, 200, { plan, hint: 'pass --yes to delete' }); return; }
        const result = executeClean(registry, name, deep);
        sendJson(res, 200, result);
        return;
      }

      if (sub === 'snapshot' && method === 'POST') {
        const persist = url.searchParams.get('write') === '1';
        if (persist) {
          const wr = writeSnapshot(registry, name);
          if (!wr) { sendJson(res, 404, { error: 'unknown app' }); return; }
          sendJson(res, 200, { snapshot: wr.path });
          return;
        }
        const p = buildSnapshot(registry, name);
        if (!p) { sendJson(res, 404, { error: 'unknown app' }); return; }
        sendJson(res, 200, p);
        return;
      }
      if (sub === 'stop' && method === 'POST') {
        const r = await registry.stop(name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }
      if (sub === 'restart' && method === 'POST') {
        const r = await registry.restart(name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
  });

  server.listen(port, '127.0.0.1');
  return server;
}
