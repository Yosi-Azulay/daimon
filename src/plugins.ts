import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export interface DoctorFinding {
  pluginName: string;
  id: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
  detail?: unknown;
}

export interface DoctorFixResult {
  ok: boolean;
  description: string;
  undoToken?: string;
}

export interface DoctorContext {
  config: unknown;
  apps: { name: string; workspaceRoot: string }[];
  history: { querySelfMetrics: (opts: { since?: number; limit?: number }) => unknown[] } | null;
  mutations: {
    setOverride: (app: string, key: string, value: unknown) => void;
  };
}

export interface DoctorPlugin {
  name: string;
  description?: string;
  requires?: ('config' | 'history' | 'apps')[];
  scan(ctx: DoctorContext): Promise<DoctorFinding[]>;
  fix?(finding: DoctorFinding, ctx: DoctorContext): Promise<DoctorFixResult>;
  undo?(finding: DoctorFinding, ctx: DoctorContext): Promise<string>;
}

export interface LoadedPlugin {
  name: string;
  description?: string;
  file: string;
  status: 'ok' | 'failed';
  error?: string;
  module?: DoctorPlugin;
  lastFindings?: DoctorFinding[];
}

export function pluginsDir(configured?: string): string {
  if (configured && typeof configured === 'string' && configured.trim()) return configured;
  return path.join(os.homedir(), '.daimon', 'plugins');
}

function isPluginFile(name: string): boolean {
  return name.startsWith('doctor-') && name.endsWith('.mjs');
}

function validateShape(mod: any): { ok: true; plugin: DoctorPlugin } | { ok: false; error: string } {
  if (!mod || typeof mod !== 'object') return { ok: false, error: 'module has no default export' };
  const p = (mod.default ?? mod) as DoctorPlugin;
  if (!p) return { ok: false, error: 'plugin shape is null' };
  if (typeof p.name !== 'string' || !p.name.length) return { ok: false, error: 'plugin.name must be a non-empty string' };
  if (!/^[a-z][a-z0-9-]*$/.test(p.name)) return { ok: false, error: `plugin.name must be kebab-case (got "${p.name}")` };
  if (typeof p.scan !== 'function') return { ok: false, error: 'plugin.scan must be a function' };
  if (p.fix !== undefined && typeof p.fix !== 'function') return { ok: false, error: 'plugin.fix, if present, must be a function' };
  if (p.undo !== undefined && typeof p.undo !== 'function') return { ok: false, error: 'plugin.undo, if present, must be a function' };
  return { ok: true, plugin: p };
}

const BUILT_IN_NAMES = new Set([
  'orphan-daemon', 'stale-lock', 'missing-search-root', 'corrupt-history-db',
  'port-conflict-pred', 'node-version-mismatch', 'orphan-node-modules',
  'orphan-venv', 'orphan-bundler-cache', 'orphan-cargo-target', 'dead-search-root',
]);

export async function loadPlugins(dir: string): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(isPluginFile).sort();
  } catch {
    return out;
  }
  const seenNames = new Set<string>();
  for (const f of entries) {
    const file = path.join(dir, f);
    try {
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
      const v = validateShape(mod);
      if (!v.ok) { out.push({ name: f, file, status: 'failed', error: v.error }); continue; }
      const p = v.plugin;
      if (BUILT_IN_NAMES.has(p.name)) {
        out.push({ name: p.name, file, status: 'failed', error: `name collides with built-in rule "${p.name}"` });
        continue;
      }
      if (seenNames.has(p.name)) {
        out.push({ name: p.name, file, status: 'failed', error: 'duplicate plug-in name' });
        continue;
      }
      seenNames.add(p.name);
      out.push({ name: p.name, description: p.description, file, status: 'ok', module: p });
    } catch (err: any) {
      out.push({ name: f, file, status: 'failed', error: err?.message ?? String(err) });
    }
  }
  return out;
}

export async function validatePluginFile(file: string): Promise<{ ok: boolean; name?: string; description?: string; error?: string }> {
  try {
    const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
    const v = validateShape(mod);
    if (!v.ok) return { ok: false, error: v.error };
    if (BUILT_IN_NAMES.has(v.plugin.name)) return { ok: false, error: `name collides with built-in rule "${v.plugin.name}"` };
    return { ok: true, name: v.plugin.name, description: v.plugin.description };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function runPluginScans(plugins: LoadedPlugin[], ctx: DoctorContext): Promise<LoadedPlugin[]> {
  for (const p of plugins) {
    if (p.status !== 'ok' || !p.module) continue;
    try {
      p.lastFindings = await p.module.scan(ctx);
      if (!Array.isArray(p.lastFindings)) p.lastFindings = [];
    } catch (err: any) {
      p.status = 'failed';
      p.error = `scan failed: ${err?.message ?? String(err)}`;
      p.lastFindings = [];
    }
  }
  return plugins;
}

export function buildContext(opts: { config: unknown; apps: { name: string; workspaceRoot: string }[]; history: any | null }): DoctorContext {
  return {
    config: opts.config,
    apps: opts.apps,
    history: opts.history && typeof opts.history.querySelfMetrics === 'function'
      ? { querySelfMetrics: opts.history.querySelfMetrics.bind(opts.history) }
      : null,
    mutations: {
      // The M36 mutation primitives mutate ~/.daimon/* and daimon.config.json only — never
      // user source. Plug-in `fix` functions get the same surface and no escape hatch.
      setOverride: () => {
        throw new Error('mutations.setOverride is not implemented in v0.8 — fix functions are advisory until M44 wires the M36 patch surface');
      },
    },
  };
}
