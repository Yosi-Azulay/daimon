import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// M81 — port management + forensics: ports.pool config, registry-declared
// portFlag/portEnv injection, pool persistence + release, `GET /api/ports`,
// apiPort EADDRINUSE forensics, and doctor's port-holder-no-lock rule.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-ports-'));

const { parsePortPool, PortAllocator, isPortFree } = await import('../dist/ports.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { inspectApiPort, renderApiPortConflict, probeDaimonSignature, scanListeningPorts } = await import('../dist/portDiag.js');
const { builtinProfiles } = await import('../dist/frameworks.js');

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43200, 43290], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: path.join(tmp, 'history.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 }, restartStorm: { perHour: 20 },
    ...overrides,
  };
}

function echoApp(name, extra = {}) {
  return {
    name, baseName: name, workspaceRoot: tmp, workspaceType: 'polyglot',
    // Echoes argv + PORT then exits; trailing `--` so injected flags land in
    // argv instead of being parsed as node options.
    command: `node -e "console.log('ARGS['+process.argv.slice(1).join(' ')+'] PORT['+(process.env.PORT||'unset')+'] FRP['+(process.env.FLASK_RUN_PORT||'unset')+']')" --`,
    hidden: false, tags: [],
    ...extra,
  };
}

async function runToExit(reg, name) {
  const exited = new Promise(resolve => reg.once('childExit', resolve));
  const r = await reg.start(name);
  assert.equal(r.ok, true, `start ok (${JSON.stringify(r)})`);
  await exited;
  // Log lines flush on the chunk handler — give the pipe a beat.
  await new Promise(res => setTimeout(res, 200));
  return (reg.getState(name)?.logBuffer ?? []).map(l => l.line).join('\n');
}

test('parsePortPool accepts min-max and rejects junk', () => {
  assert.deepEqual(parsePortPool('4200-4299'), [4200, 4299]);
  assert.deepEqual(parsePortPool(' 4300 - 4301 '), [4300, 4301]);
  assert.equal(parsePortPool('4299-4200'), null);
  assert.equal(parsePortPool('0-100'), null);
  assert.equal(parsePortPool('4200'), null);
  assert.equal(parsePortPool('4200-99999'), null);
  assert.equal(parsePortPool(null), null);
  assert.equal(parsePortPool(undefined), null);
});

test('config validation: ports.pool accepts a range, rejects junk with a warning', async () => {
  const { validateConfig, configValidationWarnings } = await import('../dist/config.js');
  const good = validateConfig({ ports: { pool: '4300-4310' } }, 'test');
  assert.equal(good.ports.pool, '4300-4310');
  const bad = validateConfig({ ports: { pool: 'not-a-range' } }, 'test');
  assert.equal(bad.ports, undefined, 'malformed pool falls back to absent');
  assert.ok(configValidationWarnings().some(w => w.includes('ports.pool')), 'warning surfaced');
  const off = validateConfig({ ports: { pool: null } }, 'test');
  assert.deepEqual(off.ports, {}, 'explicit null = disabled, no warning');
});

test('config validation: custom profiles may declare portFlag/portEnv, junk skipped', async () => {
  const { validateConfig, configValidationWarnings } = await import('../dist/config.js');
  const cfg = validateConfig({
    frameworks: [
      { id: 'good-fw', command: 'run dev', detect: { files: ['marker'] }, portFlag: '--port {port}', portEnv: 'MY_PORT' },
      { id: 'bad-flag', command: 'run dev', detect: { files: ['marker'] }, portFlag: '--port' },
      { id: 'bad-env', command: 'run dev', detect: { files: ['marker'] }, portEnv: 'not a var!' },
    ],
  }, 'test');
  assert.equal(cfg.frameworks.length, 1, 'invalid rows skipped');
  assert.equal(cfg.frameworks[0].portFlag, '--port {port}');
  assert.equal(cfg.frameworks[0].portEnv, 'MY_PORT');
  const warnings = configValidationWarnings();
  assert.ok(warnings.some(w => w.includes('bad-flag')), 'portFlag without {port} warned');
  assert.ok(warnings.some(w => w.includes('bad-env')), 'invalid env var name warned');
});

