#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { discoverApps } from './discovery.js';
import { runDoctor } from './doctor.js';
import { findPortHolder, killHolder } from './portDiag.js';
import { readSession } from './session.js';
import { readLock, spawnDetached, waitForExit, removeLock } from './daemon.js';
import { DAIMON_VERSION } from './version.js';
import { generateAgentId } from './agents.js';

// Stable per-session agent id. Generated once per CLI process, exported through
// the X-Daimon-Agent header so the daemon can tell two Claudes apart and
// recorded in the audit log's 6th column.
const AGENT_ID = generateAgentId();
import { CLI_SUBCOMMANDS, CLI_ALIASES, findSubcommand, usageString } from './cliSurface.js';
import {
  setColorOverride,
  isColorEnabled,
  color,
  renderMainHelp,
  renderSubcommandHelp,
  suggestCommand,
  suggestApp,
  formatError,
  formatHumanError,
  emitCompletion,
} from './cliHelp.js';
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
  process.stderr.write('daimon requires Node >= 20\n');
  process.exit(1);
}

let noSpawnFlag = false;
let helpRequested = false;

function fail(msg: string, code = 1): never {
  if (msg.startsWith('{')) {
    try {
      const parsed = JSON.parse(msg);
      const exit = typeof parsed.exit === 'number' ? parsed.exit : code;
      if (isColorEnabled()) {
        process.stderr.write(formatHumanError({ error: parsed.error ?? msg, hint: parsed.hint }) + '\n');
      } else {
        process.stderr.write(JSON.stringify({ error: parsed.error, ...(parsed.hint ? { hint: parsed.hint } : {}), exit }) + '\n');
      }
      process.exit(exit);
    } catch {}
  }
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function failHint(error: string, hint?: string, exit = 1): never {
  if (isColorEnabled()) {
    process.stderr.write(formatHumanError({ error, hint }) + '\n');
  } else {
    process.stderr.write(formatError({ error, hint, exit }) + '\n');
  }
  process.exit(exit);
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function suggestUnknownApp(name: string): Promise<never> {
  let known: string[] = [];
  try {
    const r = await fetch(getBaseUrl() + '/api/apps', { headers: authHeaders() });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr)) known = arr.map((a: any) => a.name).filter(Boolean);
    }
  } catch {}
  const guess = suggestApp(name, known);
  const hint = guess
    ? `did you mean '${guess}'? — list apps with \`daimon list\``
    : `list available with \`daimon list\``;
  failHint(`unknown app: ${name}`, hint);
}

function readApiPort(): number {
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
  if (noSpawnFlag || process.env.DAIMON_NO_SPAWN === '1') return;
  if (readLock()) return;
  try {
    const port = process.env.DAIMON_PORT ? Number(process.env.DAIMON_PORT) : undefined;
    await spawnDetached({ port: Number.isFinite(port as number) && (port as number) > 0 ? (port as number) : undefined });
  } catch {}
}

// Tells the daemon to register the current cwd as a workspace if it isn't already
// covered by any searchRoot. Best-effort: silently ignores network/auth failures
// so we never block a CLI command on this.
async function ensureCurrentWorkspace(): Promise<void> {
  try {
    const res = await fetch(getBaseUrl() + '/api/workspaces/ensure', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ path: process.cwd() }),
    });
    // 200 either way (added or already-covered). 401/403 means token gate is on and
    // we don't have one — silently skip; the user can still use --all.
    void res;
  } catch {}
}

function authHeaders(): Record<string, string> {
  const tok = process.env.DAIMON_TOKEN;
  const h: Record<string, string> = { 'x-daimon-cwd': process.cwd(), 'x-daimon-agent': AGENT_ID };
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

async function streamNdjson(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<void> {
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: authHeaders() });
    if (!res.ok || !res.body) fail(JSON.stringify({ error: `stream failed: HTTP ${res.status}` }));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(line + '\n');
      }
    }
    if (buf.trim()) process.stdout.write(buf + '\n');
  } catch (err: any) {
    fail(JSON.stringify({ error: err?.message || String(err) }));
  }
}

