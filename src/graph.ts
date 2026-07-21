// Read-only dependency-graph view (M175, v1.15 "Atlas"): pure composition over
// the EXISTING depends graph + registry summaries + v1.1 group membership.
// This module renders what depends.ts / orchestrate.ts already compute — it
// never changes cascade behavior, never triggers a start/stop, and holds no
// state. `GET /api/graph`, `daimon graph`, the MCP `daimon_graph` tool, and the
// dashboard graph page all consume this one shape.
//
// Workspace matching rule (M177): a node's EFFECTIVE label is its
// workspaceLabel when the searchRoot is labeled, else the basename of its
// workspaceRoot (discovery.ts's labelHint fallback) — so a label-free config
// still filters usefully. The same rule backs the dashboard/TUI switchers.

import * as path from 'node:path';
import type { AppSummary, AppmanConfig } from './types.js';
import { findCycle, topoLevels } from './depends.js';
import { groupUpPlan } from './groups.js';

export interface GraphNode {
  name: string;
  baseName: string;
  status: string;
  health: string;
  workspaceLabel: string | null;
  groups: string[];
  dependsOn: string[];      // resolved to node names present in this view
  dependedOnBy: string[];   // reverse edges, same restriction
  inCycle: boolean;
}

export interface GraphEdge { from: string; to: string } // from DEPENDS ON to

// One group's `up` start-order preview (M176): the EXACT plan `up <group>`
// executes — same groupUpPlan call, same inputs — so the graph page's panel
// and the CLI preview can never drift from what the verb actually does.
// Computed over ALL known apps, never the workspace-filtered view: a group may
// span workspaces and the order must match `up` exactly.
export interface GraphGroupPlan {
  name: string;
  apps: string[];       // declared members, config order
  levels: string[][];   // topo levels over members ∪ transitive deps
  cyclic: string[];
  unknown: string[];
}

export interface GraphView {
  workspace: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Topo levels over the view's nodes — dependencies first, same shape
  // orchestrate's plannedOrder uses. Nodes inside (or downstream of) a cycle
  // never reach in-degree 0 and are absent here; see `cycles` / `unordered`.
  levels: string[][];
  // Each detected cycle as a node path (closed walk, closing node not
  // repeated: ['a','b'] means a → b → a).
  cycles: string[][];
  // Nodes topoLevels could not schedule that are NOT members of a cycle —
  // they depend (transitively) on one, so no start order exists for them.
  unordered: string[];
  // v1.1 groups with their `up` start-order previews (M176), name-sorted.
  groups: GraphGroupPlan[];
}

