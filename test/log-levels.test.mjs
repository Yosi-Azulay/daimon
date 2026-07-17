import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// M99 — log-level classification: registry-declared patterns (first match
// wins) chained to the conservative generic heuristic, fail-soft at every
// layer, additive nullable `level` column, and the write-path bench
// (classification must not regress the log-ingest budget).

const require = createRequire(import.meta.url);
const { classifyLogLine, compileLogLevelPatterns, compiledPatternsFor, makeClassifier } = await import('../dist/logLevels.js');
const { allProfiles, validateCustomProfiles, LOG_LEVELS } = await import('../dist/frameworks.js');
const { History } = await import('../dist/history.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-loglevel-'));
const histCfg = p => ({ enabled: true, path: path.join(tmp, p), retentionDays: 7 });

// ---------------------------------------------------------------------------
// Generic fallback heuristic
// ---------------------------------------------------------------------------

test('generic heuristic: conservative error/warn/info near line start', () => {
  assert.equal(classifyLogLine('Error: connect ECONNREFUSED 127.0.0.1:5432'), 'error');
  assert.equal(classifyLogLine('error TS2304: Cannot find name'), 'error');
  assert.equal(classifyLogLine('[warn] circular dependency detected'), 'warn');
  assert.equal(classifyLogLine('Warning: React does not recognize the prop'), 'warn');
  assert.equal(classifyLogLine('INFO  Accepting connections'), 'info');
  // No level token at all -> null, never guessed.
  assert.equal(classifyLogLine('compiled client and server successfully'), null);
  assert.equal(classifyLogLine('GET /health 200 3ms'), null);
  // Zero/no-count summary lines are NOT errors.
  assert.equal(classifyLogLine('webpack compiled with 0 errors'), null);
  assert.equal(classifyLogLine('Found 0 errors. Watching for file changes.'), null);
  assert.equal(classifyLogLine('build finished, no warnings'), null);
  // A "warnings" count that is non-zero still reads as warn.
  assert.equal(classifyLogLine('Compiled with 3 warnings'), 'warn');
  // Token too deep in the line -> null (heuristic is "near line start").
  assert.equal(classifyLogLine('a'.repeat(60) + ' error somewhere deep in the middle'), null);
  // Empty / falsy input is fail-soft.
  assert.equal(classifyLogLine(''), null);
});

test('generic heuristic strips ANSI before matching', () => {
  const esc = String.fromCharCode(27);
  assert.equal(classifyLogLine(`${esc}[31mERROR${esc}[0m something broke`), 'error');
});

// ---------------------------------------------------------------------------
// Registry patterns: first match wins, chained to the generic fallback
// ---------------------------------------------------------------------------

test('profile patterns win over the generic heuristic; first match wins', () => {
  const compiled = compileLogLevelPatterns([
    { pattern: '^\\s*NOTICE\\b', level: 'info' },
    // A row that deliberately contradicts the generic heuristic: this
    // framework prints "Error summary" as an info footer.
    { pattern: '^Error summary:', level: 'info' },
  ]);
  assert.equal(classifyLogLine('NOTICE  something framework-specific', compiled), 'info');
  assert.equal(classifyLogLine('Error summary: 2 files checked', compiled), 'info', 'profile row outranks the generic error token');
  // Unmatched by the profile rows -> generic heuristic still applies.
  assert.equal(classifyLogLine('Error: real failure', compiled), 'error');
  // Unmatched by both -> null.
  assert.equal(classifyLogLine('plain progress line', compiled), null);
});

test('vite acceptance line classifies error via registry patterns (not the fallback)', () => {
  const vite = allProfiles(undefined).find(p => p.id === 'vite');
  assert.ok(vite?.logLevelPatterns?.length, 'vite ships logLevelPatterns');
  const compiled = compiledPatternsFor(vite);
  const line = 'ERROR  Pre-transform error';
  assert.ok(compiled.some(p => p.rx.test(line)), 'a vite registry pattern matches the line');
  assert.equal(classifyLogLine(line, compiled), 'error');
});

test('profiles without documented conventions ship no patterns', () => {
  // Explicit non-participation (plan: no guessing): spring-boot/laravel/expo…
  // classify only via the generic heuristic.
  for (const id of ['spring-boot', 'laravel', 'expo', 'go-air', 'deno', 'bun', 'package-json']) {
    const row = allProfiles(undefined).find(p => p.id === id);
    assert.ok(row, `profile ${id} exists`);
    assert.equal(row.logLevelPatterns, undefined, `profile ${id} must not guess a log-level convention`);
  }
});

// ---------------------------------------------------------------------------
// Fail-soft guarantees
// ---------------------------------------------------------------------------

test('classifyLogLine is fail-soft: a throwing matcher yields null, never a throw', () => {
  const boobyTrapped = [{ rx: { test() { throw new Error('boom'); } }, level: 'error' }];
  assert.equal(classifyLogLine('anything', boobyTrapped), null);
});

test('compileLogLevelPatterns drops invalid rows with a warning and keeps valid ones', () => {
  const warnings = [];
  const compiled = compileLogLevelPatterns([
    { pattern: '^OK\\b', level: 'info' },
    { pattern: '(unclosed', level: 'error' },       // invalid regex
    { pattern: '^X', level: 'fatal' },              // unknown level
    { pattern: '', level: 'warn' },                 // empty pattern
    'not-an-object',
  ], m => warnings.push(m));
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].level, 'info');
  assert.equal(warnings.length, 4);
});

test('makeClassifier without a profile row falls back to the generic heuristic', () => {
  const classify = makeClassifier(undefined);
  assert.equal(classify('ERROR boom'), 'error');
  assert.equal(classify('all good here'), null);
});

