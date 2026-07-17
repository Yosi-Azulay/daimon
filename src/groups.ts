// Named app groups (M93, v1.1): resolution + validation over the normalized
// `groups` config key. Groups consume the depends graph (topoLevels /
// transitiveClosure) and NEVER change it — depends semantics live in
// depends.ts. Groups additively subsume the legacy `profiles` map: the
// shorthand form is exactly the profiles shape, and a name defined in both
// resolves to the group (call sites check groups first; `validateGroups`
// warns on the collision).

import type { AppmanConfig, GroupDef } from './types.js';
import { topoLevels, transitiveClosure } from './depends.js';

export interface ResolvedGroup {
  name: string;
  // Member apps ordered dependencies-first (topo order among the members;
  // cyclic members excluded — they appear in `cyclic` instead).
  apps: string[];
  autoStart: boolean;
  // Members not present in `knownApps` (only populated when a set was given).
  // Run-time rule: warn and skip, start the rest — never abort the group.
  unknown: string[];
  // Members inside a dependency cycle — reported, never started.
  cyclic: string[];
}

export function groupNames(config: Pick<AppmanConfig, 'groups'>): string[] {
  return Object.keys(config.groups ?? {});
}

export function getGroup(config: Pick<AppmanConfig, 'groups'>, name: string): GroupDef | null {
  return config.groups?.[name] ?? null;
}

// Resolve a group to its member apps, ordered via the existing depends graph.
// `knownApps` (registry names / discovered apps) is optional: without it every
// member is treated as known and ordering is still computed.
export function resolveGroup(
  config: Pick<AppmanConfig, 'groups' | 'depends'>,
  name: string,
  knownApps?: Set<string> | null,
): ResolvedGroup | null {
  const def = config.groups?.[name];
  if (!def) return null;
  const members = [...new Set(def.apps)];
  const unknown = knownApps ? members.filter(a => !knownApps.has(a)) : [];
  const present = knownApps ? members.filter(a => knownApps.has(a)) : members;
  const levels = topoLevels(config.depends ?? {}, present);
  const ordered = levels.flat();
  const scheduled = new Set(ordered);
  const cyclic = present.filter(a => !scheduled.has(a));
  return { name, apps: ordered, autoStart: def.autoStart, unknown, cyclic };
}

export interface GroupUpPlan {
  group: string;
  // Topo levels over members ∪ their transitive dependencies (known apps
  // only) — the start order for `up <group>` (M94), same expansion the
  // profile orchestrator uses.
  levels: string[][];
  // Every app the plan touches, dependencies first.
  closure: string[];
  unknown: string[];
  cyclic: string[];
}

export function groupUpPlan(
  config: Pick<AppmanConfig, 'groups' | 'depends'>,
  name: string,
  knownApps: Set<string>,
): GroupUpPlan | null {
  const def = config.groups?.[name];
  if (!def) return null;
  const members = [...new Set(def.apps)];
  const unknown = members.filter(a => !knownApps.has(a));
  const present = members.filter(a => knownApps.has(a));
  const depends = config.depends ?? {};
  const closure = [...new Set(present.flatMap(a => transitiveClosure(depends, a)))]
    .filter(a => knownApps.has(a));
  const levels = topoLevels(depends, closure);
  const scheduled = new Set(levels.flat());
  const cyclic = closure.filter(a => !scheduled.has(a));
  return { group: name, levels, closure: levels.flat(), unknown, cyclic };
}

// Stop order for `stop <group>` / `down <group>` (M94): the group's members
// only (external dependencies are shared — never stopped implicitly), in
// reverse depends order. Cyclic members can't be ordered; they are appended
// last so a cycle never leaves group members running.
export function groupStopOrder(
  config: Pick<AppmanConfig, 'groups' | 'depends'>,
  name: string,
  knownApps: Set<string>,
): { order: string[]; unknown: string[] } | null {
  const def = config.groups?.[name];
  if (!def) return null;
  const members = [...new Set(def.apps)];
  const unknown = members.filter(a => !knownApps.has(a));
  const present = members.filter(a => knownApps.has(a));
  const levels = topoLevels(config.depends ?? {}, present);
  const ordered = levels.flat();
  const scheduled = new Set(ordered);
  const cyclic = present.filter(a => !scheduled.has(a));
  return { order: [...ordered.reverse(), ...cyclic], unknown };
}

