import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AppmanConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ConfigLoadResult {
  config: AppmanConfig;
  path: string;
}

export interface StubCreatedResult {
  stubCreatedAt: string;
}

export type ConfigResult =
  | { kind: 'loaded'; config: AppmanConfig; path: string }
  | { kind: 'stub-created'; path: string };

function defaultConfig(): AppmanConfig {
  return {
    searchRoots: [],
    portRange: [4200, 4299],
    apiPort: 4999,
    overrides: {},
    autoStart: [],
    profiles: {},
    tags: {},
    autoRestart: { enabled: false, maxAttempts: 5, windowMs: 300000 },
    healthProbe: {
      enabled: true,
      intervalMs: 30000,
      timeoutMs: 2000,
      path: '/',
      host: null,
      scheme: null,
      rejectUnauthorized: false,
      fallbackHosts: ['127.0.0.1', '::1'],
    },
    logs: { enabled: false, dir: path.join(os.homedir(), '.daimon', 'logs'), maxFiles: 5, maxBytesPerFile: 10000000 },
    depends: {},
    cascadeRestart: false,
    history: { enabled: true, path: path.join(os.homedir(), '.daimon', 'history.db'), retentionDays: 30 },
    notifications: { enabled: true, onError: true, onUnhealthy: true, tray: false },
    staleDetect: { enabled: true, silentMs: 30000 },
    headless: false,
    envFiles: {},
    requestLog: { enabled: false, portOffset: 1000 },
    metrics: { enabled: false },
    editor: { scheme: 'vscode' },
    apiToken: null,
    output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: ['orphan-daemon', 'stale-lock', 'missing-search-root', 'corrupt-history-db', 'port-conflict-pred', 'node-version-mismatch', 'orphan-node-modules', 'orphan-venv', 'orphan-bundler-cache', 'orphan-cargo-target', 'dead-search-root'] } },
    dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 },
    plugins: { dir: null },
    webhooks: [],
  };
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

// Field-level validation problems from the most recent validate() pass.
// Malformed-config softening (M55): a broken field falls back to its default
// with a warning instead of refusing to start; `daimon doctor` surfaces these.
let lastValidationWarnings: string[] = [];

export function configValidationWarnings(): string[] {
  return [...lastValidationWarnings];
}

export function validateConfig(raw: unknown, source: string): AppmanConfig {
  return validate(raw, source);
}

