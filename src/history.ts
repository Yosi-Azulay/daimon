import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import type { AppEvent, HistoryConfig } from './types.js';

const requireCjs = createRequire(import.meta.url);

interface EventRow {
  id: number;
  ts: number;
  app: string;
  type: string;
  from_state: string | null;
  to_state: string | null;
  message: string | null;
}

interface CompileRow { id: number; ts: number; app: string; ms: number; }

export interface BundleRow {
  id: number;
  ts: number;
  app: string;
  initialKB: number;
  lazyKB: number;
  fileCount: number;
}

export interface TaskRunRow {
  id: number;
  ts: number;
  app: string;
  task: string;
  exit_code: number | null;
  duration_ms: number | null;
  summary: string | null;
}

const FLUSH_INTERVAL_MS = 200;
const RETENTION_PASS_MS = 6 * 60 * 60 * 1000;
const RETENTION_DEBOUNCE_MS = 10_000;

type Op =
  | { kind: 'event'; row: { ts: number; app: string; type: string; from_state: string | null; to_state: string | null; message: string | null } }
  | { kind: 'compile'; row: { ts: number; app: string; ms: number } }
  | { kind: 'bundle'; row: { ts: number; app: string; initialKB: number; lazyKB: number; fileCount: number } }
  | { kind: 'task'; row: { ts: number; app: string; task: string; exit_code: number | null; duration_ms: number | null; summary: string | null } };

