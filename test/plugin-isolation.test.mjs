import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Crash-isolation torture suite (M117): a throwing plugin never takes the
// daemon down. Module-level cases exercise PluginHost directly; the final
// cases spawn a REAL daemon under an isolated DAIMON_HOME (the
// lifecycle-torture recipe) and assert it keeps serving through load
// explosions, hook throws, and async rejections.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = path.join(repoRoot, 'dist', 'main.js');

const { loadPlugins, PluginHost } = await import('../dist/plugins.js');

function setupDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugiso-'));
}
function write(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}
function flushDispatch() {
  return new Promise(r => setImmediate(() => setImmediate(() => setTimeout(r, 0))));
}
const EVT = (over = {}) => ({ ts: Date.now(), app: 'web', type: 'status', from: 'stopped', to: 'starting', ...over });

test('throw-at-load: the exploding file is load-error, its sibling loads fine', async () => {
  const dir = setupDir();
  write(dir, 'a-exploder.mjs', `throw new Error('kaboom at import');`);
  write(dir, 'b-survivor.mjs', `export default { name: 'survivor', apiVersion: 1, onEvent() {} };`);
  const r = await loadPlugins(dir);
  const exploder = r.find(p => p.file.endsWith('a-exploder.mjs'));
  const survivor = r.find(p => p.name === 'survivor');
  assert.equal(exploder.status, 'load-error');
  assert.match(exploder.error, /kaboom at import/);
  assert.equal(survivor.status, 'active');
});

test('throw-in-onEvent disables for the session: one plugin-error, survivor keeps receiving', async () => {
  const dir = setupDir();
  const seen = path.join(dir, 'seen.txt');
  write(dir, 'thrower.mjs', `export default { name: 'thrower', apiVersion: 1,
    onEvent() { throw new Error('hook boom'); } };`);
  write(dir, 'survivor.mjs', `import fs from 'node:fs';
    export default { name: 'survivor', apiVersion: 1,
      onEvent(evt) { fs.appendFileSync(${JSON.stringify(seen)}, evt.ts + '\\n'); } };`);
  const errors = [];
  const host = new PluginHost(await loadPlugins(dir), { onPluginError: e => errors.push(e) });

  host.handleRegistryEvent(EVT({ ts: 1 }));
  await flushDispatch();
  host.handleRegistryEvent(EVT({ ts: 2 }));
  host.handleRegistryEvent(EVT({ ts: 3 }));
  await flushDispatch();

  // Exactly one plugin-error, carrying hook name + stack.
  assert.equal(errors.length, 1);
  assert.equal(errors[0].plugin, 'thrower');
  assert.equal(errors[0].hook, 'onEvent');
  assert.equal(errors[0].message, 'hook boom');
  assert.match(errors[0].stack ?? '', /hook boom/);

  const thrower = host.list().find(p => p.name === 'thrower');
  assert.equal(thrower.status, 'disabled');
  assert.match(thrower.error, /disabled for this session/);
  assert.match(thrower.error, /daimon daemon restart/);

  // Subsequent events reached the surviving plugin.
  const rows = fs.readFileSync(seen, 'utf8').trim().split('\n');
  assert.deepEqual(rows, ['1', '2', '3']);
});

test('throw-in-onAppStart disables that plugin only', async () => {
  const dir = setupDir();
  write(dir, 'starter.mjs', `export default { name: 'starter', apiVersion: 1,
    onAppStart() { throw new Error('start boom'); } };`);
  const errors = [];
  const host = new PluginHost(await loadPlugins(dir), { onPluginError: e => errors.push(e) });
  host.setSnapshotProvider(name => ({ name, framework: null, port: null, pid: null, status: 'starting' }));
  host.handleRegistryEvent(EVT());
  await flushDispatch();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].hook, 'onAppStart');
  assert.equal(host.list()[0].status, 'disabled');
});

test('async rejection in a hook disables the plugin (awaited off-path)', async () => {
  const dir = setupDir();
  write(dir, 'rejector.mjs', `export default { name: 'rejector', apiVersion: 1,
    async onEvent() { await Promise.resolve(); throw new Error('async boom'); } };`);
  const errors = [];
  const host = new PluginHost(await loadPlugins(dir), { onPluginError: e => errors.push(e) });
  host.handleRegistryEvent(EVT({ ts: 1 }));
  await flushDispatch();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'async boom');
  assert.equal(host.list()[0].status, 'disabled');
});

