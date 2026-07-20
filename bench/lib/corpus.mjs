// Deterministic bench corpus (M145 harness, M146 scale-up) — v1.10.
//
// One seeder, one composition, a SCALE parameter. The 100k corpus that the
// existing test budgets were set on and the 1M corpus that certifies v1.10 are
// the same distributions at different sizes, so a budget measured at 100k and
// one measured at 1M are comparable.
//
// DETERMINISM is the contract: a fixed-seed PRNG drives every choice, so two
// machines seeding scale=1_000_000 get byte-comparable row counts and the same
// searchable needles. Nothing here calls Date.now() or Math.random().
//
// The corpus is EXPENSIVE to build (minutes at 1M), so it is cached on disk
// under bench/.corpus and reused across runs. SEEDER_VERSION invalidates it:
// bump it whenever the composition changes, or a stale corpus would silently
// certify the wrong shape of data.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { repoRoot } from './daemonHarness.mjs';

export const SEEDER_VERSION = 1;
export const CORPUS_DIR = path.join(repoRoot, 'bench', '.corpus');

// Fixed epoch so every seeded row lands on the same absolute timestamps on
// every machine and every run — the alternative (Date.now()) would make the
// corpus non-reproducible and every derived budget unfalsifiable.
export const CORPUS_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
export const CORPUS_SPAN_DAYS = 90;

// The searchable needles. Fixed strings at fixed densities so a search budget
// measures a KNOWN hit count rather than whatever the RNG happened to produce.
export const NEEDLES = {
  // ~1 in 5 events — the common case a user actually greps for.
  common: 'ECONNREFUSED',
  // ~1 in 5000 events — the worst case for FTS: a term that forces a deep scan
  // of the index before it can stop.
  rare: 'zzqx-needle-rare',
};

// mulberry32 — 32-bit, seedable, no dependencies, identical across platforms.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const APPS = ['web', 'api', 'admin', 'docs', 'storybook', 'worker', 'auth', 'billing', 'search', 'gateway'];
const AGENTS = ['claude-a1b2', 'claude-c3d4', 'human-cli', 'vscode-e5f6', '(unknown)'];
const RUNNERS = ['vitest-jest', 'pytest', 'go-test'];

/**
 * Composition of a corpus, derived proportionally from `scale` (= event count).
 * Ratios are held constant across scales so 100k and 1M differ only in size.
 */
export function composition(scale) {
  return {
    events: scale,
    logLines: scale * 2,          // logs dominate real installs ~2:1 over events
    compiles: Math.floor(scale / 20),
    bundles: Math.floor(scale / 200),
    testRuns: Math.floor(scale / 2000),
    envSnapshots: Math.floor(scale / 5000),
    resourceSamples: Math.floor(scale / 10),
    crashesPerApp: 10,            // the ring cap — more would be discarded anyway
    sessions: CORPUS_SPAN_DAYS,   // ~one daemon uptime slice per day
    apps: APPS.length,
  };
}

export function corpusPath(scale) {
  return path.join(CORPUS_DIR, `corpus-${scale}-v${SEEDER_VERSION}.db`);
}

function metaPath(scale) {
  return corpusPath(scale) + '.meta.json';
}

/** True when a cached corpus of this scale + seeder version is ready to reuse. */
export function corpusReady(scale) {
  const db = corpusPath(scale);
  const meta = metaPath(scale);
  if (!fs.existsSync(db) || !fs.existsSync(meta)) return false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return m.seederVersion === SEEDER_VERSION && m.scale === scale && m.complete === true;
  } catch {
    return false;
  }
}

/**
 * Seed (or reuse) a corpus. Returns { dbPath, meta, seeded }.
 * `seeded` is false when a valid cache was reused.
 */
export async function ensureCorpus(scale, { onProgress = () => {} } = {}) {
  const dbPath = corpusPath(scale);
  if (corpusReady(scale)) {
    return { dbPath, meta: JSON.parse(fs.readFileSync(metaPath(scale), 'utf8')), seeded: false };
  }
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  // A partial corpus from an interrupted run must never be reused.
  for (const p of [dbPath, metaPath(scale)]) { try { fs.rmSync(p, { force: true }); } catch {} }

  const meta = await seedCorpus(dbPath, scale, { onProgress });
  fs.writeFileSync(metaPath(scale), JSON.stringify(meta, null, 2) + '\n');
  return { dbPath, meta, seeded: true };
}

