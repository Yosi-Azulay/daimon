import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M145 (v1.10) — the bench harness is itself gated by the normal suite.
//
// The harness decides every performance budget in the release, so a silent bug
// in it would silently certify the wrong numbers. What is tested here is the
// PURE, fast part: the budget-derivation algebra, the contention second axis,
// the corpus determinism contract, and the shape/honesty of the committed
// baseline file. The expensive parts (live daemons, the 1M corpus) stay in
// `npm run bench` — this file must not slow the suite down.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  HEADROOM, CONTENTION_HEADROOM, deriveBudget, checkBudget,
  percentile, median, relativeMad, probeMachine, QUIET_MAD_CEILING, QUIET_BUSY_CEILING,
} = await import('../bench/lib/machine.mjs');

// ---------------------------------------------------------------------------
// Budget derivation algebra
// ---------------------------------------------------------------------------

test('deriveBudget: budget is baseline p95 x the class headroom — never a typed-in absolute', () => {
  const baseline = { p95: 200, cpuRefMedianMs: 20 };
  const b = deriveBudget(baseline, 'interactive', 'test');
  assert.equal(b.absMs, 200 * HEADROOM.interactive);
  assert.equal(b.factor, HEADROOM.interactive);
  assert.equal(b.baselineP95, 200);
});

test('deriveBudget: the contention ratio ceiling is derived from the same baseline, not chosen', () => {
  const b = deriveBudget({ p95: 200, cpuRefMedianMs: 20 }, 'query', 'test');
  // budget 600ms is worth 30 cpu references on the baseline machine; the
  // contention allowance multiplies that.
  assert.equal(b.ratio, (600 / 20) * CONTENTION_HEADROOM);
});

test('deriveBudget: refuses an unknown class or a baseline with no p95', () => {
  assert.throws(() => deriveBudget({ p95: 1, cpuRefMedianMs: 1 }, 'nonsense', 'x'), /unknown headroom class/);
  assert.throws(() => deriveBudget({ cpuRefMedianMs: 1 }, 'query', 'missing-p95'), /baseline missing p95/);
});

test('every headroom class is documented and > 1 — a factor of 1 would make the budget the baseline', () => {
  for (const [name, factor] of Object.entries(HEADROOM)) {
    assert.ok(factor > 1, `${name} headroom must exceed 1, got ${factor}`);
    assert.ok(factor <= 5, `${name} headroom ${factor} is so wide the budget stops meaning anything`);
  }
  assert.ok(CONTENTION_HEADROOM >= 2);
});

// ---------------------------------------------------------------------------
// The two-axis check: contention must not read as a regression, and a
// regression must not hide behind contention.
// ---------------------------------------------------------------------------

test('checkBudget: passes on the absolute budget on a quiet machine', () => {
  const b = deriveBudget({ p95: 100, cpuRefMedianMs: 20 }, 'query', 'test'); // 300ms
  const r = checkBudget(b, 250, 20);
  assert.equal(r.ok, true);
  assert.equal(r.byAbs, true);
});

test('checkBudget: external load inflates measurement AND reference together — still passes', () => {
  const b = deriveBudget({ p95: 100, cpuRefMedianMs: 20 }, 'query', 'test'); // abs 300ms, ratio 45x
  // A 4x-loaded machine: the query takes 1000ms but the CPU reference takes 80ms.
  const r = checkBudget(b, 1000, 80);
  assert.equal(r.byAbs, false, 'absolute axis correctly blown by contention');
  assert.equal(r.byRatio, true, 'ratio axis absorbs it: 12.5x is well under the 45x ceiling');
  assert.equal(r.ok, true);
});

test('checkBudget: a REAL regression inflates only the numerator and fails both axes', () => {
  const b = deriveBudget({ p95: 100, cpuRefMedianMs: 20 }, 'query', 'test'); // abs 300ms, ratio 45x
  // Quiet machine (reference still 20ms), query got 50x slower.
  const r = checkBudget(b, 5000, 20);
  assert.equal(r.byAbs, false);
  assert.equal(r.byRatio, false, '250x the reference cannot pass a 45x ceiling');
  assert.equal(r.ok, false);
});

test('checkBudget: the detail string always reports BOTH axes and the derivation', () => {
  const b = deriveBudget({ p95: 100, cpuRefMedianMs: 20 }, 'batch', 'why this factor');
  const r = checkBudget(b, 250, 20);
  assert.match(r.detail, /budget/);
  assert.match(r.detail, /baseline p95 100ms × 3 batch/);
  assert.match(r.detail, /contention axis/);
});

