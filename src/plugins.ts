import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { daimonDir } from './daemon.js';
import type { AppEvent } from './types.js';

// ---------------------------------------------------------------------------
// Plugin API v1 (M116, v1.5) — the whole contract, deliberately small.
//
// A plugin is one file the user placed in ~/.daimon/plugins themselves. It
// exports { name, apiVersion: 1 } plus any of four optional hooks. Hooks
// OBSERVE (read-only frozen snapshots) or CONTRIBUTE doctor rules — nothing a
// hook returns is consumed except registerDoctorRules(), and no v1 hook can
// mutate app state, config, or history. Tier: experimental (STABILITY.md);
// `apiVersion` is the migration lever if the shape ever changes.
//
// SECURITY: plug-ins are NOT sandboxed. They load via dynamic import() and
// their hooks run in-process with full Node privileges — validation checks the
// export shape, not behaviour. The safety property is opt-in by placement:
// daimon only loads files the user manually dropped into their own
// ~/.daimon/plugins directory. Treat a plug-in as trusted code you chose to
// run, not as a confined extension. (Do not describe this as a "sandbox".)
//
// ISOLATION (M117): the daemon's uptime is never a plugin's problem to lose.
// A throw at load → that file is marked load-error and skipped; a throw (or
// async rejection) in any hook → the plugin is disabled for the session with
// one plugin-error self-event; a restart reloads it fresh. No retry, no
// auto-re-enable.
// ---------------------------------------------------------------------------

export const PLUGIN_API_VERSION = 1;

export type PluginHookName = 'onEvent' | 'onAppStart' | 'onAppStop' | 'registerDoctorRules';
export const PLUGIN_HOOK_NAMES: readonly PluginHookName[] = ['onEvent', 'onAppStart', 'onAppStop', 'registerDoctorRules'];

/** Read-only app snapshot handed to onAppStart/onAppStop (frozen copy). */
export interface PluginAppSnapshot {
  name: string;
  framework: string | null;
  port: number | null;
  pid: number | null;
  status: string;
}

/** Context handed to a plugin doctor rule's check(). Read-only. */
export interface PluginDoctorContext {
  config: unknown;
  apps: { name: string; framework: string | null; workspaceRoot: string | null }[];
}

export interface PluginDoctorFinding {
  ok: boolean;
  detail?: string;
}

/** Advise-only rule contributed via registerDoctorRules(). No auto-fix in v1. */
export interface PluginDoctorRule {
  id: string;
  description: string;
  check(ctx: PluginDoctorContext): PluginDoctorFinding | PluginDoctorFinding[] | Promise<PluginDoctorFinding | PluginDoctorFinding[]>;
}

/** The module shape a v1 plugin file exports (default export or module itself). */
export interface DaimonPlugin {
  name: string;
  apiVersion: 1;
  description?: string;
  onEvent?(evt: Readonly<AppEvent>): unknown;
  onAppStart?(app: PluginAppSnapshot): unknown;
  onAppStop?(app: PluginAppSnapshot): unknown;
  registerDoctorRules?(): PluginDoctorRule[];
}

export type PluginStatus = 'active' | 'disabled' | 'load-error';

export interface LoadedPlugin {
  /** Plugin name, or the file's basename when the failure predates a name. */
  name: string;
  file: string;
  apiVersion: number | null;
  status: PluginStatus;
  hooks: PluginHookName[];
  description?: string;
  /** Present for load-error and disabled states. */
  error?: string;
  module?: DaimonPlugin;
  /** Rules collected once at load from registerDoctorRules(). */
  rules?: PluginDoctorRule[];
  /** Results of the last /api/plugins/scan run of this plugin's rules. */
  lastFindings?: { rule: string; ok: boolean; detail?: string }[];
}

export function pluginsDir(configured?: string): string {
  if (configured && typeof configured === 'string' && configured.trim()) return configured;
  return path.join(daimonDir(), 'plugins');
}

// Only JavaScript files are considered; everything else in the directory is
// ignored silently (READMEs, editor droppings, .disabled renames).
function isPluginFile(name: string): boolean {
  return /\.(mjs|cjs|js)$/i.test(name);
}

