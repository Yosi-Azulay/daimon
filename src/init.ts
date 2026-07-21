import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { discoverApps, type DiscoveryStats } from './discovery.js';
import type { AppmanConfig, DiscoveredApp } from './types.js';

// `daimon init` is a UI over the REAL discovery scan (M168, v1.14).
//
// It used to carry its own four-marker list (nx.json / angular.json /
// vite.config.* / .storybook) while discovery.ts knew the whole framework
// registry — so the wizard and the daemon literally disagreed about what was
// in the folder. That forked list is deleted: init builds a proposal by
// calling `discoverApps()` with cwd as the proposed searchRoot, which means a
// new FrameworkProfile row lights up here for free.
//
// Two invariants this module owes the user:
//   1. It writes EXACTLY ONE file — `daimon.config.json` in cwd. Never
//      ~/.daimon/*, never user source, never a .env, never a second file.
//   2. It NEVER overwrites without explicit consent: interactive mode asks,
//      `--yes` refuses outright, `--force` is the documented override.

export const DEFAULT_PORT_RANGE: [number, number] = [4200, 4299];
export const DEFAULT_API_PORT = 4999;
export const CONFIG_FILENAME = 'daimon.config.json';

export interface ProposedApp {
  name: string;
  profile: string;
  command: string;
  workspaceRoot: string;
}

export interface InitProposal {
  cwd: string;
  configPath: string;
  /** True when a config already exists at configPath (overwrite territory). */
  exists: boolean;
  searchRoots: (string | { path: string; label?: string })[];
  apps: ProposedApp[];
  portRange: [number, number];
  apiPort: number;
  /** Discovery telemetry for the zero-detection explanation. Local only. */
  scanned: number;
  rejected: Record<string, number>;
  profiles: Record<string, number>;
  warnings: string[];
}

export interface InitOpts {
  cwd?: string;
  force?: boolean;
  auto?: boolean;
  /** Non-interactive: accept the scanned proposal exactly (M168). */
  yes?: boolean;
  /** Test seams — default to the real stdio. */
  input?: Readable;
  output?: Writable;
}

export interface InitResult {
  path: string;
  installClaude: boolean;
  config: any;
  auto?: boolean;
  yes?: boolean;
  /** True when the user declined; nothing was written. */
  cancelled?: boolean;
  proposal?: InitProposal;
}

function readPackageName(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {}
  return undefined;
}

/**
 * Build the init proposal by running the real discovery scan with `cwd` as the
 * proposed searchRoot. Pure with respect to the filesystem: reads only, writes
 * nothing.
 */
export function buildProposal(opts: { cwd?: string; portRange?: [number, number]; apiPort?: number } = {}): InitProposal {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const label = readPackageName(cwd);
  const rootEntry: string | { path: string; label?: string } = label ? { path: cwd, label } : cwd;

  const stats: DiscoveryStats = { scanned: 0, rejected: {}, profiles: {} };
  const warnings: string[] = [];
  let apps: DiscoveredApp[] = [];
  try {
    // A partial config is all discovery consumes (searchRoots / frameworks /
    // overrides / tags); passing warnings keeps the scan from writing to
    // stderr behind the wizard's back.
    const probe = { searchRoots: [rootEntry], frameworks: [], overrides: {}, tags: {} } as unknown as AppmanConfig;
    apps = discoverApps(probe, { warnings, stats });
  } catch (err: any) {
    warnings.push(`discovery failed: ${err?.message || String(err)}`);
  }

  const configPath = path.join(cwd, CONFIG_FILENAME);
  return {
    cwd,
    configPath,
    exists: fs.existsSync(configPath),
    searchRoots: [rootEntry],
    apps: apps.map(a => ({
      name: a.name,
      profile: a.serverProfile ?? a.workspaceType ?? 'unknown',
      command: a.command,
      workspaceRoot: a.workspaceRoot,
    })),
    portRange: opts.portRange ?? DEFAULT_PORT_RANGE,
    apiPort: opts.apiPort ?? DEFAULT_API_PORT,
    scanned: stats.scanned,
    rejected: { ...stats.rejected },
    profiles: { ...(stats.profiles ?? {}) },
    warnings,
  };
}

