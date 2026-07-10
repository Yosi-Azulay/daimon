import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// M77 — full-text search: FTS5 over events + log lines with deferred indexing,
// LIKE fallback on FTS failure, retention cascade, and the perf budgets
// (search < 300ms on a 100k corpus; insert-path overhead < 10%).

const require = createRequire(import.meta.url);
const { History, ftsQuery } = await import('../dist/history.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-fts-'));
const histCfg = p => ({ enabled: true, path: path.join(tmp, p), retentionDays: 7 });

test('ftsQuery: quotes user tokens so FTS5 operators cannot inject', () => {
  assert.equal(ftsQuery('foo bar'), '"foo" "bar"');
  assert.equal(ftsQuery('a"b'), '"a""b"');
  assert.equal(ftsQuery('NEAR AND OR NOT'), '"NEAR" "AND" "OR" "NOT"');
  assert.equal(ftsQuery('prefix*'), '"prefix"*');
  assert.equal(ftsQuery('  '), '');
});

test('seeded corpus: finds a known string in logs/errors/events with correct refs; filters work', () => {
  const h = new History(histCfg('seed.db'));
  assert.equal(h.ftsAvailable(), true, 'FTS available on a fresh DB');
  const now = Date.now();
  h.recordEvent({ ts: now - 1000, app: 'api', type: 'error-new', message: 'Error: ECONNREFUSED 127.0.0.1:5432 in db.ts' });
  h.recordEvent({ ts: now - 900, app: 'web', type: 'status', from: 'compiling', to: 'serving', message: 'ready in 1423ms unicorn-marker' });
  h.recordEvent({ ts: now - 50 * 3600_000, app: 'api', type: 'error-new', message: 'old ECONNREFUSED entry outside window' });
  h.recordLogLine('api', 'GET /health 200 3ms unicorn-marker', now - 800);
  h.recordLogLine('web', 'compiled client and server successfully', now - 700);
  h._flushForTest();

  // kind routing + refs
  const all = h.search({ q: 'unicorn-marker' });
  assert.equal(all.fallback, false);
  assert.equal(all.hits.length, 2);
  const logHit = all.hits.find(x => x.kind === 'logs');
  const evHit = all.hits.find(x => x.kind === 'events');
  assert.ok(logHit && /^log:\d+$/.test(logHit.ref), `log ref: ${logHit?.ref}`);
  assert.ok(evHit && /^event:\d+$/.test(evHit.ref), `event ref: ${evHit?.ref}`);
  assert.ok(logHit.snippet.includes('unicorn-marker'));

  // errors kind = issue-shaped events only
  const errs = h.search({ q: 'ECONNREFUSED', kind: 'errors' });
  assert.equal(errs.hits.length, 2);
  assert.ok(errs.hits.every(x => x.kind === 'errors'));

  // --app filter
  const apiOnly = h.search({ q: 'unicorn-marker', app: 'api' });
  assert.equal(apiOnly.hits.length, 1);
  assert.equal(apiOnly.hits[0].app, 'api');

  // --since filter drops the 50h-old row
  const recent = h.search({ q: 'ECONNREFUSED', since: now - 24 * 3600_000 });
  assert.equal(recent.hits.length, 1);

  // prefix search
  const pre = h.search({ q: 'unicor*' });
  assert.equal(pre.hits.length, 2);
  h.close();
});

test('FTS-creation failure degrades to LIKE fallback with a warning reason — daemon keeps working', () => {
  const dbPath = path.join(tmp, 'squat.db');
  // Squat a plain table on the FTS name: CREATE VIRTUAL ... IF NOT EXISTS
  // silently accepts it, so only the MATCH probe can detect the breakage.
  const Better = require('better-sqlite3');
  const raw = new Better(dbPath);
  raw.exec('CREATE TABLE events_fts (rowid INTEGER, message TEXT)');
  raw.close();

  const h = new History({ enabled: true, path: dbPath, retentionDays: 7 });
  assert.equal(h.ftsAvailable(), false);
  assert.match(h.ftsDegradedReason() ?? '', /./, 'degraded reason surfaced');
  const now = Date.now();
  h.recordEvent({ ts: now, app: 'api', type: 'error-new', message: 'fallback-needle in haystack' });
  h.recordLogLine('api', 'log line with fallback-needle too', now);
  h._flushForTest();
  const r = h.search({ q: 'fallback-needle' });
  assert.equal(r.fallback, true, 'LIKE fallback flagged');
  assert.equal(r.hits.length, 2, 'both kinds found via LIKE');
  // LIKE special chars must not act as wildcards
  const wild = h.search({ q: '%needle%' });
  assert.equal(wild.hits.length, 0, 'literal % is escaped');
  h.close();
});