test('Nth-call throw: works N-1 times, then exactly one plugin-error', async () => {
  const dir = setupDir();
  const seen = path.join(dir, 'calls.txt');
  write(dir, 'nth.mjs', `import fs from 'node:fs';
    let calls = 0;
    export default { name: 'nth', apiVersion: 1,
      onEvent() { calls++; fs.appendFileSync(${JSON.stringify(seen)}, calls + '\\n'); if (calls === 3) throw new Error('third call boom'); } };`);
  const errors = [];
  const host = new PluginHost(await loadPlugins(dir), { onPluginError: e => errors.push(e) });
  for (let i = 1; i <= 5; i++) host.handleRegistryEvent(EVT({ ts: i }));
  await flushDispatch();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'third call boom');
  // Calls 4 and 5 never reached the disabled plugin.
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), ['1', '2', '3']);
  assert.equal(host.list()[0].status, 'disabled');
});

test('throwing doctor-rule check disables its plugin; other plugins unaffected', async () => {
  const dir = setupDir();
  write(dir, 'crasher.mjs', `export default { name: 'crasher', apiVersion: 1,
    registerDoctorRules() { return [{ id: 'boom', description: 'always throws', check() { throw new Error('rule boom'); } }]; } };`);
  write(dir, 'steady.mjs', `export default { name: 'steady', apiVersion: 1,
    registerDoctorRules() { return [{ id: 'fine', description: 'always ok', check() { return { ok: true }; } }]; } };`);
  const errors = [];
  const host = new PluginHost(await loadPlugins(dir), { onPluginError: e => errors.push(e) });
  await host.runDoctorRules({ config: {}, apps: [] });
  const byName = n => host.list().find(p => p.name === n);
  assert.equal(byName('crasher').status, 'disabled');
  assert.equal(errors.length, 1);
  assert.equal(byName('steady').status, 'active');
  assert.deepEqual(byName('steady').findings, [{ rule: 'fine', ok: true, detail: undefined }]);
  // Disabled plugins contribute no rules anymore.
  assert.deepEqual(host.doctorRules().map(r => r.rule.id), ['fine']);
});

test('disable is idempotent: a plugin throwing in two hooks reports once', async () => {
  const dir = setupDir();
  write(dir, 'double.mjs', `export default { name: 'double', apiVersion: 1,
    onEvent() { throw new Error('boom A'); },
    onAppStart() { throw new Error('boom B'); } };`);
  const errors = [];
  const host = new PluginHost(await loadPlugins(dir), { onPluginError: e => errors.push(e) });
  host.setSnapshotProvider(name => ({ name, framework: null, port: null, pid: null, status: 'starting' }));
  // One event triggers BOTH hooks in the same dispatch tick.
  host.handleRegistryEvent(EVT());
  await flushDispatch();
  assert.equal(errors.length, 1);
  assert.equal(host.list()[0].status, 'disabled');
});