test('registry rows: documented frameworks declare injection, fallback does not', () => {
  const byId = new Map(builtinProfiles().map(p => [p.id, p]));
  assert.equal(byId.get('vite').portFlag, '--port {port}');
  assert.equal(byId.get('angular').portFlag, '--port {port}');
  assert.equal(byId.get('nextjs').portFlag, '-p {port}');
  assert.equal(byId.get('nextjs').portEnv, 'PORT');
  assert.equal(byId.get('django').portFlag, '127.0.0.1:{port}');
  assert.equal(byId.get('express-nest').portEnv, 'PORT');
  assert.equal(byId.get('express-nest').portFlag, undefined);
  // Explicit non-participation: the generic fallback row never gets a port.
  assert.equal(byId.get('package-json').portFlag, undefined);
  assert.equal(byId.get('package-json').portEnv, undefined);
});

test('pool mode: vite profile gets a pool port injected via --port', async () => {
  const cfg = baseCfg({ ports: { pool: '43400-43405' } });
  const reg = new Registry(cfg, [echoApp('viteish', { serverProfile: 'vite' })]);
  const logs = await runToExit(reg, 'viteish');
  const m = logs.match(/--port (\d+)/);
  assert.ok(m, `--port injected (logs: ${logs})`);
  const port = Number(m[1]);
  assert.ok(port >= 43400 && port <= 43405, `port ${port} from the pool`);
  const report = reg.portsReport().find(r => r.app === 'viteish');
  assert.equal(report.source, 'pool');
  assert.equal(report.port, port);
});

test('pool mode: portEnv-only profile gets the env var, no flag', async () => {
  const cfg = baseCfg({ ports: { pool: '43410-43415' } });
  const reg = new Registry(cfg, [echoApp('apiish', { serverProfile: 'express-nest' })]);
  const logs = await runToExit(reg, 'apiish');
  assert.ok(!/--port/.test(logs), 'no flag injected');
  const m = logs.match(/PORT\[(\d+)\]/);
  assert.ok(m, `PORT env set (logs: ${logs})`);
  assert.ok(Number(m[1]) >= 43410 && Number(m[1]) <= 43415);
});

test('pool mode: non-declaring profile gets NO injection and claims no port', async () => {
  const cfg = baseCfg({ ports: { pool: '43420-43425' } });
  const reg = new Registry(cfg, [echoApp('plain', { serverProfile: 'package-json' })]);
  const logs = await runToExit(reg, 'plain');
  assert.ok(!/--port/.test(logs), `no --port appended (logs: ${logs})`);
  assert.equal(reg.getState('plain').port, null, 'no port claimed');
});

test('pool mode: pinned port wins and is injected via the declared flag', async () => {
  const cfg = baseCfg({ ports: { pool: '43430-43435' } });
  const reg = new Registry(cfg, [echoApp('pinned', { serverProfile: 'vite', pinnedPort: 43439 })]);
  const logs = await runToExit(reg, 'pinned');
  assert.ok(logs.includes('--port 43439'), `pinned port injected (logs: ${logs})`);
  const report = reg.portsReport().find(r => r.app === 'pinned');
  assert.equal(report.source, 'pinned');
});

test('legacy mode (no ports.pool): --port + PORT still appended for every app', async () => {
  const cfg = baseCfg();
  const reg = new Registry(cfg, [echoApp('legacy', { serverProfile: 'package-json' })]);
  const logs = await runToExit(reg, 'legacy');
  const m = logs.match(/--port (\d+)/);
  assert.ok(m, `legacy --port appended (logs: ${logs})`);
  assert.ok(logs.includes(`PORT[${m[1]}]`), 'legacy PORT env set');
});

test('pool assignments persist across allocator restarts and release on detach', async () => {
  let snapshot = {};
  const a1 = new PortAllocator([43440, 43445], { onChange: s => { snapshot = s; } });
  const p = await a1.allocate('web');
  assert.ok(p >= 43440 && p <= 43445);
  // "Daemon restart": a fresh allocator seeded from the persisted snapshot.
  const a2 = new PortAllocator([43440, 43445], { initial: snapshot, onChange: s => { snapshot = s; } });
  assert.equal(a2.getAssigned('web'), p, 'assignment survives restart');
  a2.release('web');
  assert.equal(a2.getAssigned('web'), undefined);
  assert.deepEqual(snapshot, {}, 'release persisted');
});

