import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// M179 + M180 (v1.16 "Recall") — the query syntax and the unified scope.
//
// The load-bearing property this file exists to prove is PARITY: the syntax
// compiles into WHERE clauses on real columns, so the SAME query returns the
// SAME rows on the FTS path and on the LIKE fallback. Everything else (unknown
// fields, time forms, facets) hangs off that.

const require = createRequire(import.meta.url);
const {
  parseSearchQuery, parseTimeBound, describeQuery, isFilterOnly, isEmptyQuery, impliesUnifiedScope,
  SEARCH_FIELDS, SEARCH_FIELD_NAMES, SEARCH_KINDS, SEARCH_LEVELS, LEVEL_EVENT_TYPES, LEVEL_LOG_VALUES,
} = await import('../dist/searchQuery.js');
const { History, errorEventTypes, facetsOf, ftsQueryFromTerms } = await import('../dist/history.js');
const { groupErrors, searchErrorGroups } = await import('../dist/errorGroups.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-sq-'));
const NOW = Date.UTC(2026, 6, 21, 12, 0, 0); // fixed clock — the parser is pure

// ---------------------------------------------------------------------------
// Parser (pure, no DB)

test('bare terms and quoted phrases split correctly; escapes survive', () => {
  const r = parseSearchQuery('chunk "failed to load" foo\\ bar baz*', NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.query.phrases, ['failed to load']);
  assert.deepEqual(r.query.terms, ['chunk', 'foo bar', 'baz*']);
  // A quoted single word is a phrase, not a term — it forces a literal match.
  assert.deepEqual(parseSearchQuery('"error"', NOW).query.phrases, ['error']);
  // An escaped quote is content, not a delimiter.
  assert.deepEqual(parseSearchQuery('a\\"b', NOW).query.terms, ['a"b']);
  // An unterminated quote takes the rest of the input as one phrase.
  assert.deepEqual(parseSearchQuery('"never closed', NOW).query.phrases, ['never closed']);
  assert.equal(parseSearchQuery('   ', NOW).query.terms.length, 0);
});

test('every field in the grammar parses, and the docs table covers exactly them', () => {
  const r = parseSearchQuery('app:web kind:logs level:error after:2026-07-01 before:2026-07-20 needle', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.query.app, 'web');
  assert.equal(r.query.kind, 'logs');
  assert.equal(r.query.level, 'error');
  assert.equal(r.query.after, Date.UTC(2026, 6, 1));
  assert.equal(r.query.before, Date.UTC(2026, 6, 20));
  assert.deepEqual(r.query.terms, ['needle']);
  // Quoted field values, and case-insensitive field names / enum values.
  const q2 = parseSearchQuery('APP:"my app" Kind:LOGS level:WARNING', NOW);
  assert.equal(q2.query.app, 'my app');
  assert.equal(q2.query.kind, 'logs');
  assert.equal(q2.query.level, 'warning');
  // The grammar table IS the source of truth for the field list.
  assert.deepEqual([...SEARCH_FIELD_NAMES], SEARCH_FIELDS.map(f => f.name));
  assert.deepEqual([...SEARCH_FIELD_NAMES], ['app', 'kind', 'level', 'before', 'after']);
  for (const f of SEARCH_FIELDS) {
    assert.ok(f.summary && f.example.startsWith(f.name + ':'), `${f.name} documents itself`);
  }
});

test('unknown field errors, naming the valid fields, and never becomes a term', () => {
  const r = parseSearchQuery('lvl:error boom', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown field 'lvl:' — did you mean 'level:'? valid fields: app, kind, level, before, after");
  assert.match(r.hint, /quote the token/); // the remedy (M90)
  // Quoting it makes it a literal search, exactly as the hint says.
  const quoted = parseSearchQuery('"lvl:error"', NOW);
  assert.equal(quoted.ok, true);
  assert.deepEqual(quoted.query.phrases, ['lvl:error']);
});

test('field values are validated: empty, bad enum, bad time — each names the fix', () => {
  const empty = parseSearchQuery('app:', NOW);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /needs a value/);
  assert.match(empty.hint, /app:web/);

  const kind = parseSearchQuery('kind:banana', NOW);
  assert.equal(kind.ok, false);
  assert.match(kind.error, /kind must be logs\|errors\|events\|tests\|error-groups/);

  const level = parseSearchQuery('level:fatal', NOW);
  assert.equal(level.ok, false);
  assert.match(level.error, /level must be error\|warning\|lint/);

  const when = parseSearchQuery('after:yesterday', NOW);
  assert.equal(when.ok, false);
  assert.equal(when.error, 'after:yesterday is not a time');
  assert.match(when.hint, /epoch ms/);
});

