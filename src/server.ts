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
import { DAIMON_VERSION } from './version.js';
import type { SelfMetricsCollector } from './selfMetrics.js';
import { isPathUnder } from './pathScope.js';
import { AgentRegistry, LockManager } from './agents.js';
import { parsePortPool } from './ports.js';
import { findPortHolder, scanListeningPorts } from './portDiag.js';
import { diffEnvSnapshots, resolveEnvFilePath } from './envFiles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function dashboardSpaDir(): string | null {
  // Angular 20's @angular/build:application builder writes the SPA to
  // <outputPath>/browser/. Probe both that and the legacy flat layout so the
  // daemon works regardless of which builder produced the bundle.
  const candidates = [
    path.resolve(__dirname, 'dashboard', 'browser'),
    path.resolve(__dirname, 'dashboard'),
    path.resolve(__dirname, '..', 'dist', 'dashboard', 'browser'),
    path.resolve(__dirname, '..', 'dist', 'dashboard'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function serveStaticFile(res: http.ServerResponse, abs: string): boolean {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    const ct = MIME[ext] ?? 'application/octet-stream';
    const buf = fs.readFileSync(abs);
    res.writeHead(200, { 'content-type': ct, 'content-length': buf.length, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Version-skew detection (M88): the CLI compares this against its own
    // version on responses it already receives — no extra round-trip. Absence
    // of the header itself signals a pre-v0.14 daemon.
    'x-daimon-version': DAIMON_VERSION,
  });
  res.end(body);
}

function parseDuration(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2] || 'ms') {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    // 'd' was missing pre-v0.11: `?since=30d` (regressions page, timeline CLI)
    // silently collapsed the window to "now" and returned nothing.
    case 'd': return n * 24 * 60 * 60 * 1000;
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
  const out: Record<string, unknown> = {
    name: s.name,
    status: s.status,
    port: s.port,
    health: s.health,
    errCount: s.errorCount,
    lastChangeMs: s.lastChangeMs ?? null,
  };
  if (s.serverProfile) out.serverProfile = s.serverProfile; // badge tag (M70/M72)
  return out;
}

function compactStatus(s: AppSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: s.name,
    status: s.status,
    port: s.port,
    url: s.url,
    health: s.health,
    errCount: s.errorCount,
    lastChangeMs: s.lastChangeMs ?? null,
    // M87 last-call rename (was `uptime`): the value is milliseconds and the
    // unsuffixed key caused real unit bugs in agents. Frozen as uptimeMs.
    uptimeMs: s.uptimeMs,
  };
  if (s.estimatedReadyAtMs != null) out.estimatedReadyAtMs = s.estimatedReadyAtMs;
  if (s.serverProfile) out.serverProfile = s.serverProfile;
  return out;
}

function compactError(e: ErrorEntry): Record<string, unknown> {
  const p = e.parsed;
  const level = e.level ?? 'error';
  if (p && (p.file || p.code)) {
    return { file: p.file ?? null, line: p.line ?? null, col: p.col ?? null, code: p.code ?? null, message: p.message ?? e.message, level };
  }
  return { file: null, line: null, col: null, code: null, message: e.message, level };
}

// M90: the most common 404 names the next step everywhere it appears.
const UNKNOWN_APP = { error: 'unknown app', hint: "list apps with GET /api/apps (CLI: daimon list); pass ?cwd= or --workspace to disambiguate duplicated names" };

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
  selfMetrics?: SelfMetricsCollector | null;
  getPlugins?: () => { name: string; description?: string; file: string; status: string; error?: string; lastFindings?: any[] }[];
  runPluginScans?: () => Promise<void>;
}