// ---------------------------------------------------------------------------
// Custom config profiles: validated data, field-level softening
// ---------------------------------------------------------------------------

test('custom profile with valid logLevelPatterns keeps them; invalid field is ignored, profile survives', () => {
  const warnings = [];
  const warn = m => warnings.push(m);
  const good = validateCustomProfiles([{
    id: 'phoenix', command: 'mix phx.server', detect: { files: ['mix.exs'] },
    logLevelPatterns: [{ pattern: '^\\[error\\]', level: 'error' }, { pattern: '^\\[info\\]', level: 'info' }],
  }], warn);
  assert.equal(good.length, 1);
  assert.equal(good[0].logLevelPatterns.length, 2);

  const softened = validateCustomProfiles([{
    id: 'phoenix2', command: 'mix phx.server', detect: { files: ['mix.exs'] },
    logLevelPatterns: [{ pattern: '(unclosed', level: 'error' }],
  }], warn);
  assert.equal(softened.length, 1, 'a broken classification row must never cost the profile');
  assert.equal(softened[0].logLevelPatterns, undefined, 'invalid field is dropped');
  assert.ok(warnings.some(m => m.includes('logLevelPatterns')), 'validation warns about the dropped field');
});

// ---------------------------------------------------------------------------
// Storage: additive nullable level column
// ---------------------------------------------------------------------------

test('log lines store their level; unclassified rows store null; logVolume rolls up', () => {
  const h = new History(histCfg('levels.db'));
  const now = Date.now();
  h.recordLogLine('web', 'ERROR boom', now - 400, 'error');
  h.recordLogLine('web', 'WARN careful', now - 300, 'warn');
  h.recordLogLine('web', 'plain line', now - 200, null);
  h.recordLogLine('web', 'legacy call shape (no level argument)', now - 100);
  h._flushForTest();
  const vol = h.logVolume({ app: 'web' });
  assert.equal(vol.total, 4);
  assert.equal(vol.byLevel.error, 1);
  assert.equal(vol.byLevel.warn, 1);
  assert.equal(vol.byLevel['null'], 2);
  h.close();
});

test('v1.1-shaped DB (no level column) opens clean; old rows read back null; new writes carry levels', () => {
  const dbPath = path.join(tmp, 'v11.db');
  const Better = require('better-sqlite3');
  const raw = new Better(dbPath);
  raw.exec(`
    CREATE TABLE log_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      app TEXT NOT NULL,
      line TEXT NOT NULL
    );
  `);
  raw.prepare('INSERT INTO log_lines (ts,app,line) VALUES (?,?,?)').run(Date.now() - 1000, 'api', 'pre-migration line');
  raw.close();

  const h = new History(histCfg('v11.db'));
  h.recordLogLine('api', 'ERROR new-world line', Date.now(), 'error');
  h._flushForTest();
  const vol = h.logVolume({ app: 'api' });
  assert.equal(vol.total, 2);
  assert.equal(vol.byLevel['null'], 1, 'pre-migration row reads back level null');
  assert.equal(vol.byLevel.error, 1);
  h.close();

  // And the other direction: a v1.2 DB keeps working when a v1.1-era writer
  // INSERTs without the level column (columns are named in every INSERT).
  const reopened = new Better(dbPath);
  reopened.prepare('INSERT INTO log_lines (ts,app,line) VALUES (?,?,?)').run(Date.now(), 'api', 'v1.1-writer line');
  const n = reopened.prepare('SELECT count(*) AS n FROM log_lines').get().n;
  assert.equal(n, 3);
  reopened.close();
});

// ---------------------------------------------------------------------------
// Write-path bench (M99): classification must not regress the ingest budget.
// Contention-immune (M91 style): both sides of the ratio run interleaved on
// the same machine, so external load inflates numerator and denominator alike.
// ---------------------------------------------------------------------------

test('perf: ingest with classification stays within 1.35x of ingest without', () => {
  const vite = allProfiles(undefined).find(p => p.id === 'vite');
  const classify = makeClassifier(vite);
  const LINES = 20_000;
  const corpus = [];
  for (let i = 0; i < LINES; i++) {
    corpus.push(
      i % 7 === 0 ? `ERROR  Pre-transform error ${i}` :
      i % 5 === 0 ? `▲ [WARNING] chunk ${i} exceeds the recommended limit` :
      `12:34:${String(i % 60).padStart(2, '0')} PM [vite] hmr update /src/File${i}.tsx`,
    );
  }

  const runPlain = db => {
    const h = new History(histCfg(db));
    const t0 = performance.now();
    for (const line of corpus) h.recordLogLine('bench', line, Date.now(), null);
    h._flushForTest();
    const ms = performance.now() - t0;
    h.close();
    return ms;
  };
  const runClassified = db => {
    const h = new History(histCfg(db));
    const t0 = performance.now();
    for (const line of corpus) h.recordLogLine('bench', line, Date.now(), classify(line));
    h._flushForTest();
    const ms = performance.now() - t0;
    h.close();
    return ms;
  };

  // Interleave rounds so ambient load hits both sides; keep the best ratio.
  let bestRatio = Infinity;
  for (let round = 0; round < 5; round++) {
    const plain = runPlain(`bench-plain-${round}.db`);
    const classified = runClassified(`bench-classified-${round}.db`);
    bestRatio = Math.min(bestRatio, classified / plain);
  }
  assert.ok(bestRatio < 1.35, `classification overhead x${bestRatio.toFixed(3)} on the ingest path (budget <1.35)`);
});

test('LOG_LEVELS export is the closed level set', () => {
  assert.deepEqual([...LOG_LEVELS], ['error', 'warn', 'info', 'debug']);
});
