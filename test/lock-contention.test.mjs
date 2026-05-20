import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate ~/.daimon by overriding HOME / USERPROFILE *before* importing daimon.ts —
// daemon.ts computes LOCK_PATH at module load time from os.homedir().
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-lock-'));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

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

  test('cleanup: restore HOME/USERPROFILE', () => {
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });
}
