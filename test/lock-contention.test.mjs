import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate ~/.daimon via DAIMON_HOME (M79) — the first-class way for test
// harnesses to relocate daimon's state dir.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-lock-'));
process.env.DAIMON_HOME = fakeHome;

const { readLock, writeLock, removeLock, lockPath } = await import('../dist/daemon.js');

// Sanity: ensure we are isolated. If LOCK_PATH still points at the real ~/.daimon, abort.
if (!lockPath().startsWith(fakeHome)) {
  test('lock-contention tests cannot isolate ~/.daimon on this OS — skipping', () => {});
} else {
  test('readLock returns null when the lock file is missing', () => {
    try { fs.unlinkSync(lockPath()); } catch {}
    assert.equal(readLock(), null);
  });

  test('readLock returns null when the lock file is corrupt', () => {
    const p = lockPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid json');
    assert.equal(readLock(), null);
    try { fs.unlinkSync(p); } catch {}
  });

  test('readLock prunes a stale lock pointing at a dead PID', () => {
    const p = lockPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 0x7FFFFFFE is virtually guaranteed to be unused on a fresh CI host.
    fs.writeFileSync(p, JSON.stringify({ pid: 0x7ffffffe, apiPort: 4999, version: 'test', startedAt: Date.now(), headless: true }));
    const r = readLock();
    assert.equal(r, null);
    assert.equal(fs.existsSync(p), false);
  });

  test('parallel writeLock calls leave a single valid lock', async () => {
    const N = 10;
    await Promise.all(Array.from({ length: N }, (_, i) =>
      new Promise((resolve) => {
        try {
          writeLock({ pid: process.pid + i + 1, apiPort: 4999, version: 'test', startedAt: Date.now(), headless: true });
        } catch {}
        resolve(undefined);
      }),
    ));
    const raw = fs.readFileSync(lockPath(), 'utf8');
    // Must parse cleanly as a single JSON object — atomic rename means we never observe partial bytes.
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed.pid, 'number');
    assert.equal(parsed.apiPort, 4999);
    removeLock();
  });

  test('50 concurrent agents against the live HTTP server: one lock winner, 49 clean 409s, all <5s', async () => {
    const { Registry } = await import('../dist/registry.js');
    const { startServer } = await import('../dist/server.js');
    const config = {
      searchRoots: [], portRange: [4000, 4099], apiPort: 0, overrides: {}, autoStart: [],
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
      errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null },
    };
    const app = { name: 'web', workspaceRoot: fakeHome, workspaceType: 'vite', command: 'echo', hidden: false, tags: [] };
    const reg = new Registry(config, [app]);
    const server = startServer(reg, 0, { getConfig: () => config });
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      const N = 50;
      const t0 = performance.now();
      // Distinct agent ids hammering the same lock-gated verb concurrently.
      const lockResults = await Promise.all(Array.from({ length: N }, (_, i) =>
        fetch(`${base}/api/apps/web/stop`, { method: 'POST', headers: { 'x-daimon-agent': `torture-${i}-abcd` } })
          .then(async r => ({ status: r.status, body: await r.json() })),
      ));
      // ...and a concurrent read storm that must never deadlock against them.
      const readResults = await Promise.all(Array.from({ length: N }, (_, i) =>
        fetch(`${base}/api/apps`, { headers: { 'x-daimon-agent': `torture-r${i}-abcd` } }).then(r => r.status),
      ));
      const wallMs = performance.now() - t0;
      const winners = lockResults.filter(r => r.status === 200);
      const blocked = lockResults.filter(r => r.status === 409);
      assert.equal(winners.length, 1, `exactly one agent should win the lock (got ${winners.length})`);
      assert.equal(blocked.length, N - 1, `the rest should get 409 (got ${blocked.length})`);
      assert.ok(blocked.every(r => r.body?.error === 'locked-by-other-agent' && typeof r.body?.agent === 'string'));
      assert.ok(readResults.every(s => s === 200), 'concurrent reads all served');
      assert.ok(wallMs < 5000, `all ${N * 2} concurrent requests served in ${wallMs.toFixed(0)}ms (<5s)`);
      // Steal breaks the contention deterministically.
      const stolen = await fetch(`${base}/api/apps/web/stop?steal=1`, { method: 'POST', headers: { 'x-daimon-agent': 'torture-thief-abcd' } });
      assert.equal(stolen.status, 200);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('cleanup: restore DAIMON_HOME', () => {
    delete process.env.DAIMON_HOME;
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });
}
