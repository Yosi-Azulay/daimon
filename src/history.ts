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

export interface CrashRow {
  id: number;
  ts: number;
  app: string;
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number | null;
  lastLines: string | null; // '\n'-joined tail of the log ring buffer
  gitHead: string | null;
}

export interface TestRunRow {
  id: number;
  ts: number;
  app: string;
  runner: string | null;
  durationMs: number | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  exitCode: number | null;
  gitHead: string | null;
}

export interface TestFailureRow {
  runId: number;
  suite: string | null;
  test: string | null;
  file: string | null;
  line: number | null;
  message: string | null;
  fingerprint: string | null;
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
  | { kind: 'task'; row: { ts: number; app: string; task: string; exit_code: number | null; duration_ms: number | null; summary: string | null } }
  | { kind: 'log'; row: { ts: number; app: string; line: string } };

export interface SearchHit {
  kind: 'logs' | 'errors' | 'events';
  app: string;
  ts: number;
  snippet: string;
  // Stable pointer back into history: "event:<id>" or "log:<id>".
  ref: string;
}

// Event types the 'errors' search kind covers (everything issue-shaped).
const ERROR_EVENT_TYPES = ['error-new', 'error-recur', 'warning-new', 'warning-recur', 'lint-new', 'lint-recur', 'crash'];

// FTS5 MATCH has its own query syntax — quote every user token so `foo-bar`,
// `a"b` or `NEAR` can't inject operators. A trailing `*` keeps prefix search.
export function ftsQuery(q: string): string {
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
  return terms.map(t => {
    const prefix = t.length > 1 && t.endsWith('*');
    const body = (prefix ? t.slice(0, -1) : t).replace(/"/g, '""');
    return `"${body}"${prefix ? '*' : ''}`;
  }).join(' ');
}

function likePattern(q: string): string {
  return '%' + q.replace(/([%_\\])/g, '\\$1') + '%';
}

// JS-side snippet for the LIKE fallback (FTS provides its own).
function fallbackSnippet(text: string, q: string, span = 90): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, span);
  const start = Math.max(0, idx - Math.floor(span / 3));
  const end = Math.min(text.length, idx + q.length + span);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export class History {
  private db: Database.Database | null = null;
  private queue: Op[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private retentionStart: NodeJS.Timeout | null = null;
  private warned = false;

  // Query SQL varies only by which WHERE clauses are present, so a handful of
  // shapes dominate — caching the prepared statements keeps the hot read
  // paths (M54) from re-parsing SQL on every API call.
  private readonly stmtCache = new Map<string, Database.Statement>();

  private prepared(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db!.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  // Recorded when the constructor archives a corrupt DB and starts fresh.
  // Surfaced by `daimon doctor`'s history-db-healthy rule.
  private archivedCorruptPath: string | null = null;

  constructor(private readonly cfg: HistoryConfig) {
    if (!cfg.enabled) return;
    try {
      fs.mkdirSync(path.dirname(cfg.path), { recursive: true });
      const Better = requireCjs('better-sqlite3');
      // Open + integrity-check. If the existing DB is corrupt we rename it to
      // history.db.corrupt-<ts> (keeping the data around for forensics) and
      // create a fresh DB. Schema migrations on the fresh DB happen below.
      let opened: Database.Database | null = null;
      // Returns true only if the corrupt file was successfully moved aside.
      // If the rename fails (e.g. a stale handle still holds history.db on
      // Windows), we must NOT reopen the same corrupt file and migrate against
      // it — the caller disables history instead.
      const archiveCorrupt = (reason: string): boolean => {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const archived = `${cfg.path}.corrupt-${ts}`;
        try {
          if (fs.existsSync(cfg.path)) fs.renameSync(cfg.path, archived);
          try { fs.unlinkSync(cfg.path + '-wal'); } catch {}
          try { fs.unlinkSync(cfg.path + '-shm'); } catch {}
          this.archivedCorruptPath = archived;
          process.stderr.write(`[daimon] history: archived corrupt db (${reason}) -> ${archived}\n`);
          return true;
        } catch (renameErr: any) {
          this.warnOnce(`failed to archive corrupt history db: ${renameErr?.message || renameErr}`);
          return false;
        }
      };
      try {
        opened = new Better(cfg.path);
        const r = opened!.prepare('PRAGMA integrity_check').get() as any;
        const ok = r && (r.integrity_check === 'ok' || r['integrity_check'] === 'ok');
        if (!ok) {
          try { opened!.close(); } catch {}
          opened = null;
          if (!archiveCorrupt('integrity_check failed')) { this.db = null; return; }
          opened = new Better(cfg.path);
        }
      } catch (openErr: any) {
        // Open-time errors (file-format mismatch, truncation) — same archive path.
        if (opened) { try { opened.close(); } catch {} opened = null; }
        if (!archiveCorrupt(`open failed: ${openErr?.message || openErr}`)) { this.db = null; return; }
        opened = new Better(cfg.path);
      }
      this.db = opened;
      if (!this.db) return; // unreachable: we returned early on any archive failure
      this.db.pragma('journal_mode = WAL');
      this.migrate();
      this.setupFts();
      // unref: history book-keeping must never be the thing keeping the
      // process alive (the daemon's server handles do that; close() flushes).
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
      this.retentionStart = setTimeout(() => this.runRetention(), RETENTION_DEBOUNCE_MS);
      this.retentionStart.unref?.();
      this.retentionTimer = setInterval(() => this.runRetention(), RETENTION_PASS_MS);
      this.retentionTimer.unref?.();
    } catch (err: any) {
      this.warnOnce(`failed to open history db: ${err?.message || err}`);
      this.db = null;
    }
  }

  archivedCorruptDbPath(): string | null {
    return this.archivedCorruptPath;
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
      CREATE INDEX IF NOT EXISTS events_app_ts ON events(app, ts);
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
      CREATE TABLE IF NOT EXISTS log_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        line TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS log_lines_ts ON log_lines(ts);
      CREATE INDEX IF NOT EXISTS log_lines_app_ts ON log_lines(app, ts);
      CREATE TABLE IF NOT EXISTS crashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        exitCode INTEGER,
        signal TEXT,
        uptimeMs INTEGER,
        lastLines TEXT,
        gitHead TEXT
      );
      CREATE INDEX IF NOT EXISTS crashes_app_ts ON crashes(app, ts);
      CREATE TABLE IF NOT EXISTS test_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        runner TEXT,
        durationMs INTEGER,
        total INTEGER,
        passed INTEGER,
        failed INTEGER,
        skipped INTEGER,
        exitCode INTEGER,
        gitHead TEXT
      );
      CREATE INDEX IF NOT EXISTS test_runs_app_ts ON test_runs(app, ts);
      CREATE TABLE IF NOT EXISTS test_failures (
        runId INTEGER NOT NULL,
        suite TEXT,
        test TEXT,
        file TEXT,
        line INTEGER,
        message TEXT,
        fingerprint TEXT
      );
      CREATE INDEX IF NOT EXISTS test_failures_run ON test_failures(runId);
      CREATE INDEX IF NOT EXISTS test_failures_fp ON test_failures(fingerprint);
      CREATE TABLE IF NOT EXISTS env_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS env_snapshots_app_ts ON env_snapshots(app, ts);
      CREATE TABLE IF NOT EXISTS self_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        rssMB REAL NOT NULL,
        heapUsedMB REAL NOT NULL,
        eventLoopLagMs REAL NOT NULL,
        historyQueryP95Ms REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS self_metrics_ts ON self_metrics(ts);
    `);
  }

  // ---------------------------------------------------------------------------
  // Full-text search (M77). FTS5 external-content tables over events and log
  // lines, kept in sync by insert/delete triggers so retention pruning cascades.
  // If FTS5 is unavailable or setup fails, search degrades to a LIKE scan and
  // the daemon keeps running — ftsDegradedReason() lets main.ts self-warn once.
  // ---------------------------------------------------------------------------

  private ftsOk = false;
  private ftsError: string | null = null;

  ftsAvailable(): boolean {
    return this.ftsOk;
  }

  ftsDegradedReason(): string | null {
    return this.db && !this.ftsOk ? (this.ftsError ?? 'unknown') : null;
  }

  // FTS indexing is DEFERRED, not trigger-per-insert: synchronous FTS5 writes
  // cost 4-10× on the insert path (measured), blowing the <10% write-overhead
  // budget. Instead a high-water mark (fts_state) tracks the last indexed
  // rowid per table; syncFts() catches up in chunks on idle flush ticks,
  // fully before retention pruning (so the delete triggers only ever see
  // indexed rows), and fully before every search (results are never stale).
  private setupFts(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS fts_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
          message, type UNINDEXED, app UNINDEXED,
          content='events', content_rowid='id'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(
          line, app UNINDEXED,
          content='log_lines', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, message, type, app) VALUES ('delete', old.id, coalesce(old.message,''), old.type, old.app);
        END;
        CREATE TRIGGER IF NOT EXISTS log_fts_ad AFTER DELETE ON log_lines BEGIN
          INSERT INTO log_fts(log_fts, rowid, line, app) VALUES ('delete', old.id, old.line, old.app);
        END;
        INSERT OR IGNORE INTO fts_state (key, value) VALUES ('events_hwm', 0);
        INSERT OR IGNORE INTO fts_state (key, value) VALUES ('logs_hwm', 0);
      `);
      // Probe with a real MATCH: IF NOT EXISTS silently accepts a plain table
      // squatting on the name, and a broken FTS module only fails at query time.
      this.db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH '"daimon-probe"' LIMIT 1`).all();
      this.db.prepare(`SELECT rowid FROM log_fts WHERE log_fts MATCH '"daimon-probe"' LIMIT 1`).all();
      this.ftsOk = true;
    } catch (err: any) {
      this.ftsOk = false;
      this.ftsError = err?.message || String(err);
      // Broken FTS + live delete triggers would fail retention pruning — drop
      // them so history keeps working and search falls back to LIKE.
      try {
        this.db.exec(`
          DROP TRIGGER IF EXISTS events_fts_ad;
          DROP TRIGGER IF EXISTS log_fts_ad;
        `);
      } catch {}
      process.stderr.write(`[daimon] history: FTS unavailable, search degrades to LIKE (${this.ftsError})\n`);
    }
  }

  // Index rows above the high-water mark, up to `chunk` per table (Infinity =
  // catch up fully). Runs inside one transaction per table.
  syncFts(chunk = Infinity): number {
    if (!this.db || !this.ftsOk) return 0;
    let indexed = 0;
    try {
      const getHwm = this.prepared(`SELECT value FROM fts_state WHERE key = ?`);
      const setHwm = this.prepared(`UPDATE fts_state SET value = ? WHERE key = ?`);
      const lim = Number.isFinite(chunk) ? Math.max(1, chunk) : -1; // -1 = no LIMIT
      // events
      {
        const hwm = (getHwm.get('events_hwm') as any)?.value ?? 0;
        const rows = this.prepared(`SELECT id, coalesce(message,'') AS message, type, app FROM events WHERE id > ? ORDER BY id LIMIT ?`)
          .all(hwm, lim === -1 ? 1_000_000_000 : lim) as any[];
        if (rows.length) {
          const ins = this.prepared(`INSERT INTO events_fts(rowid, message, type, app) VALUES (?,?,?,?)`);
          const tx = this.db.transaction(() => {
            for (const r of rows) ins.run(r.id, r.message, r.type, r.app);
            setHwm.run(rows[rows.length - 1].id, 'events_hwm');
          });
          tx();
          indexed += rows.length;
        }
      }
      // log lines
      {
        const hwm = (getHwm.get('logs_hwm') as any)?.value ?? 0;
        const rows = this.prepared(`SELECT id, line, app FROM log_lines WHERE id > ? ORDER BY id LIMIT ?`)
          .all(hwm, lim === -1 ? 1_000_000_000 : lim) as any[];
        if (rows.length) {
          const ins = this.prepared(`INSERT INTO log_fts(rowid, line, app) VALUES (?,?,?)`);
          const tx = this.db.transaction(() => {
            for (const r of rows) ins.run(r.id, r.line, r.app);
            setHwm.run(rows[rows.length - 1].id, 'logs_hwm');
          });
          tx();
          indexed += rows.length;
        }
      }
    } catch (err: any) {
      this.ftsOk = false;
      this.ftsError = err?.message || String(err);
      try { this.db.exec('DROP TRIGGER IF EXISTS events_fts_ad; DROP TRIGGER IF EXISTS log_fts_ad;'); } catch {}
      this.warnOnce(`FTS sync failed, search degrades to LIKE: ${this.ftsError}`);
    }
    return indexed;
  }

  // Per-app log-line capture feeding log_fts. Callers gate on the
  // search.logIndex / overrides.<app>.logIndex config — this just writes.
  recordLogLine(app: string, line: string, ts = Date.now()): void {
    if (!this.db) return;
    if (!line) return;
    this.queue.push({ kind: 'log', row: { ts, app, line: line.length > 2000 ? line.slice(0, 2000) : line } });
  }

  search(opts: { q: string; app?: string; since?: number; kind?: 'logs' | 'errors' | 'events'; limit?: number }): { hits: SearchHit[]; fallback: boolean } {
    if (!this.db || !opts.q || !opts.q.trim()) return { hits: [], fallback: !this.ftsOk };
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const wantEvents = !opts.kind || opts.kind === 'events' || opts.kind === 'errors';
    const wantLogs = !opts.kind || opts.kind === 'logs';
    const hits: SearchHit[] = [];
    try {
      if (this.ftsOk) {
        // Flush queued rows then index to head — search is read-your-writes.
        this.flush();
        this.syncFts();
      }
      if (this.ftsOk) {
        const match = ftsQuery(opts.q);
        if (!match) return { hits: [], fallback: false };
        if (wantEvents) {
          const wh: string[] = ['events_fts MATCH ?'];
          const args: any[] = [match];
          if (opts.app) { wh.push('e.app = ?'); args.push(opts.app); }
          if (opts.since != null) { wh.push('e.ts >= ?'); args.push(opts.since); }
          if (opts.kind === 'errors') wh.push(`e.type IN (${ERROR_EVENT_TYPES.map(() => '?').join(',')})`);
          if (opts.kind === 'errors') args.push(...ERROR_EVENT_TYPES);
          args.push(limit);
          // rowid DESC ≈ ts DESC (append-only) and lets FTS5 stream matches
          // newest-first, stopping at LIMIT instead of materializing them all.
          const rows = this.prepared(
            `SELECT e.id, e.ts, e.app, e.type, snippet(events_fts, 0, '', '', '…', 16) AS snip
             FROM events_fts JOIN events e ON e.id = events_fts.rowid
             WHERE ${wh.join(' AND ')} ORDER BY events_fts.rowid DESC LIMIT ?`,
          ).all(...args) as any[];
          for (const r of rows) {
            hits.push({
              kind: ERROR_EVENT_TYPES.includes(r.type) ? 'errors' : 'events',
              app: r.app, ts: r.ts, snippet: r.snip || r.type, ref: `event:${r.id}`,
            });
          }
        }
        if (wantLogs) {
          const wh: string[] = ['log_fts MATCH ?'];
          const args: any[] = [ftsQuery(opts.q)];
          if (opts.app) { wh.push('l.app = ?'); args.push(opts.app); }
          if (opts.since != null) { wh.push('l.ts >= ?'); args.push(opts.since); }
          args.push(limit);
          const rows = this.prepared(
            `SELECT l.id, l.ts, l.app, snippet(log_fts, 0, '', '', '…', 16) AS snip
             FROM log_fts JOIN log_lines l ON l.id = log_fts.rowid
             WHERE ${wh.join(' AND ')} ORDER BY log_fts.rowid DESC LIMIT ?`,
          ).all(...args) as any[];
          for (const r of rows) {
            hits.push({ kind: 'logs', app: r.app, ts: r.ts, snippet: r.snip, ref: `log:${r.id}` });
          }
        }
        hits.sort((a, b) => b.ts - a.ts);
        return { hits: hits.slice(0, limit), fallback: false };
      }
    } catch (err: any) {
      // A MATCH-time failure (e.g. the DB was tampered with mid-flight)
      // degrades this call to LIKE rather than erroring the endpoint.
      this.ftsOk = false;
      this.ftsError = err?.message || String(err);
    }
    // LIKE fallback — slower, but never blocks the daemon.
    const pat = likePattern(opts.q.trim());
    if (wantEvents) {
      const wh: string[] = [`message LIKE ? ESCAPE '\\'`];
      const args: any[] = [pat];
      if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
      if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
      if (opts.kind === 'errors') { wh.push(`type IN (${ERROR_EVENT_TYPES.map(() => '?').join(',')})`); args.push(...ERROR_EVENT_TYPES); }
      args.push(limit);
      const rows = this.prepared(`SELECT id, ts, app, type, message FROM events WHERE ${wh.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args) as any[];
      for (const r of rows) {
        hits.push({
          kind: ERROR_EVENT_TYPES.includes(r.type) ? 'errors' : 'events',
          app: r.app, ts: r.ts, snippet: fallbackSnippet(r.message ?? '', opts.q.trim()), ref: `event:${r.id}`,
        });
      }
    }
    if (wantLogs) {
      const wh: string[] = [`line LIKE ? ESCAPE '\\'`];
      const args: any[] = [pat];
      if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
      if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
      args.push(limit);
      const rows = this.prepared(`SELECT id, ts, app, line FROM log_lines WHERE ${wh.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args) as any[];
      for (const r of rows) {
        hits.push({ kind: 'logs', app: r.app, ts: r.ts, snippet: fallbackSnippet(r.line, opts.q.trim()), ref: `log:${r.id}` });
      }
    }
    hits.sort((a, b) => b.ts - a.ts);
    return { hits: hits.slice(0, limit), fallback: true };
  }

  recordSelfMetric(rssMB: number, heapUsedMB: number, eventLoopLagMs: number, historyQueryP95Ms: number, ts = Date.now()): void {
    if (!this.db) return;
    try {
      this.db.prepare('INSERT INTO self_metrics (ts,rssMB,heapUsedMB,eventLoopLagMs,historyQueryP95Ms) VALUES (?,?,?,?,?)').run(ts, rssMB, heapUsedMB, eventLoopLagMs, historyQueryP95Ms);
    } catch (err: any) {
      this.warnOnce(`self_metrics write failed: ${err?.message || err}`);
    }
  }

  querySelfMetrics(opts: { since?: number; limit?: number } = {}): { ts: number; rssMB: number; heapUsedMB: number; eventLoopLagMs: number; historyQueryP95Ms: number }[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    const sql = `SELECT ts, rssMB, heapUsedMB, eventLoopLagMs, historyQueryP95Ms FROM self_metrics ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 60);
    return this.prepared(sql).all(...args) as any[];
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
    if (!this.db) return;
    if (this.queue.length === 0) {
      // Idle tick: catch the FTS index up in bounded chunks so search stays
      // warm without ever taxing the write path.
      if (this.ftsOk) this.syncFts(5000);
      return;
    }
    const batch = this.queue;
    this.queue = [];
    try {
      const insEv = this.db.prepare('INSERT INTO events (ts,app,type,from_state,to_state,message) VALUES (?,?,?,?,?,?)');
      const insCm = this.db.prepare('INSERT INTO compile_times (ts,app,ms) VALUES (?,?,?)');
      const insTk = this.db.prepare('INSERT INTO task_runs (ts,app,task,exit_code,duration_ms,summary) VALUES (?,?,?,?,?,?)');
      const insBd = this.db.prepare('INSERT INTO bundles (ts,app,initialKB,lazyKB,fileCount) VALUES (?,?,?,?,?)');
      const insLg = this.db.prepare('INSERT INTO log_lines (ts,app,line) VALUES (?,?,?)');
      const tx = this.db.transaction((ops: Op[]) => {
        for (const op of ops) {
          if (op.kind === 'event') insEv.run(op.row.ts, op.row.app, op.row.type, op.row.from_state, op.row.to_state, op.row.message);
          else if (op.kind === 'compile') insCm.run(op.row.ts, op.row.app, op.row.ms);
          else if (op.kind === 'bundle') insBd.run(op.row.ts, op.row.app, op.row.initialKB, op.row.lazyKB, op.row.fileCount);
          else if (op.kind === 'log') insLg.run(op.row.ts, op.row.app, op.row.line);
          else insTk.run(op.row.ts, op.row.app, op.row.task, op.row.exit_code, op.row.duration_ms, op.row.summary);
        }
      });
      tx(batch);
    } catch (err: any) {
      this.warnOnce(`history write failed: ${err?.message || err}`);
      // Re-queue on a failed transaction (disk full, locked DB) so a transient
      // error doesn't silently drop the batch. Cap the backlog so a persistent
      // failure can't grow the queue without bound.
      if (this.queue.length < 10_000) this.queue = batch.concat(this.queue);
    }
  }

