import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathUnder, normalizeForCompare } from '../dist/pathScope.js';
import { Registry } from '../dist/registry.js';
import { platformSkip } from './helpers/platformSkip.mjs';

test('isPathUnder: identical paths match', () => {
  const p = path.resolve('/tmp/workspace');
  assert.equal(isPathUnder(p, p), true);
});

test('isPathUnder: child under parent', () => {
  const parent = path.resolve('/tmp/workspace');
  const child = path.join(parent, 'apps', 'editor');
  assert.equal(isPathUnder(child, parent), true);
});

test('isPathUnder: sibling does not match', () => {
  const a = path.resolve('/tmp/workspace-a');
  const b = path.resolve('/tmp/workspace-b');
  assert.equal(isPathUnder(b, a), false);
  // Prefix that isn't a path-separator boundary must not match.
  assert.equal(isPathUnder(path.resolve('/tmp/workspace-abc'), path.resolve('/tmp/workspace')), false);
});

test('isPathUnder: parent does not match child', () => {
  const parent = path.resolve('/tmp/workspace');
  const child = path.join(parent, 'apps');
  assert.equal(isPathUnder(parent, child), false);
});

test('isPathUnder: relative paths are resolved before comparison', () => {
  const parent = process.cwd();
  assert.equal(isPathUnder('.', parent), true);
  assert.equal(isPathUnder('./does/not/exist', parent), true);
});

// These verify REAL host path.resolve behavior on Windows (drive letters,
// NTFS case-insensitivity, slash normalization) — they can't run on POSIX, so
// they skip loudly there instead of vanishing. The case-fold DECISION itself is
// proven cross-platform in platform-seams.test.mjs via the injectable param.
test('isPathUnder (Windows): case-insensitive matching', (t) => {
  if (platformSkip(t, 'win32', 'real NTFS case-insensitive path.resolve matching')) return;
  const lower = 'd:\\synology\\sourcecode\\daimon';
  const upper = 'D:\\Synology\\SourceCode\\daimon\\src';
  assert.equal(isPathUnder(upper, lower), true);
});

test('isPathUnder (Windows): forward/back slash variants normalize the same way', (t) => {
  if (platformSkip(t, 'win32', 'real Windows slash normalization in path.resolve')) return;
  const a = 'D:/Synology/SourceCode/daimon';
  const b = 'D:\\Synology\\SourceCode\\daimon\\src';
  assert.equal(isPathUnder(b, a), true);
});

test('normalizeForCompare: trailing-separator stripped via path.resolve', () => {
  const a = normalizeForCompare(path.resolve('/tmp/x/'));
  const b = normalizeForCompare(path.resolve('/tmp/x'));
  assert.equal(a, b);
});

function makeRegistryWithApps(apps) {
  const config = {
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
  };
  return new Registry(config, apps);
}

test('resolveByCwd: single app, no cwd → unique match', () => {
  const root = path.resolve('/tmp/ws-a');
  const reg = makeRegistryWithApps([
    { name: 'editor', baseName: 'editor', workspaceRoot: root, workspaceType: 'nx', command: 'x', hidden: false, tags: [], workspaceLabel: 'ws-a' },
  ]);
  const r = reg.resolveByCwd('editor');
  assert.equal(r.kind, 'unique');
  assert.equal(r.key, 'editor');
  assert.equal(r.candidates.length, 1);
});

test('resolveByCwd: two same-name apps with no cwd → collision', () => {
  const rootA = path.resolve('/tmp/ws-a');
  const rootB = path.resolve('/tmp/ws-b');
  const reg = makeRegistryWithApps([
    { name: 'editor', baseName: 'editor', workspaceRoot: rootA, workspaceType: 'nx', command: 'x', hidden: false, tags: [], workspaceLabel: 'ws-a' },
    { name: 'editor@ws-b', baseName: 'editor', workspaceRoot: rootB, workspaceType: 'nx', command: 'x', hidden: false, tags: [], workspaceLabel: 'ws-b' },
  ]);
  const r = reg.resolveByCwd('editor');
  assert.equal(r.kind, 'collision');
  assert.equal(r.candidates.length, 2);
});

test('resolveByCwd: two same-name apps + cwd of A → unique key for A', () => {
  const rootA = path.resolve('/tmp/ws-a');
  const rootB = path.resolve('/tmp/ws-b');
  const reg = makeRegistryWithApps([
    { name: 'editor', baseName: 'editor', workspaceRoot: rootA, workspaceType: 'nx', command: 'x', hidden: false, tags: [], workspaceLabel: 'ws-a' },
    { name: 'editor@ws-b', baseName: 'editor', workspaceRoot: rootB, workspaceType: 'nx', command: 'x', hidden: false, tags: [], workspaceLabel: 'ws-b' },
  ]);
  const r = reg.resolveByCwd('editor', rootA);
  assert.equal(r.kind, 'unique');
  assert.equal(r.key, 'editor');
});

test('resolveByCwd: cwd that does not match any app → none', () => {
  const root = path.resolve('/tmp/ws-a');
  const elsewhere = path.resolve('/tmp/elsewhere');
  const reg = makeRegistryWithApps([
    { name: 'editor', baseName: 'editor', workspaceRoot: root, workspaceType: 'nx', command: 'x', hidden: false, tags: [], workspaceLabel: 'ws-a' },
  ]);
  const r = reg.resolveByCwd('editor', elsewhere);
  assert.equal(r.kind, 'none');
});

test('resolveByCwd: child path of workspaceRoot resolves to its app', () => {
  const root = path.resolve('/tmp/ws-a');
  const childCwd = path.join(root, 'apps', 'editor');
  const reg = makeRegistryWithApps([
    { name: 'editor', baseName: 'editor', workspaceRoot: root, workspaceType: 'nx', command: 'x', hidden: false, tags: [], workspaceLabel: 'ws-a' },
  ]);
  const r = reg.resolveByCwd('editor', childCwd);
  assert.equal(r.kind, 'unique');
});
