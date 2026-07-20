import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// M146 (v1.10) — open-time verification semantics.
//
// `PRAGMA integrity_check` used to run on EVERY History open. It is
// O(database size): 8.5s per open on the 1M-event corpus, paid by daemon cold
// start, by every CLI touch, and SIX times over by `daimon doctor` (which
// opened six independent handles), which in turn made the `why` route — a
// request path that calls doctor — take ~6s at 100k and ~51s at 1M.
//
// The fix keeps the invariant where it matters. Corruption comes from unclean
// shutdown and disk failure, so a DB that was NOT closed cleanly still gets the
// full check; only a DB daimon itself closed cleanly is trusted to a bounded
// structural probe. These tests pin that contract in both directions, because
// the failure mode of getting it wrong is silent data loss.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { History } = await import('../dist/history.js');

const CLEAN_SHUTDOWN_MARK = 0x0da1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-verify-'));
const dbPath = name => path.join(tmp, `${name}.db`);

function seed(p, n = 200) {
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  for (let i = 0; i < n; i++) h.recordEvent({ ts: Date.now() - i, app: 'x', type: 'status', message: 'line ' + i });
  h._flushForTest();
  return h;
}

function userVersion(p) {
  const db = new Database(p, { readonly: true });
  try { return db.pragma('user_version', { simple: true }); } finally { db.close(); }
}

/** Corrupt a page past the header — the recovery suite's fixture recipe. */
function corruptPage(p, offset = 4096) {
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
  const fd = fs.openSync(p, 'r+');
  const sz = fs.statSync(p).size;
  fs.writeSync(fd, Buffer.alloc(256, 0xff), 0, 256, Math.min(sz - 256, offset));
  fs.closeSync(fd);
}

test('a clean close marks the db; the mark is cleared again on reopen', () => {
  const p = dbPath('mark');
  seed(p).close();
  assert.equal(userVersion(p), CLEAN_SHUTDOWN_MARK, 'close() must record the clean-shutdown mark');

  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  assert.equal(userVersion(p), 0,
    're-arm on open: a crash from here on must land on the full check next time');
  h.close();
  assert.equal(userVersion(p), CLEAN_SHUTDOWN_MARK);
});

test('an UNCLEANLY closed db still gets the full integrity check — and archives when corrupt', () => {
  const p = dbPath('unclean');
  seed(p).close();
  // Simulate a crash: clear the clean mark, then corrupt a page.
  const db = new Database(p);
  db.pragma('user_version = 0');
  db.close();
  corruptPage(p);

  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  const archived = h.archivedCorruptDbPath();
  assert.ok(archived, 'a corrupt db that was not closed cleanly must still be archived');
  assert.ok(fs.existsSync(archived));
  assert.ok(h.quickCheck(), 'and the replacement db must be healthy');
  h.close();
});

test('corruption of a CLEANLY closed db is still caught by the bounded probe', () => {
  const p = dbPath('clean-corrupt');
  seed(p).close();
  assert.equal(userVersion(p), CLEAN_SHUTDOWN_MARK);
  // Leave the clean mark in place — this is the path that takes the cheap
  // probe — and corrupt the file underneath it.
  const fd = fs.openSync(p, 'r+');
  const sz = fs.statSync(p).size;
  fs.writeSync(fd, Buffer.alloc(256, 0xff), 0, 256, Math.min(sz - 256, 4096));
  fs.closeSync(fd);

  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  assert.ok(h.archivedCorruptDbPath(),
    'the structural probe must still catch a mangled page — a clean mark is not blind trust');
  h.close();
});

test("verify:'skip' never claims a clean close on the primary owner's behalf", () => {
  const p = dbPath('secondary');
  const primary = seed(p);           // primary handle still open and writing
  assert.equal(userVersion(p), 0, 'an open db is marked dirty');

  const secondary = new History({ enabled: true, path: p, retentionDays: 30 }, { verify: 'skip' });
  secondary.close();
  assert.equal(userVersion(p), 0,
    'a secondary handle closing must NOT mark clean — the primary is still running, and a '
    + 'false clean mark would skip the full check after a real crash');

  primary.close();
  assert.equal(userVersion(p), CLEAN_SHUTDOWN_MARK, 'the primary owner marks clean');
});

