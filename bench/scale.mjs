#!/usr/bin/env node
// M146 (v1.10) — scale certification: the six read paths on a 1M-event corpus.
//
// The question this answers is the one daimon could not answer before v1.10:
// after six months of recording everything, does it still answer instantly?
//
// Budgets are DERIVED, never typed in. The flow is strictly:
//   1. `--write` measures each path on a quiet machine and records the result
//      as the scale baseline (bench/BASELINE-v1.10-scale.json).
//   2. Every later run derives budget = that baseline p95 x a class headroom
//      factor and checks BOTH axes (absolute + contention ratio).
// A red budget means investigate. Loosening it is not an available move.
//
// Usage:
//   node bench/scale.mjs --write        # record the scale baseline (quiet only)
//   node bench/scale.mjs --write-syntax # record ONLY the v1.16 query-syntax
//                                       # baseline (bench/BASELINE-v1.16-search.json)
//   node bench/scale.mjs                # gate against the committed baseline
//   node bench/scale.mjs --scale=100000 # smaller corpus (smoke)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  repoRoot, makeInstall, cleanupInstall, spawnDaemon,
  waitForDaemon, killDaemon, freePort, sleep,
} from './lib/daemonHarness.mjs';
import { ensureCorpus, NEEDLES, corpusPath } from './lib/corpus.mjs';
import { probeMachine, deriveBudget, checkBudget, sample, percentile, median, round, cpuReferenceMs } from './lib/machine.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => {
  const hit = argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};

const SCALE = Number(opt('scale') || 1_000_000);
export const SCALE_BASELINE_PATH = path.join(repoRoot, 'bench', 'BASELINE-v1.10-scale.json');
// M183 (v1.16): the query-syntax budgets get their OWN committed baseline.
// The v1.10 file is the historical record of that release's measurements and
// `--write` rewrites every entry in it — so recording the new paths there
// would silently re-baseline all eleven v1.10 numbers on today's machine.
// A second file keeps each release's measurements exactly as they were taken.
export const SYNTAX_BASELINE_PATH = path.join(repoRoot, 'bench', 'BASELINE-v1.16-search.json');
const SYNTAX_PREFIXES = ['search-syntax-', 'search-like-syntax-'];
const isSyntaxMetric = name => SYNTAX_PREFIXES.some(p => name.startsWith(p));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

// ---------------------------------------------------------------------------
// Budget classes, one justification per path. These are the ONLY policy inputs;
// the numbers themselves all come from measurement.
// ---------------------------------------------------------------------------
const CLASSES = {
  // A user types `daimon search` and waits. Both FTS and the LIKE fallback are
  // certified: FTS failure degrades to LIKE by design, so a LIKE that fell over
  // at scale would turn a degraded mode into an unusable one.
  'search-fts-common': ['interactive', 'the common-term search a user actually types'],
  'search-fts-rare': ['interactive', 'a rare term forces a deeper index walk before it can stop'],
  'search-like-common': ['query', 'the no-FTS degraded path on a term that exits early at LIMIT'],
  'search-like-rare': ['query', 'LIKE walking most of the corpus before it fills LIMIT'],
  'search-like-miss': ['query', 'the true LIKE worst case — no match, so no early exit at all'],
  // M183 (v1.16): the query syntax, certified at scale on BOTH paths. The
  // filters compile to WHERE clauses on real columns, so the question these
  // answer is whether a filtered query still rides the FTS fast path (rowid
  // DESC streaming, stop at LIMIT) instead of degenerating into a full scan.
  'search-syntax-filtered': ['interactive', 'app: + after: on top of a common term — the everyday filtered search'],
  'search-syntax-phrase': ['interactive', 'a quoted phrase is one FTS phrase token; more index work than a single term'],
  'search-syntax-level': ['interactive', 'level: spans both stores (event type families + the log level column)'],
  'search-syntax-unified': ['query', 'scope=all adds the test-run column query to the indexed stores'],
  'search-like-syntax-filtered': ['query', 'the same filtered query with no index — column predicates only'],
  'search-like-syntax-phrase': ['query', 'a phrase on the LIKE path is one contiguous substring scan'],
  'search-like-syntax-level': ['query', 'level: on the LIKE path — the WHERE clause is identical, the scan is not'],
  'search-like-syntax-unified': ['query', 'unified scope with no index: the widest degraded query daimon can be asked'],
  // Composition over many queries; nobody blocks on a keystroke.
  'report': ['batch', 'fans out over every section; per-section noise compounds'],
  'export': ['batch', 'the widest composition daimon has — report plus raw sections'],
  'sessions': ['batch', 'derived per-slice aggregates over the whole corpus'],
  // Per-app answers, reached from a card click or a CLI verb.
  'why': ['interactive', 'the "what just happened" answer — felt immediately'],
  'context': ['interactive', 'agent-facing pack; an agent is blocked while it builds'],
  // Deferred-FTS catch-up from a cold high-water mark.
  'fts-catchup': ['batch', 'one-time index build after a corpus arrives unindexed'],
};

