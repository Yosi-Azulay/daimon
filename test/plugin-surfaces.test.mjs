import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M118 — the plugin visibility surfaces, module-level against synthetic state:
// GET /api/plugins row shape, POST /api/plugins/scan, the /api/overview badge,
// and doctor's plugin-load-error + plugin-contributed rules.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugsurf-'));
process.env.DAIMON_HOME = fakeHome;

const { lockPath } = await import('../dist/daemon.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
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

function setupPluginsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugsurf-p-'));
  fs.writeFileSync(path.join(dir, 'healthy.mjs'), `export default {
    name: 'healthy', apiVersion: 1, description: 'a healthy fixture',
    onEvent() {},
    registerDoctorRules() { return [{
      id: 'always-flags', description: 'always finds something',
      check(ctx) { return { ok: false, detail: 'plugin rule fired (' + ctx.apps.length + ' apps)' }; },
    }]; },
  };`);
  fs.writeFileSync(path.join(dir, 'broken.mjs'), `throw new Error('broken fixture import');`);
  return dir;
}

async function getJson(base, pathname) {
  const r = await fetch(base + pathname, { headers: { 'x-daimon-agent': 'plugsurf-agent-0001' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

if (!lockPath().startsWith(fakeHome)) {
  test('plugin surface tests cannot isolate ~/.daimon on this OS — skipping', () => {});
} else {

  test('GET /api/plugins returns the v1 row shape; scan runs rules; overview badge appears', async () => {
    const dir = setupPluginsDir();
    const config = baseConfig(dir);
    const loaded = await loadPlugins(dir);
    const host = new PluginHost(loaded);
    const reg = new Registry(config, []);
    const server = startServer(reg, 0, {
      getConfig: () => config,
      getPlugins: () => host.list(),
      getPluginCounts: () => host.counts(),
      runPluginScans: async () => host.runDoctorRules({ config, apps: [] }),
    });
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;

      const list = await getJson(base, '/api/plugins');
      assert.equal(list.status, 200);
      assert.equal(list.body.length, 2);
      const healthy = list.body.find(p => p.name === 'healthy');
      const broken = list.body.find(p => p.name === 'broken.mjs');
      // Exact row key set — this shape is consumed by the CLI verb and MCP tool.
      assert.deepEqual(Object.keys(healthy).sort(),
        ['apiVersion', 'description', 'error', 'file', 'findings', 'hooks', 'name', 'status']);
      assert.equal(healthy.status, 'active');
      assert.equal(healthy.apiVersion, 1);
      assert.deepEqual(healthy.hooks, ['onEvent', 'registerDoctorRules']);
      assert.equal(healthy.error, null);
      assert.equal(broken.status, 'load-error');
      assert.match(broken.error, /broken fixture import/);

      // Scan runs the contributed rules and records findings.
      const scanR = await fetch(base + '/api/plugins/scan', { method: 'POST', headers: { 'x-daimon-agent': 'plugsurf-agent-0001' } });
      assert.equal(scanR.status, 200);
      const after = await getJson(base, '/api/plugins');
      const healthyAfter = after.body.find(p => p.name === 'healthy');
      assert.deepEqual(healthyAfter.findings, [{ rule: 'always-flags', ok: false, detail: 'plugin rule fired (0 apps)' }]);

      // Overview badge: pointer-only counts, present because plugins exist.
      const ov = await getJson(base, '/api/overview');
      assert.equal(ov.status, 200);
      assert.deepEqual(ov.body.plugins, { total: 2, active: 1, nonActive: 1 });
    } finally {
      server.close();
    }
  });

  test('overview omits the plugins key when no plugin files exist', async () => {
    const config = baseConfig(null);
    const emptyHost = new PluginHost([]);
    const reg = new Registry(config, []);
    const server = startServer(reg, 0, {
      getConfig: () => config,
      getPlugins: () => emptyHost.list(),
      getPluginCounts: () => emptyHost.counts(),
    });
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const ov = await getJson(base, '/api/overview');
      assert.equal('plugins' in ov.body, false);
    } finally {
      server.close();
    }
  });

  test('doctor: plugin-load-error flagged with remedy, plugin rules run advise-only, files untouched', async () => {
    const dir = setupPluginsDir();
    const brokenFile = path.join(dir, 'broken.mjs');
    const before = fs.statSync(brokenFile).mtimeMs + ':' + fs.readFileSync(brokenFile, 'utf8');
    const config = baseConfig(dir);
    const result = await runDoctor(config, []);

    const loadErr = result.checks.find(c => c.name === 'plugin-load-error: broken.mjs');
    assert.ok(loadErr, 'plugin-load-error check present');
    assert.equal(loadErr.ok, false);
    assert.match(loadErr.detail, /broken fixture import/);
    assert.match(loadErr.detail, /daimon daemon restart/);
    assert.match(loadErr.detail, /never touches plugin files/);

    const ruleCheck = result.checks.find(c => c.name === 'plugin:healthy/always-flags');
    assert.ok(ruleCheck, 'plugin-contributed rule ran');
    assert.equal(ruleCheck.ok, false);
    assert.match(ruleCheck.detail, /plugin rule fired/);

    // Advise-only: doctor did not delete, rename, or edit the broken file.
    assert.equal(fs.statSync(brokenFile).mtimeMs + ':' + fs.readFileSync(brokenFile, 'utf8'), before);
  });

  test('doctor: a throwing plugin rule fails its own check, built-in rules unaffected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugsurf-t-'));
    fs.writeFileSync(path.join(dir, 'crasher.mjs'), `export default {
      name: 'crasher', apiVersion: 1,
      registerDoctorRules() { return [{ id: 'boom', description: 'throws', check() { throw new Error('rule kaboom'); } }]; },
    };`);
    const config = baseConfig(dir);
    const result = await runDoctor(config, []);
    const crashed = result.checks.find(c => c.name === 'plugin:crasher/boom');
    assert.equal(crashed.ok, false);
    assert.match(crashed.detail, /rule kaboom/);
    assert.match(crashed.detail, /built-in rules are unaffected/);
    // Built-in checks still present after the plugin crash.
    assert.ok(result.checks.some(c => c.name === 'daimon-home'));
    assert.ok(result.checks.some(c => c.name === 'agent token footprint'));
  });

  test('doctor: { plugins: false } never touches plugin files (the in-daemon /why path)', async () => {
    const dir = setupPluginsDir(); // contains a healthy + a broken plugin
    const config = baseConfig(dir);
    const result = await runDoctor(config, [], { plugins: false });
    // No plugin checks at all — the daemon's request path must not re-import
    // plugin files (each cache-busted import is cached forever by the ESM
    // loader; loading per request grows the module registry without bound).
    assert.ok(!result.checks.some(c => c.name.startsWith('plugin')), 'no plugin checks with plugins:false');
    // The rest of doctor still ran.
    assert.ok(result.checks.some(c => c.name === 'agent token footprint'));
  });

  test('doctor: clean plugins dir adds no plugin checks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugsurf-c-'));
    fs.writeFileSync(path.join(dir, 'quiet.mjs'), `export default { name: 'quiet', apiVersion: 1 };`);
    const config = baseConfig(dir);
    const result = await runDoctor(config, []);
    assert.ok(!result.checks.some(c => c.name.startsWith('plugin')), 'no plugin checks for a healthy hookless plugin');
  });
}
