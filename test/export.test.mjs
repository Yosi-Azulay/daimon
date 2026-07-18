import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// M111 (v1.4) — `daimon export`: the one-way carry-out bundle. Composition
// correctness against independently-queried values, the versioned envelope in
// all three formats, empty-history degradation to notes, atomic --out
// (torn-write survival), redaction (no env values, no personal email — in
// json, md AND csv), the HTTP route, and the 100k-corpus <750ms bench budget.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-export-'));
process.env.DAIMON_HOME = path.join(tmp, 'home');

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { buildExport, renderExportMd, renderExportCsv, writeExportAtomic, EXPORT_SCHEMA_VERSION } = await import('../dist/export.js');
const { snapshotEnvFiles } = await import('../dist/envFiles.js');
const { groupErrors } = await import('../dist/errorGroups.js');

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43700, 43790], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: path.join(tmp, 'history.db'), retentionDays: 60 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 }, restartStorm: { perHour: 20 },
    ...overrides,
  };
}

function app(name, extra = {}) {
  return { name, baseName: name, workspaceRoot: tmp, workspaceType: 'polyglot', command: 'echo x', hidden: false, tags: [], ...extra };
}

const HOUR = 3600_000;
// The seeded secret that redaction must keep out of every bundle format, and
// the personal email that must never appear in any artifact.
const SECRET = 'hunter2-super-secret-value-9f3a';
const PERSONAL_EMAIL = 'yosi' + '@flycotech.com';

function seededHistory(dbPath, now) {
  const h = new History({ enabled: true, path: dbPath, retentionDays: 60 });
  h.recordEvent({ ts: now - 10 * HOUR, app: 'alpha', type: 'status', from: 'compiling', to: 'serving' });
  h.recordEvent({ ts: now - 4 * HOUR, app: 'alpha', type: 'status', from: 'serving', to: 'error', message: 'boom' });
  // CSV-hostile message: commas, quotes, newline — must round-trip escaped.
  h.recordEvent({ ts: now - 9 * HOUR, app: 'alpha', type: 'error-new', message: 'TS2304: Cannot find name "x", again,\nsecond line' });
  for (const dt of [7, 6, 5]) h.recordEvent({ ts: now - dt * HOUR, app: 'beta', type: 'error-recur', message: 'ECONNREFUSED upstream' });
  for (const [i, ms] of [100, 200, 300, 400, 500].entries()) {
    h.recordCompile('alpha', ms, now - (8 - i) * HOUR);
  }
  h.recordCrash({ app: 'beta', ts: now - 6 * HOUR, exitCode: 1, signal: null, uptimeMs: 1234, lastLines: ['tail line 1', 'tail line 2'], gitHead: 'abc' });
  h.recordTestRun({ app: 'alpha', ts: now - 7 * HOUR, runner: 'vitest', durationMs: 1000, total: 10, passed: 8, failed: 2, skipped: 0, exitCode: 1, gitHead: 'abc' }, [
    { suite: 's', test: 'flappy', file: 'a.ts', line: 1, message: 'nope', fingerprint: 'fp1' },
  ]);
  h.recordTestRun({ app: 'alpha', ts: now - 6 * HOUR, runner: 'vitest', durationMs: 900, total: 10, passed: 10, failed: 0, skipped: 0, exitCode: 0, gitHead: 'abc' }, []);
  // Env snapshot carrying a real secret VALUE — snapshotEnvFiles hashes and
  // discards it in the same tick; the export must only ever see names+hashes.
  const root = fs.mkdtempSync(path.join(tmp, 'env-'));
  fs.writeFileSync(path.join(root, '.env'), `API_TOKEN=${SECRET}\n`);
  const snapA = snapshotEnvFiles(root, ['.env']);
  fs.writeFileSync(path.join(root, '.env'), `API_TOKEN=${SECRET}-rotated\n`);
  const snapB = snapshotEnvFiles(root, ['.env']);
  h.recordEnvSnapshot('alpha', snapA, now - 20 * HOUR);
  h.recordEnvSnapshot('alpha', snapB, now - 1 * HOUR);
  h._flushForTest();
  return h;
}

// Live registry errors feed the errorGroups section (fingerprint-folded).
function seedRegistryErrors(reg, now) {
  const s = reg.getState('alpha');
  s.errors.set('parsed', {
    message: "src/app.ts(3,7): error TS2304: Cannot find name 'boom'.",
    count: 2, firstSeen: now - 5 * HOUR, lastSeen: now - HOUR, level: 'error',
    parsed: { file: 'src/app.ts', line: 3, col: 7, code: 'TS2304', message: "Cannot find name 'boom'.", tool: 'typescript' },
  });
  const b = reg.getState('beta');
  b.errors.set('plain', {
    message: 'something, "quoted", exploded',
    count: 1, firstSeen: now - 2 * HOUR, lastSeen: now - HOUR, level: 'error',
  });
}