// ---------------------------------------------------------------------------
// Real-daemon torture (lifecycle-torture recipe): isolated DAIMON_HOME with a
// plugins dir full of hostile files. The daemon must boot, serve, record the
// plugin-error, and shut down cleanly.
// ---------------------------------------------------------------------------

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugiso-home-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';
const { lockPath } = await import('../dist/daemon.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function getJson(port, pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'x-daimon-agent': 'plugiso-agent-0001' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function postJson(port, pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers: { 'x-daimon-agent': 'plugiso-agent-0001' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

function writeMinimalConfig(home) {
  // The daemon's cwd is `home`, so this local daimon.config.json is the
  // config it loads (no config → the daemon writes a stub and exits).
  fs.writeFileSync(path.join(home, 'daimon.config.json'), JSON.stringify({
    searchRoots: [],
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
  }));
}

function spawnDaemon(home, apiPort) {
  const child = spawn(process.execPath, [mainJs, '--headless'], {
    cwd: home,
    env: { ...process.env, DAIMON_HOME: home, DAIMON_PORT: String(apiPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  return { child, stdout: () => out, stderr: () => err };
}

async function waitForDaemon(apiPort, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await getJson(apiPort, '/api/signature');
    if (r.status === 200 && r.body?.daimon === true) return r.body;
    await sleep(250);
  }
  throw new Error(`daemon on :${apiPort} did not answer /api/signature within ${timeoutMs}ms`);
}

async function shutdownDaemon(apiPort, child, timeoutMs = 10_000) {
  await postJson(apiPort, '/api/shutdown');
  const t0 = Date.now();
  while (child.exitCode === null && Date.now() - t0 < timeoutMs) await sleep(150);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
}

if (!lockPath().startsWith(fakeHome)) {
  test('plugin isolation cannot isolate ~/.daimon on this OS — skipping daemon cases', () => {});
} else {
  test('torture: daemon boots and serves through hostile plugins; plugin-error lands in events', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugiso-d1-'));
    writeMinimalConfig(home);
    const pluginsDir = path.join(home, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const jsonl = path.join(home, 'observed.jsonl');

    // a- loads first and explodes at import; b- throws on its first onEvent;
    // c- observes events to a JSONL file; d- is a legacy-shape plug-in.
    fs.writeFileSync(path.join(pluginsDir, 'a-exploder.mjs'), `throw new Error('import kaboom');`);
    fs.writeFileSync(path.join(pluginsDir, 'b-thrower.mjs'),
      `export default { name: 'thrower', apiVersion: 1, onEvent() { throw new Error('first event boom'); } };`);
    fs.writeFileSync(path.join(pluginsDir, 'c-observer.mjs'), `import fs from 'node:fs';
export default { name: 'observer', apiVersion: 1,
  onEvent(evt) { fs.appendFileSync(${JSON.stringify(jsonl)}, JSON.stringify(evt) + '\\n'); } };`);
    fs.writeFileSync(path.join(pluginsDir, 'd-legacy.mjs'),
      `export default { name: 'legacy', scan: async () => [] };`);

    const apiPort = await pickFreePort();
    const d = spawnDaemon(home, apiPort);
    try {
      await waitForDaemon(apiPort);

      // The skip self-warns (exploder + legacy) are events; they trigger the
      // thrower (disabled on the first) and the observer (records them all).
      const t0 = Date.now();
      let plugins = [];
      while (Date.now() - t0 < 10_000) {
        const r = await getJson(apiPort, '/api/plugins');
        plugins = Array.isArray(r.body) ? r.body : [];
        if (plugins.find(p => p.name === 'thrower')?.status === 'disabled') break;
        await sleep(250);
      }
      const byName = n => plugins.find(p => p.name === n || p.name.includes(n));
      assert.equal(byName('a-exploder').status, 'load-error');
      assert.match(byName('a-exploder').error, /import kaboom/);
      assert.equal(byName('legacy')?.status ?? byName('d-legacy')?.status, 'load-error');
      assert.equal(byName('thrower').status, 'disabled');
      assert.equal(byName('observer').status, 'active');

      // Daemon still serving after all of that.
      const sig = await getJson(apiPort, '/api/signature');
      assert.equal(sig.status, 200);
      assert.equal(sig.body.daimon, true);

      // Exactly one plugin-error event, carrying the stack.
      const evR = await getJson(apiPort, '/api/events?limit=200');
      const events = Array.isArray(evR.body) ? evR.body : (evR.body?.events ?? []);
      const pluginErrors = events.filter(e => (e.type ?? e.kind) === 'plugin-error');
      assert.equal(pluginErrors.length, 1);
      assert.match(pluginErrors[0].message ?? '', /thrower/);
      assert.match(pluginErrors[0].message ?? '', /first event boom/);

      // The observer really observed events (fire-and-forget dispatch works
      // in-daemon), and received the load-skip self-warns.
      assert.ok(fs.existsSync(jsonl), 'observer wrote its JSONL file');
      const observed = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.ok(observed.some(e => e.type === 'self-warn' && /plug-in skipped/.test(e.message ?? '')));

      await shutdownDaemon(apiPort, d.child);
      assert.equal(d.child.exitCode, 0, `daemon exit code ${d.child.exitCode}; stderr: ${d.stderr()}`);
    } finally {
      if (d.child.exitCode === null) { try { d.child.kill('SIGKILL'); } catch {} }
    }
  });

  test('torture: plugins dir with ONLY broken files — daemon still boots clean', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-plugiso-d2-'));
    writeMinimalConfig(home);
    const pluginsDir = path.join(home, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'syntax-error.mjs'), `export default { name: 'nope'`);
    fs.writeFileSync(path.join(pluginsDir, 'bad-require.mjs'), `import 'this-module-does-not-exist-daimon';\nexport default { name: 'x', apiVersion: 1 };`);

    const apiPort = await pickFreePort();
    const d = spawnDaemon(home, apiPort);
    try {
      await waitForDaemon(apiPort);
      const r = await getJson(apiPort, '/api/plugins');
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 2);
      assert.ok(r.body.every(p => p.status === 'load-error'));
      await shutdownDaemon(apiPort, d.child);
      assert.equal(d.child.exitCode, 0);
    } finally {
      if (d.child.exitCode === null) { try { d.child.kill('SIGKILL'); } catch {} }
    }
  });
}