test('a db from an older daimon (no mark) opens fine and takes the full check', () => {
  const p = dbPath('legacy');
  seed(p).close();
  // v1.9 and earlier never wrote user_version; 0 is exactly what they leave.
  const db = new Database(p);
  db.pragma('user_version = 0');
  db.close();

  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  assert.equal(h.archivedCorruptDbPath(), null, 'a healthy legacy db is not archived');
  assert.equal(h.queryEvents({ app: 'x', limit: 5 }).length, 5, 'and its rows are readable');
  h.close();
});

test("verify:'skip' opens a healthy db without archiving it", () => {
  const p = dbPath('skip-healthy');
  seed(p).close();
  const h = new History({ enabled: true, path: p, retentionDays: 30 }, { verify: 'skip' });
  assert.equal(h.archivedCorruptDbPath(), null);
  assert.equal(h.queryEvents({ app: 'x', limit: 3 }).length, 3);
  h.close();
});

// ---------------------------------------------------------------------------
// Doctor: one handle per sweep, and an opt-out for request paths.
// ---------------------------------------------------------------------------

test('doctor opens history exactly once per sweep (structural gate)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'doctor.ts'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const opens = [...src.matchAll(/new\s+History\s*\(/g)].length;
  assert.equal(opens, 1,
    `doctor must construct History once and share the handle, found ${opens} — each open cost `
    + 'an O(db-size) verification (8.5s on the 1M corpus), so six opens meant ~51s per sweep');
});

test('historyHealth:false drops the O(db-size) health check, and true keeps it', async () => {
  const { runDoctor } = await import('../dist/doctor.js');
  const { loadConfig } = await import('../dist/config.js');
  const p = dbPath('doctor');
  seed(p).close();
  const cfg = loadConfig();
  cfg.history = { enabled: true, path: p, retentionDays: 30 };
  cfg.searchRoots = [];

  const withCheck = await runDoctor(cfg, [], { plugins: false });
  assert.ok(withCheck.checks.some(c => c.name === 'history db'),
    'the explicit `daimon doctor` must still report db health');

  const withoutCheck = await runDoctor(cfg, [], { plugins: false, historyHealth: false });
  assert.ok(!withoutCheck.checks.some(c => c.name === 'history db'),
    'a request path opts out — `why` discards this finding but used to pay quick_check for it');
});

test('the why route asks doctor to skip the history health check', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'server.ts'), 'utf8');
  const call = src.match(/runDoctor\(cfg, allApps, \{[^}]*\}\)/);
  assert.ok(call, 'expected the why route to call runDoctor');
  assert.match(call[0], /historyHealth:\s*false/,
    'why must not pay an O(database-size) check for a finding it filters out');
});

// ---------------------------------------------------------------------------
// Bounded inline FTS catch-up (M146) — search must never stall for a minute,
// and must never answer with a partially indexed corpus.
// ---------------------------------------------------------------------------

const NEEDLE = 'zzqx-backlog-needle';

/**
 * Rewind the FTS high-water marks to zero — the state daimon sees after an
 * index rebuild: a large backlog of rows it believes are unindexed.
 *
 * Only the marks are touched. Emptying the FTS5 tables directly would be more
 * literal but corrupts their shadow tables ("database disk image is
 * malformed"), and the behaviour under test — "backlog too large to index
 * inline, so answer from LIKE" — is driven entirely by this arithmetic.
 * The caller must have CLOSED its History first.
 */
function rewindFtsMarks(p) {
  const db = new Database(p);
  db.exec('UPDATE fts_state SET value = 0;');
  db.close();
}

function seedFiller(p, n, extra) {
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  for (let i = 0; i < n; i++) {
    h.recordEvent({ ts: Date.now() - i, app: 'a', type: 'status', message: `filler line ${i}` });
  }
  if (extra) h.recordEvent(extra);
  h._flushForTest();
  h.close();
}

test('a small FTS backlog is indexed inline — search uses the index', () => {
  const p = dbPath('backlog-small');
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  try {
    for (let i = 0; i < 50; i++) {
      h.recordEvent({ ts: Date.now() - i, app: 'a', type: 'status', message: `hello ${NEEDLE} ${i}` });
    }
    h._flushForTest();
    const r = h.search({ q: NEEDLE, limit: 50 });
    assert.equal(r.fallback, false, 'a trivially small backlog must be indexed inline and answered from FTS');
    assert.ok(r.hits.length > 0);
  } finally {
    h.close();
  }
});

