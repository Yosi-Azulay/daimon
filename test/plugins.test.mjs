import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Plugin API v1 (M116) — loader validation, hook dispatch, frozen snapshots,
// doctor-rule collection, and the write-path bench. Module-level: no daemon.
// Session-disable / crash-isolation torture lives in plugin-isolation.test.mjs.

const { loadPlugins, validatePluginFile, PluginHost, PLUGIN_API_VERSION } = await import('../dist/plugins.js');

function setupDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugins-'));
}

function write(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

function flushDispatch() {
  // Host dispatch defers to setImmediate; two rounds cover hook + rejection.
  return new Promise(r => setImmediate(() => setImmediate(r)));
}

test('exposes apiVersion 1', () => {
  assert.equal(PLUGIN_API_VERSION, 1);
});

test('valid v1 plugin loads active with declared hooks; non-js files ignored silently', async () => {
  const dir = setupDir();
  write(dir, 'README.md', '# not a plugin');
  write(dir, 'notes.txt', 'nope');
  write(dir, 'observer.mjs', `export default {
    name: 'observer', apiVersion: 1, description: 'watches events',
    onEvent() {}, registerDoctorRules() { return []; },
  };`);
  const r = await loadPlugins(dir);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'observer');
  assert.equal(r[0].status, 'active');
  assert.equal(r[0].apiVersion, 1);
  assert.deepEqual(r[0].hooks, ['onEvent', 'registerDoctorRules']);
  assert.equal(r[0].description, 'watches events');
});

test('hookless plugin is valid — loads, lists, does nothing', async () => {
  const dir = setupDir();
  write(dir, 'inert.mjs', `export default { name: 'inert', apiVersion: 1 };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'active');
  assert.deepEqual(r[0].hooks, []);
  const host = new PluginHost(r);
  // Dispatching to a hookless plugin is a no-op, not an error.
  host.handleRegistryEvent({ ts: Date.now(), app: 'a', type: 'status', to: 'starting' });
  await flushDispatch();
  assert.equal(host.list()[0].status, 'active');
});

test('.cjs and .js files load too', async () => {
  const dir = setupDir();
  write(dir, 'commonjs.cjs', `module.exports = { name: 'commonjs', apiVersion: 1 };`);
  write(dir, 'plain.js', `module.exports = { name: 'plain', apiVersion: 1 };`);
  const r = await loadPlugins(dir);
  assert.deepEqual(r.map(p => [p.name, p.status]).sort(), [['commonjs', 'active'], ['plain', 'active']]);
});

test('missing name → load-error naming the requirement', async () => {
  const dir = setupDir();
  write(dir, 'anon.mjs', `export default { apiVersion: 1 };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'load-error');
  assert.match(r[0].error, /missing "name"/);
  assert.match(r[0].error, /PLUGINS\.md/);
});

test('non-kebab-case name → load-error naming the convention', async () => {
  const dir = setupDir();
  write(dir, 'badname.mjs', `export default { name: 'NotKebab', apiVersion: 1 };`);
  write(dir, 'badname2.mjs', `export default { name: 'my plugin', apiVersion: 1 };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'load-error');
  assert.match(r[0].error, /kebab-case/);
  assert.equal(r[1].status, 'load-error');
  assert.match(r[1].error, /kebab-case/);
});

test('missing apiVersion → load-error with remedy', async () => {
  const dir = setupDir();
  write(dir, 'noversion.mjs', `export default { name: 'noversion', onEvent() {} };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'load-error');
  assert.match(r[0].error, /missing "apiVersion"/);
});

test('legacy pre-v1.5 doctor plug-in shape gets the migration message', async () => {
  const dir = setupDir();
  write(dir, 'doctor-old.mjs', `export default { name: 'old-style', scan: async () => [] };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'load-error');
  assert.match(r[0].error, /legacy doctor plug-in shape/);
  assert.match(r[0].error, /registerDoctorRules/);
});

test('unknown apiVersion → skipped with the supported version named', async () => {
  const dir = setupDir();
  write(dir, 'future.mjs', `export default { name: 'future', apiVersion: 2, onEvent() {} };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'load-error');
  assert.match(r[0].error, /unsupported apiVersion 2/);
  assert.match(r[0].error, /supports apiVersion 1/);
});

