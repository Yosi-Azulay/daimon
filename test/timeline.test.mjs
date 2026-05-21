import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History } from '../dist/history.js';

function tmpHistoryConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-timeline-'));
  return {
    config: { enabled: true, path: path.join(dir, 'history.sqlite'), retentionDays: 30 },
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('queryTimeline: merges events / compiles / bundles / tasks into one sorted stream', () => {
  const { config, cleanup } = tmpHistoryConfig();
  const h = new History(config);
  try {
    const now = Date.now();
    h.recordEvent({ ts: now - 5000, app: 'editor', type: 'status', from: 'stopped', to: 'starting' });
    h.recordEvent({ ts: now - 4000, app: 'editor', type: 'status', from: 'starting', to: 'compiling' });
    h.recordCompile('editor', 1200, now - 3000);
    h.recordEvent({ ts: now - 2000, app: 'editor', type: 'error-new', message: 'TS2322 ...' });
    h.recordEvent({ ts: now - 1500, app: 'editor', type: 'lint-new', message: 'F401 unused import' });
    h.recordBundle('editor', 1024, 2048, 12, now - 1000);
    h.recordTaskRun('editor', 'test', 0, 4500, 'ok', now - 500);

    h._flushForTest();
    const rows = h.queryTimeline({ app: 'editor', since: now - 10_000 });
    const kinds = rows.map(r => r.kind);
    assert.ok(kinds.includes('status'), `missing status in ${kinds.join(',')}`);
    assert.ok(kinds.includes('error'), `missing error in ${kinds.join(',')}`);
    assert.ok(kinds.includes('lint'), `missing lint in ${kinds.join(',')}`);
    assert.ok(kinds.includes('bundle'), `missing bundle in ${kinds.join(',')}`);
    assert.ok(kinds.includes('compile'), `missing compile in ${kinds.join(',')}`);
    assert.ok(kinds.includes('task'), `missing task in ${kinds.join(',')}`);
    // Sorted desc by ts.
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].ts >= rows[i].ts, `not sorted desc at ${i}: ${rows[i - 1].ts} >= ${rows[i].ts}`);
    }
  } finally {
    h.close();
    cleanup();
  }
});

test('queryTimeline: kinds filter narrows the response', () => {
  const { config, cleanup } = tmpHistoryConfig();
  const h = new History(config);
  try {
    const now = Date.now();
    h.recordEvent({ ts: now - 3000, app: 'a', type: 'status', from: 'stopped', to: 'serving' });
    h.recordEvent({ ts: now - 2000, app: 'a', type: 'error-new', message: 'boom' });
    h.recordEvent({ ts: now - 1000, app: 'a', type: 'lint-new', message: 'F401' });

    h._flushForTest();
    const onlyLint = h.queryTimeline({ since: now - 5000, kinds: new Set(['lint']) });
    assert.equal(onlyLint.length, 1);
    assert.equal(onlyLint[0].kind, 'lint');
  } finally {
    h.close();
    cleanup();
  }
});
