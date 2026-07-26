import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import type { AppEvent, HistoryConfig } from './types.js';
import { LEVEL_EVENT_TYPES, isFilterOnly, type ParsedQuery, type SearchKind } from './searchQuery.js';

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
  // Coverage summary (M128, v1.7) — additive nullable; old rows read null.
  covLinesPct: number | null;
  covStmtsPct: number | null;
  // Failed-only rerun marker (M131, v1.7) — 1 when this run reran only prior
  // failures; totals reflect only what ran. Additive nullable; old rows null.
  failedOnly: number | null;
}

export interface TestFailureRow {
  runId: number;
  suite: string | null;
  test: string | null;
  file: string | null;
  line: number | null;
  message: string | null;
  fingerprint: string | null;
  // Quarantine annotation (M130, v1.7) — additive nullable; old rows read null.
  quarantined: number | null;
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

// Largest FTS backlog `search()` will index inline before answering (M146,
// v1.10). DERIVED, not picked: a cold-index catch-up on the 1M corpus indexed
// 3,000,187 rows in 51,492ms — 17.2µs/row. 10,000 rows is therefore ~170ms of
// inline work, which sits inside the interactive search budget. Beyond it,
// search answers from the complete-but-slower LIKE path while the idle tick
// catches the index up in 5k chunks.
const FTS_INLINE_SYNC_MAX = 10_000;

// Time-sliced retention (M147, v1.10). An unbounded prune of the 1M corpus
// blocked the event loop for 28.8s; these bound it.
//
// SLICE_MS is the longest the loop may be held in one go. 50ms is the standard
// "a frame was dropped but nothing timed out" budget: the TUI redraw, the HTTP
// keep-alive and the log-ingest flush (200ms) all tolerate it comfortably.
// CHUNK is sized so one DELETE lands well inside a slice — measured, the 1M
// prune ran ~104k rows/s, so 5k rows is ~50ms of work in the worst case.
// RESUME_MS then hands a full tick back to the loop before the next slice.
const RETENTION_SLICE_MS = 50;
const RETENTION_CHUNK = 5_000;
const RETENTION_RESUME_MS = 25;

// Prune order is LOAD-BEARING: test_failures is a child of test_runs and must
// go first, so an interrupted pass can never orphan failure rows. `rowid` is
// used uniformly — it is the implicit key on the two tables that declare none,
// and an alias for `id INTEGER PRIMARY KEY` on the rest.
const RETENTION_TABLES: { table: string; key: string; child?: boolean; where?: string }[] = [
  { table: 'test_failures', key: 'rowid', child: true, where: 'runId IN (SELECT id FROM test_runs WHERE ts < ?)' },
  { table: 'test_runs', key: 'rowid' },
  { table: 'events', key: 'rowid' },
  { table: 'compile_times', key: 'rowid' },
  { table: 'task_runs', key: 'rowid' },
  { table: 'bundles', key: 'rowid' },
  { table: 'self_metrics', key: 'rowid' },
  { table: 'crashes', key: 'rowid' },
  { table: 'env_snapshots', key: 'rowid' },
  { table: 'resource_samples', key: 'rowid' },
  // FTS shadows cascade via the AFTER DELETE triggers.
  { table: 'log_lines', key: 'rowid' },
];
const RETENTION_PASS_MS = 6 * 60 * 60 * 1000;
const RETENTION_DEBOUNCE_MS = 10_000;

type Op =
  | { kind: 'event'; row: { ts: number; app: string; type: string; from_state: string | null; to_state: string | null; message: string | null } }
  | { kind: 'compile'; row: { ts: number; app: string; ms: number } }
  | { kind: 'bundle'; row: { ts: number; app: string; initialKB: number; lazyKB: number; fileCount: number } }
  | { kind: 'task'; row: { ts: number; app: string; task: string; exit_code: number | null; duration_ms: number | null; summary: string | null } }
  | { kind: 'log'; row: { ts: number; app: string; line: string; level: string | null } }
  | { kind: 'resource'; row: { ts: number; app: string; rss: number; cpu: number } };

// One downsampled pidusage reading (M105). rss in bytes, cpu in percent.
export interface ResourceSampleRow {
  app: string;
  ts: number;
  rss: number | null;
  cpu: number | null;
}

export interface SearchHit {
  // 'tests' and 'error-groups' (M180, v1.16) appear only under the unified
  // scope — an existing call never sees them.
  kind: 'logs' | 'errors' | 'events' | 'tests' | 'error-groups';
  app: string;
  ts: number;
  snippet: string;
  // Stable pointer back into history: "event:<id>", "log:<id>", "test:<id>"
  // or "errgroup:<fingerprint>".
  ref: string;
}

export interface SearchOptions {
  q: string;
  app?: string;
  since?: number;
  kind?: SearchKind;
  limit?: number;
  // M179 (v1.16): the compiled query. When present its fields WIN over the
  // equivalent legacy options (`app`/`since`/`kind`) — one rule, documented
  // once: the query string is the more specific statement of intent. Absent =
  // v1.15 behaviour exactly (bare terms, whole-string LIKE fallback).
  query?: ParsedQuery;
  // M180 (v1.16): opt in to the unified scope (test runs here; error groups
  // are composed by the caller, which owns the live registry).
  scope?: 'all';
}

export interface SearchResult {
  hits: SearchHit[];
  fallback: boolean;
  // Present ONLY when the unified scope was requested (M180) — an existing
  // call gets the byte-identical `{ hits, fallback }` body it always did.
  facets?: Record<string, number>;
}

// Event types the 'errors' search kind covers (everything issue-shaped).
const ERROR_EVENT_TYPES = ['error-new', 'error-recur', 'warning-new', 'warning-recur', 'lint-new', 'lint-recur', 'crash'];

// Exported for the drift test: every type named in searchQuery's
// LEVEL_EVENT_TYPES must be a member of this list, or `level:` and
// `kind:errors` would disagree about what an error is.
export function errorEventTypes(): readonly string[] { return ERROR_EVENT_TYPES; }

// FTS5 MATCH has its own query syntax — quote every user token so `foo-bar`,
// `a"b` or `NEAR` can't inject operators. A trailing `*` keeps prefix search.
// A token containing spaces (a "quoted phrase", M179) becomes one quoted FTS
// token, which is exactly FTS5's phrase syntax.
export function ftsQueryFromTerms(tokens: string[]): string {
  return tokens.filter(Boolean).slice(0, 8).map(t => {
    const prefix = t.length > 1 && t.endsWith('*');
    const body = (prefix ? t.slice(0, -1) : t).replace(/"/g, '""');
    return `"${body}"${prefix ? '*' : ''}`;
  }).join(' ');
}

export function ftsQuery(q: string): string {
  return ftsQueryFromTerms(q.split(/\s+/).filter(Boolean));
}

function likePattern(q: string): string {
  return '%' + q.replace(/([%_\\])/g, '\\$1') + '%';
}

// LIKE pattern for one parsed token: a trailing `*` is a prefix marker on the
// FTS path, so it must not become a literal `*` here.
function likePatternForToken(t: string): string {
  const body = t.length > 1 && t.endsWith('*') ? t.slice(0, -1) : t;
  return likePattern(body);
}

// Per-kind counts over the hits in a response (M180). Deliberately NOT corpus
// totals: counting the whole corpus per kind would cost a second query per
// store on every search, and the number a user acts on is what came back.
export function facetsOf(hits: SearchHit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hits) out[h.kind] = (out[h.kind] ?? 0) + 1;
  return out;
}

// JS-side snippet for the LIKE fallback (FTS provides its own).
function fallbackSnippet(text: string, q: string, span = 90): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, span);
  const start = Math.max(0, idx - Math.floor(span / 3));
  const end = Math.min(text.length, idx + q.length + span);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// Open-time verification mode (M146, v1.10).
