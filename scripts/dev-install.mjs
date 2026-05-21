#!/usr/bin/env node
// Fast local install for daimon development.
//
// Idempotent — safe to run repeatedly. Use it after any source change to make the
// global `daimon` CLI pick up your local edits without re-publishing.
//
// What it does, in order:
//   1. tsc (build daemon)         — typically 3–5s
//   2. ng build (dashboard)        — skipped if dashboard/node_modules missing; ~6–10s
//   3. npm link (no-op if linked) — symlinks this project as the global `daimon`
//   4. daimon --version            — sanity check
//
// After the first run, subsequent runs only rebuild what changed (tsc is incremental
// if you keep dist/), so the typical loop is 5–10s.
//
// Flags:
//   --no-dashboard   Skip the Angular build (use when only daemon files changed).
//   --no-link        Skip the npm link step (assume it's already linked).
//   --quiet          Suppress sub-process stdout, show only step headers + final result.
//
// To revert to the published daimon: `npm rm -g daimon && npm i -g daimon`.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const skipDashboard = args.has('--no-dashboard');
const skipLink = args.has('--no-link');
const quiet = args.has('--quiet');

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

function step(label) {
  process.stdout.write(`\n\x1b[36m▸\x1b[0m ${label}\n`);
}

function run(label, cmd, cmdArgs, opts = {}) {
  step(label);
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd ?? root,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: isWin,
  });
  const ms = Date.now() - t0;
  if (r.status !== 0) {
    if (quiet && r.stdout) process.stdout.write(r.stdout.toString());
    if (quiet && r.stderr) process.stderr.write(r.stderr.toString());
    console.error(`\x1b[31m✗ ${label} failed (exit ${r.status}) in ${ms}ms\x1b[0m`);
    process.exit(r.status ?? 1);
  }
  process.stdout.write(`\x1b[32m✓\x1b[0m ${label} (${ms}ms)\n`);
  return r;
}

const startedAt = Date.now();

run('tsc (daemon)', npm, ['run', 'build']);

if (!skipDashboard) {
  if (existsSync(path.join(root, 'dashboard', 'node_modules'))) {
    run('ng build (dashboard)', npm, ['run', 'build:dashboard']);
  } else {
    process.stdout.write(`\n\x1b[33m▸ Skipping dashboard build — dashboard/node_modules missing.\x1b[0m\n`);
    process.stdout.write(`  Run: (cd dashboard && npm install) to enable the Angular SPA bundle.\n`);
  }
} else {
  process.stdout.write(`\n\x1b[33m▸ Skipping dashboard build (--no-dashboard)\x1b[0m\n`);
}

if (!skipLink) {
  // The currently-running daimon daemon holds better-sqlite3's native .node file open,
  // so `npm link` (which relocates the existing global install) fails with EBUSY on Windows.
  // Best-effort stop before linking; ignore errors if it wasn't running.
  step('daimon daemon stop (release file locks)');
  const daimonBinPre = isWin ? 'daimon.cmd' : 'daimon';
  const stop = spawnSync(daimonBinPre, ['daemon', 'stop'], { encoding: 'utf8', shell: isWin });
  if (stop.status === 0) process.stdout.write(`\x1b[32m✓\x1b[0m daemon stopped\n`);
  else process.stdout.write(`\x1b[33m·\x1b[0m daemon not running (ignored)\n`);

  // npm link is idempotent: re-runs silently update the symlink to point at the current project.
  run('npm link (global daimon → this dir)', npm, ['link']);
} else {
  process.stdout.write(`\n\x1b[33m▸ Skipping npm link (--no-link)\x1b[0m\n`);
}

step('daimon --version (sanity check)');
const daimonBin = isWin ? 'daimon.cmd' : 'daimon';
const ver = spawnSync(daimonBin, ['--version'], { encoding: 'utf8', shell: isWin });
if (ver.status !== 0) {
  process.stderr.write(ver.stderr || '');
  console.error(`\x1b[31m✗ daimon CLI is not on PATH or failed to run.\x1b[0m`);
  console.error(`  npm link may have succeeded but the global bin dir is not in PATH.`);
  console.error(`  On Windows, ensure %APPDATA%\\npm is in PATH.`);
  process.exit(1);
}
process.stdout.write(`\x1b[32m✓\x1b[0m daimon resolves to: ${(ver.stdout || '').trim()}\n`);

const totalMs = Date.now() - startedAt;
process.stdout.write(`\n\x1b[32m✓ Done in ${totalMs}ms.\x1b[0m The global \`daimon\` command now runs your local source.\n`);
process.stdout.write(`  To revert: npm rm -g daimon && npm i -g daimon\n`);
