import { loadConfig } from './config.js';

function fail(msg: string): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(1);
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

async function call(pathname: string, method: 'GET' | 'POST'): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(getBaseUrl() + pathname, { method });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } catch (err: any) {
    fail('appman is not running — start it with: npm start');
  }
}

function parseFlags(args: string[]): { tail?: number; since?: string; positional: string[] } {
  const positional: string[] = [];
  let tail: number | undefined;
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tail') { tail = Number(args[++i]); }
    else if (a === '--since') { since = args[++i]; }
    else positional.push(a);
  }
  return { tail, since, positional };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) fail(JSON.stringify({ error: 'usage: appman <list|status|errors|logs|start|stop|restart>' }));

  switch (cmd) {
    case 'list': {
      const r = await call('/api/apps', 'GET');
      out(r.body);
      return;
    }
    case 'status':
    case 'errors':
    case 'start':
    case 'stop':
    case 'restart': {
      const name = rest[0];
      if (!name) fail(JSON.stringify({ error: `usage: appman ${cmd} <name>` }));
      const suffix = cmd === 'status' ? '' : '/' + cmd;
      const method = (cmd === 'start' || cmd === 'stop' || cmd === 'restart') ? 'POST' : 'GET';
      const r = await call(`/api/apps/${encodeURIComponent(name)}${suffix}`, method);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'logs': {
      const { positional, tail, since } = parseFlags(rest);
      const name = positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman logs <name> [--tail N] [--since 30s]' }));
      const params = new URLSearchParams();
      if (tail != null && !Number.isNaN(tail)) params.set('tail', String(tail));
      if (since) params.set('since', since);
      const qs = params.toString();
      const r = await call(`/api/apps/${encodeURIComponent(name)}/logs${qs ? '?' + qs : ''}`, 'GET');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    default:
      fail(JSON.stringify({ error: `unknown command: ${cmd}` }));
  }
}

main().catch(err => fail(JSON.stringify({ error: err?.message || String(err) })));
