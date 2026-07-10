import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { AppmanConfig, DiscoveredApp } from './types.js';
import { isSafeAppName } from './shellSafe.js';
import {
  allProfiles, matchDetect, resolveCommand, RootFs,
  pnpmWorkspaceGlobs, packageJsonWorkspaceGlobs,
  type FrameworkProfile,
} from './frameworks.js';

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

// Single-app profile: marker match registers one app named after the dir.
// `dir` is the searchRoot itself, or a workspace member package (M66);
// `workspaceFs` (member case) supplies the root lockfile for pm detection.
function detectSingleApp(
  profile: FrameworkProfile,
  ctx: RootContext,
  dir: string,
  dirFs: RootFs,
  workspaceFs?: RootFs,
): boolean {
  if (!matchDetect(profile.detect, dirFs)) return false;
  const command = resolveCommand(profile, dirFs, workspaceFs);
  if (command === null) return false;
  const baseName = `${path.basename(dir)}${profile.nameSuffix ?? ''}`;
  const added = addUnique(ctx.found, baseName, {
    workspaceRoot: dir,
    workspaceType: profile.workspaceType,
    serverProfile: profile.id,
    command,
    hidden: false,
    tags: [],
    workspaceLabel: ctx.workspaceLabel,
  });
  if (added) bumpProfile(ctx.stats, profile.id);

  // Vite keeps its opt-in subfolder scan: `{ path, viteSubfolders: true }`
  // roots register each direct child with its own vite config too.
  if (profile.id === 'vite' && ctx.viteSubfolders && dir === ctx.root) {
    const sub = fg.sync('*/vite.config.{ts,js,mjs,cjs}', { cwd: toFgPath(ctx.root), absolute: true, followSymbolicLinks: false });
    for (const f of sub) {
      const subDir = path.dirname(f);
      const subBase = path.basename(subDir);
      if (subBase === path.basename(ctx.root)) continue;
      const subAdded = addUnique(ctx.found, subBase, {
        workspaceRoot: subDir,
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

// Generic package.json fallback (M66). Lowest precedence: skipped whenever a
// named profile already matched the directory, and never inside node_modules.
// Every skip is explained in discovery.stats.rejected.
function tryFallback(
  profile: FrameworkProfile,
  ctx: RootContext,
  dir: string,
  dirFs: RootFs,
  matched: Set<string>,
  workspaceFs?: RootFs,
): boolean {
  if (dir.split(/[\\/]/).includes('node_modules')) {
    if (matchDetect(profile.detect, dirFs)) bump(ctx.stats, 'fallback: inside node_modules');
    return false;
  }
  if (matched.size > 0) {
    if (matchDetect(profile.detect, dirFs)) bump(ctx.stats, 'fallback superseded by named profile');
    return false;
  }
  if (detectSingleApp(profile, ctx, dir, dirFs, workspaceFs)) return true;
  if (dirFs.exists('package.json')) bump(ctx.stats, 'package.json has no dev/serve/start script');
  return false;
}

// pnpm-workspace.yaml / turbo.json enumerator (M66): member packages get the
// full single-app profile pass, the way nx.json enumerates project.json.
function enumerateMembers(
  profile: FrameworkProfile,
  ctx: RootContext,
  rootFs: RootFs,
  profiles: FrameworkProfile[],
): boolean {
  let globs: { include: string[]; exclude: string[] };
  if (profile.workspace === 'pnpm') {
    const content = rootFs.content('pnpm-workspace.yaml');
    if (content === null) return false;
    globs = pnpmWorkspaceGlobs(content);
  } else {
    if (!rootFs.exists('turbo.json')) return false;
    globs = packageJsonWorkspaceGlobs(rootFs.packageJson());
  }
  if (globs.include.length === 0) return true; // marker present, nothing listed

  const patterns = globs.include.map(g => toFgPath(g).replace(/\/+$/, '') + '/package.json');
  const ignore = [
    '**/node_modules/**', '**/dist/**', '**/.git/**',
    ...globs.exclude.map(g => toFgPath(g).replace(/\/+$/, '') + '/**'),
  ];
  const pkgFiles = fg.sync(patterns, {
    cwd: toFgPath(ctx.root),
    ignore,
    absolute: true,
    dot: false,
    followSymbolicLinks: false,
  });

  for (const pf of pkgFiles.sort()) {
    const dir = path.resolve(path.dirname(pf)); // fg returns forward slashes on Windows
    if (dir === ctx.root) continue;
    if (ctx.stats) ctx.stats.scanned += 1;
    const dirFs = new RootFs(dir);
    const memberMatched = new Set<string>();
    for (const p of profiles) {
      if (p.workspace) continue; // no nested workspace enumeration
      if (p.suppressedBy?.some(id => memberMatched.has(id))) continue;
      const hit = p.fallback
        ? tryFallback(p, ctx, dir, dirFs, memberMatched, rootFs)
        : detectSingleApp(p, ctx, dir, dirFs, rootFs);
      if (hit) memberMatched.add(p.id);
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
      else if (profile.workspace === 'pnpm' || profile.workspace === 'turbo') hit = enumerateMembers(profile, ctx, rootFs, profiles);
      else if (profile.fallback) hit = tryFallback(profile, ctx, root, rootFs, matched);
      else hit = detectSingleApp(profile, ctx, root, rootFs);
      if (hit) matched.add(profile.id);
    }

    if (matched.size === 0) {
      warnings.push(`searchRoot matched no framework profile (run \`daimon frameworks\` to see the registry): ${root}`);
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
