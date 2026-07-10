// Test seed helper used by the dashboard E2E drive. Pushes synthetic events
// straight into the daimon history db so every dashboard route has data to
// show: >=1 error, >=1 serving app, >=1 regression-detected, >=2 agents.
//
// Run from the dashboard subpackage:
//   node --import tsx e2e/seed.ts
// or via the e2e:seed npm script.

import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

const dbPath = process.env.DAIMON_HISTORY_DB || path.join(os.homedir(), '.daimon', 'history.db');
if (!existsSync(dbPath)) {
  console.error(`[seed] history db not found at ${dbPath}. Start daimon at least once before seeding.`);
  process.exit(1);
}

const Database = requireCjs('better-sqlite3');
const db = new Database(dbPath);

const now = Date.now();
const APPS = ['web-admin', 'web-portal', 'api-gateway'];

// Events table has columns matching dist/history.js: id ts app type from_state to_state message
const insert = db.prepare(
  'INSERT INTO events (ts, app, type, from_state, to_state, message) VALUES (?, ?, ?, ?, ?, ?)'
);

// 1) serving app with health probe ok
insert.run(now - 60_000, 'web-admin', 'status', 'starting', 'serving', null);
insert.run(now - 55_000, 'web-admin', 'health', null, 'healthy', null);

// 2) error app
insert.run(now - 30_000, 'api-gateway', 'status', 'serving', 'error', null);
insert.run(now - 29_000, 'api-gateway', 'error-new', null, null, JSON.stringify({
  file: 'src/index.ts', line: 42, code: 'TS2304', message: "Cannot find name 'foo'",
}));

// 3) regression-detected
insert.run(now - 10_000, 'web-portal', 'regression-detected', null, null, JSON.stringify({
  kind: 'compile', factor: 2.4, baseline: 1200, current: 2880, suspectCommit: 'a1b2c3d:fix shimmer animation',
}));
insert.run(now - 5_000, 'api-gateway', 'regression-detected', null, null, JSON.stringify({
  kind: 'error-flap', factor: 5.1, baseline: 1.2, current: 12, fingerprint: 'TS2304:Cannot find name', suspectCommit: null,
}));

// 4) v0.12: test-run history (Tests page drive) -- two runs at the same head
// with one recurring failure plus one run-specific failure, so drill-down,
// run-diff and flaky lookups all have data. The Tests page attaches runs to
// the daemon's REAL apps, so the target names must exist in the driven
// workspace -- override with DAIMON_SEED_APPS=app1,app2.
const seedApps = (process.env.DAIMON_SEED_APPS || 'web-admin,api-gateway').split(',').map(s => s.trim()).filter(Boolean);
const [tApp1, tApp2 = seedApps[0]] = seedApps;
const insertRun = db.prepare(
  'INSERT INTO test_runs (ts, app, runner, durationMs, total, passed, failed, skipped, exitCode, gitHead) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const insertFail = db.prepare(
  'INSERT INTO test_failures (runId, suite, test, file, line, message, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const run1 = insertRun.run(now - 120_000, tApp1, 'vitest-jest', 2140, 24, 22, 2, 0, 1, 'a1b2c3d').lastInsertRowid;
insertFail.run(run1, 'auth', 'refreshes token', 'src/auth/session.spec.ts', 44, 'expected 401 to be 200', 'src/auth/session.spec.ts:44');
insertFail.run(run1, 'cart', 'computes totals', 'src/cart/cart.spec.ts', 12, 'expected 99 to be 100', 'src/cart/cart.spec.ts:12');
const run2 = insertRun.run(now - 45_000, tApp1, 'vitest-jest', 1980, 24, 23, 1, 0, 1, 'a1b2c3d').lastInsertRowid;
insertFail.run(run2, 'auth', 'refreshes token', 'src/auth/session.spec.ts', 44, 'expected 401 to be 200', 'src/auth/session.spec.ts:44');
insertRun.run(now - 20_000, tApp2, 'pytest', 730, 12, 12, 0, 0, 0, 'a1b2c3d');

// 5) v0.12: a crash report (why/detail drive)
db.prepare(
  'INSERT INTO crashes (ts, app, exitCode, signal, uptimeMs, lastLines, gitHead) VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(now - 90_000, tApp2, 1, null, 340_000, 'TypeError: Cannot read properties of undefined\n    at gateway (src/index.ts:42:7)\n[nodemon] app crashed', 'a1b2c3d');

// 6) v0.12: searchable log lines (palette search drive)
const insertLog = db.prepare('INSERT INTO log_lines (ts, app, line) VALUES (?, ?, ?)');
insertLog.run(now - 70_000, tApp1, 'GET /api/users 200 12ms');
insertLog.run(now - 65_000, tApp2, 'ECONNREFUSED 127.0.0.1:5432 retrying in 2s');
insertLog.run(now - 62_000, tApp2, 'connected to postgres after 3 retries');

console.log(`[seed] inserted events, test runs, a crash, and log lines into ${dbPath}`);
console.log('[seed] note: agent records are in-memory; have >=2 agents hit the daemon (e.g., daimon list from two terminals) before running the drive.');

db.close();