test('GET /api/ports lists apps with source and flags a foreign holder', async () => {
  const cfg = baseCfg({ ports: { pool: '43450-43454' } });
  const reg = new Registry(cfg, [echoApp('viteish2', { serverProfile: 'vite' })]);
  await runToExit(reg, 'viteish2'); // allocates 43450, then exits (status stopped/error)
  // Foreign holder must be a DIFFERENT process — the route rightly ignores
  // listeners owned by the daemon process itself (its own apiPort).
  const foreignChild = spawn(process.execPath, ['-e', `
    require('net').createServer().listen(43453, '127.0.0.1', () => console.log('up'));
    setTimeout(() => process.exit(0), 30000);
  `], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  await new Promise(resolve => {
    foreignChild.stdout.on('data', () => resolve());
    setTimeout(resolve, 3000);
  });
  const server = startServer(reg, 0, { getConfig: () => cfg });
  await new Promise(res => server.once('listening', res));
  const apiPort = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/ports`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.pool, '43450-43454');
    const app = body.apps.find(a => a.app === 'viteish2');
    assert.ok(app, 'app listed');
    assert.equal(app.source, 'pool');
    assert.ok(app.port >= 43450 && app.port <= 43454);
    const foreign = body.foreign.find(f => f.port === 43453);
    assert.ok(foreign, `foreign holder listed (got ${JSON.stringify(body.foreign)})`);
    assert.equal(foreign.pid, foreignChild.pid);
  } finally {
    server.close();
    try { foreignChild.kill(); } catch {}
  }
});

test('scanListeningPorts finds a seeded listener in one pass', async () => {
  const srv = net.createServer();
  await new Promise(res => srv.listen(43460, '127.0.0.1', res));
  try {
    const map = scanListeningPorts([43460, 43461]);
    assert.ok(map.has(43460), 'seeded port found');
    assert.ok(!map.has(43461), 'free port absent');
  } finally {
    srv.close();
  }
});

test('EADDRINUSE forensics: non-daimon holder named with pid + advise-only remedy', async () => {
  // An http 404-er, not a silent TCP socket: the signature probe resolves
  // immediately instead of eating 2×1.5s timeouts (suite wall-clock budget).
  const srv = http.createServer((_req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise(res => srv.listen(43470, '127.0.0.1', res));
  try {
    // Contention-immune (M91): the forensics tests assert CLASSIFICATION, not
    // speed — a generous probe ceiling stops a saturated host from turning a
    // slow-but-correct response into a false timeout. Production stays 1.5s.
    const f = await inspectApiPort(43470, false, { probeTimeoutMs: 15000 });
    assert.ok(f.holder, 'holder identified');
    assert.equal(f.holder.pid, process.pid, 'holder pid is the seeding process');
    assert.ok(!f.signature?.daimon, 'not a daimon');
    const lines = renderApiPortConflict(f, path.join(tmp, 'dump.txt'));
    const text = lines.join('\n');
    assert.ok(text.includes('EADDRINUSE'));
    assert.ok(text.includes(`pid ${process.pid}`), `names the pid (${text})`);
    assert.ok(/kill pid \d+ if it is unexpected|change apiPort/.test(text), 'advises, never auto-kills');
    assert.ok(text.includes('dump.txt'), 'crash dump path included');
  } finally {
    srv.close();
  }
});

test('EADDRINUSE forensics: daimon-signature holder gets the auto-fix remedy', async () => {
  const fake = http.createServer((req, res) => {
    if (req.url === '/api/signature') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ daimon: true, version: '9.9.9', pid: process.pid }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise(res => fake.listen(43471, '127.0.0.1', res));
  try {
    const sig = await probeDaimonSignature(43471);
    assert.equal(sig?.daimon, true);
    assert.equal(sig?.version, '9.9.9');
    const f = await inspectApiPort(43471, false, { probeTimeoutMs: 15000 });
    assert.equal(f.signature?.daimon, true);
    const text = renderApiPortConflict(f).join('\n');
    assert.ok(text.includes('responds as a daimon'), text);
    assert.ok(text.includes('daimon doctor --auto-fix'), 'points at the orphan auto-fix');
  } finally {
    fake.close();
  }
});

// ---------------------------------------------------------------------------
// Doctor rule + auto-fix (verify-then-kill). These isolate daimon state via
// DAIMON_HOME and write the config the CLI-side loadConfig() will read.
// ---------------------------------------------------------------------------

function writeIsolatedConfig(apiPort) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  process.env.DAIMON_HOME = home;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...baseCfg(), apiPort, history: { enabled: false, path: path.join(home, 'h.db'), retentionDays: 1 } }));
  return home;
}

function spawnDaimonDouble(port) {
  // A detached daimon lookalike: answers /api/signature like the real daemon.
  const script = `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/signature') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ daimon: true, version: '0.0.0-double', pid: process.pid })); return; }
      res.writeHead(404); res.end('{}');
    });
    srv.listen(${port}, '127.0.0.1', () => console.log('up'));
    setTimeout(() => process.exit(0), 30000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return new Promise(resolve => {
    child.stdout.on('data', () => resolve(child));
    setTimeout(() => resolve(child), 3000);
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

test('doctor auto-fix terminates a verified daimon orphan (no lock)', async () => {
  const prevHome = process.env.DAIMON_HOME;
  const port = 43480;
  writeIsolatedConfig(port);
  const child = await spawnDaimonDouble(port);
  try {
    assert.equal(await isPortFree(port), false, 'double is listening');
    const { runAutoFix } = await import('../dist/autoFix.js');
    const r = await runAutoFix({ permitted: ['port-holder-no-lock'] });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    const ran = r.ran.find(x => x.name === 'port-holder-no-lock');
    assert.ok(ran, `fix ran (${JSON.stringify(r)})`);
    assert.ok(/terminated verified orphan daimon pid \d+/.test(ran.description), ran.description);
    // The double should actually be gone.
    for (let i = 0; i < 30 && pidAlive(child.pid); i++) await new Promise(res => setTimeout(res, 100));
    assert.equal(pidAlive(child.pid), false, 'orphan process terminated');
  } finally {
    try { child.kill(); } catch {}
    if (prevHome === undefined) delete process.env.DAIMON_HOME; else process.env.DAIMON_HOME = prevHome;
  }
});

test('doctor auto-fix REFUSES a non-daimon holder', async () => {
  const prevHome = process.env.DAIMON_HOME;
  const port = 43481;
  writeIsolatedConfig(port);
  const srv = http.createServer((_req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise(res => srv.listen(port, '127.0.0.1', res));
  try {
    const { runAutoFix } = await import('../dist/autoFix.js');
    const r = await runAutoFix({ permitted: ['port-holder-no-lock'] });
    assert.equal(r.ran.length, 0, `nothing killed (${JSON.stringify(r.ran)})`);
    const skipped = r.skipped.find(x => x.name === 'port-holder-no-lock');
    assert.ok(skipped, 'rule evaluated');
    assert.ok(/NON-daimon|refusing to kill/i.test(skipped.description), skipped.description);
    // Still alive: we can still accept connections.
    assert.equal(await isPortFree(port), false, 'holder untouched');
  } finally {
    srv.close();
    if (prevHome === undefined) delete process.env.DAIMON_HOME; else process.env.DAIMON_HOME = prevHome;
  }
});

test('runDoctor reports port-holder-no-lock ok when apiPort is free', async () => {
  const prevHome = process.env.DAIMON_HOME;
  process.env.DAIMON_HOME = fs.mkdtempSync(path.join(tmp, 'home-free-'));
  try {
    const { runDoctor } = await import('../dist/doctor.js');
    const cfg = baseCfg({ apiPort: 43482 });
    const r = await runDoctor(cfg, []);
    const check = r.checks.find(c => c.name === 'port-holder-no-lock');
    assert.ok(check, 'rule present');
    assert.equal(check.ok, true);
  } finally {
    if (prevHome === undefined) delete process.env.DAIMON_HOME; else process.env.DAIMON_HOME = prevHome;
  }
});

test('GET /api/signature identifies the daemon', async () => {
  const reg = new Registry(baseCfg(), []);
  const server = startServer(reg, 0, {});
  await new Promise(res => server.once('listening', res));
  const apiPort = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/signature`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.daimon, true);
    assert.equal(body.pid, process.pid);
    assert.ok(typeof body.version === 'string' && body.version.length > 0);
  } finally {
    server.close();
  }
});