// ---------------------------------------------------------------------------
// Statistics primitives
// ---------------------------------------------------------------------------

test('percentile / median / relativeMad behave on known inputs', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 0.5), 5);
  assert.equal(percentile(xs, 0.95), 10);
  assert.equal(percentile(xs, 1), 10);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(relativeMad([10, 10, 10, 10]), 0, 'a perfectly steady machine has zero spread');
  // Odd-count, matching how probeMachine actually samples (9 references): with
  // an even count the lower-percentile median can legitimately report zero
  // spread for a bimodal set, which says nothing about the machine.
  assert.ok(relativeMad([10, 20, 50, 80, 200]) > 0.5, 'a wildly varying machine has large spread');
});

test('probeMachine reports both quietness signals and a verdict', async () => {
  const p = await probeMachine(3);
  for (const k of ['cpuRefMedianMs', 'cpuRefMadRatio', 'systemBusyFraction', 'quiet', 'cores', 'platform']) {
    assert.ok(k in p, `probeMachine must report ${k}`);
  }
  assert.equal(typeof p.quiet, 'boolean');
  assert.ok(p.systemBusyFraction >= 0 && p.systemBusyFraction <= 1);
  // Both ceilings must exist as named constants — a magic number inline would
  // be un-reviewable.
  assert.ok(QUIET_MAD_CEILING > 0 && QUIET_BUSY_CEILING > 0);
});

// ---------------------------------------------------------------------------
// Corpus determinism — the contract that makes every scale budget comparable
// ---------------------------------------------------------------------------

test('corpus: two seeds with the same anchor are row-for-row identical (fixed-seed PRNG)', async () => {
  const { seedCorpus, countRows } = await import('../bench/lib/corpus.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-corpus-det-'));
  const anchorMs = Date.UTC(2026, 5, 1);
  try {
    const a = path.join(tmp, 'a.db');
    const b = path.join(tmp, 'b.db');
    const metaA = await seedCorpus(a, 2000, { anchorMs });
    const metaB = await seedCorpus(b, 2000, { anchorMs });
    assert.deepEqual(metaA.rows, metaB.rows, 'row census must be identical across seeds');
    assert.deepEqual(metaA.composition, metaB.composition);
    assert.equal(metaA.startMs, metaB.startMs, 'the same anchor must produce the same time base');
    assert.deepEqual(countRows(a), countRows(b));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('corpus: the anchor is an INPUT — seedCorpus refuses to invent one', async () => {
  const { seedCorpus } = await import('../bench/lib/corpus.mjs');
  await assert.rejects(() => seedCorpus('unused.db', 10), /requires an explicit anchorMs/);
});

test('corpus: a stale cached corpus is rejected — aged-out data empties the why/context windows', async () => {
  const { corpusReady, CORPUS_MAX_AGE_DAYS } = await import('../bench/lib/corpus.mjs');
  // No corpus on disk for this absurd scale, so this also pins the "missing
  // means not ready" branch; the age arithmetic is asserted below it.
  assert.equal(corpusReady(-1), false);
  assert.ok(CORPUS_MAX_AGE_DAYS > 0 && CORPUS_MAX_AGE_DAYS <= 30,
    'the staleness window must be short enough that last-7d queries still hit data');
});

test('corpus: composition ratios are scale-invariant, so 100k and 1M are the same shape', async () => {
  const { composition } = await import('../bench/lib/corpus.mjs');
  const small = composition(100_000);
  const big = composition(1_000_000);
  for (const key of ['logLines', 'compiles', 'bundles', 'testRuns', 'resourceSamples']) {
    assert.equal(big[key] / small[key], 10, `${key} must scale linearly with the event count`);
  }
});

test('corpus: seedCorpus itself never reads the clock or Math.random()', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'bench', 'lib', 'corpus.mjs'), 'utf8');
  const start = src.indexOf('export async function seedCorpus');
  assert.ok(start > 0, 'seedCorpus must exist');
  // Up to the next top-level export — the seeder body only.
  const rest = src.slice(start + 1);
  const end = rest.indexOf('\nexport ');
  const body = (end === -1 ? rest : rest.slice(0, end))
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\(\)/.test(body), 'Date.now() inside seedCorpus makes the corpus unreproducible — the anchor is a parameter');
  assert.ok(!/Math\.random\(\)/.test(body), 'Math.random() inside seedCorpus makes the corpus unreproducible');
  assert.ok(!/new Date\(\)/.test(body), 'new Date() inside seedCorpus makes the corpus unreproducible');
});

// ---------------------------------------------------------------------------
// The committed baseline — the "before" column the whole release rests on
// ---------------------------------------------------------------------------

