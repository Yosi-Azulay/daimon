import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Lifecycle torture suite (M88). Everything runs against DAIMON_HOME
// isolation — never the real state dir. Covers:
//   • state.json atomic write + .bak recovery + archive-corrupt + fresh start
//   • session-state.json .bak recovery
//   • CLI↔daemon version-skew warning (stderr, never a hard fail)
//   • double-start (second daemon exits with EADDRINUSE forensics)
//   • daemon restart under load: handoff re-adopts the RUNNING child
//     (same pid), health returns, stop() actually kills the adopted tree
//   • unverifiable handoff child surfaces as status 'orphaned' with a remedy

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = path.join(repoRoot, 'dist', 'main.js');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-torture-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const { lockPath, isPidAlive } = await import('../dist/daemon.js');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'x-daimon-agent': 'torture-agent-0001' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function postJson(port, pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers: { 'x-daimon-agent': 'torture-agent-0001' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

function spawnDaemon(home, apiPort, cwd = home) {
  const child = spawn(process.execPath, [mainJs, '--headless'], {
    cwd,
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

function cli(home, apiPort, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: home,
      env: { ...process.env, DAIMON_HOME: home, DAIMON_PORT: String(apiPort), DAIMON_NO_SPAWN: '1', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 20_000);
    child.on('close', code => {
      clearTimeout(killer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------

if (!lockPath().startsWith(fakeHome)) {
  test('lifecycle torture cannot isolate ~/.daimon on this OS — skipping', () => {});
} else {

  test('torture: state.json survives corruption via .bak; double corruption archives + fresh start', async () => {
    // Isolated sub-home so daemon tests below don't see this state.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-torture-state-'));
    const prevHome = process.env.DAIMON_HOME;
    process.env.DAIMON_HOME = home;
    try {
      const { loadPersistedState, savePersistedState, flushPersistedState, stateLoadDiagnostics } = await import('../dist/stateFile.js');
      const statePath = path.join(home, 'state.json');

      // Two writes so a .bak of a GOOD version exists.
      loadPersistedState();
      savePersistedState({ ports: { web: 4211 } });
      flushPersistedState();
      savePersistedState({ ports: { web: 4211, api: 4212 }, mutes: { web: null } });
      flushPersistedState();
      assert.ok(fs.existsSync(statePath), 'state.json written');
      assert.ok(fs.existsSync(statePath + '.bak'), '.bak of the previous good version kept');

      // Kill-mid-write simulation: truncate main to garbage. Load must recover
      // the last good version from .bak — never a silent reset.
      fs.writeFileSync(statePath, '{"ports": {"web": 42', 'utf8');
      const recovered = loadPersistedState();
      assert.equal(recovered.ports.web, 4211, 'recovered ports from .bak');
      assert.equal(stateLoadDiagnostics().recoveredFromBak, true, 'recovery is reported, not silent');
      assert.ok(fs.existsSync(statePath), 'main healed from .bak');
      assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).ports, { web: 4211 }, 'healed main holds the recovered state');

      // Torch BOTH copies: archive-corrupt + fresh start (mirrors history.db).
      fs.writeFileSync(statePath, 'not json at all', 'utf8');
      fs.writeFileSync(statePath + '.bak', 'also garbage', 'utf8');
      const fresh = loadPersistedState();
      assert.deepEqual(fresh, { ports: {} }, 'fresh state after total corruption');
      const diag = stateLoadDiagnostics();
      assert.ok(diag.archivedCorruptPath && /state\.json\.corrupt-\d+$/.test(diag.archivedCorruptPath), `corrupt file archived (${diag.archivedCorruptPath})`);
      assert.ok(fs.existsSync(diag.archivedCorruptPath), 'archive exists on disk for forensics');
    } finally {
      process.env.DAIMON_HOME = prevHome;
    }
  });

  test('torture: session-state.json recovers from .bak when main is torn', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-torture-session-'));
    const { saveSessionState, loadSessionState } = await import('../dist/sessionState.js');
    const file = path.join(home, 'session-state.json');
    const snapA = { savedAt: Date.now(), apps: [{ name: 'web', status: 'serving', port: 4211, errors: [], logTail: [{ ts: Date.now(), line: 'hello' }], compileHistory: [500] }] };
    saveSessionState(snapA, file);
    saveSessionState({ ...snapA, savedAt: Date.now() }, file); // second write creates .bak
    fs.writeFileSync(file, '{"savedAt": 12', 'utf8'); // torn write
    const loaded = loadSessionState(file);
    assert.ok(loaded, 'recovered from .bak');
    assert.equal(loaded.apps[0].name, 'web');
    assert.equal(loaded.apps[0].logTail[0].line, 'hello');
  });

  test('torture: version-skew probe — old daemon warns on stderr, same-version daemon stays quiet, never a hard fail', async () => {
    // A fake pre-v0.14 daemon: answers /api/apps but sends no version header.
    const oldDaemon = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    oldDaemon.listen(0, '127.0.0.1');
    await new Promise(r => oldDaemon.once('listening', r));
    const oldPort = oldDaemon.address().port;
    const skewed = await cli(fakeHome, oldPort, ['list', '--all']);
    oldDaemon.close();
    assert.equal(skewed.status, 0, 'skew is a warning, never a hard fail');
    assert.match(skewed.stderr, /warning: CLI v.+daemon running/i, 'skew warning printed');
    assert.match(skewed.stderr, /daimon daemon restart/, 'warning names the exact remedy');

    // Same-version daemon (the real startServer from this dist): no warning.
    const { Registry } = await import('../dist/registry.js');
    const { startServer } = await import('../dist/server.js');
    const config = minimalConfig(fakeHome);
    const reg = new Registry(config, []);
    const server = startServer(reg, 0, { getConfig: () => config });
    await new Promise(r => server.once('listening', r));
    const samePort = server.address().port;
    const clean = await cli(fakeHome, samePort, ['list', '--all']);
    server.close();
    assert.equal(clean.status, 0);
    assert.ok(!/warning: CLI v/.test(clean.stderr), `no skew warning against a same-version daemon (got: ${clean.stderr})`);
  });

  test('torture: double-start — second daemon exits non-zero with EADDRINUSE forensics', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-torture-double-'));
    writeTortureWorkspace(home, 3999); // config only; no app needed here
    const apiPort = await pickFreePort();
    const d1 = spawnDaemon(home, apiPort);
    try {
      await waitForDaemon(apiPort);
      const d2 = spawnDaemon(home, apiPort);
      const t0 = Date.now();
      while (d2.child.exitCode === null && Date.now() - t0 < 20_000) await sleep(250);
      assert.notEqual(d2.child.exitCode, null, 'second daemon must exit, not hang');
      assert.notEqual(d2.child.exitCode, 0, 'second daemon exits non-zero');
      const err = d2.stderr();
      assert.match(err, /EADDRINUSE|failed to bind/i, 'stderr names the bind failure');
      assert.match(err, /daimon|pid/i, 'forensics identify the holder');
      // The loser must not have clobbered the winner's lock.
      const lockRaw = JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock'), 'utf8'));
      assert.equal(lockRaw.pid, d1.child.pid, 'winner still owns daemon.lock');
    } finally {
      await shutdownDaemon(apiPort, d1.child);
    }
  });

  test('torture: restart under load — handoff re-adopts the running child (same pid), health returns, stop kills it', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-torture-handoff-'));
    const appPort = await pickFreePort();
    writeTortureWorkspace(home, appPort);
    const apiPort = await pickFreePort();

    // Daemon 1: discover + start the fixture app.
    const d1 = spawnDaemon(home, apiPort);
    let d2 = null;
    try {
      await waitForDaemon(apiPort);
      const list = await getJson(apiPort, '/api/apps?format=full');
      assert.ok(Array.isArray(list.body) && list.body.length === 1, `discovered exactly the fixture app (got ${JSON.stringify(list.body)?.slice(0, 200)})`);
      const appName = list.body[0].name;

      const started = await postJson(apiPort, `/api/apps/${encodeURIComponent(appName)}/start`);
      assert.equal(started.status, 200, JSON.stringify(started.body));

      // Wait until the child is really up: spawn pid tracked AND the app port
      // answers. The identity that must survive the handoff is the pid
      // LISTENING on the app port (the handoff file records exactly that —
      // on Windows the shell/npm wrapper pid dies with the daemon's pipes).
      const { findPortHolder } = await import('../dist/portDiag.js');
      let spawnPid = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 30_000) {
        const ports = await getJson(apiPort, '/api/ports');
        spawnPid = (ports.body?.apps ?? []).find(a => a.app === appName)?.pid ?? null;
        const answering = await fetch(`http://127.0.0.1:${appPort}/`).then(r => r.ok).catch(() => false);
        if (spawnPid != null && answering) break;
        await sleep(300);
      }
      const answering = await fetch(`http://127.0.0.1:${appPort}/`).then(r => r.ok).catch(() => false);
      assert.ok(spawnPid != null && answering, `fixture app must be running with a tracked pid (pid=${spawnPid}, answering=${answering})`);
      const pid = findPortHolder(appPort)?.pid ?? null;
      assert.ok(pid != null, 'listener pid identified on the app port');

      // Handoff: snapshot state, shut down WITHOUT killing the child, restart.
      const snap = await postJson(apiPort, '/api/snapshot-state');
      assert.equal(snap.status, 200);
      await shutdownDaemon(apiPort, d1.child);
      const stillAnswering = await fetch(`http://127.0.0.1:${appPort}/`).then(r => r.ok).catch(() => false);
      assert.ok(isPidAlive(pid), `server process survives the handoff shutdown (pid=${pid} alive=${isPidAlive(pid)} answering=${stillAnswering})\n--- d1 stdout ---\n${d1.stdout()}\n--- d1 stderr ---\n${d1.stderr()}`);
      assert.ok(stillAnswering, 'child still serving during the gap');

      // Daemon 2: must re-adopt the SAME pid, and `daimon list` shows it healthy.
      d2 = spawnDaemon(home, apiPort);
      await waitForDaemon(apiPort);
      const readopted = await getJson(apiPort, `/api/apps/${encodeURIComponent(appName)}?format=full`);
      assert.equal(readopted.body?.status, 'serving', `re-adopted app is serving (got ${readopted.body?.status})`);
      const portsAfter = await getJson(apiPort, '/api/ports');
      const adoptedPid = (portsAfter.body?.apps ?? []).find(a => a.app === appName)?.pid ?? null;
      assert.equal(adoptedPid, pid, `re-adoption keeps the SAME pid (${adoptedPid} vs ${pid})`);

      const healthDeadline = Date.now() + 20_000;
      let health = 'unknown';
      while (Date.now() < healthDeadline) {
        const viaCli = await cli(home, apiPort, ['list', '--all']);
        const rows = JSON.parse(viaCli.stdout.trim().split('\n').pop() || '[]');
        health = rows[0]?.health ?? 'unknown';
        if (health === 'healthy') break;
        await sleep(500);
      }
      assert.equal(health, 'healthy', 'daimon list shows the re-adopted app healthy');

      // stop() must actually kill the adopted tree (no AppProcess exists).
      const stopped = await postJson(apiPort, `/api/apps/${encodeURIComponent(appName)}/stop?steal=1`);
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      const killDeadline = Date.now() + 10_000;
      while (isPidAlive(pid) && Date.now() < killDeadline) await sleep(250);
      assert.ok(!isPidAlive(pid), 'adopted child tree-killed by stop()');
    } finally {
      if (d2) await shutdownDaemon(apiPort, d2.child);
      else await shutdownDaemon(apiPort, d1.child);
    }
  });

  test('torture: unverifiable handoff child surfaces as orphaned with a remedy — never silently dropped, never killed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-torture-orphan-'));
    const appPort = await pickFreePort(); // nothing will listen here
    writeTortureWorkspace(home, appPort);
    const apiPort = await pickFreePort();

    // A live pid that is NOT listening on the announced port = unverifiable.
    const straggler = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    // Craft the handoff file the way an outgoing daemon would have.
    fs.writeFileSync(path.join(home, 'state-handoff.json'), JSON.stringify({
      ts: Date.now(),
      apps: [{ name: 'torture-app', port: appPort, pid: straggler.pid, startedAt: Date.now() - 60_000 }],
    }));

    const d = spawnDaemon(home, apiPort);
    try {
      await waitForDaemon(apiPort);
      const st = await getJson(apiPort, `/api/apps/torture-app?format=full`);
      assert.equal(st.body?.status, 'orphaned', `unverifiable child is 'orphaned' (got ${st.body?.status})`);
      assert.ok(isPidAlive(straggler.pid), 'orphan was NOT blindly killed (verify-then-kill discipline)');
      const events = await getJson(apiPort, '/api/events?since=5m');
      const orphanEvent = (events.body ?? []).find(e => e.app === 'torture-app' && e.to === 'orphaned');
      assert.ok(orphanEvent, 'orphaning recorded as a status event');
      assert.match(orphanEvent.message ?? '', /daimon (why|stop|restart)/, 'event message carries a remedy');

      // The remedy the daemon just printed says `daimon stop torture-app`
      // ends the orphan — that must be TRUE (v0.14 review finding: the kill
      // branch used to gate on `adopted` only, so stop reported success while
      // the orphan kept running).
      const stopped = await postJson(apiPort, '/api/apps/torture-app/stop?steal=1');
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      assert.equal(stopped.body?.status, 'stopped');
      const killDeadline = Date.now() + 10_000;
      while (isPidAlive(straggler.pid) && Date.now() < killDeadline) await sleep(250);
      assert.ok(!isPidAlive(straggler.pid), 'stop on an orphaned child actually kills the tracked pid — the remedy keeps its promise');
    } finally {
      await shutdownDaemon(apiPort, d.child);
      try { straggler.kill(); } catch {}
    }
  });
}