  private runRetention(): void {
    if (!this.db) return;
    // retentionDays <= 0 means "keep everything" (the dashboard field documents
    // 0 as "disables pruning"). Without this guard a cutoff of `now` would
    // DELETE the entire history on the first pass — the opposite of intent.
    if (!(this.cfg.retentionDays > 0)) return;
    try {
      // Fully sync FTS first: the AFTER DELETE cascade triggers assume every
      // row they remove was indexed.
      this.syncFts();
      const cutoff = Date.now() - this.cfg.retentionDays * 86400000;
      this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM compile_times WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM task_runs WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM bundles WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM self_metrics WHERE ts < ?').run(cutoff);
      // Failures cascade with their runs — prune child rows first so a crash
      // between the two statements can't orphan failures.
      this.db.prepare('DELETE FROM test_failures WHERE runId IN (SELECT id FROM test_runs WHERE ts < ?)').run(cutoff);
      this.db.prepare('DELETE FROM test_runs WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM crashes WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM env_snapshots WHERE ts < ?').run(cutoff);
      // FTS shadows cascade via the AFTER DELETE triggers.
      this.db.prepare('DELETE FROM log_lines WHERE ts < ?').run(cutoff);
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
    return this.prepared(sql).all(...args) as EventRow[];
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
    return this.prepared(sql).all(...args) as CompileRow[];
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
    return this.prepared(sql).all(...args) as BundleRow[];
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

  // Unified timeline: merge events + compile_times + bundles + task_runs into a
  // single sorted-desc stream. Each row carries a `kind` chip the UI uses to
  // color-code rows, plus a tight summary string and the full payload for
  // drilldown. The server route accepts ?since=&app=&kinds=<csv>.
  queryTimeline(opts: { app?: string; since?: number; kinds?: Set<string>; limit?: number }): { ts: number; app: string; kind: string; summary: string; payload: any }[] {
    if (!this.db) return [];
    const limit = opts.limit ?? 5000;
    const since = opts.since;
    const want = opts.kinds;
    const out: { ts: number; app: string; kind: string; summary: string; payload: any }[] = [];

    const wantStatus = !want || want.has('status');
    const wantError = !want || want.has('error');
    const wantWarning = !want || want.has('warning');
    const wantLint = !want || want.has('lint');
    const wantHealth = !want || want.has('health');
    const wantBundle = !want || want.has('bundle');
    const wantTask = !want || want.has('task');
    const wantRestart = !want || want.has('restart');

    if (wantStatus || wantError || wantWarning || wantLint || wantHealth || wantRestart) {
      const evs = this.queryEvents({ app: opts.app, since, limit });
      for (const r of evs) {
        let kind: string | null = null;
        if (r.type === 'status' && wantStatus) kind = 'status';
        else if ((r.type === 'error-new' || r.type === 'error-recur') && wantError) kind = 'error';
        else if ((r.type === 'warning-new' || r.type === 'warning-recur') && wantWarning) kind = 'warning';
        else if ((r.type === 'lint-new' || r.type === 'lint-recur') && wantLint) kind = 'lint';
        else if (r.type === 'health' && wantHealth) kind = 'health';
        else if ((r.type === 'restart-scheduled' || r.type === 'bundle-regression' || r.type === 'compile-regression' || r.type === 'stale' || r.type === 'self-warn' || r.type === 'crash' || r.type === 'restart-storm') && wantRestart) kind = 'restart';
        if (!kind) continue;
        const summary = kind === 'status'
          ? `${r.from_state ?? '?'} → ${r.to_state ?? '?'}`
          : (r.message ?? r.type);
        out.push({ ts: r.ts, app: r.app, kind, summary, payload: r });
      }
    }
    if (wantBundle) {
      const bs = this.queryBundles({ app: opts.app, since, limit });
      for (const r of bs) {
        out.push({ ts: r.ts, app: r.app, kind: 'bundle', summary: `initial ${r.initialKB}KB · lazy ${r.lazyKB}KB`, payload: r });
      }
    }
    // compile-times rolls up as 'compile' kind, treated like task runs (a metric event).
    if (wantTask) {
      const cs = this.queryCompiles({ app: opts.app, since, limit });
      for (const r of cs) {
        out.push({ ts: r.ts, app: r.app, kind: 'compile', summary: `compile ${(r.ms / 1000).toFixed(1)}s`, payload: r });
      }
      const ts = this.queryTasks({ app: opts.app, since, limit });
      for (const r of ts) {
        const dur = r.duration_ms ?? 0;
        out.push({ ts: r.ts, app: r.app, kind: 'task', summary: `${r.task} exit=${r.exit_code} ${(dur / 1000).toFixed(1)}s`, payload: r });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, limit);
  }

  // Crash reports (M76). Ring-buffered by design: the last `ring` crashes per
  // app survive, older rows are pruned on insert — bounded forensics, not a
  // second event log. Synchronous: crashes are rare and the caller is already
  // off the log-line hot path.
  recordCrash(
    row: { app: string; ts?: number; exitCode: number | null; signal: string | null; uptimeMs: number | null; lastLines: string[]; gitHead: string | null },
    ring = 10,
  ): void {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(() => {
        this.prepared('INSERT INTO crashes (ts,app,exitCode,signal,uptimeMs,lastLines,gitHead) VALUES (?,?,?,?,?,?,?)')
          .run(row.ts ?? Date.now(), row.app, row.exitCode, row.signal, row.uptimeMs, row.lastLines.slice(-50).join('\n'), row.gitHead);
        this.prepared('DELETE FROM crashes WHERE app = ? AND id NOT IN (SELECT id FROM crashes WHERE app = ? ORDER BY id DESC LIMIT ?)')
          .run(row.app, row.app, ring);
      });
      tx();
    } catch (err: any) {
      this.warnOnce(`crashes write failed: ${err?.message || err}`);
    }
  }

  queryCrashes(opts: { app?: string; since?: number; limit?: number } = {}): CrashRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    const sql = `SELECT * FROM crashes ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 10);
    try { return this.prepared(sql).all(...args) as CrashRow[]; } catch { return []; }
  }

  // Env snapshots (M82). The payload is REDACTED BY CONSTRUCTION: envFiles.ts
  // hands over key names + salted truncated hashes only — raw values were
  // discarded before this is ever called. Synchronous like crashes: one row
  // per app spawn, far off the log-line hot path.
  recordEnvSnapshot(app: string, snapshot: unknown, ts = Date.now()): void {
    if (!this.db) return;
    try {
      this.prepared('INSERT INTO env_snapshots (ts,app,json) VALUES (?,?,?)').run(ts, app, JSON.stringify(snapshot));
    } catch (err: any) {
      this.warnOnce(`env_snapshots write failed: ${err?.message || err}`);
    }
  }

  queryEnvSnapshots(opts: { app?: string; since?: number; until?: number; limit?: number } = {}): { id: number; ts: number; app: string; json: string }[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    if (opts.until != null) { wh.push('ts <= ?'); args.push(opts.until); }
    const sql = `SELECT * FROM env_snapshots ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 10);
    try { return this.prepared(sql).all(...args) as any[]; } catch { return []; }
  }

