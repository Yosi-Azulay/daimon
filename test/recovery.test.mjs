import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { History } = await import('../dist/history.js');

function tempDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `daimon-recovery-${label}-`));
  return path.join(dir, 'history.db');
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
