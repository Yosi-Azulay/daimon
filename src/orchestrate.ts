import type { Registry } from './registry.js';
import type { AppmanConfig } from './types.js';
import { findCycle, topoLevels, transitiveClosure } from './depends.js';

export type OrchestrateGoal = 'serving' | 'healthy' | 'stable';

export interface OrchestrateOptions {
  profile: string;
  goal: OrchestrateGoal;
  timeoutMs: number;
  dryRun?: boolean;
  budgetTokens?: number;
  stableMs?: number;
}

export interface OrchestratePerApp {
  name: string;
  reached: boolean;
  tries: number;
  fixed?: string[];
  stillFailing?: { file: string | null; line: number | null; code: string | null; tool: string | null; message: string }[];
  waitedMs?: number;
  error?: string;
}

export interface OrchestrateResult {
  profile: string;
  goal: OrchestrateGoal;
  perApp: OrchestratePerApp[];
  totalMs: number;
  allReached: boolean;
  dryRun?: boolean;
  plannedOrder?: string[][];
  alreadyHealthy?: string[];
  _meta?: { omitted?: { stillFailing?: number; perApp?: number }; warning?: string };
}

const DEFAULT_TOKENS_PER_FAILING = 60;
const DEFAULT_TOKENS_PER_APP_ROW = 25;

function reachedTarget(
  registry: Registry,
  name: string,
  goal: OrchestrateGoal,
  lastSignalAtMs: number,
  stableMs: number,
): boolean {
  const s = registry.summary(name);
  if (!s) return false;
  if (goal === 'serving') return s.status === 'serving';
  if (goal === 'healthy') return s.status === 'serving' && s.health === 'healthy';
  const idle = Date.now() - lastSignalAtMs;
  return s.status === 'serving' && s.health === 'healthy' && idle >= stableMs;
}

