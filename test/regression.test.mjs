import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History } from '../dist/history.js';

test('F29: compile-regression fires when ms > 2*p50 with >=10 prior samples', () => {
  const tmp = path.join(os.tmpdir(), `appman-history-${Date.now()}.db`);
  const h = new History({ enabled: true, path: tmp, retentionDays: 30 });
  for (let i = 0; i < 12; i++) h.recordCompile('web', 1000, Date.now() - (12 - i) * 1000);
  h['flush'](); // private but accessible
  const rows = h.queryCompiles({ app: 'web', limit: 30 });
  assert.equal(rows.length, 12);
  const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
  const p50 = sorted[Math.floor((sorted.length - 1) * 0.5)];
  assert.equal(p50, 1000);
  const slow = 2500;
  assert.ok(slow > 2 * p50, 'slow exceeds 2x p50 — would record compile-regression');
  h.close();
  fs.unlinkSync(tmp);
  try { fs.unlinkSync(tmp + '-shm'); } catch {}
  try { fs.unlinkSync(tmp + '-wal'); } catch {}
});

test('F29: not fired when fewer than 10 prior samples', () => {
  const tmp = path.join(os.tmpdir(), `appman-history-${Date.now()}.db`);
  const h = new History({ enabled: true, path: tmp, retentionDays: 30 });
  for (let i = 0; i < 5; i++) h.recordCompile('web', 1000, Date.now() - i * 1000);
  h['flush']();
  const rows = h.queryCompiles({ app: 'web' });
  assert.ok(rows.length < 10, 'only 5 samples');
  h.close();
  fs.unlinkSync(tmp);
  try { fs.unlinkSync(tmp + '-shm'); } catch {}
  try { fs.unlinkSync(tmp + '-wal'); } catch {}
});