// label ?? basename(root): the one rule for what a workspace is CALLED.
export function effectiveWorkspaceLabel(
  workspaceLabel: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string | null {
  if (workspaceLabel) return workspaceLabel;
  if (workspaceRoot) return path.basename(workspaceRoot) || null;
  return null;
}

export function matchesWorkspace(
  s: Pick<AppSummary, 'workspaceLabel' | 'workspaceRoot'>,
  label: string,
): boolean {
  return effectiveWorkspaceLabel(s.workspaceLabel, s.workspaceRoot) === label;
}

// The switcher list: every configured searchRoot's effective label, config
// order, deduped (two roots may share a basename — one entry, both match).
export function workspaceLabels(config: Pick<AppmanConfig, 'searchRoots'>): string[] {
  const out: string[] = [];
  for (const s of config.searchRoots ?? []) {
    const label = typeof s === 'string'
      ? effectiveWorkspaceLabel(null, s)
      : effectiveWorkspaceLabel(s.label ?? null, s.path);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// Resolve one `depends` entry (a baseName by convention, but a full registry
// key also works) to node names in the view: exact name match wins; otherwise
// every node sharing the baseName (a collided name means the dependency is
// intended for each workspace's copy — show it, don't guess one).
function resolveDep(dep: string, byName: Map<string, GraphNode>, byBase: Map<string, string[]>): string[] {
  if (byName.has(dep)) return [dep];
  return byBase.get(dep) ?? [];
}

export function buildGraphView(
  summaries: Pick<AppSummary, 'name' | 'baseName' | 'status' | 'health' | 'workspaceLabel' | 'workspaceRoot' | 'dependsOn'>[],
  config: Pick<AppmanConfig, 'depends' | 'groups'>,
  workspace?: string | null,
  // Names groupUpPlan resolves against — pass the FULL registry name set so
  // plans match `up` even when the view is workspace-filtered. Defaults to
  // the summaries' own names.
  allKnownNames?: string[],
): GraphView {
  const inView = workspace
    ? summaries.filter(s => matchesWorkspace(s, workspace))
    : summaries;

  const byName = new Map<string, GraphNode>();
  const byBase = new Map<string, string[]>();
  for (const s of inView) {
    const node: GraphNode = {
      name: s.name,
      baseName: s.baseName,
      status: s.status,
      health: s.health,
      workspaceLabel: effectiveWorkspaceLabel(s.workspaceLabel, s.workspaceRoot),
      groups: [],
      dependsOn: [],
      dependedOnBy: [],
      inCycle: false,
    };
    byName.set(s.name, node);
    const list = byBase.get(s.baseName) ?? [];
    list.push(s.name);
    byBase.set(s.baseName, list);
  }

  // Group membership (v1.1): a group names apps by baseName or full name.
  for (const [gname, def] of Object.entries(config.groups ?? {})) {
    for (const member of def.apps) {
      for (const n of resolveDep(member, byName, byBase)) {
        const node = byName.get(n)!;
        if (!node.groups.includes(gname)) node.groups.push(gname);
      }
    }
  }

  // Edges from config.depends via each node's own dependsOn (already
  // baseName-keyed by the registry), both endpoints restricted to the view.
  const edges: GraphEdge[] = [];
  const adjacency: Record<string, string[]> = {};
  for (const node of byName.values()) adjacency[node.name] = [];
  for (const s of inView) {
    const node = byName.get(s.name)!;
    for (const dep of s.dependsOn ?? []) {
      for (const target of resolveDep(dep, byName, byBase)) {
        if (target === s.name) continue; // self-dependency: ignore, not an edge
        if (node.dependsOn.includes(target)) continue;
        node.dependsOn.push(target);
        adjacency[s.name].push(target);
        edges.push({ from: s.name, to: target });
        const t = byName.get(target)!;
        if (!t.dependedOnBy.includes(s.name)) t.dependedOnBy.push(s.name);
      }
    }
  }

  const names = [...byName.keys()];
  const levels = topoLevels(adjacency, names);
  const scheduled = new Set(levels.flat());
  let unscheduled = names.filter(n => !scheduled.has(n));

  // Extract every cycle: findCycle returns one closed walk; peel it off the
  // unscheduled subgraph and repeat. What remains unscheduled but cycle-free
  // depends on a cycle downstream — report it as `unordered`, never guess.
  const cycles: string[][] = [];
  let sub: Record<string, string[]> = {};
  const inSub = new Set(unscheduled);
  for (const n of unscheduled) sub[n] = (adjacency[n] ?? []).filter(d => inSub.has(d));
  for (;;) {
    const walk = findCycle(sub);
    if (!walk) break;
    // findCycle closes the walk (first node repeated last) — drop the repeat.
    const cyc = walk.length > 1 && walk[0] === walk[walk.length - 1] ? walk.slice(0, -1) : walk;
    cycles.push(cyc);
    for (const n of cyc) {
      const node = byName.get(n);
      if (node) node.inCycle = true;
      inSub.delete(n);
    }
    const next: Record<string, string[]> = {};
    for (const n of inSub) next[n] = (sub[n] ?? []).filter(d => inSub.has(d));
    sub = next;
  }
  const cycleMembers = new Set(cycles.flat());
  const unordered = unscheduled.filter(n => !cycleMembers.has(n)).sort();

  const nodes = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const n of nodes) {
    n.dependsOn.sort();
    n.dependedOnBy.sort();
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // Group start-order previews (M176): the exact groupUpPlan `up` executes.
  const knownForPlans = new Set(allKnownNames ?? summaries.map(s => s.name));
  const groups: GraphGroupPlan[] = Object.keys(config.groups ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map(gname => {
      const plan = groupUpPlan(config, gname, knownForPlans)!;
      return {
        name: gname,
        apps: [...(config.groups![gname].apps)],
        levels: plan.levels,
        cyclic: plan.cyclic,
        unknown: plan.unknown,
      };
    });

  return { workspace: workspace ?? null, nodes, edges, levels, cycles, unordered, groups };
}

// ── TTY rendering (`daimon graph` on a terminal) ─────────────────────────────
// Topo levels top-down, per-node status + health + edges, cycle members marked.
// Pure string builder — the CLI applies color, this module never does.

export function renderGraphTree(view: GraphView): string {
  const L: string[] = [];
  const header = view.workspace ? `graph  ws:${view.workspace}` : 'graph';
  L.push(`${header}  (${view.nodes.length} app${view.nodes.length === 1 ? '' : 's'}, ${view.edges.length} edge${view.edges.length === 1 ? '' : 's'})`);
  if (view.nodes.length === 0) {
    L.push("  (no apps in view — run 'daimon list --all' to see every workspace, or 'daimon init --yes' to register this folder)");
    return L.join('\n');
  }
  const byName = new Map(view.nodes.map(n => [n.name, n]));
  view.levels.forEach((level, i) => {
    L.push(`  level ${i + 1}`);
    for (const name of level) {
      const n = byName.get(name);
      if (!n) continue;
      const deps = n.dependsOn.length ? `  ← ${n.dependsOn.join(', ')}` : '';
      const groups = n.groups.length ? `  [${n.groups.join(', ')}]` : '';
      L.push(`    ${n.name}  (${n.status}/${n.health})${groups}${deps}`);
    }
  });
  for (const cyc of view.cycles) {
    L.push(`  ✗ cycle: ${[...cyc, cyc[0]].join(' → ')} — these apps cannot be ordered`);
    for (const name of cyc) {
      const n = byName.get(name);
      if (!n) continue;
      L.push(`    ${n.name}  (${n.status}/${n.health})  ← ${n.dependsOn.join(', ')}`);
    }
  }
  if (view.unordered.length) {
    L.push(`  blocked by cycle: ${view.unordered.join(', ')} (they depend on a cycle member)`);
  }
  return L.join('\n');
}
