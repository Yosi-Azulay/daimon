import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { AppmanConfig, DiscoveredApp } from './types.js';
import { isSafeAppName } from './shellSafe.js';

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
}

export interface DiscoverOptions {
  warnings?: string[];
  stats?: DiscoveryStats;
}

function bump(stats: DiscoveryStats | undefined, reason: string): void {
  if (!stats) return;
  stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
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

function fileContains(p: string, rx: RegExp): boolean {
  try { return rx.test(fs.readFileSync(p, 'utf8')); } catch { return false; }
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

function detectPolyglotApps(
  root: string,
  workspaceLabel: string | undefined,
  found: Map<string, DiscoveredApp>,
): boolean {
  const baseName = path.basename(root);
  let matched = false;

  const managePy = path.join(root, 'manage.py');
  if (fs.existsSync(managePy) && fileContains(managePy, /\bdjango\b/i)) {
    addUnique(found, baseName, {
      workspaceRoot: root,
      workspaceType: 'polyglot',
      serverProfile: 'django',
      command: 'python manage.py runserver',
      hidden: false,
      tags: [],
      workspaceLabel,
    });
    matched = true;
  }

  const railsBin = path.join(root, 'bin', 'rails');
  const gemfile = path.join(root, 'Gemfile');
  if (fs.existsSync(railsBin) && fs.existsSync(gemfile)) {
    addUnique(found, baseName, {
      workspaceRoot: root,
      workspaceType: 'polyglot',
      serverProfile: 'rails',
      command: 'bin/rails server',
      hidden: false,
      tags: [],
      workspaceLabel,
    });
    matched = true;
  }

  const pyproject = path.join(root, 'pyproject.toml');
  const requirementsTxt = path.join(root, 'requirements.txt');
  const hasFastapi =
    (fs.existsSync(pyproject) && fileContains(pyproject, /\bfastapi\b/i)) ||
    (fs.existsSync(requirementsTxt) && fileContains(requirementsTxt, /\bfastapi\b/i));
  if (hasFastapi) {
    addUnique(found, baseName, {
      workspaceRoot: root,
      workspaceType: 'polyglot',
      serverProfile: 'fastapi',
      command: 'uvicorn main:app --reload',
      hidden: false,
      tags: [],
      workspaceLabel,
    });
    matched = true;
  }

  const airToml = fs.existsSync(path.join(root, '.air.toml')) || fs.existsSync(path.join(root, 'air.toml'));
  if (airToml) {
    addUnique(found, baseName, {
      workspaceRoot: root,
      workspaceType: 'polyglot',
      serverProfile: 'go-air',
      command: 'air',
      hidden: false,
      tags: [],
      workspaceLabel,
    });
    matched = true;
  }

  const trunkToml = path.join(root, 'Trunk.toml');
  if (fs.existsSync(trunkToml)) {
    addUnique(found, baseName, {
      workspaceRoot: root,
      workspaceType: 'polyglot',
      serverProfile: 'rust-trunk',
      command: 'trunk serve',
      hidden: false,
      tags: [],
      workspaceLabel,
    });
    matched = true;
  }

  return matched;
}

// Warmup cache (M54): repeated scans with unchanged searchRoots (startup +
// dashboard explain + doctor within a few seconds) reuse the last result.
// The key embeds the full searchRoots config, so any root change invalidates;
// the short TTL keeps newly created workspaces discoverable without a restart.
const SCAN_CACHE_TTL_MS = 10_000;
let scanCache: { key: string; at: number; apps: DiscoveredApp[]; warnings: string[]; stats: DiscoveryStats } | null = null;

export function discoverApps(config: AppmanConfig, opts: DiscoverOptions = {}): DiscoveredApp[] {
  const cacheKey = JSON.stringify(config.searchRoots);
  if (scanCache && scanCache.key === cacheKey && Date.now() - scanCache.at < SCAN_CACHE_TTL_MS) {
    if (opts.warnings) opts.warnings.push(...scanCache.warnings);
    if (opts.stats) {
      opts.stats.scanned = scanCache.stats.scanned;
      opts.stats.rejected = { ...scanCache.stats.rejected };
    }
    return scanCache.apps.map(a => ({ ...a }));
  }
  const stats: DiscoveryStats = opts.stats ?? { scanned: 0, rejected: {} };
  opts = { ...opts, stats };
  const found = new Map<string, DiscoveredApp>();
  const warnings: string[] = opts.warnings ?? [];
  const ownsWarnings = opts.warnings === undefined;

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

    const nxJson = path.join(root, 'nx.json');
    const angularJson = path.join(root, 'angular.json');

    if (fs.existsSync(nxJson)) {
      const projectFiles = fg.sync('**/project.json', {
        cwd: toFgPath(root),
        ignore: ['**/node_modules/**', '**/dist/**', '**/.nx/**', '**/.git/**'],
        absolute: true,
        dot: false,
        // Don't follow symlinks out of the searchRoot — a symlink pointing
        // outside the tree could otherwise pull in projects (and set a
        // workspaceRoot) beyond the configured root.
        followSymbolicLinks: false,
      });

      for (const pf of projectFiles) {
        if (opts.stats) opts.stats.scanned += 1;
        const pj = readJson(pf);
        if (!pj) { bump(opts.stats, 'unreadable project.json'); continue; }
        if (!hasServeTarget(pj)) { bump(opts.stats, 'no serve target'); continue; }
        const name: string | undefined = pj.name || path.basename(path.dirname(pf));
        if (!name) { bump(opts.stats, 'project has no name'); continue; }
        const added = addUnique(found, name, {
          workspaceRoot: root,
          workspaceType: 'nx',
          serverProfile: 'nx',
          command: `npx nx serve ${name}`,
          hidden: false,
          tags: [],
          tasks: listTargetsExceptServe(pj),
          workspaceLabel,
        });
        if (!added) {
          warnings.push(`duplicate project name "${name}" within ${root} — keeping first`);
          bump(opts.stats, 'duplicate name');
        }
      }
      continue;
    }

    if (fs.existsSync(angularJson)) {
      const ng = readJson(angularJson);
      const projects = ng?.projects || {};
      for (const [name, p] of Object.entries<any>(projects)) {
        if (!hasServeTarget(p)) continue;
        const added = addUnique(found, name, {
          workspaceRoot: root,
          workspaceType: 'angular',
          serverProfile: 'angular',
          command: `npx ng serve ${name}`,
          hidden: false,
          tags: [],
          tasks: listTargetsExceptServe(p),
          workspaceLabel,
        });
        if (!added) warnings.push(`duplicate project name "${name}" within ${root} — keeping first`);
      }
      continue;
    }

    const hasVite = fg.sync('vite.config.{ts,js,mjs,cjs}', { cwd: toFgPath(root), absolute: true, deep: 1, followSymbolicLinks: false });
    const hasStorybook = fs.existsSync(path.join(root, '.storybook'));
    let matched = false;

    if (hasVite.length > 0) {
      const baseName = path.basename(root);
      addUnique(found, baseName, {
        workspaceRoot: root,
        workspaceType: 'vite',
        serverProfile: 'vite',
        command: `npx vite`,
        hidden: false,
        tags: [],
        workspaceLabel,
      });
      matched = true;
      if (viteSubfolders) {
        const sub = fg.sync('*/vite.config.{ts,js,mjs,cjs}', { cwd: toFgPath(root), absolute: true, followSymbolicLinks: false });
        for (const f of sub) {
          const dir = path.dirname(f);
          const subBase = path.basename(dir);
          if (subBase === baseName) continue;
          addUnique(found, subBase, {
            workspaceRoot: dir,
            workspaceType: 'vite',
            serverProfile: 'vite',
            command: `npx vite`,
            hidden: false,
            tags: [],
            workspaceLabel,
          });
        }
      }
    }

    if (hasStorybook) {
      const baseName = `${path.basename(root)}-storybook`;
      addUnique(found, baseName, {
        workspaceRoot: root,
        workspaceType: 'storybook',
        serverProfile: 'storybook',
        command: `npx storybook dev --no-open`,
        hidden: false,
        tags: [],
        workspaceLabel,
      });
      matched = true;
    }

    if (!matched) {
      const polyglotMatched = detectPolyglotApps(root, workspaceLabel, found);
      if (!polyglotMatched) {
        warnings.push(`searchRoot has none of nx.json/angular.json/vite.config.*/.storybook/polyglot markers: ${root}`);
        bump(opts.stats, 'no project markers');
      }
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
  scanCache = { key: cacheKey, at: Date.now(), apps: result.map(a => ({ ...a })), warnings: [...warnings], stats: { scanned: stats.scanned, rejected: { ...stats.rejected } } };
  return result;
}
