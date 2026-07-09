import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { AppmanConfig, DiscoveredApp } from './types.js';
import { isSafeAppName } from './shellSafe.js';
import { allProfiles, matchDetect, RootFs, type FrameworkProfile } from './frameworks.js';

function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function hasServeTarget(projectJson: any): boolean {
  if (!projectJson || typeof projectJson !== 'object') return false;
  if (projectJson.targets?.serve) return true;
  if (projectJson.architect?.serve) return true;
  return false;
}

function listTargetsExceptServe(projectJson: any): string[] {
  if (!projectJson || typeof projectJson !== 'object') return [];
  const targets = projectJson.targets ?? projectJson.architect ?? {};
  return Object.keys(targets).filter(t => t !== 'serve').sort();
}

function toFgPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export interface DiscoveryStats {
  scanned: number;
  rejected: Record<string, number>;
  // Per-profile match counts (M65). Keyed by profile id; workspace
  // enumerators count one per registered project.
  profiles?: Record<string, number>;
}

export interface DiscoverOptions {
  warnings?: string[];
  stats?: DiscoveryStats;
}

function bump(stats: DiscoveryStats | undefined, reason: string): void {
  if (!stats) return;
  stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
}

function bumpProfile(stats: DiscoveryStats | undefined, id: string, n = 1): void {
  if (!stats) return;
  if (!stats.profiles) stats.profiles = {};
  stats.profiles[id] = (stats.profiles[id] ?? 0) + n;
}

// Pick a globally unique storage key for `baseName`. When two workspaces have
// apps with the same baseName (e.g., both have an "editor"), the second one
// gets a suffix so both can coexist in the registry's Map. The user-facing
// baseName remains on the DiscoveredApp; CLI/server use `?cwd=` to resolve.
function uniqueKey(
  found: Map<string, DiscoveredApp>,
  baseName: string,
  workspaceLabel: string | undefined,
  workspaceRoot: string,
): { key: string; collided: boolean } {
  if (!found.has(baseName)) return { key: baseName, collided: false };
  const existing = found.get(baseName)!;
  if (existing.workspaceRoot === workspaceRoot) return { key: baseName, collided: true };
  const labelHint = workspaceLabel || path.basename(workspaceRoot);
  let candidate = `${baseName}@${labelHint}`;
  let i = 2;
  while (found.has(candidate)) candidate = `${baseName}@${labelHint}-${i++}`;
  return { key: candidate, collided: false };
}

function addUnique(
  found: Map<string, DiscoveredApp>,
  baseName: string,
  app: Omit<DiscoveredApp, 'name' | 'baseName'>,
): boolean {
  // The name is interpolated into the app's shell command (`npx nx serve
  // <name>` etc.). It comes from an untrusted repo (project.json / angular.json
  // key, or a directory basename), so reject anything with shell metacharacters
  // rather than register a project that would inject a command on `start`.
  if (!isSafeAppName(baseName)) return false;
  const { key, collided } = uniqueKey(found, baseName, app.workspaceLabel, app.workspaceRoot);
  if (collided) return false;
  found.set(key, { name: key, baseName, ...app });
  return true;
}

interface RootContext {
  root: string;
  workspaceLabel: string | undefined;
  viteSubfolders: boolean;
  found: Map<string, DiscoveredApp>;
  warnings: string[];
  stats: DiscoveryStats | undefined;
}

