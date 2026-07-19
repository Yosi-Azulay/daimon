import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// M120 — the example plugins are exercised code: events-to-jsonl appends JSON
// lines, custom-doctor-rule contributes an advise-only check, and neither
// appears in the npm tarball.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugex-'));
process.env.DAIMON_HOME = fakeHome;

const { lockPath } = await import('../dist/daemon.js');
const { loadPlugins, PluginHost } = await import('../dist/plugins.js');
const { runDoctor } = await import('../dist/doctor.js');

function baseConfig(pluginsDir) {
  return {
    searchRoots: [], portRange: [4000, 4099], apiPort: 43990,
    overrides: {}, autoStart: [], profiles: {}, tags: {},
    autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: pluginsDir ?? null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 },
  };
}

if (!lockPath().startsWith(fakeHome)) {
  test('plugin example tests cannot isolate ~/.daimon on this OS — skipping', () => {});
} else {

  test('events-to-jsonl plugin appends JSON lines to events.jsonl', async () => {
    const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugex-jsonl-'));

    // Copy the example plugin
    const examplePath = path.join(process.cwd(), 'examples', 'plugins', 'events-to-jsonl.mjs');
    const pluginPath = path.join(pluginsDir, 'events-to-jsonl.mjs');
    fs.copyFileSync(examplePath, pluginPath);

    const loaded = await loadPlugins(pluginsDir);
    assert.equal(loaded.length, 1, 'exactly one plugin loaded');
    const plugin = loaded[0];
    assert.equal(plugin.name, 'events-to-jsonl');
    assert.equal(plugin.status, 'active');
    assert.equal(plugin.apiVersion, 1);
    assert.deepEqual(plugin.hooks, ['onEvent']);

    const host = new PluginHost(loaded);

    // Dispatch two events
    host.handleRegistryEvent({ ts: 1000, app: 'web', type: 'error-new', message: 'boom' });
    host.handleRegistryEvent({ ts: 2000, app: 'api', type: 'compile-start' });

    // Wait for async file I/O to complete
    await new Promise(r => setImmediate(() => setImmediate(r)));

    // Read the events.jsonl file next to the plugin
    const eventsPath = path.join(pluginsDir, 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath), 'events.jsonl exists');
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(l => l);
    assert.equal(lines.length, 2, 'exactly 2 lines written');

    const evt1 = JSON.parse(lines[0]);
    assert.deepEqual(evt1, { ts: 1000, app: 'web', type: 'error-new', message: 'boom' });

    const evt2 = JSON.parse(lines[1]);
    assert.deepEqual(evt2, { ts: 2000, app: 'api', type: 'compile-start' });
  });

  test('custom-doctor-rule plugin contributes a no-apps-discovered check', async () => {
    const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugex-doc-'));

    // Copy the example plugin
    const examplePath = path.join(process.cwd(), 'examples', 'plugins', 'custom-doctor-rule.mjs');
    const pluginPath = path.join(pluginsDir, 'custom-doctor-rule.mjs');
    fs.copyFileSync(examplePath, pluginPath);

    const config = baseConfig(pluginsDir);

    // Test with empty apps list
    const resultEmpty = await runDoctor(config, []);
    const checkEmpty = resultEmpty.checks.find(c => c.name === 'plugin:custom-doctor-rule/no-apps-discovered');
    assert.ok(checkEmpty, 'plugin rule check present');
    assert.equal(checkEmpty.ok, false, 'check fails when no apps discovered');
    assert.match(checkEmpty.detail, /no apps discovered/);

    // Test with one app
    const oneApp = {
      name: 'web',
      baseName: 'web',
      workspaceRoot: fakeHome,
      workspaceType: 'polyglot',
      command: 'noop',
      hidden: false,
      tags: [],
    };
    const resultWithApp = await runDoctor(config, [oneApp]);
    const checkWithApp = resultWithApp.checks.find(c => c.name === 'plugin:custom-doctor-rule/no-apps-discovered');
    assert.ok(checkWithApp, 'plugin rule check present');
    assert.equal(checkWithApp.ok, true, 'check passes when apps discovered');
    assert.match(checkWithApp.detail, /1 app/);
  });

  test('examples/ excluded from npm tarball and package.json files array', async () => {
    const repoRoot = process.cwd();

    // Parse package.json
    const pkgContent = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgContent);

    // Check package.json files array
    assert.ok(!pkg.files.includes('examples'), 'examples not in package.json files array');

    // Check npm pack output
    const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      shell: true,
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf8',
    });
    const packJson = JSON.parse(packOutput);

    // npm pack --json returns [{ files: [{ path, ... }], ... }] — one entry
    // per packed tarball. Guard against vacuity before filtering.
    const files = (packJson[0]?.files ?? []).map(f => f.path);
    assert.ok(files.includes('package.json') && files.length > 10, `pack listing parsed (${files.length} entries)`);
    const examplePaths = files.filter(p => p.startsWith('examples/') || p.startsWith('examples\\'));
    assert.equal(examplePaths.length, 0, `no examples/ paths in tarball (found: ${examplePaths.join(', ')})`);
  });

}
