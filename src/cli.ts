import { loadConfig } from './config.js';
import { discoverApps } from './discovery.js';
import { runDoctor } from './doctor.js';
import { findPortHolder, killHolder } from './portDiag.js';

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

async function loadCfg(): Promise<{ config: { autoStart?: string[]; profiles?: Record<string, string[]> } }> {
  try {
    const r = loadConfig();
    if (r.kind === 'loaded') return { config: r.config };
  } catch {}
  return { config: {} };
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

async function callJson(pathname: string, method: 'GET' | 'POST', payload: unknown): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
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
  withDeps?: boolean;
  watch?: boolean;
  force?: boolean;
  yes?: boolean;
  deep?: boolean;
  use?: string;
  speed?: number;
  task?: string;
  headless?: boolean;
  passthrough: string[];
}

function parseFlags(args: string[]): Flags {
  const f: Flags = { tags: [], positional: [], passthrough: [] };
  let afterDD = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDD) { f.passthrough.push(a); continue; }
    if (a === '--') { afterDD = true; continue; }
    if (a === '--tail') f.tail = Number(args[++i]);
    else if (a === '--since') f.since = args[++i];
    else if (a === '--since-last') f.sinceLast = true;
    else if (a === '--client') f.client = args[++i];
    else if (a === '--structured') f.structured = true;
    else if (a === '--until') f.until = args[++i];
    else if (a === '--timeout') f.timeout = args[++i];
    else if (a === '--app') f.app = args[++i];
    else if (a === '--tag') f.tags.push(args[++i]);
    else if (a === '--with-deps') f.withDeps = true;
    else if (a === '--watch') f.watch = true;
    else if (a === '--force') f.force = true;
    else if (a === '--yes') f.yes = true;
    else if (a === '--deep') f.deep = true;
    else if (a === '--use') f.use = args[++i];
    else if (a === '--speed') f.speed = Number(args[++i]);
    else if (a === '--task') f.task = args[++i];
    else if (a === '--headless') f.headless = true;
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
  if (!cmd) fail(JSON.stringify({ error: 'usage: appman <list|status|errors|events|wait|logs|start|stop|restart|up|down|history|why|tasks|run|snapshot|doctor|env|clean|free-port|record|replay>' }));

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
    case 'start': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman start <name> [--with-deps]' }));
      const qs = f.withDeps ? '?withDeps=1' : '';
      const r = await call(`/api/apps/${encodeURIComponent(name)}/start${qs}`, 'POST');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'history': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman history <name>' }));
      const r = await call(`/api/history/summary/${encodeURIComponent(name)}`);
      out(r.body);
      return;
    }
    case 'why': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman why <name>' }));
      const r = await call(`/api/history/why/${encodeURIComponent(name)}`);
      out(r.body);
      return;
    }
    case 'doctor': {
      const cfgR = loadConfig();
      if (cfgR.kind !== 'loaded') fail(JSON.stringify({ error: 'no config loaded' }));
      const apps = discoverApps(cfgR.config);
      const result = await runDoctor(cfgR.config, apps);
      out(result);
      if (!result.ok) process.exit(1);
      return;
    }
    case 'free-port': {
      const port = Number(f.positional[0]);
      if (!Number.isFinite(port) || port <= 0) fail(JSON.stringify({ error: 'usage: appman free-port <port> [--force]' }));
      const holder = findPortHolder(port);
      if (!holder) { out({ port, free: true }); return; }
      if (!f.force) { out({ port, free: false, holder }); return; }
      if (holder.pid === process.pid) fail(JSON.stringify({ error: 'refuse to kill appman itself', holder }));
      const ok = await killHolder(holder);
      out({ port, killed: ok, holder });
      if (!ok) process.exit(1);
      return;
    }
    case 'snapshot': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman snapshot <name>' }));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/snapshot?write=1`, 'POST');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'tasks': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman tasks <name>' }));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/tasks`);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'run': {
      const name = f.positional[0];
      const task = f.positional[1];
      if (!name || !task) fail(JSON.stringify({ error: 'usage: appman run <name> <task> [--watch] [-- args...]' }));
      const body = { args: f.passthrough, watch: !!f.watch };
      const r = await callJson(`/api/apps/${encodeURIComponent(name)}/run/${encodeURIComponent(task)}`, 'POST', body);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      if (!f.watch && typeof r.body?.exitCode === 'number') process.exit(r.body.exitCode === 0 ? 0 : 1);
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
    case 'up':
    case 'down': {
      const profile = f.positional[0];
      const listRes = await call('/api/apps');
      const all: any[] = Array.isArray(listRes.body) ? listRes.body : [];
      const knownConfig = (await loadCfg()).config;
      let targets: string[];
      if (!profile) {
        targets = knownConfig.autoStart || [];
        if (cmd === 'up' && targets.length === 0) {
          fail(JSON.stringify({ error: 'no autoStart configured and no profile given' }));
        }
        if (cmd === 'down' && targets.length === 0) {
          targets = all.map(a => a.name);
        }
      } else {
        const list = knownConfig.profiles?.[profile];
        if (!list) fail(JSON.stringify({ error: `unknown profile: ${profile}` }));
        targets = list;
      }
      const action = cmd === 'up' ? 'start' : 'stop';
      if (cmd === 'up') {
        await Promise.all(targets.map(n => call(`/api/apps/${encodeURIComponent(n)}/start?withDeps=1`, 'POST')));
      } else {
        await Promise.all(targets.map(n => call(`/api/apps/${encodeURIComponent(n)}/${action}`, 'POST')));
      }
      if (cmd === 'up') {
        const budgetMs = 120_000;
        const start = Date.now();
        const perAppTimeout = () => Math.max(5, Math.floor((budgetMs - (Date.now() - start)) / 1000));
        await Promise.all(targets.map(n => call(`/api/apps/${encodeURIComponent(n)}/wait?until=serving&timeout=${perAppTimeout()}`)));
      } else {
        await Promise.all(targets.map(n => call(`/api/apps/${encodeURIComponent(n)}/wait?until=stopped&timeout=10`)));
      }
      const finalList = await call('/api/apps');
      const arr: any[] = Array.isArray(finalList.body) ? finalList.body : [];
      const summary = arr
        .filter(a => targets.includes(a.name))
        .map(a => ({ name: a.name, status: a.status, health: a.health }));
      out(summary);
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
