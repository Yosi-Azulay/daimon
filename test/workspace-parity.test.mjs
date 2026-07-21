import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// Per-workspace filters end-to-end (M177, v1.15 "Atlas"): every read surface
// honors ?workspace= with ONE matching rule (effective label = label ??
// basename(root)), ONE unknown-label behavior (400 naming the known labels),
// and byte-identical output when the param is absent. Parameterized parity:
// filtered output == manual set intersection of unfiltered output.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-wspar-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { History } = await import('../dist/history.js');
const { startServer } = await import('../dist/server.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const now = Date.now();

// Two workspaces: 'main' labeled; 'beta' is an UNLABELED root, so it matches
// by folder basename — the treatment-of-unlabeled-apps half of the audit.
const mainRoot = path.join(fakeHome, 'main-ws');
const betaRoot = path.join(fakeHome, 'beta');
fs.mkdirSync(mainRoot, { recursive: true });
fs.mkdirSync(betaRoot, { recursive: true });

const APPS = {
  web: { label: 'main', root: mainRoot, status: 'serving', health: 'healthy' },
  api: { label: 'main', root: mainRoot, status: 'error', health: 'unhealthy' },
  b1: { label: null, root: betaRoot, status: 'serving', health: 'healthy' },
};
const MAIN_SET = new Set(['web', 'api']);
const BETA_SET = new Set(['b1']);

// Real History so search + trends parity runs against actual query paths.
const history = new History({ enabled: true, path: path.join(fakeHome, 'history.db'), retentionDays: 7 });
history.recordEvent({ ts: now - 1000, app: 'web', type: 'error-new', message: 'wombat-marker web exploded' });
history.recordEvent({ ts: now - 900, app: 'api', type: 'error-new', message: 'wombat-marker api exploded' });
history.recordEvent({ ts: now - 800, app: 'b1', type: 'error-new', message: 'wombat-marker b1 exploded' });
history.recordCompile('web', 1200, now - 700);
history.recordCompile('api', 800, now - 600);
history.recordCompile('b1', 400, now - 500);
history._flushForTest();

function makeFakeRegistry() {
  const ee = new EventEmitter();
  const summaryOf = (n) => {
    const a = APPS[n];
    if (!a) return null;
    return {
      name: n, baseName: n, status: a.status, health: a.health, port: null, url: null,
      errorCount: 1, uptimeMs: null, lastCompileMs: null, lastHealthAt: null,
      cpu: null, memMB: null, compileHistoryMs: [], tags: [], restartAttempts: 0,
      nextRestartAt: null, announcedUrl: null, lastHealthError: null, stale: false,
      bundle: null, bundleRegressionPct: null, dependsOn: [], activeEnvFile: null,
      workspaceLabel: a.label, workspaceRoot: a.root, lastChangeMs: null,
    };
  };
  return {
    names: () => Object.keys(APPS),
    list: () => Object.keys(APPS).map(summaryOf),
    summary: summaryOf,
    getApp: (n) => (APPS[n] ? { name: n, workspaceRoot: APPS[n].root } : null),
    getState: (n) => (APPS[n] ? { logBuffer: [] } : null),
    resolveByCwd: (n) => (APPS[n] ? { kind: 'unique', key: n } : { kind: 'none' }),
    errors: (n) => (APPS[n] ? [{ message: `${n} boom`, count: 1, firstSeen: now - 1000, lastSeen: now - 500, level: 'error' }] : []),
    events: () => [],
    on: (e, f) => ee.on(e, f),
    off: (e, f) => ee.off(e, f),
    getHistory: () => history,
    getConfig: () => config,
    isMuted: () => false,
    quarantineSummary: () => ({ count: 0, oldestSince: null }),
  };
}

const config = {
  searchRoots: [{ path: mainRoot, label: 'main' }, betaRoot],
  portRange: [4210, 4260], apiPort: 0,
  overrides: {}, autoStart: [], profiles: {}, tags: {},
  autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
  healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
  logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
  depends: {}, cascadeRestart: false,
  history: { enabled: true, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
  notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
  requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
  editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
  doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
  errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
  groups: {},
};

const reg = makeFakeRegistry();
const server = startServer(reg, 0, { getConfig: () => config, onShutdown: () => {} });
await new Promise(r => server.on('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); history.close(); });

function cli(args, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: cwd ?? fakeHome,
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
// Parameterized parity: filtered == manual intersection; absent == identical.

const SURFACES = [
  {
    name: '/api/apps',
    url: (ws) => `/api/apps${ws ? `?workspace=${ws}` : ''}`,
    appsOf: (body) => body.map(r => r.name),
    intersect: (body, set) => body.filter(r => set.has(r.name)),
  },
  {
    name: '/api/errors',
    url: (ws) => `/api/errors${ws ? `?workspace=${ws}` : ''}`,
    appsOf: (body) => [...new Set(body.map(r => r.app))],
    intersect: (body, set) => body.filter(r => set.has(r.app)),
  },
];

for (const s of SURFACES) {
  test(`${s.name}: filtered = unfiltered ∩ workspace members, row-for-row (labeled + basename)`, async () => {
    const unfiltered = await (await fetch(base + s.url(null))).json();
    for (const [ws, set] of [['main', MAIN_SET], ['beta', BETA_SET]]) {
      const filtered = await (await fetch(base + s.url(ws))).json();
      assert.deepEqual(filtered, s.intersect(unfiltered, set), `${s.name}?workspace=${ws}`);
      assert.ok(s.appsOf(filtered).every(a => set.has(a)));
    }
  });

  test(`${s.name}: absent param → byte-identical across calls`, async () => {
    const a = await (await fetch(base + s.url(null))).text();
    const b = await (await fetch(base + s.url(null))).text();
    assert.equal(a, b);
  });
}

test('unknown label → the SAME 400 naming known labels on every surface whose param is NEW in v1.15', async () => {
  const urls = [
    '/api/errors?workspace=nope',
    '/api/graph?workspace=nope',
    '/api/report?workspace=nope', // experimental surface since v0.13 — may adopt the error
    '/api/search?q=x&workspace=nope',
    '/api/history/trends?metrics=compile&workspace=nope',
  ];
  for (const u of urls) {
    const res = await fetch(base + u);
    assert.equal(res.status, 400, u);
    const body = await res.json();
    assert.match(body.error, /unknown workspace: nope/, u);
    assert.deepEqual(body.known, ['main', 'beta'], u);
    assert.match(body.hint, /main/, u);
  }
});

test('frozen /api/apps + stable /api/overview keep their historical unknown-label behavior (200, empty)', async () => {
  // These two accepted ?workspace= long before v1.15; their shapes and
  // status codes are additive-only forever (STABILITY law). An unknown label
  // stays a 200 with no rows / zero totals — never the new surfaces' 400.
  const apps = await fetch(`${base}/api/apps?workspace=nope`);
  assert.equal(apps.status, 200);
  assert.deepEqual(await apps.json(), []);
  const ov = await fetch(`${base}/api/overview?workspace=nope`);
  assert.equal(ov.status, 200);
  assert.equal((await ov.json()).totals.apps, 0);
});

test('/api/overview?workspace= scopes totals to the member set', async () => {
  const all = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(all.totals.apps, 3);
  const main = await (await fetch(`${base}/api/overview?workspace=main`)).json();
  assert.equal(main.totals.apps, 2);
  assert.deepEqual(Object.values(main.byStatus).flat().sort(), ['api', 'web']);
  const beta = await (await fetch(`${base}/api/overview?workspace=beta`)).json();
  assert.equal(beta.totals.apps, 1, 'basename label scopes the unlabeled root');
});

test('/api/search?workspace= : hits = unfiltered hits ∩ member apps, never a foreign hit', async () => {
  const all = await (await fetch(`${base}/api/search?q=wombat-marker`)).json();
  assert.equal(all.hits.length, 3);
  for (const [ws, set] of [['main', MAIN_SET], ['beta', BETA_SET]]) {
    const filtered = await (await fetch(`${base}/api/search?q=wombat-marker&workspace=${ws}`)).json();
    assert.deepEqual(
      filtered.hits.map(h => h.ref).sort(),
      all.hits.filter(h => set.has(h.app)).map(h => h.ref).sort(),
      `workspace=${ws}`,
    );
  }
});

test('/api/history/trends?workspace= : per-metric counts = member-row sums; absent unchanged', async () => {
  const all = await (await fetch(`${base}/api/history/trends?metrics=compile,errors&since=24h`)).json();
  assert.equal(all.metrics.compile.count, 3);
  assert.equal(all.metrics.errors.count, 3);
  const main = await (await fetch(`${base}/api/history/trends?metrics=compile,errors&since=24h&workspace=main`)).json();
  assert.equal(main.metrics.compile.count, 2);
  assert.equal(main.metrics.errors.count, 2);
  const beta = await (await fetch(`${base}/api/history/trends?metrics=compile,errors&since=24h&workspace=beta`)).json();
  assert.equal(beta.metrics.compile.count, 1);
  assert.equal(beta.metrics.errors.count, 1);
  const again = await (await fetch(`${base}/api/history/trends?metrics=compile,errors&since=24h`)).json();
  assert.deepEqual(again.metrics, all.metrics, 'absent param output unchanged');
});

test('/api/report?workspace= echoes the scope; unknown label already covered above', async () => {
  const r = await (await fetch(`${base}/api/report?workspace=beta`)).json();
  assert.equal(r.workspace, 'beta');
  const un = await (await fetch(`${base}/api/report`)).json();
  assert.equal(un.workspace, null);
});

// ---------------------------------------------------------------------------
// CLI parity

test('CLI: daimon errors --workspace <ws> equals the endpoint; unknown label exits 1 with labels', async () => {
  const viaHttp = await (await fetch(`${base}/api/errors?workspace=main`)).json();
  const r = await cli(['errors', '--workspace', 'main']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.body, viaHttp);
  const bad = await cli(['errors', '--workspace', 'nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown workspace/);
  assert.match(bad.stderr, /main/);
});

test('CLI: daimon search --workspace <ws> restricts hits', async () => {
  const r = await cli(['search', 'wombat-marker', '--workspace', 'beta']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([...new Set(r.body.hits.map(h => h.app))], ['b1']);
});

test('CLI: daimon list --workspace beta matches the unlabeled root by basename (compact AND full)', async () => {
  const compact = await cli(['list', '--workspace', 'beta', '--all']);
  assert.equal(compact.code, 0, compact.stderr);
  assert.deepEqual(compact.body.map(a => a.name), ['b1']);
  const full = await cli(['list', '--full', '--workspace', 'beta', '--all']);
  assert.equal(full.code, 0, full.stderr);
  assert.deepEqual(full.body.map(a => a.name), ['b1'], 'client-side skew re-filter must not drop basename matches');
});

test('CLI: daimon report --workspace beta carries the scope', async () => {
  const r = await cli(['report', '--workspace', 'beta']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.body.workspace, 'beta');
});
