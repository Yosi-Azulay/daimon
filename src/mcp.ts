import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { readLock, spawnDetached } from './daemon.js';
import { DAIMON_VERSION } from './version.js';

function apiPort(): number {
  if (process.env.DAIMON_PORT) {
    const p = Number(process.env.DAIMON_PORT);
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
  if (process.env.DAIMON_NO_SPAWN === '1') return;
  if (readLock()) return;
  try {
    const port = process.env.DAIMON_PORT ? Number(process.env.DAIMON_PORT) : undefined;
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
    return { status: 0, body: { error: 'daimon is not running — start it with: daimon daemon start --detach' } };
  }
}

function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function err(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

async function main() {
  const server = new McpServer({ name: 'daimon', version: DAIMON_VERSION });

  server.registerTool('list_apps', { description: 'List apps in compact form: name, status, port, health, errCount, lastChangeMs. Use list_apps_full for the verbose v0.4 shape.', inputSchema: {} }, async () => {
    const r = await callJson('/api/apps?format=compact');
    return r.status === 0 ? err(r.body?.error || 'unknown') : ok(r.body);
  });

  server.registerTool('list_apps_full', { description: 'List apps in the verbose v0.4 form (uptimeMs, lastCompileMs, metrics, etc.). Heavier — prefer list_apps unless you need extra fields.', inputSchema: {} }, async () => {
    const r = await callJson('/api/apps?format=full');
    return r.status === 0 ? err(r.body?.error || 'unknown') : ok(r.body);
  });

  server.registerTool('get_status', { description: 'Compact status: name, status, port, url, health, errCount, lastChangeMs, uptime. Use get_status_full for the verbose v0.4 shape.', inputSchema: { name: z.string() } }, async ({ name }) => {
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}?format=compact`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  server.registerTool('get_status_full', { description: 'Verbose v0.4 status form including events, compile history, metrics. Prefer get_status unless you need extra fields.', inputSchema: { name: z.string() } }, async ({ name }) => {
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}?format=full`);
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

  server.registerTool('overview', {
    description: 'Decision-ready snapshot of the workspace: totals, byStatus, needsAttention (with first parsed error per failing app), recentlyChanged. The recommended first call in a session — answers "what is going on right now?" in one round-trip.',
    inputSchema: { workspace: z.string().optional(), profile: z.string().optional() },
  }, async ({ workspace, profile }) => {
    const qs = new URLSearchParams();
    if (workspace) qs.set('workspace', workspace);
    if (profile) qs.set('profile', profile);
    const q = qs.toString();
    const r = await callJson('/api/overview' + (q ? '?' + q : ''));
    if (r.status === 0) return err(r.body?.error || 'unknown');
    return ok(r.body);
  });

  server.registerTool('ensure', {
    description: 'One-call lifecycle: if the app is stopped/crashed/error, start it; then block until it reaches the target state. Idempotent — returns immediately on already-terminal apps. Replaces the list→status→start→wait→status sequence. Returns compact AppSummary plus _meta.startedFromState / waitedMs. On timeout the body is { error: "timeout", state, _meta: { timedOut: true } } — treat as exit 2 equivalent.',
    inputSchema: {
      name: z.string(),
      until: z.enum(['serving', 'healthy']).optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    },
  }, async ({ name, until, timeoutMs }) => {
    const qs = new URLSearchParams();
    qs.set('until', until || 'healthy');
    qs.set('timeoutMs', String(Math.min(timeoutMs ?? 180_000, 600_000)));
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/ensure?${qs.toString()}`, 'POST');
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  server.registerTool('ensure_up', {
    description: 'One-call profile bring-up: cascade-start every app in the profile (resolving deps) and block until each reaches the target. Returns per-app terminal state plus _meta.totalMs. Use this instead of daimon up + per-app waits.',
    inputSchema: {
      profile: z.string(),
      until: z.enum(['serving', 'healthy']).optional(),
      timeoutMs: z.number().int().positive().max(1_200_000).optional(),
    },
  }, async ({ profile, until, timeoutMs }) => {
    const qs = new URLSearchParams();
    qs.set('until', until || 'healthy');
    qs.set('timeoutMs', String(Math.min(timeoutMs ?? 300_000, 1_200_000)));
    const r = await callJson(`/api/profiles/${encodeURIComponent(profile)}/ensure-up?${qs.toString()}`, 'POST');
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown profile');
    return ok(r.body);
  });

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
  process.stderr.write(`[daimon-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
