import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// `daimon graph` + GET /api/graph (M175, v1.15 "Atlas"): READ-ONLY view of the
// existing depends graph. Nodes carry status/health/effective-workspace/groups,
// edges come from config.depends restricted to known apps, levels mirror the
// topo order orchestrate uses, cycles are named, and the workspace filter
// prunes edges consistently. Pure visualization — nothing here may start,
// stop, or reorder an app.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-graph-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { buildGraphView, renderGraphTree, effectiveWorkspaceLabel, workspaceLabels, matchesWorkspace } = await import('../dist/graph.js');
const { startServer } = await import('../dist/server.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

// Two workspaces: 'main' is a labeled searchRoot; the second root is
// unlabeled, so its effective label is its basename ('beta').
const mainRoot = path.join(fakeHome, 'main-ws');
const betaRoot = path.join(fakeHome, 'beta');
fs.mkdirSync(mainRoot, { recursive: true });
fs.mkdirSync(betaRoot, { recursive: true });

// Seeded 6-app fixture: web → api → db chain, c1 ⇄ c2 cycle, `blocked`
// depending on the cycle, and one app in the other workspace.
const APPS = {
  web: { status: 'serving', health: 'healthy', dependsOn: ['api'], root: mainRoot, label: 'main' },
  api: { status: 'serving', health: 'healthy', dependsOn: ['db'], root: mainRoot, label: 'main' },
  db: { status: 'stopped', health: 'unknown', dependsOn: [], root: mainRoot, label: 'main' },
  c1: { status: 'error', health: 'unhealthy', dependsOn: ['c2'], root: mainRoot, label: 'main' },
  c2: { status: 'stopped', health: 'unknown', dependsOn: ['c1'], root: mainRoot, label: 'main' },
  blocked: { status: 'stopped', health: 'unknown', dependsOn: ['c1'], root: mainRoot, label: 'main' },
  beta1: { status: 'serving', health: 'healthy', dependsOn: [], root: betaRoot, label: null },
};

function makeFakeRegistry() {
  const ee = new EventEmitter();
  const summaryOf = (n) => {
    const a = APPS[n];
    if (!a) return null;
    return {
      name: n, baseName: n, status: a.status, health: a.health, port: null, url: null,
      errorCount: 0, uptimeMs: null, lastCompileMs: null, lastHealthAt: null,
      cpu: null, memMB: null, compileHistoryMs: [], tags: [], restartAttempts: 0,
      nextRestartAt: null, announcedUrl: null, lastHealthError: null, stale: false,
      bundle: null, bundleRegressionPct: null, dependsOn: [...a.dependsOn], activeEnvFile: null,
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
    errors: () => [],
    events: () => [],
    on: (e, f) => ee.on(e, f),
    off: (e, f) => ee.off(e, f),
    getHistory: () => null,
    getConfig: () => config,
  };
}

const config = {
  searchRoots: [{ path: mainRoot, label: 'main' }, betaRoot],
  portRange: [4210, 4260], apiPort: 0,
  overrides: {}, autoStart: [], profiles: {}, tags: {},
  autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
  healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
  logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
  depends: {
    web: ['api'], api: ['db'], c1: ['c2'], c2: ['c1'], blocked: ['c1'],
  },
  cascadeRestart: false,
  history: { enabled: false, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
  notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
  requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
  editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
  doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
  errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
  groups: { day: { apps: ['web', 'api'], autoStart: false } },
};

const reg = makeFakeRegistry();
const server = startServer(reg, 0, { getConfig: () => config, onShutdown: () => {} });
await new Promise(r => server.on('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

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
// Pure module

test('effectiveWorkspaceLabel: label wins, basename fallback, null when neither', () => {
  assert.equal(effectiveWorkspaceLabel('main', betaRoot), 'main');
  assert.equal(effectiveWorkspaceLabel(null, betaRoot), 'beta');
  assert.equal(effectiveWorkspaceLabel(null, null), null);
});

test('workspaceLabels: config order, labeled + basename, deduped', () => {
  assert.deepEqual(workspaceLabels(config), ['main', 'beta']);
  assert.deepEqual(
    workspaceLabels({ searchRoots: [betaRoot, { path: path.join(fakeHome, 'x', 'beta') }] }),
    ['beta'],
    'two roots sharing a basename collapse to one switcher entry',
  );
});

test('matchesWorkspace honors the effective-label rule', () => {
  assert.ok(matchesWorkspace({ workspaceLabel: null, workspaceRoot: betaRoot }, 'beta'));
  assert.ok(!matchesWorkspace({ workspaceLabel: 'main', workspaceRoot: betaRoot }, 'beta'));
});

test('buildGraphView: edges match config.depends exactly; reverse edges derived', () => {
  const view = buildGraphView(reg.list(), config);
  assert.deepEqual(
    view.edges,
    [
      { from: 'api', to: 'db' },
      { from: 'blocked', to: 'c1' },
      { from: 'c1', to: 'c2' },
      { from: 'c2', to: 'c1' },
      { from: 'web', to: 'api' },
    ],
  );
  const api = view.nodes.find(n => n.name === 'api');
  assert.deepEqual(api.dependsOn, ['db']);
  assert.deepEqual(api.dependedOnBy, ['web']);
});

test('buildGraphView: topo levels are dependencies-first, cycle members excluded', () => {
  const view = buildGraphView(reg.list(), config);
  assert.deepEqual(view.levels, [['beta1', 'db'], ['api'], ['web']]);
});

test('buildGraphView: the cycle is named; downstream apps are unordered, not silently dropped', () => {
  const view = buildGraphView(reg.list(), config);
  assert.equal(view.cycles.length, 1);
  assert.deepEqual([...view.cycles[0]].sort(), ['c1', 'c2']);
  assert.deepEqual(view.unordered, ['blocked'], 'blocked depends on the cycle — no order exists');
  assert.ok(view.nodes.find(n => n.name === 'c1').inCycle);
  assert.ok(view.nodes.find(n => n.name === 'c2').inCycle);
  assert.ok(!view.nodes.find(n => n.name === 'blocked').inCycle, 'downstream of a cycle is not IN it');
});

test('buildGraphView: group membership from v1.1 groups; health/status carried per node', () => {
  const view = buildGraphView(reg.list(), config);
  assert.deepEqual(view.nodes.find(n => n.name === 'web').groups, ['day']);
  assert.deepEqual(view.nodes.find(n => n.name === 'db').groups, []);
  const c1 = view.nodes.find(n => n.name === 'c1');
  assert.equal(c1.status, 'error');
  assert.equal(c1.health, 'unhealthy');
});

test('buildGraphView: workspace filter keeps matching nodes and prunes edges consistently', () => {
  const view = buildGraphView(reg.list(), config, 'main');
  assert.equal(view.workspace, 'main');
  assert.ok(!view.nodes.some(n => n.name === 'beta1'));
  assert.ok(view.edges.every(e => view.nodes.some(n => n.name === e.from) && view.nodes.some(n => n.name === e.to)));
  const beta = buildGraphView(reg.list(), config, 'beta');
  assert.deepEqual(beta.nodes.map(n => n.name), ['beta1'], 'basename label matches the unlabeled root');
  assert.deepEqual(beta.edges, []);
});

test('renderGraphTree: topo order top-down, cycle marked, blocked apps named', () => {
  const text = renderGraphTree(buildGraphView(reg.list(), config));
  const lines = text.split('\n');
  assert.match(lines[0], /7 apps, 5 edges/);
  const l1 = lines.findIndex(l => l.includes('level 1'));
  const l3 = lines.findIndex(l => l.includes('level 3'));
  assert.ok(l1 >= 0 && l3 > l1, 'levels render top-down');
  assert.ok(text.includes('✗ cycle:'), 'cycle marked');
  assert.match(text, /blocked by cycle: blocked/);
  assert.ok(lines.some(l => l.includes('web') && l.includes('[day]')), 'group membership rendered');
});

test('renderGraphTree: empty view degrades to a remedy, never a bare blank', () => {
  const text = renderGraphTree(buildGraphView([], config, 'beta'));
  assert.match(text, /daimon list --all|daimon init/);
});

// ---------------------------------------------------------------------------
// HTTP

test('GET /api/graph returns the full view; shape matches the pure module', async () => {
  const body = await (await fetch(`${base}/api/graph`)).json();
  assert.deepEqual(body, JSON.parse(JSON.stringify(buildGraphView(reg.list(), config))));
  assert.deepEqual(Object.keys(body).sort(), ['cycles', 'edges', 'groups', 'levels', 'nodes', 'unordered', 'workspace']);
});

test('GET /api/graph?workspace= filters; unknown label → 400 naming the known ones', async () => {
  const body = await (await fetch(`${base}/api/graph?workspace=beta`)).json();
  assert.deepEqual(body.nodes.map(n => n.name), ['beta1']);
  const res = await fetch(`${base}/api/graph?workspace=nope`);
  assert.equal(res.status, 400);
  const err = await res.json();
  assert.match(err.error, /unknown workspace/);
  assert.deepEqual(err.known, ['main', 'beta']);
  assert.match(err.hint, /main/);
});

test('GET /api/graph?cwd= scopes like /api/apps', async () => {
  const body = await (await fetch(`${base}/api/graph?cwd=${encodeURIComponent(betaRoot)}`)).json();
  assert.deepEqual(body.nodes.map(n => n.name), ['beta1']);
});

// ---------------------------------------------------------------------------
// Group start-order previews (M176): the exact plan `up <group>` executes.

test('graph view carries per-group up plans: members ∪ depends closure in topo levels', async () => {
  const body = await (await fetch(`${base}/api/graph`)).json();
  assert.equal(body.groups.length, 1);
  const day = body.groups[0];
  assert.equal(day.name, 'day');
  assert.deepEqual(day.apps, ['web', 'api'], 'declared members, config order');
  assert.deepEqual(day.levels, [['db'], ['api'], ['web']], 'closure pulls db in, dependencies first');
  assert.deepEqual(day.cyclic, []);
  assert.deepEqual(day.unknown, []);
});

test('group plans ignore the workspace filter — the order must match `up` exactly', async () => {
  const body = await (await fetch(`${base}/api/graph?workspace=beta`)).json();
  assert.equal(body.groups.length, 1, 'plans still present in a filtered view');
  assert.deepEqual(body.groups[0].levels, [['db'], ['api'], ['web']]);
});

test('CLI: daimon up <group> --dry-run outputs plannedOrder and starts nothing', async () => {
  // The CLI resolves group-vs-profile from the LOCAL config; give it one.
  const upDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-graph-up-'));
  fs.writeFileSync(path.join(upDir, 'daimon.config.json'), JSON.stringify({
    searchRoots: [], groups: { day: ['web', 'api'] },
  }), 'utf8');
  const r = await cli(['up', 'day', '--dry-run'], upDir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.body.group, 'day');
  assert.equal(r.body.dryRun, true);
  assert.deepEqual(r.body.plannedOrder, [['db'], ['api'], ['web']]);
  // The fake registry has no start(); had the CLI acted, POST /up would have
  // thrown a 500 out of the handler and surfaced in stderr — code 0 + this
  // body means the daemon was never asked to start anything.
});

// ---------------------------------------------------------------------------
// CLI

test('CLI: daimon graph --json --all equals the endpoint body', async () => {
  const viaHttp = await (await fetch(`${base}/api/graph`)).json();
  const r = await cli(['graph', '--json', '--all']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.body, viaHttp);
});

test('CLI: daimon graph --workspace beta filters; unknown label exits 1 naming labels', async () => {
  const r = await cli(['graph', '--workspace', 'beta']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.body.nodes.map(n => n.name), ['beta1']);
  const bad = await cli(['graph', '--workspace', 'nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown workspace/);
  assert.match(bad.stderr, /main/, 'remedy names the known labels');
});

test('CLI: cwd-implicit scoping — graph from inside a workspace shows only it', async () => {
  const r = await cli(['graph', '--json'], betaRoot);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.body.nodes.map(n => n.name), ['beta1']);
});

// ---------------------------------------------------------------------------
// Read-only guarantee: the graph module can never signal or spawn a process.

test('graph.ts imports nothing that can touch a process (read-only law)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'graph.ts'), 'utf8');
  for (const banned of ['child_process', 'process.kill', 'registry.start', 'registry.stop', 'registry.restart', 'treeKill']) {
    assert.ok(!src.includes(banned), `graph.ts must not reference ${banned}`);
  }
});