test('retention pruning cascades into FTS (deleted rows stop matching)', () => {
  const h = new History({ enabled: true, path: path.join(tmp, 'retention.db'), retentionDays: 7 });
  const old = Date.now() - 30 * 86400_000;
  h.recordEvent({ ts: old, app: 'api', type: 'error-new', message: 'ancient-needle should vanish' });
  h.recordLogLine('api', 'ancient-needle in a log line', old);
  h.recordEvent({ ts: Date.now(), app: 'api', type: 'error-new', message: 'fresh-needle stays' });
  h._flushForTest();
  assert.equal(h.search({ q: 'ancient-needle' }).hits.length, 2, 'indexed before pruning');
  h._runRetentionForTest();
  assert.equal(h.search({ q: 'ancient-needle' }).hits.length, 0, 'pruned rows no longer match');
  assert.equal(h.search({ q: 'fresh-needle' }).hits.length, 1, 'fresh rows survive');
  h.close();
});

test('perf: search over a 100k-event corpus < 300ms; insert-path overhead from FTS < 10%', () => {
  // --- corpus + search budget ---
  const h = new History({ enabled: true, path: path.join(tmp, 'bench.db'), retentionDays: 30 });
  const base = Date.now() - 86400_000;
  for (let i = 0; i < 100_000; i++) {
    h.recordEvent({
      ts: base + i * 100,
      app: 'app' + (i % 20),
      type: i % 5 === 0 ? 'error-new' : 'status',
      message: `Error: Cannot resolve module './cmp${i % 500}' in src/pages/page${i % 300}.ts:${i % 90} ECONNREFUSED 127.0.0.1:${4200 + (i % 50)} #${i}`,
    });
    // Keep the queue's requeue cap out of play.
    if (i % 20_000 === 19_999) h._flushForTest();
  }
  h._flushForTest();
  h.syncFts(); // one-time index build is not the query budget
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = h.search({ q: 'ECONNREFUSED', limit: 50 });
    best = Math.min(best, performance.now() - t0);
    assert.ok(r.hits.length > 0 && !r.fallback);
  }
  assert.ok(best < 300, `search took ${best.toFixed(1)}ms (budget 300ms)`);
  h.close();

  // --- insert-path overhead: FTS-enabled vs FTS-degraded history ---
  const squatPath = path.join(tmp, 'bench-nofts.db');
  const Better = require('better-sqlite3');
  const raw = new Better(squatPath);
  raw.exec('CREATE TABLE events_fts (rowid INTEGER, message TEXT)');
  raw.close();
  const withFts = new History({ enabled: true, path: path.join(tmp, 'bench-fts.db'), retentionDays: 30 });
  const noFts = new History({ enabled: true, path: squatPath, retentionDays: 30 });
  assert.equal(withFts.ftsAvailable(), true);
  assert.equal(noFts.ftsAvailable(), false);
  const writeN = (hist, n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      hist.recordEvent({ ts: base + i, app: 'a', type: 'status', message: 'msg line number ' + i });
    }
    hist._flushForTest();
    return performance.now() - t0;
  };
  writeN(withFts, 2000); writeN(noFts, 2000); // warmup
  let bestRatio = Infinity;
  for (let round = 0; round < 3; round++) {
    const tNo = writeN(noFts, 15_000);
    const tYes = writeN(withFts, 15_000);
    bestRatio = Math.min(bestRatio, tYes / tNo);
  }
  assert.ok(bestRatio < 1.10, `FTS insert-path overhead ×${bestRatio.toFixed(3)} (budget <1.10) — indexing must stay off the write path`);
  withFts.close();
  noFts.close();
});

test('cleanup tmp', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