//
//   'auto' — the default. Full `PRAGMA integrity_check` UNLESS the DB carries
//            our clean-shutdown marker, in which case a bounded structural
//            probe is enough.
//   'skip' — structural probe only. For SECONDARY handles opened by a caller
//            that runs its own explicit health check (doctor) — verifying
//            twice is pure duplicated cost.
export type VerifyMode = 'auto' | 'skip';

// Written into the (previously unused) `user_version` header field by close().
// A header int is read in microseconds and is invisible to older daimon
// versions, so a v1.9 daimon opens a v1.10 DB and vice versa with no change in
// behaviour — it simply runs its own integrity_check as it always did.
const CLEAN_SHUTDOWN_MARK = 0x0da1;

/**
 * Bounded structural probe: read the schema, then touch the root page of every
 * table. Cost is O(tables) — MILLISECONDS regardless of database size — and it
 * detects the corruption modes that actually occur (truncation, a partially
 * written page, a garbage file), because any of them break the pages this
 * touches. Measured against the recovery suite's deliberately corrupted DB:
 * caught in 3.6ms where integrity_check took 8539ms on a 610MB corpus.
 */
function structuralProbe(db: Database.Database): boolean {
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    for (const t of tables) db.prepare(`SELECT * FROM "${t.name}" LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a freshly opened DB, and report which check was used.
 *
 * WHY THIS EXISTS (v1.10): `PRAGMA integrity_check` is O(database size) and ran
 * on EVERY open. Measured on the 1M-event corpus (610MB) it cost 8.5s per open
 * — paid by daemon cold start, by every CLI command that touches history, and
 * six times over by `daimon doctor`, which opened six independent handles. The
 * `why` route calls doctor on the request path, so "what just happened" took
 * ~6s at 100k and would have taken ~51s at 1M.
 *
 * The invariant is PRESERVED where it matters: corruption comes from unclean
 * shutdown and disk failure, so a DB that was not closed cleanly still gets the
 * full check. Only a DB that daimon itself closed cleanly is trusted to a
 * bounded probe. Residual gap — bitrot on a cleanly-closed file — is caught by
 * `daimon doctor` (which still runs a full check) and by SQLITE_CORRUPT on use,
 * which the existing fail-soft paths already handle.
 */
function verifyOpenedDb(db: Database.Database, mode: VerifyMode): { ok: boolean; how: string } {
  if (mode === 'skip') return { ok: structuralProbe(db), how: 'structural probe' };
  let cleanlyClosed = false;
  try {
    cleanlyClosed = (db.pragma('user_version', { simple: true }) as number) === CLEAN_SHUTDOWN_MARK;
  } catch { /* unreadable header — fall through to the full check */ }
  if (cleanlyClosed) {
    // Re-arm: this handle now owns the DB, and a crash from here on must land
    // on the full check next time.
    try { db.pragma('user_version = 0'); } catch {}
    return { ok: structuralProbe(db), how: 'structural probe (clean shutdown)' };
  }
  const r = db.prepare('PRAGMA integrity_check').get() as any;
  const ok = !!r && (r.integrity_check === 'ok' || r['integrity_check'] === 'ok');
  return { ok, how: 'integrity_check' };
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

  private readonly verifyMode: VerifyMode;
  // Time-sliced retention cursor (M147): which table the pass is draining, and
  // whether a pass is already in flight so the 6h timer can't overlap itself.
  private retentionRunning = false;
  private retentionTableIdx = 0;

  constructor(private readonly cfg: HistoryConfig, opts: { verify?: VerifyMode } = {}) {
    this.verifyMode = opts.verify ?? 'auto';
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
        const { ok, how } = verifyOpenedDb(opened!, this.verifyMode);
        if (!ok) {
          try { opened!.close(); } catch {}
          opened = null;
          if (!archiveCorrupt(`${how} failed`)) { this.db = null; return; }
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
        line TEXT NOT NULL,
        level TEXT
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
      CREATE TABLE IF NOT EXISTS resource_samples (
        app TEXT NOT NULL,
        ts INTEGER NOT NULL,
        rss INTEGER,
        cpu REAL
      );
      CREATE INDEX IF NOT EXISTS resource_samples_app_ts ON resource_samples(app, ts);
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
    // Additive v1.2 migration (M99): nullable classified-level column on
    // log_lines. Guarded ALTER for DBs created before the column existed —
    // a v1.1 DB opens clean here, and a v1.2 DB opens clean under v1.1
    // (its INSERTs name their columns). Old rows read back with level null.
    try {
      const cols = this.db.prepare(`PRAGMA table_info(log_lines)`).all() as { name: string }[];
      if (!cols.some(c => c.name === 'level')) {
        this.db.exec(`ALTER TABLE log_lines ADD COLUMN level TEXT`);
      }
    } catch (err: any) {
      this.warnOnce(`log_lines level migration failed (levels degrade to null): ${err?.message || err}`);
    }
    // Additive v1.7 migration (M128/M130): nullable coverage columns on
    // test_runs and a quarantine flag on test_failures. Same guarded-ALTER
    // discipline — a v1.6 DB opens clean here, and a v1.7 DB opens clean under
    // v1.6 (its INSERTs name their columns). Old rows read the new columns null.
    try {
      const tr = this.db.prepare(`PRAGMA table_info(test_runs)`).all() as { name: string }[];
      if (!tr.some(c => c.name === 'covLinesPct')) this.db.exec(`ALTER TABLE test_runs ADD COLUMN covLinesPct REAL`);
      if (!tr.some(c => c.name === 'covStmtsPct')) this.db.exec(`ALTER TABLE test_runs ADD COLUMN covStmtsPct REAL`);
      if (!tr.some(c => c.name === 'failedOnly')) this.db.exec(`ALTER TABLE test_runs ADD COLUMN failedOnly INTEGER`);
      const tf = this.db.prepare(`PRAGMA table_info(test_failures)`).all() as { name: string }[];
      if (!tf.some(c => c.name === 'quarantined')) this.db.exec(`ALTER TABLE test_failures ADD COLUMN quarantined INTEGER`);
    } catch (err: any) {
      this.warnOnce(`test coverage/quarantine migration failed (fields degrade to null): ${err?.message || err}`);
    }
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
  /**
   * How many rows the FTS index is behind the base tables.
   *
   * O(1): `id` is INTEGER PRIMARY KEY in both tables, so MAX(id) is an index
   * lookup, and the high-water marks are a two-row table.
   */
  private ftsBacklog(): number {
    if (!this.db) return 0;
    try {
      const row = this.prepared(`
        SELECT
          (SELECT COALESCE(MAX(id), 0) FROM events)
            - COALESCE((SELECT value FROM fts_state WHERE key = 'events_hwm'), 0) AS ev,
          (SELECT COALESCE(MAX(id), 0) FROM log_lines)
            - COALESCE((SELECT value FROM fts_state WHERE key = 'logs_hwm'), 0) AS lg
      `).get() as { ev: number; lg: number };
      return Math.max(0, row?.ev ?? 0) + Math.max(0, row?.lg ?? 0);
    } catch {
      return 0;
    }
  }

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
  // `level` (M99) is the ingest-time classification; null = unclassified.
  recordLogLine(app: string, line: string, ts = Date.now(), level: string | null = null): void {
    if (!this.db) return;
    if (!line) return;
    this.queue.push({ kind: 'log', row: { ts, app, line: line.length > 2000 ? line.slice(0, 2000) : line, level } });
  }

  /**
   * Full-text + filter search over events, log lines and (under the unified
   * scope) test runs.
   *
   * COMPILATION RULE (M179, v1.16): the query syntax's filters become WHERE
   * clauses on the real columns — `app`, `ts`, `type`, `level` — on BOTH the
   * FTS path and the LIKE path. They are never expressed as FTS operators, so
   * a degraded index changes speed and snippet quality, never which rows match.
   */
  search(opts: SearchOptions): SearchResult {
    if (!this.db || !opts.q || !opts.q.trim()) return { hits: [], fallback: !this.ftsOk };
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const pq = opts.query;
    // Compiled filters. The query string wins over the legacy params (one rule,
    // applied to every field).
    const fApp = pq?.app ?? opts.app;
    const fAfter = pq?.after ?? opts.since;
    const fBefore = pq?.before;
    const fKind = pq?.kind ?? opts.kind;
    const fLevel = pq?.level;
    const unified = opts.scope === 'all' || fKind === 'tests' || fKind === 'error-groups';
    const textEmpty = pq ? isFilterOnly(pq) : !opts.q.trim();
    const wantEvents = !fKind || fKind === 'events' || fKind === 'errors';
    const wantLogs = !fKind || fKind === 'logs';
    // `tests` never appears unless asked for: byte-compatibility for every
    // pre-v1.16 call. `level:` is a severity, and a test run has none — asking
    // for one excludes test runs rather than inventing a level for them.
    const wantTests = (fKind === 'tests' || (unified && !fKind)) && !fLevel;
    const hits: SearchHit[] = [];
    const withFacets = (r: SearchResult): SearchResult => {
      if (unified) r.facets = facetsOf(r.hits);
      return r;
    };
    // Text tokens, per path.
    //   FTS  — a compiled query contributes its phrases (one quoted FTS token
    //          each = FTS5 phrase syntax) and its bare terms; a legacy call
    //          splits on whitespace exactly as v1.15 did.
    //   LIKE — a compiled query ANDs one pattern per token, which is the parity
    //          the syntax needs (same rows as FTS, just slower and without
    //          ranked snippets); a legacy call keeps v1.15's single
    //          whole-string pattern, so pre-v1.16 calls are unchanged.
    const ftsTokens = pq ? [...pq.phrases, ...pq.terms] : opts.q.split(/\s+/).filter(Boolean);
    const likeTokens = pq ? [...pq.phrases, ...pq.terms] : [opts.q.trim()];
    const snippetNeedle = likeTokens[0] ?? '';
    // ── the ONE filter builder, used by both paths ──────────────────────────
    // `p` is the column prefix ('e.' when joined against the FTS shadow, ''
    // when querying the base table directly). Same clauses, same order, both
    // paths — that is what makes a degraded index a speed story, not a
    // correctness one.
    const evFilters = (p: string) => {
      const wh: string[] = [];
      const args: any[] = [];
      if (fApp) { wh.push(`${p}app = ?`); args.push(fApp); }
      if (fAfter != null) { wh.push(`${p}ts >= ?`); args.push(fAfter); }
      if (fBefore != null) { wh.push(`${p}ts <= ?`); args.push(fBefore); }
      if (fKind === 'errors') { wh.push(`${p}type IN (${ERROR_EVENT_TYPES.map(() => '?').join(',')})`); args.push(...ERROR_EVENT_TYPES); }
      if (fLevel) {
        const types = LEVEL_EVENT_TYPES[fLevel];
        wh.push(`${p}type IN (${types.map(() => '?').join(',')})`);
        args.push(...types);
      }
      return { wh, args };
    };
    const logFilters = (p: string) => {
      const wh: string[] = [];
      const args: any[] = [];
      if (fApp) { wh.push(`${p}app = ?`); args.push(fApp); }
      if (fAfter != null) { wh.push(`${p}ts >= ?`); args.push(fAfter); }
      if (fBefore != null) { wh.push(`${p}ts <= ?`); args.push(fBefore); }
      // v1.2's nullable level column: a line daimon could not classify has NULL
      // here, so `level:` excludes it — documented, never guessed at.
      if (fLevel) { wh.push(`${p}level = ?`); args.push(fLevel); }
      return { wh, args };
    };
    // Whether THIS query may use the FTS index. Distinct from `ftsOk` (is the
    // index usable at all) — an index that is merely far behind is not wrong,
    // it is just not ready for this call. A filter-only query (no text at all,
    // M179) never touches the index: it is pure column predicates, exact on any
    // path, and `fallback` then reports only the state of the index.
    let useFts = this.ftsOk && !textEmpty;
    try {
      // Flush queued rows — search is read-your-writes on every path.
      this.flush();
      if (useFts) {
        // Bounded inline catch-up (M146, v1.10).
        //
        // syncFts() used to run UNBOUNDED here. On a cold high-water mark that
        // is the whole corpus: measured at 51.5s to index 3M rows on the 1M
        // corpus, so the first search after an index rebuild blocked for the
        // better part of a minute.
        //
        // Correctness is NOT traded away for speed. When the backlog is too
        // large to index inline we answer from the LIKE path, which scans the
        // base tables and therefore returns COMPLETE results — including rows
        // this process just wrote, so read-your-writes still holds. It is
        // slower and it already reports `fallback: true`; what it never is, is
        // wrong. The idle flush tick keeps indexing in 5k chunks meanwhile, so
        // this degrades for one query and heals itself.
        if (this.ftsBacklog() > FTS_INLINE_SYNC_MAX) useFts = false;
        else this.syncFts();
      }
      if (useFts && this.ftsOk) {
        const match = ftsQueryFromTerms(ftsTokens);
        if (!match) return withFacets({ hits: [], fallback: false });
        if (wantEvents) {
          const f = evFilters('e.');
          const wh: string[] = ['events_fts MATCH ?', ...f.wh];
          const args: any[] = [match, ...f.args];
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
          const f = logFilters('l.');
          const wh: string[] = ['log_fts MATCH ?', ...f.wh];
          const args: any[] = [match, ...f.args];
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
        // Test runs are a COLUMN query on both paths — test_runs has no FTS
        // shadow (adding one would mean a write-path trigger, which is
        // forbidden), so the unified scope costs the index nothing.
        if (wantTests) hits.push(...this.searchTestRuns(likeTokens, { app: fApp, after: fAfter, before: fBefore }, limit));
        hits.sort((a, b) => b.ts - a.ts);
        return withFacets({ hits: hits.slice(0, limit), fallback: false });
      }
    } catch (err: any) {
      // A MATCH-time failure (e.g. the DB was tampered with mid-flight)
      // degrades this call to LIKE rather than erroring the endpoint. Anything
      // the FTS branch had already collected is DROPPED first: the column path
      // below re-queries the same stores, so keeping partial results would
      // return the early rows twice.
      hits.length = 0;
      this.ftsOk = false;
      this.ftsError = err?.message || String(err);
    }
    // Column path — the LIKE fallback (slower, but COMPLETE: it scans the base
    // tables, so it never returns fewer rows than FTS would) and, for a
    // filter-only query, the only path there is.
    const textWhere = (col: string) => likeTokens.filter(Boolean).map(() => `${col} LIKE ? ESCAPE '\\'`);
    const textArgs = likeTokens.filter(Boolean).map(likePatternForToken);
    if (wantEvents) {
      const f = evFilters('');
      const wh: string[] = [...textWhere('message'), ...f.wh];
      const args: any[] = [...textArgs, ...f.args];
      args.push(limit);
      const rows = this.prepared(
        `SELECT id, ts, app, type, message FROM events${wh.length ? ' WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`,
      ).all(...args) as any[];
      for (const r of rows) {
        hits.push({
          kind: ERROR_EVENT_TYPES.includes(r.type) ? 'errors' : 'events',
          app: r.app, ts: r.ts, snippet: fallbackSnippet(r.message ?? '', snippetNeedle), ref: `event:${r.id}`,
        });
      }
    }
    if (wantLogs) {
      const f = logFilters('');
      const wh: string[] = [...textWhere('line'), ...f.wh];
      const args: any[] = [...textArgs, ...f.args];
      args.push(limit);
      const rows = this.prepared(
        `SELECT id, ts, app, line FROM log_lines${wh.length ? ' WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`,
      ).all(...args) as any[];
      for (const r of rows) {
        hits.push({ kind: 'logs', app: r.app, ts: r.ts, snippet: fallbackSnippet(r.line, snippetNeedle), ref: `log:${r.id}` });
      }
    }
    if (wantTests) hits.push(...this.searchTestRuns(likeTokens, { app: fApp, after: fAfter, before: fBefore }, limit));
    hits.sort((a, b) => b.ts - a.ts);
    // A filter-only query was answered exactly; `fallback` then describes the
    // index's health, not this answer's quality.
    return withFacets({ hits: hits.slice(0, limit), fallback: textEmpty ? !this.ftsOk : true });
  }

  /**
   * Test-run hits for the unified scope (M180, v1.16).
   *
   * A COLUMN query by design: `test_runs` / `test_failures` have no FTS shadow
   * and never will, because keeping one in sync would mean a per-insert trigger
   * — the one thing the deferred-indexing rule forbids. Matching is over the
   * runner name and the run's recorded failures (suite / test / file /
   * message); every token must match somewhere in the run (AND), mirroring the
   * text semantics of the other stores.
   */
  private searchTestRuns(tokens: string[], f: { app?: string; after?: number; before?: number }, limit: number): SearchHit[] {
    if (!this.db) return [];
    const out: SearchHit[] = [];
    try {
      const wh: string[] = [];
      const args: any[] = [];
      if (f.app) { wh.push('r.app = ?'); args.push(f.app); }
      if (f.after != null) { wh.push('r.ts >= ?'); args.push(f.after); }
      if (f.before != null) { wh.push('r.ts <= ?'); args.push(f.before); }
      for (const t of tokens.filter(Boolean)) {
        const p = likePatternForToken(t);
        wh.push(`(r.runner LIKE ? ESCAPE '\\' OR EXISTS (
                   SELECT 1 FROM test_failures tf WHERE tf.runId = r.id AND (
                     tf.suite LIKE ? ESCAPE '\\' OR tf.test LIKE ? ESCAPE '\\'
                     OR tf.file LIKE ? ESCAPE '\\' OR tf.message LIKE ? ESCAPE '\\')))`);
        args.push(p, p, p, p, p);
      }
      args.push(limit);
      const rows = this.prepared(
        `SELECT r.id, r.ts, r.app, r.runner, r.total, r.passed, r.failed, r.exitCode
         FROM test_runs r${wh.length ? ' WHERE ' + wh.join(' AND ') : ''} ORDER BY r.ts DESC LIMIT ?`,
      ).all(...args) as any[];
      if (!rows.length) return out;
      // One extra query for the whole page (never one per hit) to name a
      // failure in the snippet.
      const ids = rows.map(r => r.id);
      const firstFailure = new Map<number, string>();
      const fRows = this.prepared(
        `SELECT runId, suite, test FROM test_failures WHERE runId IN (${ids.map(() => '?').join(',')})`,
      ).all(...ids) as any[];
      for (const fr of fRows) {
        if (firstFailure.has(fr.runId)) continue;
        const name = [fr.suite, fr.test].filter(Boolean).join(' > ');
        if (name) firstFailure.set(fr.runId, name);
      }
      for (const r of rows) {
        const totals = `${r.passed ?? 0}/${r.total ?? 0} passed${r.failed ? `, ${r.failed} failed` : ''}`;
        const fail = firstFailure.get(r.id);
        out.push({
          kind: 'tests',
          app: r.app,
          ts: r.ts,
          snippet: `${r.runner || 'tests'} · ${totals}${fail ? ` — ${fail}` : ''}`,
          ref: `test:${r.id}`,
        });
      }
    } catch (err: any) {
      // A unified-scope query must never fail the whole search because the
      // test tables are unhappy — the other kinds still answer.
      this.warnOnce(`test-run search failed: ${err?.message || err}`);
    }
    return out;
  }

  // Log-volume rollup (M99/M103): total stored lines + per-level counts.
  // Unclassified rows land under 'null'. Flushes queued writes first so a
  // caller that just recorded sees its own lines (read-your-writes, like search).
  logVolume(opts: { app?: string; since?: number; until?: number } = {}): { total: number; byLevel: Record<string, number> } {
    const out = { total: 0, byLevel: {} as Record<string, number> };
    if (!this.db) return out;
    try {
      this.flush();
      const wh: string[] = [];
      const args: any[] = [];
      if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
      if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
      if (opts.until != null) { wh.push('ts <= ?'); args.push(opts.until); }
      const rows = this.prepared(
        `SELECT coalesce(level, 'null') AS level, count(*) AS n FROM log_lines ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} GROUP BY coalesce(level, 'null')`,
      ).all(...args) as { level: string; n: number }[];
      for (const r of rows) {
        out.byLevel[r.level] = r.n;
        out.total += r.n;
      }
    } catch (err: any) {
      this.warnOnce(`log volume query failed: ${err?.message || err}`);
    }
    return out;
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

  // Resource samples (M105) ride the batched flush queue like log lines —
  // sampling must move neither the write path nor the idle-CPU baseline
  // (both bench-measured in test/resource-sampling.test.mjs).
  recordResourceSample(app: string, rssBytes: number, cpuPct: number, ts = Date.now()): void {
    if (!this.db) return;
    this.queue.push({ kind: 'resource', row: { ts, app, rss: Math.round(rssBytes), cpu: cpuPct } });
  }

  queryResourceSamples(opts: { app?: string; since?: number; until?: number; limit?: number } = {}): ResourceSampleRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: any[] = [];
    if (opts.app) { wh.push('app = ?'); args.push(opts.app); }
    if (opts.since != null) { wh.push('ts >= ?'); args.push(opts.since); }
    if (opts.until != null) { wh.push('ts <= ?'); args.push(opts.until); }
    const sql = `SELECT app, ts, rss, cpu FROM resource_samples ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(opts.limit ?? 2000);
    try { return this.prepared(sql).all(...args) as ResourceSampleRow[]; } catch { return []; }
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
      const insLg = this.db.prepare('INSERT INTO log_lines (ts,app,line,level) VALUES (?,?,?,?)');
      const insRs = this.db.prepare('INSERT INTO resource_samples (ts,app,rss,cpu) VALUES (?,?,?,?)');
      const tx = this.db.transaction((ops: Op[]) => {
        for (const op of ops) {
          if (op.kind === 'event') insEv.run(op.row.ts, op.row.app, op.row.type, op.row.from_state, op.row.to_state, op.row.message);
          else if (op.kind === 'compile') insCm.run(op.row.ts, op.row.app, op.row.ms);
          else if (op.kind === 'bundle') insBd.run(op.row.ts, op.row.app, op.row.initialKB, op.row.lazyKB, op.row.fileCount);
          else if (op.kind === 'log') insLg.run(op.row.ts, op.row.app, op.row.line, op.row.level);
          else if (op.kind === 'resource') insRs.run(op.row.ts, op.row.app, op.row.rss, op.row.cpu);
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
    if (this.retentionRunning) return; // a slice is already mid-flight
    this.retentionRunning = true;
    try {
      // Fully sync FTS first: the AFTER DELETE cascade triggers assume every
      // row they remove was indexed.
      this.syncFts();
      const cutoff = Date.now() - this.cfg.retentionDays * 86400000;
      this.retentionSlice(cutoff);
    } catch (err: any) {
      this.warnOnce(`retention failed: ${err?.message || err}`);
      this.retentionRunning = false;
    }
  }

  /**
   * One TIME-SLICED retention pass (M147, v1.10).
   *
   * The pruning statements used to run unbounded, back to back. Measured on the
   * 1M-event corpus with two thirds of every table eligible, that blocked the
   * daemon's event loop for 28.8 SECONDS — during which the TUI froze, the HTTP
   * API stopped answering, and log ingest stalled. It is a real scenario, not a
   * synthetic one: it is what a user gets the first time they lower
   * retentionDays, or the first pass after a long-dormant install.
   *
   * Now each table is drained in bounded chunks, and the pass yields once it
   * has spent its slice, resuming on a timer. Semantics are unchanged — every
   * row older than the cutoff is still deleted, and the FTS shadows still
   * cascade through the AFTER DELETE triggers — it just no longer happens in
   * one uninterruptible bite.
   */
  private retentionSlice(cutoff: number): void {
    let more = false;
    try {
      more = this.retentionStep(cutoff);
    } catch (err: any) {
      this.warnOnce(`retention failed: ${err?.message || err}`);
      this.retentionTableIdx = 0;
      this.retentionRunning = false;
      return;
    }
    if (more) {
      // Out of slice with work remaining — hand the loop back and resume.
      const t = setTimeout(() => this.retentionSlice(cutoff), RETENTION_RESUME_MS);
      t.unref?.();
      return;
    }
    this.retentionTableIdx = 0;
    this.retentionRunning = false;
  }

  /**
   * Delete up to one slice's worth of expired rows. Returns true when work
   * remains. This is the only synchronous span retention ever occupies, so its
   * duration IS the event-loop stall the bench asserts on.
   */
  private retentionStep(cutoff: number, chunk = RETENTION_CHUNK): boolean {
    if (!this.db) return false;
    const deadline = performance.now() + RETENTION_SLICE_MS;
    while (this.retentionTableIdx < RETENTION_TABLES.length) {
      const spec = RETENTION_TABLES[this.retentionTableIdx];
      // Bounded delete by key. `DELETE ... LIMIT` requires a non-default SQLite
      // build, so the row set is narrowed with a subquery instead.
      const pred = spec.child ? spec.where : 'ts < ?';
      const info = this.prepared(
        `DELETE FROM ${spec.table} WHERE ${spec.key} IN (SELECT ${spec.key} FROM ${spec.table} WHERE ${pred} LIMIT ?)`,
      ).run(cutoff, chunk);
      if (info.changes < chunk) {
        this.retentionTableIdx++;      // this table is drained
        continue;
      }
      if (performance.now() >= deadline) return true;
    }
    return false;
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

  // `apps` (M177, v1.15 — additive): restrict rows to an app-name set, for
  // the ?workspace= filter on /api/history/trends. Applied in the same JS
  // bucketing pass the metric already does — no schema or query change.
  trends(opts: { app?: string; apps?: Set<string>; metric: 'compile' | 'bundle' | 'errors' | 'restarts' | 'rss' | 'cpu'; sinceMs: number; bucketMs: number }): { points: { t: number; v: number; v2?: number }[]; count: number } {
    if (!this.db) return { points: [], count: 0 };
    const sinceTs = Date.now() - opts.sinceMs;
    const bucket = opts.bucketMs;
    const inScope = (app: string | null | undefined): boolean => !opts.apps || (!!app && opts.apps.has(app));
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
      const rows = this.queryCompiles({ app: opts.app, since: sinceTs, limit: 10000 }).filter(r => inScope(r.app));
      count = rows.length;
      for (const r of rows) bumpAvg(r.ts, r.ms);
    } else if (opts.metric === 'bundle') {
      const rows = this.queryBundles({ app: opts.app, since: sinceTs, limit: 10000 }).filter(r => inScope(r.app));
      count = rows.length;
      for (const r of rows) {
        const b = Math.floor(r.ts / bucket) * bucket;
        const cur = buckets.get(b) ?? { sum: 0, n: 0, sum2: 0 };
        cur.sum += r.initialKB;
        cur.sum2 = (cur.sum2 ?? 0) + r.lazyKB;
        cur.n += 1;
        buckets.set(b, cur);
      }
    } else if (opts.metric === 'rss' || opts.metric === 'cpu') {
      // Resource series (M109, v1.3): bucket-averaged rss (MB) / cpu (%)
      // from resource_samples. Null readings are skipped, not zeroed.
      const rows = this.queryResourceSamples({ app: opts.app, since: sinceTs, limit: 10000 }).filter(r => inScope(r.app));
      for (const r of rows) {
        const raw = opts.metric === 'rss' ? r.rss : r.cpu;
        if (raw == null) continue;
        bumpAvg(r.ts, opts.metric === 'rss' ? raw / (1024 * 1024) : raw);
        count++;
      }
    } else if (opts.metric === 'errors') {
      const rows = this.queryEvents({ app: opts.app, since: sinceTs, limit: 10000 }).filter(r => inScope(r.app));
      for (const r of rows) {
        if (r.type === 'error-new' || r.type === 'error-recur') { bumpCount(r.ts); count++; }
      }
    } else {
      const rows = this.queryEvents({ app: opts.app, since: sinceTs, limit: 10000 }).filter(r => inScope(r.app));
      for (const r of rows) {
        if (r.type === 'status' && r.to_state === 'starting' && (r.from_state === 'error' || r.from_state === 'serving' || r.from_state === 'compiling')) {
          bumpCount(r.ts); count++;
        }
      }
    }
    const points: { t: number; v: number; v2?: number }[] = [];
    const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    for (const [t, v] of sorted) {
      if (opts.metric === 'compile' || opts.metric === 'bundle' || opts.metric === 'rss') {
        points.push({ t, v: Math.round(v.sum / v.n), ...(v.sum2 != null ? { v2: Math.round(v.sum2 / v.n) } : {}) });
      } else if (opts.metric === 'cpu') {
        points.push({ t, v: Math.round((v.sum / v.n) * 10) / 10 });
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

  // Per-session slice aggregates (M134, v1.8). Windowed COUNT/DISTINCT over the
  // indexed ts columns — the session-derivation counting primitive. Kept in the
  // DB layer (where all SQL lives) so sessions.ts stays pure composition and the
  // 100k-corpus derivation bench holds without materializing every row in JS.
  // Non-overlapping session windows mean daemon-down gap rows fall outside every
  // [since, until] and are naturally excluded.
  sliceCounts(since: number, until: number): { apps: string[]; errorCount: number; compileCount: number; testRunCount: number } {
    const empty = { apps: [] as string[], errorCount: 0, compileCount: 0, testRunCount: 0 };
    if (!this.db) return empty;
    try {
      const apps = (this.prepared('SELECT DISTINCT app FROM events WHERE ts >= ? AND ts <= ? AND app != ?').all(since, until, '__daemon__') as { app: string }[])
        .map(r => r.app).sort();
      const errorCount = (this.prepared("SELECT COUNT(*) AS c FROM events WHERE ts >= ? AND ts <= ? AND type IN ('error-new','error-recur')").get(since, until) as { c: number }).c;
      const compileCount = (this.prepared('SELECT COUNT(*) AS c FROM compile_times WHERE ts >= ? AND ts <= ?').get(since, until) as { c: number }).c;
      const testRunCount = (this.prepared('SELECT COUNT(*) AS c FROM test_runs WHERE ts >= ? AND ts <= ?').get(since, until) as { c: number }).c;
      return { apps, errorCount, compileCount, testRunCount };
    } catch {
      return empty;
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
    run: { app: string; ts?: number; runner: string | null; durationMs: number | null; total: number | null; passed: number | null; failed: number | null; skipped: number | null; exitCode: number | null; gitHead: string | null; covLinesPct?: number | null; covStmtsPct?: number | null; failedOnly?: boolean },
    failures: { suite: string; test: string; file?: string; line?: number; message: string; fingerprint: string; quarantined?: boolean }[],
  ): number | null {
    if (!this.db) return null;
    try {
      const insRun = this.prepared('INSERT INTO test_runs (ts,app,runner,durationMs,total,passed,failed,skipped,exitCode,gitHead,covLinesPct,covStmtsPct,failedOnly) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const insFail = this.prepared('INSERT INTO test_failures (runId,suite,test,file,line,message,fingerprint,quarantined) VALUES (?,?,?,?,?,?,?,?)');
      const tx = this.db.transaction(() => {
        const r = insRun.run(run.ts ?? Date.now(), run.app, run.runner, run.durationMs, run.total, run.passed, run.failed, run.skipped, run.exitCode, run.gitHead, run.covLinesPct ?? null, run.covStmtsPct ?? null, run.failedOnly ? 1 : null);
        const runId = Number(r.lastInsertRowid);
        for (const f of failures) {
          insFail.run(runId, f.suite, f.test, f.file ?? null, f.line ?? null, f.message, f.fingerprint, f.quarantined ? 1 : null);
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

  // Backpressure probe (M147, v1.10). The flush queue is drained on a timer, so
  // a storm that outruns the drain shows up as a growing queue before it shows
  // up as latency. The write-path bench asserts the queue drains to zero after
  // a storm — read-only, never used by production code.
  _queueDepthForTest(): number {
    return this.queue.length;
  }

  /**
   * Drain retention to completion, synchronously, and report each slice's
   * duration.
   *
   * Production retention yields between slices (M147), but a test that pruned
   * "some of it, eventually" would be untestable — so this drives the same
   * retentionStep loop straight through. The returned slice timings are what
   * the write-path bench asserts on: the total is interesting, but the MAX
   * SLICE is the number that decides whether the daemon stalls.
   */
  _runRetentionForTest(chunk = RETENTION_CHUNK): { slices: number[]; totalMs: number } {
    const slices: number[] = [];
    const t0 = performance.now();
    if (!this.db || !(this.cfg.retentionDays > 0)) return { slices, totalMs: 0 };
    try {
      this.syncFts();
      const cutoff = Date.now() - this.cfg.retentionDays * 86400000;
      this.retentionTableIdx = 0;
      for (;;) {
        const s0 = performance.now();
        const more = this.retentionStep(cutoff, chunk);
        slices.push(performance.now() - s0);
        if (!more) break;
      }
    } catch (err: any) {
      this.warnOnce(`retention failed: ${err?.message || err}`);
    } finally {
      this.retentionTableIdx = 0;
      this.retentionRunning = false;
    }
    return { slices, totalMs: performance.now() - t0 };
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
      // Mark the clean shutdown LAST, after the flush and checkpoint above, so
      // the marker can only ever mean "everything reached disk". A secondary
      // handle ('skip') never writes it — the primary owner is still running,
      // and claiming a clean close on its behalf would skip the full check
      // after a real crash.
      if (this.verifyMode !== 'skip') {
        try { this.db.pragma(`user_version = ${CLEAN_SHUTDOWN_MARK}`); } catch {}
      }
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}