test('BASELINE-v1.10.json is committed, quiet, and covers the closed metric set', () => {
  const p = path.join(repoRoot, 'bench', 'BASELINE-v1.10.json');
  assert.ok(fs.existsSync(p), 'the committed baseline is the input to every budget — it must exist');
  const b = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(b.machineQuiet, true, 'a contended baseline would inflate every derived budget');
  assert.equal(b.quick, false, 'a --quick run is not a baseline');
  for (const metric of ['daemon-cold-start', 'cli-roundtrip', 'idle-footprint', 'tui-attach', 'dashboard-route-tti']) {
    assert.ok(b.metrics[metric], `baseline must carry ${metric}`);
  }
});

test('every baseline metric records the method that produced it (reproducibility)', () => {
  const b = JSON.parse(fs.readFileSync(path.join(repoRoot, 'bench', 'BASELINE-v1.10.json'), 'utf8'));
  for (const [name, m] of Object.entries(b.metrics)) {
    assert.ok(typeof m.method === 'string' && m.method.length > 20,
      `${name} must document how it was measured, got ${JSON.stringify(m.method)}`);
  }
});

// ---------------------------------------------------------------------------
// Deferred-FTS discipline (the standing invariant, re-asserted at v1.10 scale)
// ---------------------------------------------------------------------------

test('no FTS trigger sits on the INSERT path — deferred indexing only', () => {
  // M183 (v1.16) widened the scan from history.ts to EVERY source file: the
  // query syntax and the unified scope added search code outside history.ts,
  // and "no per-insert FTS trigger" is a property of the whole tree, not of
  // one file that happens to hold the schema today.
  const roots = [path.join(repoRoot, 'src'), path.join(repoRoot, 'src', 'tui')];
  const files = roots.flatMap(dir => fs.readdirSync(dir)
    .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map(f => path.join(dir, f)));
  let total = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const triggers = [...src.matchAll(/CREATE\s+TRIGGER[^;]*?(AFTER|BEFORE)\s+(INSERT|UPDATE|DELETE)\s+ON\s+(\w+)/gi)];
    total += triggers.length;
    for (const [, when, verb, table] of triggers) {
      assert.equal(verb.toUpperCase(), 'DELETE',
        `${path.basename(file)}: ${when} ${verb} trigger on ${table}: FTS indexing must stay OFF the write path `
        + '(measured 4-10x on inserts) — only DELETE cleanup triggers are permitted');
    }
  }
  assert.ok(total > 0, 'expected the retention-cleanup triggers to still exist');
});

test('the v1.16 query-syntax paths are budgeted from their own committed baseline', () => {
  // M183: the syntax queries are certified on BOTH engines. This asserts the
  // harness is WIRED — every class declared, every metric documented, and the
  // baseline (once recorded) covering both paths. The numbers themselves are
  // produced by `npm run bench:scale`, never typed in here.
  const scaleSrc = fs.readFileSync(path.join(repoRoot, 'bench', 'scale.mjs'), 'utf8');
  const declared = [...scaleSrc.matchAll(/'(search-(?:like-)?syntax-[a-z]+)':\s*\['(interactive|query|batch|startup|write)'/g)]
    .map(m => m[1]);
  const expected = ['filtered', 'phrase', 'level', 'unified']
    .flatMap(k => [`search-syntax-${k}`, `search-like-syntax-${k}`]);
  for (const name of expected) {
    assert.ok(declared.includes(name), `${name} has no budget class — an unclassified metric silently SKIPS the gate`);
  }
  // Both engines, from one query table: a query certified on FTS only would
  // leave the degraded path — the one a broken index falls back to — ungated.
  assert.match(scaleSrc, /measureSyntax\(h, 'search-syntax-'/, 'the FTS path must run the syntax queries');
  assert.match(scaleSrc, /measureSyntax\(hl, 'search-like-syntax-'/, 'the LIKE path must run the same syntax queries');

  const baselinePath = path.join(repoRoot, 'bench', 'BASELINE-v1.16-search.json');
  if (!fs.existsSync(baselinePath)) return; // recorded by --write-syntax on a quiet machine
  const b = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  for (const name of expected) {
    const m = b.metrics?.[name];
    assert.ok(m && typeof m.p95 === 'number', `${name} missing from the committed v1.16 baseline`);
    assert.ok(typeof m.method === 'string' && m.method.length > 20, `${name} must document how it was measured`);
    assert.ok(m.hits > 0, `${name} certified an EMPTY result set — the budget would mean nothing`);
  }
});
