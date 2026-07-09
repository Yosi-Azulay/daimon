import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M65 — framework adapter registry: built-in rows, multi-family coexistence,
// custom config profiles, per-profile discovery stats, GET /api/frameworks.

const { builtinProfiles, allProfiles, validateCustomProfiles, matchDetect, RootFs } = await import('../dist/frameworks.js');
const { discoverApps } = await import('../dist/discovery.js');
const { validateConfig } = await import('../dist/config.js');

function makeRoot(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-fwreg-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content === null) fs.mkdirSync(full, { recursive: true });
    else fs.writeFileSync(full, content);
  }
  return dir;
}

function baseCfg(roots, extra = {}) {
  return {
    searchRoots: roots,
    portRange: [4200, 4300],
    apiPort: 6822,
    overrides: {},
    autoStart: [],
    profiles: {},
    tags: {},
    autoRestart: { enabled: false, maxAttempts: 3, windowMs: 60000 },
    healthProbe: { enabled: false, intervalMs: 5000, timeoutMs: 2000, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 5, maxBytesPerFile: 1024 * 1024 },
    depends: {},
    cascadeRestart: false,
    history: { enabled: false, path: '', retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 60000 },
    headless: true,
    envFiles: {},
    requestLog: { enabled: false, portOffset: 1000 },
    metrics: { enabled: false },
    editor: { scheme: 'vscode' },
    apiToken: null,
    output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } },
    dashboard: { theme: 'auto', density: 'comfortable' },
    ...extra,
  };
}

const ANGULAR_JSON = JSON.stringify({
  projects: { 'web-admin': { architect: { serve: {}, build: {}, test: {} } } },
});

// --- registry shape ---------------------------------------------------------

test('registry ships ≥9 built-in profiles with the 9 v0.10 ids', () => {
  const ids = builtinProfiles().map(p => p.id);
  for (const id of ['nx', 'angular', 'vite', 'storybook', 'django', 'rails', 'fastapi', 'go-air', 'rust-trunk']) {
    assert.ok(ids.includes(id), `missing built-in profile ${id}`);
  }
  assert.ok(ids.length >= 9);
});

test('every built-in row has family, detect clause, command, workspaceType', () => {
  for (const p of builtinProfiles()) {
    assert.ok(p.family, `${p.id} missing family`);
    // Workspace enumerators (pnpm/turbo) register member apps, not a root app.
    if (!(p.workspace === 'pnpm' || p.workspace === 'turbo')) assert.ok(p.command, `${p.id} missing command`);
    assert.ok(p.workspaceType, `${p.id} missing workspaceType`);
    const d = p.detect;
    assert.ok(d.files?.length || d.anyFiles?.length || d.fileContains?.length || d.globContains?.length || d.packageJson,
      `${p.id} has no detect clause`);
  }
});

// --- multi-family coexistence (M65 acceptance) -------------------------------