// Nx workspace enumerator: one app per project.json with a serve target.
// Returns true when the root is an nx workspace (even with zero projects) so
// the angular row stays suppressed and the root counts as "matched".
function enumerateNx(profile: FrameworkProfile, ctx: RootContext, rootFs: RootFs): boolean {
  if (!rootFs.exists('nx.json')) return false;
  const projectFiles = fg.sync('**/project.json', {
    cwd: toFgPath(ctx.root),
    ignore: ['**/node_modules/**', '**/dist/**', '**/.nx/**', '**/.git/**'],
    absolute: true,
    dot: false,
    // Don't follow symlinks out of the searchRoot — a symlink pointing
    // outside the tree could otherwise pull in projects (and set a
    // workspaceRoot) beyond the configured root.
    followSymbolicLinks: false,
  });

  for (const pf of projectFiles) {
    if (ctx.stats) ctx.stats.scanned += 1;
    const pj = readJson(pf);
    if (!pj) { bump(ctx.stats, 'unreadable project.json'); continue; }
    if (!hasServeTarget(pj)) { bump(ctx.stats, 'no serve target'); continue; }
    const name: string | undefined = pj.name || path.basename(path.dirname(pf));
    if (!name) { bump(ctx.stats, 'project has no name'); continue; }
    const added = addUnique(ctx.found, name, {
      workspaceRoot: ctx.root,
      workspaceType: profile.workspaceType,
      serverProfile: profile.id,
      command: profile.command.replace('{name}', name),
      hidden: false,
      tags: [],
      tasks: listTargetsExceptServe(pj),
      workspaceLabel: ctx.workspaceLabel,
    });
    if (added) {
      bumpProfile(ctx.stats, profile.id);
    } else {
      ctx.warnings.push(`duplicate project name "${name}" within ${ctx.root} — keeping first`);
      bump(ctx.stats, 'duplicate name');
    }
  }
  return true;
}

// Angular workspace enumerator: one app per angular.json project with a serve
// target. Matches on angular.json presence like the nx enumerator.
function enumerateAngular(profile: FrameworkProfile, ctx: RootContext, rootFs: RootFs): boolean {
  if (!rootFs.exists('angular.json')) return false;
  const ng = readJson(path.join(ctx.root, 'angular.json'));
  const projects = ng?.projects || {};
  for (const [name, p] of Object.entries<any>(projects)) {
    if (!hasServeTarget(p)) continue;
    const added = addUnique(ctx.found, name, {
      workspaceRoot: ctx.root,
      workspaceType: profile.workspaceType,
      serverProfile: profile.id,
      command: profile.command.replace('{name}', name),
      hidden: false,
      tags: [],
      tasks: listTargetsExceptServe(p),
      workspaceLabel: ctx.workspaceLabel,
    });
    if (added) bumpProfile(ctx.stats, profile.id);
    else ctx.warnings.push(`duplicate project name "${name}" within ${ctx.root} — keeping first`);
  }
  return true;
}

// Single-app profile: marker match registers one app named after the root dir.
function detectSingleApp(profile: FrameworkProfile, ctx: RootContext, rootFs: RootFs): boolean {
  if (!matchDetect(profile.detect, rootFs)) return false;
  const baseName = `${path.basename(ctx.root)}${profile.nameSuffix ?? ''}`;
  const added = addUnique(ctx.found, baseName, {
    workspaceRoot: ctx.root,
    workspaceType: profile.workspaceType,
    serverProfile: profile.id,
    command: profile.command,
    hidden: false,
    tags: [],
    workspaceLabel: ctx.workspaceLabel,
  });
  if (added) bumpProfile(ctx.stats, profile.id);

  // Vite keeps its opt-in subfolder scan: `{ path, viteSubfolders: true }`
  // roots register each direct child with its own vite config too.
  if (profile.id === 'vite' && ctx.viteSubfolders) {
    const sub = fg.sync('*/vite.config.{ts,js,mjs,cjs}', { cwd: toFgPath(ctx.root), absolute: true, followSymbolicLinks: false });
    for (const f of sub) {
      const dir = path.dirname(f);
      const subBase = path.basename(dir);
      if (subBase === path.basename(ctx.root)) continue;
      const subAdded = addUnique(ctx.found, subBase, {
        workspaceRoot: dir,
        workspaceType: profile.workspaceType,
        serverProfile: profile.id,
        command: profile.command,
        hidden: false,
        tags: [],
        workspaceLabel: ctx.workspaceLabel,
      });
      if (subAdded) bumpProfile(ctx.stats, profile.id);
    }
  }
  return true;
}

// Warmup cache (M54): repeated scans with unchanged searchRoots (startup +
// dashboard explain + doctor within a few seconds) reuse the last result.
// The key embeds the full searchRoots + custom-frameworks config, so any
// change invalidates; the short TTL keeps newly created workspaces
// discoverable without a restart.
const SCAN_CACHE_TTL_MS = 10_000;
let scanCache: { key: string; at: number; apps: DiscoveredApp[]; warnings: string[]; stats: DiscoveryStats } | null = null;

