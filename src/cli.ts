#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { discoverApps } from './discovery.js';
import { runDoctor } from './doctor.js';
import { findPortHolder, killHolder } from './portDiag.js';
import { readSession } from './session.js';
import { daimonDir, readLock, spawnDetached, waitForExit, removeLock } from './daemon.js';
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

// Frozen-verb guard for the `--group <value>` form (M95): every verb accepted
// a bare `--group` before v1.1, so `--group web-admin` used to parse the
// value as a positional. parseFlags can't know which was meant — only config
// can. Rule: with NO groups configured, restore the v0.14 parse exactly (the
// value becomes the leading positional, the flag stays bare) so every
// previously-valid invocation is byte-identical. Defining groups is the
// user's opt-in to the value form — from then on an unknown name errors with
// the valid group list (M95) instead of degrading silently.
async function resolveGroupFlag(f: Flags): Promise<void> {
  if (!f.groupName) return;
  const groups = (await loadCfg()).config.groups ?? {};
  if (Object.keys(groups).length === 0) {
    f.positional.unshift(f.groupName);
    f.groupName = undefined;
  }
}

// Unknown-group exit (M95): always names the valid groups (the daemon's 400/
// 404 bodies carry them as `known`).
function failGroup(name: string, body: any): never {
  const known: string[] = Array.isArray(body?.known) ? body.known : [];
  failHint(
    `unknown group: ${name}`,
    known.length
      ? `known groups: ${known.join(', ')}`
      : (body?.hint ?? "no groups configured — add a 'groups' map to daimon.config.json (name → [app, ...])"),
  );
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

async function loadCfg(): Promise<{ config: { autoStart?: string[]; profiles?: Record<string, string[]>; groups?: Record<string, { apps: string[]; autoStart: boolean }> } }> {
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

// Streams NDJSON to stdout and returns the terminal `{ kind: 'done', ... }`
// object if the stream emitted one (focus/ensure-style streams do), so callers
// can map its `reason` to an exit code. Returns null for streams with no
// terminal event.
async function streamNdjson(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<any | null> {
  let terminal: any = null;
  const inspect = (line: string) => {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.kind === 'done') terminal = obj;
    } catch {}
  };
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: authHeaders() });
    warnOnVersionSkew(res);
    if (!res.ok || !res.body) failHint(`stream failed: HTTP ${res.status}`, "check 'daimon daemon status', then retry; 'daimon daemon restart' hands off to a fresh daemon");
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
        inspect(line);
      }
    }
    if (buf.trim()) { process.stdout.write(buf + '\n'); inspect(buf); }
  } catch (err: any) {
    fail(JSON.stringify({ error: err?.message || String(err) }));
  }
  return terminal;
}

// Version-skew warning (M88): every daemon response carries x-daimon-version
// (v0.14+). Compare it against this CLI's version on responses we already
// receive — one stderr line, at most once per invocation, never a hard fail.
// A missing header on a live daemon means it predates v0.14: same skew, same
// remedy (`daimon daemon restart` performs the handoff to the new version).
let skewWarned = false;
function warnOnVersionSkew(res: { headers: { get(name: string): string | null } }): void {
  if (skewWarned) return;
  const remote = res.headers.get('x-daimon-version');
  if (remote === DAIMON_VERSION) return;
  skewWarned = true;
  const daemonV = remote ? `v${remote}` : 'an older version (pre-0.14)';
  process.stderr.write(`[daimon] warning: CLI v${DAIMON_VERSION} is talking to a daemon running ${daemonV} — run \`daimon daemon restart\` to hand off to the current version\n`);
}

// Ceiling on a single (non-streaming) daemon call so a stalled daemon can't hang
// the CLI forever. Set above the daemon's own 600s max long-poll deadline
// (wait/ensure/orchestrate) so a legitimate long wait completes but a truly hung
// daemon still unblocks. Streaming verbs (streamNdjson) are long-lived and excluded.
const CALL_TIMEOUT_MS = 660_000;

async function call(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<{ status: number; body: any }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: authHeaders(), signal: ac.signal });
    warnOnVersionSkew(res);
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } catch (err: any) {
    if (err?.name === 'AbortError') failHint(`daimon call timed out after ${CALL_TIMEOUT_MS}ms`, "the daemon may be hung — 'daimon daemon restart' hands off to a fresh one");
    failHint('daimon is not running', 'start it with: daimon daemon start --detach');
  } finally {
    clearTimeout(timer);
  }
}

