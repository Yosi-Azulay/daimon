#!/usr/bin/env node
import { loadConfig } from './config.js';
import { discoverApps } from './discovery.js';
import { runDoctor } from './doctor.js';
import { findPortHolder, killHolder } from './portDiag.js';
import { readSession } from './session.js';
import { readLock, spawnDetached, waitForExit, removeLock } from './daemon.js';
import { APPMAN_VERSION } from './version.js';
import { CLI_SUBCOMMANDS, findSubcommand, usageString } from './cliSurface.js';
import {
  checkVersionDriftAndNudge,
  COMMAND_NAMES as CLAUDE_COMMAND_NAMES,
  defaultClaudeDir,
  install as claudeInstall,
  readManifest as readClaudeManifest,
  status as claudeStatus,
  uninstall as claudeUninstall,
} from './claude.js';

const nodeMajor = Number((process.versions.node || '0').split('.')[0]);
if (nodeMajor && nodeMajor < 20) {
  process.stderr.write('appman requires Node >= 20\n');
  process.exit(1);
}

let noSpawnFlag = false;

function fail(msg: string, code = 1): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function readApiPort(): number {
  if (process.env.APPMAN_PORT) {
    const p = Number(process.env.APPMAN_PORT);
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

async function ensureDaemon(): Promise<void> {
  if (noSpawnFlag || process.env.APPMAN_NO_SPAWN === '1') return;
  if (readLock()) return;
  try {
    const port = process.env.APPMAN_PORT ? Number(process.env.APPMAN_PORT) : undefined;
    await spawnDetached({ port: Number.isFinite(port as number) && (port as number) > 0 ? (port as number) : undefined });
  } catch {}
}

function authHeaders(): Record<string, string> {
  const tok = process.env.APPMAN_TOKEN;
  return tok ? { authorization: `Bearer ${tok}` } : {};
}

async function call(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: authHeaders() });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } catch {
    fail(JSON.stringify({ error: 'appman is not running — start it with: appman daemon start --detach' }));
  }
}

async function callJson(pathname: string, method: 'GET' | 'POST', payload: unknown): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } catch {
    fail(JSON.stringify({ error: 'appman is not running — start it with: appman daemon start --detach' }));
  }
}

interface ClaudeFlags {
  skill?: boolean;
  commands?: boolean;
  agent?: boolean;
  all?: boolean;
  dir?: string;
  yes?: boolean;
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
  detach?: boolean;
  workspace?: string;
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
    else if (a === '--detach') f.detach = true;
    else if (a === '--workspace') f.workspace = args[++i];
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

function printHelp(): void {
  const w = Math.max(...CLI_SUBCOMMANDS.map(c => c.name.length));
  const lines = [
    `appman v${APPMAN_VERSION}`,
    'usage: appman <command> [args]',
    '',
  ];
  for (const c of CLI_SUBCOMMANDS) {
    lines.push(`  ${c.name.padEnd(w)}  ${c.summary}`);
  }
  lines.push('');
  lines.push('Flags: --no-spawn (skip auto-spawn), APPMAN_PORT=N (target a non-default daemon), APPMAN_NO_SPAWN=1');
  process.stdout.write(lines.join('\n') + '\n');
}

function parseClaudeFlags(args: string[]): { positional: string[]; flags: ClaudeFlags } {
  const flags: ClaudeFlags = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--skill') flags.skill = true;
    else if (a === '--commands') flags.commands = true;
    else if (a === '--agent') flags.agent = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--dir') flags.dir = args[++i];
    else if (a === '--yes') flags.yes = true;
    else positional.push(a);
  }
  return { positional, flags };
}

