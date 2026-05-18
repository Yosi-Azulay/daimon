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
  };
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
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

  if (obj.searchRoots !== undefined) {
    if (!Array.isArray(obj.searchRoots) || !obj.searchRoots.every(s => typeof s === 'string' || (s && typeof s === 'object' && typeof (s as any).path === 'string'))) {
      throw new Error(`Config "searchRoots" must be an array of strings or { path, viteSubfolders? } objects (${source})`);
    }
    cfg.searchRoots = obj.searchRoots as any;
  }

  if (obj.portRange !== undefined) {
    if (
      !Array.isArray(obj.portRange) ||
      obj.portRange.length !== 2 ||
      typeof obj.portRange[0] !== 'number' ||
      typeof obj.portRange[1] !== 'number' ||
      obj.portRange[0] > obj.portRange[1]
    ) {
      throw new Error(`Config "portRange" must be [min, max] numbers (${source})`);
    }
    cfg.portRange = [obj.portRange[0] as number, obj.portRange[1] as number];
  }

  if (obj.apiPort !== undefined) {
    if (typeof obj.apiPort !== 'number') {
      throw new Error(`Config "apiPort" must be a number (${source})`);
    }
    cfg.apiPort = obj.apiPort;
  }

  if (obj.overrides !== undefined) {
    if (typeof obj.overrides !== 'object' || obj.overrides === null || Array.isArray(obj.overrides)) {
      throw new Error(`Config "overrides" must be an object (${source})`);
    }
    cfg.overrides = obj.overrides as AppmanConfig['overrides'];
  }

  if (obj.autoStart !== undefined) {
    if (!Array.isArray(obj.autoStart) || !obj.autoStart.every(s => typeof s === 'string')) {
      throw new Error(`Config "autoStart" must be an array of strings (${source})`);
    }
    cfg.autoStart = obj.autoStart as string[];
  }

  if (obj.profiles !== undefined) {
    if (typeof obj.profiles !== 'object' || obj.profiles === null || Array.isArray(obj.profiles)) {
      throw new Error(`Config "profiles" must be an object (${source})`);
    }
    for (const [k, v] of Object.entries(obj.profiles as object)) {
      if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) {
        throw new Error(`Config "profiles.${k}" must be an array of strings (${source})`);
      }
    }
    cfg.profiles = obj.profiles as Record<string, string[]>;
  }

  if (obj.tags !== undefined) {
    if (typeof obj.tags !== 'object' || obj.tags === null || Array.isArray(obj.tags)) {
      throw new Error(`Config "tags" must be an object (${source})`);
    }
    cfg.tags = obj.tags as Record<string, string[]>;
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
    for (const [k, v] of Object.entries(obj.depends as Record<string, unknown>)) {
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
        throw new Error(`Config "depends.${k}" must be an array of strings (${source})`);
      }
    }
    cfg.depends = obj.depends as Record<string, string[]>;
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

  return cfg;
}

export function configLookupPaths(): { local: string; user: string } {
  return {
    local: path.join(process.cwd(), 'daimon.config.json'),
    user: path.join(os.homedir(), '.daimon', 'config.json'),
  };
}

export function loadConfig(): ConfigResult {
  const { local, user } = configLookupPaths();

  if (fs.existsSync(local)) {
    const raw = JSON.parse(fs.readFileSync(local, 'utf8'));
    return { kind: 'loaded', config: validate(raw, local), path: local };
  }
  if (fs.existsSync(user)) {
    const raw = JSON.parse(fs.readFileSync(user, 'utf8'));
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
