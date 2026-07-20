#!/usr/bin/env node
// M148 (v1.10) — startup diet: the paths users feel before any data exists.
//
// Two things are measured here:
//   1. INSTANT PATHS — `--help`, `--version`, and the no-daemon error. These
//      never touch the daemon, so their entire cost is node boot + whatever
//      dist/cli.js drags in at import time. A budget derived from the M145 CLI
//      baseline guards them.
//   2. MODULE LOAD ATTRIBUTION — the per-module cost of importing each entry
//      point's dependencies, measured by importing each in a fresh process.
//      This is the evidence for which modules are worth making lazy; the
//      release rule is that candidates come from measurement, never intuition.
//
// Usage:
//   node bench/startup.mjs --write     # record the baseline (quiet only)
//   node bench/startup.mjs             # gate against it
//   node bench/startup.mjs --modules   # print the module-cost table only

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repoRoot, cliJs, makeInstall, cleanupInstall, freePort } from './lib/daemonHarness.mjs';
import { probeMachine, deriveBudget, checkBudget, percentile, median, round, cpuReferenceMs } from './lib/machine.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
export const STARTUP_BASELINE_PATH = path.join(repoRoot, 'bench', 'BASELINE-v1.10-startup.json');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const CLASSES = {
  'cli-help': ['interactive', 'typed constantly; the cheapest thing daimon can do'],
  'cli-version': ['interactive', 'scripts poll it; must be pure node boot + a string'],
  'cli-no-daemon': ['interactive', 'the error a new user hits first — must be immediate'],
};

function runCli(args, env = {}) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [cliJs, ...args], {
      env: { ...process.env, DAIMON_NO_SPAWN: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.once('exit', code => resolve({ ms: performance.now() - t0, code, out, err }));
  });
}

async function measureCliPath(name, args, env, runs, expect) {
  const times = [];
  const refs = [cpuReferenceMs()];
  for (let i = 0; i < 3; i++) await runCli(args, env); // warm the OS file cache
  let sample = null;
  for (let i = 0; i < runs; i++) {
    const r = await runCli(args, env);
    sample = r;
    times.push(r.ms);
    if (i % 10 === 9) refs.push(cpuReferenceMs());
  }
  refs.push(cpuReferenceMs());
  if (expect && !expect(sample)) {
    return { note: `${name}: output did not match its expectation — not certified` };
  }
  return {
    p50: round(percentile(times, 0.5)),
    p95: round(percentile(times, 0.95)),
    samples: times.length,
    cpuRefMedianMs: round(median(refs)),
    method: `spawn(dist/cli.js ${args.join(' ')}) -> exit, N=${runs}, no daemon involved`,
  };
}

/**
 * Per-module import cost, each in a FRESH process so nothing is pre-warmed by
 * a sibling module's imports. The number is the module's full transitive load
 * cost — which is exactly what an entry point pays for naming it at top level.
 */