function makeSeeded(dbName) {
  const now = Date.now();
  const dbPath = path.join(tmp, dbName);
  const h = seededHistory(dbPath, now);
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 60 } });
  const reg = new Registry(cfg, [app('alpha'), app('beta')]);
  reg.setHistory(h);
  seedRegistryErrors(reg, now);
  return { now, h, cfg, reg };
}

test('seeded export: every section matches independently-queried values', () => {
  const { now, h, reg } = makeSeeded('seeded.db');
  const b = buildExport({ registry: reg, history: h, agents: [], flakyThreshold: 3 }, { since: now - 24 * HOUR, until: now });

  assert.equal(b.schemaVersion, 1);
  assert.equal(EXPORT_SCHEMA_VERSION, 1);
  assert.equal(typeof b.daimonVersion, 'string');
  assert.equal(b.since, now - 24 * HOUR);
  assert.equal(b.until, now);
  assert.equal(b.app, null);

  // The section list is closed — no raw log-line section may ever appear.
  assert.deepEqual(
    Object.keys(b.sections).sort(),
    ['compiles', 'crashes', 'errorGroups', 'events', 'report', 'testRuns'],
  );

  // events: exactly what queryEvents returns.
  const evs = h.queryEvents({ since: now - 24 * HOUR, until: now, limit: 10_000 });
  assert.equal(b.sections.events.count, evs.length);
  assert.deepEqual(b.sections.events.rows, evs);

  // errorGroups: fingerprint-folded live registry errors, like /api/errors?group=fingerprint.
  const expectedGroups = groupErrors([
    { app: 'alpha', errors: [...reg.getState('alpha').errors.values()] },
    { app: 'beta', errors: [...reg.getState('beta').errors.values()] },
  ]);
  assert.equal(b.sections.errorGroups.count, expectedGroups.length);
  assert.deepEqual(b.sections.errorGroups.groups.map(g => g.fingerprint).sort(), expectedGroups.map(g => g.fingerprint).sort());

  // testRuns / compiles / crashes: existing query shapes, unmodified.
  assert.equal(b.sections.testRuns.count, 2);
  assert.equal(b.sections.compiles.count, 5);
  assert.equal(b.sections.crashes.count, 1);
  assert.deepEqual(b.sections.crashes.rows[0].lastLines, h.queryCrashes({ since: now - 24 * HOUR, limit: 200 })[0].lastLines, 'crash rows keep their bounded tail, query shape unmodified');
  assert.ok(String(b.sections.crashes.rows[0].lastLines).includes('tail line 1'), 'bounded tail excerpt present');

  // report: the embedded M83 report with its own sections.
  assert.equal(b.sections.report.since, now - 24 * HOUR);
  assert.ok(b.sections.report.sections.uptime, 'report section embedded whole');
  h.close();
});

test('app filter narrows every section', () => {
  const { now, h, reg } = makeSeeded('filtered.db');
  const b = buildExport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now, app: 'beta' });
  assert.equal(b.app, 'beta');
  assert.ok(b.sections.events.rows.every(e => e.app === 'beta'));
  assert.ok(b.sections.errorGroups.groups.every(g => g.apps.length === 1 && g.apps[0] === 'beta'));
  assert.ok(b.sections.testRuns.note, 'beta has no test runs → note');
  assert.equal(b.sections.crashes.count, 1);
  h.close();
});

test('empty history: a valid bundle of notes, never an error', () => {
  const dbPath = path.join(tmp, 'empty.db');
  const h = new History({ enabled: true, path: dbPath, retentionDays: 7 });
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 7 } });
  const reg = new Registry(cfg, [app('lonely')]);
  reg.setHistory(h);
  const b = buildExport({ registry: reg, history: h }, { since: Date.now() - 24 * HOUR });
  assert.equal(b.schemaVersion, 1);
  for (const key of ['events', 'errorGroups', 'testRuns', 'compiles', 'crashes']) {
    assert.ok(b.sections[key]?.note, `${key} degraded to a note (${JSON.stringify(b.sections[key])})`);
  }
  assert.ok(b.sections.report.sections, 'report still an object of its own notes');
  // All three formats render without throwing on an all-notes bundle.
  assert.ok(renderExportMd(b).includes('# daimon export'));
  assert.ok(renderExportCsv(b).includes('section,ts,app,summary,detail'));
  h.close();
});