test('a root with angular.json + manage.py yields two apps', () => {
  const root = makeRoot({
    'angular.json': ANGULAR_JSON,
    'manage.py': 'import django\n',
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 2, `expected 2 apps, got ${apps.map(a => a.name).join(', ')}`);
  const profiles = apps.map(a => a.serverProfile).sort();
  assert.deepEqual(profiles, ['angular', 'django']);
});

test('nx.json still suppresses angular.json for the same root', () => {
  const root = makeRoot({
    'nx.json': '{}',
    'angular.json': ANGULAR_JSON,
    'apps/web/project.json': JSON.stringify({ name: 'web', targets: { serve: {} } }),
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'nx');
});

test('vite still suppresses the polyglot rows (unchanged v0.10 behavior)', () => {
  const root = makeRoot({
    'vite.config.ts': 'export default {}\n',
    'Trunk.toml': '[build]\n',
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'vite');
});

// --- per-profile discovery stats ---------------------------------------------

test('discovery.stats gains per-profile match counts', () => {
  const root = makeRoot({
    'angular.json': ANGULAR_JSON,
    'manage.py': 'import django\n',
  });
  const stats = { scanned: 0, rejected: {} };
  discoverApps(baseCfg([root]), { stats });
  assert.equal(stats.profiles.angular, 1);
  assert.equal(stats.profiles.django, 1);
});

// --- custom profiles (config `frameworks: []`) ---------------------------------

test('custom profile in config discovers a fixture app', () => {
  const root = makeRoot({ 'mix.exs': 'defmodule Foo do\n  use Mix.Project\nend\n' });
  const cfg = baseCfg([root], {
    frameworks: validateCustomProfiles([
      { id: 'phoenix', detect: { files: ['mix.exs'], fileContains: [{ file: 'mix.exs', pattern: 'Mix\\.Project' }] }, command: 'mix phx.server' },
    ], () => {}),
  });
  const apps = discoverApps(cfg);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'phoenix');
  assert.equal(apps[0].command, 'mix phx.server');
  assert.equal(apps[0].workspaceType, 'polyglot');
});

test('validateCustomProfiles: invalid regex is skipped with a warning', () => {
  const warnings = [];
  const out = validateCustomProfiles([
    { id: 'bad-rx', detect: { fileContains: [{ file: 'x.txt', pattern: '(' }] }, command: 'run' },
    { id: 'good', detect: { files: ['marker.txt'] }, command: 'run' },
  ], m => warnings.push(m));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'good');
  assert.ok(warnings.some(w => w.includes('bad-rx')));
});

test('validateCustomProfiles: unknown errorParser id is skipped with a warning', () => {
  const warnings = [];
  const out = validateCustomProfiles([
    { id: 'custom1', detect: { files: ['m.txt'] }, command: 'run', errorParser: 'no-such-parser' },
  ], m => warnings.push(m));
  assert.equal(out.length, 0);
  assert.ok(warnings.some(w => w.includes('no-such-parser')));
});

test('validateCustomProfiles: built-in id clash and missing command are skipped', () => {
  const warnings = [];
  const out = validateCustomProfiles([
    { id: 'vite', detect: { files: ['x'] }, command: 'run' },
    { id: 'no-cmd', detect: { files: ['x'] } },
    { id: 'over-long-pattern', detect: { fileContains: [{ file: 'x', pattern: 'a'.repeat(600) }] }, command: 'run' },
  ], m => warnings.push(m));
  assert.equal(out.length, 0);
  assert.equal(warnings.length, 3);
});

test('config validation accepts frameworks[] and normalizes rows', () => {
  const cfg = validateConfig({
    searchRoots: [],
    frameworks: [
      { id: 'phoenix', detect: { files: ['mix.exs'] }, command: 'mix phx.server', readiness: { pattern: 'Running .*Endpoint' }, url: { pattern: 'Access \\S+ at (http\\S+)' } },
      { id: 'broken', detect: {}, command: 'x' },
    ],
  }, 'test');
  assert.equal(cfg.frameworks.length, 1);
  assert.equal(cfg.frameworks[0].id, 'phoenix');
  assert.equal(cfg.frameworks[0].builtin, false);
  assert.equal(cfg.frameworks[0].readiness.pattern, 'Running .*Endpoint');
});

test('custom profiles are checked after built-ins (built-in wins the same root)', () => {
  const root = makeRoot({ 'Trunk.toml': '[build]\n', 'marker.txt': 'x' });
  const cfg = baseCfg([root], {
    frameworks: validateCustomProfiles([
      { id: 'my-trunk', detect: { files: ['marker.txt'] }, command: 'my serve' },
    ], () => {}),
  });
  const apps = discoverApps(cfg);
  // Same baseName + same root → the earlier (built-in) row keeps the slot.
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'rust-trunk');
});

// --- matchDetect semantics -----------------------------------------------------

test('matchDetect: packageJson dependsOn + script clauses', () => {
  const root = makeRoot({
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: { dev: 'next dev' } }),
  });
  const rootFs = new RootFs(root);
  assert.equal(matchDetect({ packageJson: { dependsOn: ['next'] } }, rootFs), true);
  assert.equal(matchDetect({ packageJson: { dependsOn: ['nuxt'] } }, rootFs), false);
  assert.equal(matchDetect({ packageJson: { dependsOn: ['next'], script: ['dev'] } }, rootFs), true);
  assert.equal(matchDetect({ packageJson: { script: ['serve'] } }, rootFs), false);
  assert.equal(matchDetect({}, rootFs), false, 'empty detect never matches');
});

// --- GET /api/frameworks ---------------------------------------------------------

test('GET /api/frameworks lists built-ins + custom with match counts', async () => {
  const { startServer } = await import('../dist/server.js');
  const { Registry } = await import('../dist/registry.js');
  const root = makeRoot({ 'manage.py': 'import django\n' });
  const cfg = baseCfg([root], {
    frameworks: validateCustomProfiles([
      { id: 'phoenix', detect: { files: ['mix.exs'] }, command: 'mix phx.server' },
    ], () => {}),
  });
  const reg = new Registry(cfg, []);
  const server = startServer(reg, 0, { getConfig: () => cfg });
  try {
    await new Promise(r => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/frameworks`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.builtinCount >= 9, `expected ≥9 built-ins, got ${body.builtinCount}`);
    assert.equal(body.customCount, 1);
    const django = body.profiles.find(p => p.id === 'django');
    assert.equal(django.matches, 1);
    assert.deepEqual(django.apps, [path.basename(root)]);
    const phoenix = body.profiles.find(p => p.id === 'phoenix');
    assert.equal(phoenix.builtin, false);
    assert.equal(phoenix.matches, 0);
  } finally {
    await new Promise(r => server.close(r));
  }
});
