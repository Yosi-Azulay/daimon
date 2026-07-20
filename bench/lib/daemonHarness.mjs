// Shared bench fixture: a throwaway daimon install (M145, v1.10).
//
// Every bench that needs a live daemon goes through here. The rules are the
// lifecycle-torture recipe: a temp DAIMON_HOME + a SEPARATE temp workspace, a
// free port picked at run time, and both temp dirs removed in a finally. A
// bench must never touch the real ~/.daimon — the numbers would be polluted by
// the user's own history and, worse, the run would mutate their state.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const mainJs = path.join(repoRoot, 'dist', 'main.js');
export const cliJs = path.join(repoRoot, 'dist', 'cli.js');

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Create a throwaway { home, workspace } pair with a valid config.
 * `dbPath` optionally points history at a pre-seeded corpus instead of a
 * fresh DB (the M146 1M corpus reuse path).
 */
export function makeInstall({ apiPort, dbPath = null, retentionDays = 3650 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-bench-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-bench-ws-'));
  const config = {
    searchRoots: [workspace],
    apiPort,
    history: { enabled: true, retentionDays, ...(dbPath ? { path: dbPath } : {}) },
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2));
  return { home, workspace, config };
}

export function cleanupInstall(inst) {
  for (const dir of [inst?.home, inst?.workspace]) {
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export function spawnDaemon({ home, apiPort, workspace, headless = true, extraEnv = {} }) {
  const args = headless ? [mainJs, '--headless'] : [mainJs];
  const child = spawn(process.execPath, args, {
    cwd: workspace || home,
    env: { ...process.env, DAIMON_HOME: home, DAIMON_PORT: String(apiPort), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  return { child, stdout: () => out, stderr: () => err };
}

export async function signatureOk(apiPort) {
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/signature`, {
      headers: { 'x-daimon-agent': 'daimon-bench-0001' },
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function waitForDaemon(apiPort, timeoutMs = 30_000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (await signatureOk(apiPort)) return performance.now() - t0;
    await sleep(5);
  }
  throw new Error(`daemon on :${apiPort} never answered /api/signature within ${timeoutMs}ms`);
}

export async function killDaemon(handle) {
  if (!handle?.child || handle.child.exitCode != null) return;
  const done = new Promise(r => handle.child.once('exit', r));
  try { handle.child.kill('SIGKILL'); } catch {}
  await Promise.race([done, sleep(3000)]);
}

/** Run a CLI verb against a live daemon; resolves with { ms, code }. */
export function runCli(args, { home, workspace, agent = 'daimon-bench-0001' }) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: workspace || home,
      env: { ...process.env, DAIMON_HOME: home, DAIMON_AGENT_ID: agent, DAIMON_NO_SPAWN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});
    child.once('exit', code => resolve({ ms: performance.now() - t0, code, out }));
  });
}