function validate(raw: unknown, source: string): AppmanConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Config at ${source} is not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const cfg = defaultConfig();
  const warnings: string[] = [];
  lastValidationWarnings = warnings;
  const warn = (msg: string): void => {
    warnings.push(msg);
    process.stderr.write(`[daimon] config warning: ${msg} — using default\n`);
  };

  if (obj.searchRoots !== undefined) {
    if (!Array.isArray(obj.searchRoots) || !obj.searchRoots.every(s => typeof s === 'string' || (s && typeof s === 'object' && typeof (s as any).path === 'string'))) {
      warn(`"searchRoots" must be an array of strings or { path, viteSubfolders? } objects (${source})`);
    } else {
      cfg.searchRoots = obj.searchRoots as any;
    }
  }

  if (obj.portRange !== undefined) {
    if (
      !Array.isArray(obj.portRange) ||
      obj.portRange.length !== 2 ||
      typeof obj.portRange[0] !== 'number' ||
      typeof obj.portRange[1] !== 'number' ||
      obj.portRange[0] > obj.portRange[1]
    ) {
      warn(`"portRange" must be [min, max] numbers (${source})`);
    } else {
      cfg.portRange = [obj.portRange[0] as number, obj.portRange[1] as number];
    }
  }

  if (obj.apiPort !== undefined) {
    if (typeof obj.apiPort !== 'number') {
      warn(`"apiPort" must be a number (${source})`);
    } else {
      cfg.apiPort = obj.apiPort;
    }
  }

  if (obj.overrides !== undefined) {
    if (typeof obj.overrides !== 'object' || obj.overrides === null || Array.isArray(obj.overrides)) {
      warn(`"overrides" must be an object (${source})`);
    } else {
      cfg.overrides = obj.overrides as AppmanConfig['overrides'];
    }
  }

  if (obj.autoStart !== undefined) {
    if (!Array.isArray(obj.autoStart) || !obj.autoStart.every(s => typeof s === 'string')) {
      warn(`"autoStart" must be an array of strings (${source})`);
    } else {
      cfg.autoStart = obj.autoStart as string[];
    }
  }

  if (obj.profiles !== undefined) {
    if (typeof obj.profiles !== 'object' || obj.profiles === null || Array.isArray(obj.profiles)) {
      warn(`"profiles" must be an object (${source})`);
    } else {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(obj.profiles as object)) {
        if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) {
          warn(`"profiles.${k}" must be an array of strings (${source})`);
        } else {
          out[k] = v;
        }
      }
      cfg.profiles = out;
    }
  }

  if (obj.tags !== undefined) {
    if (typeof obj.tags !== 'object' || obj.tags === null || Array.isArray(obj.tags)) {
      warn(`"tags" must be an object (${source})`);
    } else {
      cfg.tags = obj.tags as Record<string, string[]>;
    }
  }

  if (obj.autoRestart && typeof obj.autoRestart === 'object') {
    cfg.autoRestart = { ...cfg.autoRestart, ...(obj.autoRestart as Partial<AppmanConfig['autoRestart']>) };
  }
  if (obj.healthProbe && typeof obj.healthProbe === 'object') {
    cfg.healthProbe = { ...cfg.healthProbe, ...(obj.healthProbe as Partial<AppmanConfig['healthProbe']>) };
  }
  if (obj.logs && typeof obj.logs === 'object') {
    cfg.logs = { ...cfg.logs, ...(obj.logs as Partial<AppmanConfig['logs']>) };
    cfg.logs.dir = expandTilde(cfg.logs.dir);
  }

  if (obj.depends && typeof obj.depends === 'object' && !Array.isArray(obj.depends)) {
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(obj.depends as Record<string, unknown>)) {
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
        warn(`"depends.${k}" must be an array of strings (${source})`);
      } else {
        out[k] = v as string[];
      }
    }
    cfg.depends = out;
  }
  if (typeof obj.cascadeRestart === 'boolean') cfg.cascadeRestart = obj.cascadeRestart;

  if (obj.history && typeof obj.history === 'object') {
    cfg.history = { ...cfg.history, ...(obj.history as Partial<AppmanConfig['history']>) };
    cfg.history.path = expandTilde(cfg.history.path);
  }
  if (obj.notifications && typeof obj.notifications === 'object') {
    cfg.notifications = { ...cfg.notifications, ...(obj.notifications as Partial<AppmanConfig['notifications']>) };
  }
  if (obj.staleDetect && typeof obj.staleDetect === 'object') {
    cfg.staleDetect = { ...cfg.staleDetect, ...(obj.staleDetect as Partial<AppmanConfig['staleDetect']>) };
  }
  if (typeof obj.headless === 'boolean') cfg.headless = obj.headless;
  if (obj.envFiles && typeof obj.envFiles === 'object' && !Array.isArray(obj.envFiles)) {
    cfg.envFiles = obj.envFiles as Record<string, string[]>;
  }
  if (obj.requestLog && typeof obj.requestLog === 'object') {
    cfg.requestLog = { ...cfg.requestLog, ...(obj.requestLog as Partial<AppmanConfig['requestLog']>) };
  }
  if (obj.metrics && typeof obj.metrics === 'object') {
    cfg.metrics = { ...cfg.metrics, ...(obj.metrics as Partial<AppmanConfig['metrics']>) };
  }
  if (obj.editor && typeof obj.editor === 'object') {
    const scheme = (obj.editor as any).scheme;
    if (typeof scheme === 'string' && scheme.trim()) cfg.editor = { scheme: scheme.trim() };
  }
  if (typeof obj.apiToken === 'string' || obj.apiToken === null) {
    cfg.apiToken = obj.apiToken as string | null;
  }
  if (obj.output && typeof obj.output === 'object') {
    const o = obj.output as Partial<AppmanConfig['output']>;
    if (o.format === 'compact' || o.format === 'full') cfg.output.format = o.format;
    if (typeof o.ndjson === 'boolean') cfg.output.ndjson = o.ndjson;
  }
  if (obj.doctor && typeof obj.doctor === 'object') {
    const d = (obj.doctor as any).autoFix;
    if (d && typeof d === 'object') {
      if (typeof d.onInit === 'boolean') cfg.doctor.autoFix.onInit = d.onInit;
      if (Array.isArray(d.permitted)) cfg.doctor.autoFix.permitted = d.permitted.filter((x: unknown) => typeof x === 'string');
    }
  }
  if (obj.dashboard && typeof obj.dashboard === 'object') {
    const d = obj.dashboard as Partial<AppmanConfig['dashboard']>;
    if (d.theme === 'auto' || d.theme === 'light' || d.theme === 'dark') cfg.dashboard.theme = d.theme;
    if (d.density === 'comfortable' || d.density === 'compact') cfg.dashboard.density = d.density;
  }
  if (obj.errorRetention && typeof obj.errorRetention === 'object') {
    const er = obj.errorRetention as Partial<AppmanConfig['errorRetention']>;
    if (typeof er.maxAgeMs === 'number' && er.maxAgeMs > 0) cfg.errorRetention.maxAgeMs = er.maxAgeMs;
  }
  if (obj.plugins && typeof obj.plugins === 'object') {
    const pl = obj.plugins as Partial<AppmanConfig['plugins']>;
    if (typeof pl.dir === 'string' && pl.dir.trim()) cfg.plugins.dir = expandTilde(pl.dir);
    else if (pl.dir === null) cfg.plugins.dir = null;
  }
  if (Array.isArray(obj.webhooks)) {
    const out: AppmanConfig['webhooks'] = [];
    for (const entry of obj.webhooks) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as any;
      if (typeof e.url !== 'string' || !e.url.trim()) continue;
      const w: AppmanConfig['webhooks'][number] = { url: e.url };
      if (Array.isArray(e.events)) w.events = e.events.filter((s: any) => typeof s === 'string');
      if (e.headers && typeof e.headers === 'object') {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.headers)) if (typeof v === 'string') h[k] = v;
        w.headers = h;
      }
      if (e.filter && typeof e.filter === 'object') {
        const f: any = {};
        for (const k of ['to', 'from', 'app']) {
          if (Array.isArray(e.filter[k])) f[k] = e.filter[k].filter((s: any) => typeof s === 'string');
        }
        w.filter = f;
      }
      out.push(w);
    }
    cfg.webhooks = out;
  }

  return cfg;
}

