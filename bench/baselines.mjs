#!/usr/bin/env node
// M145 (v1.10) — the "before" column for the whole Featherweight release.
//
// MEASURE FIRST. Nothing in v1.10 optimizes anything until these numbers exist
// and are committed, because every M146-M148 budget is derived from them and
// every optimization must carry a before/after against them.
//
// Closed baseline set (the plan's list — do not extend without a plan change):
//   daemon-cold-start        spawn -> /api/signature answering
//   cli-roundtrip            `daimon list --json` against a warm daemon (N>=50)
//   idle-rss / idle-cpu      60s window on an idle daemon, empty workspace
//   tui-attach               launch -> first full TUI frame on stdout
//   dashboard-route-tti      per-route navigation timing on the seeded corpus
//
// Usage:
//   node bench/baselines.mjs                 # measure + print table
//   node bench/baselines.mjs --write         # also commit BASELINE-v1.10.json
//   node bench/baselines.mjs --only=cli-roundtrip,tui-attach
//   node bench/baselines.mjs --quick         # short windows; NEVER committed
//
// A run on a contended machine is LABELLED (`machineQuiet: false`) and refused
// for --write: a baseline measured under load would silently inflate every
// budget derived from it, which is exactly the "budget loosened to pass" failure
// the release forbids.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  repoRoot, makeInstall, cleanupInstall, spawnDaemon, waitForDaemon,
  killDaemon, freePort, runCli, sleep, mainJs,
} from './lib/daemonHarness.mjs';
import { probeMachine, percentile, median, round, cpuReferenceMs } from './lib/machine.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => {
  const hit = argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};

const QUICK = flag('quick');
const ONLY = (opt('only') || '').split(',').map(s => s.trim()).filter(Boolean);
export const BASELINE_PATH = path.join(repoRoot, 'bench', 'BASELINE-v1.10.json');

const wanted = name => ONLY.length === 0 || ONLY.includes(name);
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

// ---------------------------------------------------------------------------
// daemon cold start: spawn -> /api/signature. A FRESH DAIMON_HOME per iteration
// so nothing is warm except the OS file cache — this is the number a user feels
// the first time they run `daimon` after a reboot.
// ---------------------------------------------------------------------------
async function measureColdStart(runs) {
  const times = [];
  const refs = [];
  for (let i = 0; i < runs; i++) {
    const apiPort = await freePort();
    const inst = makeInstall({ apiPort });
    let handle = null;
    try {
      const t0 = performance.now();
      handle = spawnDaemon({ ...inst, apiPort });
      await waitForDaemon(apiPort);
      times.push(performance.now() - t0);
    } finally {
      await killDaemon(handle);
      cleanupInstall(inst);
    }
    refs.push(cpuReferenceMs());
  }
  return summarize(times, refs, 'spawn(dist/main.js --headless) -> first 200 from GET /api/signature, fresh DAIMON_HOME each run');
}

// ---------------------------------------------------------------------------
// CLI round trip: full user-felt cost — node boot + argv dispatch + HTTP hop.
// Measured against a WARM daemon, so this isolates the client side.
// ---------------------------------------------------------------------------
async function measureCliRoundtrip(runs) {
  const apiPort = await freePort();
  const inst = makeInstall({ apiPort });
  let handle = null;
  try {
    handle = spawnDaemon({ ...inst, apiPort });
    await waitForDaemon(apiPort);
    const times = [];
    const refs = [cpuReferenceMs()];
    for (let i = 0; i < 5; i++) await runCli(['list', '--json'], inst); // warmup
    for (let i = 0; i < runs; i++) {
      const r = await runCli(['list', '--json'], inst);
      times.push(r.ms);
      if (i % 15 === 14) refs.push(cpuReferenceMs());
    }
    refs.push(cpuReferenceMs());
    return summarize(times, refs, `spawn(dist/cli.js list --json) -> exit, warm daemon, N=${runs}`);
  } finally {
    await killDaemon(handle);
    cleanupInstall(inst);
  }
}

