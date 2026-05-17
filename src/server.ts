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