function validateShape(mod: any): { ok: true; plugin: DaimonPlugin } | { ok: false; error: string } {
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return { ok: false, error: 'module has no export' };
  const p = (mod.default ?? mod) as DaimonPlugin;
  if (!p || typeof p !== 'object') return { ok: false, error: 'plugin export must be an object — export default { name, apiVersion: 1, ...hooks } (see PLUGINS.md)' };
  if (typeof p.name !== 'string' || !p.name.length) {
    return { ok: false, error: 'missing "name" — a plugin must export { name, apiVersion: 1 } (see PLUGINS.md)' };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(p.name)) return { ok: false, error: `plugin.name must be kebab-case (got "${p.name}")` };
  if (p.apiVersion === undefined) {
    // Pre-v1.5 doctor plug-ins exported { name, scan } — name the migration.
    if (typeof (p as any).scan === 'function') {
      return { ok: false, error: 'legacy doctor plug-in shape (scan()) — Plugin API v1 requires { name, apiVersion: 1 }; wrap scan() findings in registerDoctorRules() (see PLUGINS.md, "Migrating a pre-v1.5 plug-in")' };
    }
    return { ok: false, error: 'missing "apiVersion" — declare apiVersion: 1 (see PLUGINS.md)' };
  }
  if (p.apiVersion !== PLUGIN_API_VERSION) {
    return { ok: false, error: `unsupported apiVersion ${JSON.stringify(p.apiVersion)} — this daimon supports apiVersion ${PLUGIN_API_VERSION}; check the plugin's docs for a compatible release` };
  }
  for (const hook of PLUGIN_HOOK_NAMES) {
    const v = (p as any)[hook];
    if (v !== undefined && typeof v !== 'function') {
      return { ok: false, error: `"${hook}" must be a function when present (got ${typeof v})` };
    }
  }
  if (p.description !== undefined && typeof p.description !== 'string') {
    return { ok: false, error: '"description" must be a string when present' };
  }
  return { ok: true, plugin: p };
}

function declaredHooks(p: DaimonPlugin): PluginHookName[] {
  return PLUGIN_HOOK_NAMES.filter(h => typeof (p as any)[h] === 'function');
}

function validateRules(v: unknown): { ok: true; rules: PluginDoctorRule[] } | { ok: false; error: string } {
  if (!Array.isArray(v)) return { ok: false, error: 'registerDoctorRules() must return an array of { id, description, check } (see PLUGINS.md)' };
  for (const r of v as any[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id.length || typeof r.description !== 'string' || typeof r.check !== 'function') {
      return { ok: false, error: 'registerDoctorRules() returned an invalid rule — each rule needs { id: string, description: string, check: function } (see PLUGINS.md)' };
    }
  }
  return { ok: true, rules: v as PluginDoctorRule[] };
}

/**
 * Enumerate + import + validate every plugin file in `dir`. Never throws:
 * each file loads inside its own try/catch and a bad file becomes a
 * `load-error` row while its siblings load normally. Enumerated once at
 * daemon startup — no watch, no hot reload; changed plugins need
 * `daimon daemon restart`.
 */
export async function loadPlugins(dir: string): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(isPluginFile).sort();
  } catch {
    return out; // no plugins dir = no plugins
  }
  const seenNames = new Set<string>();
  for (const f of entries) {
    const file = path.join(dir, f);
    try {
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
      const v = validateShape(mod);
      if (!v.ok) { out.push({ name: f, file, apiVersion: null, status: 'load-error', hooks: [], error: v.error }); continue; }
      const p = v.plugin;
      if (seenNames.has(p.name)) {
        out.push({ name: p.name, file, apiVersion: p.apiVersion, status: 'load-error', hooks: [], error: `duplicate plugin name "${p.name}" — an earlier file already registered it; rename or remove one of the two` });
        continue;
      }
      // registerDoctorRules() runs once, here, still inside the load phase: a
      // throw or a malformed return is a load failure, not a session-disable.
      let rules: PluginDoctorRule[] = [];
      if (typeof p.registerDoctorRules === 'function') {
        try {
          const rv = validateRules(p.registerDoctorRules());
          if (!rv.ok) { out.push({ name: p.name, file, apiVersion: p.apiVersion, status: 'load-error', hooks: declaredHooks(p), error: rv.error }); continue; }
          rules = rv.rules;
        } catch (err: any) {
          out.push({ name: p.name, file, apiVersion: p.apiVersion, status: 'load-error', hooks: declaredHooks(p), error: `registerDoctorRules() threw: ${err?.message ?? String(err)}` });
          continue;
        }
      }
      seenNames.add(p.name);
      out.push({ name: p.name, file, apiVersion: p.apiVersion, status: 'active', hooks: declaredHooks(p), description: p.description, module: p, rules });
    } catch (err: any) {
      out.push({ name: f, file, apiVersion: null, status: 'load-error', hooks: [], error: err?.message ?? String(err) });
    }
  }
  return out;
}

