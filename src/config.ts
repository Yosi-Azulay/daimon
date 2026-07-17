import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AppmanConfig } from './types.js';
import { validateCustomProfiles } from './frameworks.js';
import { parsePortPool } from './ports.js';
import { daimonDir } from './daemon.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config-key catalog with stability tiers (M87). Keys are the top-level
// properties of daimon.config.json; this map is the single source of truth for
// which keys exist (build-docs renders it; `daimon config validate` checks
// unknown keys against it). Config back-compat is NEVER breakable regardless
// of tier — a v0.1 config must load unchanged forever; the tier speaks to the
// key's *semantics* staying put. Experimental sub-keys inside stable parents:
// notifications.kinds / notifications.quietHours / notifications.batchMs and
// webhooks[].digest (all M84, v0.13).
export const CONFIG_KEY_STABILITY: Record<string, import('./stability.js').Stability> = {
  searchRoots: 'frozen',
  portRange: 'frozen',
  apiPort: 'frozen',
  overrides: 'frozen',
  autoStart: 'frozen',
  profiles: 'frozen',
  tags: 'frozen',
  depends: 'frozen',
  autoRestart: 'stable',
  healthProbe: 'stable',
  logs: 'stable',
  cascadeRestart: 'stable',
  history: 'stable',
  notifications: 'stable',
  staleDetect: 'stable',
  headless: 'stable',
  envFiles: 'stable',
  requestLog: 'stable',
  metrics: 'stable',
  editor: 'stable',
  apiToken: 'stable',
  output: 'stable',
  doctor: 'stable',
  dashboard: 'stable',
  errorRetention: 'stable',
  plugins: 'stable',
  webhooks: 'stable',
  frameworks: 'stable',
  tests: 'stable',
  restartStorm: 'stable',
  search: 'stable',
  ports: 'experimental', // v0.13 (M81)
  groups: 'experimental', // v1.1 (M93)
};

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
    logs: { enabled: false, dir: path.join(daimonDir(), 'logs'), maxFiles: 5, maxBytesPerFile: 10000000 },
    depends: {},
    cascadeRestart: false,
    history: { enabled: true, path: path.join(daimonDir(), 'history.db'), retentionDays: 30 },
    notifications: { enabled: true, onError: true, onUnhealthy: true, tray: false },
    staleDetect: { enabled: true, silentMs: 30000 },
    headless: false,
    envFiles: {},
    requestLog: { enabled: false, portOffset: 1000 },
    metrics: { enabled: false },
    editor: { scheme: 'vscode' },
    apiToken: null,
    output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: ['orphan-daemon', 'stale-lock', 'missing-search-root', 'corrupt-history-db', 'port-conflict-pred', 'port-holder-no-lock', 'node-version-mismatch', 'orphan-node-modules', 'orphan-venv', 'orphan-bundler-cache', 'orphan-cargo-target', 'dead-search-root'] } },
    dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 },
    plugins: { dir: null },
    webhooks: [],
    frameworks: [],
    tests: { flakyThreshold: 3 },
    restartStorm: { perHour: 20 },
    search: { logIndex: true },
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

// Small edit-distance for unknown-key suggestions (M91). Local on purpose:
// config.ts must stay importable without dragging the CLI help layer in.
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

export function nearestConfigKey(key: string): string | null {
  let best: string | null = null;
  let bestDist = 3; // suggest only within 2 edits
  for (const known of Object.keys(CONFIG_KEY_STABILITY)) {
    const d = editDistance(key.toLowerCase(), known.toLowerCase());
    if (d < bestDist) { bestDist = d; best = known; }
  }
  return best;
}

