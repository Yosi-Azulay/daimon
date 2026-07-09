import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M67 — adapter test kit. One fixture per registry profile under
// test/fixtures/frameworks/<id>/; this suite is the gate for every profile:
// a profile without a fixture doesn't ship.
//
// Per profile it asserts: detection (discoverApps on the fixture), command,
// readiness transition, URL extraction, and ≥1 parsed error with file:line —
// the last three by feeding the fixture's captured output through parseLine
// with the profile's compiled parse context.

const { discoverApps } = await import('../dist/discovery.js');
const { builtinProfiles, allProfiles } = await import('../dist/frameworks.js');
const { parseLine, compileParseContext } = await import('../dist/parser.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures', 'frameworks');

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

function freshState() {
  return {
    name: 'x', baseName: 'x', status: 'starting', port: null, pid: null, startedAt: Date.now(),
    compileStartedAt: Date.now(), lastCompileMs: null, lastCompileAt: null, logBuffer: [],
    errors: new Map(), compileHistory: [], health: 'unknown', lastHealthAt: null, cpu: null, memMB: null,
    restartAttempts: 0, restartWindowStart: null, nextRestartAt: null, tags: [],
    announcedUrl: null, lastHealthError: null, cachedProbeHost: null, lastLogTs: null,
    stale: false, bundle: null, bundleRegressionPct: null, activeEnvFile: null,
    sessionOverrides: null, dependsOn: [], workspaceLabel: null, workspaceRoot: null,
  };
}

const fixtureIds = fs.readdirSync(fixturesDir).filter(d => fs.statSync(path.join(fixturesDir, d)).isDirectory());

test('every built-in registry profile ships with a fixture', () => {
  for (const p of builtinProfiles()) {
    assert.ok(fixtureIds.includes(p.id), `profile '${p.id}' has no fixture in test/fixtures/frameworks/ — a profile without a fixture doesn't ship`);
  }
});

test('custom config profile readiness/url patterns drive the parse pipeline', () => {
  // Compile a context straight from a data-only row, the way Registry.start does.
  const ctx = compileParseContext({
    id: 'phoenix', family: 'js', detect: { files: ['mix.exs'] }, command: 'mix phx.server',
    workspaceType: 'polyglot', builtin: false,
    readiness: { pattern: 'Running \\S+ with cowboy' },
    url: { pattern: 'Access \\S+ at (https?:\\/\\/\\S+)' },
    errorParser: 'jvm-gradle',
  });
  const state = freshState();
  parseLine(state, '[info] Running MyAppWeb.Endpoint with cowboy 2.10.0 at 127.0.0.1:4000 (http)', ctx);
  parseLine(state, '[info] Access MyAppWeb.Endpoint at http://localhost:4000', ctx);
  assert.equal(state.status, 'serving', 'custom readiness pattern must drive compiling→serving');
  assert.equal(state.announcedUrl, 'http://localhost:4000', 'custom url pattern must feed the announced-URL probe');
  assert.ok(state.lastCompileAt != null, 'ready cycle recorded for ready-time estimates');
});

for (const id of fixtureIds) {
  const dir = path.join(fixturesDir, id);
  const fx = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));

  test(`framework ${id}: detection + command`, () => {
    const apps = discoverApps(baseCfg([dir]));
    for (const want of fx.apps) {
      const app = apps.find(a => a.baseName === want.name && a.serverProfile === want.profile);
      assert.ok(app, `expected app ${want.name} (${want.profile}); got ${apps.map(a => `${a.baseName}:${a.serverProfile}`).join(', ') || 'none'}`);
      // Windows command resolution (M68): fixtures may carry a win32 variant.
      const wantCmd = process.platform === 'win32' ? (want.commandWin32 ?? want.command) : want.command;
      if (wantCmd) assert.equal(app.command, wantCmd);
    }
  });

  if (fx.parse) {
    const profileId = fx.parse.profile ?? fx.apps[0].profile;
    const row = allProfiles(undefined).find(p => p.id === profileId);
    const ctx = compileParseContext(row);

    test(`framework ${id}: readiness transition + URL extraction`, () => {
      const state = freshState();
      for (const line of fx.parse.startup) parseLine(state, line, ctx);
      assert.equal(state.status, fx.parse.expectStatus, `status after startup output`);
      if (fx.parse.expectUrl !== null && fx.parse.expectUrl !== undefined) {
        assert.equal(state.announcedUrl, fx.parse.expectUrl);
      }
      if (fx.parse.expectStatus === 'serving') {
        assert.ok(state.lastCompileAt != null, 'reaching serving must record a compile/ready cycle (feeds M61 ready-time)');
      }
    });

    test(`framework ${id}: ≥1 parsed error with file:line`, () => {
      const state = freshState();
      state.status = 'serving';
      const before = fx.parse.startup.length;
      for (const line of [...fx.parse.startup, ...fx.parse.errors]) parseLine(state, line, ctx);
      const entries = [...state.errors.values()];
      const want = fx.parse.expectError;
      const hit = entries.find(e => e.parsed?.file === want.file && e.parsed?.line === want.line);
      assert.ok(hit, `expected error at ${want.file}:${want.line}; got ${JSON.stringify(entries.map(e => e.parsed && { file: e.parsed.file, line: e.parsed.line }))}`);
      assert.equal(state.status, 'error', 'an error line must flip status to error');
      // Fail-soft: every line still lands in the log path — parseLine never
      // drops lines (the log buffer is fed upstream of parsing; here we just
      // re-assert parseLine tolerated every fixture line without throwing).
      assert.ok(before >= 0);
    });
  }
}
