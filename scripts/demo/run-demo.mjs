#!/usr/bin/env node
// daimon demo script (M114, v1.4). A deterministic, headless, replayable
// terminal session for a screencast: recording the terminal stays a human
// step, this script only guarantees the same commands print the same shape
// of output every run.
//
// Isolation: everything runs under a throwaway DAIMON_HOME (state) and a
// throwaway workspace dir (config + fixture apps) — the real ~/.daimon is
// NEVER touched. This is the same real-daemon-under-DAIMON_HOME recipe
// proven in test/lifecycle-torture.test.mjs: spawn dist/main.js directly
// with DAIMON_HOME/DAIMON_PORT env, wait for /api/signature, drive
// dist/cli.js against it, shut down via the daemon API, clean up.
//
// Exit 0 on success. Exit 1 with a clear message on failure — always after
// best-effort cleanup (kill anything spawned, remove temp dirs).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const mainJs = path.join(repoRoot, 'dist', 'main.js');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const fixturesDir = path.join(here, 'fixtures');

const FORBIDDEN_STRINGS = ['yosi@flycotech.com'];
const demoAgentId = `daimon-demo-script-${process.pid}`;

// Everything printed goes through here so we can grep the full transcript
// for the forbidden strings before declaring success (defense in depth —
// nothing in this script should ever produce them, but the check is cheap).
const transcriptLines = [];

function log(line) {
  transcriptLines.push(line);
  process.stdout.write(line + '\n');
}