test('time bounds: date, datetime, duration and epoch ms all resolve; durations use the injected clock', () => {
  assert.equal(parseTimeBound('2026-07-01', NOW), Date.UTC(2026, 6, 1));
  assert.equal(parseTimeBound('2026-07-01T14:30', NOW), Date.UTC(2026, 6, 1, 14, 30));
  assert.equal(parseTimeBound('2026-07-01T14:30:00Z', NOW), Date.UTC(2026, 6, 1, 14, 30));
  assert.equal(parseTimeBound('24h', NOW), NOW - 86_400_000);
  assert.equal(parseTimeBound('30m', NOW), NOW - 1_800_000);
  assert.equal(parseTimeBound('2w', NOW), NOW - 14 * 86_400_000);
  assert.equal(parseTimeBound(String(NOW), NOW), NOW);
  assert.equal(parseTimeBound('not-a-time', NOW), null);
  // Pure: the same input twice gives the same answer.
  assert.equal(parseSearchQuery('after:24h', NOW).query.after, parseSearchQuery('after:24h', NOW).query.after);
});

test('level: families are a subset of the errors kind — the two can never disagree', () => {
  const all = errorEventTypes();
  for (const lvl of SEARCH_LEVELS) {
    for (const t of LEVEL_EVENT_TYPES[lvl]) {
      assert.ok(all.includes(t), `${t} (level:${lvl}) must be an ERROR_EVENT_TYPE`);
    }
  }
  // crash is deliberately excluded from every level family (no severity).
  assert.ok(all.includes('crash'));
  assert.ok(!Object.values(LEVEL_EVENT_TYPES).flat().includes('crash'));
});

test('helpers: filter-only detection, unified-kind implication, describeQuery echo', () => {
  assert.equal(isFilterOnly(parseSearchQuery('app:web level:error', NOW).query), true);
  assert.equal(isFilterOnly(parseSearchQuery('app:web boom', NOW).query), false);
  assert.equal(impliesUnifiedScope(parseSearchQuery('kind:tests', NOW).query), true);
  assert.equal(impliesUnifiedScope(parseSearchQuery('kind:logs', NOW).query), false);
  assert.match(describeQuery(parseSearchQuery('app:web "chunk failed"', NOW).query), /app=web/);
  assert.equal(describeQuery(parseSearchQuery('', NOW).query), '(no filters)');
  assert.deepEqual(SEARCH_KINDS, ['logs', 'errors', 'events', 'tests', 'error-groups']);
});

test('FTS token compilation: phrases become one quoted token, prefixes survive, 8-term cap holds', () => {
  assert.equal(ftsQueryFromTerms(['chunk failed', 'boom']), '"chunk failed" "boom"');
  assert.equal(ftsQueryFromTerms(['pre*']), '"pre"*');
  assert.equal(ftsQueryFromTerms(Array.from({ length: 12 }, (_, i) => 't' + i)).split(' ').length, 8);
});

test('ordinary text containing a colon stays a TERM — the v1.15 queries still work', () => {
  // THE BACK-COMPAT RULE. `word:` is everywhere in real search text, and every
  // one of these returned hits in v1.15. Erroring on them would break the
  // stable /api/search surface for the most common thing anyone pastes.
  for (const [q, expected] of [
    ['TypeError: cannot read', ['TypeError:', 'cannot', 'read']],
    ['http://localhost:4200', ['http://localhost:4200']],
    ['node:fs', ['node:fs']],
    ['errgroup:src/a.ts:4', ['errgroup:src/a.ts:4']],
  ]) {
    const r = parseSearchQuery(q, NOW);
    assert.equal(r.ok, true, `${q} must parse, not 400`);
    assert.deepEqual(r.query.terms, expected);
  }
  // …while a NEAR-MISS of a real field is a typo and still errors loudly, which
  // is what "never silently treated as a term" is actually protecting.
  for (const [q, near] of [['lvl:error', 'level'], ['ap:web', 'app'], ['kinds:logs', 'kind'], ['befor:24h', 'before']]) {
    const r = parseSearchQuery(q, NOW);
    assert.equal(r.ok, false, `${q} is a typo and must error`);
    assert.match(r.error, new RegExp(`did you mean '${near}:'`));
  }
});

