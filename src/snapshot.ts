import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Registry } from './registry.js';

const SECRET_RX = /key|secret|token|password|api[-_]?key/i;

function redactEnv(env: Record<string, string | undefined> | NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    out[k] = SECRET_RX.test(k) ? '***' : v;
  }
  return out;
}

export interface SnapshotPayload {
  takenAt: string;
  summary: any;
  logs: { ts: number; line: string }[];
  errors: { hash: string; message: string; count: number; firstSeen: number; lastSeen: number }[];
  env: Record<string, string>;
  configSlice: any;
  events: any[];
  bundles?: any[];
}

export function buildSnapshot(registry: Registry, name: string): SnapshotPayload | null {
  const summary = registry.summary(name);
  if (!summary) return null;
  const state = registry.getState(name)!;
  const app = registry.getApp(name)!;
  const cfg = registry.getConfig();
  const overrides = cfg.overrides?.[name] ?? {};
  const baseEnv: Record<string, string | undefined> = { ...process.env, ...(app.env ?? {}), ...(state.sessionOverrides?.env ?? {}) };
  const history = registry.getHistory();
  const events = history ? history.queryEvents({ app: name, limit: 50 }) : [];
  const bundles = history ? history.queryBundles({ app: name, limit: 100 }) : [];
  return {
    takenAt: new Date().toISOString(),
    summary,
    logs: state.logBuffer.slice(-500).map(e => ({ ts: e.ts, line: e.line })),
    errors: [...state.errors.entries()].map(([hash, e]) => ({ hash, message: e.message, count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen })),
    env: redactEnv(baseEnv),
    configSlice: {
      command: state.sessionOverrides?.command ?? overrides.command ?? app.command,
      port: state.sessionOverrides?.port ?? overrides.port ?? null,
      workspaceRoot: app.workspaceRoot,
      workspaceType: app.workspaceType,
      tags: app.tags,
      depends: cfg.depends?.[name] ?? [],
      envFiles: cfg.envFiles?.[name] ?? [],
    },
    events,
    bundles,
  };
}

export function writeSnapshot(registry: Registry, name: string): { path: string; payload: SnapshotPayload } | null {
  const payload = buildSnapshot(registry, name);
  if (!payload) return null;
  const dir = path.join(os.homedir(), '.daimon', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const ts = payload.takenAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `${name}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return { path: file, payload };
}
