import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { readLock, spawnDetached } from './daemon.js';
import { BOSUN_VERSION } from './version.js';

function apiPort(): number {
  if (process.env.BOSUN_PORT) {
    const p = Number(process.env.BOSUN_PORT);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const lock = readLock();
  if (lock) return lock.apiPort;
  try {
    const r = loadConfig();
    if (r.kind === 'loaded') return r.config.apiPort;
  } catch {}
  return 4999;
}

const BASE = () => `http://127.0.0.1:${apiPort()}`;

let ensured = false;
async function ensureDaemon(): Promise<void> {
  if (ensured) return;
  ensured = true;
  if (process.env.BOSUN_NO_SPAWN === '1') return;
  if (readLock()) return;
  try {
    const port = process.env.BOSUN_PORT ? Number(process.env.BOSUN_PORT) : undefined;
    await spawnDetached({ port: Number.isFinite(port as number) && (port as number) > 0 ? (port as number) : undefined });
  } catch {}
}

async function callJson(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<any> {
  await ensureDaemon();
  try {
    const res = await fetch(BASE() + pathname, { method });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  } catch (err: any) {
    return { status: 0, body: { error: 'bosun is not running — start it with: bosun daemon start --detach' } };
  }
}

function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function err(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

async function main() {
  const server = new McpServer({ name: 'bosun', version: BOSUN_VERSION });

  server.registerTool('list_apps', { description: 'List all known apps with current status, port, health, etc.', inputSchema: {} }, async () => {
    const r = await callJson('/api/apps');
    return r.status === 0 ? err(r.body?.error || 'unknown') : ok(r.body);
  });

  server.registerTool('get_status', { description: 'Get the current status of one app.', inputSchema: { name: z.string() } }, async ({ name }) => {
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  server.registerTool('get_errors', {
    description: 'Get errors for an app. Supports --since duration, --since-last cursor, optional structured form.',
    inputSchema: {
      name: z.string(),
      since: z.string().optional(),
      sinceLast: z.boolean().optional(),
      client: z.string().optional(),
      structured: z.boolean().optional(),
    },
  }, async ({ name, since, sinceLast, client, structured }) => {
    let path = `/api/apps/${encodeURIComponent(name)}/errors`;
    const qs = new URLSearchParams();
    if (sinceLast) { path += '/since-last'; if (client) qs.set('client', client); }
    else if (since) qs.set('since', since);
    const q = qs.toString();
    const r = await callJson(path + (q ? '?' + q : ''));
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    let body = r.body;
    if (structured && Array.isArray(body)) body = body.map((e: any) => e.parsed ?? { message: e.message });
    return ok(body);
  });

  server.registerTool('get_logs', {
    description: 'Get recent log lines for an app.',
    inputSchema: { name: z.string(), tail: z.number().int().positive().optional(), since: z.string().optional() },
  }, async ({ name, tail, since }) => {
    const qs = new URLSearchParams();
    if (tail) qs.set('tail', String(tail));
    if (since) qs.set('since', since);
    const q = qs.toString();
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/logs${q ? '?' + q : ''}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    server.registerTool(`${action}_app`, { description: `${action} an app.`, inputSchema: { name: z.string() } }, async ({ name }) => {
      const r = await callJson(`/api/apps/${encodeURIComponent(name)}/${action}`, 'POST');
      if (r.status === 0) return err(r.body?.error || 'unknown');
      return ok(r.body);
    });
  }

  server.registerTool('wait_for_app', {
    description: 'Block until app reaches the given state or timeout (max 600s).',
    inputSchema: {
      name: z.string(),
      until: z.enum(['serving', 'healthy', 'stopped', 'error']).optional(),
      timeout: z.number().int().positive().max(600).optional(),
    },
  }, async ({ name, until, timeout }) => {
    const qs = new URLSearchParams();
    qs.set('until', until || 'serving');
    qs.set('timeout', String(Math.min(timeout ?? 120, 600)));
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/wait?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`[bosun-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
