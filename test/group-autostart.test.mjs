import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// autoStart groups at daemon boot (M96, v1.1): a REAL daemon (DAIMON_HOME
// isolated, torture-suite pattern) boots a config where one app is named by
// two autoStart groups and another by the per-app list + a group. Each spawns
// exactly once (the app itself proves it by appending to a spawn ledger),
// with one dedup log line naming every source; an unknown member warns and
// never blocks the rest.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = path.join(repoRoot, 'dist', 'main.js');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-gauto-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

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
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'x-daimon-agent': 'gauto-agent-0001' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

// One discoverable app: package.json `dev` script → a node server that
// APPENDS its pid to spawns-<name>.log on boot (the spawn ledger) and serves
// 200 on its pinned port.
function writeApp(home, name, appPort) {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name, private: true, scripts: { dev: 'node server.js' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http');",
    "const fs = require('fs');",
    "const path = require('path');",
    `fs.appendFileSync(path.join(${JSON.stringify(home)}, 'spawns-${name}.log'), process.pid + '\\n');`,
    `const port = Number(process.env.PORT || 0) || ${appPort};`,
    "http.createServer((req, res) => { res.writeHead(200, {'content-type': 'text/plain'}); res.end('ok'); })",
    "  .listen(port, '127.0.0.1', () => console.log(`Server listening on http://127.0.0.1:${port}`));",
    'setInterval(() => {}, 60_000);',
  ].join('\n'));
  return dir;
}

function spawnLedger(home, name) {
  const p = path.join(home, `spawns-${name}.log`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

test('boot: overlapping autoStart groups spawn each app once, log once, degrade on unknown members', { timeout: 120_000 }, async () => {
  const apiPort = await pickFreePort();
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const dirA = writeApp(fakeHome, 'app-a', portA);
  const dirB = writeApp(fakeHome, 'app-b', portB);
  fs.writeFileSync(path.join(fakeHome, 'daimon.config.json'), JSON.stringify({
    searchRoots: [dirA, dirB],
    apiPort,
    overrides: { 'app-a': { port: portA }, 'app-b': { port: portB } },
    // app-a: named by BOTH groups. app-b: per-app list + morning group.
    // ghost: unknown member — warns, never blocks the others.
    autoStart: ['app-b'],
    groups: {
      morning: { apps: ['app-a', 'app-b', 'ghost'], autoStart: true },
      evening: { apps: ['app-a'], autoStart: true },
    },
    healthProbe: { enabled: true, intervalMs: 500, timeoutMs: 1500, path: '/' },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    history: { enabled: false, path: path.join(fakeHome, 'history.db'), retentionDays: 1 },
    logs: { enabled: false },
  }, null, 2));

  const child = spawn(process.execPath, [mainJs, '--headless'], {
    cwd: fakeHome,
    env: { ...process.env, DAIMON_HOME: fakeHome, DAIMON_PORT: String(apiPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });

  try {
    // Wait for the daemon, then for both apps to reach serving.
    const t0 = Date.now();
    let sig = null;
    while (Date.now() - t0 < 30_000) {
      const r = await getJson(apiPort, '/api/signature');
      if (r.status === 200 && r.body?.daimon === true) { sig = r.body; break; }
      await sleep(250);
    }
    assert.ok(sig, `daemon did not come up.\nstdout: ${out}\nstderr: ${err}`);

    // Wait until both children are really up (spawn ledger written AND their
    // daemon-assigned ports answer) — the same readiness signal the torture
    // suite uses; fresh package-json starts don't flip to 'serving' without
    // framework readiness, and that's not what M96 asserts.
    let apps = [];
    let answering = 0;
    while (Date.now() - t0 < 60_000) {
      const r = await getJson(apiPort, '/api/apps');
      apps = Array.isArray(r.body) ? r.body : [];
      const ledgersReady = spawnLedger(fakeHome, 'app-a').length >= 1 && spawnLedger(fakeHome, 'app-b').length >= 1;
      const ports = apps.filter(a => a.port != null).map(a => a.port);
      if (ledgersReady && ports.length === 2) {
        const oks = await Promise.all(ports.map(p =>
          fetch(`http://127.0.0.1:${p}/`).then(r2 => r2.ok).catch(() => false)));
        answering = oks.filter(Boolean).length;
        if (answering === 2) break;
      }
      await sleep(400);
    }
    assert.deepEqual(apps.map(a => a.name).sort(), ['app-a', 'app-b'], `both members known.\nstdout: ${out}\nstderr: ${err}`);
    assert.equal(answering, 2, `both members answering on their ports.\nstdout: ${out}\nstderr: ${err}`);

    // The spawn ledger proves "starts once": exactly one boot line per app.
    assert.equal(spawnLedger(fakeHome, 'app-a').length, 1, 'app-a spawned exactly once');
    assert.equal(spawnLedger(fakeHome, 'app-b').length, 1, 'app-b spawned exactly once');

    // One dedup line per multi-source app, naming every source.
    const dedupA = out.split('\n').filter(l => l.includes('autoStart: app-a requested by'));
    assert.equal(dedupA.length, 1, `one dedup line for app-a:\n${out}`);
    assert.match(dedupA[0], /group:morning/);
    assert.match(dedupA[0], /group:evening/);
    assert.match(dedupA[0], /starting once/);
    const dedupB = out.split('\n').filter(l => l.includes('autoStart: app-b requested by'));
    assert.equal(dedupB.length, 1, `one dedup line for app-b:\n${out}`);
    assert.match(dedupB[0], /\bautoStart\b/);
    assert.match(dedupB[0], /group:morning/);

    // Unknown member warns (with its sources) and blocked nothing.
    assert.match(err, /autoStart references unknown app "ghost" \(group:morning\)/);
  } finally {
    await getJson(apiPort, '/api/shutdown').catch(() => {});
    try {
      await fetch(`http://127.0.0.1:${apiPort}/api/shutdown`, { method: 'POST' }).catch(() => {});
    } catch {}
    const t1 = Date.now();
    while (child.exitCode === null && Date.now() - t1 < 10_000) await sleep(150);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  }
});
