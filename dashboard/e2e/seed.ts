// Test seed helper used by the dashboard E2E drive. Pushes synthetic events
// straight into the daimon history db so every dashboard route has data to
// show: ≥1 error, ≥1 serving app, ≥1 regression-detected, ≥2 agents.
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

console.log(`[seed] inserted 6 events into ${dbPath}`);
console.log('[seed] note: agent records are in-memory; have ≥2 agents hit the daemon (e.g., daimon list from two terminals) before running the drive.');

db.close();