/** The config object a proposal writes. Kept deliberately minimal. */
export function proposalToConfig(p: InitProposal): any {
  return { searchRoots: p.searchRoots, portRange: p.portRange, apiPort: p.apiPort };
}

function writeConfig(target: string, config: any): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function overwriteError(target: string, how: string): Error {
  return new Error(
    `refusing to overwrite ${target} (${how})`,
  );
}

/** The likeliest reason a scan came back empty, phrased as a remedy. */
export function explainEmpty(p: InitProposal): string[] {
  const lines: string[] = [];
  const reasons = Object.entries(p.rejected).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) {
    lines.push(`no framework markers found in ${p.cwd}`);
  } else {
    for (const [reason, n] of reasons) lines.push(`${reason} (${n})`);
  }
  lines.push("run 'daimon frameworks' to see every profile daimon can detect, or add an overrides.<app>.command entry by hand");
  return lines;
}

// `null` means the input stream ended before an answer arrived — `daimon init`
// piped from /dev/null, or run by a script that forgot `--yes`. Without this,
// the readline question simply never settles and the command HANGS forever
// (it wrote nothing, but it also never exited). EOF is treated as "no".
function ask(rl: readline.Interface, q: string): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false;
    const onClose = () => { if (!settled) { settled = true; resolve(null); } };
    rl.once('close', onClose);
    rl.question(q, ans => {
      settled = true;
      rl.off('close', onClose);
      resolve(ans.trim());
    });
  });
}

function renderProposal(p: InitProposal, write: (s: string) => void): void {
  write(`[daimon init] scanning ${p.cwd}\n`);
  if (p.apps.length) {
    write(`[daimon init] detected ${p.apps.length} app${p.apps.length === 1 ? '' : 's'}:\n`);
    for (const a of p.apps) write(`  - ${a.name}  (${a.profile})  ${a.command}\n`);
  } else {
    write('[daimon init] detected no apps in this directory:\n');
    for (const line of explainEmpty(p)) write(`  - ${line}\n`);
  }
  write(`[daimon init] searchRoot: ${typeof p.searchRoots[0] === 'string' ? p.searchRoots[0] : (p.searchRoots[0] as any).path}\n`);
  write(`[daimon init] portRange: ${p.portRange[0]}-${p.portRange[1]}   apiPort: ${p.apiPort}\n`);
}

function renderClosingHints(p: InitProposal, write: (s: string) => void): void {
  write(`[daimon init] wrote ${p.configPath}\n`);
  write('[daimon init] next: `daimon daemon start`, then `daimon list`\n');
  write('[daimon init] optional: `daimon claude install` adds the Claude Code integration\n');
}

/**
 * `--auto`: no prompts, safe defaults. Shape preserved from v0.x; only the
 * detection underneath changed (marker list → real discovery scan).
 */
export async function runInitAuto(opts: InitOpts = {}): Promise<InitResult> {
  const p = buildProposal({ cwd: opts.cwd });
  if (p.exists && !opts.force) throw overwriteError(p.configPath, 'pass --force to overwrite');
  const config = proposalToConfig(p);
  writeConfig(p.configPath, config);
  return { path: p.configPath, installClaude: false, config, auto: true, proposal: p };
}

/**
 * `--yes`: accept the scanned proposal exactly, non-interactively. Refuses to
 * clobber an existing config (that is what `--force` is for) — a scripted run
 * must never silently replace a hand-written config.
 */
export async function runInitYes(opts: InitOpts = {}): Promise<InitResult> {
  const p = buildProposal({ cwd: opts.cwd });
  if (p.exists && !opts.force) {
    throw overwriteError(
      p.configPath,
      `run 'daimon init --force' to replace it, or 'daimon init' to review the change first`,
    );
  }
  const config = proposalToConfig(p);
  writeConfig(p.configPath, config);
  return { path: p.configPath, installClaude: false, config, yes: true, proposal: p };
}

