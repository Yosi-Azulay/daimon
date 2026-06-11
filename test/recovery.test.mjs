import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { validateConfig, configValidationWarnings } = await import('../dist/config.js');
const { applyConfigToRegistry } = await import('../dist/configManager.js');
const { saveSessionState, loadSessionState } = await import('../dist/sessionState.js');

function tempDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `daimon-recovery-${label}-`));
  return path.join(dir, 'history.db');
}

function baseConfig(extra = {}) {
  return {
    searchRoots: [], portRange: [4000, 4099], apiPort: 4999, overrides: {}, autoStart: [],
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
    ...extra,
  };
}

function makeApp(name, root) {
  return { name, workspaceRoot: root, workspaceType: 'vite', command: 'echo', hidden: false, tags: [] };
}

test('History constructs cleanly on a fresh disk', () => {
  const p = tempDbPath('fresh');
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  assert.equal(h.archivedCorruptDbPath(), null);
  assert.ok(h.quickCheck());
  h.close();
});

test('History archives a corrupt db on open and starts fresh', () => {
  const p = tempDbPath('corrupt');
  // Seed a real SQLite db so integrity_check has structure to fail on, then
  // truncate it midway through to corrupt the page index. This is more
  // faithful to a SIGKILL-during-write than writing random bytes (which
  // better-sqlite3 will sometimes happily overwrite).
  const seed = new History({ enabled: true, path: p, retentionDays: 30 });
  for (let i = 0; i < 200; i++) seed.recordEvent({ ts: Date.now() - i, app: 'x', type: 'status' });
  seed._flushForTest?.();
  seed.close();
  // Corrupt: truncate the main file to a length that includes the SQLite
  // header (so open succeeds) but cuts off the page index (so integrity_check
  // returns non-ok). Also remove the -wal sidecar so replay can't rescue.
  // Remove WAL/SHM so SQLite cannot replay the log, then overwrite a
  // mid-database page with junk. integrity_check should report the broken
  // pointers in the page btree.
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
  const fd = fs.openSync(p, 'r+');
  const sz = fs.statSync(p).size;
  // Overwrite a chunk far past the header so the file still "looks" like a
  // SQLite db but its internal page pointers are broken.
  const offset = Math.min(sz - 256, 4096);
  fs.writeSync(fd, Buffer.alloc(256, 0xff), 0, 256, offset);
  fs.closeSync(fd);

  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  const archived = h.archivedCorruptDbPath();
  assert.ok(archived, 'expected archivedCorruptDbPath to be set');
  assert.ok(fs.existsSync(archived));
  assert.ok(h.quickCheck());
  h.close();
});

test('History close runs a WAL checkpoint (truncates -wal sidecar)', () => {
  const p = tempDbPath('wal');
  const h = new History({ enabled: true, path: p, retentionDays: 30 });
  for (let i = 0; i < 100; i++) h.recordEvent({ ts: Date.now() - i, app: 'a', type: 'status' });
  h._flushForTest?.();
  h.close();
  const walPath = p + '-wal';
  // After checkpoint+close the -wal file is either gone or empty.
  if (fs.existsSync(walPath)) {
    const sz = fs.statSync(walPath).size;
    assert.ok(sz === 0, `expected -wal truncated (got ${sz} bytes)`);
  }
});

test('History reopen preserves events written before close', () => {
  const p = tempDbPath('reopen');
  const a = new History({ enabled: true, path: p, retentionDays: 30 });
  a.recordEvent({ ts: Date.now(), app: 'web', type: 'status', from: 'starting', to: 'serving' });
  a._flushForTest?.();
  a.close();
  const b = new History({ enabled: true, path: p, retentionDays: 30 });
  const rows = b.queryEvents({ app: 'web' });
  assert.ok(rows.length >= 1);
  b.close();
});

test('History disabled config produces a no-op instance', () => {
  const h = new History({ enabled: false, path: '/nonexistent', retentionDays: 30 });
  h.recordEvent({ ts: 1, app: 'x', type: 'status' });
  assert.deepEqual(h.queryEvents({ app: 'x' }), []);
  h.close();
});

