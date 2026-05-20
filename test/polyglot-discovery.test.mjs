import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverApps } from '../dist/discovery.js';

function makeRoot(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-poly-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function baseCfg(roots) {
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
  };
}

test('detects Django via manage.py with django import marker', () => {
  const root = makeRoot({ 'manage.py': '#!/usr/bin/env python\nimport django\nfrom django.core.management import execute_from_command_line\n' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'django');
  assert.equal(apps[0].workspaceType, 'polyglot');
  assert.match(apps[0].command, /manage\.py runserver/);
});

test('rejects manage.py without django import (strict marker)', () => {
  const root = makeRoot({ 'manage.py': 'print("hello")\n' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 0);
});

test('detects Rails via bin/rails + Gemfile', () => {
  const root = makeRoot({
    'bin/rails': '#!/usr/bin/env ruby\nrequire "rails"\n',
    'Gemfile': 'source "https://rubygems.org"\ngem "rails"\n',
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'rails');
});

test('detects FastAPI via pyproject.toml with fastapi marker', () => {
  const root = makeRoot({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["fastapi", "uvicorn"]\n',
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'fastapi');
});

test('detects go-air via .air.toml', () => {
  const root = makeRoot({ '.air.toml': 'root = "."\n[build]\n  cmd = "go build -o ./tmp/main"\n' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'go-air');
  assert.equal(apps[0].command, 'air');
});

test('detects rust-trunk via Trunk.toml', () => {
  const root = makeRoot({ 'Trunk.toml': '[build]\ntarget = "index.html"\n' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'rust-trunk');
  assert.equal(apps[0].command, 'trunk serve');
});

test('JS detector takes precedence over polyglot (Vite + manage.py)', () => {
  const root = makeRoot({
    'vite.config.ts': 'export default {}\n',
    'manage.py': 'import django\n',
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].workspaceType, 'vite');
  assert.equal(apps[0].serverProfile, 'vite');
});

test('existing JS apps still report serverProfile equal to workspaceType', () => {
  const root = makeRoot({ 'vite.config.ts': 'export default {}\n' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps[0].workspaceType, 'vite');
  assert.equal(apps[0].serverProfile, 'vite');
});
