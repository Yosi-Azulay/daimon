import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// M179 + M180 (v1.16 "Recall") over the real surfaces: HTTP and the CLI.
//
// What this file guards: the query syntax reaches the daemon and the terminal
// with the SAME error text, the unified scope is strictly OPT-IN (a v1.15 call
// gets a v1.15 body), and every rejected value names what would have been
// accepted.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-srchsurf-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { History } = await import('../dist/history.js');
const { startServer } = await import('../dist/server.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const now = Date.now();

const history = new History({ enabled: true, path: path.join(fakeHome, 'history.db'), retentionDays: 90 });
history.recordEvent({ ts: now - 1000, app: 'web', type: 'error-new', message: 'okapi-marker chunk failed to load' });
history.recordEvent({ ts: now - 900, app: 'api', type: 'warning-new', message: 'okapi-marker deprecated flag' });
history.recordEvent({ ts: now - 800, app: 'web', type: 'status', message: 'okapi-marker ready in 900ms' });
history.recordLogLine('web', 'okapi-marker ERROR boom', now - 700, 'error');
history.recordLogLine('api', 'okapi-marker plain line', now - 600, null);
history.recordTestRun(
  { app: 'web', ts: now - 500, runner: 'vitest', durationMs: 900, total: 4, passed: 3, failed: 1, skipped: 0, exitCode: 1, gitHead: null },
  [{ suite: 'okapi-marker suite', test: 'loads', file: 'a.spec.ts', message: 'nope', fingerprint: 'fp' }],
);
history._flushForTest();

const APPS = ['web', 'api'];
const config = {
  searchRoots: [], portRange: [4210, 4260], apiPort: 0,
  overrides: {}, autoStart: [], profiles: {}, tags: {},
  autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
  healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
  logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
  depends: {}, cascadeRestart: false,
  history: { enabled: true, path: path.join(fakeHome, 'history.db'), retentionDays: 90 },
  notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
  requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
  editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
  doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
  errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
  groups: {},
};

const ee = new EventEmitter();
const summaryOf = (n) => (APPS.includes(n) ? {
  name: n, baseName: n, status: 'serving', health: 'healthy', port: null, url: null,
  errorCount: 1, uptimeMs: null, lastCompileMs: null, lastHealthAt: null,
  cpu: null, memMB: null, compileHistoryMs: [], tags: [], restartAttempts: 0,
  nextRestartAt: null, announcedUrl: null, lastHealthError: null, stale: false,
  bundle: null, bundleRegressionPct: null, dependsOn: [], activeEnvFile: null,
  workspaceLabel: null, workspaceRoot: null, lastChangeMs: null,
} : null);
const reg = {
  names: () => APPS,
  list: () => APPS.map(summaryOf),
  summary: summaryOf,
  getApp: (n) => (APPS.includes(n) ? { name: n, workspaceRoot: null } : null),
  getState: (n) => (APPS.includes(n) ? { logBuffer: [] } : null),
  resolveByCwd: (n) => (APPS.includes(n) ? { kind: 'unique', key: n } : { kind: 'none' }),
  // One folded error group per app, both matching 'okapi-marker'.
  errors: (n) => (APPS.includes(n)
    ? [{ message: `okapi-marker ${n} TS2304 boom`, count: 2, firstSeen: now - 5000, lastSeen: now - 300, level: n === 'api' ? 'lint' : 'error' }]
    : []),
  events: () => [],
  on: (e, f) => ee.on(e, f),
  off: (e, f) => ee.off(e, f),
  getHistory: () => history,
  getConfig: () => config,
  isMuted: () => false,
  quarantineSummary: () => ({ count: 0, oldestSince: null }),
};

const server = startServer(reg, 0, { getConfig: () => config, onShutdown: () => {} });
await new Promise(r => server.on('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(() => {
  server.close();
  history.close();
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};

function cli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: fakeHome,
      env: { ...process.env, DAIMON_HOME: fakeHome, DAIMON_NO_SPAWN: '1', DAIMON_PORT: String(port), NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 20_000);
    child.on('close', code => {
      clearTimeout(killer);
      let body = null;
      try { body = JSON.parse(stdout.trim()); } catch {}
      resolve({ code, body, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------

test('HTTP: a v1.15-style call returns the v1.15 body — no facets, no new kinds', async () => {
  const r = await get('/api/search?q=okapi-marker');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['fallback', 'hits']);
  assert.ok(r.body.hits.length >= 4);
  assert.ok(r.body.hits.every(h => ['logs', 'errors', 'events'].includes(h.kind)));
  // The legacy params still work, unchanged.
  const scoped = await get('/api/search?q=okapi-marker&app=api&kind=errors');
  assert.ok(scoped.body.hits.length > 0);
  assert.ok(scoped.body.hits.every(h => h.app === 'api' && h.kind === 'errors'));
});

test('HTTP: the query syntax filters, and the query wins over the equivalent param', async () => {
  const r = await get('/api/search?q=' + encodeURIComponent('app:web level:error okapi-marker'));
  assert.equal(r.status, 200);
  assert.ok(r.body.hits.length > 0);
  assert.ok(r.body.hits.every(h => h.app === 'web'));
  // ?app=api is overridden by app:web in the query — one documented rule.
  const conflict = await get('/api/search?app=api&q=' + encodeURIComponent('app:web okapi-marker'));
  assert.ok(conflict.body.hits.length > 0);
  assert.ok(conflict.body.hits.every(h => h.app === 'web'));
  // A filter-only query needs no text at all.
  const filterOnly = await get('/api/search?q=' + encodeURIComponent('app:api'));
  assert.ok(filterOnly.body.hits.length > 0 && filterOnly.body.hits.every(h => h.app === 'api'));
});

test('HTTP: scope=all adds test-run and error-group hits with facets; kind:tests implies it', async () => {
  const r = await get('/api/search?scope=all&q=okapi-marker');
  assert.equal(r.status, 200);
  const kinds = new Set(r.body.hits.map(h => h.kind));
  assert.ok(kinds.has('tests'), 'test runs searched');
  assert.ok(kinds.has('error-groups'), 'live error groups searched');
  assert.ok(r.body.facets && r.body.facets.tests === 1);
  // Facets sum to the hits actually returned.
  assert.equal(Object.values(r.body.facets).reduce((a, b) => a + b, 0), r.body.hits.length);
  const groupHit = r.body.hits.find(h => h.kind === 'error-groups');
  assert.match(groupHit.ref, /^errgroup:/);
  const testHit = r.body.hits.find(h => h.kind === 'tests');
  assert.match(testHit.ref, /^test:\d+$/);

  // kind:tests in the QUERY unlocks the unified scope on its own.
  const only = await get('/api/search?q=' + encodeURIComponent('kind:tests okapi-marker'));
  assert.ok(only.body.hits.length === 1 && only.body.hits[0].kind === 'tests');
  assert.ok(only.body.facets, 'facets appear when a unified kind is asked for');
  // …as does the kind PARAM.
  const viaParam = await get('/api/search?kind=error-groups&q=okapi-marker');
  assert.ok(viaParam.body.hits.length > 0 && viaParam.body.hits.every(h => h.kind === 'error-groups'));
});

test('HTTP: rejected values name what would have been accepted', async () => {
  const unknown = await get('/api/search?q=' + encodeURIComponent('lvl:error boom'));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "unknown field 'lvl:' — did you mean 'level:'? valid fields: app, kind, level, before, after");
  assert.match(unknown.body.hint, /quote the token/);

  const badKind = await get('/api/search?kind=bananas&q=x');
  assert.equal(badKind.status, 400);
  assert.match(badKind.body.error, /kind must be logs\|errors\|events\|tests\|error-groups/);

  const badScope = await get('/api/search?scope=some&q=x');
  assert.equal(badScope.status, 400);
  assert.match(badScope.body.error, /scope must be 'all'/);

  const badTime = await get('/api/search?q=' + encodeURIComponent('after:lastweek'));
  assert.equal(badTime.status, 400);
  assert.match(badTime.body.hint, /epoch ms/);

  // The blank-query guard predates v1.16 and is unchanged.
  assert.equal((await get('/api/search?q=%20')).status, 400);
});

test('HTTP: the v1.15 queries that contain a colon still return hits, not 400s', async () => {
  // The regression this file previously could not see: it only ever searched a
  // colon-free token, so every one of these — ordinary text, a URL, a Windows
  // path — could have been 400ing and the gate would have stayed green.
  for (const q of ['okapi-marker', 'TypeError: okapi-marker', 'http://localhost:4200 okapi-marker', 'C:\src okapi-marker']) {
    const r = await get('/api/search?q=' + encodeURIComponent(q));
    assert.equal(r.status, 200, `${q} must not 400: ${JSON.stringify(r.body)}`);
  }
  // …while a TYPO of a real field still errors, and now names the field.
  const typo = await get('/api/search?q=' + encodeURIComponent('lvl:error boom'));
  assert.equal(typo.status, 400);
  assert.match(typo.body.error, /did you mean 'level:'/);
});

test('HTTP: a query with no terms and no filters is refused, not answered with the newest rows', async () => {
  for (const q of ['""', '"']) {
    const r = await get('/api/search?q=' + encodeURIComponent(q));
    assert.equal(r.status, 400, `${q} must be refused`);
    assert.match(r.body.error, /no terms and no filters/);
    assert.match(r.body.hint, /app:web/);
  }
});

test('HTTP: limit is clamped before it reaches a slice', async () => {
  // ?limit=-1 used to reach `hits.slice(0, -1)` and silently drop the last hit.
  const neg = await get('/api/search?limit=-1&q=okapi-marker');
  assert.equal(neg.status, 200);
  const one = await get('/api/search?limit=1&q=okapi-marker');
  assert.equal(one.body.hits.length, 1);
  assert.ok(neg.body.hits.length >= 1, 'a negative limit must not empty the result');
  const huge = await get('/api/search?limit=99999&q=okapi-marker');
  assert.ok(huge.body.hits.length <= 500);
});

test('HTTP: the legacy app/since params also scope error-group hits', async () => {
  // Every other store honoured ?app=; groups ignored it, so a scoped search
  // returned groups from every app and all time.
  const r = await get('/api/search?scope=all&app=api&q=okapi-marker');
  assert.equal(r.status, 200);
  const groups = r.body.hits.filter(h => h.kind === 'error-groups');
  assert.ok(groups.length > 0, 'fixture has an api group');
  assert.ok(groups.every(h => h.app === 'api'), `a foreign-app group leaked: ${JSON.stringify(groups)}`);
});

test('HTTP: only the two declared POST paths are accepted', async () => {
  // `POST /api/searches/<anything>` used to be treated as "save".
  const res = await fetch(base + '/api/searches/renmae', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'sneaky', query: 'boom' }),
  });
  assert.equal(res.status, 404, 'a mistyped subpath must 404, not save');
  const list = await get('/api/searches');
  assert.ok(!list.body.searches.some(x => x.name === 'sneaky'), 'nothing was created by the typo path');
});

test('CLI: the same query, the same errors, plus --all for the unified scope', async () => {
  const ok = await cli(['search', 'app:web level:error okapi-marker']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(ok.body.hits.length > 0 && ok.body.hits.every(h => h.app === 'web'));

  const all = await cli(['search', 'okapi-marker', '--all']);
  assert.equal(all.code, 0, all.stderr);
  assert.ok(all.body.facets, 'facets in the CLI body');
  assert.ok(all.body.hits.some(h => h.kind === 'tests'));

  const bad = await cli(['search', 'lvl:error boom']);
  assert.equal(bad.code, 1, 'a bad query is a plain error exit, not a 2');
  assert.match(bad.stderr, /unknown field 'lvl:' — did you mean 'level:'\? valid fields: app, kind, level, before, after/);
  assert.match(bad.stderr, /quote the token/);
});

test('CLI: `daimon searches` round-trips through the daemon', async () => {
  const saved = await cli(['searches', 'save', 'today-errors', 'level:error after:24h']);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(saved.body.saved.name, 'today-errors');

  const list = await cli(['searches', 'list']);
  assert.equal(list.body.searches.length, 1);
  assert.equal(list.body.searches[0].query, 'level:error after:24h');

  // A saved query is validated by the REAL parser at save time.
  const bad = await cli(['searches', 'save', 'broken', 'lvl:error']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown field 'lvl:'/);
  assert.equal((await cli(['searches', 'list'])).body.searches.length, 1, 'nothing was saved');

  const renamed = await cli(['searches', 'rename', 'today-errors', 'errors-today']);
  assert.equal(renamed.code, 0, renamed.stderr);
  assert.equal(renamed.body.saved.name, 'errors-today');

  const missing = await cli(['searches', 'delete', 'nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no saved search named 'nope'/);
  assert.match(missing.stderr, /errors-today/, 'the error names what IS saved');

  const gone = await cli(['searches', 'delete', 'errors-today']);
  assert.equal(gone.code, 0, gone.stderr);
  assert.equal((await cli(['searches', 'list'])).body.searches.length, 0);
});