async function handleClaude(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (!sub) fail(JSON.stringify({ error: 'usage: appman claude <install|update|uninstall|status> [--skill] [--commands] [--agent] [--all] [--dir <path>] [--yes]' }));
  const { flags } = parseClaudeFlags(rest.slice(1));
  const dir = flags.dir ?? defaultClaudeDir();
  const apiPort = readApiPort();

  if (sub === 'status') {
    out(claudeStatus(dir));
    return;
  }

  if (sub === 'install') {
    let selection: { skill: boolean; commands: boolean; agent: boolean };
    const anyFlag = flags.skill || flags.commands || flags.agent || flags.all;
    if (flags.all || flags.yes || (!anyFlag && !process.stdin.isTTY)) {
      selection = { skill: true, commands: true, agent: true };
    } else if (!anyFlag) {
      const { promptClaudeInstall } = await import('./tui/ClaudeInstallPrompt.js');
      const picked = await promptClaudeInstall();
      if (!picked) { out({ cancelled: true }); return; }
      selection = picked;
    } else {
      selection = { skill: !!flags.skill, commands: !!flags.commands, agent: !!flags.agent };
    }
    const r = claudeInstall({ ...selection, dir, apiPort });
    out({ installed: r.installed, manifest: r.manifestPath, version: APPMAN_VERSION });
    return;
  }

  if (sub === 'update') {
    const m = readClaudeManifest(dir);
    if (!m) fail(JSON.stringify({ error: 'no manifest at ' + dir + ' — run `appman claude install` first' }));
    const selection = {
      skill: !!m!.skill,
      commands: !!(m!.commands && m!.commands.length),
      agent: !!m!.agent,
    };
    const r = claudeInstall({ ...selection, dir, apiPort });
    out({ updated: r.installed, manifest: r.manifestPath, version: APPMAN_VERSION });
    return;
  }

  if (sub === 'uninstall') {
    const anyFlag = flags.skill || flags.commands || flags.agent || flags.all;
    if (!anyFlag) fail(JSON.stringify({ error: 'usage: appman claude uninstall [--all|--skill|--commands|--agent]' }));
    const r = claudeUninstall({ dir, selection: { all: flags.all, skill: flags.skill, commands: flags.commands, agent: flags.agent } });
    out({ removed: r.removed, manifest: r.manifestPath });
    return;
  }

  fail(JSON.stringify({ error: `unknown claude subcommand: ${sub}` }));
  void CLAUDE_COMMAND_NAMES;
}

async function handleDaemon(rest: string[]): Promise<void> {
  const sub = rest[0];
  const f = parseFlags(rest.slice(1));
  switch (sub) {
    case 'status': {
      const lock = readLock();
      if (!lock) { out({ running: false }); return; }
      const uptime = Date.now() - lock.startedAt;
      out({ running: true, pid: lock.pid, port: lock.apiPort, uptime, version: lock.version, headless: lock.headless });
      return;
    }
    case 'start': {
      if (f.detach) {
        const existing = readLock();
        if (existing) { out({ ok: true, alreadyRunning: true, pid: existing.pid, port: existing.apiPort }); return; }
        try {
          const port = process.env.APPMAN_PORT ? Number(process.env.APPMAN_PORT) : undefined;
          const info = await spawnDetached({ port: Number.isFinite(port as number) && (port as number) > 0 ? (port as number) : undefined });
          out({ ok: true, pid: info.pid, port: info.apiPort });
        } catch (err: any) {
          fail(JSON.stringify({ error: err?.message || String(err) }));
        }
        return;
      }
      const { startInProcess } = await import('./main.js');
      await startInProcess({ headless: !!f.headless });
      return;
    }
    case 'stop': {
      const lock = readLock();
      if (!lock) { out({ ok: true, wasRunning: false }); return; }
      try {
        await fetch(`http://127.0.0.1:${lock.apiPort}/api/shutdown`, { method: 'POST', headers: authHeaders() });
      } catch {}
      const exited = await waitForExit(lock.pid, 5000);
      if (exited) {
        removeLock();
        out({ ok: true, wasRunning: true });
      } else {
        try { process.kill(lock.pid, 'SIGTERM'); } catch {}
        await waitForExit(lock.pid, 2000);
        removeLock();
        out({ ok: true, wasRunning: true, forced: true });
      }
      return;
    }
    case 'restart': {
      const lock = readLock();
      if (lock) {
        try { await fetch(`http://127.0.0.1:${lock.apiPort}/api/shutdown`, { method: 'POST', headers: authHeaders() }); } catch {}
        await waitForExit(lock.pid, 5000);
        removeLock();
      }
      const port = process.env.APPMAN_PORT ? Number(process.env.APPMAN_PORT) : undefined;
      const info = await spawnDetached({ port: Number.isFinite(port as number) && (port as number) > 0 ? (port as number) : undefined });
      out({ ok: true, pid: info.pid, port: info.apiPort });
      return;
    }
    case 'attach': {
      await ensureDaemon();
      const lock = readLock();
      if (!lock) fail(JSON.stringify({ error: 'no daemon running and auto-spawn failed' }));
      const { attachToDaemon } = await import('./tui/AttachApp.js');
      await attachToDaemon(lock!.apiPort);
      return;
    }
    case 'install-service': {
      const { installServiceArtifact } = await import('./serviceInstaller.js');
      const r = installServiceArtifact();
      out({ platform: r.platform, artifact: r.path, installCmd: r.installCmd });
      return;
    }
    default:
      fail(JSON.stringify({ error: `usage: appman daemon <start|stop|status|restart|attach|install-service> [--detach] [--headless]` }));
  }
}

