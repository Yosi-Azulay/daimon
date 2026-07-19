import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// M128 (v1.7) — coverage capture: history round-trip of the additive nullable
// coverage columns, and proof that a v1.6-shaped DB (no coverage columns) opens
// clean under v1.7 via the guarded ALTER.

const { History } = await import('../dist/history.js');
const require = createRequire(import.meta.url);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-cov-'));
}

test('recordTestRun round-trips coverage + failedOnly + quarantined', () => {
  const dir = tmpDir();
  const h = new History({ enabled: true, path: path.join(dir, 'history.db'), retentionDays: 30 });
  const runId = h.recordTestRun(
    { app: 'web', runner: 'vitest-jest', durationMs: 1000, total: 3, passed: 2, failed: 1, skipped: 0, exitCode: 1, gitHead: 'abc', covLinesPct: 90.32, covStmtsPct: 85.71, failedOnly: true },
    [{ suite: 'math', test: 'adds', file: 'm.test.ts', line: 1, message: 'x', fingerprint: 'm.test.ts:1', quarantined: true }],
  );
  const run = h.queryTestRuns({ app: 'web', limit: 1 })[0];
  assert.equal(run.covLinesPct, 90.32);
  assert.equal(run.covStmtsPct, 85.71);
  assert.equal(run.failedOnly, 1);
  const fails = h.queryTestFailures([runId]);
  assert.equal(fails[0].quarantined, 1);
  h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordTestRun with no coverage stores null (coverage is a normal absent state)', () => {
  const dir = tmpDir();
  const h = new History({ enabled: true, path: path.join(dir, 'history.db'), retentionDays: 30 });
  h.recordTestRun(
    { app: 'go', runner: 'go-test', durationMs: 10, total: 2, passed: 2, failed: 0, skipped: 0, exitCode: 0, gitHead: 'h' },
    [],
  );
  const run = h.queryTestRuns({ app: 'go', limit: 1 })[0];
  assert.equal(run.covLinesPct, null);
  assert.equal(run.covStmtsPct, null);
  assert.equal(run.failedOnly, null);
  h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('additive migration: a v1.6 DB (no coverage columns) opens clean; old rows read null', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'history.db');
  // Build a v1.6-shaped test_runs/test_failures directly — no cov/failedOnly/
  // quarantined columns — and insert a legacy row.
  const Database = require('better-sqlite3');
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, app TEXT NOT NULL,
      runner TEXT, durationMs INTEGER, total INTEGER, passed INTEGER, failed INTEGER,
      skipped INTEGER, exitCode INTEGER, gitHead TEXT
    );
    CREATE TABLE test_failures (
      runId INTEGER NOT NULL, suite TEXT, test TEXT, file TEXT, line INTEGER,
      message TEXT, fingerprint TEXT
    );
  `);
  raw.prepare('INSERT INTO test_runs (ts,app,runner,total,passed,failed,skipped,exitCode,gitHead) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(Date.now(), 'legacy', 'pytest', 5, 5, 0, 0, 0, 'old');
  raw.close();

  // Open under v1.7 — the guarded ALTER must add the columns without error.
  const h = new History({ enabled: true, path: dbPath, retentionDays: 30 });
  const run = h.queryTestRuns({ app: 'legacy', limit: 1 })[0];
  assert.ok(run, 'legacy row still readable');
  assert.equal(run.covLinesPct, null, 'old row reads coverage null');
  assert.equal(run.covStmtsPct, null);
  assert.equal(run.failedOnly, null);
  // And a fresh write with coverage now succeeds against the migrated table.
  h.recordTestRun(
    { app: 'legacy', runner: 'pytest', durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, exitCode: 0, gitHead: 'new', covLinesPct: 63 },
    [],
  );
  const rows = h.queryTestRuns({ app: 'legacy', limit: 5 });
  assert.ok(rows.some(r => r.covLinesPct === 63), 'post-migration coverage write lands');
  h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
