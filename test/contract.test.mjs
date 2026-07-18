import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Golden-shape contract suite (M87). Every `frozen` surface (STABILITY.md) is
// pinned by a snapshot in test/fixtures/contract/ recording its response's
// KEY SETS + TYPES (never values). The rules:
//
//   - a frozen surface WITHOUT a snapshot fails this suite (fixture-gating,
//     same convention as frameworks/testrunners fixtures);
//   - a snapshot key missing from a live response, or changing type, fails —
//     forever (frozen = additive-only: NEW keys are allowed, lost keys never);
//   - regenerate snapshots with UPDATE_CONTRACT_SNAPSHOTS=1 after an
//     intentional ADDITIVE change, and hand-review the diff before committing.
//
// The harness is fully synthetic: a Registry seeded with deterministic state
// behind a real startServer() on an ephemeral port, DAIMON_HOME-isolated. CLI
// verbs run dist/cli.js as a subprocess against that server; MCP tools run
// over an in-memory transport pointed at it. No real daemon, ever.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-contract-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const UPDATE = process.env.UPDATE_CONTRACT_SNAPSHOTS === '1';
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contract');
if (UPDATE) fs.mkdirSync(fixturesDir, { recursive: true });

const { lockPath } = await import('../dist/daemon.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { CLI_SUBCOMMANDS } = await import('../dist/cliSurface.js');
const { HTTP_ENDPOINTS } = await import('../dist/httpSurface.js');
const { CONFIG_KEY_STABILITY } = await import('../dist/config.js');
const { EVENT_KIND_STABILITY } = await import('../dist/types.js');

// ---------------------------------------------------------------------------
// Shape helpers. A shape is: a type string ('string' | 'number' | 'boolean' |
// 'null', unions like 'number|null'), an object map { key: shape }, or an
// array marker { $array: elemShape | 'unknown' }.

function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return { $array: 'unknown' };
    // Element shape = intersection of all elements' shapes with type unions,
    // so optional per-element keys don't get pinned as guaranteed.
    let elem = shapeOf(v[0]);
    for (const x of v.slice(1)) elem = mergeShapes(elem, shapeOf(x));
    return { $array: elem };
  }
  const t = typeof v;
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = shapeOf(v[k]);
    return out;
  }
  return t;
}

function mergeShapes(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return [...new Set([...a.split('|'), ...b.split('|')])].sort().join('|');
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if ('$array' in a || '$array' in b) {
      if (!('$array' in a) || !('$array' in b)) return 'mixed';
      if (a.$array === 'unknown') return b;
      if (b.$array === 'unknown') return a;
      return { $array: mergeShapes(a.$array, b.$array) };
    }
    const out = {};
    for (const k of Object.keys(a)) {
      if (k in b) out[k] = mergeShapes(a[k], b[k]); // intersection of keys
    }
    return out;
  }
  return 'mixed';
}

// Assert `actual` is compatible with `snapshot`: every snapshot key exists
// with a matching type; EXTRA keys in actual are fine (additive-only rule).
function assertCompatible(snapshot, actual, where) {
  if (typeof snapshot === 'string') {
    if (snapshot === 'mixed' || snapshot === 'unknown') return;
    const t = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
    assert.ok(
      snapshot.split('|').includes(t),
      `${where}: expected type ${snapshot}, got ${t} (frozen shape — see STABILITY.md)`,
    );
    return;
  }
  if ('$array' in snapshot) {
    assert.ok(Array.isArray(actual), `${where}: expected array, got ${actual === null ? 'null' : typeof actual}`);
    if (snapshot.$array === 'unknown') return;
    for (let i = 0; i < actual.length; i++) assertCompatible(snapshot.$array, actual[i], `${where}[${i}]`);
    return;
  }
  assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `${where}: expected object, got ${actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual}`);
  for (const k of Object.keys(snapshot)) {
    assert.ok(k in actual, `${where}.${k}: key missing from a frozen surface (frozen = additive-only; see STABILITY.md)`);
    assertCompatible(snapshot[k], actual[k], `${where}.${k}`);
  }
}