async function main() {
  const argv = process.argv.slice(2).filter(a => {
    if (a === '--no-spawn') { noSpawnFlag = true; return false; }
    return true;
  });

  const [cmd, ...rest] = argv;

  try { checkVersionDriftAndNudge(); } catch {}

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { printHelp(); return; }
  if (cmd === '--version' || cmd === '-v') { out({ version: APPMAN_VERSION }); return; }

  if (cmd === 'daemon') { await handleDaemon(rest); return; }
  if (cmd === 'claude') { await handleClaude(rest); return; }
  if (cmd === 'init') {
    const { runInit } = await import('./init.js');
    const fParsed = parseFlags(rest);
    try {
      const r = await runInit({ force: !!fParsed.force });
      out({ path: r.path, installClaude: r.installClaude });
      if (r.installClaude) {
        const apiPort = readApiPort();
        const inst = claudeInstall({ skill: true, commands: true, agent: true, dir: defaultClaudeDir(), apiPort });
        out({ claudeInstalled: inst.installed });
      }
    } catch (err: any) {
      fail(JSON.stringify({ error: err?.message || String(err) }));
    }
    return;
  }

  const f = parseFlags(rest);
  const surface = findSubcommand(cmd);
  if (surface?.needsDaemon) await ensureDaemon();

  switch (cmd) {
    case 'list': {
      const r = await call('/api/apps');
      let arr = Array.isArray(r.body) ? r.body : [];
      if (f.tags.length) arr = arr.filter((a: any) => f.tags.every(t => (a.tags || []).includes(t)));
      if (f.workspace) arr = arr.filter((a: any) => a.workspaceLabel === f.workspace);
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
    case 'env': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman env <name> [--use <file>]' }));
      if (f.use) {
        const r = await callJson(`/api/apps/${encodeURIComponent(name)}/env`, 'POST', { use: f.use });
        if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
        out(r.body);
        return;
      }
      const r = await call(`/api/apps/${encodeURIComponent(name)}/env`);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'clean': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: appman clean <name> [--deep] [--yes]' }));
      const qs = new URLSearchParams();
      if (f.deep) qs.set('deep', '1');
      if (f.yes) qs.set('yes', '1');
      const r = await call(`/api/apps/${encodeURIComponent(name)}/clean${qs.toString() ? '?' + qs.toString() : ''}`, 'POST');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      if (r.status === 409) { out(r.body); process.exit(1); }
      out(r.body);
      return;
    }
    case 'record': {
      const r = await call('/api/session/record?action=toggle', 'POST');
      out(r.body);
      return;
    }
    case 'replay': {
      const file = f.positional[0];
      if (!file) fail(JSON.stringify({ error: 'usage: appman replay <session.jsonl> [--speed N]' }));
      const speed = f.speed && f.speed > 0 ? f.speed : 1;
      let ops;
      try { ops = readSession(file); } catch (err: any) { fail(JSON.stringify({ error: err?.message || String(err) })); }
      let prev = 0;
      for (const op of ops) {
        const gap = Math.max(0, (op.ts - prev) / speed);
        if (gap > 0) await new Promise(r => setTimeout(r, gap));
        prev = op.ts;
        if (op.kind === 'run') {
          await callJson(`/api/apps/${encodeURIComponent(op.app)}/run/${encodeURIComponent(op.task || '')}`, 'POST', { args: op.args || [] });
        } else {
          await call(`/api/apps/${encodeURIComponent(op.app)}/${op.kind}`, 'POST');
        }
      }
      out({ replayed: ops.length, file });
      return;
    }
    case 'doctor': {
      const cfgR = loadConfig();
      if (cfgR.kind !== 'loaded') fail(JSON.stringify({ error: 'no config loaded' }));
      const warnings: string[] = [];
      const apps = discoverApps(cfgR.config, { warnings });
      const result = await runDoctor(cfgR.config, apps);
      for (const w of warnings) {
        result.checks.unshift({ name: `discovery: ${w}`, ok: false, detail: w });
      }
      if (warnings.length) result.ok = false;
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
      fail(JSON.stringify({ error: `unknown command: ${cmd}. ${usageString()}` }));
  }
}

main().catch(err => fail(JSON.stringify({ error: err?.message || String(err) })));