async function call(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: authHeaders() });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } catch {
    failHint('daimon is not running', 'start it with: daimon daemon start --detach');
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
    failHint('daimon is not running', 'start it with: daimon daemon start --detach');
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
  full?: boolean;
  compact?: boolean;
  profile?: string;
  stream?: boolean;
  explain?: boolean;
  autoFix?: boolean;
  dryRun?: boolean;
  auto?: boolean;
  redacted?: boolean;
  budget?: number;
  accept?: boolean;
  path?: string;
  goal?: string;
  self?: boolean;
  all?: boolean;
  level?: string;
  label?: string;
  kinds?: string;
  open?: boolean;
  steal?: boolean;
  json?: boolean;
  min?: number;
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
    else if (a === '--min' || a === '--min-occurrences') f.min = Number(args[++i]);
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
    else if (a === '--full') f.full = true;
    else if (a === '--compact') f.compact = true;
    else if (a === '--profile') f.profile = args[++i];
    else if (a === '--stream') f.stream = true;
    else if (a === '--explain') f.explain = true;
    else if (a === '--auto-fix') f.autoFix = true;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--auto') f.auto = true;
    else if (a === '--redacted') f.redacted = true;
    else if (a === '--budget') f.budget = Number(args[++i]);
    else if (a === '--accept') f.accept = true;
    else if (a === '--path') f.path = args[++i];
    else if (a === '--goal') f.goal = args[++i];
    else if (a === '--self') f.self = true;
    else if (a === '--all') f.all = true;
    else if (a === '--level') f.level = args[++i];
    else if (a === '--label') f.label = args[++i];
    else if (a === '--kinds') f.kinds = args[++i];
    else if (a === '--open') f.open = true;
    else if (a === '--steal') f.steal = true;
    else if (a === '--json') f.json = true;
    else f.positional.push(a);
  }
  return f;
}

function formatQuery(f: Flags): string {
  if (f.full) return '?format=full';
  if (f.compact) return '?format=compact';
  return '';
}

// Build a `cwd=<process.cwd()>` query fragment for per-app commands, unless
// the user explicitly opted out with --all or pinned a workspace label.
function scopeQs(f: Flags): URLSearchParams {
  const qs = new URLSearchParams();
  if (!f.all && !f.workspace) qs.set('cwd', process.cwd());
  return qs;
}

// Pretty-print the 412 name-collision body that the server returns when a
// baseName matches more than one workspace. Exits with code 4.
function reportCollisionAndExit(body: any): never {
  const cands: any[] = Array.isArray(body?.candidates) ? body.candidates : [];
  process.stderr.write(`error: ${body?.error || 'name-collision'}\n`);
  if (body?.hint) process.stderr.write(`hint: ${body.hint}\n`);
  if (cands.length) {
    process.stderr.write('candidates:\n');
    for (const c of cands) {
      const label = c.workspaceLabel ? ` [${c.workspaceLabel}]` : '';
      process.stderr.write(`  - ${c.name}${label}  (${c.workspaceRoot ?? '?'})\n`);
    }
  }
  out({ error: body?.error || 'name-collision', candidates: cands });
  process.exit(4);
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
  process.stdout.write(renderMainHelp() + '\n');
}

function printSubHelp(name: string): boolean {
  const c = findSubcommand(name);
  if (!c) return false;
  process.stdout.write(renderSubcommandHelp(c) + '\n');
  return true;
}

function printAbout(): void {
  const lock = readLock();
  let configPath: string | null = null;
  try {
    const r = loadConfig();
    if (r.kind === 'loaded') configPath = r.path;
  } catch {}
  const lockPath = path.join(os.homedir(), '.daimon', 'lock.json');
  const claudeArtifacts: string[] = [];
  try {
    const m = readClaudeManifest(defaultClaudeDir());
    if (m) {
      if (m.skill) claudeArtifacts.push('skill');
      if (m.agent) claudeArtifacts.push('agent');
      if (Array.isArray((m as any).commands) && (m as any).commands.length) claudeArtifacts.push('commands');
    }
  } catch {}
  out({
    version: DAIMON_VERSION,
    nodeVersion: process.versions.node,
    platform: process.platform,
    configPath,
    lockPath,
    running: !!lock,
    runningPid: lock?.pid ?? null,
    runningPort: lock?.apiPort ?? null,
    claudeArtifacts,
  });
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
  if (!sub) fail(JSON.stringify({ error: 'usage: daimon claude <install|update|uninstall|status> [--skill] [--commands] [--agent] [--all] [--dir <path>] [--yes]' }));
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
      selection = { skill: true, commands: false, agent: true };
    } else if (!anyFlag) {
      const { promptClaudeInstall } = await import('./tui/ClaudeInstallPrompt.js');
      const picked = await promptClaudeInstall();
      if (!picked) { out({ cancelled: true }); return; }
      selection = { skill: picked.skill, commands: false, agent: picked.agent };
    } else {
      selection = { skill: !!flags.skill, commands: false, agent: !!flags.agent };
    }
    const r = claudeInstall({
      ...selection, dir, apiPort,
      onMigrationEvent: ev => {
        if (ev.kind === 'removed') out({ removed: ev.file });
        else out({ warning: `${ev.file} was modified; backing up to ${ev.file}.bak` });
      },
    });
    out({ installed: r.installed, manifest: r.manifestPath, version: DAIMON_VERSION });
    return;
  }

  if (sub === 'update') {
    const m = readClaudeManifest(dir);
    if (!m) fail(JSON.stringify({ error: 'no manifest at ' + dir + ' — run `daimon claude install` first' }));
    const selection = {
      skill: !!m!.skill,
      commands: false,
      agent: !!m!.agent,
    };
    const r = claudeInstall({
      ...selection, dir, apiPort,
      onMigrationEvent: ev => {
        if (ev.kind === 'removed') out({ removed: ev.file });
        else out({ warning: `${ev.file} was modified; backing up to ${ev.file}.bak` });
      },
    });
    out({ updated: r.installed, manifest: r.manifestPath, version: DAIMON_VERSION });
    return;
  }

  if (sub === 'uninstall') {
    const anyFlag = flags.skill || flags.commands || flags.agent || flags.all;
    if (!anyFlag) fail(JSON.stringify({ error: 'usage: daimon claude uninstall [--all|--skill|--commands|--agent]' }));
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
          const port = process.env.DAIMON_PORT ? Number(process.env.DAIMON_PORT) : undefined;
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
        try { await fetch(`http://127.0.0.1:${lock.apiPort}/api/snapshot-state`, { method: 'POST', headers: authHeaders() }); } catch {}
        try { await fetch(`http://127.0.0.1:${lock.apiPort}/api/shutdown`, { method: 'POST', headers: authHeaders() }); } catch {}
        await waitForExit(lock.pid, 5000);
        removeLock();
      }
      const port = process.env.DAIMON_PORT ? Number(process.env.DAIMON_PORT) : undefined;
      const info = await spawnDetached({ port: Number.isFinite(port as number) && (port as number) > 0 ? (port as number) : undefined });
      out({ ok: true, pid: info.pid, port: info.apiPort, handoff: true });
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
      fail(JSON.stringify({ error: `usage: daimon daemon <start|stop|status|restart|attach|install-service> [--detach] [--headless]` }));
  }
}

