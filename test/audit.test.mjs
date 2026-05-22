import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate ~/.daimon so appendAuditEntry writes into a temp dir.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-audit-'));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { appendAuditEntry, parseAuditLine } = await import('../dist/audit.js');
const { daimonDir } = await import('../dist/daemon.js');

function readLog() {
  const p = path.join(daimonDir(), 'audit.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
}

test('parseAuditLine accepts a legacy 5-column row (no agent)', () => {
  const line = '2026-05-22T00:00:00.000Z\t127.0.0.1\tabc123def456\tapiPort,profiles\t/repo';
  const p = parseAuditLine(line);
  assert.ok(p);
  assert.equal(p.cwd, '/repo');
  assert.equal(p.agent, null);
  assert.deepEqual(p.changedKeys, ['apiPort', 'profiles']);
});

test('parseAuditLine reads the new 6-column row (with agent)', () => {
  const line = '2026-05-22T00:00:00.000Z\t127.0.0.1\tabc123\tapiPort\t/repo\thost-1234-abcd';
  const p = parseAuditLine(line);
  assert.equal(p.agent, 'host-1234-abcd');
});

test('appendAuditEntry writes the agent column when provided', () => {
  appendAuditEntry('127.0.0.1', { a: 1 }, { a: 2 }, ['a'], '/x', 'agent-Z');
  const lines = readLog();
  const last = lines[lines.length - 1];
  const cols = last.split('\t');
  assert.equal(cols.length, 6);
  assert.equal(cols[5], 'agent-Z');
});

test('appendAuditEntry writes empty agent column when omitted', () => {
  appendAuditEntry('127.0.0.1', { a: 1 }, { a: 2 }, ['a'], '/x');
  const lines = readLog();
  const last = lines[lines.length - 1];
  const cols = last.split('\t');
  assert.equal(cols.length, 6);
  assert.equal(cols[5], '');
});

test('parseAuditLine returns null on empty input', () => {
  assert.equal(parseAuditLine(''), null);
  assert.equal(parseAuditLine('   '), null);
});

test('parseAuditLine returns null on short rows', () => {
  assert.equal(parseAuditLine('a\tb\tc'), null);
});

test('cleanup: restore HOME/USERPROFILE', () => {
  if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
  if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});