async function waitForGoal(
  registry: Registry,
  name: string,
  goal: OrchestrateGoal,
  timeoutMs: number,
  stableMs: number,
): Promise<{ reached: boolean; waitedMs: number }> {
  const start = Date.now();
  if (goal !== 'stable') {
    const r = await registry.waitFor(name, goal === 'serving' ? 'serving' : 'healthy', timeoutMs);
    return { reached: !r.timedOut, waitedMs: r.waitedMs };
  }
  let lastSignalAt = Date.now();
  const onEvent = (ev: any) => { if (ev?.app === name) lastSignalAt = Date.now(); };
  registry.on('event', onEvent);
  try {
    while (Date.now() - start < timeoutMs) {
      if (reachedTarget(registry, name, goal, lastSignalAt, stableMs)) {
        return { reached: true, waitedMs: Date.now() - start };
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return { reached: reachedTarget(registry, name, goal, lastSignalAt, stableMs), waitedMs: Date.now() - start };
  } finally {
    registry.off('event', onEvent);
  }
}

export async function orchestrateProfile(
  registry: Registry,
  config: AppmanConfig,
  opts: OrchestrateOptions,
): Promise<OrchestrateResult | { error: string }> {
  const start = Date.now();
  const list = config.profiles?.[opts.profile];
  if (!list) return { error: `unknown profile: ${opts.profile}` };
  const known = list.filter(n => registry.summary(n) != null);
  const closure = Array.from(new Set(known.flatMap(n => transitiveClosure(config.depends ?? {}, n)))).filter(n => registry.summary(n) != null);
  const levels = topoLevels(config.depends ?? {}, closure);

  // topoLevels only emits nodes that reach in-degree 0, so any app inside a
  // dependency cycle is silently omitted from the plan and never started.
  // Detect that and surface it rather than letting the apps vanish.
  const inSet = new Set(closure);
  const scheduled = new Set(levels.flat());
  const cyclicApps = closure.filter(n => !scheduled.has(n));
  let cycleWarning: string | undefined;
  if (cyclicApps.length) {
    const cyc = findCycle(config.depends ?? {});
    const cycStr = cyc ? cyc.filter(n => inSet.has(n)).join(' → ') : cyclicApps.join(', ');
    cycleWarning = `dependency cycle detected (${cycStr}); ${cyclicApps.length} app(s) cannot be ordered and were skipped: ${cyclicApps.join(', ')}`;
  }

  const alreadyHealthy: string[] = [];
  for (const n of closure) {
    const s = registry.summary(n);
    if (!s) continue;
    if (opts.goal === 'serving' && s.status === 'serving') alreadyHealthy.push(n);
    else if ((opts.goal === 'healthy' || opts.goal === 'stable') && s.status === 'serving' && s.health === 'healthy') alreadyHealthy.push(n);
  }

  if (opts.dryRun) {
    const unhealthy = closure.filter(n => !alreadyHealthy.includes(n));
    return {
      profile: opts.profile,
      goal: opts.goal,
      perApp: unhealthy.map(n => ({ name: n, reached: false, tries: 0, ...(cyclicApps.includes(n) ? { error: 'in dependency cycle — cannot order' } : {}) })),
      totalMs: Date.now() - start,
      allReached: unhealthy.length === 0,
      dryRun: true,
      plannedOrder: levels,
      alreadyHealthy,
      ...(cycleWarning ? { _meta: { warning: cycleWarning } } : {}),
    };
  }

  const perAppTimeout = Math.max(5000, Math.floor(opts.timeoutMs / 2));
  const stableMs = opts.stableMs ?? 5000;
  const perApp = new Map<string, OrchestratePerApp>();
  for (const n of closure) perApp.set(n, { name: n, reached: false, tries: 0 });
  // Cyclic apps aren't in any topo level, so the start/wait loops below skip
  // them. Record why instead of returning them as an unexplained reached:false.
  for (const n of cyclicApps) perApp.set(n, { name: n, reached: false, tries: 0, error: 'in dependency cycle — cannot order' });

  for (const level of levels) {
    await Promise.all(level.map(async n => {
      const s = registry.summary(n);
      if (!s) { perApp.set(n, { name: n, reached: false, tries: 0, error: 'unknown app' }); return; }
      if (alreadyHealthy.includes(n)) { perApp.set(n, { name: n, reached: true, tries: 0 }); return; }
      if (s.status !== 'starting' && s.status !== 'compiling' && s.status !== 'serving') {
        await registry.start(n);
      }
    }));
    await Promise.all(level.map(async n => {
      if (perApp.get(n)?.reached) return;
      const r = await waitForGoal(registry, n, opts.goal, perAppTimeout, stableMs);
      const entry = perApp.get(n)!;
      entry.tries = 1;
      entry.waitedMs = r.waitedMs;
      entry.reached = r.reached;
      perApp.set(n, entry);
    }));
  }

  // Exclude cyclic apps from straggler recovery — they were never scheduled, so
  // restarting them would ignore their (cyclic) dependencies.
  const cyclicSet = new Set(cyclicApps);
  const stragglers = [...perApp.values()].filter(p => !p.reached && !cyclicSet.has(p.name));
  if (stragglers.length > 0) {
    const { runAutoFix, ORCHESTRATE_SAFE_AUTO_FIX } = await import('./autoFix.js');
    // Default to the safe subset: orchestrate should never rewrite the user's
    // config or restart the daemon as a side effect. An explicit
    // `doctor.autoFix.permitted` in config is still honoured (opt-in).
    const permitted = (config.doctor?.autoFix?.permitted as any) ?? ORCHESTRATE_SAFE_AUTO_FIX;
    const remainingBudget = Math.max(5000, opts.timeoutMs - (Date.now() - start));
    const perStragglerTimeout = Math.max(5000, Math.floor(remainingBudget / Math.max(stragglers.length, 1)));
    let fixResult: any = { ran: [] };
    try { fixResult = await runAutoFix({ permitted, dryRun: false }); } catch {}
    const fixedRules: string[] = (fixResult.ran ?? []).map((r: any) => r.name);
    await Promise.all(stragglers.map(async p => {
      const entry = perApp.get(p.name)!;
      entry.tries = 2;
      try {
        const rr = await registry.restart(p.name);
        if (!rr?.ok) entry.error = rr?.error ?? 'restart failed';
      } catch (err: any) {
        entry.error = err?.message ?? String(err);
      }
      const r = await waitForGoal(registry, p.name, opts.goal, perStragglerTimeout, stableMs);
      entry.waitedMs = (entry.waitedMs ?? 0) + r.waitedMs;
      entry.reached = r.reached;
      if (!entry.reached) {
        const errs = registry.errors(p.name) ?? [];
        entry.stillFailing = errs.slice(0, 3).map(e => ({
          file: e.parsed?.file ?? null,
          line: e.parsed?.line ?? null,
          code: e.parsed?.code ?? null,
          tool: e.parsed?.tool ?? null,
          message: e.parsed?.message ?? e.message,
        }));
      }
      entry.fixed = fixedRules;
      perApp.set(p.name, entry);
    }));
  }

  const perAppArr = [...perApp.values()];
  const allReached = perAppArr.every(p => p.reached);
  const result: OrchestrateResult = {
    profile: opts.profile,
    goal: opts.goal,
    perApp: perAppArr,
    totalMs: Date.now() - start,
    allReached,
  };
  if (cycleWarning) result._meta = { ...(result._meta ?? {}), warning: cycleWarning };

  if (typeof opts.budgetTokens === 'number' && opts.budgetTokens > 0) {
    let budget = opts.budgetTokens;
    let omittedFailing = 0;
    let omittedRows = 0;
    for (const entry of perAppArr) {
      if (entry.stillFailing) {
        const cost = entry.stillFailing.length * DEFAULT_TOKENS_PER_FAILING;
        if (cost > budget) {
          omittedFailing += entry.stillFailing.length;
          delete entry.stillFailing;
        } else {
          budget -= cost;
        }
      }
    }
    while (budget < 0 || perAppArr.length * DEFAULT_TOKENS_PER_APP_ROW > Math.max(budget, opts.budgetTokens / 4)) {
      const idx = perAppArr.findIndex(p => p.reached);
      if (idx === -1) break;
      perAppArr.splice(idx, 1);
      omittedRows++;
    }
    if (omittedFailing || omittedRows) {
      result._meta = { ...(result._meta ?? {}), omitted: {} };
      if (omittedFailing) result._meta.omitted!.stillFailing = omittedFailing;
      if (omittedRows) result._meta.omitted!.perApp = omittedRows;
    }
  }

  return result;
}