function measureModuleLoad(file) {
  return new Promise(resolve => {
    const url = pathToFileURL(path.join(repoRoot, 'dist', file)).href;
    const code = `const t=performance.now();await import(${JSON.stringify(url)});process.stdout.write(String(performance.now()-t));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});
    child.once('exit', () => resolve(Number(out) || null));
  });
}

async function moduleTable() {
  const files = fs.readdirSync(path.join(repoRoot, 'dist'))
    .filter(f => f.endsWith('.js') && !f.endsWith('.d.js'))
    .sort();
  const rows = [];
  for (const f of files) {
    // Three samples, take the minimum: module load is dominated by disk +
    // compile, and the minimum is the cleanest estimate of the true cost.
    const samples = [];
    for (let i = 0; i < 3; i++) samples.push(await measureModuleLoad(f));
    const best = Math.min(...samples.filter(n => n != null));
    if (Number.isFinite(best)) rows.push({ module: f, ms: round(best) });
  }
  rows.sort((a, b) => b.ms - a.ms);
  return rows;
}

export async function runStartup({ runs = 25 } = {}) {
  const machineBefore = await probeMachine();
  const apiPort = await freePort(); // a port nothing is listening on
  const inst = makeInstall({ apiPort });
  const metrics = {};
  try {
    log('· cli --help …');
    metrics['cli-help'] = await measureCliPath('cli-help', ['--help'], {}, runs, r => /usage|Usage/.test(r.out));
    log('· cli --version …');
    metrics['cli-version'] = await measureCliPath('cli-version', ['--version'], {}, runs, r => /\d+\.\d+\.\d+/.test(r.out));
    log('· cli against no daemon …');
    metrics['cli-no-daemon'] = await measureCliPath(
      'cli-no-daemon', ['list', '--json'],
      { DAIMON_HOME: inst.home, DAIMON_NO_SPAWN: '1' },
      runs,
      r => r.code !== 0 || /not running|ECONNREFUSED|daemon/i.test(r.out + r.err),
    );
  } finally {
    cleanupInstall(inst);
  }

  log('· module load attribution …');
  const modules = await moduleTable();

  const machineAfter = await probeMachine();
  return {
    schemaVersion: 1,
    release: 'v1.10.0',
    machineQuiet: machineBefore.quiet && machineAfter.quiet,
    machine: { before: machineBefore, after: machineAfter },
    metrics,
    modules: modules.slice(0, 25),
  };
}

export function gate(fresh, baseline) {
  const rows = [];
  for (const [name, m] of Object.entries(fresh.metrics)) {
    const [klass, why] = CLASSES[name] ?? [];
    const base = baseline.metrics?.[name];
    if (m.note) { rows.push({ name, status: 'skipped', detail: m.note }); continue; }
    if (!klass || !base || base.p95 == null) { rows.push({ name, status: 'skipped', detail: 'no class or baseline' }); continue; }
    const budget = deriveBudget(base, klass, why);
    const verdict = checkBudget(budget, m.p95, m.cpuRefMedianMs);
    rows.push({ name, status: verdict.ok ? 'ok' : 'OVER BUDGET', detail: verdict.detail });
  }
  return rows;
}

function printResult(r) {
  log('');
  for (const [name, m] of Object.entries(r.metrics)) {
    if (m.note) { log(`  ${name.padEnd(16)} — ${m.note}`); continue; }
    log(`  ${name.padEnd(16)} p50 ${m.p50}ms  p95 ${m.p95}ms`);
  }
  log('');
  log('  heaviest modules by full transitive import cost:');
  for (const row of r.modules.slice(0, 12)) log(`    ${row.module.padEnd(26)} ${row.ms}ms`);
  log('');
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
})();

if (invokedDirectly) {
  if (flag('modules')) {
    for (const row of await moduleTable()) log(`${row.module.padEnd(28)} ${row.ms}ms`);
  } else {
    const result = await runStartup();
    printResult(result);
    if (flag('write')) {
      if (!result.machineQuiet) {
        process.stderr.write('[bench] refusing --write: machine was not quiet.\n');
        process.exit(2);
      }
      fs.writeFileSync(STARTUP_BASELINE_PATH, JSON.stringify(result, null, 2) + '\n');
      log(`[bench] wrote ${path.relative(repoRoot, STARTUP_BASELINE_PATH)}`);
    } else {
      if (!fs.existsSync(STARTUP_BASELINE_PATH)) {
        process.stderr.write('[bench] no startup baseline committed yet — run with --write on a quiet machine first.\n');
        process.exit(2);
      }
      const rows = gate(result, JSON.parse(fs.readFileSync(STARTUP_BASELINE_PATH, 'utf8')));
      let failed = 0;
      for (const row of rows) {
        if (row.status === 'OVER BUDGET') failed++;
        log(`  ${row.status === 'ok' ? 'PASS' : row.status === 'skipped' ? 'SKIP' : 'FAIL'}  ${row.name.padEnd(16)} ${row.detail}`);
      }
      if (failed) {
        process.stderr.write(`[bench] ${failed} startup budget(s) over. Investigate — budgets are never loosened to pass.\n`);
        process.exit(1);
      }
      log('[bench] all startup budgets green.');
    }
  }
}
