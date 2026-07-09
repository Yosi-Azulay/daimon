import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

// M68 — backend wave: TCP readiness fallback, markServing accounting,
// Windows command resolution, and the tcpProbe primitive.

const { tcpProbe, HealthMonitor } = await import('../dist/health.js');
const { Registry } = await import('../dist/registry.js');
const { resolveCommand, RootFs, builtinProfiles } = await import('../dist/frameworks.js');

function makeRoot(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-m68-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const cfg = {
  apiPort: 0, portRange: [4200, 4299], searchRoots: [],
  history: { enabled: false, path: '', retentionDays: 7 },
  metrics: { enabled: false }, logs: { enabled: false, dir: '' },
  healthProbe: { enabled: true, intervalMs: 30000, timeoutMs: 500, path: '/' },
};

test('tcpProbe: open port true, closed port false', async () => {
  const srv = net.createServer(() => {});
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.equal(await tcpProbe(port, 500), true);
  await new Promise(r => srv.close(r));
  assert.equal(await tcpProbe(port, 500), false);
});

test('markServing: flips starting→serving and records a ready cycle', () => {
  const app = { name: 'api', baseName: 'api', workspaceRoot: process.cwd(), workspaceType: 'polyglot', serverProfile: 'express-nest', command: 'npm run dev', hidden: false, tags: [] };
  const reg = new Registry(cfg, [app]);
  const s = reg.getState('api');
  s.status = 'starting';
  s.compileStartedAt = Date.now() - 1200;
  reg.markServing('api', 'test');
  assert.equal(s.status, 'serving');
  assert.ok(s.lastCompileMs >= 1000, 'ready cycle duration recorded');
  assert.equal(s.compileHistory.length, 1, 'feeds M61 ready-time estimates');
  // Idempotent: a second call while serving is a no-op.
  reg.markServing('api', 'again');
  assert.equal(s.compileHistory.length, 1);
});

test('HealthMonitor tcp readiness: express-nest app flips to serving when port accepts', async () => {
  const srv = net.createServer(() => {});
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const app = { name: 'api', baseName: 'api', workspaceRoot: process.cwd(), workspaceType: 'polyglot', serverProfile: 'express-nest', command: 'npm run dev', hidden: false, tags: [] };
  const reg = new Registry(cfg, [app]);
  const s = reg.getState('api');
  s.status = 'starting';
  s.port = port;
  const monitor = new HealthMonitor(reg, cfg.healthProbe, cfg);
  try {
    reg.emit('change'); // trigger evaluate()
    const deadline = Date.now() + 5000;
    while (s.status !== 'serving' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(s.status, 'serving', 'tcp readiness fallback must flip status');
  } finally {
    monitor.stop();
    await new Promise(r => srv.close(r));
  }
});

test('Windows command resolution: mvnw.cmd / gradlew.cmd / ruby bin-rails shim', () => {
  const springRow = builtinProfiles().find(p => p.id === 'spring-boot');
  const railsRow = builtinProfiles().find(p => p.id === 'rails');

  const maven = makeRoot({ 'pom.xml': '<project>spring-boot</project>', 'mvnw': '#!/bin/sh\n' });
  assert.equal(resolveCommand(springRow, new RootFs(maven), undefined, 'linux'), './mvnw spring-boot:run');
  assert.equal(resolveCommand(springRow, new RootFs(maven), undefined, 'win32'), 'mvnw.cmd spring-boot:run');

  const gradle = makeRoot({ 'build.gradle': 'org.springframework.boot', 'gradlew': '#!/bin/sh\n' });
  assert.equal(resolveCommand(springRow, new RootFs(gradle), undefined, 'linux'), './gradlew bootRun');
  assert.equal(resolveCommand(springRow, new RootFs(gradle), undefined, 'win32'), 'gradlew.cmd bootRun');

  const noWrapper = makeRoot({ 'pom.xml': '<project>spring-boot</project>' });
  assert.equal(resolveCommand(springRow, new RootFs(noWrapper), undefined, 'win32'), 'mvn spring-boot:run');

  const railsRoot = makeRoot({ 'bin/rails': '#!/usr/bin/env ruby\n', 'Gemfile': 'gem "rails"\n' });
  assert.equal(resolveCommand(railsRow, new RootFs(railsRoot), undefined, 'linux'), 'bin/rails server');
  assert.equal(resolveCommand(railsRow, new RootFs(railsRoot), undefined, 'win32'), 'ruby bin/rails server');
});

test('dotnet detection requires the Web SDK marker inside *.csproj', async () => {
  const { discoverApps } = await import('../dist/discovery.js');
  const baseCfg = roots => ({ ...cfg, searchRoots: roots, overrides: {}, autoStart: [], profiles: {}, tags: {}, depends: {}, envFiles: {} });

  const web = makeRoot({ 'MyApi.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' });
  const apps1 = discoverApps(baseCfg([web]));
  assert.equal(apps1.length, 1);
  assert.equal(apps1[0].serverProfile, 'dotnet');
  assert.equal(apps1[0].command, 'dotnet watch');

  const lib = makeRoot({ 'MyLib.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>' });
  assert.equal(discoverApps(baseCfg([lib])).length, 0, 'class libraries must not register');
});