test('validateConfig softens invalid fields to defaults with warnings (M55)', () => {
  const cfg = validateConfig({
    searchRoots: 'not-an-array',
    portRange: [9000],
    apiPort: 'nope',
    autoStart: ['ok-app'],
  }, 'test-source');
  assert.deepEqual(cfg.searchRoots, []);
  assert.deepEqual(cfg.portRange, [4200, 4299]);
  assert.equal(cfg.apiPort, 4999);
  assert.deepEqual(cfg.autoStart, ['ok-app'], 'valid fields still load');
  const warnings = configValidationWarnings();
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some(w => w.includes('searchRoots')));
  assert.ok(warnings.some(w => w.includes('portRange')));
  assert.ok(warnings.some(w => w.includes('apiPort')));
  // A clean config resets the warning list.
  validateConfig({}, 'test-source');
  assert.equal(configValidationWarnings().length, 0);
});

test('soft-reload detaches orphaned apps and cleans their state (M55)', async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-orphan-a-'));
  const reg = new Registry(baseConfig(), [makeApp('keeper', rootA), makeApp('orphan', rootA)]);
  assert.deepEqual(reg.names().sort(), ['keeper', 'orphan']);
  const next = baseConfig();
  // Empty searchRoots → discovery returns nothing; both become orphans.
  const r = applyConfigToRegistry(reg, next);
  assert.deepEqual(r.removedApps.sort(), ['keeper', 'orphan']);
  await new Promise(res => setTimeout(res, 50));
  assert.deepEqual(reg.names(), [], 'orphaned entries removed from the registry');
  const cleanupEvents = reg.events({ sinceMs: 60_000 }).filter(e => e.type === 'self-warn' && (e.message || '').startsWith('orphaned app detached'));
  assert.equal(cleanupEvents.length, 2, 'a self-warn cleanup event per detached app');
});

test('session state round-trips errors, log tail, and compile history (M55)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-session-'));
  const file = path.join(root, 'session-state.json');
  const reg = new Registry(baseConfig(), [makeApp('web', root)]);
  const st = reg.getState('web');
  const now = Date.now();
  st.status = 'serving';
  st.errors.set('NG0100: boom', { message: 'NG0100: boom', count: 4, firstSeen: now - 5000, lastSeen: now });
  for (let i = 0; i < 250; i++) st.logBuffer.push({ ts: now - i, line: `line-${i}` });
  st.compileHistory.push(1200, 1300, 1250);

  saveSessionState(reg.exportSessionState(), file);
  const snap = loadSessionState(file);
  assert.ok(snap, 'snapshot loads back');
  assert.equal(snap.apps[0].logTail.length, 200, 'log tail capped at 200 lines');

  // Simulate the post-kill-9 daemon: fresh registry, same apps, restore.
  const reg2 = new Registry(baseConfig(), [makeApp('web', root)]);
  const restored = reg2.restoreSessionState(snap);
  assert.equal(restored, 1);
  const st2 = reg2.getState('web');
  assert.equal(st2.errors.get('NG0100: boom')?.count, 4, 'error history survives the restart');
  assert.equal(reg2.logs('web', { tail: 200 }).length, 200, 'log buffer survives the restart');
  assert.deepEqual(st2.compileHistory, [1200, 1300, 1250], 'compile history survives (feeds ready estimates)');
  const ev = reg2.events({ sinceMs: 60_000 }).find(e => e.type === 'status' && e.to === 'stopped');
  assert.ok(ev, 'restart leaves a visible status event');
  assert.equal(ev.from, 'serving');
});

test('loadSessionState rejects stale or malformed snapshots (M55)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-session-stale-'));
  const file = path.join(root, 'session-state.json');
  fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now() - 25 * 3600_000, apps: [] }), 'utf8');
  assert.equal(loadSessionState(file), null, 'snapshots older than 24h are ignored');
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(loadSessionState(file), null, 'malformed snapshots are ignored');
  assert.equal(loadSessionState(path.join(root, 'missing.json')), null);
});
