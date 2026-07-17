// M108 — CPU storms, warn-only budgets, and the WARN-NEVER-KILL enforcement
// suite. The grep-style tests here are load-bearing: they prove the resource
// modules cannot touch a process (no imports at all in resources.ts, no
// signal/kill/spawn surface in the sampling path) and the behavioral tests
// prove that firing every resource event kind leaves the app's registry
// state — and the process-control surface — completely untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { ResourceGuard } from '../dist/resources.js';

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-guard-'));
process.env.DAIMON_HOME = fakeHome;
const { Registry } = await import('../dist/registry.js');

const MB = 1024 * 1024;
const STEP = 30_000;

function drive(guard, app, count, fn, { startTs = 0, step = STEP } = {}) {
  for (let i = 0; i < count; i++) {
    const ts = startTs + i * step;
    const { rss = 200 * MB, cpu = 5 } = fn(i, ts);
    guard.note(app, ts, rss, cpu);
  }
  return startTs + count * step;
}

// Warm-up: 11 samples of quiet cpu (median 5, small jitter). Storm windows
// need 15 min past establishment — index ≥ 40.
const quietCpu = i => 5 + (i % 3) - 1; // 4/5/6 cycling: median 5, MAD 1

function stormCollector() {
  const events = [];
  const guard = new ResourceGuard({ onCpuStorm: info => events.push(info) });
  return { guard, events };
}

test('sustained CPU above the app\'s own baseline for a full window → one cpu-storm per episode', () => {
  const { guard, events } = stormCollector();
  drive(guard, 'web', 240, i => ({ cpu: i < 11 ? quietCpu(i) : 85 }));
  assert.equal(events.length, 1, `one event per episode, got ${events.length}`);
  const ev = events[0];
  assert.equal(ev.app, 'web');
  assert.ok(ev.windowMeanPct > ev.baselineCpuPct, 'payload carries window mean vs baseline');
  assert.ok(ev.remedy.includes('never kills'), 'remedy restates warn-never-kill');
});

test('a single hot sample never fires', () => {
  const { guard, events } = stormCollector();
  drive(guard, 'web', 240, i => ({ cpu: i === 100 ? 98 : quietCpu(i) }));
  assert.deepEqual(events, []);
});

test('a compile burst (minutes, not a full window) never fires', () => {
  const { guard, events } = stormCollector();
  // 4 minutes of pegged CPU every half hour — bursty, not a storm.
  drive(guard, 'web', 240, i => ({ cpu: i % 60 < 8 ? 95 : quietCpu(i) }));
  assert.deepEqual(events, []);
});

test('cpu-storm re-arms on return to baseline, then a fresh full window can fire again', () => {
  const { guard, events } = stormCollector();
  let end = drive(guard, 'web', 60, i => ({ cpu: i < 11 ? quietCpu(i) : 85 }));
  assert.equal(events.length, 1);
  end = drive(guard, 'web', 5, () => ({ cpu: 5 }), { startTs: end }); // back to baseline
  drive(guard, 'web', 60, () => ({ cpu: 85 }), { startTs: end });
  assert.equal(events.length, 2, `re-armed episode fires again, got ${events.length}`);
});

test('an app with a naturally busy baseline does not storm at its normal level', () => {
  const { guard, events } = stormCollector();
  // Baseline ~60% (a hot dev server); staying at 60-70% is its normal.
  drive(guard, 'web', 240, i => ({ cpu: 60 + (i % 5) * 2 }));
  assert.deepEqual(events, []);
});

// ── Budgets: absolute, user-set, warn-only ──────────────────────────────────

function budgetCollector(budgetsFn) {
  const events = [];
  const guard = new ResourceGuard({ budgets: budgetsFn, onBudgetExceeded: info => events.push(info) });
  return { guard, events };
}

