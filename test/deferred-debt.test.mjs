import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M72 — deferred debt: error grouping by fingerprint (module + API),
// per-app webhook scoping + override merge.

const { fingerprintOf, groupErrors } = await import('../dist/errorGroups.js');
const { effectiveWebhooks, WebhookDispatcher } = await import('../dist/webhooks.js');

// --- fingerprinting -----------------------------------------------------------

test('fingerprintOf: parsed location wins; volatile numbers are normalized away', () => {
  const parsed = { message: 'x', parsed: { file: 'src/a.ts', line: 3, col: 9, code: 'TS2304', message: 'x' }, count: 1, firstSeen: 1, lastSeen: 1 };
  assert.equal(fingerprintOf(parsed), 'src/a.ts:3:TS2304');

  const a = { message: 'Error: timeout after 5123ms (attempt 3)', count: 1, firstSeen: 1, lastSeen: 1 };
  const b = { message: 'Error: timeout after 9877ms (attempt 12)', count: 1, firstSeen: 1, lastSeen: 1 };
  assert.equal(fingerprintOf(a), fingerprintOf(b), 'numeric noise must not split groups');

  const c = { message: 'Error: connection refused', count: 1, firstSeen: 1, lastSeen: 1 };
  assert.notEqual(fingerprintOf(a), fingerprintOf(c));
});

test('groupErrors: same location across apps folds into one group', () => {
  const e = (over = {}) => ({ message: 'boom', count: 2, firstSeen: 100, lastSeen: 200, parsed: { file: 'src/a.ts', line: 3, message: 'boom' }, ...over });
  const groups = groupErrors([
    { app: 'web', errors: [e(), e({ parsed: { file: 'src/b.ts', line: 9, message: 'other' }, message: 'other', firstSeen: 50, lastSeen: 400 })] },
    { app: 'admin', errors: [e({ count: 3, firstSeen: 80, lastSeen: 300 })] },
  ]);
  assert.equal(groups.length, 2);
  const shared = groups.find(g => g.fingerprint === 'src/a.ts:3');
  assert.equal(shared.count, 5, 'counts accumulate across apps');
  assert.deepEqual(shared.apps.sort(), ['admin', 'web']);
  assert.equal(shared.firstSeen, 80);
  assert.equal(shared.lastSeen, 300);
  assert.equal(shared.instances.length, 2);
  // Sorted newest-last-seen first.
  assert.equal(groups[0].fingerprint, 'src/b.ts:9');
});

// --- GET /api/errors?group=fingerprint ----------------------------------------

test('GET /api/errors groups across apps by fingerprint', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-m72-'));
  const { startServer } = await import('../dist/server.js');
  const { Registry } = await import('../dist/registry.js');
  const cfg = {
    apiPort: 0, portRange: [4200, 4299], searchRoots: [],
    history: { enabled: false, path: '', retentionDays: 7 },
    metrics: { enabled: false }, logs: { enabled: false, dir: path.join(fakeHome, 'logs') },
  };
  const mk = n => ({ name: n, baseName: n, workspaceRoot: fakeHome, workspaceType: 'vite', command: 'echo', hidden: false, tags: [] });
  const reg = new Registry(cfg, [mk('web'), mk('admin')]);
  for (const app of ['web', 'admin']) {
    const s = reg.getState(app);
    s.errors.set('h1', { message: 'ERROR TS2304: boom', count: 2, firstSeen: 100, lastSeen: 200, parsed: { file: 'src/a.ts', line: 3, code: 'TS2304', message: 'boom' }, level: 'error' });
  }
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const grouped = await (await fetch(`${base}/api/errors?group=fingerprint`)).json();
    assert.equal(grouped.groups.length, 1);
    assert.equal(grouped.groups[0].fingerprint, 'src/a.ts:3:TS2304');
    assert.equal(grouped.groups[0].count, 4);
    assert.deepEqual(grouped.groups[0].apps.sort(), ['admin', 'web']);
    const flat = await (await fetch(`${base}/api/errors`)).json();
    assert.equal(flat.length, 2);
    assert.ok(flat.every(e => e.app === 'web' || e.app === 'admin'));
  } finally {
    await new Promise(r => server.close(r));
  }
});

// --- per-app webhooks -----------------------------------------------------------

test('effectiveWebhooks merges overrides.<app>.webhooks scoped to that app', () => {
  const merged = effectiveWebhooks({
    webhooks: [{ url: 'http://127.0.0.1:1/global' }],
    overrides: {
      'web-admin': { webhooks: [{ url: 'http://127.0.0.1:1/per-app', events: ['error'] }] },
      other: {},
    },
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].apps, undefined, 'global entry stays unscoped (all apps)');
  assert.deepEqual(merged[1].apps, ['web-admin']);
  assert.deepEqual(merged[1].events, ['error']);
});

test('webhooks[].apps scoping: only listed apps fire (local httptest)', async () => {
  const hits = [];
  const sink = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${sink.address().port}/hook`;

  const { Registry } = await import('../dist/registry.js');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-m72wh-'));
  const cfg = {
    apiPort: 0, portRange: [4200, 4299], searchRoots: [],
    history: { enabled: false, path: '', retentionDays: 7 },
    metrics: { enabled: false }, logs: { enabled: false, dir: path.join(fakeHome, 'logs') },
  };
  const mk = n => ({ name: n, baseName: n, workspaceRoot: fakeHome, workspaceType: 'vite', command: 'echo', hidden: false, tags: [] });
  const reg = new Registry(cfg, [mk('scoped'), mk('other')]);
  const dispatcher = new WebhookDispatcher(reg, [{ url, apps: ['scoped'] }]);
  try {
    reg.recordEvent({ app: 'other', type: 'error-new', message: 'not for the hook' });
    reg.recordEvent({ app: 'scoped', type: 'error-new', message: 'for the hook' });
    const deadline = Date.now() + 5000;
    while (hits.length < 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    // Give the 1/sec rate limiter one more window to prove 'other' never fires.
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(hits.length, 1, `expected exactly the scoped event, got ${JSON.stringify(hits)}`);
    assert.equal(hits[0].app ?? hits[0].event?.app, 'scoped');
  } finally {
    dispatcher.stop();
    await new Promise(r => sink.close(r));
  }
});
