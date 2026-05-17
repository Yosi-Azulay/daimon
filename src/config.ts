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
    healthProbe: { enabled: true, intervalMs: 30000, timeoutMs: 2000, path: '/' },
    logs: { enabled: false, dir: path.join(os.homedir(), '.appman', 'logs'), maxFiles: 5, maxBytesPerFile: 10000000 },
  };
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
    if (cfg.logs.dir.startsWith('~')) {
      cfg.logs.dir = path.join(os.homedir(), cfg.logs.dir.slice(cfg.logs.dir.startsWith('~/') || cfg.logs.dir.startsWith('~\\') ? 2 : 1));
    }
  }

  return cfg;
}

export function configLookupPaths(): { local: string; user: string } {
  return {
    local: path.join(process.cwd(), 'appman.config.json'),
    user: path.join(os.homedir(), '.appman', 'config.json'),
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
    path.resolve(__dirname, '..', 'appman.config.example.json'),
    path.resolve(__dirname, '..', '..', 'appman.config.example.json'),
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