// ---------------------------------------------------------------------------
// Idle footprint: what the daemon costs to simply be running. Sampled with the
// same pidusage the UsageMonitor already uses, so the number matches what
// daimon reports about itself.
// ---------------------------------------------------------------------------
async function measureIdle(windowMs) {
  const { default: pidusage } = await import('pidusage');
  const apiPort = await freePort();
  const inst = makeInstall({ apiPort });
  let handle = null;
  try {
    handle = spawnDaemon({ ...inst, apiPort });
    await waitForDaemon(apiPort);
    await sleep(3000); // let boot-time allocation settle before sampling idle
    const rss = [];
    const cpu = [];
    const t0 = performance.now();
    while (performance.now() - t0 < windowMs) {
      try {
        const s = await pidusage(handle.child.pid);
        rss.push(s.memory / 1024 / 1024);
        cpu.push(s.cpu);
      } catch { /* process gone mid-window — surfaced by an empty sample set */ }
      await sleep(2000);
    }
    if (!rss.length) throw new Error('idle: no samples collected');
    return {
      rssMb: { p50: round(median(rss)), p95: round(percentile(rss, 0.95)), max: round(Math.max(...rss)) },
      cpuPct: { p50: round(median(cpu), 2), p95: round(percentile(cpu, 0.95), 2), max: round(Math.max(...cpu), 2) },
      samples: rss.length,
      windowMs,
      method: `pidusage on the daemon pid every 2s over ${Math.round(windowMs / 1000)}s, idle daemon, empty workspace`,
    };
  } finally {
    await killDaemon(handle);
    cleanupInstall(inst);
  }
}

// ---------------------------------------------------------------------------
// TUI attach: launch -> first full frame.
//
// Ink renders its first frame to a piped stdout before it discovers stdin is
// not raw-mode-capable and exits, so a non-TTY bench can measure the real frame
// cost without a pty dependency. We detect the frame by the ribbon's box-draw
// header, then kill immediately — the subsequent raw-mode exit is expected and
// deliberately not part of the measurement.
// ---------------------------------------------------------------------------
const FRAME_MARKER = '╭'; // the ribbon's top-left corner

async function measureTuiAttach(runs) {
  const times = [];
  const refs = [];
  for (let i = 0; i < runs; i++) {
    const apiPort = await freePort();
    const inst = makeInstall({ apiPort });
    let handle = null;
    try {
      const t0 = performance.now();
      handle = spawnDaemon({ ...inst, apiPort, headless: false });
      const ms = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no TUI frame within 30s')), 30_000);
        const onData = d => {
          if (String(d).includes(FRAME_MARKER)) {
            clearTimeout(timer);
            handle.child.stdout.off('data', onData);
            resolve(performance.now() - t0);
          }
        };
        handle.child.stdout.on('data', onData);
      });
      times.push(ms);
    } finally {
      await killDaemon(handle);
      cleanupInstall(inst);
    }
    refs.push(cpuReferenceMs());
  }
  return summarize(times, refs, 'spawn(dist/main.js) -> first stdout chunk containing the ribbon frame');
}

// ---------------------------------------------------------------------------
// Dashboard route TTI. Driven through Playwright's chromium directly (no test
// runner) so the output is JSON rather than a report. Degrades to a { note }
// when the browser or the built SPA is unavailable — an absent measurement is
// recorded as absent, never as a number.
// ---------------------------------------------------------------------------
// TTI signal: the route's <main> landmark carries rendered content.
//
// `networkidle` is WRONG for this dashboard and always times out — every route
// holds a live SSE stream open, so the network never goes idle by design. The
// e2e specs work around it with `.catch(() => {})`; a bench cannot, because a
// swallowed 30s timeout would be recorded as the route's TTI. The <main>
// landmark (added in the M89 a11y pass) is present on every route and is only
// populated once the lazy chunk has loaded and the route component has
// rendered — which is exactly time-to-interactive.
const CONTENT_READY = `() => {
  const m = document.querySelector('main');
  return !!m && (m.innerText || '').trim().length > 20;
}`;