test('Windows paths keep their separators, quoted or not (the dev box is Windows)', () => {
  // In JS source each `\\` below is ONE backslash reaching the parser.
  assert.deepEqual(parseSearchQuery('D:\\Synology\\SourceCode', NOW).query.terms, ['D:\\Synology\\SourceCode']);
  assert.deepEqual(parseSearchQuery('"D:\\Synology\\SourceCode"', NOW).query.phrases, ['D:\\Synology\\SourceCode']);
  // A backslash still escapes the three characters that need it: quote, space, backslash.
  assert.deepEqual(parseSearchQuery('a\\ b', NOW).query.terms, ['a b']);
  assert.deepEqual(parseSearchQuery('a\\"b', NOW).query.terms, ['a"b']);
  assert.deepEqual(parseSearchQuery('a\\\\b', NOW).query.terms, ['a\\b']);
});

test('a time outside the Date range is not a time — it used to crash the TUI on render', () => {
  for (const q of ['after:99999999999999999', 'after:99999999w', 'after:1751328000000000000']) {
    const r = parseSearchQuery(q, NOW);
    assert.equal(r.ok, false, `${q} must be rejected`);
    assert.match(r.error, /is not a time/);
  }
  // describeQuery runs on the TUI render path, so it must never throw even if
  // a bound reaches it some other way.
  assert.doesNotThrow(() => describeQuery({ terms: [], phrases: [], after: 1e17, raw: '' }));
});

test('a query that says nothing is detected, so search never dumps the newest rows', () => {
  for (const q of ['""', '"', '""""']) {
    const r = parseSearchQuery(q, NOW);
    assert.equal(r.ok, true);
    assert.equal(isEmptyQuery(r.query), true, `${q} must count as empty`);
  }
  assert.equal(isEmptyQuery(parseSearchQuery('app:web', NOW).query), false);
  assert.equal(isEmptyQuery(parseSearchQuery('boom', NOW).query), false);
});

// ---------------------------------------------------------------------------
// Compilation into history — the SAME assertions on both paths.

function seed(h, now) {
  h.recordEvent({ ts: now - 1000, app: 'web', type: 'error-new', message: 'zebra-marker chunk failed to load' });
  h.recordEvent({ ts: now - 900, app: 'api', type: 'error-new', message: 'zebra-marker connection refused' });
  h.recordEvent({ ts: now - 800, app: 'web', type: 'warning-new', message: 'zebra-marker deprecated option' });
  h.recordEvent({ ts: now - 700, app: 'web', type: 'status', message: 'zebra-marker ready in 900ms' });
  h.recordEvent({ ts: now - 40 * 86_400_000, app: 'web', type: 'error-new', message: 'zebra-marker ancient failure' });
  h.recordLogLine('web', 'zebra-marker ERROR chunk failed to load /main.js', now - 600, 'error');
  h.recordLogLine('web', 'zebra-marker INFO all good', now - 500, 'info');
  h.recordLogLine('api', 'zebra-marker unclassified line', now - 400, null);
  // The log column's own spelling is 'warn' (frameworks.ts LOG_LEVELS), NOT the
  // grammar's 'warning' — this row is the one that catches a missing mapping.
  h.recordLogLine('web', 'zebra-marker WARN deprecated api used', now - 550, 'warn');
  h.recordTestRun(
    { app: 'web', ts: now - 300, runner: 'vitest', durationMs: 1200, total: 10, passed: 9, failed: 1, skipped: 0, exitCode: 1, gitHead: null },
    [{ suite: 'zebra-marker suite', test: 'renders the chunk', file: 'a.spec.ts', message: 'expected true', fingerprint: 'fp1' }],
  );
  h._flushForTest();
}

// A DB whose FTS name is squatted by a plain table degrades to the column path
// (the M77 recipe) — the same corpus, the same queries, the other engine.
function squattedDb(name) {
  const p = path.join(tmp, name);
  const Better = require('better-sqlite3');
  const raw = new Better(p);
  raw.exec('CREATE TABLE events_fts (rowid INTEGER, message TEXT)');
  raw.close();
  return p;
}