// The v1.16 syntax queries, as a user would type them. Built from the corpus's
// own needles and its real time span so every one of them MATCHES — a budget
// certifying an empty result set certifies nothing (the M146 rule).
function syntaxQueries(meta) {
  const weekIn = meta.startMs + 83 * 86_400_000; // inside the corpus's newest week
  return [
    ['filtered', `app:web after:${weekIn} ${NEEDLES.common}`],
    ['phrase', '"Cannot resolve module"'],
    ['level', `level:error ${NEEDLES.common}`],
    ['unified', `app:web ${NEEDLES.common}`, { scope: 'all' }],
  ];
}

async function getJson(apiPort, pathname) {
  const r = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
    headers: { 'x-daimon-agent': 'daimon-bench-0001' },
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

// ---------------------------------------------------------------------------
// In-process measurements (search + FTS catch-up): these exercise the storage
// engine directly, with no HTTP framing in the number.
// ---------------------------------------------------------------------------
async function measureSearch(dbPath, meta) {
  const { History } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'history.js')).href);
  const { parseSearchQuery } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'searchQuery.js')).href);
  const out = {};
  const SYNTAX = syntaxQueries(meta);
  // One helper for both engines: the SAME query strings, the SAME parser, so a
  // difference in the numbers is a difference in the engine and nothing else.
  const measureSyntax = async (hist, prefix, runs) => {
    for (const [name, q, extra = {}] of SYNTAX) {
      const parsed = parseSearchQuery(q);
      if (!parsed.ok) throw new Error(`bench query does not parse: ${q} — ${parsed.error}`);
      let hits = 0;
      const s2 = await sample(() => {
        const r = hist.search({ q, query: parsed.query, limit: 50, ...extra });
        hits = r.hits.length;
      }, { runs, warmup: 2 });
      if (!hits) throw new Error(`${prefix}${name} found nothing — the budget would certify an empty query`);
      out[`${prefix}${name}`] = { ...s2, hits, method: `History.search({ q: '${q}'${extra.scope ? ", scope: 'all'" : ''} }) on the ${SCALE}-event corpus` };
    }
  };

  const h = new History({ enabled: true, path: dbPath, retentionDays: 3650 });
  try {
    if (!h.ftsAvailable()) throw new Error('corpus has no usable FTS index — reseed it');
    for (const [name, q] of [['search-fts-common', NEEDLES.common], ['search-fts-rare', NEEDLES.rare]]) {
      let hits = 0;
      const s = await sample(() => {
        const r = h.search({ q, limit: 50 });
        hits = r.hits.length;
        if (r.fallback) throw new Error(`${name} unexpectedly fell back to LIKE`);
      }, { runs: 20, warmup: 3 });
      out[name] = { ...s, hits, method: `History.search({ q: '${q}', limit: 50 }) on the ${SCALE}-event corpus, FTS path` };
      if (!hits) throw new Error(`${name} found nothing — the budget would be certifying an empty query`);
    }
    await measureSyntax(h, 'search-syntax-', 12);
  } finally {
    h.close();
  }

  // LIKE fallback: squat the FTS table on a COPY so the real corpus keeps its
  // index. Copying is the honest way — mutating the shared corpus would make
  // every later run measure the degraded path by accident.
  const likeDb = dbPath.replace(/\.db$/, '.like.db');
  fs.copyFileSync(dbPath, likeDb);
  const raw = new (await import('node:module')).createRequire(import.meta.url)('better-sqlite3')(likeDb);
  raw.exec('DROP TABLE IF EXISTS events_fts; DROP TABLE IF EXISTS log_fts;');
  raw.exec('CREATE TABLE events_fts (rowid INTEGER, message TEXT); CREATE TABLE log_fts (rowid INTEGER, line TEXT);');
  raw.close();
  const hl = new History({ enabled: true, path: likeDb, retentionDays: 3650 });
  try {
    if (hl.ftsAvailable()) throw new Error('expected the squatted copy to have no usable FTS');
    // THREE LIKE cases, because a single common-term measurement flatters the
    // path badly: LIKE scans newest-first and stops at LIMIT, so a term that
    // appears every 5th row returns in under a millisecond no matter how large
    // the corpus. The rare and absent terms are the ones that actually walk the
    // table, and the absent term is the true worst case (no early exit at all).
    for (const [name, q, mustHit] of [
      ['search-like-common', NEEDLES.common, true],
      ['search-like-rare', NEEDLES.rare, true],
      ['search-like-miss', 'qqzz-no-such-term-anywhere', false],
    ]) {
      let hits = 0;
      let sawFallback = false;
      const s = await sample(() => {
        const r = hl.search({ q, limit: 50 });
        hits = r.hits.length;
        sawFallback = r.fallback;
      }, { runs: 8, warmup: 2 });
      if (!sawFallback) throw new Error(`${name} did not actually take the LIKE fallback path`);
      if (mustHit && !hits) throw new Error(`${name} found nothing — it would be certifying an empty query`);
      if (!mustHit && hits) throw new Error(`${name} was supposed to match nothing, got ${hits}`);
      out[name] = { ...s, hits, method: `History.search({ q: '${q}' }) on an FTS-squatted copy — LIKE degraded path, ${SCALE}-event corpus` };
    }
    await measureSyntax(hl, 'search-like-syntax-', 6);
  } finally {
    hl.close();
    try { fs.rmSync(likeDb, { force: true }); } catch {}
  }
  return out;
}

