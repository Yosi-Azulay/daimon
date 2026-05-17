import fs from 'node:fs';
import path from 'node:path';
import type { Registry } from './registry.js';

const STANDARD_DIRS = ['dist', '.angular/cache', 'tmp', 'out-tsc'];
const DEEP_DIRS = ['node_modules'];

export interface CleanPlan {
  app: string;
  workspace: string;
  targets: { path: string; exists: boolean; sizeBytes?: number }[];
  ranOnServing: boolean;
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) total += dirSize(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch {}
    }
  } catch {}
  return total;
}

export function planClean(registry: Registry, name: string, deep: boolean): CleanPlan | null {
  const app = registry.getApp(name);
  if (!app) return null;
  const state = registry.getState(name);
  const ranOnServing = state ? (state.status === 'serving' || state.status === 'compiling' || state.status === 'starting') : false;
  const list = [...STANDARD_DIRS, ...(deep ? DEEP_DIRS : [])];
  const targets = list.map(rel => {
    const full = path.join(app.workspaceRoot, rel);
    const exists = fs.existsSync(full);
    return { path: full, exists, sizeBytes: exists ? dirSize(full) : 0 };
  });
  return { app: name, workspace: app.workspaceRoot, targets, ranOnServing };
}

export function executeClean(registry: Registry, name: string, deep: boolean): { ok: boolean; removed: string[]; failed: { path: string; error: string }[] } | { error: string } {
  const plan = planClean(registry, name, deep);
  if (!plan) return { error: 'unknown app' };
  if (plan.ranOnServing) return { error: 'app is currently running; stop it first' };
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const t of plan.targets) {
    if (!t.exists) continue;
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
      removed.push(t.path);
    } catch (err: any) {
      failed.push({ path: t.path, error: err?.message || String(err) });
    }
  }
  return { ok: failed.length === 0, removed, failed };
}