test('rssMb budget crossed for a full window → one event naming value, budget, remedy', () => {
  const { guard, events } = budgetCollector(() => ({ rssMb: 300 }));
  drive(guard, 'web', 40, () => ({ rss: 400 * MB }));
  assert.equal(events.length, 1, `one event per crossing episode, got ${events.length}`);
  const ev = events[0];
  assert.equal(ev.metric, 'rss');
  assert.equal(ev.budget, 300);
  assert.ok(ev.observed >= 399, 'observed value named');
  assert.ok(ev.remedy.includes('resources.rssMb'), 'remedy names the config key');
  assert.ok(ev.remedy.includes('never kills'));
});

test('budget episode: stays over → one event; dips under → re-arms → second crossing fires again', () => {
  const { guard, events } = budgetCollector(() => ({ cpuPct: 50 }));
  let end = drive(guard, 'web', 40, () => ({ cpu: 80 }));
  assert.equal(events.length, 1);
  assert.equal(events[0].metric, 'cpu');
  end = drive(guard, 'web', 3, () => ({ cpu: 10 }), { startTs: end }); // re-arm
  drive(guard, 'web', 40, () => ({ cpu: 80 }), { startTs: end });
  assert.equal(events.length, 2);
});

test('a brief crossing (shorter than the window) never fires', () => {
  const { guard, events } = budgetCollector(() => ({ rssMb: 300 }));
  drive(guard, 'web', 60, i => ({ rss: (i % 20 < 4 ? 400 : 200) * MB }));
  assert.deepEqual(events, []);
});

test('no budgets resolved → zero budget events at any level', () => {
  const { guard, events } = budgetCollector(() => undefined);
  drive(guard, 'web', 60, () => ({ rss: 4000 * MB, cpu: 100 }));
  assert.deepEqual(events, []);
});

// ── Registry wiring: overrides win per key; state stays untouched ───────────

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43800, 43890], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: path.join(fakeHome, 'h.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    ...overrides,
  };
}
const mkApps = names => names.map(name => ({
  name, baseName: name, workspaceRoot: fakeHome, workspaceType: 'polyglot',
  command: 'noop', hidden: false, tags: [],
}));

test('overrides.<app>.resources beats the global budget per key; events flow through recordEvent', () => {
  const reg = new Registry(baseCfg({
    resources: { rssMb: 300 },
    overrides: { web: { resources: { rssMb: 500 } } },
  }), mkApps(['web', 'api']));
  const events = [];
  reg.on('event', ev => events.push(ev));
  // Both apps sit at 400MB for a full budget window: api (global 300) fires,
  // web (override 500) stays silent.
  for (let i = 0; i < 40; i++) {
    const ts = i * STEP;
    reg.noteResourceSample('web', ts, 400 * MB, 5);
    reg.noteResourceSample('api', ts, 400 * MB, 5);
  }
  const budget = events.filter(e => e.type === 'resource-budget-exceeded');
  assert.equal(budget.length, 1, JSON.stringify(budget));
  assert.equal(budget[0].app, 'api');
  const payload = JSON.parse(budget[0].message);
  assert.equal(payload.budget, 300);
  assert.equal(payload.metric, 'rss');
  assert.ok(payload.remedy.includes('overrides.api.resources.rssMb'));
});

test('no resources config → zero budget events, and suspicion still self-calibrates', () => {
  const reg = new Registry(baseCfg(), mkApps(['web']));
  const events = [];
  reg.on('event', ev => events.push(ev));
  for (let i = 0; i < 40; i++) reg.noteResourceSample('web', i * STEP, 4000 * MB, 100);
  assert.deepEqual(events.filter(e => e.type === 'resource-budget-exceeded'), []);
});