async function callJson(pathname: string, method: 'GET' | 'POST', payload: unknown): Promise<{ status: number; body: any }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(getBaseUrl() + pathname, { method, headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload), signal: ac.signal });
    warnOnVersionSkew(res);
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } catch (err: any) {
    if (err?.name === 'AbortError') failHint(`daimon call timed out after ${CALL_TIMEOUT_MS}ms`, "the daemon may be hung — 'daimon daemon restart' hands off to a fresh one");
    failHint('daimon is not running', 'start it with: daimon daemon start --detach');
  } finally {
    clearTimeout(timer);
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
  group?: boolean;
  // `--group <name>` (M95): the value form filters read verbs to a named
  // group's members. Bare `--group` (no value) keeps its legacy meaning on
  // `errors` (fingerprint grouping).
  groupName?: string;
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
  limit?: number;
  flaky?: boolean;
  kind?: string;
  grep?: string;
  from?: string;
  to?: string;
  md?: boolean;
  forDur?: string;
  // `daimon export` (M111, v1.4): output format + atomic file target.
  format?: string;
  outFile?: string;
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
    else if (a === '--group') {
      // Value form (M95): `--group <name>` filters to a group's members.
      // Bare `--group` (next token missing or another flag) stays the legacy
      // boolean — `daimon errors --group` keeps fingerprint grouping.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) f.groupName = args[++i];
      f.group = true;
    }
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
    else if (a === '--from') f.from = args[++i];
    else if (a === '--to') f.to = args[++i];
    else if (a === '--md') f.md = true;
    else if (a === '--for') f.forDur = args[++i];
    else if (a === '--open') f.open = true;
    else if (a === '--steal') f.steal = true;
    else if (a === '--json') f.json = true;
    else if (a === '--limit') f.limit = Number(args[++i]);
    else if (a === '--flaky') f.flaky = true;
    else if (a === '--kind') f.kind = args[++i];
    else if (a === '--grep') f.grep = args[++i];
    else if (a === '--format') f.format = args[++i];
    else if (a === '--out') f.outFile = args[++i];
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
  const lockPath = path.join(daimonDir(), 'lock.json');
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
    if (!m) fail(JSON.stringify({ error: `no manifest at ${dir} — run \`daimon claude install\` first` }));
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

  failHint(`unknown claude subcommand: ${sub}`, 'usage: daimon claude <install|update|uninstall|status>');
  void CLAUDE_COMMAND_NAMES;
}