// Boot-time autoStart plan (M96): the per-app `autoStart` list first, then
// every `autoStart: true` group in config order. Dedup happens HERE, at
// resolution before any spawn — an app named by several sources appears once,
// with every source recorded for the single log line.
export interface AutoStartEntry {
  app: string;
  // 'autoStart' for the per-app list, 'group:<name>' per contributing group.
  sources: string[];
}

export function autoStartPlan(
  config: Pick<AppmanConfig, 'groups' | 'depends' | 'autoStart'>,
): AutoStartEntry[] {
  const plan = new Map<string, AutoStartEntry>();
  const add = (app: string, source: string): void => {
    const cur = plan.get(app);
    if (cur) {
      if (!cur.sources.includes(source)) cur.sources.push(source);
    } else {
      plan.set(app, { app, sources: [source] });
    }
  };
  for (const app of config.autoStart ?? []) add(app, 'autoStart');
  for (const [name, def] of Object.entries(config.groups ?? {})) {
    if (!def.autoStart) continue;
    // Members in depends order so earlier spawns are the dependencies —
    // same graph the group's `up` uses; cyclic members still get their
    // start attempt (per-app failure degrades, never blocks boot).
    const levels = topoLevels(config.depends ?? {}, [...new Set(def.apps)]);
    const ordered = levels.flat();
    const scheduled = new Set(ordered);
    for (const app of ordered) add(app, `group:${name}`);
    for (const app of def.apps) if (!scheduled.has(app)) add(app, `group:${name}`);
  }
  return [...plan.values()];
}

// Small edit-distance for nearest-name suggestions, local on purpose (same
// convention as config.ts's key suggester — groups.ts must stay importable
// without the CLI help layer).
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

export function nearestName(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = 3; // suggest only within 2 edits
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

// `daimon config validate` checks (M93). Pure over the normalized config —
// warnings never block loading (config back-compat is not breakable).
// `knownAppNames` comes from discovery; pass null to skip unknown-app checks
// (e.g. when discovery itself failed — degrade, don't guess).
export function validateGroups(
  config: Pick<AppmanConfig, 'groups' | 'profiles' | 'autoStart'>,
  knownAppNames: string[] | null,
): string[] {
  const warnings: string[] = [];
  const groups = config.groups ?? {};
  const known = knownAppNames ? new Set(knownAppNames) : null;

  for (const [name, def] of Object.entries(groups)) {
    if (def.apps.length === 0) {
      warnings.push(`groups.${name}: empty group — 'daimon up ${name}' will start nothing`);
    }
    if (name === 'fingerprint') {
      warnings.push(`group "fingerprint" is shadowed on 'daimon errors --group' (that value keeps its historical stack-fingerprint meaning) — rename the group to use it there`);
    }
    if (known) {
      for (const app of def.apps) {
        if (known.has(app)) continue;
        const guess = nearestName(app, knownAppNames!);
        warnings.push(`groups.${name}: unknown app "${app}"${guess ? ` — did you mean "${guess}"?` : ''} (skipped at run time; the rest of the group still starts)`);
      }
    }
    if (config.profiles && name in config.profiles) {
      warnings.push(`group "${name}" also exists in profiles — the group wins for up/stop/down; rename one to silence this`);
    }
  }

  // Dual-autoStart membership: informational, not a problem — dedup at
  // resolution means the app starts once.
  const autoStartGroupsByApp = new Map<string, string[]>();
  for (const [name, def] of Object.entries(groups)) {
    if (!def.autoStart) continue;
    for (const app of new Set(def.apps)) {
      const cur = autoStartGroupsByApp.get(app) ?? [];
      cur.push(name);
      autoStartGroupsByApp.set(app, cur);
    }
  }
  for (const [app, names] of autoStartGroupsByApp) {
    const alsoPerApp = (config.autoStart ?? []).includes(app);
    if (names.length > 1) {
      warnings.push(`app "${app}" is in autoStart groups ${names.map(n => `"${n}"`).join(' and ')} — it starts once at boot`);
    } else if (alsoPerApp) {
      warnings.push(`app "${app}" is in the autoStart list and autoStart group "${names[0]}" — it starts once at boot`);
    }
  }

  return warnings;
}
