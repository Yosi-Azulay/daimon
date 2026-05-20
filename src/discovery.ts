import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { AppmanConfig, DiscoveredApp } from './types.js';

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

function fileContains(p: string, rx: RegExp): boolean {
  try { return rx.test(fs.readFileSync(p, 'utf8')); } catch { return false; }
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
    const name = baseName;
    if (!found.has(name)) {
      found.set(name, {
        name,
        workspaceRoot: root,
        workspaceType: 'polyglot',
        serverProfile: 'django',
        command: 'python manage.py runserver',
        hidden: false,
        tags: [],
        workspaceLabel,
      });
    }
    matched = true;
  }

  const railsBin = path.join(root, 'bin', 'rails');
  const gemfile = path.join(root, 'Gemfile');
  if (fs.existsSync(railsBin) && fs.existsSync(gemfile)) {
    const name = baseName;
    if (!found.has(name)) {
      found.set(name, {
        name,
        workspaceRoot: root,
        workspaceType: 'polyglot',
        serverProfile: 'rails',
        command: 'bin/rails server',
        hidden: false,
        tags: [],
        workspaceLabel,
      });
    }
    matched = true;
  }

  const pyproject = path.join(root, 'pyproject.toml');
  const requirementsTxt = path.join(root, 'requirements.txt');
  const hasFastapi =
    (fs.existsSync(pyproject) && fileContains(pyproject, /\bfastapi\b/i)) ||
    (fs.existsSync(requirementsTxt) && fileContains(requirementsTxt, /\bfastapi\b/i));
  if (hasFastapi && !found.has(baseName)) {
    found.set(baseName, {
      name: baseName,
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
  if (airToml && !found.has(baseName)) {
    found.set(baseName, {
      name: baseName,
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
  if (fs.existsSync(trunkToml) && !found.has(baseName)) {
    found.set(baseName, {
      name: baseName,
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

export function discoverApps(config: AppmanConfig, opts: DiscoverOptions = {}): DiscoveredApp[] {
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
      });

      for (const pf of projectFiles) {
        if (opts.stats) opts.stats.scanned += 1;
        const pj = readJson(pf);
        if (!pj) { bump(opts.stats, 'unreadable project.json'); continue; }
        if (!hasServeTarget(pj)) { bump(opts.stats, 'no serve target'); continue; }
        const name: string | undefined = pj.name || path.basename(path.dirname(pf));
        if (!name) { bump(opts.stats, 'project has no name'); continue; }
        if (found.has(name)) {
          warnings.push(`duplicate project name "${name}" — keeping first`);
          bump(opts.stats, 'duplicate name');
          continue;
        }
        found.set(name, {
          name,
          workspaceRoot: root,
          workspaceType: 'nx',
          serverProfile: 'nx',
          command: `npx nx serve ${name}`,
          hidden: false,
          tags: [],
          tasks: listTargetsExceptServe(pj),
          workspaceLabel,
        });
      }
      continue;
    }

    if (fs.existsSync(angularJson)) {
      const ng = readJson(angularJson);
      const projects = ng?.projects || {};
      for (const [name, p] of Object.entries<any>(projects)) {
        if (!hasServeTarget(p)) continue;
        if (found.has(name)) {
          warnings.push(`duplicate project name "${name}" — keeping first`);
          continue;
        }
        found.set(name, {
          name,
          workspaceRoot: root,
          workspaceType: 'angular',
          serverProfile: 'angular',
          command: `npx ng serve ${name}`,
          hidden: false,
          tags: [],
          tasks: listTargetsExceptServe(p),
          workspaceLabel,
        });
      }
      continue;
    }

    const hasVite = fg.sync('vite.config.{ts,js,mjs,cjs}', { cwd: toFgPath(root), absolute: true, deep: 1 });
    const hasStorybook = fs.existsSync(path.join(root, '.storybook'));
    let matched = false;

    if (hasVite.length > 0) {
      const name = path.basename(root);
      if (!found.has(name)) {
        found.set(name, {
          name,
          workspaceRoot: root,
          workspaceType: 'vite',
          serverProfile: 'vite',
          command: `npx vite`,
          hidden: false,
          tags: [],
          workspaceLabel,
        });
      }
      matched = true;
      if (viteSubfolders) {
        const sub = fg.sync('*/vite.config.{ts,js,mjs,cjs}', { cwd: toFgPath(root), absolute: true });
        for (const f of sub) {
          const dir = path.dirname(f);
          const subName = path.basename(dir);
          if (subName === name || found.has(subName)) continue;
          found.set(subName, {
            name: subName,
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
      const name = `${path.basename(root)}-storybook`;
      if (!found.has(name)) {
        found.set(name, {
          name,
          workspaceRoot: root,
          workspaceType: 'storybook',
          serverProfile: 'storybook',
          command: `npx storybook dev --no-open`,
          hidden: false,
          tags: [],
          workspaceLabel,
        });
      }
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
    const existing = found.get(name);
    if (existing) {
      if (ov.command) existing.command = ov.command;
      if (typeof ov.hidden === 'boolean') existing.hidden = ov.hidden;
      if (typeof ov.port === 'number') existing.pinnedPort = ov.port;
      if (ov.env) existing.env = ov.env;
    } else if (ov.command) {
      found.set(name, {
        name,
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
    a.tags = config.tags?.[a.name] ?? [];
  }

  if (ownsWarnings && warnings.length) {
    for (const w of warnings) {
      process.stderr.write(`[daimon] warning: ${w}\n`);
    }
  }

  return [...found.values()].filter(a => !a.hidden);
}