export function discoverApps(config: AppmanConfig, opts: DiscoverOptions = {}): DiscoveredApp[] {
  const cacheKey = JSON.stringify([config.searchRoots, config.frameworks ?? []]);
  if (scanCache && scanCache.key === cacheKey && Date.now() - scanCache.at < SCAN_CACHE_TTL_MS) {
    if (opts.warnings) opts.warnings.push(...scanCache.warnings);
    if (opts.stats) {
      opts.stats.scanned = scanCache.stats.scanned;
      opts.stats.rejected = { ...scanCache.stats.rejected };
      opts.stats.profiles = { ...(scanCache.stats.profiles ?? {}) };
    }
    return scanCache.apps.map(a => ({ ...a }));
  }
  const stats: DiscoveryStats = opts.stats ?? { scanned: 0, rejected: {} };
  opts = { ...opts, stats };
  const found = new Map<string, DiscoveredApp>();
  const warnings: string[] = opts.warnings ?? [];
  const ownsWarnings = opts.warnings === undefined;
  const profiles = allProfiles(config.frameworks);

  for (const rootEntry of config.searchRoots) {
    const rootRaw = typeof rootEntry === 'string' ? rootEntry : rootEntry.path;
    const viteSubfolders = typeof rootEntry === 'string' ? false : !!rootEntry.viteSubfolders;
    const workspaceLabel = typeof rootEntry === 'string' ? undefined : rootEntry.label;
    const root = path.resolve(rootRaw);
    if (!fs.existsSync(root)) {
      warnings.push(`searchRoot does not exist: ${root}`);
      bump(opts.stats, 'searchRoot missing');
      continue;
    }

    const ctx: RootContext = { root, workspaceLabel, viteSubfolders, found, warnings, stats: opts.stats };
    const rootFs = new RootFs(root);
    // Multi-family coexistence (M65): every profile row gets a shot at every
    // root; `suppressedBy` expresses the few intra-family precedence rules
    // (nx over angular, vite/storybook over the polyglot rows).
    const matched = new Set<string>();

    for (const profile of profiles) {
      if (profile.suppressedBy?.some(id => matched.has(id))) continue;
      let hit: boolean;
      if (profile.workspace === 'nx') hit = enumerateNx(profile, ctx, rootFs);
      else if (profile.workspace === 'angular') hit = enumerateAngular(profile, ctx, rootFs);
      else hit = detectSingleApp(profile, ctx, rootFs);
      if (hit) matched.add(profile.id);
    }

    if (matched.size === 0) {
      warnings.push(`searchRoot has none of nx.json/angular.json/vite.config.*/.storybook/polyglot markers: ${root}`);
      bump(opts.stats, 'no project markers');
    }
  }

  for (const [name, ov] of Object.entries(config.overrides || {})) {
    // Override lookup is by baseName: a user's `overrides["editor"]` should
    // match all entries whose baseName is "editor", not just the one stored
    // under the literal key "editor".
    const matches = [...found.values()].filter(a => (a.baseName ?? a.name) === name);
    if (matches.length > 0) {
      for (const existing of matches) {
        if (ov.command) existing.command = ov.command;
        if (typeof ov.hidden === 'boolean') existing.hidden = ov.hidden;
        if (typeof ov.port === 'number') existing.pinnedPort = ov.port;
        if (ov.env) existing.env = ov.env;
      }
    } else if (ov.command) {
      found.set(name, {
        name,
        baseName: name,
        workspaceRoot: process.cwd(),
        workspaceType: 'nx',
        command: ov.command,
        hidden: ov.hidden ?? false,
        pinnedPort: ov.port,
        env: ov.env,
        tags: [],
      });
    }
  }

  for (const a of found.values()) {
    a.tags = config.tags?.[a.baseName ?? a.name] ?? [];
  }

  if (ownsWarnings && warnings.length) {
    for (const w of warnings) {
      process.stderr.write(`[daimon] warning: ${w}\n`);
    }
  }

  const result = [...found.values()].filter(a => !a.hidden);
  scanCache = { key: cacheKey, at: Date.now(), apps: result.map(a => ({ ...a })), warnings: [...warnings], stats: { scanned: stats.scanned, rejected: { ...stats.rejected }, profiles: { ...(stats.profiles ?? {}) } } };
  return result;
}
