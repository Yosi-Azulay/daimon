// Pure layout + a11y math for the depends-graph page (M174/M176, v1.15
// "Atlas"). Hand-rolled SVG only — no chart/graph/layout library, ever (a
// locked v1.15 rule). Everything here is a pure function over the /api/graph
// GraphView so it unit-tests without Angular or a DOM, and the page itself
// stays a thin renderer.
//
// The graph is READ-ONLY visualization: nothing in this module (or the page)
// may start, stop, or reorder an app. Layout columns ARE the topo levels the
// daemon computed — dependencies left, dependents right — so what you see is
// literally the order `up` would use.

import type { GraphGroupPlan, GraphNode, GraphView } from './daimon-api';

export const NODE_W = 156;
export const NODE_H = 48;
export const COL_GAP = 72;
export const ROW_GAP = 18;
export const MARGIN = 28;
// Extra headroom above the top node row so group-hull labels never clip.
export const HULL_LABEL_ROOM = 22;

export interface LaidNode {
  node: GraphNode;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface LaidEdge {
  from: string;
  to: string;
  /** SVG path d: from the dependent's left edge to the dependency's right edge. */
  d: string;
  inCycle: boolean;
}

export interface GroupHull {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  members: string[];
}

export interface GraphLayout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  hulls: GroupHull[];
  width: number;
  height: number;
}

// Column plan: one column per topo level (dependencies first), then every
// cycle in its own column, then the cycle-blocked (`unordered`) apps last —
// nothing the daemon reported is ever silently dropped from the drawing.
function columnPlan(view: GraphView): string[][] {
  const cols: string[][] = view.levels.map(l => [...l]);
  for (const cyc of view.cycles) cols.push([...cyc]);
  if (view.unordered.length) cols.push([...view.unordered]);
  return cols.filter(c => c.length > 0);
}

export function layoutGraph(view: GraphView): GraphLayout {
  const byName = new Map(view.nodes.map(n => [n.name, n]));
  const cols = columnPlan(view);
  const topY = MARGIN + HULL_LABEL_ROOM;

  const laid: LaidNode[] = [];
  const pos = new Map<string, LaidNode>();
  cols.forEach((names, col) => {
    names.forEach((name, row) => {
      const node = byName.get(name);
      if (!node) return;
      const ln: LaidNode = {
        node,
        col,
        row,
        x: MARGIN + col * (NODE_W + COL_GAP),
        y: topY + row * (NODE_H + ROW_GAP),
      };
      laid.push(ln);
      pos.set(name, ln);
    });
  });

  const cycleMembers = new Set(view.cycles.flat());
  const edges: LaidEdge[] = view.edges
    .filter(e => pos.has(e.from) && pos.has(e.to))
    .map(e => {
      const a = pos.get(e.from)!; // dependent
      const b = pos.get(e.to)!;   // dependency
      // Anchor on the facing sides; a gentle cubic keeps parallel edges legible.
      const x1 = a.x;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x + NODE_W;
      const y2 = b.y + NODE_H / 2;
      const dx = Math.max(24, Math.abs(x1 - x2) / 2);
      const d = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
      return { from: e.from, to: e.to, d, inCycle: cycleMembers.has(e.from) && cycleMembers.has(e.to) };
    });

  const hulls = groupHulls(view, pos);

  const maxCol = cols.length;
  const maxRows = cols.reduce((m, c) => Math.max(m, c.length), 0);
  return {
    nodes: laid,
    edges,
    hulls,
    width: MARGIN * 2 + Math.max(1, maxCol) * NODE_W + Math.max(0, maxCol - 1) * COL_GAP,
    height: topY + MARGIN + Math.max(1, maxRows) * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP,
  };
}

// Group cluster hulls (M176): a padded bounding region per v1.1 group over its
// member nodes IN VIEW. An app in several groups is drawn once — it just sits
// inside several hulls. Groups with fewer than 1 visible member get no hull.
// Padding grows with the group's index so two groups over the same members
// render as distinguishable nested outlines rather than one rectangle.
function groupHulls(view: GraphView, pos: Map<string, LaidNode>): GroupHull[] {
  const hulls: GroupHull[] = [];
  const groupNames = [...new Set(view.nodes.flatMap(n => n.groups))].sort();
  groupNames.forEach((gname, i) => {
    const members = view.nodes.filter(n => n.groups.includes(gname)).map(n => n.name);
    const placed = members.map(m => pos.get(m)).filter((p): p is LaidNode => !!p);
    if (!placed.length) return;
    const pad = 10 + (i % 3) * 6;
    const minX = Math.min(...placed.map(p => p.x)) - pad;
    const minY = Math.min(...placed.map(p => p.y)) - pad - 14; // room for the label
    const maxX = Math.max(...placed.map(p => p.x + NODE_W)) + pad;
    const maxY = Math.max(...placed.map(p => p.y + NODE_H)) + pad;
    hulls.push({ name: gname, x: minX, y: minY, w: maxX - minX, h: maxY - minY, members });
  });
  return hulls;
}