export class History {
  private db: Database.Database | null = null;
  private queue: Op[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private retentionStart: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(private readonly cfg: HistoryConfig) {
    if (!cfg.enabled) return;
    try {
      fs.mkdirSync(path.dirname(cfg.path), { recursive: true });
      const Better = requireCjs('better-sqlite3');
      this.db = new Better(cfg.path);
      this.db!.pragma('journal_mode = WAL');
      this.migrate();
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      this.retentionStart = setTimeout(() => this.runRetention(), RETENTION_DEBOUNCE_MS);
      this.retentionTimer = setInterval(() => this.runRetention(), RETENTION_PASS_MS);
    } catch (err: any) {
      this.warnOnce(`failed to open history db: ${err?.message || err}`);
      this.db = null;
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[daimon] history: ${msg}\n`);
  }

  private migrate(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        message TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts_app ON events(ts, app);
      CREATE TABLE IF NOT EXISTS compile_times (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS compile_app_ts ON compile_times(app, ts);
      CREATE TABLE IF NOT EXISTS task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        task TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms INTEGER,
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS task_runs_app_ts ON task_runs(app, ts);
      CREATE TABLE IF NOT EXISTS bundles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        initialKB INTEGER NOT NULL,
        lazyKB INTEGER NOT NULL,
        fileCount INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bundles_app_ts ON bundles(app, ts);
    `);
  }

  recordEvent(ev: AppEvent): void {
    if (!this.db) return;
    this.queue.push({
      kind: 'event',
      row: {
        ts: ev.ts,
        app: ev.app,
        type: ev.type,
        from_state: ev.from ?? null,
        to_state: ev.to ?? null,
        message: ev.message ?? null,
      },
    });
  }

  recordCompile(app: string, ms: number, ts = Date.now()): void {
    if (!this.db) return;
    this.queue.push({ kind: 'compile', row: { ts, app, ms } });
  }

  recordBundle(app: string, initialKB: number, lazyKB: number, fileCount: number, ts = Date.now()): void {
    if (!this.db) return;
    this.queue.push({ kind: 'bundle', row: { ts, app, initialKB, lazyKB, fileCount } });
  }

  recordTaskRun(app: string, task: string, exitCode: number | null, durationMs: number | null, summary: unknown | null, ts = Date.now()): void {
    if (!this.db) return;
    this.queue.push({
      kind: 'task',
      row: { ts, app, task, exit_code: exitCode, duration_ms: durationMs, summary: summary == null ? null : JSON.stringify(summary) },
    });
  }

  private flush(): void {
    if (!this.db || this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      const insEv = this.db.prepare('INSERT INTO events (ts,app,type,from_state,to_state,message) VALUES (?,?,?,?,?,?)');
      const insCm = this.db.prepare('INSERT INTO compile_times (ts,app,ms) VALUES (?,?,?)');
      const insTk = this.db.prepare('INSERT INTO task_runs (ts,app,task,exit_code,duration_ms,summary) VALUES (?,?,?,?,?,?)');
      const insBd = this.db.prepare('INSERT INTO bundles (ts,app,initialKB,lazyKB,fileCount) VALUES (?,?,?,?,?)');
      const tx = this.db.transaction((ops: Op[]) => {
        for (const op of ops) {
          if (op.kind === 'event') insEv.run(op.row.ts, op.row.app, op.row.type, op.row.from_state, op.row.to_state, op.row.message);
          else if (op.kind === 'compile') insCm.run(op.row.ts, op.row.app, op.row.ms);
          else if (op.kind === 'bundle') insBd.run(op.row.ts, op.row.app, op.row.initialKB, op.row.lazyKB, op.row.fileCount);
          else insTk.run(op.row.ts, op.row.app, op.row.task, op.row.exit_code, op.row.duration_ms, op.row.summary);
        }
      });
      tx(batch);
    } catch (err: any) {
      this.warnOnce(`history write failed: ${err?.message || err}`);
    }
  }

  private runRetention(): void {
    if (!this.db) return;
    try {
      const cutoff = Date.now() - this.cfg.retentionDays * 86400000;
      this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM compile_times WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM task_runs WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM bundles WHERE ts < ?').run(cutoff);
    } catch (err: any) {
      this.warnOnce(`retention failed: ${err?.message || err}`);
    }
  }

  queryEvents(opts: { app?: string; since?: number; until?: number; type?: string; limit?: number }): EventRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    if (opts.until != null) { wh.push('ts <= ?'); args.push(opts.until); }
    if (opts.type) { wh.push('type = ?'); args.push(opts.type); }
    const sql = `SELECT * FROM events ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 500);
    return this.db.prepare(sql).all(...args) as EventRow[];
  }

  queryCompiles(opts: { app?: string; since?: number; until?: number; limit?: number }): CompileRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    if (opts.until != null) { wh.push('ts <= ?'); args.push(opts.until); }
    const sql = `SELECT * FROM compile_times ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 1000);
    return this.db.prepare(sql).all(...args) as CompileRow[];
  }

  queryBundles(opts: { app?: string; since?: number; until?: number; limit?: number }): BundleRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    if (opts.until != null) { wh.push('ts <= ?'); args.push(opts.until); }
    const sql = `SELECT * FROM bundles ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 1000);
    return this.db.prepare(sql).all(...args) as BundleRow[];
  }

  trends(opts: { app?: string; metric: 'compile' | 'bundle' | 'errors' | 'restarts'; sinceMs: number; bucketMs: number }): { points: { t: number; v: number; v2?: number }[]; count: number } {
    if (!this.db) return { points: [], count: 0 };
    const sinceTs = Date.now() - opts.sinceMs;
    const bucket = opts.bucketMs;
    const buckets = new Map<number, { sum: number; n: number; sum2?: number }>();
    const bumpAvg = (t: number, v: number) => {
      const b = Math.floor(t / bucket) * bucket;
      const cur = buckets.get(b) ?? { sum: 0, n: 0 };
      cur.sum += v; cur.n += 1;
      buckets.set(b, cur);
    };
    const bumpCount = (t: number) => {
      const b = Math.floor(t / bucket) * bucket;
      const cur = buckets.get(b) ?? { sum: 0, n: 0 };
      cur.sum += 1; cur.n += 1;
      buckets.set(b, cur);
    };
    let count = 0;
    if (opts.metric === 'compile') {
      const rows = this.queryCompiles({ app: opts.app, since: sinceTs, limit: 10000 });
      count = rows.length;
      for (const r of rows) bumpAvg(r.ts, r.ms);
    } else if (opts.metric === 'bundle') {
      const rows = this.queryBundles({ app: opts.app, since: sinceTs, limit: 10000 });
      count = rows.length;
      for (const r of rows) {
        const b = Math.floor(r.ts / bucket) * bucket;
        const cur = buckets.get(b) ?? { sum: 0, n: 0, sum2: 0 };
        cur.sum += r.initialKB;
        cur.sum2 = (cur.sum2 ?? 0) + r.lazyKB;
        cur.n += 1;
        buckets.set(b, cur);
      }
    } else if (opts.metric === 'errors') {
      const rows = this.queryEvents({ app: opts.app, since: sinceTs, limit: 10000 });
      for (const r of rows) {
        if (r.type === 'error-new' || r.type === 'error-recur') { bumpCount(r.ts); count++; }
      }
    } else {
      const rows = this.queryEvents({ app: opts.app, since: sinceTs, limit: 10000 });
      for (const r of rows) {
        if (r.type === 'status' && r.to_state === 'starting' && (r.from_state === 'error' || r.from_state === 'serving' || r.from_state === 'compiling')) {
          bumpCount(r.ts); count++;
        }
      }
    }
    const points: { t: number; v: number; v2?: number }[] = [];
    const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    for (const [t, v] of sorted) {
      if (opts.metric === 'compile' || opts.metric === 'bundle') {
        points.push({ t, v: Math.round(v.sum / v.n), ...(v.sum2 != null ? { v2: Math.round(v.sum2 / v.n) } : {}) });
      } else {
        points.push({ t, v: v.sum });
      }
    }
    return { points, count };
  }

  queryTasks(opts: { app?: string; task?: string; since?: number; limit?: number }): TaskRunRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.task) { wh.push('task = ?'); args.push(opts.task); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    const sql = `SELECT * FROM task_runs ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    return this.db.prepare(sql).all(...args) as TaskRunRow[];
  }

  summary(name: string): { uptimePct24h: number; restartCount24h: number; compileP50: number | null; compileP95: number | null; topErrors: { message: string; count: number }[] } {
    if (!this.db) return { uptimePct24h: 0, restartCount24h: 0, compileP50: null, compileP95: null, topErrors: [] };
    const since = Date.now() - 24 * 3600 * 1000;
    const events = this.queryEvents({ app: name, since, limit: 5000 });

    let serving = 0;
    let cursor = since;
    let currentlyServing = false;
    let lastServeStart: number | null = null;
    const ordered = [...events].sort((a, b) => a.ts - b.ts);
    for (const ev of ordered) {
      if (ev.type !== 'status') continue;
      if (ev.to_state === 'serving' && !currentlyServing) {
        currentlyServing = true;
        lastServeStart = ev.ts;
      } else if (currentlyServing && ev.to_state !== 'serving' && lastServeStart != null) {
        serving += ev.ts - lastServeStart;
        currentlyServing = false;
        lastServeStart = null;
      }
    }
    if (currentlyServing && lastServeStart != null) serving += Date.now() - lastServeStart;
    void cursor;
    const uptimePct24h = Math.round((serving / (24 * 3600 * 1000)) * 1000) / 10;

    const restartCount24h = events.filter(e => e.type === 'status' && e.to_state === 'starting' && (e.from_state === 'serving' || e.from_state === 'error' || e.from_state === 'compiling')).length;

    const compiles = this.queryCompiles({ app: name, since, limit: 1000 }).map(c => c.ms).sort((a, b) => a - b);
    const pct = (arr: number[], p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(arr.length - 1, Math.floor((arr.length - 1) * p));
      return arr[idx];
    };
    const compileP50 = pct(compiles, 0.5);
    const compileP95 = pct(compiles, 0.95);

    const errCounts = new Map<string, number>();
    for (const ev of events) {
      if (ev.type === 'error-new' || ev.type === 'error-recur') {
        const m = ev.message ?? '';
        if (!m) continue;
        errCounts.set(m, (errCounts.get(m) ?? 0) + 1);
      }
    }
    const topErrors = [...errCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([message, count]) => ({ message, count }));

    return { uptimePct24h, restartCount24h, compileP50, compileP95, topErrors };
  }

  why(name: string): { trigger: AppEvent | null; preceding: AppEvent[] } {
    const evs = this.queryEvents({ app: name, limit: 200 });
    const lastStatus = evs.find(e => e.type === 'status' && (e.to_state === 'error' || e.from_state === 'error' || e.to_state === 'serving'));
    const trigger = lastStatus
      ? { ts: lastStatus.ts, app: lastStatus.app, type: lastStatus.type as any, from: lastStatus.from_state ?? undefined, to: lastStatus.to_state ?? undefined, message: lastStatus.message ?? undefined }
      : null;
    const cutoff = trigger ? trigger.ts : Date.now();
    const before = evs.filter(e => e.ts < cutoff).slice(0, 5);
    return {
      trigger,
      preceding: before.map(e => ({ ts: e.ts, app: e.app, type: e.type as any, from: e.from_state ?? undefined, to: e.to_state ?? undefined, message: e.message ?? undefined })),
    };
  }

  quickCheck(): boolean {
    if (!this.db) return false;
    try {
      const r = this.db.prepare('PRAGMA quick_check').get() as any;
      return r?.quick_check === 'ok';
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.retentionStart) clearTimeout(this.retentionStart);
    this.flush();
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}