const observed = new Map(); // fixtureFile -> { surface, cases: { name: shape } }
const testedFixtures = new Set();

function checkCase(fixtureFile, surface, caseName, value) {
  testedFixtures.add(fixtureFile);
  const shape = shapeOf(value);
  if (UPDATE) {
    const rec = observed.get(fixtureFile) ?? { surface, note: 'Golden shape (key sets + types, never values). Regenerate with UPDATE_CONTRACT_SNAPSHOTS=1 and hand-review: keys may be ADDED, never removed or retyped.', cases: {} };
    rec.cases[caseName] = shape;
    observed.set(fixtureFile, rec);
    return;
  }
  const p = path.join(fixturesDir, fixtureFile);
  assert.ok(fs.existsSync(p), `missing contract snapshot ${fixtureFile} for frozen surface "${surface}" — run UPDATE_CONTRACT_SNAPSHOTS=1 node --test test/contract.test.mjs and review`);
  const fixture = JSON.parse(fs.readFileSync(p, 'utf8'));
  const snap = fixture.cases?.[caseName];
  assert.ok(snap, `snapshot ${fixtureFile} has no case "${caseName}" — regenerate with UPDATE_CONTRACT_SNAPSHOTS=1`);
  assertCompatible(snap, value, `${surface} [${caseName}]`);
}

// ---------------------------------------------------------------------------
// Synthetic harness.