function assertNoForbiddenStrings(...blobs) {
  const haystack = [transcriptLines.join('\n'), ...blobs].join('\n');
  for (const needle of FORBIDDEN_STRINGS) {
    if (haystack.includes(needle)) {
      throw new Error(`demo output contains a forbidden string: "${needle}"`);
    }
  }
}

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
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'x-daimon-agent': 'demo-script-0001' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function postJson(port, pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers: { 'x-daimon-agent': 'demo-script-0001' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
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

function copyFixture(name, destRoot) {
  const src = path.join(fixturesDir, name);
  const dest = path.join(destRoot, name);
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

// Run one CLI command as the screencast would show it: print the invocation,
// run it, print its stdout, return the parsed result. Throws on unexpected
// non-zero exit so the whole demo fails loudly instead of limping on.
// watchdogMs must exceed any --timeout the command itself was given, or this
// kills the child before the command's own timeout can fire.
//
// cwd (the workspace, where daimon.config.json lives) and daimonHome (the
// state dir the daemon was launched with) are deliberately separate — the
// CLI needs DAIMON_HOME to find daemon.lock (e.g. for `daemon stop`), which
// is NOT where the config lives. Conflating them makes `daemon stop` look
// like it worked (`wasRunning:false`, no lock found) while actually leaving
// the daemon running.
function runCli(args, { cwd, daimonHome, apiPort, allowExit = [0], watchdogMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    log(`$ daimon ${args.join(' ')}`);
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd,
      env: {
        ...process.env,
        DAIMON_HOME: daimonHome,
        DAIMON_PORT: String(apiPort),
        DAIMON_NO_SPAWN: '1',
        NO_COLOR: '1',
        // Every command here is a separate CLI process, which would
        // otherwise mint its own agent id (agents.ts generateAgentId) and
        // trip over the previous command's soft-lock on the app. Pin one
        // stable id for the whole demo session — exactly what
        // DAIMON_AGENT_ID is for.
        DAIMON_AGENT_ID: demoAgentId,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, watchdogMs);
    child.on('close', code => {
      clearTimeout(killer);
      if (stdout.trim()) log(stdout.trimEnd());
      if (!allowExit.includes(code)) {
        const why = timedOut ? ` (watchdog killed it after ${watchdogMs}ms — raise watchdogMs if this command legitimately needs longer)` : '';
        reject(new Error(`daimon ${args.join(' ')} exited ${code}${why}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(mainJs) || !fs.existsSync(cliJs)) {
    throw new Error(`dist not built — run "npm run build" first (expected ${mainJs} and ${cliJs})`);
  }

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-demo-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-demo-ws-'));
  let daemonChild = null;
  let apiPort = null;

  try {
    log('=== daimon demo (headless, deterministic) ===');
    log(`DAIMON_HOME: ${fakeHome}`);
    log(`workspace:   ${workspace}`);
    log('');

    const webDir = copyFixture('demo-web', workspace);
    const brokenDir = copyFixture('demo-broken', workspace);

    apiPort = await pickFreePort();
    const webPort = await pickFreePort();
    const brokenPort = await pickFreePort();

    const configPath = path.join(workspace, 'daimon.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      searchRoots: [webDir, brokenDir],
      apiPort,
      overrides: {
        'demo-web': { port: webPort },
        'demo-broken': { port: brokenPort },
      },
      history: { enabled: true, path: path.join(fakeHome, 'history.db'), retentionDays: 1 },
      notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
      logs: { enabled: false },
    }, null, 2));

    daemonChild = spawn(process.execPath, [mainJs, '--headless'], {
      cwd: workspace,
      env: { ...process.env, DAIMON_HOME: fakeHome, DAIMON_PORT: String(apiPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonStdout = '';
    let daemonStderr = '';
    daemonChild.stdout.on('data', d => { daemonStdout += d; });
    daemonChild.stderr.on('data', d => { daemonStderr += d; });

    try {
      await waitForDaemon(apiPort);
    } catch (err) {
      throw new Error(`${err.message}\n--- daemon stdout ---\n${daemonStdout}\n--- daemon stderr ---\n${daemonStderr}`);
    }
    log(`daemon up on :${apiPort} (pid ${daemonChild.pid})`);
    log('');

    try {
      await runCli(['list'], { cwd: workspace, daimonHome: fakeHome, apiPort });

      await runCli(['start', 'demo-web'], { cwd: workspace, daimonHome: fakeHome, apiPort });
      await runCli(['start', 'demo-broken'], { cwd: workspace, daimonHome: fakeHome, apiPort });

      // The wait watchdog must outlast the command's own --timeout, or the
      // watchdog fires first and masks whether `wait` would have succeeded.
      await runCli(['wait', 'demo-web', '--until', 'serving', '--timeout', '60s'], { cwd: workspace, daimonHome: fakeHome, apiPort, watchdogMs: 75_000 });
      // demo-broken's seeded ERROR line flips its status straight to 'error'
      // (see fixtures/demo-broken/server.js) — it never settles on 'serving',
      // so wait for the state the demo is actually seeding.
      await runCli(['wait', 'demo-broken', '--until', 'error', '--timeout', '60s'], { cwd: workspace, daimonHome: fakeHome, apiPort, watchdogMs: 75_000 });

      await runCli(['errors', 'demo-broken'], { cwd: workspace, daimonHome: fakeHome, apiPort });

      await runCli(['report', '--md'], { cwd: workspace, daimonHome: fakeHome, apiPort });

      await runCli(['export', '--format', 'md'], { cwd: workspace, daimonHome: fakeHome, apiPort });

      await runCli(['stop', 'demo-web'], { cwd: workspace, daimonHome: fakeHome, apiPort });
      await runCli(['stop', 'demo-broken'], { cwd: workspace, daimonHome: fakeHome, apiPort });

      await runCli(['daemon', 'stop'], { cwd: workspace, daimonHome: fakeHome, apiPort });
    } catch (err) {
      throw new Error(`${err.message}\n--- daemon stdout ---\n${daemonStdout}\n--- daemon stderr ---\n${daemonStderr}`);
    }

    // `daimon daemon stop` already waited on the daemon's own exit; make
    // sure the child process object agrees before we declare success.
    const exitDeadline = Date.now() + 10_000;
    while (daemonChild.exitCode === null && Date.now() < exitDeadline) await sleep(200);
    if (daemonChild.exitCode === null) {
      try { daemonChild.kill('SIGKILL'); } catch {}
    }
    daemonChild = null;

    assertNoForbiddenStrings(daemonStdout, daemonStderr);

    log('');
    log('=== daimon demo complete ===');
  } finally {
    if (daemonChild && daemonChild.exitCode === null) {
      // Something failed before the scripted `daemon stop` ran — try a
      // graceful shutdown first, then escalate. Never leave it running.
      if (apiPort != null) { try { await postJson(apiPort, '/api/shutdown'); } catch {} }
      const deadline = Date.now() + 5_000;
      while (daemonChild.exitCode === null && Date.now() < deadline) await sleep(200);
      if (daemonChild.exitCode === null) { try { daemonChild.kill('SIGKILL'); } catch {} }
    }
    // Cleanup is scoped entirely to the two temp dirs this run created —
    // nothing outside them is ever touched or removed.
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

main().then(() => {
  process.exitCode = 0;
}).catch(err => {
  process.stderr.write(`\ndaimon demo FAILED: ${err?.stack || err?.message || err}\n`);
  process.exitCode = 1;
});
