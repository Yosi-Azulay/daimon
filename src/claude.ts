import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAIMON_VERSION } from './version.js';
import { CLI_SUBCOMMANDS, commandsTable } from './cliSurface.js';
import { daimonDir } from './daemon.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Manifest {
  'daimon-version': string;
  'installed-at': string;
  skill?: { path: string } | null;
  commands?: string[];
  agent?: { path: string } | null;
}

export interface InstallSelection {
  skill: boolean;
  commands: boolean;
  agent: boolean;
}

export interface InstallOpts extends InstallSelection {
  dir: string;
  apiPort: number;
}

export const COMMAND_NAMES = ['status', 'start', 'stop', 'restart', 'errors', 'logs', 'up', 'doctor', 'why', 'wait'];

export function defaultClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

export function manifestPath(dir: string): string {
  return path.join(dir, 'daimon.installed.json');
}

function templatesDir(): string {
  const candidates = [
    path.resolve(here, 'templates', 'claude'),
    path.resolve(here, '..', 'src', 'templates', 'claude'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('claude templates directory not found');
}

function readTemplate(rel: string): string {
  return fs.readFileSync(path.join(templatesDir(), rel), 'utf8');
}

function render(template: string, apiPort: number): string {
  const now = new Date().toISOString();
  return template
    .replace(/\{\{daimon_version\}\}/g, DAIMON_VERSION)
    .replace(/\{\{api_port\}\}/g, String(apiPort))
    .replace(/\{\{generated_at\}\}/g, now)
    .replace(/\{\{commands_table\}\}/g, commandsTable());
}

function writeFile(p: string, contents: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents, 'utf8');
}

export function readManifest(dir: string): Manifest | null {
  try {
    let raw = fs.readFileSync(manifestPath(dir), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

export function writeManifest(dir: string, m: Manifest): void {
  writeFile(manifestPath(dir), JSON.stringify(m, null, 2) + '\n');
}

export function install(opts: InstallOpts): { installed: string[]; manifestPath: string } {
  const installed: string[] = [];
  const manifest: Manifest = readManifest(opts.dir) ?? {
    'daimon-version': DAIMON_VERSION,
    'installed-at': new Date().toISOString(),
  };
  manifest['daimon-version'] = DAIMON_VERSION;
  manifest['installed-at'] = new Date().toISOString();

  if (opts.skill) {
    const rel = path.join('skills', 'daimon', 'SKILL.md');
    writeFile(path.join(opts.dir, rel), render(readTemplate('skill.md.tmpl'), opts.apiPort));
    manifest.skill = { path: rel.replace(/\\/g, '/') };
    installed.push(rel);
  }
  if (opts.commands) {
    const cmdList: string[] = [];
    for (const name of COMMAND_NAMES) {
      const rel = path.join('commands', `daimon-${name}.md`);
      writeFile(path.join(opts.dir, rel), render(readTemplate(path.join('commands', `${name}.md.tmpl`)), opts.apiPort));
      cmdList.push(name);
      installed.push(rel);
    }
    manifest.commands = cmdList;
  }
  if (opts.agent) {
    const rel = path.join('agents', 'daimon-runner.md');
    writeFile(path.join(opts.dir, rel), render(readTemplate('agent.md.tmpl'), opts.apiPort));
    manifest.agent = { path: rel.replace(/\\/g, '/') };
    installed.push(rel);
  }

  writeManifest(opts.dir, manifest);
  return { installed, manifestPath: manifestPath(opts.dir) };
}

export function uninstall(opts: { dir: string; selection: Partial<InstallSelection> & { all?: boolean } }): { removed: string[]; manifestPath: string | null } {
  const removed: string[] = [];
  const m = readManifest(opts.dir);
  if (!m) return { removed, manifestPath: null };
  const all = opts.selection.all;

  if ((all || opts.selection.skill) && m.skill) {
    const p = path.join(opts.dir, m.skill.path);
    try { fs.rmSync(p, { force: true }); removed.push(m.skill.path); } catch {}
    try { fs.rmdirSync(path.dirname(p)); } catch {}
    m.skill = null;
  }
  if ((all || opts.selection.commands) && m.commands) {
    for (const name of m.commands) {
      const rel = path.join('commands', `daimon-${name}.md`);
      try { fs.rmSync(path.join(opts.dir, rel), { force: true }); removed.push(rel); } catch {}
    }
    m.commands = [];
  }
  if ((all || opts.selection.agent) && m.agent) {
    try { fs.rmSync(path.join(opts.dir, m.agent.path), { force: true }); removed.push(m.agent.path); } catch {}
    m.agent = null;
  }

  if (!m.skill && (!m.commands || m.commands.length === 0) && !m.agent) {
    try { fs.unlinkSync(manifestPath(opts.dir)); } catch {}
    return { removed, manifestPath: null };
  }
  writeManifest(opts.dir, m);
  return { removed, manifestPath: manifestPath(opts.dir) };
}

export function status(dir: string): { skill: { installed: boolean; version: string | null; path: string | null }; commands: { installed: boolean; version: string | null; names: string[] }; agent: { installed: boolean; version: string | null; path: string | null }; manifestPath: string | null } {
  const m = readManifest(dir);
  if (!m) {
    return {
      skill: { installed: false, version: null, path: null },
      commands: { installed: false, version: null, names: [] },
      agent: { installed: false, version: null, path: null },
      manifestPath: null,
    };
  }
  return {
    skill: { installed: !!m.skill, version: m.skill ? m['daimon-version'] : null, path: m.skill?.path ?? null },
    commands: { installed: !!(m.commands && m.commands.length), version: m.commands && m.commands.length ? m['daimon-version'] : null, names: m.commands ?? [] },
    agent: { installed: !!m.agent, version: m.agent ? m['daimon-version'] : null, path: m.agent?.path ?? null },
    manifestPath: manifestPath(dir),
  };
}

const NUDGE_FILE = path.join(daimonDir(), '.claude-nudge');
const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function checkVersionDriftAndNudge(): void {
  if (process.env.DAIMON_NO_CLAUDE_NUDGE === '1') return;
  const dir = defaultClaudeDir();
  const m = readManifest(dir);
  if (!m) return;
  if (m['daimon-version'] === DAIMON_VERSION) return;
  try {
    const stat = fs.statSync(NUDGE_FILE);
    if (Date.now() - stat.mtimeMs < NUDGE_INTERVAL_MS) return;
  } catch {}
  process.stderr.write(`[daimon] claude integration is from v${m['daimon-version']} — run \`daimon claude update\` to refresh\n`);
  try {
    fs.mkdirSync(path.dirname(NUDGE_FILE), { recursive: true });
    fs.writeFileSync(NUDGE_FILE, String(Date.now()));
  } catch {}
}

void CLI_SUBCOMMANDS;