/** Offline sanity check for one plugin file (`daimon plugin validate <path>`). */
export async function validatePluginFile(file: string): Promise<{ ok: boolean; name?: string; description?: string; hooks?: PluginHookName[]; error?: string }> {
  try {
    const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
    const v = validateShape(mod);
    if (!v.ok) return { ok: false, error: v.error };
    if (typeof v.plugin.registerDoctorRules === 'function') {
      try {
        const rv = validateRules(v.plugin.registerDoctorRules());
        if (!rv.ok) return { ok: false, error: rv.error };
      } catch (err: any) {
        return { ok: false, error: `registerDoctorRules() threw: ${err?.message ?? String(err)}` };
      }
    }
    return { ok: true, name: v.plugin.name, description: v.plugin.description, hooks: declaredHooks(v.plugin) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// Cheap deep-freeze for the flat-ish snapshot objects hooks receive. Hooks get
// a frozen COPY — mutating it throws in strict mode and can never reach
// registry state.
function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

export function freezeEventForPlugins(evt: AppEvent): Readonly<AppEvent> {
  return deepFreeze({ ...evt });
}

export function freezeAppSnapshot(snap: PluginAppSnapshot): Readonly<PluginAppSnapshot> {
  return deepFreeze({ ...snap });
}

export interface PluginHostOptions {
  /** Called once when a hook throw disables a plugin (→ plugin-error event). */
  onPluginError?: (info: { plugin: string; hook: PluginHookName; message: string; stack: string | null }) => void;
}

/** JSON-safe row for /api/plugins and `daimon plugins`. */
export interface PluginInfo {
  name: string;
  file: string;
  apiVersion: number | null;
  status: PluginStatus;
  hooks: PluginHookName[];
  description: string | null;
  error: string | null;
  findings: { rule: string; ok: boolean; detail?: string }[];
}

/**
 * Owns the loaded plugin list and every hook invocation. All dispatch is
 * OFF the event write path: handleRegistryEvent() only schedules a
 * setImmediate when at least one active plugin declares a relevant hook —
 * the synchronous cost on recordEvent's caller is one array check.
 */
export class PluginHost {
  private readonly plugins: LoadedPlugin[];
  private readonly opts: PluginHostOptions;
  private snapshotProvider: ((app: string) => PluginAppSnapshot | null) | null = null;

  constructor(plugins: LoadedPlugin[], opts: PluginHostOptions = {}) {
    this.plugins = plugins;
    this.opts = opts;
  }

  /** Injected by main.ts; returns the live app snapshot at dispatch time. */
  setSnapshotProvider(fn: (app: string) => PluginAppSnapshot | null): void {
    this.snapshotProvider = fn;
  }

  list(): PluginInfo[] {
    return this.plugins.map(p => ({
      name: p.name,
      file: p.file,
      apiVersion: p.apiVersion,
      status: p.status,
      hooks: p.hooks,
      description: p.description ?? null,
      error: p.error ?? null,
      findings: p.lastFindings ?? [],
    }));
  }

  counts(): { total: number; active: number; nonActive: number } {
    const total = this.plugins.length;
    const active = this.plugins.filter(p => p.status === 'active').length;
    return { total, active, nonActive: total - active };
  }

  private activeWith(hook: PluginHookName): LoadedPlugin[] {
    return this.plugins.filter(p => p.status === 'active' && p.hooks.includes(hook));
  }

  hasHookSubscribers(): boolean {
    return this.plugins.some(p => p.status === 'active' && (p.hooks.includes('onEvent') || p.hooks.includes('onAppStart') || p.hooks.includes('onAppStop')));
  }

  /**
   * Session-disable (M117): first throw wins, exactly one plugin-error. All
   * hooks unhook (status check in activeWith) and doctor rules deregister
   * (doctorRules filters on status). A restart reloads the plugin fresh.
   */
  private disable(p: LoadedPlugin, hook: PluginHookName, err: unknown): void {
    if (p.status !== 'active') return;
    const message = (err as any)?.message ?? String(err);
    const stack = typeof (err as any)?.stack === 'string' ? (err as any).stack : null;
    p.status = 'disabled';
    p.error = `${hook} threw: ${message} — plugin disabled for this session; fix the file, then \`daimon daemon restart\` to reload it`;
    try { this.opts.onPluginError?.({ plugin: p.name, hook, message, stack }); } catch { /* never let reporting recurse */ }
  }

  /** Every hook call goes through here: sync throws and async rejections both land in disable(). */
  private invoke(p: LoadedPlugin, hook: PluginHookName, arg: unknown): void {
    const fn = (p.module as any)?.[hook];
    if (typeof fn !== 'function') return;
    try {
      const r = fn.call(p.module, arg);
      if (r && typeof (r as any).then === 'function') {
        Promise.resolve(r).catch(err => this.disable(p, hook, err));
      }
    } catch (err) {
      this.disable(p, hook, err);
    }
  }

  /**
   * Entry point wired to registry's 'event' emitter. Runs AFTER the
   * registry/history write completed (recordEvent emits last). Defers all
   * plugin work to a setImmediate tick — fire-and-forget.
   */
  handleRegistryEvent(evt: AppEvent): void {
    if (!this.hasHookSubscribers()) return;
    setImmediate(() => {
      try {
        const onEvent = this.activeWith('onEvent');
        if (onEvent.length) {
          const frozen = freezeEventForPlugins(evt);
          for (const p of onEvent) this.invoke(p, 'onEvent', frozen);
        }
        // App lifecycle hooks derive from status transitions: a fresh process
        // enters 'starting'; a process that went away enters 'stopped'.
        if (evt.type === 'status' && evt.app !== '__daemon__' && (evt.to === 'starting' || evt.to === 'stopped')) {
          const hook: PluginHookName = evt.to === 'starting' ? 'onAppStart' : 'onAppStop';
          const targets = this.activeWith(hook);
          if (targets.length) {
            const snap = this.snapshotProvider?.(evt.app) ?? { name: evt.app, framework: null, port: null, pid: null, status: evt.to };
            const frozenSnap = freezeAppSnapshot(snap);
            for (const p of targets) this.invoke(p, hook, frozenSnap);
          }
        }
      } catch { /* dispatch machinery itself must never throw upward */ }
    });
  }

  /** Active plugin-contributed doctor rules (advise-only). */
  doctorRules(): { plugin: LoadedPlugin; rule: PluginDoctorRule }[] {
    const out: { plugin: LoadedPlugin; rule: PluginDoctorRule }[] = [];
    for (const p of this.plugins) {
      if (p.status !== 'active' || !p.rules) continue;
      for (const rule of p.rules) out.push({ plugin: p, rule });
    }
    return out;
  }

  /**
   * Run every active plugin's doctor rules against ctx (POST /api/plugins/scan).
   * A throwing check disables its plugin (session semantics, same as any hook)
   * and is reported as a failed finding; other plugins are unaffected.
   */
  async runDoctorRules(ctx: PluginDoctorContext): Promise<void> {
    const frozenCtx = deepFreeze({ config: ctx.config, apps: ctx.apps.map(a => ({ ...a })) });
    for (const p of this.plugins) {
      if (p.status !== 'active' || !p.rules?.length) continue;
      const findings: { rule: string; ok: boolean; detail?: string }[] = [];
      for (const rule of p.rules) {
        try {
          const r = await rule.check(frozenCtx);
          const arr = Array.isArray(r) ? r : [r];
          for (const f of arr) {
            if (f && typeof f === 'object' && typeof f.ok === 'boolean') findings.push({ rule: rule.id, ok: f.ok, detail: f.detail });
          }
        } catch (err) {
          this.disable(p, 'registerDoctorRules', err);
          findings.push({ rule: rule.id, ok: false, detail: `check threw: ${(err as any)?.message ?? String(err)}` });
          break;
        }
      }
      p.lastFindings = findings;
    }
  }
}
