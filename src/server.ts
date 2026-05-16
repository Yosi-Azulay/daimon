import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registry } from './registry.js';
import { Cursors } from './cursors.js';

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

function parseSinceParam(s: string | null): { sinceMs?: number; sinceTs?: number } {
  if (!s) return {};
  if (/^\d{10,}$/.test(s)) return { sinceTs: Number(s) };
  const dur = parseDuration(s);
  if (dur != null) return { sinceMs: dur };
  return {};
}

export function startServer(registry: Registry, port: number): http.Server {
  const cursors = new Cursors();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const method = req.method || 'GET';
      const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);

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
        sendJson(res, 200, registry.events({ sinceMs, app }));
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
        sendJson(res, 200, registry.list());
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
        sendJson(res, 200, s);
        return;
      }

      if (sub === 'errors' && sub2 === 'since-last' && method === 'GET') {
        const client = url.searchParams.get('client') || 'default';
        const cursor = cursors.getErrorCursor(client, name);
        const errs = registry.errorsSince(name, cursor);
        if (errs == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
        const newest = errs.reduce((acc, e) => Math.max(acc, e.lastSeen), cursor);
        if (newest > cursor) cursors.setErrorCursor(client, name, newest);
        sendJson(res, 200, errs);
        return;
      }

      if (sub === 'errors' && !sub2 && method === 'GET') {
        const sinceRaw = url.searchParams.get('since');
        if (sinceRaw) {
          const { sinceMs, sinceTs } = parseSinceParam(sinceRaw);
          const cutoff = sinceTs ?? (sinceMs != null ? Date.now() - sinceMs : 0);
          const errs = registry.errorsSince(name, cutoff);
          if (errs == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
          sendJson(res, 200, errs);
          return;
        }
        const errs = registry.errors(name);
        if (errs == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
        sendJson(res, 200, errs);
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

      if (sub === 'start' && method === 'POST') {
        const r = await registry.start(name);
        sendJson(res, r.ok ? 200 : 400, r);
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