test('non-function hook field → load-error naming the field', async () => {
  const dir = setupDir();
  write(dir, 'badhook.mjs', `export default { name: 'badhook', apiVersion: 1, onEvent: 'not-a-fn' };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'load-error');
  assert.match(r[0].error, /"onEvent" must be a function/);
});

test('duplicate plugin name → later file load-error, first stays active', async () => {
  const dir = setupDir();
  write(dir, 'a-first.mjs', `export default { name: 'dupe', apiVersion: 1 };`);
  write(dir, 'b-second.mjs', `export default { name: 'dupe', apiVersion: 1 };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'active');
  assert.equal(r[1].status, 'load-error');
  assert.match(r[1].error, /duplicate plugin name/);
});

test('registerDoctorRules returning junk → load-error', async () => {
  const dir = setupDir();
  write(dir, 'badrules.mjs', `export default { name: 'badrules', apiVersion: 1, registerDoctorRules() { return 'nope'; } };`);
  write(dir, 'badrule2.mjs', `export default { name: 'badrule2', apiVersion: 1, registerDoctorRules() { return [{ id: 'x' }]; } };`);
  const r = await loadPlugins(dir);
  const byName = n => r.find(p => p.name === n);
  assert.equal(byName('badrules').status, 'load-error');
  assert.match(byName('badrules').error, /must return an array/);
  assert.equal(byName('badrule2').status, 'load-error');
  assert.match(byName('badrule2').error, /invalid rule/);
});

test('onEvent receives a frozen copy of a seeded event', async () => {
  const dir = setupDir();
  const outFile = path.join(dir, 'seen.json');
  write(dir, 'watcher.mjs', `import fs from 'node:fs';
    export default { name: 'watcher', apiVersion: 1,
      onEvent(evt) { fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(evt) + '\\n'); } };`);
  const plugins = await loadPlugins(dir);
  const host = new PluginHost(plugins);
  const evt = { ts: 1234, app: 'web', type: 'error-new', message: 'boom' };
  host.handleRegistryEvent(evt);
  await flushDispatch();
  const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), evt);
});

test('mutating a received snapshot inside a hook does not alter the source event', async () => {
  const dir = setupDir();
  write(dir, 'mutator.mjs', `export default { name: 'mutator', apiVersion: 1,
    onEvent(evt) { try { evt.message = 'tampered'; evt.injected = true; } catch {} } };`);
  const plugins = await loadPlugins(dir);
  const host = new PluginHost(plugins);
  const evt = { ts: 1, app: 'web', type: 'status', from: 'stopped', to: 'starting', message: 'original' };
  host.handleRegistryEvent(evt);
  await flushDispatch();
  assert.equal(evt.message, 'original');
  assert.equal('injected' in evt, false);
  // The mutation attempt itself must not have disabled the plugin (frozen
  // copies fail silently in sloppy mode / throw in strict — either way the
  // registry-side object is untouched).
  assert.equal(host.list()[0].status, 'active');
});

test('onAppStart/onAppStop fire on status transitions with the app snapshot', async () => {
  const dir = setupDir();
  const outFile = path.join(dir, 'lifecycle.json');
  write(dir, 'lifecycle.mjs', `import fs from 'node:fs';
    const log = (kind, app) => fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify({ kind, app }) + '\\n');
    export default { name: 'lifecycle', apiVersion: 1,
      onAppStart(app) { log('start', app); },
      onAppStop(app) { log('stop', app); } };`);
  const plugins = await loadPlugins(dir);
  const host = new PluginHost(plugins);
  host.setSnapshotProvider(name => ({ name, framework: 'vite', port: 5173, pid: 4242, status: 'starting' }));
  host.handleRegistryEvent({ ts: 1, app: 'web', type: 'status', from: 'stopped', to: 'starting' });
  host.handleRegistryEvent({ ts: 2, app: 'web', type: 'compile-regression', message: 'not a lifecycle event' });
  host.handleRegistryEvent({ ts: 3, app: 'web', type: 'status', from: 'serving', to: 'stopped' });
  // Daemon self-status transitions never reach app lifecycle hooks.
  host.handleRegistryEvent({ ts: 4, app: '__daemon__', type: 'status', to: 'starting' });
  await flushDispatch();
  const rows = fs.readFileSync(outFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => r.kind), ['start', 'stop']);
  assert.equal(rows[0].app.name, 'web');
  assert.equal(rows[0].app.framework, 'vite');
  assert.equal(rows[0].app.port, 5173);
  assert.equal(rows[0].app.pid, 4242);
});

