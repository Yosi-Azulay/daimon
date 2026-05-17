import fs from 'node:fs';
import path from 'node:path';
import type { Registry } from './registry.js';
import type { StaleDetectConfig } from './types.js';

const CHECK_MS = 5_000;
const GLOB_REFRESH_MS = 30_000;
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.angular', '.nx', '.git', 'tmp', 'out-tsc', 'coverage']);
const TRACKED_EXT = new Set(['.ts', '.tsx', '.html', '.scss', '.css', '.js', '.jsx', '.json']);

interface Cache {
  ts: number;
  files: { path: string; mtime: number }[];
}

export class StaleDetector {
  private timer: NodeJS.Timeout | null = null;
  private caches = new Map<string, Cache>();

  constructor(private readonly registry: Registry, private readonly cfg: StaleDetectConfig) {
    if (!cfg.enabled) return;
    this.timer = setInterval(() => this.tick(), CHECK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private tick(): void {
    for (const name of this.registry.names()) this.evaluate(name);
  }

  private evaluate(name: string): void {
    const s = this.registry.getState(name);
    const app = this.registry.getApp(name);
    if (!s || !app) return;
    if (s.status !== 'serving') {
      if (s.stale) this.registry.setStale(name, false);
      return;
    }
    if (s.startedAt == null) return;
    const lastLog = s.lastLogTs ?? s.startedAt;
    const silentFor = Date.now() - lastLog;
    if (silentFor < this.cfg.silentMs) {
      if (s.stale) this.registry.setStale(name, false);
      return;
    }
    const referenceTs = s.lastCompileAt ?? s.startedAt;
    if (this.hasSourceChange(app.workspaceRoot, referenceTs)) {
      if (!s.stale) {
        this.registry.setStale(name, true);
        this.registry.recordEvent({ app: name, type: 'stale', message: `no output in ${Math.round(silentFor / 1000)}s despite source changes` });
      }
    }
  }

  private hasSourceChange(root: string, sinceTs: number): boolean {
    const cached = this.caches.get(root);
    if (!cached || Date.now() - cached.ts > GLOB_REFRESH_MS) {
      const files = this.scan(root);
      this.caches.set(root, { ts: Date.now(), files });
    }
    const fresh = this.caches.get(root)!;
    return fresh.files.some(f => f.mtime > sinceTs);
  }

  private scan(root: string): { path: string; mtime: number }[] {
    const out: { path: string; mtime: number }[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || out.length > 4000) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.git')) continue;
        if (ent.isDirectory()) {
          if (IGNORE_DIRS.has(ent.name)) continue;
          walk(path.join(dir, ent.name), depth + 1);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name);
          if (!TRACKED_EXT.has(ext)) continue;
          try {
            const full = path.join(dir, ent.name);
            const st = fs.statSync(full);
            out.push({ path: full, mtime: st.mtimeMs });
          } catch {}
        }
      }
    };
    walk(root, 0);
    return out;
  }
}