// ── non-color status channel ──────────────────────────────────────────────────
// Color alone never encodes health (locked v1.15 rule): every status pairs its
// token color with a distinct glyph AND a distinct border treatment, and the
// status word itself is in the node's visible text + aria label.

export function statusGlyph(status: string): string {
  switch (status) {
    case 'serving': return '●';
    case 'compiling': return '◐';
    case 'starting': return '◌';
    case 'error': return '✕';
    default: return '○'; // stopped / unknown
  }
}

/** stroke-dasharray per status — the border half of the non-color channel. */
export function statusDash(status: string): string {
  switch (status) {
    case 'error': return '4 3';
    case 'compiling': return '7 3';
    case 'starting': return '2 3';
    case 'stopped': return '1 4';
    default: return ''; // serving: solid
  }
}

// ── aria ──────────────────────────────────────────────────────────────────────

export function nodeAriaLabel(n: GraphNode): string {
  const parts = [`${n.name} — ${n.status}, health ${n.health}`];
  parts.push(n.dependsOn.length ? `depends on ${n.dependsOn.join(', ')}` : 'no dependencies');
  parts.push(n.dependedOnBy.length ? `depended on by ${n.dependedOnBy.join(', ')}` : 'nothing depends on it');
  if (n.groups.length) parts.push(`in group${n.groups.length > 1 ? 's' : ''} ${n.groups.join(', ')}`);
  if (n.inCycle) parts.push('part of a dependency cycle');
  parts.push('press Enter to open the app');
  return parts.join('. ');
}

export function graphSummary(view: GraphView): string {
  if (!view.nodes.length) {
    return view.workspace
      ? `No apps in workspace ${view.workspace}.`
      : 'No apps registered.';
  }
  const parts = [
    `Dependency graph of ${view.nodes.length} app${view.nodes.length === 1 ? '' : 's'}`
    + (view.workspace ? ` in workspace ${view.workspace}` : '')
    + `, ${view.edges.length} dependenc${view.edges.length === 1 ? 'y' : 'ies'}.`,
  ];
  if (view.levels.length) {
    parts.push(`Start order: ${view.levels.map((l, i) => `level ${i + 1}: ${l.join(', ')}`).join('; ')}.`);
  }
  for (const cyc of view.cycles) {
    parts.push(`Dependency cycle: ${[...cyc, cyc[0]].join(' depends on ')} — these apps cannot be ordered.`);
  }
  if (view.unordered.length) {
    parts.push(`Blocked by the cycle: ${view.unordered.join(', ')}.`);
  }
  return parts.join(' ');
}

export function cycleLabel(cyc: string[]): string {
  return [...cyc, cyc[0]].join(' → ');
}

// The `up <group>` start-order preview line (M176) — display only, rendered
// from the SAME plan the daemon executes.
export function formatUpPreview(plan: GraphGroupPlan): string {
  if (!plan.levels.length) return 'nothing to start';
  const levels = plan.levels.map((l, i) => `level ${i + 1}: ${l.join(', ')}`).join(' · ');
  const cyc = plan.cyclic.length ? ` · in cycle (skipped): ${plan.cyclic.join(', ')}` : '';
  const unk = plan.unknown.length ? ` · unknown: ${plan.unknown.join(', ')}` : '';
  return `will start — ${levels}${cyc}${unk}`;
}

// ── keyboard navigation ───────────────────────────────────────────────────────
// Tab walks nodes (every node is tabbable, DOM order = column order = topo
// order). Arrows walk the GRAPH: left → first dependency, right → first
// dependent, up/down → neighbor in the same column. Returns the node name to
// focus, or null (caller keeps focus where it is).

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export function arrowTarget(layout: GraphLayout, current: string, key: ArrowKey): string | null {
  const cur = layout.nodes.find(n => n.node.name === current);
  if (!cur) return null;
  if (key === 'ArrowLeft') return cur.node.dependsOn[0] ?? null;
  if (key === 'ArrowRight') return cur.node.dependedOnBy[0] ?? null;
  const column = layout.nodes
    .filter(n => n.col === cur.col)
    .sort((a, b) => a.row - b.row);
  const idx = column.findIndex(n => n.node.name === current);
  const next = key === 'ArrowUp' ? column[idx - 1] : column[idx + 1];
  return next ? next.node.name : null;
}