// ---------------------------------------------------------------------------

function minimalConfig(home) {
  return {
    searchRoots: [], portRange: [4310, 4360], apiPort: 0, overrides: {}, autoStart: [], profiles: {}, tags: {},
    autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: path.join(home, 'history.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
  };
}

// A real discoverable workspace: one plain-JS app (package.json `dev` script →
// the generic package-json profile) whose server binds the pinned port and
// answers 200 on '/'. The daemon's cwd is `home`, so the local
// daimon.config.json there is the config the daemon loads.
function writeTortureWorkspace(home, appPort) {
  const appDir = path.join(home, 'torture-app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'torture-app',
    private: true,
    scripts: { dev: 'node server.js' },
  }, null, 2));
  fs.writeFileSync(path.join(appDir, 'server.js'), [
    "const http = require('http');",
    'const port = Number(process.env.PORT || 0) || ' + appPort + ';',
    "http.createServer((req, res) => { res.writeHead(200, {'content-type': 'text/plain'}); res.end('ok'); })",
    "  .listen(port, '127.0.0.1', () => console.log(`Server listening on http://127.0.0.1:${port}`));",
    'setInterval(() => {}, 60_000);',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'daimon.config.json'), JSON.stringify({
    searchRoots: [appDir],
    apiPort: 4999,
    overrides: { 'torture-app': { port: appPort } },
    healthProbe: { enabled: true, intervalMs: 500, timeoutMs: 1500, path: '/' },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    history: { enabled: true, path: path.join(home, 'history.db'), retentionDays: 1 },
    logs: { enabled: false },
  }, null, 2));
}
