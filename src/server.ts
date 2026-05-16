import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registry } from './registry.js';

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

function parseSince(s: string | null): number | undefined {
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

export function startServer(registry: Registry, port: number): http.Server {
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

      if (sub === 'errors' && method === 'GET') {
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
          sinceMs: parseSince(since),
        });
        if (lines == null) { sendJson(res, 404, { error: 'unknown app' }); return; }
        sendJson(res, 200, { lines });
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
