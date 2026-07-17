import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// M100 — `daimon logs` filtering: ?level= / ?grep= / ?since= on the frozen
// logs route (additive params, default shape byte-identical), the same
// filters in follow (SSE) mode evaluated per line at delivery, group-logs
// level filtering, and the CLI error path for a bad regex.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-logsfilter-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');

const config = {
  searchRoots: [], portRange: [4210, 4260], apiPort: 0,
  overrides: {}, autoStart: [], profiles: {}, tags: {},
  groups: { pair: { apps: ['web', 'api'], autoStart: false } },
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
  { name: 'web', baseName: 'web', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [], workspaceLabel: 'main' },
  { name: 'api', baseName: 'api', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [], workspaceLabel: 'main' },
];

const reg = new Registry(config, apps);
const now = Date.now();
{
  const s = reg.getState('web');
  s.status = 'serving';
  // Mixed-level seed: two error, one warn, one info, two unclassified —
  // one of them OLD (2h ago) for the ?since= case.
  s.logBuffer.push({ ts: now - 2 * 3600_000, line: 'OLD ERROR from two hours ago', level: 'error' });
  s.logBuffer.push({ ts: now - 5000, line: 'ERROR  EADDRINUSE: address already in use', level: 'error' });
  s.logBuffer.push({ ts: now - 4000, line: 'WARN  chunk size exceeds limit', level: 'warn' });
  s.logBuffer.push({ ts: now - 3000, line: 'server ready on 4241', level: 'info' });
  s.logBuffer.push({ ts: now - 2000, line: 'GET / 200' });
  s.logBuffer.push({ ts: now - 1000, line: 'plain unclassified line' });
}
{
  const s = reg.getState('api');
  s.status = 'serving';
  s.logBuffer.push({ ts: now - 1500, line: 'ERROR api exploded', level: 'error' });
  s.logBuffer.push({ ts: now - 500, line: 'api humming along' });
}

const server = startServer(reg, 0, { getConfig: () => config, onShutdown: () => {} });
await new Promise(resolve => server.once('listening', resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const HDRS = { 'x-daimon-agent': 'logsfilter-suite-abcd', 'x-daimon-cwd': fakeHome };
async function http(pathname) {
  const r = await fetch(BASE + pathname, { headers: HDRS });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

test('bare /api/logs is byte-identical to the unfiltered tail (frozen shape untouched)', async () => {
  const r = await http('/api/apps/web/logs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    lines: [
      'OLD ERROR from two hours ago',
      'ERROR  EADDRINUSE: address already in use',
      'WARN  chunk size exceeds limit',
      'server ready on 4241',
      'GET / 200',
      'plain unclassified line',
    ],
  });
});

test('?level=error returns only classified-error lines; unclassified excluded', async () => {
  const r = await http('/api/apps/web/logs?level=error');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lines, [
    'OLD ERROR from two hours ago',
    'ERROR  EADDRINUSE: address already in use',
  ]);
});

test('?level composes with ?grep and ?since (AND)', async () => {
  const grep = await http('/api/apps/web/logs?level=error&grep=' + encodeURIComponent('EADDR.*'));
  assert.deepEqual(grep.body.lines, ['ERROR  EADDRINUSE: address already in use']);
  const since = await http('/api/apps/web/logs?level=error&since=30m');
  assert.deepEqual(since.body.lines, ['ERROR  EADDRINUSE: address already in use'], '2h-old error drops out of a 30m window');
  const all3 = await http('/api/apps/web/logs?level=error&since=30m&grep=' + encodeURIComponent('nothing-matches'));
  assert.deepEqual(all3.body.lines, []);
});

test('?level=warn and ?level=info hit their classified lines', async () => {
  assert.deepEqual((await http('/api/apps/web/logs?level=warn')).body.lines, ['WARN  chunk size exceeds limit']);
  assert.deepEqual((await http('/api/apps/web/logs?level=info')).body.lines, ['server ready on 4241']);
  assert.deepEqual((await http('/api/apps/web/logs?level=debug')).body.lines, []);
});

test('invalid ?level= is a 400 naming the accepted values', async () => {
  const r = await http('/api/apps/web/logs?level=fatal');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /error\|warn\|info\|debug/);
  assert.match(r.body.error, /fatal/);
});

test('group logs honor ?level= across members', async () => {
  const r = await http('/api/groups/pair/logs?level=error');
  assert.equal(r.status, 200);
  const lines = r.body.lines.map(l => `${l.app}:${l.line}`);
  assert.deepEqual(lines, [
    'web:OLD ERROR from two hours ago',
    'web:ERROR  EADDRINUSE: address already in use',
    'api:ERROR api exploded',
  ]);
});

test('follow mode: level+grep filters apply per delivered line, backlog included', async () => {
  const ctl = new AbortController();
  const res = await fetch(BASE + '/api/apps/web/logs/stream?level=error&grep=' + encodeURIComponent('ERROR'), {
    headers: HDRS, signal: ctl.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const lines = [];
  const readUntil = async wanted => {
    const deadline = Date.now() + 5000;
    while (lines.length < wanted && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const data = chunk.split('\n').find(l => l.startsWith('data: '));
        if (data) lines.push(JSON.parse(data.slice(6)));
      }
    }
  };
  // Backlog: both classified-error lines match level+grep.
  await readUntil(2);
  assert.deepEqual(lines.map(l => l.line), [
    'OLD ERROR from two hours ago',
    'ERROR  EADDRINUSE: address already in use',
  ]);
  // Live lines: a warn line and an unclassified line must NOT be delivered;
  // a matching error line must.
  reg.emit('log', { name: 'web', ts: Date.now(), line: 'WARN ERROR-adjacent but warn-classified', level: 'warn' });
  reg.emit('log', { name: 'web', ts: Date.now(), line: 'ERROR but unclassified', level: null });
  reg.emit('log', { name: 'web', ts: Date.now(), line: 'ERROR live and classified', level: 'error' });
  await readUntil(3);
  assert.equal(lines.length, 3);
  assert.equal(lines[2].line, 'ERROR live and classified');
  ctl.abort();
});

test('CLI: invalid --grep regex exits 1 with a message naming the bad pattern', async () => {
  const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  const r = await new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, 'logs', 'web', '--grep', '(unclosed', '--all'], {
      cwd: fakeHome,
      env: { ...process.env, DAIMON_PORT: String(PORT), DAIMON_NO_SPAWN: '1', DAIMON_HOME: fakeHome, NO_COLOR: '1' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 20_000);
    child.on('close', code => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /invalid grep regex/);
});

test('teardown', () => {
  server.close();
});