async function measureDashboardTti(corpusDbPath, runs) {
  const distDash = path.join(repoRoot, 'dist', 'dashboard');
  if (!fs.existsSync(distDash)) {
    return { note: 'dist/dashboard missing — run npm run build:dashboard to certify route TTI' };
  }
  let chromium;
  try {
    // @playwright/test is CJS and lives in dashboard/node_modules; resolve it
    // from there rather than from the repo root, and via require rather than
    // import() — the ESM namespace of a CJS module does not expose `chromium`.
    const req = createRequire(path.join(repoRoot, 'dashboard', 'package.json'));
    ({ chromium } = req('@playwright/test'));
    if (!chromium) throw new Error('@playwright/test exposed no chromium');
  } catch (err) {
    return { note: `@playwright/test unavailable (${err?.message || err}) — route TTI not certified in this run` };
  }
  const { ROUTE_PATHS } = await loadRoutePaths();
  const apiPort = await freePort();
  const inst = makeInstall({ apiPort, dbPath: corpusDbPath });
  let handle = null;
  let browser = null;
  try {
    handle = spawnDaemon({ ...inst, apiPort });
    await waitForDaemon(apiPort);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const base = `http://127.0.0.1:${apiPort}`;
    const routes = {};
    for (const route of ROUTE_PATHS) {
      const times = [];
      for (let i = 0; i < runs + 1; i++) {
        const t0 = performance.now();
        await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(CONTENT_READY, null, { timeout: 20_000 });
        const ms = performance.now() - t0;
        if (i > 0) times.push(ms); // drop the first (lazy chunk fetch) per route
      }
      routes[route] = { p50: round(median(times)), p95: round(percentile(times, 0.95)), samples: times.length };
    }
    const allP95 = Object.values(routes).map(r => r.p95);
    return {
      routes,
      worstRouteP95: round(Math.max(...allP95)),
      method: `chromium goto(waitUntil=networkidle) x${runs} per route against a daemon on the seeded corpus`,
    };
  } catch (err) {
    return { note: `route TTI not certified: ${err?.message || err}` };
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    await killDaemon(handle);
    cleanupInstall(inst);
  }
}