export function configLookupPaths(): { local: string; user: string } {
  return {
    local: path.join(process.cwd(), 'daimon.config.json'),
    user: path.join(os.homedir(), '.daimon', 'config.json'),
  };
}

// Unparseable config refuses to start (M55) — but with the JSON line/column
// rather than V8's bare byte offset.
function parseJsonWithLocation(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err: any) {
    const m = /position (\d+)/.exec(err?.message || '');
    if (m) {
      const pos = Number(m[1]);
      const upTo = text.slice(0, pos);
      const line = upTo.split('\n').length;
      const col = pos - upTo.lastIndexOf('\n');
      throw new Error(`${source}: invalid JSON at line ${line}, column ${col} (${err.message})`);
    }
    throw new Error(`${source}: invalid JSON (${err?.message || err})`);
  }
}

export function loadConfig(): ConfigResult {
  const { local, user } = configLookupPaths();

  if (fs.existsSync(local)) {
    const raw = parseJsonWithLocation(fs.readFileSync(local, 'utf8'), local);
    return { kind: 'loaded', config: validate(raw, local), path: local };
  }
  if (fs.existsSync(user)) {
    const raw = parseJsonWithLocation(fs.readFileSync(user, 'utf8'), user);
    return { kind: 'loaded', config: validate(raw, user), path: user };
  }

  const exampleCandidates = [
    path.resolve(__dirname, '..', 'daimon.config.example.json'),
    path.resolve(__dirname, '..', '..', 'daimon.config.example.json'),
  ];
  const example = exampleCandidates.find(p => fs.existsSync(p));
  fs.mkdirSync(path.dirname(user), { recursive: true });
  if (example) {
    fs.copyFileSync(example, user);
  } else {
    fs.writeFileSync(user, JSON.stringify(defaultConfig(), null, 2) + '\n', 'utf8');
  }
  return { kind: 'stub-created', path: user };
}