const now = Date.now();
const ftsHist = new History({ enabled: true, path: path.join(tmp, 'fts.db'), retentionDays: 90 });
const likeHist = new History({ enabled: true, path: squattedDb('like.db'), retentionDays: 90 });
seed(ftsHist, now);
seed(likeHist, now);
assert.equal(ftsHist.ftsAvailable(), true);
assert.equal(likeHist.ftsAvailable(), false);

const run = (h, q, extra = {}) => {
  const parsed = parseSearchQuery(q);
  assert.equal(parsed.ok, true, `parse ${q}`);
  return h.search({ q, query: parsed.query, limit: 100, ...extra });
};
const refs = r => r.hits.map(x => x.ref).sort();

const PARITY_QUERIES = [
  'zebra-marker',
  'app:web zebra-marker',
  'app:api zebra-marker',
  'level:error zebra-marker',
  'level:warning zebra-marker',
  'kind:logs zebra-marker',
  'kind:errors zebra-marker',
  'kind:events zebra-marker',
  `after:${now - 2000} zebra-marker`,
  `before:${now - 850} zebra-marker`,
  'app:web level:error zebra-marker',
  'app:web',
  'level:error',
];

test('parity: every syntax query returns the SAME rows on the FTS path and the LIKE path', () => {
  for (const q of PARITY_QUERIES) {
    const a = run(ftsHist, q);
    const b = run(likeHist, q);
    assert.deepEqual(refs(a), refs(b), `paths disagree for: ${q}`);
    assert.ok(a.hits.length > 0, `${q} matched nothing — the fixture would prove nothing`);
  }
});

test('filters narrow to exactly the seeded rows', () => {
  for (const h of [ftsHist, likeHist]) {
    const appOnly = run(h, 'app:api zebra-marker');
    assert.ok(appOnly.hits.every(x => x.app === 'api'), 'app: filter');

    // level: spans BOTH stores — error events and the v1.2 log level column.
    const err = run(h, 'level:error zebra-marker');
    assert.ok(err.hits.some(x => x.kind === 'errors'), 'error events matched');
    assert.ok(err.hits.some(x => x.kind === 'logs'), 'error log lines matched');
    // …and the unclassified log line is excluded by design.
    assert.ok(!err.hits.some(x => x.snippet.includes('unclassified')), 'null-level lines excluded');
    assert.ok(!err.hits.some(x => x.snippet.includes('deprecated')), 'warnings excluded from level:error');

    // THE TWO VOCABULARIES. `level:warning` must reach a log line the
    // classifier stored as 'warn' — comparing the grammar's word to the column
    // directly made this structurally impossible, and no fixture noticed
    // because none seeded a warn line.
    const warn = run(h, 'level:warning zebra-marker');
    assert.ok(warn.hits.some(x => x.kind === 'errors'), 'warning events matched');
    assert.ok(warn.hits.some(x => x.kind === 'logs' && x.snippet.includes('deprecated api')),
      'a log line stored as level=warn must match level:warning');
    // lint is an issue level with no log-level counterpart: events only, and
    // never a fabricated log match.
    const lint = run(h, 'level:lint');
    assert.ok(!lint.hits.some(x => x.kind === 'logs'), 'level:lint must never match a log line');

    // Time bounds, including the 40-day-old row that only `before:` reaches.
    const recent = run(h, `after:${now - 2000} zebra-marker`);
    assert.ok(!recent.hits.some(x => x.snippet.includes('ancient')));
    const old = run(h, `before:${now - 86_400_000} zebra-marker`);
    assert.equal(old.hits.length, 1);
    assert.ok(old.hits[0].snippet.includes('ancient'));

    // A phrase is contiguous; the same words unquoted are an AND of terms.
    assert.ok(run(h, '"chunk failed"').hits.length > 0);
    assert.equal(run(h, '"failed chunk"').hits.length, 0, 'phrase order matters');
    assert.ok(run(h, 'failed chunk').hits.length > 0, 'bare terms AND, order-free');

    // Filter-only: no text at all, answered by column predicates.
    const filterOnly = run(h, 'app:api');
    assert.ok(filterOnly.hits.length > 0 && filterOnly.hits.every(x => x.app === 'api'));
  }
});

