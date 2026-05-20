import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { orchestrateProfile } from '../dist/orchestrate.js';

function makeFakeRegistry(apps, opts = {}) {
  const ee = new EventEmitter();
  const states = new Map();
  for (const [name, init] of Object.entries(apps)) {
    states.set(name, { status: init.status ?? 'stopped', health: init.health ?? 'unknown', errCount: 0 });
  }
  const reg = {
    on: (ev, fn) => ee.on(ev, fn),
    off: (ev, fn) => ee.off(ev, fn),
    summary: (n) => {
      const s = states.get(n);
      if (!s) return null;
      return { name: n, status: s.status, health: s.health, port: null, url: null, errorCount: s.errCount, uptimeMs: null, lastCompileMs: null, lastHealthAt: null, cpu: null, memMB: null, compileHistoryMs: [], tags: [], restartAttempts: 0, nextRestartAt: null, announcedUrl: null, lastHealthError: null, stale: false, bundle: null, bundleRegressionPct: null, dependsOn: [], activeEnvFile: null, workspaceLabel: null };
    },
    start: async (n) => {
      const s = states.get(n);
      if (!s) return { ok: false, status: 'unknown' };
      const target = (opts.startWillReach && opts.startWillReach[n]) || { status: 'serving', health: 'healthy' };
      setTimeout(() => { Object.assign(s, target); ee.emit('change'); }, 5);
      return { ok: true, status: 'starting' };
    },
    restart: async (n) => {
      const s = states.get(n);
      if (!s) return { ok: false, status: 'unknown' };
      const target = (opts.restartWillReach && opts.restartWillReach[n]) || { status: 'serving', health: 'healthy' };
      setTimeout(() => { Object.assign(s, target); ee.emit('change'); }, 5);
      return { ok: true, status: 'starting' };
    },
    errors: (n) => opts.errors?.[n] ?? [],
    waitFor: (name, until, timeoutMs) => new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        const s = states.get(name);
        if (!s) return resolve({ name, status: 'unknown', health: 'unknown', timedOut: false, waitedMs: 0 });
        if (until === 'serving' && s.status === 'serving') return resolve({ name, status: s.status, health: s.health, timedOut: false, waitedMs: Date.now() - start });
        if (until === 'healthy' && s.status === 'serving' && s.health === 'healthy') return resolve({ name, status: s.status, health: s.health, timedOut: false, waitedMs: Date.now() - start });
      };
      check();
      const onChange = () => check();
      ee.on('change', onChange);
      setTimeout(() => { ee.off('change', onChange); const s = states.get(name); resolve({ name, status: s?.status ?? 'unknown', health: s?.health ?? 'unknown', timedOut: true, waitedMs: timeoutMs }); }, timeoutMs);
    }),
  };
  return reg;
}

const baseCfg = {
  profiles: { full: ['web', 'api'] },
  depends: { web: ['api'], api: [] },
  doctor: { autoFix: { permitted: [] } },
};

test('orchestrate dry-run reports planned order and unhealthy apps without starting', async () => {
  const reg = makeFakeRegistry({ web: { status: 'stopped' }, api: { status: 'stopped' } });
  const r = await orchestrateProfile(reg, baseCfg, { profile: 'full', goal: 'healthy', timeoutMs: 5000, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(Array.isArray(r.plannedOrder));
  assert.ok(r.plannedOrder.flat().includes('api'));
  assert.ok(r.plannedOrder.flat().includes('web'));
});

test('orchestrate unknown profile returns error', async () => {
  const reg = makeFakeRegistry({ web: { status: 'stopped' } });
  const r = await orchestrateProfile(reg, baseCfg, { profile: 'nope', goal: 'healthy', timeoutMs: 5000 });
  assert.ok(r.error);
});

test('orchestrate already-healthy apps are no-ops', async () => {
  const reg = makeFakeRegistry({ web: { status: 'serving', health: 'healthy' }, api: { status: 'serving', health: 'healthy' } });
  const r = await orchestrateProfile(reg, baseCfg, { profile: 'full', goal: 'healthy', timeoutMs: 5000 });
  assert.equal(r.allReached, true);
  for (const p of r.perApp) assert.equal(p.tries, 0);
});

test('orchestrate happy-path cascade-starts apps and they reach goal', async () => {
  const reg = makeFakeRegistry({ web: { status: 'stopped' }, api: { status: 'stopped' } });
  const r = await orchestrateProfile(reg, baseCfg, { profile: 'full', goal: 'healthy', timeoutMs: 5000 });
  assert.equal(r.allReached, true);
  assert.equal(r.perApp.length, 2);
  for (const p of r.perApp) assert.equal(p.reached, true);
});

test('orchestrate runs at most one try-fix round and surfaces stillFailing', async () => {
  const reg = makeFakeRegistry(
    { web: { status: 'stopped' }, api: { status: 'stopped' } },
    {
      startWillReach: { api: { status: 'serving', health: 'healthy' }, web: { status: 'error', health: 'unhealthy' } },
      restartWillReach: { web: { status: 'error', health: 'unhealthy' } },
      errors: { web: [{ message: 'TS1234: bad', parsed: { file: 'a.ts', line: 1, col: 2, code: 'TS1234', tool: 'typescript', message: 'TS1234: bad' } }] },
    },
  );
  const r = await orchestrateProfile(reg, baseCfg, { profile: 'full', goal: 'healthy', timeoutMs: 2000 });
  assert.equal(r.allReached, false);
  const web = r.perApp.find(p => p.name === 'web');
  assert.equal(web.reached, false);
  assert.equal(web.tries, 2);
  assert.ok(Array.isArray(web.stillFailing));
  assert.ok(web.stillFailing.length >= 1);
  assert.equal(web.stillFailing[0].code, 'TS1234');
});