// Unknown top-level keys (M91): warn with the nearest valid name — never fail,
// old configs stay loadable forever. '$schema' is tolerated silently.
function warnUnknownKeys(obj: Record<string, unknown>, source: string, warn: (msg: string) => void): void {
  for (const key of Object.keys(obj)) {
    if (key === '$schema') continue;
    if (key in CONFIG_KEY_STABILITY) continue;
    const guess = nearestConfigKey(key);
    warn(`unknown config key "${key}"${guess ? ` — did you mean "${guess}"?` : ''} (${source})`);
  }
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

  // Unknown keys warn (with a nearest-name suggestion) but never fail —
  // config back-compat is not breakable (STABILITY.md).
  warnUnknownKeys(obj, source, msg => {
    warnings.push(msg);
    process.stderr.write(`[daimon] config warning: ${msg} — ignored\n`);
  });

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
    const n = obj.notifications as any;
    cfg.notifications = { ...cfg.notifications, ...n };
    // M84 fields are validated individually; a broken one falls back to
    // "absent" (= pre-v0.13 behavior) rather than poisoning the object.
    if (n.kinds !== undefined) {
      if (Array.isArray(n.kinds) && n.kinds.every((k: unknown) => typeof k === 'string')) {
        cfg.notifications.kinds = n.kinds;
      } else {
        delete cfg.notifications.kinds;
        warn(`"notifications.kinds" must be an array of strings (${source})`);
      }
    }
    if (n.quietHours !== undefined && n.quietHours !== null) {
      if (typeof n.quietHours === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(n.quietHours)) {
        cfg.notifications.quietHours = n.quietHours;
      } else {
        delete cfg.notifications.quietHours;
        warn(`"notifications.quietHours" must look like "22:00-08:00" (${source})`);
      }
    }
    if (n.batchMs !== undefined) {
      if (typeof n.batchMs === 'number' && n.batchMs > 0) {
        cfg.notifications.batchMs = Math.floor(n.batchMs);
      } else {
        delete cfg.notifications.batchMs;
        warn(`"notifications.batchMs" must be a positive number (${source})`);
      }
    }
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
      if (Array.isArray(e.apps)) w.apps = e.apps.filter((s: any) => typeof s === 'string');
      if (e.digest !== undefined) {
        if (typeof e.digest === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(e.digest)) {
          w.digest = e.digest;
        } else {
          warn(`"webhooks[].digest" must be "HH:MM" 24h local time (${source})`);
        }
      }
      out.push(w);
    }
    cfg.webhooks = out;
  }

  if (obj.tests !== undefined) {
    const t = obj.tests as any;
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      if (typeof t.flakyThreshold === 'number' && t.flakyThreshold >= 1) {
        cfg.tests = { ...cfg.tests!, flakyThreshold: Math.floor(t.flakyThreshold) };
      } else if (t.flakyThreshold !== undefined) {
        warn(`"tests.flakyThreshold" must be a number >= 1 (${source})`);
      }
    } else {
      warn(`"tests" must be an object (${source})`);
    }
  }

  if (obj.restartStorm !== undefined) {
    const r = obj.restartStorm as any;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      if (typeof r.perHour === 'number' && r.perHour >= 1) {
        cfg.restartStorm = { perHour: Math.floor(r.perHour) };
      } else if (r.perHour !== undefined) {
        warn(`"restartStorm.perHour" must be a number >= 1 (${source})`);
      }
    } else {
      warn(`"restartStorm" must be an object (${source})`);
    }
  }

  if (obj.search !== undefined) {
    const s = obj.search as any;
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      if (typeof s.logIndex === 'boolean') cfg.search = { logIndex: s.logIndex };
      else if (s.logIndex !== undefined) warn(`"search.logIndex" must be a boolean (${source})`);
    } else {
      warn(`"search" must be an object (${source})`);
    }
  }

  if (obj.ports !== undefined) {
    const p = obj.ports as any;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      if (p.pool === undefined || p.pool === null) {
        cfg.ports = {};
      } else if (typeof p.pool === 'string' && parsePortPool(p.pool)) {
        cfg.ports = { pool: p.pool };
      } else {
        warn(`"ports.pool" must be a "min-max" port range like "4200-4299" (${source})`);
      }
    } else {
      warn(`"ports" must be an object (${source})`);
    }
  }

  if (obj.groups !== undefined) {
    // Named app groups (M93). Both forms normalize to { apps, autoStart } here
    // so nothing downstream ever sees the shorthand. A broken entry is skipped
    // with a warning; the rest of the map survives.
    const g = obj.groups as any;
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      warn(`"groups" must be an object mapping name → string[] | { apps, autoStart? } (${source})`);
    } else {
      const out: Record<string, import('./types.js').GroupDef> = {};
      for (const [name, v] of Object.entries(g)) {
        if (Array.isArray(v) && v.every(s => typeof s === 'string')) {
          out[name] = { apps: v as string[], autoStart: false };
        } else if (v && typeof v === 'object' && !Array.isArray(v)
          && Array.isArray((v as any).apps) && (v as any).apps.every((s: unknown) => typeof s === 'string')) {
          const a = (v as any).autoStart;
          if (a !== undefined && typeof a !== 'boolean') {
            warn(`"groups.${name}.autoStart" must be a boolean (${source})`);
            out[name] = { apps: (v as any).apps as string[], autoStart: false };
          } else {
            out[name] = { apps: (v as any).apps as string[], autoStart: a === true };
          }
        } else {
          warn(`"groups.${name}" must be an array of app names or { apps: string[], autoStart?: boolean } (${source})`);
        }
      }
      cfg.groups = out;
    }
  }

  if (obj.frameworks !== undefined) {
    // Custom framework profiles (M65): data-only rows. Invalid entries are
    // skipped with a warning (doctor surfaces them); valid ones survive.
    cfg.frameworks = validateCustomProfiles(obj.frameworks, msg => warn(`${msg} (${source})`));
  }

  return cfg;
}

export function configLookupPaths(): { local: string; user: string } {
  return {
    local: path.join(process.cwd(), 'daimon.config.json'),
    user: path.join(daimonDir(), 'config.json'),
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