export async function runInit(opts: InitOpts = {}): Promise<InitResult> {
  if (opts.auto) return runInitAuto(opts);
  if (opts.yes) return runInitYes(opts);

  const out = opts.output ?? process.stdout;
  const write = (s: string) => { out.write(s); };
  const p = buildProposal({ cwd: opts.cwd });
  const rl = readline.createInterface({ input: opts.input ?? process.stdin, output: out });
  try {
    renderProposal(p, write);

    const cancel = (why: string): InitResult => {
      write(`[daimon init] ${why} — nothing was written\n`);
      return { path: p.configPath, installClaude: false, config: null, cancelled: true, proposal: p };
    };
    const noInput = 'no input on stdin (use `daimon init --yes` to accept the proposal non-interactively)';

    if (p.exists && !opts.force) {
      write(`[daimon init] ${p.configPath} already exists.\n`);
      const existing = summarizeExisting(p.configPath);
      for (const line of existing) write(`  current: ${line}\n`);
      const ans = await ask(rl, 'Overwrite it with the proposal above? [y/N] ');
      if (ans === null) return cancel(noInput);
      // Silence means NO here: replacing a file the user already wrote is the
      // one action in this command that destroys something.
      if (!(ans || 'n').toLowerCase().startsWith('y')) return cancel('cancelled');
    } else {
      const ans = await ask(rl, `Write ${p.configPath}? [Y/n] `);
      if (ans === null) return cancel(noInput);
      if (!(ans || 'y').toLowerCase().startsWith('y')) return cancel('cancelled');
    }

    const portRangeRaw = await ask(rl, `Port range [${p.portRange[0]}-${p.portRange[1]}]: `);
    if (portRangeRaw === null) return cancel(noInput);
    const portMatch = (portRangeRaw || `${p.portRange[0]}-${p.portRange[1]}`).match(/^(\d+)\s*[-,\s]\s*(\d+)$/);
    // Anything unparseable keeps the default rather than writing a config the
    // daemon would then refuse to load.
    if (portMatch) {
      const lo = Number(portMatch[1]);
      const hi = Number(portMatch[2]);
      if (lo > 0 && hi >= lo && hi < 65536) p.portRange = [lo, hi];
    }

    const apiPortRaw = await ask(rl, `apiPort [${p.apiPort}]: `);
    if (apiPortRaw === null) return cancel(noInput);
    const apiPort = Number(apiPortRaw || p.apiPort);
    if (Number.isInteger(apiPort) && apiPort > 0 && apiPort < 65536) p.apiPort = apiPort;

    const config = proposalToConfig(p);
    writeConfig(p.configPath, config);
    renderClosingHints(p, write);
    return { path: p.configPath, installClaude: false, config, proposal: p };
  } finally {
    rl.close();
  }
}

/** One-line-per-key summary of the config already on disk, for the overwrite prompt. */
function summarizeExisting(target: string): string[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(target, 'utf8'));
    const lines: string[] = [];
    const roots = Array.isArray(cfg.searchRoots) ? cfg.searchRoots : [];
    lines.push(`searchRoots: ${roots.length ? roots.map((r: any) => (typeof r === 'string' ? r : r?.path)).join(', ') : '(none)'}`);
    if (Array.isArray(cfg.portRange)) lines.push(`portRange: ${cfg.portRange[0]}-${cfg.portRange[1]}`);
    if (cfg.apiPort != null) lines.push(`apiPort: ${cfg.apiPort}`);
    const extra = Object.keys(cfg).filter(k => !['searchRoots', 'portRange', 'apiPort'].includes(k));
    if (extra.length) lines.push(`other keys that would be LOST: ${extra.join(', ')}`);
    return lines;
  } catch {
    return ['(unreadable — it will be replaced)'];
  }
}