  // Test runs (M74) insert synchronously (not via the flush queue) because the
  // caller needs the rowid to attach failures — one transaction per suite run,
  // far off the log-line hot path.
  recordTestRun(
    run: { app: string; ts?: number; runner: string | null; durationMs: number | null; total: number | null; passed: number | null; failed: number | null; skipped: number | null; exitCode: number | null; gitHead: string | null },
    failures: { suite: string; test: string; file?: string; line?: number; message: string; fingerprint: string }[],
  ): number | null {
    if (!this.db) return null;
    try {
      const insRun = this.prepared('INSERT INTO test_runs (ts,app,runner,durationMs,total,passed,failed,skipped,exitCode,gitHead) VALUES (?,?,?,?,?,?,?,?,?,?)');
      const insFail = this.prepared('INSERT INTO test_failures (runId,suite,test,file,line,message,fingerprint) VALUES (?,?,?,?,?,?,?)');
      const tx = this.db.transaction(() => {
        const r = insRun.run(run.ts ?? Date.now(), run.app, run.runner, run.durationMs, run.total, run.passed, run.failed, run.skipped, run.exitCode, run.gitHead);
        const runId = Number(r.lastInsertRowid);
        for (const f of failures) {
          insFail.run(runId, f.suite, f.test, f.file ?? null, f.line ?? null, f.message, f.fingerprint);
        }
        return runId;
      });
      return tx() as number;
    } catch (err: any) {
      this.warnOnce(`test_runs write failed: ${err?.message || err}`);
      return null;
    }
  }

  queryTestRuns(opts: { app?: string; since?: number; limit?: number } = {}): TestRunRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    const sql = `SELECT * FROM test_runs ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 50);
    try { return this.prepared(sql).all(...args) as TestRunRow[]; } catch { return []; }
  }

  queryTestFailures(runIds: number[]): TestFailureRow[] {
    if (!this.db || runIds.length === 0) return [];
    // Keyset is small (≤ query limit) — an IN list beats N round-trips.
    const placeholders = runIds.map(() => '?').join(',');
    try {
      return this.db.prepare(`SELECT * FROM test_failures WHERE runId IN (${placeholders})`).all(...runIds) as TestFailureRow[];
    } catch {
      return [];
    }
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
    return this.prepared(sql).all(...args) as TaskRunRow[];
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

  _flushForTest(): void {
    this.flush();
  }

  _runRetentionForTest(): void {
    this.runRetention();
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
      // Force a WAL checkpoint so a SIGKILL between flush and close doesn't
      // leave the next startup with an oversized -wal sidecar. Best-effort —
      // SQLite already journals safely, this just keeps disk tidy.
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}
