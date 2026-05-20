import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadPlugins, validatePluginFile, runPluginScans, buildContext } = await import('../dist/plugins.js');

function setupDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugins-'));
}

test('loadPlugins ignores files that do not match doctor-*.mjs', async () => {
  const dir = setupDir();
  fs.writeFileSync(path.join(dir, 'not-a-plugin.mjs'), 'export default {}');
  fs.writeFileSync(path.join(dir, 'doctor-good.mjs'),
    `export default { name: 'good', scan: async () => [] };`);
  const r = await loadPlugins(dir);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'good');
  assert.equal(r[0].status, 'ok');
});

test('loadPlugins reports failures without crashing', async () => {
  const dir = setupDir();
  fs.writeFileSync(path.join(dir, 'doctor-broken.mjs'), 'throw new Error("nope");');
  fs.writeFileSync(path.join(dir, 'doctor-bad-shape.mjs'), 'export default { name: "" };');
  fs.writeFileSync(path.join(dir, 'doctor-bad-name.mjs'),
    `export default { name: 'NotKebab', scan: async () => [] };`);
  const r = await loadPlugins(dir);
  const byNameOrFile = (n) => r.find(p => p.name === n || p.file.endsWith(n));
  assert.equal(byNameOrFile('doctor-broken.mjs')?.status, 'failed');
  assert.equal(byNameOrFile('doctor-bad-shape.mjs')?.status, 'failed');
  assert.equal(byNameOrFile('doctor-bad-name.mjs')?.status, 'failed');
});

test('loadPlugins rejects names that collide with built-in rules', async () => {
  const dir = setupDir();
  fs.writeFileSync(path.join(dir, 'doctor-orphan.mjs'),
    `export default { name: 'orphan-daemon', scan: async () => [] };`);
  const r = await loadPlugins(dir);
  assert.equal(r[0].status, 'failed');
  assert.match(r[0].error ?? '', /collides/);
});

test('runPluginScans populates lastFindings and survives a throwing scan', async () => {
  const dir = setupDir();
  fs.writeFileSync(path.join(dir, 'doctor-finds.mjs'),
    `export default { name: 'finds', scan: async (ctx) => ctx.apps.map(a => ({ pluginName: 'finds', id: a.name, message: a.name })) };`);
  fs.writeFileSync(path.join(dir, 'doctor-throws.mjs'),
    `export default { name: 'throws', scan: async () => { throw new Error('boom'); } };`);
  const plugins = await loadPlugins(dir);
  const ctx = buildContext({ config: {}, apps: [{ name: 'a', workspaceRoot: '/tmp' }], history: null });
  await runPluginScans(plugins, ctx);
  const finds = plugins.find(p => p.name === 'finds');
  const throws = plugins.find(p => p.name === 'throws');
  assert.deepEqual(finds.lastFindings?.map(f => f.id), ['a']);
  assert.equal(throws.status, 'failed');
  assert.match(throws.error ?? '', /scan failed/);
});

test('validatePluginFile sanity-checks a file path without daemon involvement', async () => {
  const dir = setupDir();
  const good = path.join(dir, 'doctor-vp-good.mjs');
  fs.writeFileSync(good, `export default { name: 'vp-good', scan: async () => [] };`);
  const r = await validatePluginFile(good);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'vp-good');
});
