import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from './config.js';
import type { AppmanConfig } from './types.js';
import type { Registry } from './registry.js';
import { discoverApps } from './discovery.js';

const SPAWN_TIME_FIELDS = new Set(['command', 'port', 'env', 'url']);

function readRawObject(p: string): Record<string, unknown> {
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be a JSON object');
  return parsed as Record<string, unknown>;
}

function deepMerge(target: any, patch: any): any {
  if (patch === null) return null;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete base[k];
    else base[k] = deepMerge(base[k], v);
  }
  return base;
}

function atomicWrite(p: string, contents: string): void {
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, p);
}

function topLevelChangedKeys(prev: any, next: any): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(next)) if (JSON.stringify(prev?.[k]) !== JSON.stringify(next[k])) out.add(k);
  for (const k of Object.keys(prev || {})) if (!(k in next)) out.add(k);
  return [...out];
}

export interface PatchOpts {
  configPath: string;
  patch: any;
}

export function patchConfigOnDisk(opts: PatchOpts): { config: AppmanConfig; raw: any; applied: string[]; prevRaw: any } {
  const prev = readRawObject(opts.configPath);
  const merged = deepMerge(prev, opts.patch);
  if (!merged || typeof merged !== 'object') throw new Error('patch produced non-object config');
  const validated = validateConfig(merged, opts.configPath);
  atomicWrite(opts.configPath, JSON.stringify(merged, null, 2) + '\n');
  return { config: validated, raw: merged, applied: topLevelChangedKeys(prev, merged), prevRaw: prev };
}

export function softReloadFromDisk(opts: { configPath: string; registry: Registry }): { addedApps: string[]; removedApps: string[]; restartRequired: string[]; config: AppmanConfig } {
  const raw = readRawObject(opts.configPath);
  const next = validateConfig(raw, opts.configPath);
  return applyConfigToRegistry(opts.registry, next);
}

export function applyConfigToRegistry(registry: Registry, next: AppmanConfig): { addedApps: string[]; removedApps: string[]; restartRequired: string[]; config: AppmanConfig } {
  const current = registry.getConfig();
  // Delete (not set-to-undefined) so keys absent from the new config really
  // disappear instead of lingering as `key: undefined`.
  for (const k of Object.keys(current)) delete (current as any)[k];
  Object.assign(current, next);

  const prevApps = new Set(registry.names());
  const newApps = discoverApps(current);
  const newNames = new Set(newApps.map(a => a.name));

  const added: string[] = [];
  const removed: string[] = [];

  for (const app of newApps) {
    if (!prevApps.has(app.name)) {
      registry.addDiscoveredApp(app);
      added.push(app.name);
    } else {
      registry.updateDiscoveredApp(app);
    }
  }
  for (const name of prevApps) {
    if (!newNames.has(name)) {
      removed.push(name);
      // Orphaned-app cleanup (M55): kill the child and drop all state for
      // apps that are no longer under any searchRoot.
      void registry.detachApp(name);
    }
  }

  const restartRequired: string[] = [];
  for (const name of registry.names()) {
    const state = registry.getState(name);
    if (state && (state.status === 'serving' || state.status === 'compiling')) {
      const ov = current.overrides?.[name];
      if (!ov) continue;
      for (const f of SPAWN_TIME_FIELDS) if (f in ov) { restartRequired.push(name); break; }
    }
  }

  return { addedApps: added, removedApps: removed, restartRequired, config: current };
}