// Deferred-FTS catch-up from a COLD high-water mark: the cost paid when a
// corpus exists but has never been indexed (a fresh upgrade, a rebuilt index).
// This is the number that decides whether sync must become chunked.
async function measureFtsCatchup(dbPath) {
  const { History } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'history.js')).href);
  const work = dbPath.replace(/\.db$/, '.catchup.db');
  fs.copyFileSync(dbPath, work);
  const require = (await import('node:module')).createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const raw = new Database(work);
  // Reset to a cold index: empty FTS tables, high-water marks back to zero.
  raw.exec("DELETE FROM events_fts; DELETE FROM log_fts; UPDATE fts_state SET value = 0;");
  raw.close();

  const h = new History({ enabled: true, path: work, retentionDays: 3650 });
  try {
    const refs = [cpuReferenceMs()];
    const t0 = performance.now();
    const indexed = h.syncFts();
    const ms = performance.now() - t0;
    refs.push(cpuReferenceMs());
    return {
      'fts-catchup': {
        p50: round(ms), p95: round(ms), samples: 1, indexed,
        cpuRefMedianMs: round(median(refs)),
        method: `History.syncFts() from a zeroed high-water mark over the ${SCALE}-event corpus (${indexed} rows)`,
      },
    };
  } finally {
    h.close();
    try { fs.rmSync(work, { force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// HTTP measurements: report / export / sessions / why / context are composed in
// the server's route layer, so the honest number is the one a client sees.
// ---------------------------------------------------------------------------
async function measureHttp(dbPath, corpusMeta) {
  const apiPort = await freePort();
  // Stub apps named after real corpus apps, so `why`/`context` answer about an
  // app the corpus actually has history for.
  const inst = makeInstall({ apiPort, dbPath, apps: ['web', 'api', 'admin'] });
  let handle = null;
  try {
    handle = spawnDaemon({ ...inst, apiPort });
    await waitForDaemon(apiPort);
    // Discovery is async after listen; wait until the stub apps are registered
    // or `why`/`context` would 404 and we would bench an error path.
    const app = await waitForApp(apiPort, inst.apps);
    const since = corpusMeta.startMs;

    const targets = {
      report: `/api/report?since=${since}`,
      export: `/api/export?since=${since}`,
      sessions: `/api/sessions`,
      why: `/api/why/${app}`,
      context: `/api/context/${app}`,
    };
    const out = {};
    for (const [name, pathname] of Object.entries(targets)) {
      const probe = await getJson(apiPort, pathname);
      if (probe.status !== 200) {
        out[name] = { note: `HTTP ${probe.status} on ${pathname} — not certified` };
        continue;
      }
      const s = await sample(async () => {
        const r = await getJson(apiPort, pathname);
        if (r.status !== 200) throw new Error(`${name}: HTTP ${r.status}`);
      }, { runs: 12, warmup: 2 });
      out[name] = { ...s, bytes: JSON.stringify(probe.body).length, method: `GET ${pathname} against a daemon on the ${SCALE}-event corpus` };
    }
    return out;
  } finally {
    await killDaemon(handle);
    cleanupInstall(inst);
  }
}

async function waitForApp(apiPort, wanted, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await getJson(apiPort, '/api/apps');
    const names = Array.isArray(r.body) ? r.body.map(a => a.name) : (r.body?.apps ?? []).map(a => a.name);
    const hit = wanted.find(w => names.includes(w));
    if (hit) return hit;
    await sleep(250);
  }
  throw new Error(`discovery never registered any of ${wanted.join('/')} — why/context would bench a 404`);
}

// ---------------------------------------------------------------------------

export async function runScale({ scale = SCALE } = {}) {
  const machineBefore = await probeMachine();
  const { dbPath, meta, seeded } = await ensureCorpus(scale, {
    onProgress: (k, i, n) => { if (i === n) log(`  seeded ${k}: ${n}`); },
  });
  if (seeded) log(`[bench] corpus built in ${meta.seedMs}ms (${Math.round(meta.dbBytes / 1048576)}MB)`);
  else log(`[bench] reusing cached corpus (${Math.round(meta.dbBytes / 1048576)}MB)`);

  const metrics = {};
  log('· search (FTS common / rare / v1.16 syntax, then the same on the LIKE path) …');
  Object.assign(metrics, await measureSearch(dbPath, meta));
  log('· fts catch-up from a cold high-water mark …');
  Object.assign(metrics, await measureFtsCatchup(dbPath));
  log('· report / export / sessions / why / context (HTTP) …');
  Object.assign(metrics, await measureHttp(dbPath, meta));

  // Settle before re-probing: this bench spawns daemons and deletes 600MB
  // files, and its OWN teardown would otherwise read as foreign load and
  // refuse a perfectly good baseline.
  await sleep(5000);
  const machineAfter = await probeMachine();
  return {
    schemaVersion: 1,
    release: 'v1.10.0',
    scale,
    corpus: { rows: meta.rows, dbBytes: meta.dbBytes, spanDays: meta.spanDays, seederVersion: meta.seederVersion },
    machineQuiet: machineBefore.quiet && machineAfter.quiet,
    machine: { before: machineBefore, after: machineAfter },
    metrics,
  };
}

/**
 * Gate a fresh run against the committed baselines.
 *
 * Two baseline sources, one rule: a metric is gated against whichever committed
 * file recorded it (v1.10 for the original eleven paths, v1.16 for the query
 * syntax). A metric with no baseline anywhere SKIPS — it is never silently
 * passed and never invented.
 */
export function gate(fresh, baseline, syntaxBaseline = null) {
  const rows = [];
  for (const [name, m] of Object.entries(fresh.metrics)) {
    const [klass, why] = CLASSES[name] ?? [];
    const base = baseline.metrics?.[name] ?? syntaxBaseline?.metrics?.[name];
    if (m.note) { rows.push({ name, status: 'skipped', detail: m.note }); continue; }
    if (!klass) { rows.push({ name, status: 'skipped', detail: 'no budget class declared' }); continue; }
    if (!base || base.p95 == null) { rows.push({ name, status: 'skipped', detail: 'no committed baseline entry' }); continue; }
    const budget = deriveBudget(base, klass, why);
    const verdict = checkBudget(budget, m.p95, m.cpuRefMedianMs);
    rows.push({ name, status: verdict.ok ? 'ok' : 'OVER BUDGET', detail: verdict.detail });
  }
  return rows;
}

function printMetrics(result) {
  log('');
  log(`scale ${result.scale.toLocaleString()} events · corpus ${Math.round(result.corpus.dbBytes / 1048576)}MB · machineQuiet ${result.machineQuiet}`);
  for (const [name, m] of Object.entries(result.metrics)) {
    if (m.note) { log(`  ${name.padEnd(20)} — ${m.note}`); continue; }
    const extra = m.hits != null ? ` (${m.hits} hits)` : m.indexed != null ? ` (${m.indexed} rows)` : m.bytes != null ? ` (${(m.bytes / 1024).toFixed(0)}KB)` : '';
    log(`  ${name.padEnd(20)} p50 ${m.p50}ms  p95 ${m.p95}ms${extra}`);
  }
  log('');
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
})();

if (invokedDirectly) {
  const result = await runScale();
  printMetrics(result);

  if (flag('write') || flag('write-syntax')) {
    if (!result.machineQuiet) {
      process.stderr.write('[bench] refusing to write a baseline: machine was not quiet — a contended baseline inflates every budget derived from it.\n');
      process.exit(2);
    }
    if (flag('write-syntax')) {
      // ONLY the v1.16 query-syntax paths (M183). The v1.10 numbers stay
      // exactly as they were measured for that release — `--write` rewrites
      // every entry, so recording the new paths there would silently
      // re-baseline eleven older budgets on today's machine.
      const metrics = Object.fromEntries(Object.entries(result.metrics).filter(([n]) => isSyntaxMetric(n)));
      const out = { ...result, release: 'v1.16.0', metrics };
      fs.writeFileSync(SYNTAX_BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
      log(`[bench] wrote ${path.relative(repoRoot, SYNTAX_BASELINE_PATH)} (${Object.keys(metrics).length} query-syntax paths)`);
    } else {
      fs.writeFileSync(SCALE_BASELINE_PATH, JSON.stringify(result, null, 2) + '\n');
      log(`[bench] wrote ${path.relative(repoRoot, SCALE_BASELINE_PATH)}`);
    }
  } else {
    if (!fs.existsSync(SCALE_BASELINE_PATH)) {
      process.stderr.write('[bench] no scale baseline committed yet — run with --write on a quiet machine first.\n');
      process.exit(2);
    }
    const syntaxBase = fs.existsSync(SYNTAX_BASELINE_PATH)
      ? JSON.parse(fs.readFileSync(SYNTAX_BASELINE_PATH, 'utf8'))
      : null;
    const rows = gate(result, JSON.parse(fs.readFileSync(SCALE_BASELINE_PATH, 'utf8')), syntaxBase);
    let failed = 0;
    for (const r of rows) {
      if (r.status === 'OVER BUDGET') failed++;
      log(`  ${r.status === 'ok' ? 'PASS' : r.status === 'skipped' ? 'SKIP' : 'FAIL'}  ${r.name.padEnd(20)} ${r.detail}`);
    }
    log('');
    if (failed) {
      process.stderr.write(`[bench] ${failed} budget(s) over. Investigate — budgets are never loosened to pass.\n`);
      process.exit(1);
    }
    log('[bench] all scale budgets green.');
  }
}