/**
 * Seed a corpus into an explicit path and return its meta. Split out from
 * ensureCorpus so the determinism contract can be tested at a tiny scale in the
 * normal suite, against a temp dir, without touching the cached corpora.
 */
export async function seedCorpus(dbPath, scale, { onProgress = () => {} } = {}) {
  const { History } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'history.js')).href);
  const h = new History({ enabled: true, path: dbPath, retentionDays: 3650 });
  const t0 = performance.now();
  const comp = composition(scale);
  const rnd = mulberry32(0xda1de5ec);
  const spanMs = CORPUS_SPAN_DAYS * 86400_000;
  const tsAt = frac => CORPUS_EPOCH + Math.floor(frac * spanMs);

  // --- events -------------------------------------------------------------
  // Types mirror what a real install accumulates: mostly status churn, a fifth
  // errors, the rest lifecycle. The message body carries realistic module
  // paths + ports so FTS tokenization sees production-shaped text.
  const TYPES = ['status', 'status', 'status', 'error-new', 'error-recur', 'restart', 'compile-done', 'health'];
  for (let i = 0; i < comp.events; i++) {
    const app = APPS[i % APPS.length];
    const type = TYPES[Math.floor(rnd() * TYPES.length)];
    const isCommon = i % 5 === 0;
    const isRare = i % 5000 === 0;
    const parts = [
      `Error: Cannot resolve module './cmp${i % 500}'`,
      `in src/pages/page${i % 300}.ts:${i % 90}:${i % 40}`,
      isCommon ? `${NEEDLES.common} 127.0.0.1:${4200 + (i % 50)}` : `served on 127.0.0.1:${4200 + (i % 50)}`,
      isRare ? NEEDLES.rare : '',
      `#${i}`,
    ];
    h.recordEvent({ ts: tsAt(i / comp.events), app, type, message: parts.filter(Boolean).join(' ') });
    if (i % 20_000 === 19_999) { h._flushForTest(); onProgress('events', i + 1, comp.events); }
  }
  h._flushForTest();
  onProgress('events', comp.events, comp.events);

  // --- session boundaries -------------------------------------------------
  // Sessions are DERIVED from these __daemon__ lifecycle events (M134), so a
  // corpus without them would make the sessions budget meaningless.
  for (let d = 0; d < comp.sessions; d++) {
    const dayStart = d / comp.sessions;
    const dayEnd = (d + 0.8) / comp.sessions;
    h.recordEvent({ ts: tsAt(dayStart), app: '__daemon__', type: 'daemon-start', message: 'daemon started' });
    h.recordEvent({ ts: tsAt(dayEnd), app: '__daemon__', type: 'daemon-stop', message: 'daemon stopped' });
  }
  h._flushForTest();

  // --- log lines ----------------------------------------------------------
  const LEVELS = ['info', 'warn', 'error', 'debug', null];
  for (let i = 0; i < comp.logLines; i++) {
    const app = APPS[i % APPS.length];
    const level = LEVELS[Math.floor(rnd() * LEVELS.length)];
    const isCommon = i % 5 === 0;
    const isRare = i % 5000 === 0;
    const line = `[${level ?? 'log'}] chunk ${i % 900} built in ${100 + (i % 800)}ms `
      + (isCommon ? `${NEEDLES.common} ` : '')
      + (isRare ? `${NEEDLES.rare} ` : '')
      + `src/app/feature${i % 200}/file${i % 60}.ts`;
    h.recordLogLine(app, line, tsAt(i / comp.logLines), level);
    if (i % 40_000 === 39_999) { h._flushForTest(); onProgress('logLines', i + 1, comp.logLines); }
  }
  h._flushForTest();
  onProgress('logLines', comp.logLines, comp.logLines);

  // --- compiles / bundles / resource samples ------------------------------
  for (let i = 0; i < comp.compiles; i++) {
    h.recordCompile(APPS[i % APPS.length], 300 + Math.floor(rnd() * 4000), tsAt(i / comp.compiles));
  }
  for (let i = 0; i < comp.bundles; i++) {
    h.recordBundle(APPS[i % APPS.length], 400 + Math.floor(rnd() * 900), 100 + Math.floor(rnd() * 400), 20 + (i % 200), tsAt(i / comp.bundles));
  }
  for (let i = 0; i < comp.resourceSamples; i++) {
    h.recordResourceSample(APPS[i % APPS.length], (120 + Math.floor(rnd() * 400)) * 1024 * 1024, Math.floor(rnd() * 90), tsAt(i / comp.resourceSamples));
  }
  h._flushForTest();
  onProgress('metrics', comp.compiles + comp.bundles + comp.resourceSamples, comp.compiles + comp.bundles + comp.resourceSamples);

  // --- test runs (with failures, coverage, quarantine) --------------------
  for (let i = 0; i < comp.testRuns; i++) {
    const app = APPS[i % APPS.length];
    const runner = RUNNERS[i % RUNNERS.length];
    const failed = i % 7 === 0 ? 1 + Math.floor(rnd() * 3) : 0;
    const total = 40 + Math.floor(rnd() * 200);
    const failures = [];
    for (let f = 0; f < failed; f++) {
      const name = `renders row ${(i + f) % 13}`;
      failures.push({
        suite: `suite${(i + f) % 9}`,
        test: name,
        file: `src/app/feature${i % 200}/spec${f}.ts`,
        line: 10 + f,
        message: `expected true to be false ${NEEDLES.common}`,
        fingerprint: `fp-${(i + f) % 40}`,
      });
    }
    h.recordTestRun({
      app, ts: tsAt(i / comp.testRuns), runner,
      durationMs: 1000 + Math.floor(rnd() * 20000),
      total, passed: total - failed, failed, skipped: i % 11,
      exitCode: failed ? 1 : 0, gitHead: `abc${i % 1000}`,
      covLinesPct: runner === 'go-test' ? null : 60 + Math.floor(rnd() * 35),
      covStmtsPct: runner === 'go-test' ? null : 60 + Math.floor(rnd() * 35),
    }, failures);
  }

  // --- env snapshots (redaction-safe by construction: names + hashes only) --
  for (let i = 0; i < comp.envSnapshots; i++) {
    h.recordEnvSnapshot(APPS[i % APPS.length], {
      files: [{ file: '.env', keys: ['API_URL', 'PORT', `FEATURE_${i % 20}`], hashes: { API_URL: 'a1b2c3d4e5f6', PORT: 'f6e5d4c3b2a1' } }],
    }, tsAt(i / comp.envSnapshots));
  }

  // --- crashes (ring-capped per app) --------------------------------------
  for (const app of APPS) {
    for (let i = 0; i < comp.crashesPerApp; i++) {
      h.recordCrash({
        app, ts: tsAt((i + 1) / (comp.crashesPerApp + 2)),
        exitCode: 1, signal: null, uptimeMs: 60_000 + i * 1000,
        lastLines: [`Error: listen ${NEEDLES.common} 127.0.0.1:4200`, `    at Server.setupListenHandle`],
        gitHead: `abc${i}`,
      });
    }
  }
  h._flushForTest();

  // FTS index is built ONCE here (deferred-indexing discipline: never per-insert
  // triggers). Query budgets must not pay for the initial build, and the
  // catch-up cost from a cold high-water mark is measured separately in M146.
  const ftsT0 = performance.now();
  h.syncFts();
  const ftsBuildMs = performance.now() - ftsT0;
  h.close();

  // Row counts are read back from the finished DB rather than accumulated in
  // JS: the History idle-flush tick also runs syncFts, so an in-flight counter
  // would be timing-dependent and break the "same numbers on every machine"
  // contract. The counts below are a property of the corpus, not of the run.
  const rows = countRows(dbPath);

  const meta = {
    seederVersion: SEEDER_VERSION,
    scale,
    complete: true,
    composition: comp,
    epoch: CORPUS_EPOCH,
    spanDays: CORPUS_SPAN_DAYS,
    needles: NEEDLES,
    seedMs: Math.round(performance.now() - t0),
    ftsBuildMs: Math.round(ftsBuildMs),
    rows,
    dbBytes: fs.statSync(dbPath).size,
  };
  return meta;
}

const COUNTED_TABLES = [
  'events', 'log_lines', 'compile_times', 'test_runs', 'test_failures',
  'env_snapshots', 'crashes', 'resource_samples', 'events_fts', 'log_fts',
];

/** Deterministic row census of a finished corpus — part of its identity. */
export function countRows(dbPath) {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const out = {};
    for (const t of COUNTED_TABLES) {
      try { out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch { out[t] = null; }
    }
    return out;
  } finally {
    db.close();
  }
}