test('history disabled entirely: notes, not errors', () => {
  const cfg = baseCfg({ history: { enabled: false, path: path.join(tmp, 'x.db'), retentionDays: 7 } });
  const reg = new Registry(cfg, [app('a')]);
  const b = buildExport({ registry: reg, history: null }, { since: Date.now() - 24 * HOUR });
  for (const key of ['events', 'testRuns', 'compiles', 'crashes']) {
    assert.ok(b.sections[key]?.note, `${key} degraded (${JSON.stringify(b.sections[key])})`);
  }
});

test('schemaVersion 1 is present in the envelope/header of all three formats', () => {
  const { now, h, reg } = makeSeeded('versions.db');
  const b = buildExport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now });
  assert.equal(b.schemaVersion, 1);
  const md = renderExportMd(b);
  assert.match(md.split('\n')[1], /schemaVersion 1/);
  const csv = renderExportCsv(b);
  assert.match(csv.split('\n')[0], /^# daimon export schemaVersion=1 /);
  h.close();
});

test('md render: report embedded + per-section summary lines', () => {
  const { now, h, reg } = makeSeeded('md.db');
  const md = renderExportMd(buildExport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now }));
  assert.ok(md.startsWith('# daimon export'));
  for (const line of ['## Sections', '- **events**', '- **errorGroups**', '- **testRuns**', '- **compiles**', '- **crashes**']) {
    assert.ok(md.includes(line), `${line} present`);
  }
  assert.ok(md.includes('# daimon report'), 'the M83 report renders inside the bundle');
  assert.ok(md.includes('one-way bundle'), 'one-way statement present');
  h.close();
});

test('csv render: stable columns, one row per record, hostile fields escaped', () => {
  const { now, h, reg } = makeSeeded('csv.db');
  const b = buildExport({ registry: reg, history: h }, { since: now - 24 * HOUR, until: now });
  const csv = renderExportCsv(b);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[1], 'section,ts,app,summary,detail');
  // Row count: every record from every non-note section, report not flattened.
  const expected = b.sections.events.count + b.sections.errorGroups.count
    + b.sections.testRuns.count + b.sections.compiles.count + b.sections.crashes.count;
  // Quoted fields may carry embedded newlines — count rows by section prefix.
  const rows = csv.match(/^(events|errorGroups|testRuns|compiles|crashes),/gm) ?? [];
  assert.equal(rows.length, expected, `one csv row per record (${rows.length}/${expected})`);
  assert.ok(!csv.split('\n').some(l => l.startsWith('report,')), 'report section is not flattened into csv');
  // The comma/quote/newline message survived quoting: field is wrapped and quotes doubled.
  assert.ok(csv.includes('""x""'), 'embedded quotes doubled');
  h.close();
});