const config = {
  searchRoots: [], portRange: [4210, 4260], apiPort: 0,
  overrides: {}, autoStart: [], profiles: { fullstack: ['web', 'idle'] }, tags: {},
  autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
  healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
  logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
  depends: {}, cascadeRestart: false,
  history: { enabled: false, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
  notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
  requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
  editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
  doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
  errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
};
const apps = [
  { name: 'web', baseName: 'web', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: ['frontend'], workspaceLabel: 'main' },
  { name: 'idle', baseName: 'idle', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [], workspaceLabel: 'main' },
  // One spawnable app per surface block (HTTP / CLI / MCP): the 30s soft-lock
  // is per-app+agent, and each block presents a different agent id.
  { name: 'child', baseName: 'child', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'node -e "setInterval(()=>{},1000)"', hidden: false, tags: [], workspaceLabel: 'main' },
  { name: 'child2', baseName: 'child2', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'node -e "setInterval(()=>{},1000)"', hidden: false, tags: [], workspaceLabel: 'main' },
  { name: 'child3', baseName: 'child3', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'node -e "setInterval(()=>{},1000)"', hidden: false, tags: [], workspaceLabel: 'main' },
];

const reg = new Registry(config, apps);
// Seed deterministic state: `web` is serving+healthy with parsed + unparsed
// errors, a short log tail, and a status event — every optional-but-usual
// field a consumer scripts against.
{
  const s = reg.getState('web');
  s.status = 'serving';
  s.port = 4241;
  s.pid = 4242;
  s.startedAt = Date.now() - 60_000;
  s.lastCompileMs = 1234;
  s.logBuffer.push({ ts: Date.now() - 5000, line: 'server listening on 4241' });
  s.logBuffer.push({ ts: Date.now() - 4000, line: 'GET / 200' });
  s.logBuffer.push({ ts: Date.now() - 3000, line: 'ERROR boom at src/app.ts:3:7' });
  s.errors.set('parsed', {
    message: "src/app.ts(3,7): error TS2304: Cannot find name 'boom'.",
    count: 2, firstSeen: Date.now() - 5000, lastSeen: Date.now() - 1000, level: 'error',
    parsed: { file: 'src/app.ts', line: 3, col: 7, code: 'TS2304', message: "Cannot find name 'boom'.", tool: 'typescript' },
  });
  s.errors.set('plain', {
    message: 'something exploded without a location',
    count: 1, firstSeen: Date.now() - 2000, lastSeen: Date.now() - 500, level: 'error',
  });
  reg.recordEvent({ app: 'web', type: 'status', from: 'compiling', to: 'serving', message: 'compiled cleanly' });
  reg.setHealth('web', 'healthy');
}

const server = startServer(reg, 0, { getConfig: () => config, onShutdown: () => {} });
await new Promise(resolve => server.once('listening', resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.DAIMON_PORT = String(PORT);

// Minimal local config so CLI subprocesses (export-config) resolve one.
fs.writeFileSync(path.join(fakeHome, 'daimon.config.json'), '{}\n', 'utf8');

const HDRS = { 'x-daimon-agent': 'contract-suite-abcd', 'x-daimon-cwd': fakeHome };
async function http(method, pathname) {
  const r = await fetch(BASE + pathname, { method, headers: HDRS });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
// Async on purpose: the daemon the CLI talks to runs in THIS process, so a
// spawnSync here would block the event loop and deadlock every CLI call.
function cli(...args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: fakeHome,
      env: { ...process.env, DAIMON_PORT: String(PORT), DAIMON_NO_SPAWN: '1', DAIMON_HOME: fakeHome, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 30_000);
    child.on('close', code => {
      clearTimeout(killer);
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      let body = null;
      try { body = JSON.parse(line); } catch {}
      resolve({ status: code, body, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Coverage gate: every frozen surface must map to a fixture this suite writes
// or verifies. Filenames derive from the catalogs, so a NEW frozen surface
// fails here until it gets both a harness case and a snapshot.

const slug = s => s.replace(/^\//, '').replace(/[/:]+/g, '-').replace(/-+/g, '-').toLowerCase();
const FROZEN_HTTP = HTTP_ENDPOINTS.filter(e => e.stability === 'frozen');
const FROZEN_CLI = CLI_SUBCOMMANDS.filter(c => c.stability === 'frozen');
const expectedFixtures = new Set([
  ...FROZEN_HTTP.map(e => `http-${e.method.toLowerCase()}-${slug(e.path)}.json`),
  ...FROZEN_CLI.map(c => `cli-${c.name.replace(/\s+/g, '-')}.json`),
  'config-keys.json',
  'event-kinds.json',
  // MCP fixtures are asserted in the MCP block below against the live catalog.
]);

if (!lockPath().startsWith(fakeHome)) {
  test('contract suite cannot isolate ~/.daimon on this OS — skipping', () => {});
} else {

  // ── HTTP: frozen endpoint shapes ──────────────────────────────────────────

  test('http contract: GET /api/apps (compact, full, explain)', async () => {
    const f = 'http-get-api-apps.json';
    const compact = await http('GET', '/api/apps');
    assert.equal(compact.status, 200);
    checkCase(f, 'GET /api/apps', 'compact', compact.body);
    const full = await http('GET', '/api/apps?format=full');
    assert.equal(full.status, 200);
    checkCase(f, 'GET /api/apps', 'full', full.body);
    const explain = await http('GET', '/api/apps?explain=1');
    assert.equal(explain.status, 200);
    checkCase(f, 'GET /api/apps', 'explain', explain.body);
    // M87 last-call fix: server-side filters keep the compact shape.
    const tagged = await http('GET', '/api/apps?tag=frontend');
    assert.equal(tagged.body.length, 1);
    assert.equal(tagged.body[0].name, 'web');
    assert.ok(!('tags' in tagged.body[0]), 'tag filter must not switch to the full shape');
    const ws = await http('GET', '/api/apps?workspace=main');
    assert.equal(ws.body.length, 5);
  });

  test('http contract: GET /api/apps/:name (compact, full)', async () => {
    const f = 'http-get-api-apps-name.json';
    const compact = await http('GET', '/api/apps/web');
    assert.equal(compact.status, 200);
    assert.ok('uptimeMs' in compact.body && !('uptime' in compact.body), 'M87 rename: compact status carries uptimeMs');
    checkCase(f, 'GET /api/apps/:name', 'compact', compact.body);
    const full = await http('GET', '/api/apps/web?format=full');
    assert.equal(full.status, 200);
    checkCase(f, 'GET /api/apps/:name', 'full', full.body);
  });

  test('http contract: GET /api/apps/:name/errors (+ since-last)', async () => {
    const f = 'http-get-api-apps-name-errors.json';
    const compact = await http('GET', '/api/apps/web/errors');
    assert.equal(compact.status, 200);
    assert.equal(compact.body.length, 2);
    checkCase(f, 'GET /api/apps/:name/errors', 'compact', compact.body);
    const full = await http('GET', '/api/apps/web/errors?format=full');
    checkCase(f, 'GET /api/apps/:name/errors', 'full', full.body);
    const sl = await http('GET', '/api/apps/web/errors/since-last?client=contract');
    assert.equal(sl.status, 200);
    checkCase('http-get-api-apps-name-errors-since-last.json', 'GET /api/apps/:name/errors/since-last', 'compact', sl.body);
  });

  test('http contract: GET /api/apps/:name/logs (+ stream first event)', async () => {
    const logs = await http('GET', '/api/apps/web/logs?tail=10');
    assert.equal(logs.status, 200);
    checkCase('http-get-api-apps-name-logs.json', 'GET /api/apps/:name/logs', 'default', logs.body);

    // SSE stream: the initial tail replays immediately; read the first data
    // frame and pin its payload shape.
    const ctl = new AbortController();
    const res = await fetch(BASE + '/api/apps/web/logs/stream', { headers: HDRS, signal: ctl.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    ctl.abort();
    const text = new TextDecoder().decode(value);
    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    assert.ok(dataLine, 'stream should replay the tail immediately');
    checkCase('http-get-api-apps-name-logs-stream.json', 'GET /api/apps/:name/logs/stream', 'event', JSON.parse(dataLine.slice(6)));
  });

  test('http contract: GET /api/apps/:name/wait', async () => {
    const r = await http('GET', '/api/apps/web/wait?until=serving&timeout=2');
    assert.equal(r.status, 200);
    assert.equal(r.body.timedOut, false);
    checkCase('http-get-api-apps-name-wait.json', 'GET /api/apps/:name/wait', 'reached', r.body);
    // v0.14 additive fix: timeoutMs accepted alongside legacy seconds.
    const ms = await http('GET', '/api/apps/web/wait?until=serving&timeoutMs=2000');
    assert.equal(ms.body.timedOut, false);
  });

  test('http contract: GET /api/events', async () => {
    const r = await http('GET', '/api/events?since=1h');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body) && r.body.length >= 1);
    checkCase('http-get-api-events.json', 'GET /api/events', 'default', r.body);
  });

  test('http contract: GET /api/config + GET /api/signature', async () => {
    const cfg = await http('GET', '/api/config');
    assert.equal(cfg.status, 200);
    checkCase('http-get-api-config.json', 'GET /api/config', 'default', cfg.body);
    const sig = await http('GET', '/api/signature');
    assert.equal(sig.status, 200);
    assert.equal(sig.body.daimon, true);
    checkCase('http-get-api-signature.json', 'GET /api/signature', 'default', sig.body);
  });

  // Experimental tier, but snapshot-pinned anyway (M111): the export bundle is
  // a CONSUMED FORMAT — schemaVersion evolves additive-only from day one, so
  // its envelope gets the same golden-shape treatment as a frozen surface.
  test('http contract: GET /api/export (v1.4 bundle envelope)', async () => {
    const r = await http('GET', '/api/export?since=24h');
    assert.equal(r.status, 200);
    assert.equal(r.body.schemaVersion, 1, 'schemaVersion 1 — bump only with an additive migration note');
    assert.deepEqual(
      Object.keys(r.body.sections).sort(),
      ['compiles', 'crashes', 'errorGroups', 'events', 'report', 'testRuns'],
      'the section list is closed — in particular, no raw log-line section may ever appear',
    );
    checkCase('http-get-api-export.json', 'GET /api/export', 'default', r.body);
  });

  test('http contract: POST start/stop/restart', async () => {
    const started = await http('POST', '/api/apps/child/start');
    assert.equal(started.status, 200);
    assert.equal(started.body.ok, true);
    checkCase('http-post-api-apps-name-start.json', 'POST /api/apps/:name/start', 'started', started.body);

    const restarted = await http('POST', '/api/apps/child/restart?steal=1');
    assert.equal(restarted.status, 200);
    checkCase('http-post-api-apps-name-restart.json', 'POST /api/apps/:name/restart', 'restarted', restarted.body);

    const stopped = await http('POST', '/api/apps/child/stop?steal=1');
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.ok, true);
    checkCase('http-post-api-apps-name-stop.json', 'POST /api/apps/:name/stop', 'stopped', stopped.body);
  });

  // ── CLI: frozen verb output shapes (dist/cli.js subprocess) ───────────────

  test('cli contract: list (compact, full, explain)', async () => {
    const compact = await cli('list');
    assert.equal(compact.status, 0, compact.stderr);
    checkCase('cli-list.json', 'daimon list', 'compact', compact.body);
    const full = await cli('list', '--full');
    checkCase('cli-list.json', 'daimon list', 'full', full.body);
    const explain = await cli('list', '--explain');
    checkCase('cli-list.json', 'daimon list', 'explain', explain.body);
    // M87 last-call fix: filters keep the compact shape (and --compact works).
    const tagged = await cli('list', '--tag', 'frontend');
    assert.equal(tagged.body.length, 1, 'tag filter still filters');
    assert.ok(!('tags' in tagged.body[0]), 'tag filter no longer switches to full shape');
  });

  test('cli contract: status (compact, full)', async () => {
    const compact = await cli('status', 'web');
    assert.equal(compact.status, 0, compact.stderr);
    assert.ok('uptimeMs' in compact.body && !('uptime' in compact.body), 'M87 rename: uptimeMs');
    checkCase('cli-status.json', 'daimon status', 'compact', compact.body);
    const full = await cli('status', 'web', '--full');
    checkCase('cli-status.json', 'daimon status', 'full', full.body);
  });

  test('cli contract: errors (compact, full)', async () => {
    const compact = await cli('errors', 'web');
    assert.equal(compact.status, 0, compact.stderr);
    checkCase('cli-errors.json', 'daimon errors', 'compact', compact.body);
    const full = await cli('errors', 'web', '--full');
    checkCase('cli-errors.json', 'daimon errors', 'full', full.body);
  });

  test('cli contract: logs / wait / events', async () => {
    const logs = await cli('logs', 'web', '--tail', '5');
    assert.equal(logs.status, 0, logs.stderr);
    checkCase('cli-logs.json', 'daimon logs', 'default', logs.body);
    const wait = await cli('wait', 'web', '--until', 'serving', '--timeout', '2s');
    assert.equal(wait.status, 0, wait.stderr);
    checkCase('cli-wait.json', 'daimon wait', 'reached', wait.body);
    const events = await cli('events', '--since', '1h');
    assert.equal(events.status, 0, events.stderr);
    checkCase('cli-events.json', 'daimon events', 'default', events.body);
  });

  test('cli contract: start/stop/restart', async () => {
    // Every cli() run is a fresh process = a fresh agent id, so follow-up
    // verbs pass --steal to cross the previous invocation's soft-lock.
    const started = await cli('start', 'child2');
    assert.equal(started.status, 0, started.stderr);
    checkCase('cli-start.json', 'daimon start', 'started', started.body);
    const restarted = await cli('restart', 'child2', '--steal');
    assert.equal(restarted.status, 0, restarted.stderr);
    checkCase('cli-restart.json', 'daimon restart', 'restarted', restarted.body);
    const stopped = await cli('stop', 'child2', '--steal');
    assert.equal(stopped.status, 0, stopped.stderr);
    checkCase('cli-stop.json', 'daimon stop', 'stopped', stopped.body);
  });

  test('cli contract: daemon status (stopped + running)', async () => {
    const stopped = await cli('daemon', 'status');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.body.running, false);
    checkCase('cli-daemon.json', 'daimon daemon', 'status-stopped', stopped.body);
    // Fake a live lock (this test process's pid passes the liveness probe).
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, apiPort: PORT, version: '0.0.0-contract', startedAt: Date.now() - 1000, headless: true }));
    try {
      const running = await cli('daemon', 'status');
      assert.equal(running.body.running, true);
      assert.ok('uptimeMs' in running.body && !('uptime' in running.body), 'M87 rename: uptimeMs');
      checkCase('cli-daemon.json', 'daimon daemon', 'status-running', running.body);
    } finally {
      fs.rmSync(lockPath(), { force: true });
    }
  });

  test('cli contract: export-config', async () => {
    const r = await cli('export-config');
    assert.equal(r.status, 0, r.stderr);
    checkCase('cli-export-config.json', 'daimon export-config', 'default', r.body);
  });

  // ── MCP: frozen tool result shapes over an in-memory transport ────────────

  test('mcp contract: frozen tool result shapes', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildServer, MCP_TOOL_STABILITY } = await import('../dist/mcp.js');

    const mcpServer = buildServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    const client = new Client({ name: 'contract', version: '0.0.0' });
    await client.connect(ct);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(t => t.name).sort(),
      Object.keys(MCP_TOOL_STABILITY).sort(),
      'src/mcp.ts MCP_TOOL_STABILITY catalog must exactly match the registered tools',
    );

    const callShape = async (fixture, name, args, caseName = 'default') => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name} should succeed against the synthetic daemon: ${result.content?.[0]?.text}`);
      const body = JSON.parse(result.content[0].text);
      checkCase(fixture, `mcp ${name}`, caseName, body);
      return body;
    };

    await callShape('mcp-list_apps.json', 'list_apps', {});
    await callShape('mcp-list_apps_full.json', 'list_apps_full', {});
    const st1 = await callShape('mcp-get_status.json', 'get_status', { name: 'web', cwd: fakeHome });
    assert.ok('uptimeMs' in st1 && !('uptime' in st1), 'M87 rename: uptimeMs in MCP get_status');
    await callShape('mcp-get_status_full.json', 'get_status_full', { name: 'web', cwd: fakeHome });
    await callShape('mcp-get_errors.json', 'get_errors', { name: 'web', cwd: fakeHome });
    await callShape('mcp-get_logs.json', 'get_logs', { name: 'web', tail: 5, cwd: fakeHome });
    await callShape('mcp-wait_for_app.json', 'wait_for_app', { name: 'web', until: 'serving', timeout: 2 });
    await callShape('mcp-start_app.json', 'start_app', { name: 'child3', cwd: fakeHome });
    await callShape('mcp-restart_app.json', 'restart_app', { name: 'child3', cwd: fakeHome });
    await callShape('mcp-stop_app.json', 'stop_app', { name: 'child3', cwd: fakeHome });

    for (const [name, tier] of Object.entries(MCP_TOOL_STABILITY)) {
      if (tier !== 'frozen') continue;
      assert.ok(testedFixtures.has(`mcp-${name}.json`), `frozen MCP tool ${name} has no golden-shape case in this suite`);
    }
    await client.close();
  });

  // ── Config keys + event kinds: frozen names can never disappear ───────────

  test('contract: frozen config keys and event kinds persist', async () => {
    testedFixtures.add('config-keys.json');
    testedFixtures.add('event-kinds.json');
    if (UPDATE) {
      observed.set('config-keys.json', {
        surface: 'config keys (src/config.ts CONFIG_KEY_STABILITY)',
        note: 'Frozen config keys — may NEVER be removed or demoted. Additive keys go in CONFIG_KEY_STABILITY with their own tier.',
        cases: { frozen: Object.entries(CONFIG_KEY_STABILITY).filter(([, t]) => t === 'frozen').map(([k]) => k).sort() },
      });
      observed.set('event-kinds.json', {
        surface: 'event kinds (src/types.ts EVENT_KIND_STABILITY)',
        note: 'Frozen event kinds — may NEVER be removed or demoted.',
        cases: { frozen: Object.entries(EVENT_KIND_STABILITY).filter(([, t]) => t === 'frozen').map(([k]) => k).sort() },
      });
      return;
    }
    const cfgFix = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'config-keys.json'), 'utf8'));
    for (const key of cfgFix.cases.frozen) {
      assert.equal(CONFIG_KEY_STABILITY[key], 'frozen', `config key "${key}" was frozen and may not be removed or demoted`);
    }
    const evFix = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'event-kinds.json'), 'utf8'));
    for (const kind of evFix.cases.frozen) {
      assert.equal(EVENT_KIND_STABILITY[kind], 'frozen', `event kind "${kind}" was frozen and may not be removed or demoted`);
    }
  });

  // ── shutdown endpoint last (harmless: onShutdown is a noop here) ──────────

  test('http contract: POST /api/shutdown', async () => {
    const r = await http('POST', '/api/shutdown');
    assert.equal(r.status, 200);
    checkCase('http-post-api-shutdown.json', 'POST /api/shutdown', 'default', r.body);
  });

  // ── fixture-gating: every frozen surface has a snapshot + a harness case ──

  test('contract coverage: every frozen surface is snapshotted', async () => {
    // Cleanup + snapshot-writing FIRST so an earlier failed surface test can't
    // leave children running or discard the shapes that did get observed.
    await reg.stopAll();
    server.close();
    if (UPDATE) {
      for (const [file, rec] of observed) {
        fs.writeFileSync(path.join(fixturesDir, file), JSON.stringify(rec, null, 2) + '\n', 'utf8');
      }
      console.log(`[contract] wrote ${observed.size} snapshots to ${fixturesDir}`);
    }
    for (const f of expectedFixtures) {
      assert.ok(testedFixtures.has(f), `frozen surface fixture ${f} has no harness case in contract.test.mjs — add one (fixture-gating)`);
      if (!UPDATE) {
        assert.ok(fs.existsSync(path.join(fixturesDir, f)), `missing snapshot ${f} — run UPDATE_CONTRACT_SNAPSHOTS=1 node --test test/contract.test.mjs and review the diff`);
      }
    }
    // Tier sanity across all five catalogs.
    for (const c of CLI_SUBCOMMANDS) {
      assert.ok(['frozen', 'stable', 'experimental'].includes(c.stability), `CLI verb ${c.name} missing a valid stability tier`);
    }
    for (const e of HTTP_ENDPOINTS) {
      assert.ok(['frozen', 'stable', 'experimental'].includes(e.stability), `HTTP ${e.method} ${e.path} missing a valid stability tier`);
    }
    for (const [k, t] of Object.entries(CONFIG_KEY_STABILITY)) {
      assert.ok(['frozen', 'stable', 'experimental'].includes(t), `config key ${k} missing a valid tier`);
    }
    for (const [k, t] of Object.entries(EVENT_KIND_STABILITY)) {
      assert.ok(['frozen', 'stable', 'experimental'].includes(t), `event kind ${k} missing a valid tier`);
    }
  });
}