// A hostname is loopback if it's localhost, ::1, or in 127.0.0.0/8. Used to
// gate mutating requests: a browser page on any other origin (or a DNS-rebind
// domain resolving to 127.0.0.1) presents a non-loopback Host/Origin and is
// rejected, so a visited web page can't drive start/stop/run/config on the
// local daemon (CSRF / DNS-rebinding).
function isLoopbackHostname(hostname: string): boolean {
  if (!hostname) return false;
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // [::1]
  if (h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// Extract the hostname from a Host header value ("127.0.0.1:4999" -> "127.0.0.1",
// "[::1]:4999" -> "[::1]"). Returns '' if it can't be parsed.
function hostnameFromHostHeader(host: string | undefined): string {
  if (!host) return '';
  const h = host.trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // keep [..] for isLoopbackHostname
  const colon = h.indexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

// A request is allowed to mutate state only if both its Host and (when present)
// its Origin/Referer are loopback. Non-browser clients (CLI, MCP) send no Origin
// and a loopback Host, so they pass; a cross-origin browser fetch is blocked.
function isSameOriginLoopback(req: http.IncomingMessage): boolean {
  const host = req.headers['host'] as string | undefined;
  // If a Host header is present it must be loopback (blocks DNS rebinding).
  if (host && !isLoopbackHostname(hostnameFromHostHeader(host))) return false;
  const originHdr = (req.headers['origin'] as string | undefined) || (req.headers['referer'] as string | undefined);
  if (originHdr && originHdr !== 'null') {
    try {
      if (!isLoopbackHostname(new URL(originHdr).hostname)) return false;
    } catch {
      return false; // unparseable Origin/Referer — reject
    }
  } else if (originHdr === 'null') {
    return false; // opaque origin (sandboxed iframe / file://) is never trusted
  }
  return true;
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

// Read and JSON-parse a request body with a hard size cap, resolving on the
// socket closing for any reason. The previous inline pattern (a) skipped bodies
// sent with Transfer-Encoding: chunked because it keyed off content-length, and
// (b) listened only for 'end', so an aborted upload left the await pending
// forever. This handles both: it always drains the stream (chunked included),
// bounds memory, and resolves on 'end'/'aborted'/'error'/'close'. Returns {} on
// empty, malformed, or over-limit bodies (over-limit destroys the socket).
const MAX_BODY_BYTES = 1_000_000;
function readJsonBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<any> {
  return new Promise<any>(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (val: any) => { if (!done) { done = true; resolve(val); } };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        try { req.destroy(); } catch {}
        finish({});
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { finish({}); return; }
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish({}); }
    });
    req.on('aborted', () => finish({}));
    req.on('error', () => finish({}));
    req.on('close', () => finish({}));
  });
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
  const serverStartedAt = Date.now();
  const cursors = new Cursors();
  const agents = new AgentRegistry();
  const locks = new LockManager();
  // Every CLI invocation mints a fresh id, so without pruning the registry
  // grows one record per command for the daemon's lifetime.
  const agentPrune = setInterval(() => agents.prune(), 60_000);
  agentPrune.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const method = req.method || 'GET';
      const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);

      // Identify the agent on every request so the in-memory registry, audit
      // log, and per-app soft-lock all see the same id. CLI sends it as a
      // header; MCP forwards from its own env. Missing header = anonymous
      // legacy caller (e.g. the dashboard's polling) — it still acts as
      // 'unknown' for lock/audit purposes but is not recorded as an agent.
      const agentHdr = (req.headers['x-daimon-agent'] as string | undefined)?.trim();
      const cwdHdr = (req.headers['x-daimon-cwd'] as string | undefined)?.trim() || null;
      const agentId = agentHdr && agentHdr.length ? agentHdr : 'unknown';
      if (agentId !== 'unknown') agents.touch(agentId, cwdHdr);

      // CSRF / DNS-rebinding gate: any state-changing method must come from a
      // loopback Host with a loopback (or absent) Origin. Read-only verbs
      // (GET/HEAD/OPTIONS) are exempt — the SPA and streams need them and they
      // can't change state. This runs before every route so no mutating handler
      // can be reached cross-origin.
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !isSameOriginLoopback(req)) {
        sendJson(res, 403, { error: 'forbidden: cross-origin or non-loopback request rejected' });
        return;
      }

      const requireAuth = (): boolean => {
        const cfg = opts.getConfig ? opts.getConfig() : null;
        const token = cfg?.apiToken ?? null;
        if (!token) return true;
        const hdr = req.headers['authorization'];
        if (typeof hdr === 'string' && hdr.toLowerCase().startsWith('bearer ')) {
          const supplied = Buffer.from(hdr.slice(7).trim());
          const expected = Buffer.from(token);
          // Constant-time compare so the token isn't leaked byte-by-byte via
          // response timing. Length check first (timingSafeEqual throws on
          // mismatched lengths).
          if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return true;
        }
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
          const body: any = await readJsonBody(req);
          const r = opts.patchConfig(body);
          if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
          const newEtag = configEtag(opts.configPath);
          try {
            const remote = (req.socket as any).remoteAddress || '127.0.0.1';
            appendAuditEntry(remote, body, body, r.applied, cwdHdr, agentId === 'unknown' ? null : agentId);
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
      // Signature endpoint (M81): lets port forensics and doctor's
      // verify-then-kill positively identify a listener as a daimon. No auth —
      // identification only, loopback only, no state exposed.
      if (url.pathname === '/api/signature' && method === 'GET') {
        sendJson(res, 200, { daimon: true, version: DAIMON_VERSION, pid: process.pid, startedAt: serverStartedAt });
        return;
      }
      // `daimon ports` (M81): app→port→source→pid plus foreign holders of
      // pool/pinned ports (one netstat/ss pass, per-holder enrichment after).
      if (parts[0] === 'api' && parts[1] === 'ports' && !parts[2] && method === 'GET') {
        const cfg = opts.getConfig?.();
        const apps = registry.portsReport();
        const candidates = new Set<number>();
        const pool = parsePortPool(cfg?.ports?.pool ?? null) ?? cfg?.portRange ?? null;
        if (pool) for (let p = pool[0]; p <= pool[1]; p++) candidates.add(p);
        for (const a of apps) if (a.port != null) candidates.add(a.port);
        const listeners = scanListeningPorts(candidates);
        const appByPort = new Map<number, (typeof apps)[number]>();
        for (const a of apps) if (a.port != null) appByPort.set(a.port, a);
        const foreign: { port: number; pid: number; name?: string; cmd?: string }[] = [];
        for (const [p, pid] of listeners) {
          const owner = appByPort.get(p);
          // A running daimon-managed app holds its own port (the LISTEN pid is
          // usually a child of state.pid, so status is the reliable signal).
          if (owner && owner.status !== 'stopped' && owner.status !== 'error') continue;
          if (pid === process.pid) continue;
          // Enrich the first few with process identity; beyond that, pid only.
          const holder = foreign.length < 10 ? findPortHolder(p) : null;
          foreign.push({ port: p, pid: holder?.pid ?? pid, ...(holder?.name ? { name: holder.name } : {}), ...(holder?.cmd ? { cmd: holder.cmd.slice(0, 160) } : {}) });
        }
        foreign.sort((a, b) => a.port - b.port);
        sendJson(res, 200, { pool: cfg?.ports?.pool ?? null, apps, foreign });
        return;
      }
      if (url.pathname === '/api/self' && method === 'GET') {
        if (!opts.selfMetrics) {
          sendJson(res, 503, { error: 'self-metrics collector not attached' });
          return;
        }
        sendJson(res, 200, opts.selfMetrics.snapshot());
        return;
      }
      if (url.pathname === '/api/plugins' && method === 'GET') {
        const list = opts.getPlugins ? opts.getPlugins() : [];
        sendJson(res, 200, list.map(p => ({
          name: p.name, description: p.description ?? null, file: p.file,
          status: p.status, error: p.error ?? null,
          findings: p.lastFindings ?? [],
        })));
        return;
      }
      if (url.pathname === '/api/plugins/scan' && method === 'POST') {
        if (!requireAuth()) return;
        if (!opts.runPluginScans) { sendJson(res, 503, { error: 'plug-in scan not available' }); return; }
        try { await opts.runPluginScans(); } catch (err: any) { sendJson(res, 500, { error: err?.message || String(err) }); return; }
        const list = opts.getPlugins ? opts.getPlugins() : [];
        sendJson(res, 200, list);
        return;
      }
      if (url.pathname === '/api/agents' && method === 'GET') {
        const list = agents.list();
        const lockList = locks.list();
        const lockByApp: Record<string, { agent: string; lockedAt: number; expiresAt: number }> = {};
        for (const l of lockList) lockByApp[l.app] = { agent: l.agent, lockedAt: l.lockedAt, expiresAt: l.expiresAt };
        sendJson(res, 200, { agents: list, locks: lockByApp, self: agentId === 'unknown' ? null : agentId });
        return;
      }

      if (url.pathname === '/api/self/history' && method === 'GET') {
        const since = parseSinceParam(url.searchParams.get('since'));
        const sinceMs = since.sinceMs ?? 60 * 60 * 1000;
        const sinceTs = since.sinceTs ?? Date.now() - sinceMs;
        const hist = registry.getHistory();
        const rows = hist ? hist.querySelfMetrics({ since: sinceTs, limit: 1440 }) : [];
        sendJson(res, 200, rows);
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

      // Workspace registry — read.
      if (url.pathname === '/api/workspaces' && method === 'GET' && opts.getConfig) {
        const cfg = opts.getConfig();
        const all = registry.list();
        const rows = cfg.searchRoots.map(s => {
          const wsPath = typeof s === 'string' ? s : s.path;
          const label = typeof s === 'string' ? null : (s.label ?? null);
          const apps = all.filter(a => {
            const r2 = a.workspaceRoot;
            return !!r2 && isPathUnder(r2, wsPath);
          });
          return {
            path: wsPath,
            label,
            appCount: apps.length,
            apps: apps.map(a => a.name),
          };
        });
        sendJson(res, 200, rows);
        return;
      }

      if (url.pathname === '/api/workspaces/resolve' && method === 'GET' && opts.getConfig) {
        const cwdParam = url.searchParams.get('cwd');
        if (!cwdParam) { sendJson(res, 400, { error: 'cwd query param required' }); return; }
        const cfg = opts.getConfig();
        const roots = cfg.searchRoots.map(s => typeof s === 'string' ? { path: s, label: null as string | null } : { path: s.path, label: s.label ?? null });
        const match = roots.find(r2 => isPathUnder(cwdParam, r2.path));
        if (!match) {
          sendJson(res, 404, { error: 'no workspace covers cwd', cwd: cwdParam, hint: "register it with 'daimon workspaces add' (or POST /api/workspaces/ensure)" });
          return;
        }
        sendJson(res, 200, { path: match.path, label: match.label, cwd: cwdParam });
        return;
      }

      if (url.pathname === '/api/workspaces/remove' && method === 'POST' && opts.getConfig && opts.patchConfig) {
        if (!requireAuth()) return;
        const body: any = await readJsonBody(req);
        const targetPath = typeof body?.path === 'string' ? body.path : '';
        if (!targetPath) { sendJson(res, 400, { error: 'path is required' }); return; }
        const cfg = opts.getConfig();
        const norm = (s: string | { path: string }) => typeof s === 'string' ? s : s.path;
        const before = cfg.searchRoots.map(norm);
        const nextRoots = cfg.searchRoots.filter(s => norm(s) !== targetPath);
        if (nextRoots.length === before.length) {
          sendJson(res, 404, { error: `not a registered searchRoot: ${targetPath}` });
          return;
        }
        const r = opts.patchConfig({ searchRoots: nextRoots });
        if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
        sendJson(res, 200, { removed: targetPath, removedApps: r.removedApps ?? [] });
        return;
      }

      // Multi-workspace auto-register. CLI calls this once per invocation with its cwd
      // so a daemon spawned in folder A can also serve folder B's apps.
      if (url.pathname === '/api/workspaces/ensure' && method === 'POST' && opts.getConfig && opts.patchConfig) {
        if (!requireAuth()) return;
        const body: any = await readJsonBody(req);
        const targetPath = typeof body?.path === 'string' ? body.path : '';
        const labelOpt = typeof body?.label === 'string' && body.label ? body.label : null;
        if (!targetPath) { sendJson(res, 400, { error: 'path is required' }); return; }
        if (!fs.existsSync(targetPath)) { sendJson(res, 400, { error: `path does not exist: ${targetPath}` }); return; }
        const cfg = opts.getConfig();
        const existingRoots = cfg.searchRoots.map(s => typeof s === 'string' ? s : s.path);
        const covered = existingRoots.some(r => isPathUnder(targetPath, r));
        if (covered) {
          const matched = existingRoots.find(r => isPathUnder(targetPath, r));
          sendJson(res, 200, { added: false, root: matched, reason: 'already covered' });
          return;
        }
        const nextEntry = labelOpt ? { path: targetPath, label: labelOpt } : targetPath;
        const nextRoots = [...cfg.searchRoots, nextEntry];
        const r = opts.patchConfig({ searchRoots: nextRoots });
        if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
        sendJson(res, 200, { added: true, root: targetPath, label: labelOpt, addedApps: r.addedApps ?? [] });
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
        const spaDir = dashboardSpaDir();
        if (spaDir && serveStaticFile(res, path.join(spaDir, 'index.html'))) return;
        res.writeHead(404).end('dashboard not found — run "npm run build:dashboard" in the daimon repo');
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'events' && parts.length === 2) {
        if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
        const sinceMs = parseDuration(url.searchParams.get('since'));
        const app = url.searchParams.get('app') || undefined;
        if (url.searchParams.get('stream') === 'ndjson') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-daimon-version': DAIMON_VERSION });
          const seed = registry.events({ sinceMs, app });
          for (const ev of seed) res.write(JSON.stringify(ev) + '\n');
          // Ring-buffer against slow consumers (M54): cap pending lines at 500,
          // drop oldest on overflow and report the drop count in-stream.
          const buffer: string[] = [];
          let dropped = 0;
          let writable = true;
          const flush = () => {
            while (buffer.length && writable) {
              writable = res.write(buffer.shift()!);
            }
            if (dropped > 0 && buffer.length === 0 && writable) {
              res.write(JSON.stringify({ ts: Date.now(), type: 'stream-overflow', dropped }) + '\n');
              process.stderr.write(`[daimon] event stream: slow client, dropped ${dropped} events\n`);
              dropped = 0;
            }
          };
          const onEvent = (ev: any) => {
            if (app && ev.app !== app) return;
            if (buffer.length >= 500) { dropped++; buffer.shift(); }
            buffer.push(JSON.stringify(ev) + '\n');
            flush();
          };
          registry.on('event', onEvent);
          res.on('drain', () => { writable = true; flush(); });
          const keepalive = setInterval(() => { try { if (writable) writable = res.write('\n'); } catch {} }, 30_000);
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
        // Long-poll: nothing new yet + ?waitMs= → hold the request open until
        // the next matching event or the deadline. Lets MCP subscribe_events
        // block instead of busy-polling.
        const waitMs = Math.min(Math.max(parseInt(url.searchParams.get('waitMs') || '0', 10) || 0, 0), 55_000);
        if (memEvents.length === 0 && waitMs > 0) {
          const ev = await new Promise<any | null>(resolve => {
            const cleanup = (value: any | null) => {
              registry.off('event', onEvent);
              clearTimeout(timer);
              resolve(value);
            };
            const onEvent = (e: any) => { if (!app || e.app === app) cleanup(e); };
            const timer = setTimeout(() => cleanup(null), waitMs);
            registry.on('event', onEvent);
            req.on('close', () => cleanup(null));
          });
          sendJson(res, 200, ev ? [ev] : []);
          return;
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
        if (sub3 === 'timeline') {
          const kindsRaw = url.searchParams.get('kinds');
          const kinds = kindsRaw ? new Set(kindsRaw.split(',').map(s => s.trim()).filter(Boolean)) : undefined;
          const rows = h.queryTimeline({ app, since: sinceMs, kinds, limit: lim ?? 5000 });
          sendJson(res, 200, rows);
          return;
        }
        if (sub3 === 'bundles') {
          sendJson(res, 200, h.queryBundles({ app, since: sinceMs, until: untilMs, limit: lim }));
          return;
        }
        if (sub3 === 'trends') {
          const sinceLabel = (url.searchParams.get('since') || '24h').toLowerCase();
          const windows: Record<string, number> = { '24h': 24 * 3600 * 1000, '7d': 7 * 86400 * 1000, '30d': 30 * 86400 * 1000 };
          const sinceMsTrend = windows[sinceLabel] ?? windows['24h'];
          const bucketMs = sinceLabel === '24h' ? 3600 * 1000 : 86400 * 1000;
          // `metrics=compile,bundle,errors,restarts` (v0.9) returns all metrics
          // in one round-trip, sharing the queryEvents() scan between errors
          // and restarts. `metric=<single>` continues to work for back-compat.
          const metricsParam = url.searchParams.get('metrics');
          if (metricsParam) {
            const want = metricsParam.split(',').map(s => s.trim()).filter(Boolean) as ('compile' | 'bundle' | 'errors' | 'restarts')[];
            const valid: ('compile' | 'bundle' | 'errors' | 'restarts')[] = ['compile', 'bundle', 'errors', 'restarts'];
            const filtered = want.filter(m => valid.includes(m));
            if (!filtered.length) { sendJson(res, 400, { error: 'metrics must include at least one of compile|bundle|errors|restarts' }); return; }
            const out: Record<string, { points: { t: number; v: number; v2?: number }[]; count: number }> = {};
            for (const m of filtered) {
              const r = h.trends({ app, metric: m, sinceMs: sinceMsTrend, bucketMs });
              out[m] = { points: r.points, count: r.count };
            }
            sendJson(res, 200, { app: app ?? null, since: sinceLabel, metrics: out, _meta: { aggregation: sinceLabel === '24h' ? 'hour' : 'day' } });
            return;
          }
          const metric = (url.searchParams.get('metric') || 'compile') as 'compile' | 'bundle' | 'errors' | 'restarts';
          if (!['compile', 'bundle', 'errors', 'restarts'].includes(metric)) {
            sendJson(res, 400, { error: 'metric must be compile|bundle|errors|restarts' });
            return;
          }
          const { points, count } = h.trends({ app, metric, sinceMs: sinceMsTrend, bucketMs });
          sendJson(res, 200, { app: app ?? null, metric, since: sinceLabel, points, _meta: { aggregation: sinceLabel === '24h' ? 'hour' : 'day', count } });
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
        if (!list) { sendJson(res, 404, { error: 'unknown profile', hint: 'profiles are named sets in daimon.config.json profiles; GET /api/profiles/suggest lists candidates' }); return; }
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

      if (parts[0] === 'api' && parts[1] === 'profiles' && parts[2] === 'suggest' && method === 'GET') {
        const cfg = opts.getConfig?.();
        const h = registry.getHistory();
        if (!h) { sendJson(res, 200, { suggestions: [], reason: 'history disabled' }); return; }
        const sinceMs = parseDuration(url.searchParams.get('since')) ?? 30 * 24 * 60 * 60_000;
        const minOcc = Number(url.searchParams.get('minOccurrences') ?? 5) || 5;
        const rows = h.queryEvents({ since: Date.now() - sinceMs, type: 'status', limit: 20_000 });
        const { suggestProfiles } = await import('./profiles.js');
        const suggestions = suggestProfiles(rows.map(r => ({ ts: r.ts, app: r.app, to_state: r.to_state, type: r.type })), {
          minOccurrences: minOcc,
          existingProfiles: cfg?.profiles ?? {},
        });
        sendJson(res, 200, { suggestions, windowDays: Math.round(sinceMs / (24 * 60 * 60_000)) });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'orchestrate' && method === 'POST') {
        const cfg = opts.getConfig?.();
        if (!cfg) { sendJson(res, 500, { error: 'no config loaded' }); return; }
        const profile = url.searchParams.get('profile');
        if (!profile) { sendJson(res, 400, { error: 'profile query param required' }); return; }
        const goalRaw = (url.searchParams.get('goal') || 'healthy').toLowerCase();
        if (!['serving', 'healthy', 'stable'].includes(goalRaw)) { sendJson(res, 400, { error: 'goal must be serving|healthy|stable' }); return; }
        const timeoutMsRaw = url.searchParams.get('timeoutMs') || url.searchParams.get('timeout');
        let timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 300_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 300_000;
        timeoutMs = Math.min(timeoutMs, 1_200_000);
        const dryRun = url.searchParams.get('dryRun') === 'true' || url.searchParams.get('dry-run') === 'true';
        const budgetRaw = url.searchParams.get('budget');
        const budgetTokens = budgetRaw && Number.isFinite(Number(budgetRaw)) ? Number(budgetRaw) : undefined;
        const { orchestrateProfile } = await import('./orchestrate.js');
        const r = await orchestrateProfile(registry, cfg, { profile, goal: goalRaw as any, timeoutMs, dryRun, budgetTokens });
        if ((r as any).error) { sendJson(res, 404, r); return; }
        sendJson(res, 200, r);
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
        const polyglot = apps.filter(a => a.workspaceType === 'polyglot');
        const annotatedApps = apps.map(a => ({ name: a.name, workspaceType: a.workspaceType, serverProfile: a.serverProfile ?? a.workspaceType, workspaceRoot: a.workspaceRoot }));
        const polyglotHint = polyglot.length > 0
          ? ` · ${polyglot.length} polyglot app${polyglot.length === 1 ? '' : 's'} found (${[...new Set(polyglot.map(p => p.serverProfile))].join(', ')})`
          : '';
        sendJson(res, 200, {
          searchRoots: roots,
          scanned: stats.scanned,
          rejected: stats.rejected,
          warnings,
          appsFound: apps.length,
          apps: annotatedApps,
          suggestion: apps.length === 0
            ? (roots.length === 0
              ? "no searchRoots configured. Run 'daimon init --auto' from a workspace folder."
              : "discovery returned no apps. Check that searchRoots contain a framework marker (nx.json / angular.json / next.config.* / vite.config.* / manage.py / *.csproj / pubspec.yaml / a package.json dev script, …) — run 'daimon frameworks' for the full registry.")
            : `${apps.length} apps discovered${polyglotHint}`,
        });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'frameworks' && method === 'GET') {
        const cfg = opts.getConfig?.();
        const { allProfiles, profileBadge, profileTone } = await import('./frameworks.js');
        const { discoverApps } = await import('./discovery.js');
        const stats = { scanned: 0, rejected: {} as Record<string, number>, profiles: {} as Record<string, number> };
        const apps = cfg ? discoverApps(cfg, { stats }) : [];
        const profiles = allProfiles(cfg?.frameworks).map(p => ({
          id: p.id,
          family: p.family,
          builtin: p.builtin,
          command: p.command,
          workspace: p.workspace ?? null,
          errorParser: p.errorParser ?? null,
          healthProbe: p.healthProbe ?? null,
          readiness: p.readiness?.pattern ?? null,
          url: p.url?.pattern ?? null,
          badge: profileBadge(p),
          tone: profileTone(p),
          matches: stats.profiles[p.id] ?? 0,
          apps: apps.filter(a => (a.serverProfile ?? a.workspaceType) === p.id).map(a => a.name),
        }));
        sendJson(res, 200, {
          profiles,
          builtinCount: profiles.filter(p => p.builtin).length,
          customCount: profiles.filter(p => !p.builtin).length,
          stats: { scanned: stats.scanned, rejected: stats.rejected },
        });
        return;
      }

      // Global errors across all apps (M72). ?group=fingerprint folds entries
      // with the same source location / normalized message into groups with
      // count, first/last-seen and affected apps.
      if (parts[0] === 'api' && parts[1] === 'errors' && !parts[2] && method === 'GET') {
        const levelFilter = (url.searchParams.get('level') || 'error').toLowerCase();
        const matchesLevel = (e: ErrorEntry) => {
          const lvl = e.level ?? 'error';
          if (levelFilter === 'all') return true;
          if (levelFilter === 'warning') return lvl === 'warning';
          if (levelFilter === 'lint') return lvl === 'lint';
          return lvl === 'error';
        };
        const perApp = registry.list().map(s => ({
          app: s.name,
          errors: (registry.errors(s.name) ?? []).filter(matchesLevel),
        }));
        if ((url.searchParams.get('group') || '') === 'fingerprint') {
          const { groupErrors } = await import('./errorGroups.js');
          sendJson(res, 200, { groups: groupErrors(perApp) });
          return;
        }
        sendJson(res, 200, perApp.flatMap(({ app, errors }) => errors.map(e => ({ app, ...e }))));
        return;
      }

      // `daimon context <app>` (M78): the agent context pack. Pure composition
      // of existing queries — no new state. ?budget=<chars> drops sections
      // lowest-priority-first (compile → agents → crashes → tests → errors;
      // status is never dropped) and reports what fell in truncated[].
      if (parts[0] === 'api' && parts[1] === 'context' && parts[2] && method === 'GET') {
        const ctxName0 = decodeURIComponent(parts[2]);
        const resolvedCtx = registry.resolveByCwd(ctxName0, url.searchParams.get('cwd') || null);
        if (resolvedCtx.kind === 'collision') {
          sendJson(res, 412, { error: 'name-collision', candidates: resolvedCtx.candidates });
          return;
        }
        const ctxName = resolvedCtx.kind === 'unique' && resolvedCtx.key ? resolvedCtx.key : ctxName0;
        const s = registry.summary(ctxName);
        if (!s) { sendJson(res, 404, UNKNOWN_APP); return; }
        const appRow = registry.getApp(ctxName);
        const h = registry.getHistory();
        const dayAgo = Date.now() - 24 * 3600_000;

        const { groupErrors } = await import('./errorGroups.js');
        const recentErrors = (registry.errors(ctxName) ?? []).filter(e => e.lastSeen >= dayAgo);
        const errors = groupErrors([{ app: ctxName, errors: recentErrors }]).slice(0, 5)
          .map(g => ({ fingerprint: g.fingerprint, message: g.message.slice(0, 300), count: g.count, lastSeen: g.lastSeen, parsed: g.parsed ?? null }));

        const lastRun = h?.queryTestRuns({ app: ctxName, limit: 1 })[0] ?? null;
        const tests = lastRun ? {
          ...lastRun,
          failures: h!.queryTestFailures([lastRun.id]).map(f => ({ suite: f.suite, test: f.test, file: f.file, line: f.line, message: f.message?.slice(0, 200) ?? null, fingerprint: f.fingerprint })),
        } : null;

        const crash = h?.queryCrashes({ app: ctxName, limit: 1 })[0] ?? null;
        const crashes = crash ? {
          ts: crash.ts, exitCode: crash.exitCode, signal: crash.signal, uptimeMs: crash.uptimeMs,
          gitHead: crash.gitHead, lastLines: (crash.lastLines ?? '').split('\n').filter(Boolean).slice(-15),
        } : null;

        const hist = h ? h.summary(ctxName) : null;
        const regressionEvents = (h?.queryEvents({ app: ctxName, since: Date.now() - 7 * 86400_000, type: 'regression-detected', limit: 5 }) ?? [])
          .map(r => { try { return { ts: r.ts, ...JSON.parse(r.message ?? '{}') }; } catch { return { ts: r.ts }; } });
        const compile = {
          p50: hist?.compileP50 ?? null,
          p95: hist?.compileP95 ?? null,
          lastCompileMs: s.lastCompileMs,
          lastRegression: regressionEvents[0] ?? null,
        };

        const { suspectCommitForDir } = await import('./regressions.js');
        const head = await suspectCommitForDir(appRow?.workspaceRoot ?? null);
        const suspectCommits = [...new Set([
          ...regressionEvents.map((r: any) => r.suspectCommit).filter(Boolean),
          ...(head ? [head] : []),
        ])].slice(0, 5);

        const lock = locks.current(ctxName);
        const agentsSection = {
          lock: lock ? { agent: lock.agent, expiresAt: lock.expiresAt } : null,
          recent: locks.recentInteractions(ctxName, 3),
          active: agents.list().map(a => ({ id: a.id, lastSeen: a.lastSeen })).slice(0, 5),
        };

        const out: Record<string, any> = {
          app: ctxName,
          status: {
            ...compactStatus(s),
            framework: s.serverProfile ?? null,
            workspaceRoot: appRow?.workspaceRoot ?? null,
            stale: s.stale,
            restartAttempts: s.restartAttempts,
          },
          errors,
          tests,
          crashes,
          suspectCommits,
          agents: agentsSection,
          compile,
          truncated: [] as string[],
        };
        const budgetRaw = url.searchParams.get('budget');
        const budget = budgetRaw ? Math.max(256, Number(budgetRaw) | 0) : null;
        if (budget) {
          const dropOrder = ['compile', 'agents', 'crashes', 'tests', 'errors'];
          for (const section of dropOrder) {
            if (JSON.stringify(out).length <= budget) break;
            delete out[section];
            out.truncated.push(section);
          }
        }
        sendJson(res, 200, out);
        return;
      }

      // `daimon report` (M83): the digest — composition over existing queries,
      // every section independently degradable. ?since=24h|7d|<ms>&app=&workspace=&md=1
      if (parts[0] === 'api' && parts[1] === 'report' && !parts[2] && method === 'GET') {
        const sinceP = parseSinceParam(url.searchParams.get('since'));
        const sinceTs = sinceP.sinceTs ?? (Date.now() - (sinceP.sinceMs ?? 24 * 3600_000));
        const { buildReport, renderReportMd } = await import('./report.js');
        const report = buildReport({
          registry,
          history: registry.getHistory(),
          agents: agents.list().map(a => ({ id: a.id, lastSeen: a.lastSeen })),
          flakyThreshold: opts.getConfig?.().tests?.flakyThreshold ?? 3,
        }, {
          since: sinceTs,
          app: url.searchParams.get('app') || undefined,
          workspace: url.searchParams.get('workspace') || undefined,
        });
        if (url.searchParams.get('md') === '1') {
          const md = renderReportMd(report);
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-length': Buffer.byteLength(md) });
          res.end(md);
          return;
        }
        sendJson(res, 200, report);
        return;
      }

      // Full-text search (M77): everything daimon has seen, greppable.
      // ?q=&app=&since=&kind=logs|errors|events&limit=. Falls back to LIKE
      // (fallback:true) when FTS is unavailable — never errors the daemon.
      if (parts[0] === 'api' && parts[1] === 'search' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        if (!q.trim()) { sendJson(res, 400, { error: 'q query param required' }); return; }
        const h = registry.getHistory();
        if (!h) { sendJson(res, 200, { hits: [], fallback: false, note: 'history disabled' }); return; }
        const kindRaw = (url.searchParams.get('kind') || '').toLowerCase();
        if (kindRaw && !['logs', 'errors', 'events'].includes(kindRaw)) {
          sendJson(res, 400, { error: 'kind must be logs|errors|events' });
          return;
        }
        const sinceP = parseSinceParam(url.searchParams.get('since'));
        const since = sinceP.sinceTs ?? (sinceP.sinceMs != null ? Date.now() - sinceP.sinceMs : undefined);
        const limitRaw = Number(url.searchParams.get('limit') || 50);
        const r = h.search({
          q,
          app: url.searchParams.get('app') || undefined,
          since,
          kind: (kindRaw || undefined) as any,
          limit: Number.isFinite(limitRaw) ? limitRaw : 50,
        });
        sendJson(res, 200, r);
        return;
      }

      // `daimon why <app>` (M76): one-shot composition of everything relevant
      // to "why is this app broken" — status, last crash, grouped errors,
      // regressions, storm state, suspect commit, matching doctor findings.
      // Env awareness (M82): read-only, redacted. Responses carry file names,
      // key NAMES, and timestamps — never values, never hashes.
      if (parts[0] === 'api' && parts[1] === 'env' && parts[2] && method === 'GET') {
        const envName0 = decodeURIComponent(parts[2]);
        const resolvedEnv = registry.resolveByCwd(envName0, url.searchParams.get('cwd') || null);
        if (resolvedEnv.kind === 'collision') {
          sendJson(res, 412, { error: 'name-collision', candidates: resolvedEnv.candidates });
          return;
        }
        const envName = resolvedEnv.kind === 'unique' && resolvedEnv.key ? resolvedEnv.key : envName0;
        const appRow = registry.getApp(envName);
        if (!appRow) { sendJson(res, 404, UNKNOWN_APP); return; }
        const h = registry.getHistory();
        const stripHashes = (snapJson: string): any => {
          try {
            const snap = JSON.parse(snapJson);
            return { files: (snap.files ?? []).map((f: any) => ({ file: f.file, exists: f.exists, mtime: f.mtime, size: f.size, keyNames: f.keyNames ?? [] })) };
          } catch { return null; }
        };
        if (parts[3] === 'diff') {
          const snaps = h?.queryEnvSnapshots({ app: envName, limit: 100 }) ?? [];
          const fromParam = url.searchParams.get('from');
          const toParam = url.searchParams.get('to');
          const pick = (atOrBefore: number | null, skipId?: number) =>
            snaps.find(s => (atOrBefore == null || s.ts <= atOrBefore) && s.id !== skipId) ?? null;
          const toRow = pick(toParam ? Number(toParam) : null);
          const fromRow = toRow
            ? (fromParam ? pick(Number(fromParam)) : snaps.find(s => s.ts <= toRow.ts && s.id !== toRow.id) ?? null)
            : null;
          if (!toRow || !fromRow) {
            sendJson(res, 200, { app: envName, note: 'need at least two snapshots (start the app to record one per spawn)', diff: null });
            return;
          }
          let d;
          try { d = diffEnvSnapshots(JSON.parse(fromRow.json), JSON.parse(toRow.json)); }
          catch { sendJson(res, 500, { error: 'snapshot parse failed' }); return; }
          sendJson(res, 200, { app: envName, from: fromRow.ts, to: toRow.ts, ...d });
          return;
        }
        const candidates = (registry.envCandidates(envName) ?? []).map(f => ({
          file: f,
          exists: fs.existsSync(resolveEnvFilePath(appRow.workspaceRoot, f)),
        }));
        const latest = h?.queryEnvSnapshots({ app: envName, limit: 1 })[0] ?? null;
        sendJson(res, 200, {
          app: envName,
          candidates,
          // Legacy field (pre-v0.13 `daimon env`): the file actively injected.
          active: registry.getState(envName)?.activeEnvFile ?? null,
          snapshot: latest ? { ts: latest.ts, ageMs: Date.now() - latest.ts, ...stripHashes(latest.json) } : null,
        });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'why' && parts[2] && method === 'GET') {
        const whyName0 = decodeURIComponent(parts[2]);
        const resolvedWhy = registry.resolveByCwd(whyName0, url.searchParams.get('cwd') || null);
        if (resolvedWhy.kind === 'collision') {
          sendJson(res, 412, { error: 'name-collision', candidates: resolvedWhy.candidates });
          return;
        }
        const whyName = resolvedWhy.kind === 'unique' && resolvedWhy.key ? resolvedWhy.key : whyName0;
        const s = registry.summary(whyName);
        if (!s) { sendJson(res, 404, UNKNOWN_APP); return; }
        const appRow = registry.getApp(whyName);
        const h = registry.getHistory();
        const dayAgo = Date.now() - 24 * 3600_000;

        const crash = h?.queryCrashes({ app: whyName, limit: 1 })[0] ?? null;
        const lastCrash = crash ? {
          ts: crash.ts,
          exitCode: crash.exitCode,
          signal: crash.signal,
          uptimeMs: crash.uptimeMs,
          gitHead: crash.gitHead,
          lastLines: (crash.lastLines ?? '').split('\n').filter(Boolean),
        } : null;

        const { groupErrors } = await import('./errorGroups.js');
        const recentErrors = (registry.errors(whyName) ?? []).filter(e => e.lastSeen >= dayAgo);
        const errorGroups = groupErrors([{ app: whyName, errors: recentErrors }]).slice(0, 5)
          .map(g => ({ fingerprint: g.fingerprint, message: g.message, count: g.count, lastSeen: g.lastSeen, parsed: g.parsed ?? null }));

        const regressions = (h?.queryEvents({ app: whyName, since: Date.now() - 7 * 86400_000, type: 'regression-detected', limit: 10 }) ?? [])
          .map(r => { try { return { ts: r.ts, ...JSON.parse(r.message ?? '{}') }; } catch { return { ts: r.ts, message: r.message }; } });

        const storm = registry.stormState(whyName);

        // envChanged (M82): current env fingerprint vs the last snapshot at or
        // before the most recent healthy signal. Names only, never values.
        let envChanged: any = null;
        try {
          const snaps = h?.queryEnvSnapshots({ app: whyName, limit: 50 }) ?? [];
          if (snaps.length >= 2) {
            const healthyEv = (h?.queryEvents({ app: whyName, type: 'health', limit: 200 }) ?? []).find(ev => ev.to_state === 'healthy');
            const baselineRow = (healthyEv ? snaps.find(s => s.ts <= healthyEv.ts && s.id !== snaps[0].id) : null) ?? snaps[1];
            const d = diffEnvSnapshots(JSON.parse(baselineRow.json), JSON.parse(snaps[0].json));
            if (d.changed) envChanged = { since: baselineRow.ts, ...d };
          }
        } catch {}

        const { suspectCommitForDir } = await import('./regressions.js');
        const suspectCommit = await suspectCommitForDir(appRow?.workspaceRoot ?? null);

        // Doctor findings scoped to this app: per-app rules (restart-storm,
        // smart-restart-tune), plus hygiene findings covering its workspace.
        let doctorFindings: { name: string; ok: boolean; detail?: string }[] = [];
        try {
          const cfg = opts.getConfig?.();
          if (cfg) {
            const { runDoctor } = await import('./doctor.js');
            const allApps = registry.names().map(n => registry.getApp(n)!).filter(Boolean);
            const result = await runDoctor(cfg, allApps);
            const root = (appRow?.workspaceRoot ?? '').toLowerCase();
            doctorFindings = result.checks.filter(c =>
              c.name.includes(whyName)
              || (root && c.name.toLowerCase().includes(root))
              || (c.name.startsWith('searchroot-hygiene') && root && isPathUnder(appRow!.workspaceRoot, c.name.slice('searchroot-hygiene: '.length))),
            );
          }
        } catch {}

        sendJson(res, 200, {
          app: whyName,
          status: compactStatus(s),
          lastCrash,
          errorGroups,
          regressions,
          storm,
          envChanged,
          suspectCommit,
          doctor: doctorFindings,
        });
        return;
      }

      // Flaky tests (M75): query-derived from run history — a fingerprint that
      // flipped pass↔fail >= tests.flakyThreshold times at the same gitHead.
      if (parts[0] === 'api' && parts[1] === 'tests' && parts[2] === 'flaky' && method === 'GET') {
        const h = registry.getHistory();
        if (!h) { sendJson(res, 200, { flaky: [] }); return; }
        const app = url.searchParams.get('app') || undefined;
        const { findFlakyTests } = await import('./testRunners.js');
        const threshold = opts.getConfig?.().tests?.flakyThreshold ?? 3;
        const runs = h.queryTestRuns({ app, limit: 200 });
        const heads = [...new Set(runs.map(r => r.gitHead).filter((g): g is string => !!g))];
        const flaky = heads.flatMap(head => findFlakyTests(runs, ids => h.queryTestFailures(ids), head, threshold));
        sendJson(res, 200, { flaky, threshold });
        return;
      }

      // Test-run history (M74). ?app=&limit=&since=; failures attached per run.
      if (parts[0] === 'api' && parts[1] === 'tests' && !parts[2] && method === 'GET') {
        const h = registry.getHistory();
        if (!h) { sendJson(res, 200, { runs: [] }); return; }
        const app = url.searchParams.get('app') || undefined;
        const limitRaw = Number(url.searchParams.get('limit') || 50);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50;
        const sinceP = parseSinceParam(url.searchParams.get('since'));
        const since = sinceP.sinceTs ?? (sinceP.sinceMs != null ? Date.now() - sinceP.sinceMs : undefined);
        const runs = h.queryTestRuns({ app, since, limit });
        const failures = h.queryTestFailures(runs.map(r => r.id));
        const byRun = new Map<number, any[]>();
        for (const f of failures) {
          const arr = byRun.get(f.runId) ?? [];
          arr.push({ suite: f.suite, test: f.test, file: f.file, line: f.line, message: f.message, fingerprint: f.fingerprint });
          byRun.set(f.runId, arr);
        }
        sendJson(res, 200, { runs: runs.map(r => ({ ...r, failures: byRun.get(r.id) ?? [] })) });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'doctor' && parts[2] === 'auto-fix' && method === 'POST') {
        if (!requireAuth()) return;
        const body: any = await readJsonBody(req);
        const { runAutoFix, ALL_AUTO_FIX } = await import('./autoFix.js');
        const cfg = opts.getConfig?.();
        const defaults = (cfg?.doctor?.autoFix?.permitted as any) ?? ALL_AUTO_FIX;
        const permitted = Array.isArray(body.permitted) && body.permitted.length ? body.permitted : defaults;
        try {
          const r = await runAutoFix({ permitted, dryRun: !!body.dryRun });
          sendJson(res, 200, r);
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? String(err) });
        }
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
        const out: any = { ts: Date.now(), version: DAIMON_VERSION, totals, byStatus, needsAttention, recentlyChanged };
        if (totals.apps === 0) {
          out._meta = { suggestion: "no apps registered. run 'daimon doctor' for recommended next step, or 'daimon init --auto' from a workspace folder." };
        }
        const budgetRaw = url.searchParams.get('budget');
        const budgetTokens = budgetRaw ? Math.max(64, Number(budgetRaw) | 0) : null;
        if (budgetTokens) {
          // Token estimate: ~4 chars per token. Drop overflow rows from needsAttention then recentlyChanged.
          const capChars = budgetTokens * 4;
          let omittedNa = 0;
          let omittedRc = 0;
          while (JSON.stringify(out).length > capChars && (out.needsAttention.length || out.recentlyChanged.length)) {
            if (out.needsAttention.length > 1) { out.needsAttention.pop(); omittedNa++; }
            else if (out.recentlyChanged.length) { out.recentlyChanged.pop(); omittedRc++; }
            else if (out.needsAttention.length === 1) { out.needsAttention.pop(); omittedNa++; }
            else break;
          }
          if (omittedNa || omittedRc) {
            out._meta = { ...(out._meta ?? {}), budget: budgetTokens, omitted: { needsAttention: omittedNa, recentlyChanged: omittedRc } };
          } else {
            out._meta = { ...(out._meta ?? {}), budget: budgetTokens };
          }
        }
        sendJson(res, 200, out);
        return;
      }

      if (parts[0] !== 'api' || parts[1] !== 'apps') {
        // Static-asset fallthrough for the Angular SPA: serve hashed JS/CSS/font
        // files from dist/dashboard/(browser/) and SPA-fallback unknown extension-
        // less paths to index.html. Keeps everything before /api/ working.
        if (method === 'GET' && !url.pathname.startsWith('/metrics')) {
          const spaDir = dashboardSpaDir();
          if (spaDir) {
            const rel = url.pathname.replace(/^\/dashboard\//, '/').replace(/^\//, '');
            if (rel) {
              const abs = path.resolve(spaDir, rel);
              // Require a separator boundary so a sibling dir whose name merely
              // starts with spaDir's basename can't be served.
              if ((abs === spaDir || abs.startsWith(spaDir + path.sep)) && serveStaticFile(res, abs)) return;
            }
            if (!path.extname(rel || '')) {
              if (serveStaticFile(res, path.join(spaDir, 'index.html'))) return;
            }
          }
        }
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      if (parts.length === 2) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const fmt = resolveFormat(url, opts.getConfig);
        let all = registry.list();
        // Optional ?cwd= filter: keep only apps whose workspaceRoot is under the given path.
        // CLI passes its process.cwd() so two agents on the same daemon see distinct app sets.
        const cwdRaw = url.searchParams.get('cwd');
        const cwd = cwdRaw && cwdRaw.length > 0 ? cwdRaw : null;
        if (cwd) {
          all = all.filter(s => {
            const app = registry.getApp(s.name);
            if (!app) return false;
            return isPathUnder(app.workspaceRoot, cwd) || isPathUnder(cwd, app.workspaceRoot);
          });
        }
        // Server-side ?tag= / ?workspace= filters (M87 last-call fix). The CLI
        // used to filter client-side on fields only the FULL shape carries, so
        // `daimon list --tag x` silently switched to the verbose shape and
        // `--tag x --compact` always returned []. Filtering here, where the
        // full summaries live, keeps the output shape independent of filters.
        const tagFilters = url.searchParams.getAll('tag').filter(Boolean);
        if (tagFilters.length) all = all.filter(s => tagFilters.every(t => (s.tags ?? []).includes(t)));
        const wsFilter = url.searchParams.get('workspace');
        if (wsFilter) all = all.filter(s => s.workspaceLabel === wsFilter);
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
              ...(cwd ? { cwdScope: cwd } : {}),
              suggestion: rows.length === 0
                ? (roots.length === 0
                  ? "no searchRoots configured. Run 'daimon init --auto' from a workspace folder to add the current cwd."
                  : cwd
                    ? `no apps under cwd '${cwd}'. Run 'daimon list --all' to see apps from other workspaces, or 'daimon init --auto' to register this dir.`
                    : "discovery returned no apps. Check that searchRoots contain a framework marker (run 'daimon frameworks' for the registry), then run 'daimon doctor'.")
                : 'apps discovered; _meta is informational.',
            };
          }
          sendJson(res, 200, { apps: rows, _meta: meta });
          return;
        }
        sendJson(res, 200, rows);
        return;
      }

      const requestedName = decodeURIComponent(parts[2]);
      const sub = parts[3];
      const sub2 = parts[4];

      // Resolve `<name>` to a single internal key. Two workspaces can register
      // apps with the same baseName ("editor"); the CLI sends `?cwd=` to pick
      // one. Without `?cwd=`, a single-match name resolves directly; a
      // collision returns 412 with the candidate list.
      const cwdQ = url.searchParams.get('cwd') || null;
      const resolved = registry.resolveByCwd(requestedName, cwdQ);
      let name = requestedName;
      if (resolved.kind === 'unique' && resolved.key) {
        name = resolved.key;
      } else if (resolved.kind === 'none' && cwdQ) {
        sendJson(res, 404, {
          error: `no app named '${requestedName}' under cwd '${cwdQ}'`,
          hint: 'use --all (or omit cwd) to broaden the search, or --workspace <label> to target a specific workspace',
        });
        return;
      } else if (resolved.kind === 'collision') {
        sendJson(res, 412, {
          error: 'name-collision',
          candidates: resolved.candidates,
          hint: cwdQ
            ? 'multiple apps under that cwd share this name — use --workspace <label> to disambiguate'
            : 'multiple workspaces share this app name — pass --cwd or --workspace <label>',
        });
        return;
      }
      // resolved.kind === 'none' && !cwdQ falls through; subsequent handlers
      // 404 individually so legacy endpoints (no cwd) keep the same error shape.

      // Per-app soft lock: an agent that just called start/stop/restart/ensure/
      // try-fix owns the app for 30s. A different agent gets 409
      // locked-by-other-agent unless `?steal=1` is passed. The original agent
      // can re-call freely. Defined here (before the per-verb handlers) so every
      // state-changing verb — including ensure and try-fix — serialises through
      // the same gate.
      const tryLock = (action: string): boolean => {
        // Validate the app before locking — otherwise 409s (and interaction
        // history) can materialize for app names that don't exist.
        if (!registry.summary(name)) { sendJson(res, 404, UNKNOWN_APP); return false; }
        const stealQ = url.searchParams.get('steal');
        const steal = stealQ === '1' || stealQ === 'true';
        if (steal) { locks.steal(name, agentId, action); return true; }
        const blocker = locks.acquire(name, agentId, action);
        if (blocker) {
          sendJson(res, 409, {
            error: 'locked-by-other-agent',
            agent: blocker.agent,
            lockedAt: blocker.lockedAt,
            expiresAt: blocker.expiresAt,
            hint: 'pass ?steal=1 to override, or wait for the lock to expire',
          });
          return false;
        }
        return true;
      };

      if (!sub) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const s = registry.summary(name);
        if (!s) {
          sendJson(res, 404, UNKNOWN_APP);
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

      // Optional ?level= filter. Default 'error' preserves pre-warnings CLI/MCP behavior.
      // 'warning' returns warnings only; 'lint' returns lint findings only; 'all' returns everything.
      const levelFilter = (url.searchParams.get('level') || 'error').toLowerCase();
      const matchesLevel = (e: ErrorEntry) => {
        const lvl = e.level ?? 'error';
        if (levelFilter === 'all') return true;
        if (levelFilter === 'warning') return lvl === 'warning';
        if (levelFilter === 'lint') return lvl === 'lint';
        return lvl === 'error';
      };

      if (sub === 'errors' && sub2 === 'since-last' && method === 'GET') {
        const client = url.searchParams.get('client') || 'default';
        const cursor = cursors.getErrorCursor(client, name);
        const errsAll = registry.errorsSince(name, cursor);
        if (errsAll == null) { sendJson(res, 404, UNKNOWN_APP); return; }
        const errs = errsAll.filter(matchesLevel);
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
          const errsAll = registry.errorsSince(name, cutoff);
          if (errsAll == null) { sendJson(res, 404, UNKNOWN_APP); return; }
          const errs = errsAll.filter(matchesLevel);
          sendJson(res, 200, fmt === 'full' ? errs : errs.map(compactError));
          return;
        }
        const errsAll = registry.errors(name);
        if (errsAll == null) { sendJson(res, 404, UNKNOWN_APP); return; }
        const errs = errsAll.filter(matchesLevel);
        sendJson(res, 200, fmt === 'full' ? errs : errs.map(compactError));
        return;
      }

      if (sub === 'logs' && parts[4] === 'stream' && method === 'GET') {
        if (!registry.summary(name)) { sendJson(res, 404, UNKNOWN_APP); return; }
        // ?grep= (M79): server-side regex filter on the live tail. Length-
        // capped and compiled case-insensitively, like custom-profile patterns.
        const grepRaw = url.searchParams.get('grep');
        let grepRx: RegExp | null = null;
        if (grepRaw) {
          if (grepRaw.length > 512) { sendJson(res, 400, { error: 'grep pattern too long (max 512 chars)' }); return; }
          try { grepRx = new RegExp(grepRaw, 'i'); }
          catch (e: any) { sendJson(res, 400, { error: `invalid grep regex: ${e?.message || e}` }); return; }
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-daimon-version': DAIMON_VERSION,
        });
        const initial = (registry.logs(name, { tail: 50 }) ?? []).filter(l => !grepRx || grepRx.test(l));
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
          if (dropped > 0 && buffer.length === 0) {
            // Tell the consumer (and the daemon log) what overflowed instead
            // of silently losing lines.
            res.write(`data: ${JSON.stringify({ ts: Date.now(), dropped })}\n\n`);
            process.stderr.write(`[daimon] log stream ${name}: slow client, dropped ${dropped} lines\n`);
            dropped = 0;
          }
        };
        const onLog = (ev: { name: string; ts: number; line: string }) => {
          if (ev.name !== name) return;
          if (grepRx && !grepRx.test(ev.line)) return;
          if (buffer.length >= 200) { dropped++; buffer.shift(); }
          buffer.push(`data: ${JSON.stringify({ ts: ev.ts, line: ev.line })}\n\n`);
          flush();
        };
        registry.on('log', onLog);
        res.on('drain', flush);
        const keepalive = setInterval(() => res.write(': ping\n\n'), 30_000);
        req.on('close', () => { registry.off('log', onLog); clearInterval(keepalive); });
        return;
      }

      if (sub === 'logs' && method === 'GET') {
        const tail = url.searchParams.get('tail');
        const since = url.searchParams.get('since');
        let lines = registry.logs(name, {
          tail: tail ? Number(tail) : undefined,
          sinceMs: parseDuration(since),
        });
        if (lines == null) { sendJson(res, 404, UNKNOWN_APP); return; }
        const grepRaw = url.searchParams.get('grep');
        if (grepRaw) {
          if (grepRaw.length > 512) { sendJson(res, 400, { error: 'grep pattern too long (max 512 chars)' }); return; }
          try {
            const rx = new RegExp(grepRaw, 'i');
            lines = lines.filter(l => rx.test(l));
          } catch (e: any) {
            sendJson(res, 400, { error: `invalid grep regex: ${e?.message || e}` });
            return;
          }
        }
        sendJson(res, 200, { lines });
        return;
      }

      if (sub === 'focus' && method === 'POST') {
        const s0 = registry.summary(name);
        if (!s0) { sendJson(res, 404, UNKNOWN_APP); return; }
        const untilRaw = (url.searchParams.get('until') || 'healthy').toLowerCase();
        if (!['serving', 'healthy', 'stable'].includes(untilRaw)) {
          sendJson(res, 400, { error: 'until must be one of serving|healthy|stable' });
          return;
        }
        const timeoutMsRaw = url.searchParams.get('timeoutMs') || url.searchParams.get('timeout');
        let timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 180_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 180_000;
        timeoutMs = Math.min(timeoutMs, 600_000);
        const stableMsRaw = url.searchParams.get('stableMs');
        const stableMs = stableMsRaw && Number.isFinite(Number(stableMsRaw)) ? Math.max(1000, Number(stableMsRaw)) : 5000;
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-daimon-version': DAIMON_VERSION,
        });
        const write = (obj: any) => {
          try { res.write(JSON.stringify(obj) + '\n'); } catch {}
        };
        write({ kind: 'subscribed', app: name, until: untilRaw, ts: Date.now(), state: compactStatus(s0) });
        const start = Date.now();
        let lastSignalAt = Date.now();
        let finished = false;
        const finish = (reason: 'reached' | 'timeout' | 'closed') => {
          if (finished) return;
          finished = true;
          registry.off('event', onEvent);
          clearInterval(stableTimer);
          clearInterval(keepalive);
          clearTimeout(deadline);
          const sFinal = registry.summary(name);
          write({ kind: 'done', reason, ts: Date.now(), state: sFinal ? compactStatus(sFinal) : null, waitedMs: Date.now() - start });
          try { res.end(); } catch {}
        };
        const reachedTarget = (): boolean => {
          const sNow = registry.summary(name);
          if (!sNow) return false;
          if (untilRaw === 'serving') return sNow.status === 'serving';
          if (untilRaw === 'healthy') return sNow.status === 'serving' && sNow.health === 'healthy';
          if (untilRaw === 'stable') {
            const idle = Date.now() - lastSignalAt;
            return sNow.status === 'serving' && sNow.health === 'healthy' && idle >= stableMs;
          }
          return false;
        };
        const onEvent = (ev: { app: string; type: string; from?: string; to?: string; ts: number; message?: string }) => {
          if (ev.app !== name) return;
          lastSignalAt = Date.now();
          if (ev.type === 'status') {
            write({ kind: 'status', from: ev.from, to: ev.to, ts: ev.ts });
            if (untilRaw !== 'stable' && reachedTarget()) finish('reached');
          } else if (ev.type === 'error-new' || ev.type === 'error-recur') {
            const errs = registry.errors(name) ?? [];
            const last = errs[0];
            if (last) write({ kind: 'error', message: last.message, parsed: last.parsed ?? null, ts: ev.ts });
          } else if (ev.type === 'health') {
            write({ kind: 'health', from: ev.from, to: ev.to, ts: ev.ts });
            if (untilRaw !== 'stable' && reachedTarget()) finish('reached');
          }
        };
        registry.on('event', onEvent);
        const stableTimer = setInterval(() => {
          if (reachedTarget()) finish('reached');
        }, 1000);
        const keepalive = setInterval(() => { try { res.write('\n'); } catch {} }, 30_000);
        const deadline = setTimeout(() => finish('timeout'), timeoutMs);
        req.on('close', () => finish('closed'));
        if (reachedTarget()) finish('reached');
        return;
      }

      if (sub === 'health' && sub2 === 'pin' && method === 'POST') {
        const s = registry.getState(name);
        if (!s) { sendJson(res, 404, UNKNOWN_APP); return; }
        const body: any = await readJsonBody(req);
        const desired: string | null = (typeof body.path === 'string' && body.path) ? body.path : (s.discoveredHealthPath ?? null);
        if (!desired) { sendJson(res, 400, { error: 'no path supplied and no discoveredHealthPath on app', hint: 'start the app and wait for it to serve once (auto-discovery), or pass { path } explicitly' }); return; }
        const { configLookupPaths } = await import('./config.js');
        const { local, user } = configLookupPaths();
        const target = fs.existsSync(local) ? local : user;
        let raw: any = {};
        // Refuse to clobber a config the user is mid-edit: if the file exists
        // but doesn't parse, don't start from {} and overwrite it.
        if (fs.existsSync(target)) {
          try { raw = JSON.parse(fs.readFileSync(target, 'utf8')); }
          catch (err: any) { sendJson(res, 409, { error: `config at ${target} is not valid JSON; fix it before pinning`, detail: err?.message || String(err) }); return; }
        }
        if (!raw.overrides || typeof raw.overrides !== 'object') raw.overrides = {};
        if (!raw.overrides[name] || typeof raw.overrides[name] !== 'object') raw.overrides[name] = {};
        const prev = raw.overrides[name].healthProbePath ?? null;
        raw.overrides[name].healthProbePath = desired;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Atomic + .bak (M88): this writes a user-owned config file, so a
        // crash mid-write must never leave it truncated or unrecoverable.
        const pinTmp = target + '.' + process.pid + '.tmp';
        fs.writeFileSync(pinTmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
        try { if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak'); } catch {}
        fs.renameSync(pinTmp, target);
        // health/pin mutates on-disk config just like PATCH /api/config, so it
        // must leave the same audit trail.
        try {
          const remote = (req.socket as any).remoteAddress || '127.0.0.1';
          appendAuditEntry(remote, { healthProbePath: prev }, { healthProbePath: desired }, [`overrides.${name}.healthProbePath`], cwdHdr, agentId === 'unknown' ? null : agentId);
        } catch {}
        if (opts.reloadConfig) {
          try { await opts.reloadConfig(); } catch {}
        }
        sendJson(res, 200, { pinned: desired, app: name, configPath: target, previous: prev });
        return;
      }

      if (sub === 'try-fix' && method === 'POST') {
        const s0 = registry.summary(name);
        if (!s0) { sendJson(res, 404, UNKNOWN_APP); return; }
        const untilRaw = (url.searchParams.get('until') || 'healthy').toLowerCase();
        if (!['serving', 'healthy'].includes(untilRaw)) {
          sendJson(res, 400, { error: 'until must be serving|healthy' });
          return;
        }
        // try-fix restarts the app — serialise it through the soft lock like
        // start/stop/restart so a second agent can't restart underneath the
        // agent that holds the lock.
        if (!tryLock('try-fix')) return;
        const timeoutMsRaw = url.searchParams.get('timeoutMs') || url.searchParams.get('timeout');
        let timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 180_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 180_000;
        timeoutMs = Math.min(timeoutMs, 600_000);
        const before = {
          status: s0.status,
          health: s0.health,
          errCount: s0.errorCount,
          firstError: (registry.errors(name) ?? [])[0]?.parsed ?? null,
        };
        const { runAutoFix, ALL_AUTO_FIX } = await import('./autoFix.js');
        const cfg = opts.getConfig?.();
        const permitted = (cfg?.doctor?.autoFix?.permitted as any) ?? ALL_AUTO_FIX;
        let fixResult: any = { ran: [], skipped: [], errors: [] };
        try { fixResult = await runAutoFix({ permitted, dryRun: false }); } catch (err: any) { fixResult.errors.push({ name: 'auto-fix', error: err?.message ?? String(err) }); }
        const fixed: string[] = (fixResult.ran ?? []).map((r: any) => r.name);
        let restartErr: string | null = null;
        try { const rr = await registry.restart(name); if (!rr?.ok) restartErr = rr?.error ?? 'restart failed'; }
        catch (err: any) { restartErr = err?.message ?? String(err); }
        const waitR = await registry.waitFor(name, untilRaw as any, timeoutMs);
        const sFinal = registry.summary(name);
        const errsFinal = registry.errors(name) ?? [];
        const stillFailing = errsFinal.slice(0, 5).map(e => ({
          file: e.parsed?.file ?? null,
          line: e.parsed?.line ?? null,
          code: e.parsed?.code ?? null,
          tool: e.parsed?.tool ?? null,
          message: e.parsed?.message ?? e.message,
        }));
        const after = sFinal ? { status: sFinal.status, health: sFinal.health, errCount: sFinal.errorCount } : { status: waitR.status, health: waitR.health, errCount: 0 };
        const reached =
          (untilRaw === 'serving' && after.status === 'serving') ||
          (untilRaw === 'healthy' && after.status === 'serving' && after.health === 'healthy');
        sendJson(res, 200, {
          before,
          after,
          fixed,
          stillFailing,
          reached,
          waitedMs: waitR.waitedMs,
          _meta: { autoFix: fixResult, restartErr, timedOut: waitR.timedOut },
        });
        return;
      }

      if (sub === 'wait' && method === 'GET') {
        if (!registry.summary(name)) { sendJson(res, 404, UNKNOWN_APP); return; }
        const untilRaw = (url.searchParams.get('until') || 'serving').toLowerCase();
        if (!['serving', 'healthy', 'stopped', 'error'].includes(untilRaw)) {
          sendJson(res, 400, { error: 'until must be one of serving|healthy|stopped|error' });
          return;
        }
        // ?timeout= is SECONDS (legacy, kept forever); ?timeoutMs= accepted
        // since v0.14 for consistency with ensure/focus/try-fix. Ms wins.
        const timeoutMsRaw = url.searchParams.get('timeoutMs');
        const timeoutSecRaw = url.searchParams.get('timeout');
        let timeoutSec = timeoutSecRaw ? Number(timeoutSecRaw) : 120;
        if (timeoutMsRaw && Number.isFinite(Number(timeoutMsRaw)) && Number(timeoutMsRaw) > 0) {
          timeoutSec = Number(timeoutMsRaw) / 1000;
        }
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) timeoutSec = 120;
        timeoutSec = Math.min(timeoutSec, 600);
        const result = await registry.waitFor(name, untilRaw as any, timeoutSec * 1000);
        sendJson(res, 200, result);
        return;
      }

      if (sub === 'ensure' && method === 'POST') {
        const s0 = registry.summary(name);
        if (!s0) { sendJson(res, 404, UNKNOWN_APP); return; }
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
          // Only contend the soft lock when ensure actually starts the app; an
          // already-terminal app returned above without locking, so an idempotent
          // ensure of a healthy app stays a lock-free read.
          if (!tryLock('ensure')) return;
          await registry.start(name);
        }
        const r = await registry.waitFor(name, effectiveUntil, timeoutMs);
        const sFinal = registry.summary(name);
        const compact = sFinal ? compactStatus(sFinal) : { name, status: r.status, port: null, url: null, health: r.health, errCount: 0, lastChangeMs: null, uptimeMs: null };
        if (r.timedOut) {
          sendJson(res, 200, { error: 'timeout', state: compact, _meta: { format: 'compact', startedFromState: startFromState, warning, waitedMs: r.waitedMs, timedOut: true } });
          return;
        }
        sendJson(res, 200, { ...compact, _meta: { format: 'compact', startedFromState: startFromState, warning, waitedMs: r.waitedMs } });
        return;
      }

      if (sub === 'lock' && method === 'GET') {
        if (!registry.summary(name)) { sendJson(res, 404, UNKNOWN_APP); return; }
        const current = locks.current(name);
        const recent = locks.recentInteractions(name, 3);
        sendJson(res, 200, { app: name, current, recent });
        return;
      }

      if (sub === 'handoff' && method === 'POST') {
        if (!registry.summary(name)) { sendJson(res, 404, UNKNOWN_APP); return; }
        const body: any = await readJsonBody(req);
        const toAgent = typeof body?.to === 'string' ? body.to.trim() : '';
        if (!toAgent) { sendJson(res, 400, { error: 'body { to: <agentId> } required' }); return; }
        const current = locks.current(name);
        const next = locks.handoff(name, toAgent, agentId === 'unknown' ? null : agentId);
        sendJson(res, 200, { handedOff: name, from: current?.agent ?? null, to: next.agent, lockedAt: next.lockedAt, expiresAt: next.expiresAt });
        return;
      }

      if (sub === 'start' && method === 'POST') {
        if (!tryLock('start')) return;
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
        if (!tryLock('start-with-deps')) return;
        const r = await registry.startWithDeps(name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      // Run the app's test suite once (M74). Soft-lock gated like start/stop —
      // two agents can't run the same suite concurrently unaware; ?steal=1
      // applies. Audit-logged like other lifecycle calls.
      if (sub === 'test' && method === 'POST') {
        if (!tryLock('test')) return;
        const timeoutMsRaw = url.searchParams.get('timeoutMs') || url.searchParams.get('timeout');
        let timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 300_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 300_000;
        timeoutMs = Math.min(timeoutMs, 600_000);
        try {
          const remote = (req.socket as any).remoteAddress || '127.0.0.1';
          appendAuditEntry(remote, { action: 'test', app: name }, { action: 'test', app: name }, [`test:${name}`], cwdHdr, agentId === 'unknown' ? null : agentId);
        } catch {}
        const r = await registry.runTests(name, { timeoutMs });
        if ('error' in r) {
          sendJson(res, r.error === 'unknown app' ? 404 : 422, r);
          return;
        }
        sendJson(res, 200, r);
        return;
      }

      if (sub === 'tasks' && method === 'GET' && !sub2) {
        const tasks = registry.listTasks(name);
        if (tasks == null) { sendJson(res, 404, UNKNOWN_APP); return; }
        sendJson(res, 200, { tasks, watching: registry.listWatchTasks(name) });
        return;
      }

      if (sub === 'run' && sub2 && method === 'POST') {
        const body: any = await readJsonBody(req);
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
        const body: any = await readJsonBody(req);
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
        if (!plan) { sendJson(res, 404, UNKNOWN_APP); return; }
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
          if (!wr) { sendJson(res, 404, UNKNOWN_APP); return; }
          sendJson(res, 200, { snapshot: wr.path });
          return;
        }
        const p = buildSnapshot(registry, name);
        if (!p) { sendJson(res, 404, UNKNOWN_APP); return; }
        sendJson(res, 200, p);
        return;
      }
      if (sub === 'stop' && method === 'POST') {
        if (!tryLock('stop')) return;
        const r = await registry.stop(name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }
      // Notification mute (M84): persisted, surfaced in status + dashboard.
      if (sub === 'mute' && method === 'POST') {
        if (!registry.summary(name)) { sendJson(res, 404, UNKNOWN_APP); return; }
        const body: any = await readJsonBody(req);
        const forMs = typeof body?.forMs === 'number' && body.forMs > 0 ? body.forMs : null;
        sendJson(res, 200, registry.mute(name, forMs));
        return;
      }
      if (sub === 'unmute' && method === 'POST') {
        if (!registry.summary(name)) { sendJson(res, 404, UNKNOWN_APP); return; }
        sendJson(res, 200, registry.unmute(name));
        return;
      }
      if (sub === 'restart' && method === 'POST') {
        if (!tryLock('restart')) return;
        const r = await registry.restart(name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      // Last-resort static asset handler for the Angular SPA: serve files from
      // dist/dashboard when the request looks like an asset (has an extension) or
      // explicitly targets /dashboard/*. SPA routes without an extension fall back
      // to index.html so the Router can take over client-side.
      if (method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/metrics')) {
        const spaDir = dashboardSpaDir();
        if (spaDir) {
          const rel = url.pathname.replace(/^\/dashboard\//, '/').replace(/^\//, '');
          if (rel) {
            const abs = path.resolve(spaDir, rel);
            if (abs.startsWith(spaDir) && serveStaticFile(res, abs)) return;
          }
          if (!path.extname(rel || '')) {
            if (serveStaticFile(res, path.join(spaDir, 'index.html'))) return;
          }
        }
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
  });

  server.listen(port, '127.0.0.1');
  return server;
}
