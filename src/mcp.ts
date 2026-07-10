import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { readLock, spawnDetached } from './daemon.js';
import { DAIMON_VERSION } from './version.js';
import { generateAgentId } from './agents.js';

const AGENT_ID = generateAgentId();
function headers(): Record<string, string> {
  return { 'x-daimon-agent': AGENT_ID, 'x-daimon-cwd': process.cwd() };
}

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

// Ceiling on a single daemon call so a daemon that accepts the socket then
// stalls can't hang an MCP tool invocation indefinitely. Set above the daemon's
// own 600s max long-poll deadline (wait_for_app etc.) so legitimate long waits
// complete while a truly hung daemon still unblocks.
const CALL_TIMEOUT_MS = 660_000;

async function callJson(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<any> {
  await ensureDaemon();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(BASE() + pathname, { method, headers: headers(), signal: ac.signal });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  } catch (err: any) {
    if (err?.name === 'AbortError') return { status: 0, body: { error: `daimon call timed out after ${CALL_TIMEOUT_MS}ms` } };
    return { status: 0, body: { error: 'daimon is not running — start it with: daimon daemon start --detach' } };
  } finally {
    clearTimeout(timer);
  }
}

function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function err(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

// Exported so the contract test can connect over an in-memory transport and
// validate the full tool surface without grabbing stdio or spawning a daemon.
export function buildServer(): McpServer {
  const server = new McpServer({ name: 'daimon', version: DAIMON_VERSION });

  server.registerTool('list_apps', { description: 'List apps in compact form: name, status, port, health, errCount, lastChangeMs. Use list_apps_full for the verbose v0.4 shape.', inputSchema: {} }, async () => {
    const r = await callJson('/api/apps?format=compact');
    return r.status === 0 ? err(r.body?.error || 'unknown') : ok(r.body);
  });

  server.registerTool('list_apps_full', { description: 'List apps in the verbose v0.4 form (uptimeMs, lastCompileMs, metrics, etc.). Heavier — prefer list_apps unless you need extra fields.', inputSchema: {} }, async () => {
    const r = await callJson('/api/apps?format=full');
    return r.status === 0 ? err(r.body?.error || 'unknown') : ok(r.body);
  });

  // Default `cwd` used by MCP tools when the caller doesn't pass one. The MCP
  // server runs in the daemon's process, so `process.cwd()` is the user's
  // shell cwd when they spawned `daimon mcp`. Accept-but-don't-default to it
  // would mean two agents share "everything" — so we default in.
  const defaultCwd = process.cwd();
  const cwdField = z.string().optional().describe('Workspace cwd for name disambiguation; defaults to the MCP server cwd. Use an explicit value when invoking from a different workspace.');

  server.registerTool('get_status', { description: 'Compact status: name, status, port, url, health, errCount, lastChangeMs, uptime. Use get_status_full for the verbose v0.4 shape.', inputSchema: { name: z.string(), cwd: cwdField } }, async ({ name, cwd }) => {
    const qs = new URLSearchParams({ format: 'compact', cwd: cwd ?? defaultCwd });
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 412) return err(JSON.stringify(r.body));
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  server.registerTool('get_status_full', { description: 'Verbose v0.4 status form including events, compile history, metrics. Prefer get_status unless you need extra fields.', inputSchema: { name: z.string(), cwd: cwdField } }, async ({ name, cwd }) => {
    const qs = new URLSearchParams({ format: 'full', cwd: cwd ?? defaultCwd });
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 412) return err(JSON.stringify(r.body));
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  server.registerTool('get_errors', {
    description: 'Get errors for an app. Supports --since duration, --since-last cursor, optional structured form, and --level (error|warning|lint|all).',
    inputSchema: {
      name: z.string(),
      since: z.string().optional(),
      sinceLast: z.boolean().optional(),
      client: z.string().optional(),
      structured: z.boolean().optional(),
      level: z.enum(['error', 'warning', 'lint', 'all']).optional(),
      cwd: cwdField,
    },
  }, async ({ name, since, sinceLast, client, structured, level, cwd }) => {
    let path = `/api/apps/${encodeURIComponent(name)}/errors`;
    const qs = new URLSearchParams();
    qs.set('cwd', cwd ?? defaultCwd);
    if (sinceLast) { path += '/since-last'; if (client) qs.set('client', client); }
    else if (since) qs.set('since', since);
    if (level) qs.set('level', level);
    const q = qs.toString();
    const r = await callJson(path + (q ? '?' + q : ''));
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 412) return err(JSON.stringify(r.body));
    if (r.status === 404) return err('unknown app');
    let body = r.body;
    if (structured && Array.isArray(body)) body = body.map((e: any) => e.parsed ?? { message: e.message });
    return ok(body);
  });

  server.registerTool('get_logs', {
    description: 'Get recent log lines for an app.',
    inputSchema: { name: z.string(), tail: z.number().int().positive().optional(), since: z.string().optional(), cwd: cwdField },
  }, async ({ name, tail, since, cwd }) => {
    const qs = new URLSearchParams();
    qs.set('cwd', cwd ?? defaultCwd);
    if (tail) qs.set('tail', String(tail));
    if (since) qs.set('since', since);
    const q = qs.toString();
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/logs${q ? '?' + q : ''}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 412) return err(JSON.stringify(r.body));
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    server.registerTool(`${action}_app`, { description: `${action[0].toUpperCase()}${action.slice(1)} a dev-server app by name. Takes the per-app soft lock; another agent's concurrent call gets a structured locked-by-other-agent error.`, inputSchema: { name: z.string(), cwd: cwdField } }, async ({ name, cwd }) => {
      const qs = new URLSearchParams({ cwd: cwd ?? defaultCwd });
      const r = await callJson(`/api/apps/${encodeURIComponent(name)}/${action}?${qs.toString()}`, 'POST');
      if (r.status === 0) return err(r.body?.error || 'unknown');
      if (r.status === 412) return err(JSON.stringify(r.body));
      return ok(r.body);
    });
  }

  server.registerTool('overview', {
    description: 'Decision-ready snapshot of the workspace: totals, byStatus, needsAttention (with first parsed error per failing app), recentlyChanged. The recommended first call in a session — answers "what is going on right now?" in one round-trip. Pass `budget` (tokens) to cap response size; overflow collapses to _meta.omitted.',
    inputSchema: {
      workspace: z.string().optional(),
      profile: z.string().optional(),
      budget: z.number().int().positive().max(50_000).optional(),
    },
  }, async ({ workspace, profile, budget }) => {
    const qs = new URLSearchParams();
    if (workspace) qs.set('workspace', workspace);
    if (profile) qs.set('profile', profile);
    if (budget) qs.set('budget', String(budget));
    const q = qs.toString();
    const r = await callJson('/api/overview' + (q ? '?' + q : ''));
    if (r.status === 0) return err(r.body?.error || 'unknown');
    return ok(r.body);
  });

  server.registerTool('diff_errors', {
    description: 'Errors that appeared since the last call by this client. Compact list of {file,line,col,code,message,tool}; bounded by `budget` tokens — overflow collapses to {omitted:N}. Use this as the "did my last change introduce new errors?" round-trip.',
    inputSchema: {
      name: z.string(),
      client: z.string().optional(),
      budget: z.number().int().positive().max(50_000).optional(),
    },
  }, async ({ name, client, budget }) => {
    const qs = new URLSearchParams();
    qs.set('client', client || 'mcp-default');
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/errors/since-last?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    const arr = Array.isArray(r.body) ? r.body : [];
    const compact = arr.map((e: any) => ({
      file: e.file ?? null,
      line: e.line ?? null,
      col: e.col ?? null,
      code: e.code ?? null,
      tool: e.tool ?? null,
      message: e.message ?? '',
    }));
    const cap = (budget ?? 800) * 4;
    let omitted = 0;
    let payload: any[] = compact;
    while (JSON.stringify(payload).length > cap && payload.length > 0) {
      payload.pop();
      omitted++;
    }
    return ok({ errors: payload, _meta: { omitted, total: compact.length, budget: budget ?? 800 } });
  });

  server.registerTool('try_fix', {
    description: 'Composite remediation: run doctor --auto-fix for permitted rules, restart the named app, wait for the target state, return {before, after, fixed:[ruleName], stillFailing:[…parsed first 5]}. Never edits user source code, only daemon state. Pair with `focus` for narration; use this for the action.',
    inputSchema: {
      name: z.string(),
      until: z.enum(['serving', 'healthy']).optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    },
  }, async ({ name, until, timeoutMs }) => {
    const qs = new URLSearchParams();
    qs.set('until', until || 'healthy');
    qs.set('timeoutMs', String(Math.min(timeoutMs ?? 180_000, 600_000)));
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/try-fix?${qs.toString()}`, 'POST');
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  server.registerTool('focus', {
    description: 'Single round-trip "subscribe-then-act" snapshot for one app: starts the app if stopped, then narrates status/error/health events until target state (serving|healthy|stable) or timeout. Returns the captured event list plus final state. Use as a coherent narrative instead of polling.',
    inputSchema: {
      name: z.string(),
      until: z.enum(['serving', 'healthy', 'stable']).optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    },
  }, async ({ name, until, timeoutMs }) => {
    const qs = new URLSearchParams();
    qs.set('until', until || 'healthy');
    qs.set('timeoutMs', String(Math.min(timeoutMs ?? 180_000, 600_000)));
    await ensureDaemon();
    try {
      const res = await fetch(BASE() + `/api/apps/${encodeURIComponent(name)}/focus?${qs.toString()}`, { method: 'POST', headers: headers() });
      if (res.status === 404) return err('unknown app');
      if (!res.body) return err('no response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const events: any[] = [];
      let final: any = null;
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const ln of lines) {
          const t = ln.trim();
          if (!t) continue;
          try {
            const ev = JSON.parse(t);
            if (ev.kind === 'done') final = ev;
            else events.push(ev);
          } catch {}
        }
      }
      return ok({ events, final });
    } catch (e: any) {
      return err(e?.message || String(e));
    }
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

  server.registerTool('orchestrate', {
    description: 'Bring up an entire profile in one MCP call: cascade-start every app via depends-order, wait until each reaches the goal, and run ONE round of try-fix on stragglers. Returns { profile, goal, perApp:[{name, reached, tries, fixed?, stillFailing?}], totalMs, allReached }. goal=stable means serving+healthy+5s idle. Honors --budget (drops stillFailing first when over-budget). --dryRun reports planned order + currently-unhealthy apps without starting anything. Recommended way to "bring up my whole workspace" in one call.',
    inputSchema: {
      profile: z.string(),
      goal: z.enum(['serving', 'healthy', 'stable']).optional(),
      timeoutMs: z.number().int().positive().max(1_200_000).optional(),
      dryRun: z.boolean().optional(),
      budget: z.number().int().positive().optional(),
    },
  }, async ({ profile, goal, timeoutMs, dryRun, budget }) => {
    const qs = new URLSearchParams();
    qs.set('profile', profile);
    qs.set('goal', goal || 'healthy');
    qs.set('timeoutMs', String(Math.min(timeoutMs ?? 300_000, 1_200_000)));
    if (dryRun) qs.set('dryRun', 'true');
    if (typeof budget === 'number') qs.set('budget', String(budget));
    const r = await callJson(`/api/orchestrate?${qs.toString()}`, 'POST');
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err(r.body?.error || 'unknown profile');
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

  server.registerTool('daimon_frameworks', {
    description: 'List the framework adapter registry (M65): built-in + custom profiles with detection markers, command, readiness/url patterns, badge/tone, per-profile match counts and which apps each matched. Use to understand what frameworks daimon recognises in the configured workspaces.',
    inputSchema: {},
  }, async () => {
    const r = await callJson('/api/frameworks');
    if (r.status === 0) return err(r.body?.error || 'unknown');
    return ok(r.body);
  });

  server.registerTool('daimon_search', {
    description: 'Full-text search over everything daimon has seen — per-app log lines, errors, and events (FTS5; falls back to LIKE with fallback:true). Returns compact hits { kind, app, ts, snippet, ref }. A trailing * on a term does prefix search.',
    inputSchema: {
      q: z.string(),
      app: z.string().optional(),
      since: z.string().optional().describe('Duration window like 30m, 24h, 7d'),
      kind: z.enum(['logs', 'errors', 'events']).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  }, async ({ q, app, since, kind, limit }) => {
    const qs = new URLSearchParams({ q });
    if (app) qs.set('app', app);
    if (since) qs.set('since', since);
    if (kind) qs.set('kind', kind);
    if (limit) qs.set('limit', String(limit));
    const r = await callJson('/api/search?' + qs.toString());
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 400) return err(r.body?.error || 'bad search query');
    return ok(r.body);
  });

  server.registerTool('daimon_run_tests', {
    description: 'Run the app\'s own test suite once (daimon wraps the project\'s runner — vitest/jest/pytest/go/cargo/dotnet or overrides.<app>.testCommand; it never installs one). Returns parsed failures {suite,test,file,line,message,fingerprint} + totals; the run is recorded in history. Takes the per-app soft lock — a concurrent run by another agent returns locked-by-other-agent.',
    inputSchema: {
      name: z.string(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
      cwd: cwdField,
    },
  }, async ({ name, timeoutMs, cwd }) => {
    const qs = new URLSearchParams({ cwd: cwd ?? defaultCwd });
    qs.set('timeoutMs', String(Math.min(timeoutMs ?? 300_000, 600_000)));
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/test?${qs.toString()}`, 'POST');
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    if (r.status === 412) return err(JSON.stringify(r.body));
    if (r.status === 409) return err(JSON.stringify(r.body));
    return ok(r.body);
  });

  server.registerTool('daimon_why', {
    description: 'One-shot forensics for a broken app: current status/health, last crash report (exit code, signal, uptime, last log lines, gitHead), fingerprint-grouped 24h errors, recent regressions, restart-storm state, suspect commit, and matching doctor findings. Use before digging through logs manually.',
    inputSchema: { name: z.string(), cwd: cwdField },
  }, async ({ name, cwd }) => {
    const qs = new URLSearchParams({ cwd: cwd ?? defaultCwd });
    const r = await callJson(`/api/why/${encodeURIComponent(name)}?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    if (r.status === 412) return err(JSON.stringify(r.body));
    return ok(r.body);
  });

  server.registerTool('daimon_report', {
    description: 'The digest (M83): what happened over a window — per-app uptime %, error groups (new/recurring/resolved), test pass-rate + flakiest tests, compile p50/p95 + regressions, crashes/storms, agent activity, env changes (key names only, never values). Sections with no data degrade to { note }. Use for "summarize the last day/week" questions.',
    inputSchema: {
      since: z.string().optional().describe('Window like 24h or 7d (default 24h)'),
      app: z.string().optional(),
      workspace: z.string().optional(),
    },
  }, async ({ since, app, workspace }) => {
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    if (app) qs.set('app', app);
    if (workspace) qs.set('workspace', workspace);
    const q = qs.toString();
    const r = await callJson('/api/report' + (q ? '?' + q : ''));
    if (r.status === 0) return err(r.body?.error || 'unknown');
    return ok(r.body);
  });

  server.registerTool('daimon_env', {
    description: 'Read-only env-file awareness (M82): the app\'s convention env files (found/missing), key NAMES from the latest spawn snapshot, and snapshot age — or, with diff=true, files/keys added/removed/changed between the last two spawns. Values are NEVER included (redacted at the storage layer); open the file itself to see one.',
    inputSchema: {
      name: z.string(),
      diff: z.boolean().optional().describe('Compare the last two spawn snapshots instead of showing the latest'),
      cwd: cwdField,
    },
  }, async ({ name, diff, cwd }) => {
    const qs = new URLSearchParams({ cwd: cwd ?? defaultCwd });
    const path = `/api/env/${encodeURIComponent(name)}${diff ? '/diff' : ''}`;
    const r = await callJson(`${path}?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    if (r.status === 412) return err(JSON.stringify(r.body));
    return ok(r.body);
  });

  server.registerTool('daimon_context', {
    description: 'The agent context pack: one call assembling status/url/framework/uptime, top error groups, last crash, last test run + failures, compile stats, suspect commits, and active locks/agents for an app. Pass budget (chars) to cap the payload — sections drop lowest-priority-first and are listed in truncated[]. Call this FIRST when debugging an app, then follow up with targeted calls.',
    inputSchema: {
      name: z.string(),
      budget: z.number().int().positive().max(200_000).optional(),
      cwd: cwdField,
    },
  }, async ({ name, budget, cwd }) => {
    const qs = new URLSearchParams({ cwd: cwd ?? defaultCwd });
    if (budget) qs.set('budget', String(budget));
    const r = await callJson(`/api/context/${encodeURIComponent(name)}?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    if (r.status === 412) return err(JSON.stringify(r.body));
    return ok(r.body);
  });

  server.registerTool('daimon_who_owns', {
    description: 'Return the current soft-lock holder for an app (if any) and the last 3 agents who interacted with it. Use before start/stop/restart to avoid stepping on another agent.',
    inputSchema: { name: z.string(), cwd: cwdField },
  }, async ({ name, cwd }) => {
    const qs = new URLSearchParams({ cwd: cwd ?? defaultCwd });
    const r = await callJson(`/api/apps/${encodeURIComponent(name)}/lock?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    if (r.status === 404) return err('unknown app');
    return ok(r.body);
  });

  server.registerTool('daimon_subscribe_events', {
    description: 'Long-poll for new daimon events. Returns events newer than `sinceMs` (default 60s) for `app` (or all apps), filtered by `kinds` (status, error, warning, lint, health, restart, bundle, task, regression). When nothing has happened yet the daemon holds the request open up to `waitMs` (default 25s) and returns the next event as it lands — no sleeping needed.',
    inputSchema: {
      app: z.string().optional(),
      kinds: z.array(z.string()).optional(),
      sinceMs: z.number().int().positive().max(86_400_000).optional(),
      waitMs: z.number().int().min(0).max(55_000).optional(),
    },
  }, async ({ app, kinds, sinceMs, waitMs }) => {
    const qs = new URLSearchParams();
    qs.set('since', String(sinceMs ?? 60_000) + 'ms');
    qs.set('waitMs', String(waitMs ?? 25_000));
    if (app) qs.set('app', app);
    const r = await callJson(`/api/events?${qs.toString()}`);
    if (r.status === 0) return err(r.body?.error || 'unknown');
    let arr = Array.isArray(r.body) ? r.body : [];
    if (kinds && kinds.length) {
      const want = new Set(kinds);
      arr = arr.filter((e: any) => {
        const t: string = e.type ?? '';
        if (t === 'status' && want.has('status')) return true;
        if ((t === 'error-new' || t === 'error-recur') && want.has('error')) return true;
        if ((t === 'warning-new' || t === 'warning-recur') && want.has('warning')) return true;
        if ((t === 'lint-new' || t === 'lint-recur') && want.has('lint')) return true;
        if (t === 'health' && want.has('health')) return true;
        if ((t === 'restart-scheduled' || t === 'compile-regression' || t === 'bundle-regression') && want.has('restart')) return true;
        if (t === 'bundle' && want.has('bundle')) return true;
        if (t === 'task-run' && want.has('task')) return true;
        if (t === 'regression-detected' && want.has('regression')) return true;
        return false;
      });
    }
    return ok(arr);
  });

  server.registerTool('daimon_notify_on_error', {
    description: 'Block (up to `timeoutMs`) until the next error-new event for `app`. Convenience wrapper around daimon_subscribe_events for the common "tell me when this app errors" pattern. Returns { error, ts } on hit, { timedOut: true } on timeout.',
    inputSchema: {
      app: z.string(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    },
  }, async ({ app, timeoutMs }) => {
    const budget = Math.min(timeoutMs ?? 60_000, 600_000);
    const start = Date.now();
    while (Date.now() - start < budget) {
      const since = Math.max(500, Date.now() - start);
      const waitMs = Math.max(0, Math.min(55_000, budget - (Date.now() - start)));
      const qs = new URLSearchParams({ since: since + 'ms', app, waitMs: String(waitMs) });
      const r = await callJson(`/api/events?${qs.toString()}`);
      if (r.status === 0) return err(r.body?.error || 'unknown');
      const arr = Array.isArray(r.body) ? r.body : [];
      const hit = arr.find((e: any) => e.type === 'error-new');
      if (hit) return ok({ error: hit, waitedMs: Date.now() - start });
      // Non-error events came back — brief pause so a chatty app can't pin the loop.
      if (arr.length) await new Promise(res => setTimeout(res, 500));
    }
    return ok({ timedOut: true, waitedMs: Date.now() - start });
  });

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
})();

if (invokedDirectly) {
  main().catch(err => {
    process.stderr.write(`[daimon-mcp] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