test('WARN NEVER KILL (behavioral): firing all three event kinds leaves app state and process control untouched', () => {
  const reg = new Registry(baseCfg({ resources: { rssMb: 300, cpuPct: 50 } }), mkApps(['web']));
  const events = [];
  reg.on('event', ev => events.push(ev));
  // Spy every process-control surface the registry has.
  const touched = [];
  for (const m of ['stop', 'restart', 'start', 'stopAll']) {
    const orig = reg[m].bind(reg);
    reg[m] = (...args) => { touched.push([m, args]); return orig(...args); };
  }
  // Simulate a running app the way the daemon would see one.
  const st = reg.getState('web');
  Object.assign(st, { pid: 12345, status: 'serving', startedAt: 0, health: 'healthy' });
  const before = { pid: st.pid, status: st.status, health: st.health };

  // Warm-up then: leaky RSS + pegged CPU + both budgets crossed.
  for (let i = 0; i < 240; i++) {
    const rss = (i < 11 ? 200 : 400 + (i - 10) * 2) * MB;
    const cpu = i < 11 ? 5 + (i % 3) - 1 : 90;
    reg.noteResourceSample('web', i * STEP, rss, cpu);
  }
  const kinds = new Set(events.map(e => e.type));
  assert.ok(kinds.has('resource-leak-suspect'), `leak fired (${[...kinds]})`);
  assert.ok(kinds.has('cpu-storm'), 'storm fired');
  assert.ok(kinds.has('resource-budget-exceeded'), 'budget fired');

  const after = reg.getState('web');
  assert.deepEqual({ pid: after.pid, status: after.status, health: after.health }, before,
    'resource events must not move app state by a single field');
  assert.deepEqual(touched, [], 'no process-control method may be reached from a resource event');
  // Every payload restates the contract in its remedy.
  for (const t of ['resource-leak-suspect', 'cpu-storm', 'resource-budget-exceeded']) {
    const ev = events.find(e => e.type === t);
    assert.ok(JSON.parse(ev.message).remedy.toLowerCase().includes('never kills'), `${t} remedy carries the promise`);
  }
});

// ── WARN NEVER KILL (structural): the grep suite ────────────────────────────

test('resources.ts imports nothing and contains no process-control surface', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'resources.ts'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m,
    'resources.ts must import NOTHING (not even node builtins) — verdicts only');
  assert.doesNotMatch(src, /\brequire\s*\(/, 'no dynamic requires either');
  for (const bad of [
    /\.kill\s*\(/, /process\.kill/, /treeKill/, /child_process/,
    /\bspawn\w*\s*\(/, /\bexec\w*\s*\(/, /SIGTERM|SIGKILL|SIGINT/,
    /\.stop\s*\(/, /\.restart\s*\(/,
  ]) {
    assert.doesNotMatch(src, bad, `resources.ts must not contain ${bad}`);
  }
});

test('the sampling path (usage.ts) has no kill/spawn surface', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'usage.ts'), 'utf8');
  for (const bad of [
    /\.kill\s*\(/, /process\.kill/, /treeKill/, /child_process/,
    /\bspawn\w*\s*\(/, /\bexec\w*\s*\(/, /SIGTERM|SIGKILL/,
  ]) {
    assert.doesNotMatch(src, bad, `usage.ts must not contain ${bad}`);
  }
});

test('no consumer wires a resource event kind to a process-control call', () => {
  // Every src file that mentions a resource event kind: the kind may only be
  // routed to events, notifications, webhooks, docs, or read surfaces. A
  // handler body that calls stop/kill/restart around one of these kinds is
  // the exact regression this suite exists to block.
  const srcDir = path.join(repoRoot, 'src');
  const offenders = [];
  const scan = dir => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { scan(p); continue; }
      if (!/\.tsx?$/.test(f.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!/resource-leak-suspect|cpu-storm|resource-budget-exceeded/.test(src)) continue;
      // Window: 6 lines around each mention must not invoke process control.
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!/resource-leak-suspect|cpu-storm|resource-budget-exceeded/.test(line)) return;
        const ctx = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (/\.kill\s*\(|treeKill|process\.kill|\bstopApp\s*\(|\.stopAll\s*\(|\brestart\s*\(/.test(ctx)) {
          offenders.push(`${path.relative(repoRoot, p)}:${i + 1}`);
        }
      });
    }
  };
  scan(srcDir);
  assert.deepEqual(offenders, [], `resource event kinds wired to process control at: ${offenders.join(', ')}`);
});