async function handleDaemon(rest: string[]): Promise<void> {
  const sub = rest[0];
  const f = parseFlags(rest.slice(1));
  switch (sub) {
    case 'status': {
      const lock = readLock();
      if (!lock) { out({ running: false }); return; }
      // M87 last-call rename (was `uptime`): milliseconds, so say so in the key.
      const uptimeMs = Date.now() - lock.startedAt;
      out({ running: true, pid: lock.pid, port: lock.apiPort, uptimeMs, version: lock.version, headless: lock.headless });
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
      if (!lock) failHint('no daemon running and auto-spawn failed', "start it in the foreground to see why: 'daimon daemon start'");
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

  if (cmd === 'plugins') {
    // Plugin API v1 (M118): what loaded, what didn't, and why. TTY table by
    // default; compact JSON with --json or when piped.
    const fp = parseFlags(rest);
    await ensureDaemon();
    const r = await call('/api/plugins');
    const arr: any[] = Array.isArray(r.body) ? r.body : [];
    if (!fp.json && process.stdout.isTTY && isColorEnabled()) {
      const dim = (s: string) => color.dim(s);
      const L: string[] = [];
      const nonActive = arr.filter(p => p.status !== 'active').length;
      L.push(color.bold('plugins') + dim(`  ${arr.length} file${arr.length === 1 ? '' : 's'} in ~/.daimon/plugins${nonActive ? ` · ${nonActive} not active` : ''}`));
      for (const p of arr) {
        const rawStatus = String(p.status).padEnd(10);
        const status = p.status === 'active' ? rawStatus : color.red(rawStatus);
        L.push(`  ${String(p.name).padEnd(26)} ${status} v${p.apiVersion ?? '—'}  ${dim((p.hooks ?? []).join(',') || '(no hooks)')}`);
        if (p.error) L.push(dim(`    ${p.error}`));
      }
      if (!arr.length) L.push(dim('  (none — drop a .mjs file exporting { name, apiVersion: 1 } into ~/.daimon/plugins; see PLUGINS.md)'));
      process.stdout.write(L.join('\n') + '\n');
      return;
    }
    out(r.body);
    return;
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
  // Alias resolution rewrote `config` to the canonical multi-word name.
  if (cmd === 'config validate') {
    const sub = rest[0];
    if (sub !== 'validate') failHint(`unknown config subcommand: ${sub ?? '(none)'}`, 'usage: daimon config validate [<path>]');
    const { validateConfig, configValidationWarnings, configLookupPaths } = await import('./config.js');
    const fsMod = await import('node:fs');
    const explicit = rest[1] ? path.resolve(rest[1]) : null;
    const { local, user } = configLookupPaths();
    const target = explicit ?? (fsMod.existsSync(local) ? local : user);
    if (!fsMod.existsSync(target)) {
      out({ path: target, ok: false, errors: [`no config file at ${target}`], warnings: [], hint: "run 'daimon init --auto' to create one" });
      process.exit(1);
    }
    let raw: unknown;
    try {
      let text = fsMod.readFileSync(target, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM, same as configManager
      raw = JSON.parse(text);
    } catch (err: any) {
      out({ path: target, ok: false, errors: [`invalid JSON: ${err?.message || err}`], warnings: [], hint: 'fix the syntax error; the daemon refuses to start on unparseable config' });
      process.exit(1);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out({ path: target, ok: false, errors: ['config must be a JSON object'], warnings: [] });
      process.exit(1);
    }
    const validated = validateConfig(raw, target);
    const warnings = configValidationWarnings();
    // Group checks (M93): unknown app names (against a discovery scan),
    // dual-autoStart membership, group/profile collisions. Discovery failing
    // degrades to skipping the unknown-app check — never a validate error.
    if (validated.groups && Object.keys(validated.groups).length) {
      const { validateGroups } = await import('./groups.js');
      let knownNames: string[] | null = null;
      try {
        const apps = discoverApps(validated);
        knownNames = [...new Set(apps.flatMap(a => [a.name, ...(a.baseName ? [a.baseName] : [])]))];
      } catch { knownNames = null; }
      warnings.push(...validateGroups(validated, knownNames));
    }
    out({ path: target, ok: true, errors: [], warnings, ...(warnings.length ? { hint: 'warnings never block loading — the daemon falls back to defaults for these' } : {}) });
    return;
  }
  if (cmd === 'export-config') {
    const cfgR = loadConfig();
    if (cfgR.kind !== 'loaded') failHint('no config loaded', "run 'daimon init --auto' in your workspace to create one");
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
    if (r.status !== 200) failHint(`discovery failed (HTTP ${r.status})`, "run 'daimon doctor' for config + searchRoot checks");
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
      // M87 last-call fix: --tag/--workspace filter on the DAEMON (where the
      // full rows live) instead of silently switching the output to the full
      // shape client-side. The output shape now depends only on --full/--compact.
      await resolveGroupFlag(f);
      const params = new URLSearchParams();
      if (f.full) params.set('format', 'full');
      else if (f.compact) params.set('format', 'compact');
      for (const t of f.tags) params.append('tag', t);
      if (f.workspace) params.set('workspace', f.workspace);
      if (f.groupName) params.set('group', f.groupName);
      if (f.explain) params.set('explain', '1');
      // Default: only show apps under the current cwd. Pass --all to see every app the
      // daemon knows about (across all registered searchRoots). A --group names
      // a global working set, so it skips the cwd scope like --all does.
      if (!f.all && !f.groupName) {
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
      if (r.status === 400 && r.body?.error) fail(JSON.stringify(r.body));
      if (f.explain) {
        // explain returns { apps, _meta }; filters already applied server-side.
        out(r.body);
        return;
      }
      let arr = Array.isArray(r.body) ? r.body : [];
      // Belt-and-braces for version skew (new CLI, pre-v0.14 daemon that
      // ignores ?tag=/?workspace=): re-filter locally when rows carry the
      // fields (full shape). Harmless when the daemon already filtered.
      if (f.tags.length) arr = arr.filter((a: any) => !Array.isArray(a.tags) || f.tags.every(t => a.tags.includes(t)));
      if (f.workspace) arr = arr.filter((a: any) => !('workspaceLabel' in a) || a.workspaceLabel === f.workspace);
      if (f.groupName) {
        // Same skew belt-and-braces for ?group= (a pre-v1.1 daemon ignores
        // it): the member list lives in local config, so re-intersect.
        const g = (await loadCfg()).config.groups?.[f.groupName];
        if (g) arr = arr.filter((a: any) => g.apps.includes(a.name) || (a.baseName && g.apps.includes(a.baseName)));
      }
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
      if (cmd === 'status') await resolveGroupFlag(f);
      const name = f.positional[0];
      // `status --group <g>` (M95): per-member statuses + a "3/4 healthy"
      // summary, no app name needed.
      if (cmd === 'status' && f.groupName && !name) {
        const r = await call(`/api/groups/${encodeURIComponent(f.groupName)}/status`);
        if (r.status === 404) failGroup(f.groupName, r.body);
        out(r.body);
        return;
      }
      if (cmd === 'status' && f.groupName && name) failHint('pass either an app name or --group <group>, not both', 'usage: daimon status <name> | daimon status --group <group>');
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
      if (r.status === 404) {
        // Group fallback on `stop` (M94): app-name precedence is absolute —
        // this branch only fires where the frozen verb previously errored.
        // No app of that name + a group of that name → stop the group's
        // members in reverse depends order.
        if (cmd === 'stop') {
          const knownConfig = (await loadCfg()).config;
          if (knownConfig.groups?.[name]) {
            const gp = new URLSearchParams();
            if (f.steal) gp.set('steal', '1');
            const gr = await call(`/api/groups/${encodeURIComponent(name)}/stop?${gp.toString()}`, 'POST');
            if (gr.status === 404) failHint(`unknown group: ${name}`, "the daemon's config may be older than the CLI's — run 'daimon daemon restart', then 'daimon config validate'");
            out(gr.body);
            // Keep stop's documented exit codes on the group path: a
            // lock-blocked member is the per-app 409 case (exit 5, same as a
            // single stop), any other member left running is an error (1).
            const rows: any[] = Array.isArray(gr.body?.apps) ? gr.body.apps : [];
            const locked = rows.filter(r => r.lockedBy);
            if (locked.length) {
              process.stderr.write(`error: ${locked.map(r => `'${r.name}' is locked by agent ${r.lockedBy}`).join('; ')}\n`);
              process.stderr.write(`hint: pass --steal to override, or wait\n`);
              process.exit(5);
            }
            if (gr.body?.allStopped === false) process.exit(1);
            return;
          }
        }
        await suggestUnknownApp(name);
      }
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
    case 'test': {
      const name = f.positional[0];
      if (!name) failHint('missing app name', 'usage: daimon test <name> [--timeout <dur>] [--steal]');
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      if (f.steal) params.set('steal', '1');
      let timeoutSec = 300;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/test?${params.toString()}`, 'POST');
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 409 && r.body?.error === 'locked-by-other-agent') {
        process.stderr.write(`error: app '${name}' is locked by agent ${r.body.agent} (expires ${new Date(r.body.expiresAt).toISOString()})\n`);
        process.stderr.write(`hint: pass --steal to override, or wait\n`);
        process.exit(5);
      }
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      if (r.status === 422 || r.body?.error) process.exit(1);
      if (r.body?.timedOut) process.exit(2);
      const failed = r.body?.totals?.failed ?? null;
      if ((failed != null && failed > 0) || (failed == null && r.body?.exitCode !== 0)) process.exit(1);
      return;
    }
    case 'context': {
      const name = f.positional[0];
      if (!name) failHint('missing app name', 'usage: daimon context <name> [--budget <chars>]');
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      if (f.budget && Number.isFinite(f.budget) && f.budget > 0) params.set('budget', String(Math.floor(f.budget)));
      const r = await call(`/api/context/${encodeURIComponent(name)}?${params.toString()}`);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      return;
    }
    case 'search': {
      const q = f.positional.join(' ').trim();
      if (!q) failHint('missing query', 'usage: daimon search <query> [--app <a>] [--since <dur>] [--kind logs|errors|events]');
      const params = new URLSearchParams({ q });
      if (f.app) params.set('app', f.app);
      if (f.since) params.set('since', f.since);
      if (f.kind) params.set('kind', f.kind);
      if (f.limit != null && Number.isFinite(f.limit)) params.set('limit', String(Math.floor(f.limit)));
      const r = await call('/api/search?' + params.toString());
      if (r.status === 400) fail(JSON.stringify(r.body));
      out(r.body);
      return;
    }
    case 'test-history': {
      const name = f.positional[0];
      if (!name) failHint('missing app name', 'usage: daimon test-history <name> [--flaky] [--limit N]');
      const params = new URLSearchParams({ app: name });
      if (f.flaky) {
        const r = await call('/api/tests/flaky?' + params.toString());
        out(r.body);
        return;
      }
      if (f.limit != null && Number.isFinite(f.limit)) params.set('limit', String(Math.floor(f.limit)));
      else params.set('limit', '20');
      const r = await call('/api/tests?' + params.toString());
      out(r.body);
      return;
    }
    case 'frameworks': {
      const r = await call('/api/frameworks');
      out(r.body);
      return;
    }
    // The alias maps `profiles` → this canonical name before the switch. The
    // old `case 'profiles'` could never match after that rewrite, so the verb
    // shipped broken in v0.12–v0.13 (M91 fix).
    case 'profiles suggest': {
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
    case 'mute':
    case 'unmute': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: `usage: daimon ${cmd} <name>${cmd === 'mute' ? ' [--for <dur>]' : ''}` }));
      let body: any = undefined;
      if (cmd === 'mute' && f.forDur) {
        const m = /^(\d+)(ms|s|m|h|d)?$/.exec(f.forDur.trim());
        if (!m) failHint('invalid --for duration', 'use e.g. --for 30m, --for 2h, --for 1d');
        const mult = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] ?? 'm'] ?? 60_000;
        body = { forMs: Number(m[1]) * mult };
      }
      const r = body
        ? await callJson(`/api/apps/${encodeURIComponent(name)}/${cmd}`, 'POST', body)
        : await call(`/api/apps/${encodeURIComponent(name)}/${cmd}`, 'POST');
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      return;
    }
    case 'report': {
      await resolveGroupFlag(f);
      const params = new URLSearchParams();
      if (f.since) params.set('since', f.since);
      if (f.app) params.set('app', f.app);
      if (f.workspace) params.set('workspace', f.workspace);
      if (f.groupName) params.set('group', f.groupName);
      const qs = params.toString();
      const r = await call(`/api/report${qs ? '?' + qs : ''}`);
      if (r.status === 400 && f.groupName && r.body?.error) failGroup(f.groupName, r.body);
      if (f.md && r.body && typeof r.body === 'object') {
        const { renderReportMd } = await import('./report.js');
        process.stdout.write(renderReportMd(r.body as any) + '\n');
        return;
      }
      out(r.body);
      return;
    }
    // `daimon export` (M111, v1.4): the one-way carry-out bundle. The daemon
    // composes + renders; the CLI only routes bytes — stdout by default,
    // atomic tmp+rename with --out.
    case 'export': {
      const format = (f.format ?? 'json').toLowerCase();
      if (!['json', 'md', 'csv'].includes(format)) {
        fail(JSON.stringify({ error: `unknown --format '${f.format}' — use json (canonical), md (paste-ready) or csv (flat rows)` }));
      }
      const params = new URLSearchParams();
      if (f.since) params.set('since', f.since);
      if (f.app) params.set('app', f.app);
      if (format !== 'json') params.set('format', format);
      const qs = params.toString();
      const r = await call(`/api/export${qs ? '?' + qs : ''}`);
      if (r.status !== 200) {
        out(r.body);
        process.exit(1);
      }
      const text = format === 'json' ? JSON.stringify(r.body, null, 2) + '\n' : String(r.body);
      if (f.outFile) {
        const target = path.resolve(f.outFile);
        const { writeExportAtomic } = await import('./export.js');
        const written = writeExportAtomic(target, text);
        out({ written: written.path, bytes: written.bytes, format });
        return;
      }
      process.stdout.write(text.endsWith('\n') ? text : text + '\n');
      return;
    }
    case 'env': {
      const first = f.positional[0];
      if (first === 'diff') {
        const name = f.positional[1];
        if (!name) fail(JSON.stringify({ error: 'usage: daimon env diff <name> [--from <ts>] [--to <ts>]' }));
        const params = new URLSearchParams();
        if (f.from) params.set('from', f.from);
        if (f.to) params.set('to', f.to);
        const qs = params.toString();
        const r = await call(`/api/env/${encodeURIComponent(name)}/diff${qs ? '?' + qs : ''}`);
        if (r.status === 412) reportCollisionAndExit(r.body);
        if (r.status === 404) await suggestUnknownApp(name);
        out(r.body);
        return;
      }
      const name = first;
      if (!name) fail(JSON.stringify({ error: 'usage: daimon env <name> [--use <file>] | daimon env diff <name> [--from <ts>] [--to <ts>]' }));
      // Legacy behavior (pre-v0.13): --use activates an env file for injection.
      if (f.use) {
        const r = await callJson(`/api/apps/${encodeURIComponent(name)}/env`, 'POST', { use: f.use });
        if (r.status === 404) await suggestUnknownApp(name);
        out(r.body);
        return;
      }
      const r = await call(`/api/env/${encodeURIComponent(name)}`);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 404) await suggestUnknownApp(name);
      const b: any = r.body;
      if (process.stdout.isTTY && isColorEnabled() && b && typeof b === 'object' && Array.isArray(b.candidates)) {
        const dim = (s: string) => color.dim(s);
        const L: string[] = [];
        L.push(color.bold(`env ${b.app}`) + (b.snapshot ? dim(`  snapshot ${Math.round((b.snapshot.ageMs ?? 0) / 1000)}s old`) : dim('  (no snapshot yet — start the app once)')));
        for (const c of b.candidates) {
          L.push(`  ${String(c.file).padEnd(28)} ${c.exists ? 'found' : dim('missing')}`);
        }
        for (const fSnap of b.snapshot?.files ?? []) {
          if (!fSnap.exists) continue;
          L.push(dim(`  ${fSnap.file}: ${fSnap.keyNames.length} keys`) + (fSnap.keyNames.length ? ` ${fSnap.keyNames.join(', ')}` : ''));
        }
        L.push(dim('  values are never shown — open the file itself'));
        process.stdout.write(L.join('\n') + '\n');
        return;
      }
      out(b);
      return;
    }
    case 'why': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon why <name>' }));
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      const qs = params.toString();
      const r = await call(`/api/why/${encodeURIComponent(name)}${qs ? '?' + qs : ''}`);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 404) await suggestUnknownApp(name);
      const b = r.body;
      if (process.stdout.isTTY && isColorEnabled() && b && typeof b === 'object') {
        const dim = (s: string) => color.dim(s);
        const head = (s: string) => color.bold(s);
        const L: string[] = [];
        L.push(head(`why ${b.app}`) + dim(`  status=${b.status?.status ?? '?'} health=${b.status?.health ?? '?'} errors=${b.status?.errCount ?? 0}`));
        if (b.lastCrash) {
          L.push(head('last crash') + `  code=${b.lastCrash.exitCode ?? 'null'}${b.lastCrash.signal ? ` signal=${b.lastCrash.signal}` : ''} uptime=${Math.round((b.lastCrash.uptimeMs ?? 0) / 1000)}s ${dim(new Date(b.lastCrash.ts).toISOString())}`);
          for (const ln of (b.lastCrash.lastLines ?? []).slice(-5)) L.push(dim('  | ' + ln));
        } else {
          L.push(dim('no recorded crashes'));
        }
        if (b.storm?.active) L.push(head('restart storm') + `  ${b.storm.countLastHour} exits in the last hour (threshold ${b.storm.threshold})`);
        for (const g of b.errorGroups ?? []) L.push(head('error') + ` ×${g.count}  ${g.message.slice(0, 120)}`);
        for (const rg of (b.regressions ?? []).slice(0, 3)) L.push(head('regression') + `  ${rg.kind ?? '?'} ×${rg.factor ?? '?'}${rg.suspectCommit ? dim('  suspect ' + rg.suspectCommit) : ''}`);
        if (b.suspectCommit) L.push(head('suspect commit') + `  ${b.suspectCommit}`);
        for (const d of b.doctor ?? []) L.push(head(d.ok ? 'note' : 'doctor') + `  ${d.name}${d.detail ? dim(' — ' + d.detail) : ''}`);
        process.stdout.write(L.join('\n') + '\n');
        return;
      }
      out(b);
      return;
    }
    case 'clean': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon clean <name> [--deep] [--yes]' }));
      const qs = new URLSearchParams();
      if (f.deep) qs.set('deep', '1');
      if (f.yes) qs.set('yes', '1');
      const r = await call(`/api/apps/${encodeURIComponent(name)}/clean${qs.toString() ? '?' + qs.toString() : ''}`, 'POST');
      if (r.status === 404) await suggestUnknownApp(name);
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
      if (cfgR.kind !== 'loaded') failHint('no config loaded', "run 'daimon init --auto' in your workspace to create one");
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
    case 'top': {
      const r = await call('/api/top');
      const b: any = r.body;
      if (!f.json && process.stdout.isTTY && isColorEnabled() && b && typeof b === 'object' && Array.isArray(b.apps)) {
        const dim = (s: string) => color.dim(s);
        const fmtUp = (ms: number | null): string => {
          if (ms == null) return '—';
          const s = Math.floor(ms / 1000);
          if (s < 60) return `${s}s`;
          if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
          const h = Math.floor(s / 3600);
          return `${h}h ${Math.floor((s % 3600) / 60)}m`;
        };
        const L: string[] = [];
        L.push(color.bold('top') + dim(`  ${b.apps.length} running · sorted by rss`));
        L.push(dim(`  ${'app'.padEnd(26)} ${'pid'.padStart(7)} ${'rss'.padStart(8)} ${'cpu'.padStart(7)}  uptime`));
        for (const a of b.apps) {
          const rss = a.rssMB != null ? `${a.rssMB}MB` : '—';
          const cpu = a.cpu != null ? `${a.cpu}%` : '—';
          const tail = a.status && a.status !== 'serving' ? dim(`  ${a.status}`) : '';
          L.push(`  ${String(a.name).padEnd(26)} ${String(a.pid ?? '—').padStart(7)} ${rss.padStart(8)} ${cpu.padStart(7)}  ${fmtUp(a.uptimeMs)}${tail}`);
        }
        if (!b.apps.length) L.push(dim('  (no running apps)'));
        process.stdout.write(L.join('\n') + '\n');
        return;
      }
      out(b);
      return;
    }
    case 'ports': {
      const r = await call('/api/ports');
      const b: any = r.body;
      if (process.stdout.isTTY && isColorEnabled() && b && typeof b === 'object' && Array.isArray(b.apps)) {
        const dim = (s: string) => color.dim(s);
        const L: string[] = [];
        L.push(color.bold('ports') + dim(b.pool ? `  pool=${b.pool}` : '  (no ports.pool configured — legacy portRange assignment)'));
        for (const a of b.apps) {
          const port = a.port != null ? String(a.port) : '—';
          L.push(`  ${String(a.app).padEnd(26)} ${port.padStart(5)}  ${String(a.source ?? '—').padEnd(10)} pid=${a.pid ?? '—'} ${dim(String(a.status ?? ''))}`);
        }
        if (Array.isArray(b.foreign) && b.foreign.length) {
          L.push(color.bold('foreign holders'));
          for (const fh of b.foreign) {
            L.push(`  ${String(fh.port).padStart(5)}  pid=${fh.pid}${fh.name ? ` ${fh.name}` : ''}${fh.cmd ? dim(`  ${fh.cmd}`) : ''}`);
          }
        }
        process.stdout.write(L.join('\n') + '\n');
        return;
      }
      out(b);
      return;
    }
    case 'free-port': {
      const port = Number(f.positional[0]);
      if (!Number.isFinite(port) || port <= 0) fail(JSON.stringify({ error: 'usage: daimon free-port <port> [--force]' }));
      const holder = findPortHolder(port);
      if (!holder) { out({ port, free: true }); return; }
      if (!f.force) { out({ port, free: false, holder }); return; }
      if (holder.pid === process.pid) failHint('refusing: that port is held by this daimon itself', "use 'daimon daemon stop' to stop the daemon, or change apiPort in daimon.config.json");
      const ok = await killHolder(holder);
      out({ port, killed: ok, holder });
      if (!ok) process.exit(1);
      return;
    }
    case 'snapshot': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon snapshot <name>' }));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/snapshot?write=1`, 'POST');
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      return;
    }
    case 'tasks': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon tasks <name>' }));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/tasks`);
      if (r.status === 404) await suggestUnknownApp(name);
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
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      if (!f.watch && typeof r.body?.exitCode === 'number') process.exit(r.body.exitCode === 0 ? 0 : 1);
      return;
    }
    case 'errors': {
      await resolveGroupFlag(f);
      const name = f.positional[0];
      // Named-group filter (M95): `errors --group <g>` — all member apps'
      // errors, flat shape, no app name needed.
      if (!name && f.groupName) {
        const params = new URLSearchParams({ group: f.groupName });
        if (f.level) params.set('level', f.level);
        const r = await call('/api/errors?' + params.toString());
        if (r.status === 400 && r.body?.error) failGroup(f.groupName, r.body);
        out(r.body);
        return;
      }
      // Global grouped view (M72): bare `daimon errors --group` (no value)
      // keeps its historical fingerprint-grouping meaning.
      if (!name && f.group) {
        const params = new URLSearchParams({ group: 'fingerprint' });
        if (f.level) params.set('level', f.level);
        const r = await call('/api/errors?' + params.toString());
        out(r.body);
        return;
      }
      if (!name) fail(JSON.stringify({ error: 'usage: daimon errors <name> [--since 2m] [--since-last] [--client <id>] [--structured] [--group] [--full|--compact] [--level error|warning|lint|all]' }));
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
      if (r.status === 404) await suggestUnknownApp(name);
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
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/ensure?${params.toString()}`, 'POST');
      if (r.status === 404) await suggestUnknownApp(name);
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
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
        timeoutSec = Math.min(t, 1200);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const r = await call(`/api/profiles/${encodeURIComponent(profile)}/ensure-up?${params.toString()}`, 'POST');
      if (r.status === 404) failHint('unknown profile', "profiles are named sets in daimon.config.json `profiles`; run 'daimon profiles suggest' for candidates");
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
      // An empty profile is a config error, not a timeout — don't report it as
      // exit 2 (which a CI harness reads as "apps didn't come up in time").
      if (apps.length === 0) {
        process.stdout.write(JSON.stringify({ profile, until, allReached: false, perApp: [], error: 'profile resolved to zero apps' }) + '\n');
        process.exit(1);
      }
      const allReached = apps.every(a => !a.timedOut);
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
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const doneEv = await streamNdjson(`/api/apps/${encodeURIComponent(name)}/focus?${params.toString()}`, 'POST');
      // Honour the documented exit-code contract: a timeout (target not reached
      // before the deadline) must exit 2, not 0. The stream's terminal event
      // carries reason: 'reached' | 'timeout' | 'closed'.
      if (doneEv && doneEv.reason && doneEv.reason !== 'reached') process.exit(2);
      return;
    }
    case 'pin-health': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon pin-health <name> [--accept] [--path <p>]' }));
      const status = await call(`/api/apps/${encodeURIComponent(name)}?format=full`);
      if (status.status === 404) await suggestUnknownApp(name);
      const discovered: string | null = (status.body as any)?.discoveredHealthPath ?? null;
      const candidate = f.path ?? discovered ?? null;
      if (!f.accept) {
        out({ app: name, discoveredHealthPath: discovered, candidate, hint: candidate ? `re-run with --accept to persist ${candidate} to daimon.config.json` : 'no path discovered yet; start the app and wait for first serving' });
        return;
      }
      if (!candidate) fail(JSON.stringify({ error: 'no path to pin — pass --path or wait for auto-discovery' }));
      const r = await callJson(`/api/apps/${encodeURIComponent(name)}/health/pin`, 'POST', { path: candidate });
      if (r.status === 404) await suggestUnknownApp(name);
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
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
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
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/try-fix?${params.toString()}`, 'POST');
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      if (r.body && r.body.reached === false) process.exit(2);
      return;
    }
    case 'wait': {
      const name = f.positional[0];
      if (!name) fail(JSON.stringify({ error: 'usage: daimon wait <name> [--until serving|healthy|stopped|error] [--timeout 120s]' }));
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      if (f.until) params.set('until', f.until);
      let timeoutSec = 120;
      if (f.timeout) {
        const t = durationToSeconds(f.timeout);
        if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
        timeoutSec = Math.min(t, 600);
      }
      params.set('timeout', String(Math.ceil(timeoutSec)));
      const r = await call(`/api/apps/${encodeURIComponent(name)}/wait?${params.toString()}`);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 404) await suggestUnknownApp(name);
      out(r.body);
      if (r.body?.timedOut) process.exit(2);
      return;
    }
    case 'up':
    case 'down': {
      const profile = f.positional[0];
      const knownConfig = (await loadCfg()).config;
      // Groups resolve first (M94) — documented precedence over the legacy
      // profiles map. The daemon runs the depends-aware plan server-side and
      // returns the readiness summary; legacy profile invocations below stay
      // byte-identical.
      if (profile && knownConfig.groups?.[profile]) {
        const params = new URLSearchParams();
        if (f.steal) params.set('steal', '1');
        if (cmd === 'up') {
          const until = (f.until || 'healthy').toLowerCase();
          if (until !== 'serving' && until !== 'healthy') fail(JSON.stringify({ error: 'up --until must be serving|healthy' }));
          params.set('until', until);
          let timeoutSec = 300;
          if (f.timeout) {
            const t = durationToSeconds(f.timeout);
            if (t == null) failHint(`invalid --timeout: ${f.timeout}`, 'durations look like 30s, 5m, 2h');
            timeoutSec = Math.min(t, 1200);
          }
          params.set('timeoutMs', String(Math.ceil(timeoutSec * 1000)));
        }
        const action = cmd === 'up' ? 'up' : 'stop';
        const r = await call(`/api/groups/${encodeURIComponent(profile)}/${action}?${params.toString()}`, 'POST');
        if (r.status === 404) failHint(`unknown group: ${profile}`, "the daemon's config may be older than the CLI's — run 'daimon daemon restart', then 'daimon config validate'");
        out(r.body);
        if (cmd === 'up' && r.body?.allReached === false) process.exit(2);
        // down <group>: a member still running (lock-refused or stop timeout)
        // is an error, not a silent 0.
        if (cmd === 'down' && r.body?.allStopped === false) process.exit(1);
        return;
      }
      const listRes = await call('/api/apps');
      const all: any[] = Array.isArray(listRes.body) ? listRes.body : [];
      let targets: string[];
      if (!profile) {
        targets = knownConfig.autoStart || [];
        if (cmd === 'up' && targets.length === 0) {
          failHint('no autoStart configured and no profile given', "add an autoStart list or a profiles entry to daimon.config.json, or start one app with 'daimon start <name>'");
        }
        if (cmd === 'down' && targets.length === 0) {
          targets = all.map(a => a.name);
        }
      } else {
        const list = knownConfig.profiles?.[profile];
        if (!list) failHint(`unknown profile: ${profile}`, "profiles are named sets in daimon.config.json `profiles`; run 'daimon profiles suggest' for candidates");
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
      await resolveGroupFlag(f);
      const name = f.positional[0];
      // `logs --group <g>` (M95): ts-merged tail across the group's members,
      // each line carrying its app. --tail/--since/--grep apply to the merge.
      if (f.groupName && !name) {
        const params = new URLSearchParams();
        if (f.tail != null && !Number.isNaN(f.tail)) params.set('tail', String(f.tail));
        if (f.since) params.set('since', f.since);
        if (f.grep) params.set('grep', f.grep);
        if (f.level) params.set('level', f.level);
        const qs = params.toString();
        const r = await call(`/api/groups/${encodeURIComponent(f.groupName)}/logs${qs ? '?' + qs : ''}`);
        if (r.status === 404) failGroup(f.groupName, r.body);
        if (r.status === 400) fail(JSON.stringify(r.body));
        out(r.body);
        return;
      }
      if (f.groupName && name) failHint('pass either an app name or --group <group>, not both', 'usage: daimon logs <name> | daimon logs --group <group>');
      if (!name) fail(JSON.stringify({ error: 'usage: daimon logs <name> [--tail N] [--since 30s] [--level error|warn|info|debug] [--grep <regex>] [--stream] | --group <group>' }));
      if (!f.all) await ensureCurrentWorkspace();
      const params = scopeQs(f);
      if (f.tail != null && !Number.isNaN(f.tail)) params.set('tail', String(f.tail));
      if (f.since) params.set('since', f.since);
      if (f.grep) params.set('grep', f.grep);
      if (f.level) params.set('level', f.level);
      if (f.stream) {
        // Live tail (SSE) with the server-side --grep filter applied; emits
        // NDJSON {ts,line} until SIGINT.
        try {
          const res = await fetch(getBaseUrl() + `/api/apps/${encodeURIComponent(name)}/logs/stream?${params.toString()}`, { headers: authHeaders() });
          if (res.status === 404) await suggestUnknownApp(name);
          if (!res.ok || !res.body) failHint(`stream failed: HTTP ${res.status}`, "check 'daimon daemon status', then retry; 'daimon daemon restart' hands off to a fresh daemon");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const chunks = buf.split('\n\n');
            buf = chunks.pop() ?? '';
            for (const chunk of chunks) {
              const data = chunk.split('\n').find(l => l.startsWith('data: '));
              if (data) process.stdout.write(data.slice(6) + '\n');
            }
          }
        } catch (err: any) {
          fail(JSON.stringify({ error: err?.message || String(err) }));
        }
        return;
      }
      const qs = params.toString();
      const r = await call(`/api/apps/${encodeURIComponent(name)}/logs${qs ? '?' + qs : ''}`);
      if (r.status === 412) reportCollisionAndExit(r.body);
      if (r.status === 400) fail(JSON.stringify(r.body));
      if (r.status === 404) await suggestUnknownApp(name);
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