// The route list lives in TypeScript next to the specs; parse the literal
// rather than duplicating it here, so a new dashboard route is benched
// automatically instead of being silently missed.
async function loadRoutePaths() {
  const src = fs.readFileSync(path.join(repoRoot, 'dashboard', 'e2e', 'routes.ts'), 'utf8');
  const body = src.match(/ROUTE_PATHS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!body) throw new Error('could not parse ROUTE_PATHS from dashboard/e2e/routes.ts');
  const ROUTE_PATHS = [...body[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (!ROUTE_PATHS.length) throw new Error('ROUTE_PATHS parsed empty');
  return { ROUTE_PATHS };
}

function summarize(times, refs, method) {
  return {
    p50: round(percentile(times, 0.5)),
    p95: round(percentile(times, 0.95)),
    min: round(Math.min(...times)),
    max: round(Math.max(...times)),
    samples: times.length,
    cpuRefMedianMs: round(median(refs)),
    method,
  };
}

// ---------------------------------------------------------------------------

export async function runBaselines({ quick = QUICK, corpusDbPath = null } = {}) {
  const machineBefore = await probeMachine();
  const metrics = {};

  const N = {
    coldStart: quick ? 2 : 7,
    cli: quick ? 8 : 50,
    idleWindowMs: quick ? 8_000 : 60_000,
    tui: quick ? 2 : 5,
    tti: quick ? 1 : 3,
  };

  if (wanted('daemon-cold-start')) {
    log('· daemon-cold-start …');
    metrics['daemon-cold-start'] = await measureColdStart(N.coldStart);
  }
  if (wanted('cli-roundtrip')) {
    log('· cli-roundtrip …');
    metrics['cli-roundtrip'] = await measureCliRoundtrip(N.cli);
  }
  if (wanted('idle-footprint')) {
    log(`· idle-footprint (${N.idleWindowMs / 1000}s window) …`);
    metrics['idle-footprint'] = await measureIdle(N.idleWindowMs);
  }
  if (wanted('tui-attach')) {
    log('· tui-attach …');
    metrics['tui-attach'] = await measureTuiAttach(N.tui);
  }
  if (wanted('dashboard-route-tti')) {
    log('· dashboard-route-tti …');
    metrics['dashboard-route-tti'] = await measureDashboardTti(corpusDbPath, N.tti);
  }

  // Let the last metric's processes (daemon, chromium) actually exit before
  // probing again — otherwise the run's own teardown reads as external load
  // and the whole baseline is refused for a reason that isn't true.
  await sleep(3000);
  const machineAfter = await probeMachine();
  // Quiet for the WHOLE run, not just at the start — a build kicked off
  // mid-measurement must not pass as a quiet baseline.
  const machineQuiet = machineBefore.quiet && machineAfter.quiet;

  return {
    schemaVersion: 1,
    release: 'v1.10.0',
    quick,
    machineQuiet,
    machine: { before: machineBefore, after: machineAfter },
    metrics,
  };
}

// Documented repeatability tolerance (the M145 acceptance criterion).
//
// MEASURED, not asserted: three consecutive runs on the v1.10 dev box (one
// quiet, two under mild background load) spread as follows on p95 —
//   daemon-cold-start  1076.5 / 1082.6 / 1189.4 ms   (±5.0% about the median)
//   cli-roundtrip       399.3 /  403.5 /  404.7 ms   (±0.7%)
//   tui-attach         1017.6 / 1029.9 / 1155.5 ms   (±6.6%)
// 20% is comfortably outside that spread and well inside the smallest headroom
// factor (2x), so drift beyond it is a signal rather than noise.
export const BASELINE_TOLERANCE = 0.20;

function comparableP95(metric) {
  if (!metric || metric.note) return null;
  if (metric.p95 != null) return metric.p95;
  if (metric.worstRouteP95 != null) return metric.worstRouteP95;
  if (metric.rssMb) return metric.rssMb.p95;
  return null;
}

/** Compare a fresh run against the committed baseline. Returns per-metric drift. */
export function verifyAgainstBaseline(fresh, committed) {
  const rows = [];
  for (const [name, m] of Object.entries(fresh.metrics)) {
    const now = comparableP95(m);
    const before = comparableP95(committed.metrics?.[name]);
    if (now == null || before == null) {
      rows.push({ name, status: 'skipped', note: m.note || 'no comparable p95 in one side' });
      continue;
    }
    const drift = (now - before) / before;
    rows.push({
      name, before, now,
      driftPct: round(drift * 100, 1),
      status: Math.abs(drift) <= BASELINE_TOLERANCE ? 'ok' : (drift > 0 ? 'REGRESSED' : 'improved'),
    });
  }
  return rows;
}

function printTable(result) {
  log('');
  log(`machineQuiet: ${result.machineQuiet}  (madRatio ${result.machine.before.cpuRefMadRatio}/${result.machine.after.cpuRefMadRatio}, `
    + `systemBusy ${result.machine.before.systemBusyFraction}/${result.machine.after.systemBusyFraction})`);
  log('');
  for (const [name, m] of Object.entries(result.metrics)) {
    if (m.note) { log(`  ${name.padEnd(22)} — ${m.note}`); continue; }
    if (name === 'idle-footprint') {
      log(`  ${name.padEnd(22)} rss p50 ${m.rssMb.p50}MB / p95 ${m.rssMb.p95}MB · cpu p50 ${m.cpuPct.p50}% / p95 ${m.cpuPct.p95}% (${m.samples} samples)`);
      continue;
    }
    if (name === 'dashboard-route-tti') {
      log(`  ${name.padEnd(22)} worst route p95 ${m.worstRouteP95}ms`);
      for (const [route, r] of Object.entries(m.routes)) {
        log(`    ${route.padEnd(20)} p50 ${r.p50}ms  p95 ${r.p95}ms`);
      }
      continue;
    }
    log(`  ${name.padEnd(22)} p50 ${m.p50}ms  p95 ${m.p95}ms  (n=${m.samples}, cpuRef ${m.cpuRefMedianMs}ms)`);
  }
  log('');
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
})();

if (invokedDirectly) {
  if (!fs.existsSync(mainJs)) {
    process.stderr.write('[bench] dist/main.js missing — run `npm run build` first.\n');
    process.exit(1);
  }
  const corpusDbPath = opt('corpus');
  const result = await runBaselines({ corpusDbPath });
  printTable(result);
  if (flag('verify')) {
    if (!fs.existsSync(BASELINE_PATH)) {
      process.stderr.write('[bench] no committed baseline to verify against.\n');
      process.exit(2);
    }
    const rows = verifyAgainstBaseline(result, JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
    log(`drift vs committed baseline (tolerance ±${Math.round(BASELINE_TOLERANCE * 100)}%):`);
    for (const r of rows) {
      log(r.status === 'skipped'
        ? `  ${r.name.padEnd(22)} skipped — ${r.note}`
        : `  ${r.name.padEnd(22)} ${r.before} -> ${r.now} (${r.driftPct > 0 ? '+' : ''}${r.driftPct}%) ${r.status}`);
    }
    if (rows.some(r => r.status === 'REGRESSED')) process.exit(1);
  }
  if (flag('write')) {
    if (result.quick) {
      process.stderr.write('[bench] refusing --write on a --quick run: short windows are not a baseline.\n');
      process.exit(2);
    }
    if (!result.machineQuiet) {
      process.stderr.write('[bench] refusing --write: machine was not quiet. A contended baseline inflates every budget derived from it.\n');
      process.exit(2);
    }
    if (ONLY.length) {
      // Merge into the existing file rather than truncating the other metrics.
      const prev = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : { metrics: {} };
      result.metrics = { ...prev.metrics, ...result.metrics };
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2) + '\n');
    log(`[bench] wrote ${path.relative(repoRoot, BASELINE_PATH)}`);
  }
}