test('--out is atomic: a simulated mid-write kill never leaves a torn target', () => {
  const target = path.join(tmp, 'bundle.json');
  fs.writeFileSync(target, '{"old":true}', 'utf8');
  // Simulate dying mid-write: the tmp file exists half-written, rename never ran.
  fs.writeFileSync(`${target}.${process.pid}.tmp`, '{"torn":', 'utf8');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { old: true }, 'target untouched by a torn tmp write');
  // The real write replaces the target in one rename and cleans up after itself.
  const res = writeExportAtomic(target, '{"new":true}\n');
  assert.equal(res.path, target);
  assert.equal(res.bytes, Buffer.byteLength('{"new":true}\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { new: true });
  assert.ok(!fs.existsSync(`${target}.${process.pid}.tmp`), 'tmp renamed away');
});

test('redaction holds in every format: no env value, no personal email', () => {
  const { now, h, reg } = makeSeeded('redact.db');
  const b = buildExport({ registry: reg, history: h, agents: [], flakyThreshold: 3 }, { since: now - 24 * HOUR, until: now });
  const artifacts = {
    json: JSON.stringify(b),
    md: renderExportMd(b),
    csv: renderExportCsv(b),
  };
  for (const [fmt, text] of Object.entries(artifacts)) {
    assert.ok(!text.includes(SECRET), `${fmt}: seeded env VALUE must never appear in a bundle`);
    assert.ok(!text.toLowerCase().includes(PERSONAL_EMAIL), `${fmt}: personal email must never appear in a bundle`);
  }
  // Sanity: the secret really was seeded (env change is visible by KEY name).
  const snaps = h.queryEnvSnapshots({ app: 'alpha', limit: 5 });
  assert.ok(snaps.length >= 2, 'env snapshots recorded');
  assert.ok(JSON.stringify(snaps).includes('API_TOKEN'), 'key name stored');
  assert.ok(!JSON.stringify(snaps).includes(SECRET), 'value hashed away at the storage layer');
  h.close();
});

test('GET /api/export: json envelope, md/csv content types, 400 remedy on bad format', async () => {
  const { now, h, cfg, reg } = makeSeeded('route.db');
  const server = startServer(reg, 0, { getConfig: () => cfg });
  await new Promise(res => server.once('listening', res));
  const apiPort = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/export?since=24h`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schemaVersion, 1);
    assert.ok(body.sections.events.count >= 1);

    const md = await fetch(`http://127.0.0.1:${apiPort}/api/export?since=24h&format=md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type') || '', /markdown/);
    assert.ok((await md.text()).startsWith('# daimon export'));

    const csv = await fetch(`http://127.0.0.1:${apiPort}/api/export?since=24h&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /csv/);
    assert.match((await csv.text()).split('\n')[0], /schemaVersion=1/);

    const bad = await fetch(`http://127.0.0.1:${apiPort}/api/export?format=xml`);
    assert.equal(bad.status, 400);
    const err = await bad.json();
    assert.match(err.error, /json\|md\|csv/, 'error carries the remedy');
  } finally {
    server.close();
    h.close();
  }
});

test('cli: daimon export --out writes the bundle atomically; stdout stays pipe-friendly', async () => {
  const { now, h, cfg, reg } = makeSeeded('cli.db');
  const server = startServer(reg, 0, { getConfig: () => cfg });
  await new Promise(res => server.once('listening', res));
  const apiPort = server.address().port;
  const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  const run = (...args) => new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: tmp,
      env: { ...process.env, DAIMON_PORT: String(apiPort), DAIMON_NO_SPAWN: '1', NO_COLOR: '1' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 30_000);
    child.on('close', code => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
  try {
    const outFile = path.join(tmp, 'cli-bundle.json');
    const w = await run('export', '--since', '24h', '--out', outFile);
    assert.equal(w.code, 0, w.stderr);
    const receipt = JSON.parse(w.stdout.trim().split('\n').pop());
    assert.equal(receipt.written, outFile);
    assert.equal(receipt.format, 'json');
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(written.schemaVersion, 1);
    assert.equal(receipt.bytes, fs.statSync(outFile).size);

    const p = await run('export', '--since', '24h');
    assert.equal(p.code, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout).schemaVersion, 1, 'stdout is the bundle itself');

    const c = await run('export', '--since', '24h', '--format', 'csv');
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout.split('\n')[0], /schemaVersion=1/);

    const badFmt = await run('export', '--format', 'xml');
    assert.equal(badFmt.code, 1);
    assert.match(badFmt.stderr + badFmt.stdout, /json/, 'bad format names the valid set');
  } finally {
    server.close();
    h.close();
  }
});

test('bench: full JSON bundle over a 100k-event corpus in < 750ms', () => {
  const dbPath = path.join(tmp, 'bench.db');
  const h = new History({ enabled: true, path: dbPath, retentionDays: 365 });
  const apps = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const now = Date.now();
  const dayMs = 24 * HOUR;
  const types = ['status', 'error-new', 'error-recur'];
  const states = ['serving', 'compiling', 'error', 'starting'];
  for (let i = 0; i < 100_000; i++) {
    const ts = now - Math.floor((i / 100_000) * dayMs * 30);
    h.recordEvent({
      ts, app: apps[i % apps.length], type: types[i % types.length],
      from: states[i % states.length], to: states[(i + 1) % states.length],
      message: i % 3 === 0 ? `err message ${i % 13}` : undefined,
    });
    if (i % 5000 === 0) h._flushForTest();
  }
  for (let i = 0; i < 10_000; i++) {
    h.recordCompile(apps[i % apps.length], 50 + (i % 5000), now - Math.floor((i / 10_000) * dayMs * 30));
    if (i % 2000 === 0) h._flushForTest();
  }
  h._flushForTest();

  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 365 } });
  const reg = new Registry(cfg, apps.map(a => app(a)));
  reg.setHistory(h);

  // Warm the statement cache once, then median of 3 full-bundle passes
  // (compose + stringify — the whole JSON production cost).
  JSON.stringify(buildExport({ registry: reg, history: h }, { since: now - 7 * dayMs }));
  const samples = [];
  for (let pass = 0; pass < 3; pass++) {
    const t0 = performance.now();
    const b = buildExport({ registry: reg, history: h }, { since: now - 7 * dayMs });
    const text = JSON.stringify(b);
    samples.push(performance.now() - t0);
    assert.ok(b.sections.events.count > 0 && text.length > 1000, 'bench bundle has data');
  }
  samples.sort((a, b) => a - b);
  const median = samples[1];
  assert.ok(median < 750, `export bench budget: median ${median.toFixed(1)}ms < 750ms (samples: ${samples.map(s => s.toFixed(0)).join(',')})`);
  h.close();
});