test('truncation order is per-engine, and each path returns a subset of the same match set', () => {
  // The FTS branch streams `events_fts.rowid DESC` (the M146 optimisation that
  // lets it stop at LIMIT); the column path orders `ts DESC`. Those agree while
  // everything matches under the limit — the parity suite above runs there —
  // but with ingest out of ts order they can pick DIFFERENT rows once the
  // result is truncated. That is a documented ordering caveat, not a
  // correctness one: both paths draw from the same match set.
  const full = new Set(refs(run(ftsHist, 'zebra-marker')));
  for (const h of [ftsHist, likeHist]) {
    const cut = run(h, 'zebra-marker', { limit: 2 });
    assert.ok(cut.hits.length <= 2 * 2, 'each store applies the limit');
    for (const r of refs(cut)) assert.ok(full.has(r), `${r} is not in the full match set`);
  }
});

test('a v1.15-style call is unchanged: same body keys, no facets, bare-term behaviour identical', () => {
  for (const h of [ftsHist, likeHist]) {
    const legacy = h.search({ q: 'zebra-marker', limit: 100 });
    assert.deepEqual(Object.keys(legacy).sort(), ['fallback', 'hits']);
    assert.equal('facets' in legacy, false, 'facets must not appear without the unified scope');
    // No test-run hits leak into a pre-v1.16 call.
    assert.ok(!legacy.hits.some(x => x.kind === 'tests' || x.kind === 'error-groups'));
    // Same rows as the parsed form of the same bare query.
    assert.deepEqual(refs(legacy), refs(run(h, 'zebra-marker')));
    // The legacy kind/app/since params still work on their own.
    const viaParams = h.search({ q: 'zebra-marker', app: 'api', limit: 100 });
    assert.ok(viaParams.hits.length > 0 && viaParams.hits.every(x => x.app === 'api'));
  }
});

test('unified scope adds test-run hits with working refs, on both paths', () => {
  for (const h of [ftsHist, likeHist]) {
    const all = h.search({ q: 'zebra-marker', query: parseSearchQuery('zebra-marker').query, scope: 'all', limit: 100 });
    const t = all.hits.filter(x => x.kind === 'tests');
    assert.equal(t.length, 1, 'the seeded run matched by its failure suite');
    assert.match(t[0].ref, /^test:\d+$/);
    assert.match(t[0].snippet, /vitest · 9\/10 passed, 1 failed — zebra-marker suite > renders the chunk/);
    assert.ok(all.facets.tests === 1 && all.facets.logs > 0, 'facets count the response');

    // kind:tests alone implies the unified scope and returns only test hits.
    const only = h.search({ q: 'kind:tests zebra-marker', query: parseSearchQuery('kind:tests zebra-marker').query, limit: 100 });
    assert.ok(only.hits.length === 1 && only.hits[0].kind === 'tests');

    // A test run has no severity, so a level: query excludes test runs.
    const lvl = h.search({ q: 'level:error zebra-marker', query: parseSearchQuery('level:error zebra-marker').query, scope: 'all', limit: 100 });
    assert.ok(!lvl.hits.some(x => x.kind === 'tests'));
  }
});

test('error-group hits are a pure matcher over folded groups (no index, no new state)', () => {
  const groups = groupErrors([
    { app: 'web', errors: [{ message: 'TS2304: Cannot find name zebra', count: 3, firstSeen: now - 5000, lastSeen: now - 100, level: 'error', parsed: { file: 'src/a.ts', line: 4 } }] },
    { app: 'api', errors: [{ message: 'lint: unused var', count: 1, firstSeen: now - 5000, lastSeen: now - 200, level: 'lint' }] },
  ]);
  const hit = searchErrorGroups(groups, parseSearchQuery('zebra').query, 50);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'error-groups');
  assert.match(hit[0].ref, /^errgroup:src\/a\.ts:4$/);
  assert.match(hit[0].snippet, /^×3 TS2304/);
  // Filters apply to groups too.
  assert.equal(searchErrorGroups(groups, parseSearchQuery('app:api zebra').query, 50).length, 0);
  assert.equal(searchErrorGroups(groups, parseSearchQuery('level:lint unused').query, 50).length, 1);
  assert.equal(searchErrorGroups(groups, parseSearchQuery(`before:${now - 4000} unused`).query, 50).length, 1);
  assert.equal(searchErrorGroups(groups, parseSearchQuery(`after:${now - 50} unused`).query, 50).length, 0);
  // The file path is searchable, and the phrase must be contiguous.
  assert.equal(searchErrorGroups(groups, parseSearchQuery('"src/a.ts"').query, 50).length, 1);
  assert.equal(facetsOf(hit)['error-groups'], 1);
});

test('cleanup', () => {
  ftsHist.close();
  likeHist.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