test('doctorRules() exposes contributed rules; runDoctorRules records findings', async () => {
  const dir = setupDir();
  write(dir, 'ruler.mjs', `export default { name: 'ruler', apiVersion: 1,
    registerDoctorRules() { return [{
      id: 'too-many-apps', description: 'flags >1 app',
      check(ctx) { return { ok: ctx.apps.length <= 1, detail: ctx.apps.length + ' apps' }; },
    }]; } };`);
  const plugins = await loadPlugins(dir);
  const host = new PluginHost(plugins);
  assert.equal(host.doctorRules().length, 1);
  assert.equal(host.doctorRules()[0].rule.id, 'too-many-apps');
  await host.runDoctorRules({ config: {}, apps: [{ name: 'a', framework: null, workspaceRoot: null }, { name: 'b', framework: null, workspaceRoot: null }] });
  const info = host.list()[0];
  assert.equal(info.findings.length, 1);
  assert.deepEqual(info.findings[0], { rule: 'too-many-apps', ok: false, detail: '2 apps' });
});

test('validatePluginFile: ok with hooks for a good file, specific error otherwise', async () => {
  const dir = setupDir();
  const good = path.join(dir, 'vp-good.mjs');
  fs.writeFileSync(good, `export default { name: 'vp-good', apiVersion: 1, onEvent() {} };`);
  const r = await validatePluginFile(good);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'vp-good');
  assert.deepEqual(r.hooks, ['onEvent']);
  const bad = path.join(dir, 'vp-bad.mjs');
  fs.writeFileSync(bad, `export default { name: 'vp-bad' };`);
  const rb = await validatePluginFile(bad);
  assert.equal(rb.ok, false);
  assert.match(rb.error, /apiVersion/);
});

test('counts() splits active vs non-active', async () => {
  const dir = setupDir();
  write(dir, 'ok.mjs', `export default { name: 'ok', apiVersion: 1 };`);
  write(dir, 'broken.mjs', `throw new Error('explode at import');`);
  const plugins = await loadPlugins(dir);
  const host = new PluginHost(plugins);
  assert.deepEqual(host.counts(), { total: 2, active: 1, nonActive: 1 });
});

// M121 gate: hook dispatch must not move the event write path. The
// synchronous cost of handleRegistryEvent with a no-op plugin loaded is one
// filter + one setImmediate; the budget is deliberately generous (absolute)
// so external load cannot flake it — a real regression (sync plugin work on
// the write path) would blow through it by orders of magnitude.
test('bench: 10k dispatches with a no-op plugin stay off the write path', async () => {
  const dir = setupDir();
  write(dir, 'noop.mjs', `export default { name: 'noop', apiVersion: 1, onEvent() {} };`);
  const host = new PluginHost(await loadPlugins(dir));
  const evt = { ts: 1, app: 'web', type: 'status', from: 'stopped', to: 'serving' };
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 10_000; i++) host.handleRegistryEvent(evt);
  const syncMs = Number(process.hrtime.bigint() - t0) / 1e6;
  await flushDispatch();
  assert.ok(syncMs < 500, `10k dispatch schedulings took ${syncMs.toFixed(1)}ms (budget 500ms)`);

  // With no plugins loaded the early return must make dispatch ~free.
  const empty = new PluginHost([]);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 10_000; i++) empty.handleRegistryEvent(evt);
  const emptyMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(emptyMs < 100, `10k no-plugin dispatches took ${emptyMs.toFixed(1)}ms (budget 100ms)`);
});