test('a HUGE FTS backlog degrades to LIKE — complete results, never a 51s stall', () => {
  const p = dbPath('backlog-huge');
  // FTS_INLINE_SYNC_MAX is 10_000, and search()'s own flush() opportunistically
  // indexes one 5_000-row chunk before the backlog is measured — so the corpus
  // has to clear 15_000 for the inline sync to actually be refused.
  seedFiller(p, 25_000, { ts: Date.now(), app: 'a', type: 'error-new', message: `boom ${NEEDLE} tail` });
  rewindFtsMarks(p);
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  try {
    const t0 = performance.now();
    const r = h.search({ q: NEEDLE, limit: 50 });
    const ms = performance.now() - t0;

    assert.equal(r.fallback, true, 'a backlog too large to index inline must answer from the LIKE path');
    assert.ok(r.hits.length > 0,
      'and it must still FIND the row — degrading to LIKE trades speed, never correctness; '
      + 'a wrong-but-fast answer is worse than a slow one');
    assert.ok(ms < 5000, `search must not stall on a cold index, took ${ms.toFixed(0)}ms`);
  } finally {
    h.close();
  }
});

test('read-your-writes survives the degraded path — a just-written row is found', () => {
  const p = dbPath('backlog-ryw');
  seedFiller(p, 25_000);
  rewindFtsMarks(p);
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  try {
    // Written AFTER the index went cold, and never indexed.
    h.recordEvent({ ts: Date.now(), app: 'a', type: 'error-new', message: `fresh ${NEEDLE} write` });

    const r = h.search({ q: NEEDLE, limit: 50 });
    assert.ok(r.hits.length > 0,
      'search flushes then scans the base tables, so a row written moments ago is visible '
      + 'even while the index is far behind');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// Time-sliced retention (M147) — pruning must never hold the loop, and must
// still prune everything.
// ---------------------------------------------------------------------------

test('retention still deletes EVERY expired row — slicing changed timing, not semantics', () => {
  const p = dbPath('retention-complete');
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  try {
    const old = Date.now() - 90 * 86400_000;
    const fresh = Date.now();
    for (let i = 0; i < 12_000; i++) {
      h.recordEvent({ ts: old + i, app: 'a', type: 'status', message: `ancient ${i}` });
      h.recordLogLine('a', `ancient log ${i}`, old + i, 'info');
    }
    for (let i = 0; i < 100; i++) {
      h.recordEvent({ ts: fresh - i, app: 'a', type: 'status', message: `recent ${i}` });
    }
    h._flushForTest();

    const { slices } = h._runRetentionForTest();
    assert.ok(slices.length >= 1, 'retention must report at least one slice');

    const survivors = h.queryEvents({ app: 'a', limit: 20_000 });
    assert.ok(survivors.length > 0, 'fresh rows survive');
    assert.ok(survivors.every(e => e.ts >= Date.now() - 31 * 86400_000),
      'no row older than the cutoff may survive a completed retention pass');
    assert.ok(!survivors.some(e => (e.message || '').startsWith('ancient')),
      'every expired row is gone — a sliced prune still finishes the job');
  } finally {
    h.close();
  }
});

test('retention yields: a large prune is many bounded slices, not one long block', () => {
  const p = dbPath('retention-sliced');
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  try {
    const old = Date.now() - 90 * 86400_000;
    // Comfortably more than one chunk (5_000) so slicing must engage.
    for (let i = 0; i < 26_000; i++) {
      h.recordEvent({ ts: old + i, app: 'a', type: 'status', message: `old ${i}` });
    }
    h._flushForTest();
    // A deliberately tiny chunk forces many slices regardless of machine speed,
    // so this asserts the MECHANISM rather than a wall-clock number.
    const { slices } = h._runRetentionForTest(1_000);
    assert.ok(slices.length > 1,
      `a prune larger than one chunk must yield between slices, got ${slices.length}`);
    assert.equal(h.queryEvents({ app: 'a', limit: 100 }).length, 0, 'and it still drains fully');
  } finally {
    h.close();
  }
});

test('retention prunes child rows before their parents — no orphaned test failures', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'history.ts'), 'utf8');
  const block = src.slice(src.indexOf('const RETENTION_TABLES'));
  const failuresAt = block.indexOf("table: 'test_failures'");
  const runsAt = block.indexOf("table: 'test_runs'");
  assert.ok(failuresAt > 0 && runsAt > 0, 'both tables must be in the prune order');
  assert.ok(failuresAt < runsAt,
    'test_failures must be pruned before test_runs — the reverse orphans failure rows '
    + 'if a sliced pass is interrupted between the two');
});

test('cleanup tmp', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
