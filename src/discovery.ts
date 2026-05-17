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

function toFgPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function discoverApps(config: AppmanConfig): DiscoveredApp[] {
  const found = new Map<string, DiscoveredApp>();
  const warnings: string[] = [];

  for (const rootEntry of config.searchRoots) {
    const rootRaw = typeof rootEntry === 'string' ? rootEntry : rootEntry.path;
    const viteSubfolders = typeof rootEntry === 'string' ? false : !!rootEntry.viteSubfolders;
    const root = path.resolve(rootRaw);
    if (!fs.existsSync(root)) {
      warnings.push(`searchRoot does not exist: ${root}`);
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
        const pj = readJson(pf);
        if (!pj || !hasServeTarget(pj)) continue;
        const name: string | undefined = pj.name || path.basename(path.dirname(pf));
        if (!name) continue;
        if (found.has(name)) {
          warnings.push(`duplicate project name "${name}" — keeping first`);
          continue;
        }
        found.set(name, {
          name,
          workspaceRoot: root,
          workspaceType: 'nx',
          command: `npx nx serve ${name}`,
          hidden: false,
          tags: [],
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
          command: `npx ng serve ${name}`,
          hidden: false,
          tags: [],
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
          command: `npx vite`,
          hidden: false,
          tags: [],
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
            command: `npx vite`,
            hidden: false,
            tags: [],
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
          command: `npx storybook dev --no-open`,
          hidden: false,
          tags: [],
        });
      }
      matched = true;
    }

    if (!matched) warnings.push(`searchRoot has none of nx.json/angular.json/vite.config.*/.storybook: ${root}`);
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

  if (warnings.length) {
    for (const w of warnings) {
      process.stderr.write(`[appman] warning: ${w}\n`);
    }
  }

  return [...found.values()].filter(a => !a.hidden);
}
