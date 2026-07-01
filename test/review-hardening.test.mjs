import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Raw request helper so we can set the Host header (fetch/undici forbids it).
function rawRequest(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, res => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.end();
  });
}

// Regression coverage for the v0.10.x review-hardening pass. Tests the pure
// shell-safety guards and the server-level CSRF / DNS-rebinding gate.

// Isolate ~/.daimon before importing modules that read it at load time.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-harden-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { isSafeAppName, isSafeTaskName, isSafeTaskArg, assertSafeCommandParts } = await import('../dist/shellSafe.js');

test('isSafeAppName accepts real project names', () => {
  for (const n of ['web', 'my-app', 'admin.web', 'pkg_1', '@scope/app']) {
    assert.equal(isSafeAppName(n), true, `expected ${n} to be safe`);
  }
});

test('isSafeAppName rejects shell-injection names', () => {
  for (const n of ['app && calc.exe', 'app; rm -rf /', 'a`whoami`', 'a$(id)', 'a b', 'a|b', '']) {
    assert.equal(isSafeAppName(n), false, `expected ${n} to be rejected`);
  }
});

test('isSafeTaskName allows nx target syntax but rejects metacharacters', () => {
  assert.equal(isSafeTaskName('build'), true);
  assert.equal(isSafeTaskName('app:e2e'), true);
  assert.equal(isSafeTaskName('build; echo hi'), false);
  assert.equal(isSafeTaskName('$(id)'), false);
});

test('isSafeTaskArg rejects shell metacharacters', () => {
  assert.equal(isSafeTaskArg('--coverage'), true);
  assert.equal(isSafeTaskArg('src/app'), true);
  assert.equal(isSafeTaskArg('; calc.exe'), false);
  assert.equal(isSafeTaskArg('`whoami`'), false);
  assert.equal(isSafeTaskArg('$(id)'), false);
  assert.equal(isSafeTaskArg('a|b'), false);
});

test('assertSafeCommandParts throws on any unsafe part', () => {
  assert.doesNotThrow(() => assertSafeCommandParts('web', 'test', ['--watch']));
  assert.throws(() => assertSafeCommandParts('web && calc', 'test', []));
  assert.throws(() => assertSafeCommandParts('web', 'test; id', []));
  assert.throws(() => assertSafeCommandParts('web', 'test', ['; rm -rf /']));
});

// --- audit field escaping -------------------------------------------------
const { appendAuditEntry, parseAuditLine } = await import('../dist/audit.js');

test('audit fields cannot inject extra columns via TAB in cwd', () => {
  // A cwd carrying tabs + a fake agent segment must not forge the agent column.
  appendAuditEntry('127.0.0.1', {}, { a: 1 }, ['apiPort'], '/proj\t/evil\tforged-agent', 'real-agent');
  const logPath = path.join(fakeHome, '.daimon', 'audit.log');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const parsed = parseAuditLine(lines[lines.length - 1]);
  assert.equal(parsed.agent, 'real-agent', 'agent column must not be overwritten by injected tabs');
  assert.ok(!parsed.cwd.includes('\t'), 'cwd must not contain raw tabs');
});

// --- CSRF / DNS-rebinding gate -------------------------------------------
const { startServer } = await import('../dist/server.js');
const { Registry } = await import('../dist/registry.js');

const config = {
  apiPort: 0, portRange: [4200, 4299], history: { enabled: false, path: '', retentionDays: 7 },
  metrics: { enabled: false }, logs: { dir: path.join(fakeHome, 'logs') }, searchRoots: [],
};
const app = { name: 'web', workspaceRoot: fakeHome, workspaceType: 'vite', command: 'echo', hidden: false, tags: [] };

test('mutating request from a cross-origin page is rejected (CSRF)', async () => {
  const reg = new Registry(config, [app]);
  const server = startServer(reg, 0, { getConfig: () => config });
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    // A browser page on evil.com fetching the daemon carries a cross-origin Origin.
    const evil = await fetch(`${base}/api/apps/web/stop`, { method: 'POST', headers: { origin: 'http://evil.com', 'x-daimon-agent': 'test-1-abcd' } });
    assert.equal(evil.status, 403, 'cross-origin POST must be forbidden');
    // A non-browser client (no Origin, loopback Host) is allowed through the gate.
    const ok = await fetch(`${base}/api/apps/web/stop`, { method: 'POST', headers: { 'x-daimon-agent': 'test-2-abcd' } });
    assert.notEqual(ok.status, 403, 'same-origin/loopback POST must pass the CSRF gate');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('mutating request with a non-loopback Host is rejected (DNS rebinding)', async () => {
  const reg = new Registry(config, [app]);
  const server = startServer(reg, 0, { getConfig: () => config });
  try {
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;
    const rebind = await rawRequest(port, {
      method: 'POST',
      path: '/api/apps/web/stop',
      headers: { host: 'attacker.example.com', 'x-daimon-agent': 'test-3-abcd' },
    });
    assert.equal(rebind.status, 403, 'non-loopback Host must be forbidden');
    // Sanity: the same request with a loopback Host passes the gate.
    const okHost = await rawRequest(port, {
      method: 'POST',
      path: '/api/apps/web/stop',
      headers: { host: `127.0.0.1:${port}`, 'x-daimon-agent': 'test-4-abcd' },
    });
    assert.notEqual(okHost.status, 403, 'loopback Host must pass the gate');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET requests are exempt from the CSRF gate', async () => {
  const reg = new Registry(config, [app]);
  const server = startServer(reg, 0, { getConfig: () => config });
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/apps`, { headers: { origin: 'http://evil.com' } });
    assert.equal(r.status, 200, 'read-only GET must not be blocked by Origin');
  } finally {
    await new Promise(r => server.close(r));
  }
});
