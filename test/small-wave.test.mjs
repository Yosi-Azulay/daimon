import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M79 — DAIMON_HOME relocation + `daimon logs --grep` (one-shot + live tail).

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-home-'));
process.env.DAIMON_HOME = fakeHome;

const { daimonDir, lockPath, writeLock, readLock, removeLock } = await import('../dist/daemon.js');
const { configLookupPaths } = await import('../dist/config.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { runDoctor } = await import('../dist/doctor.js');

test('DAIMON_HOME relocates the entire state dir (lock, config lookup) — real ~/.daimon untouched', () => {
  assert.equal(daimonDir(), fakeHome);
  assert.equal(lockPath(), path.join(fakeHome, 'daemon.lock'));
  assert.equal(configLookupPaths().user, path.join(fakeHome, 'config.json'));

  const realLock = path.join(os.homedir(), '.daimon', 'daemon.lock');
  const before = fs.existsSync(realLock) ? fs.statSync(realLock).mtimeMs : null;
  writeLock({ pid: process.pid, apiPort: 4999, version: 'test', startedAt: Date.now(), headless: true });
  assert.ok(fs.existsSync(path.join(fakeHome, 'daemon.lock')), 'lock written under DAIMON_HOME');
  assert.ok(readLock(), 'lock readable');
  const after = fs.existsSync(realLock) ? fs.statSync(realLock).mtimeMs : null;
  assert.equal(before, after, 'real ~/.daimon/daemon.lock untouched');
  removeLock();
  assert.equal(readLock(), null);
});

test('doctor prints the active daimon home and flags the DAIMON_HOME source', async () => {
  const cfg = {
    searchRoots: [], portRange: [4210, 4290], apiPort: 4999, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: '', retentionDays: 0 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
  };
  const r = await runDoctor(cfg, []);
  const home = r.checks.find(c => c.name === 'daimon-home');
  assert.ok(home, 'daimon-home check present');
  assert.equal(home.ok, true);
  assert.ok(home.detail.includes(fakeHome), 'prints the active home');
  assert.match(home.detail, /from DAIMON_HOME/, 'notes the env source');
});

const cfg = {
  searchRoots: [], portRange: [4210, 4290], apiPort: 0, overrides: {}, autoStart: [],
  profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
  healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
  logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
  depends: {}, cascadeRestart: false,
  history: { enabled: false, path: '', retentionDays: 0 },
  notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
  requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
  editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
  doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
  errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
};
const app = { name: 'web', baseName: 'web', workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] };

test('logs --grep: one-shot filter, invalid regex 400, oversized pattern 400', async () => {
  const reg = new Registry(cfg, [app]);
  const state = reg.getState('web');
  const now = Date.now();
  state.logBuffer.push(
    { ts: now - 3, line: 'GET /health 200' },
    { ts: now - 2, line: 'ERROR: connection refused' },
    { ts: now - 1, line: 'listening on 3000' },
  );
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const filtered = await fetch(`${base}/api/apps/web/logs?grep=error`).then(r => r.json());
    assert.deepEqual(filtered.lines, ['ERROR: connection refused'], 'case-insensitive regex filter');
    const bad = await fetch(`${base}/api/apps/web/logs?grep=` + encodeURIComponent('[unclosed'));
    assert.equal(bad.status, 400);
    const huge = await fetch(`${base}/api/apps/web/logs?grep=` + encodeURIComponent('a'.repeat(600)));
    assert.equal(huge.status, 400, 'length-capped like custom profile patterns');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('logs --grep: filters a live stream (SSE tail only passes matching lines)', async () => {
  const reg = new Registry(cfg, [app]);
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ac = new AbortController();
    const res = await fetch(`${base}/api/apps/web/logs/stream?grep=ERR`, { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const got = [];
    const consume = (async () => {
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop() ?? '';
        for (const c of chunks) {
          const data = c.split('\n').find(l => l.startsWith('data: '));
          if (data) got.push(JSON.parse(data.slice(6)).line);
        }
      }
    })().catch(() => {});
    await new Promise(r => setTimeout(r, 150));
    reg.emit('log', { name: 'web', ts: Date.now(), line: 'plain info line' });
    reg.emit('log', { name: 'web', ts: Date.now(), line: 'ERR: kaboom' });
    reg.emit('log', { name: 'web', ts: Date.now(), line: 'another quiet line' });
    reg.emit('log', { name: 'other', ts: Date.now(), line: 'ERR from another app' });
    await new Promise(r => setTimeout(r, 400));
    ac.abort();
    await consume;
    assert.deepEqual(got, ['ERR: kaboom'], `stream passed only the matching line for this app (got ${JSON.stringify(got)})`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('cleanup', () => {
  delete process.env.DAIMON_HOME;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});
