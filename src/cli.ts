import { loadConfig } from './config.js';

function fail(msg: string, code = 1): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function readApiPort(): number {
  try {
    const r = loadConfig();
    if (r.kind === 'loaded') return r.config.apiPort;
  } catch {}
  return 4999;
}

function getBaseUrl(): string {
  return `http://127.0.0.1:${readApiPort()}`;
}

async function call(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(getBaseUrl() + pathname, { method });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } catch {
    fail('appman is not running — start it with: npm start');
  }
}

interface Flags {
  tail?: number;
  since?: string;
  sinceLast?: boolean;
  client?: string;
  structured?: boolean;
  until?: string;
  timeout?: string;
  app?: string;
  tags: string[];
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const f: Flags = { tags: [], positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tail') f.tail = Number(args[++i]);
    else if (a === '--since') f.since = args[++i];
    else if (a === '--since-last') f.sinceLast = true;
    else if (a === '--client') f.client = args[++i];
    else if (a === '--structured') f.structured = true;
    else if (a === '--until') f.until = args[++i];
    else if (a === '--timeout') f.timeout = args[++i];
    else if (a === '--app') f.app = args[++i];
    else if (a === '--tag') f.tags.push(args[++i]);
    else f.positional.push(a);
  }
  return f;
}

function durationToSeconds(s: string): number | null {
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2] || 's') {
    case 'ms': return n / 1000;
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 60 * 60;
  }
  return null;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) fail(JSON.stringify({ error: 'usage: appman <list|status|errors|events|wait|logs|start|stop|restart>' }));

  const f = parseFlags(rest);

  switch (cmd) {
    case 'list': {
      const r = await call('/api/apps');
      let arr = Array.isArray(r.body) ? r.body : [];
      if (f.tags.length) arr = arr.filter((a: any) => f.tags.every(t => (a.tags || []).includes(t)));
      out(arr);
      return;
    }
    case 'status':
    case 'start':
    case 'stop':
    case 'restart': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: `usage: appman ${cmd} <name>` }));
      const suffix = cmd === 'status' ? '' : '/' + cmd;
      const method: 'GET' | 'POST' = cmd === 'status' ? 'GET' : 'POST';
      const r = await call(`/api/apps/${encodeURIComponent(name)}${suffix}`, method);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'errors': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman errors <name> [--since 2m] [--since-last] [--client <id>] [--structured]' }));
      const params = new URLSearchParams();
      let endpoint = `/api/apps/${encodeURIComponent(name)}/errors`;
      if (f.sinceLast) {
        endpoint += '/since-last';
        if (f.client) params.set('client', f.client);
      } else if (f.since) {
        params.set('since', f.since);
      }
      const qs = params.toString();
      const r = await call(endpoint + (qs ? '?' + qs : ''));
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      let body = r.body;
      if (f.structured && Array.isArray(body)) {
        body = body.map((e: any) => e.parsed ?? { message: e.message });
      }
      out(body);
      return;
    }
    case 'events': {
      const params = new URLSearchParams();
      if (f.since) params.set('since', f.since);
      if (f.app) params.set('app', f.app);
      const qs = params.toString();
      const r = await call('/api/events' + (qs ? '?' + qs : ''));
      out(r.body);
      return;
    }
    case 'wait': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman wait <name> [--until serving|healthy|stopped|error] [--timeout 60s]' }));
      const params = new URLSearchParams();
      if (f.until) params.set('until', f.until);
      let timeoutSec = 120;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) fail(JSON.stringify({ error: `invalid --timeout: ${f.timeout}` }));
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeout', String(Math.ceil(timeoutSec)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/wait?${params.toString()}`);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      if (r.body?.timedOut) process.exit(2);
      return;
    }
    case 'logs': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman logs <name> [--tail N] [--since 30s]' }));
      const params = new URLSearchParams();
      if (f.tail != null && !Number.isNaN(f.tail)) params.set('tail', String(f.tail));
      if (f.since) params.set('since', f.since);
      const qs = params.toString();
      const r = await call(`/api/apps/${encodeURIComponent(name)}/logs${qs ? '?' + qs : ''}`);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    default:
      fail(JSON.stringify({ error: `unknown command: ${cmd}` }));
  }
}

main().catch(err => fail(JSON.stringify({ error: err?.message || String(err) })));