async function main() {
  const argv = process.argv.slice(2).filter(a => {
    if (a === '--no-spawn') { noSpawnFlag = true; return false; }
    if (a === '--no-color') { setColorOverride('off'); return false; }
    if (a === '--help' || a === '-h') { helpRequested = true; return false; }
    return true;
  });

  let [cmd, ...rest] = argv;

  try { checkVersionDriftAndNudge(); } catch {}

  if (!cmd && helpRequested) { printHelp(); return; }
  if (!cmd) { printHelp(); return; }
  if (cmd === 'help') { const sub = rest[0]; if (sub && printSubHelp(sub)) return; printHelp(); return; }
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(DAIMON_VERSION + '\n'); return; }
  if (cmd === '--about') { printAbout(); return; }

  if (CLI_ALIASES[cmd]) cmd = CLI_ALIASES[cmd];

  if (helpRequested) {
    if (printSubHelp(cmd)) return;
    printHelp();
    return;
  }

  if (cmd === 'completion') {
    const shell = rest[0];
    if (!shell) failHint('missing shell', 'usage: daimon completion <bash|zsh|fish|powershell>');
    const r = emitCompletion(shell);
    if (!r.ok) failHint(r.error, 'supported shells: bash, zsh, fish, powershell');
    process.stdout.write(r.script);
    return;
  }

  if (cmd === 'self') {
    await ensureDaemon();
    const r = await call('/api/self');
    if (r.status === 404) failHint('self endpoint not available', 'daemon may be from an older daimon version — run `daimon daemon restart`');
    out(r.body);
    return;
  }

  if (cmd === 'plugin') {
    const sub = rest[0];
    if (!sub) failHint('missing subcommand', 'usage: daimon plugin <list|show <name>|validate <path>>');
    if (sub === 'list') {
      await ensureDaemon();
      const r = await call('/api/plugins');
      out(r.body);
      return;
    }
    if (sub === 'show') {
      const name = rest[1];
      if (!name) failHint('missing plug-in name', 'usage: daimon plugin show <name>');
      await ensureDaemon();
      const r = await call('/api/plugins');
      const arr: any[] = Array.isArray(r.body) ? r.body : [];
      const match = arr.find(p => p.name === name);
      if (!match) failHint(`unknown plug-in: ${name}`, 'list installed plug-ins with: daimon plugin list');
      out(match);
      return;
    }
    if (sub === 'validate') {
      const p = rest[1];
      if (!p) failHint('missing file path', 'usage: daimon plugin validate <path>');
      const { validatePluginFile } = await import('./plugins.js');
      const r = await validatePluginFile(path.resolve(p));
      out(r);
      if (!r.ok) process.exit(1);
      return;
    }
    failHint(`unknown plugin subcommand: ${sub}`, 'usage: daimon plugin <list|show <name>|validate <path>>');
  }

  if (cmd === 'workspaces') {
    await ensureDaemon();
    const sub = rest[0];
    const f2 = parseFlags(rest.slice(1));
    if (!sub || sub === 'list') {
      const r = await call('/api/workspaces');
      out(r.body);
      return;
    }
    if (sub === 'add') {
      const p = f2.positional[0] || process.cwd();
      const payload: any = { path: path.resolve(p) };
      if (f2.label) payload.label = f2.label;
      const r = await callJson('/api/workspaces/ensure', 'POST', payload);
      out(r.body);
      return;
    }
    if (sub === 'rm' || sub === 'remove') {
      const p = f2.positional[0];
      if (!p) failHint('missing path', 'usage: daimon workspaces rm <path>');
      const r = await callJson('/api/workspaces/remove', 'POST', { path: path.resolve(p) });
      if (r.status === 404) failHint(`not registered: ${p}`, `run 'daimon workspaces list' to see registered searchRoots`);
      out(r.body);
      return;
    }
    if (sub === 'show') {
      const p = f2.positional[0] || process.cwd();
      const r = await call('/api/workspaces/resolve?cwd=' + encodeURIComponent(path.resolve(p)));
      out(r.body);
      return;
    }
    failHint(`unknown workspaces subcommand: ${sub}`, 'usage: daimon workspaces <list|add|rm|show> [--label <name>]');
  }

  if (cmd === 'dashboard') {
    await ensureDaemon();
    const lock = readLock();
    const port = lock?.apiPort ?? readApiPort();
    const url = `http://127.0.0.1:${port}/?cwd=${encodeURIComponent(process.cwd())}`;
    // Best-effort open. Falls back to printing the URL when no opener is found.
    const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const { spawn } = await import('node:child_process');
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {}
    out({ url, cwd: process.cwd() });
    return;
  }

  if (cmd === 'daemon') { await handleDaemon(rest); return; }
  if (cmd === 'claude') { await handleClaude(rest); return; }
  if (cmd === 'export-config') {
    const cfgR = loadConfig();
    if (cfgR.kind !== 'loaded') fail(JSON.stringify({ error: 'no config loaded' }));
    const fParsed = parseFlags(rest);
    const cfg: any = JSON.parse(JSON.stringify(cfgR.config));
    if (fParsed.redacted) {
      const home = os.homedir().replace(/\\/g, '/');
      const redactPath = (p: any): any => {
        if (typeof p !== 'string') return p;
        const normalized = p.replace(/\\/g, '/');
        if (normalized.toLowerCase().startsWith(home.toLowerCase())) {
          return '~' + normalized.slice(home.length);
        }
        return p;
      };
      if (cfg.apiToken != null && cfg.apiToken !== '') cfg.apiToken = '<redacted>';
      if (cfg.history?.path) cfg.history.path = redactPath(cfg.history.path);
      if (cfg.logs?.dir) cfg.logs.dir = redactPath(cfg.logs.dir);
      if (Array.isArray(cfg.searchRoots)) {
        cfg.searchRoots = cfg.searchRoots.map((sr: any) =>
          typeof sr === 'string' ? redactPath(sr) : { ...sr, path: redactPath(sr.path) }
        );
      }
    }
    out(cfg);
    return;
  }
  if (cmd === 'discover') {
    await ensureDaemon();
    const r = await call('/api/discovery/explain');
    if (r.status !== 200) fail(JSON.stringify({ error: 'discovery failed', status: r.status }));
    out(r.body);
    return;
  }
  if (cmd === 'init') {
    const { runInit } = await import('./init.js');
    const fParsed = parseFlags(rest);
    try {
      const r = await runInit({ force: !!fParsed.force, auto: !!fParsed.auto });
      out({ path: r.path, installClaude: r.installClaude, auto: r.auto });
      if (r.installClaude) {
        const apiPort = readApiPort();
        const inst = claudeInstall({
          skill: true, commands: false, agent: true, dir: defaultClaudeDir(), apiPort,
          onMigrationEvent: ev => {
            if (ev.kind === 'removed') out({ removed: ev.file });
            else out({ warning: `${ev.file} was modified; backing up to ${ev.file}.bak` });
          },
        });
        out({ claudeInstalled: inst.installed });
      }
      // A running daemon was spawned with a different cwd / config path; without this
      // restart, the just-written config has no effect and `daimon list` returns [].
      const lock = readLock();
      if (lock) {
        try { await fetch(`http://127.0.0.1:${lock.apiPort}/api/snapshot-state`, { method: 'POST', headers: authHeaders() }); } catch {}
        try { await fetch(`http://127.0.0.1:${lock.apiPort}/api/shutdown`, { method: 'POST', headers: authHeaders() }); } catch {}
        await waitForExit(lock.pid, 5000);
        removeLock();
        try {
          const port = process.env.DAIMON_PORT ? Number(process.env.DAIMON_PORT) : undefined;
          const info = await spawnDetached({ port: Number.isFinite(port as number) && (port as number) > 0 ? (port as number) : undefined });
          out({ daemonRestarted: true, pid: info.pid, port: info.apiPort });
        } catch (err: any) {
          out({ daemonRestarted: false, error: err?.message || String(err) });
        }
      }
      // F59 smoke test: ask the (now-current) daemon to run a discovery pass and report counts.
      try {
        await ensureDaemon();
        const explainR = await fetch(getBaseUrl() + '/api/discovery/explain', { headers: authHeaders() });
        if (explainR.ok) {
          const exp: any = await explainR.json();
          const byKind: Record<string, number> = {};
          try {
            const lr = await fetch(getBaseUrl() + '/api/apps?format=full', { headers: authHeaders() });
            const arr = await lr.json();
            if (Array.isArray(arr)) {
              for (const a of arr) {
                const kind = a.workspaceType ?? 'unknown';
                byKind[kind] = (byKind[kind] ?? 0) + 1;
              }
            }
          } catch {}
          const apps = exp.appsFound ?? 0;
          const smoke: any = { init: 'ok', configPath: r.path, discovered: { apps, byKind } };
          if (apps === 0) {
            smoke._meta = { searchRoots: exp.searchRoots, scanned: exp.scanned, rejected: exp.rejected, suggestion: exp.suggestion };
            smoke.warning = 'discovery found 0 apps; see _meta.suggestion';
          }
          out(smoke);
        }
      } catch {}
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
      const needFull = f.full || ((f.tags.length || f.workspace) && !f.compact);
      const params = new URLSearchParams();
      if (needFull) params.set('format', 'full');
      else if (f.compact) params.set('format', 'compact');
      if (f.explain) params.set('explain', '1');
      // Default: only show apps under the current cwd. Pass --all to see every app the
      // daemon knows about (across all registered searchRoots).
      if (!f.all) {
        await ensureCurrentWorkspace();
        params.set('cwd', process.cwd());
      }
      if (f.stream) {
        params.set('stream', 'ndjson');
        const qs = params.toString();
        await streamNdjson('/api/apps' + (qs ? '?' + qs : ''));
        return;
      }
      const qs = params.toString();
      const r = await call('/api/apps' + (qs ? '?' + qs : ''));
      if (f.explain) {
        // explain returns { apps, _meta }; do not apply tag/workspace filters here.
        out(r.body);
        return;
      }
      let arr = Array.isArray(r.body) ? r.body : [];
      if (f.tags.length) arr = arr.filter((a: any) => f.tags.every(t => (a.tags || []).includes(t)));
      if (f.workspace) arr = arr.filter((a: any) => a.workspaceLabel === f.workspace);
      out(arr);
      return;
    }
    case 'why-empty': {
      const r = await call('/api/apps?explain=1');
      out(r.body);
      return;
    }
    case 'status':
    case 'stop':
    case 'restart': {
      const name = f.positional[0];
      if (!name) failHint(`missing app name`, `usage: daimon ${cmd} <name>`);
      if (!f.all) await ensureCurrentWorkspace();
      const suffix = cmd === 'status' ? '' : '/' + cmd;
      const method: 'GET' | 'POST' = cmd === 'status' ? 'GET' : 'POST';
      const params = scopeQs(f);
      if (cmd === 'status' && f.full) params.set('format', 'full');
      else if (cmd === 'status' && f.compact) params.set('format', 'compact');
      if (cmd !== 'status' && f.steal) params.set('steal', '1');
      const qs = params.toString();
      const r = await call(`/api/apps/${encodeURIComponent(name)}${suffix}${qs ? '?' + qs : ''}`, method);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 409 && r.body?.error === 'locked-by-other-agent') {
        process.stderr.write(`error: app '${name}' is locked by agent ${r.body.agent} (expires ${new Date(r.body.expiresAt).toISOString()})\n`);
        process.stderr.write(`hint: pass --steal to override, or wait\n`);
        process.exit(5);
      }
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      return;
    }
    case 'start': {
      const name = f.positional[0];
      if (!name) failHint('missing app name', 'usage: daimon start <name> [--with-deps]');
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      if (f.withDeps) params.set('withDeps', '1');
      if (f.steal) params.set('steal', '1');
      const qs = params.toString();
      const r = await call(`/api/apps/${encodeURIComponent(name)}/start${qs ? '?' + qs : ''}`, 'POST');
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 409 && r.body?.error === 'locked-by-other-agent') {
        process.stderr.write(`error: app '${name}' is locked by agent ${r.body.agent} (expires ${new Date(r.body.expiresAt).toISOString()})\n`);
        process.stderr.write(`hint: pass --steal to override, or wait\n`);
        process.exit(5);
      }
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      return;
    }
    case 'agents': {
      const r = await call('/api/agents');
      out(r.body);
      return;
    }
    case 'profiles': {
      const sub = f.positional[0];
      if (sub !== 'suggest') failHint('usage: daimon profiles suggest [--since 30d] [--min 5]');
      const params = new URLSearchParams();
      if (f.since) params.set('since', f.since);
      if (f.min != null) params.set('minOccurrences', String(f.min));
      const q = params.toString();
      const r = await call('/api/profiles/suggest' + (q ? '?' + q : ''));
      out(r.body);
      return;
    }
    case 'handoff': {
      const app = f.positional[0];
      const to = f.positional[1];
      if (!app || !to) failHint('missing args', 'usage: daimon handoff <app> <agentId>');
      const r = await callJson(`/api/apps/${encodeURIComponent(app)}/handoff`, 'POST', { to });
      if (r.status === 404) await suggestUnknownApp(app);
      out(r.body);
      return;
    }
    case 'history': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon history <name>' }));
      const r = await call(`/api/history/summary/${encodeURIComponent(name)}`);
      out(r.body);
      return;
    }
    case 'why': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon why <name>' }));
      const r = await call(`/api/history/why/${encodeURIComponent(name)}`);
      out(r.body);
      return;
    }
    case 'env': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon env <name> [--use <file>]' }));
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
      if (!name) fail(JSON.stringify({ error: 'usage: daimon clean <name> [--deep] [--yes]' }));
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
      if (!file) fail(JSON.stringify({ error: 'usage: daimon replay <session.jsonl> [--speed N]' }));
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
      if (f.self) {
        await ensureDaemon();
        const r = await call('/api/self');
        if (r.status === 503) failHint('self-metrics not available', 'daemon may need a restart: daimon daemon restart');
        const m: any = r.body ?? {};
        const checks: any[] = [];
        const HEAP_WARN_MB = 256;
        const LAG_WARN_MS = 100;
        const QUERY_P95_WARN_MS = 50;
        checks.push({ name: 'heap', ok: m.heapUsedMB < HEAP_WARN_MB, detail: `heapUsed ${m.heapUsedMB}MB (warn at ${HEAP_WARN_MB}MB)` });
        checks.push({ name: 'event-loop-lag', ok: m.eventLoopLagP95Ms < LAG_WARN_MS, detail: `p95 ${m.eventLoopLagP95Ms}ms (warn at ${LAG_WARN_MS}ms)` });
        checks.push({ name: 'history-db-query', ok: (m.historyDbQueryMs?.p95 ?? 0) < QUERY_P95_WARN_MS, detail: `p95 ${m.historyDbQueryMs?.p95 ?? 0}ms (warn at ${QUERY_P95_WARN_MS}ms)` });
        const ok = checks.every(c => c.ok);
        out({ ok, checks, metrics: m });
        if (!ok) process.exit(1);
        return;
      }
      if (f.autoFix) {
        const { runAutoFix, ALL_AUTO_FIX } = await import('./autoFix.js');
        const permitted = (cfgR.config.doctor?.autoFix?.permitted ?? ALL_AUTO_FIX) as any;
        const r = await runAutoFix({ permitted, dryRun: !!f.dryRun });
        out(r);
        if (r.errors.length) process.exit(1);
        return;
      }
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
      if (!Number.isFinite(port) || port <= 0) fail(JSON.stringify({ error: 'usage: daimon free-port <port> [--force]' }));
      const holder = findPortHolder(port);
      if (!holder) { out({ port, free: true }); return; }
      if (!f.force) { out({ port, free: false, holder }); return; }
      if (holder.pid === process.pid) fail(JSON.stringify({ error: 'refuse to kill daimon itself', holder }));
      const ok = await killHolder(holder);
      out({ port, killed: ok, holder });
      if (!ok) process.exit(1);
      return;
    }
    case 'snapshot': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon snapshot <name>' }));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/snapshot?write=1`, 'POST');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'tasks': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon tasks <name>' }));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/tasks`);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'run': {
      const name = f.positional[0];
      const task = f.positional[1];
      if (!name || !task) fail(JSON.stringify({ error: 'usage: daimon run <name> <task> [--watch] [-- args...]' }));
      if (!f.all) await ensureCurrentWorkspace();
      const body = { args: f.passthrough, watch: !!f.watch };
      const params = scopeQs(f);
      const qs = params.toString();
      const r = await callJson(`/api/apps/${encodeURIComponent(name)}/run/${encodeURIComponent(task)}${qs ? '?' + qs : ''}`, 'POST', body);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      if (!f.watch && typeof r.body?.exitCode === 'number') process.exit(r.body.exitCode === 0 ? 0 : 1);
      return;
    }
    case 'errors': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon errors <name> [--since 2m] [--since-last] [--client <id>] [--structured] [--full|--compact] [--level error|warning|lint|all]' }));
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      let endpoint = `/api/apps/${encodeURIComponent(name)}/errors`;
      if (f.sinceLast) {
        endpoint += '/since-last';
        if (f.client) params.set('client', f.client);
      } else if (f.since) {
        params.set('since', f.since);
      }
      if (f.level) params.set('level', f.level);
      if (f.full) params.set('format', 'full');
      else if (f.compact) params.set('format', 'compact');
      const qs = params.toString();
      const r = await call(endpoint + (qs ? '?' + qs : ''));
      if (r.status === 412) reportCollisionAndExit(r.body);
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
      if (f.stream) {
        params.set('stream', 'ndjson');
        const qs = params.toString();
        await streamNdjson('/api/events' + (qs ? '?' + qs : ''));
        return;
      }
      const qs = params.toString();
      const r = await call('/api/events' + (qs ? '?' + qs : ''));
      out(r.body);
      return;
    }
    case 'ensure': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon ensure <name> [--until serving|healthy] [--timeout 180s]' }));
      const params = new URLSearchParams();
      const until = (f.until || 'healthy').toLowerCase();
      if (until !== 'serving' && until !== 'healthy') fail(JSON.stringify({ error: 'ensure --until must be serving|healthy' }));
      params.set('until', until);
      let timeoutSec = 180;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) fail(JSON.stringify({ error: `invalid --timeout: ${f.timeout}` }));
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/ensure?${params.toString()}`, 'POST');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      if (r.body?.error === 'timeout') process.exit(2);
      return;
    }
    case 'ensure-up': {
      const profile = f.positional[0];
      if (!profile) fail(JSON.stringify({ error: 'usage: daimon ensure-up <profile> [--until serving|healthy] [--timeout 300s]' }));
      const params = new URLSearchParams();
      const until = (f.until || 'healthy').toLowerCase();
      if (until !== 'serving' && until !== 'healthy') fail(JSON.stringify({ error: 'ensure-up --until must be serving|healthy' }));
      params.set('until', until);
      let timeoutSec = 300;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) fail(JSON.stringify({ error: `invalid --timeout: ${f.timeout}` }));
        timeoutSec = Math.min(t, 1200);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const r = await call(`/api/profiles/${encodeURIComponent(profile)}/ensure-up?${params.toString()}`, 'POST');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown profile' }));
      out(r.body);
      const anyTimeout = Array.isArray(r.body?.apps) && r.body.apps.some((a: any) => a.timedOut);
      if (anyTimeout) process.exit(2);
      return;
    }
    case 'ci': {
      const sub = f.positional[0];
      if (sub !== 'start') failHint('usage: daimon ci start <profile> [--until ready|healthy] [--timeout 5m] [--json]');
      const profile = f.positional[1];
      if (!profile) failHint('usage: daimon ci start <profile> [--until ready|healthy] [--timeout 5m] [--json]');
      const untilRaw = (f.until || 'healthy').toLowerCase();
      const until = untilRaw === 'ready' ? 'healthy' : untilRaw;
      if (until !== 'serving' && until !== 'healthy') failHint(`ci --until must be serving|healthy|ready (got: ${untilRaw})`);
      let timeoutSec = 300;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`);
        timeoutSec = Math.min(t!, 1200);
      }
      const params = new URLSearchParams({ until, timeoutMs: String(Math.ceil(timeoutSec * 1000)) });
      const r = await call(`/api/profiles/${encodeURIComponent(profile)}/ensure-up?${params.toString()}`, 'POST');
      if (r.status === 404) {
        process.stdout.write(JSON.stringify({ profile, error: 'unknown profile', allReached: false }) + '\n');
        process.exit(1);
      }
      const body = r.body || {};
      const apps: any[] = Array.isArray(body.apps) ? body.apps : [];
      const allReached = apps.length > 0 && apps.every(a => !a.timedOut);
      const report = {
        profile,
        until,
        allReached,
        perApp: apps.map(a => ({
          name: a.name,
          state: a.state,
          reachedTargetMs: a.reachedTargetMs ?? null,
          timedOut: !!a.timedOut,
        })),
        totalMs: body._meta?.totalMs ?? null,
      };
      process.stdout.write(JSON.stringify(report) + '\n');
      if (!allReached) process.exit(2);
      return;
    }
    case 'overview': {
      const params = new URLSearchParams();
      if (f.workspace) params.set('workspace', f.workspace);
      if (f.profile) params.set('profile', f.profile);
      if (f.budget && Number.isFinite(f.budget) && f.budget > 0) params.set('budget', String(Math.floor(f.budget)));
      const qs = params.toString();
      const r = await call('/api/overview' + (qs ? '?' + qs : ''));
      out(r.body);
      return;
    }
    case 'focus': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon focus <name> [--until serving|healthy|stable] [--timeout 180s]' }));
      const params = new URLSearchParams();
      const until = (f.until || 'healthy').toLowerCase();
      if (!['serving', 'healthy', 'stable'].includes(until)) fail(JSON.stringify({ error: 'focus --until must be serving|healthy|stable' }));
      params.set('until', until);
      let timeoutSec = 180;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) fail(JSON.stringify({ error: `invalid --timeout: ${f.timeout}` }));
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      await streamNdjson(`/api/apps/${encodeURIComponent(name)}/focus?${params.toString()}`, 'POST');
      return;
    }
    case 'pin-health': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon pin-health <name> [--accept] [--path <p>]' }));
      const status = await call(`/api/apps/${encodeURIComponent(name)}?format=full`);
      if (status.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      const discovered: string | null = (status.body as any)?.discoveredHealthPath ?? null;
      const candidate = f.path ?? discovered ?? null;
      if (!f.accept) {
        out({ app: name, discoveredHealthPath: discovered, candidate, hint: candidate ? `re-run with --accept to persist ${candidate} to daimon.config.json` : 'no path discovered yet; start the app and wait for first serving' });
        return;
      }
      if (!candidate) fail(JSON.stringify({ error: 'no path to pin — pass --path or wait for auto-discovery' }));
      const r = await callJson(`/api/apps/${encodeURIComponent(name)}/health/pin`, 'POST', { path: candidate });
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    case 'orchestrate': {
      const profile = f.positional[0];
      if (!profile) fail(JSON.stringify({ error: 'usage: daimon orchestrate <profile> [--goal serving|healthy|stable] [--timeout 300s] [--dry-run] [--budget <tokens>]' }));
      const params = new URLSearchParams();
      params.set('profile', profile);
      const goal = (f.goal || f.until || 'healthy').toLowerCase();
      if (!['serving', 'healthy', 'stable'].includes(goal)) fail(JSON.stringify({ error: 'orchestrate --goal must be serving|healthy|stable' }));
      params.set('goal', goal);
      let timeoutSec = 300;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) fail(JSON.stringify({ error: `invalid --timeout: ${f.timeout}` }));
        timeoutSec = Math.min(t, 1200);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      if (f.dryRun) params.set('dryRun', 'true');
      if (f.budget && Number.isFinite(f.budget) && f.budget > 0) params.set('budget', String(Math.floor(f.budget)));
      const r = await call(`/api/orchestrate?${params.toString()}`, 'POST');
      if (r.status === 404) fail(JSON.stringify(r.body));
      if (r.status === 400) fail(JSON.stringify(r.body));
      out(r.body);
      if (r.body && r.body.allReached === false) process.exit(2);
      return;
    }
    case 'try-fix': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon try-fix <name> [--until serving|healthy] [--timeout 180s]' }));
      const params = new URLSearchParams();
      const until = (f.until || 'healthy').toLowerCase();
      if (!['serving', 'healthy'].includes(until)) fail(JSON.stringify({ error: 'try-fix --until must be serving|healthy' }));
      params.set('until', until);
      let timeoutSec = 180;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) fail(JSON.stringify({ error: `invalid --timeout: ${f.timeout}` }));
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/try-fix?${params.toString()}`, 'POST');
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      if (r.body && r.body.reached === false) process.exit(2);
      return;
    }
    case 'wait': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon wait <name> [--until serving|healthy|stopped|error] [--timeout 60s]' }));
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      if (f.until) params.set('until', f.until);
      let timeoutSec = 120;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) fail(JSON.stringify({ error: `invalid --timeout: ${f.timeout}` }));
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeout', String(Math.ceil(timeoutSec)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/wait?${params.toString()}`);
      if (r.status === 412) reportCollisionAndExit(r.body);
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
    case 'timeline': {
      const params = new URLSearchParams();
      if (f.since) params.set('since', f.since);
      if (f.app) params.set('app', f.app);
      if (f.kinds) params.set('kinds', f.kinds);
      const qs = params.toString();
      const r = await call('/api/history/timeline' + (qs ? '?' + qs : ''));
      out(r.body);
      return;
    }
    case 'logs': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon logs <name> [--tail N] [--since 30s]' }));
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      if (f.tail != null && !Number.isNaN(f.tail)) params.set('tail', String(f.tail));
      if (f.since) params.set('since', f.since);
      const qs = params.toString();
      const r = await call(`/api/apps/${encodeURIComponent(name)}/logs${qs ? '?' + qs : ''}`);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 404) fail(JSON.stringify({ error: 'unknown app' }));
      out(r.body);
      return;
    }
    default: {
      const guess = suggestCommand(cmd);
      const hint = guess ? `did you mean '${guess}'? — run \`daimon --help\` to list commands` : 'run `daimon --help` to list commands';
      failHint(`unknown command: ${cmd}`, hint);
    }
  }
}

main().catch(err => fail(JSON.stringify({ error: err?.message || String(err) })));
