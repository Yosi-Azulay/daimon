import { describe, expect, it } from 'vitest';
import type { GraphView } from './daimon-api';
import {
  MARGIN, NODE_H, NODE_W,
  arrowTarget, cycleLabel, formatUpPreview, graphSummary, layoutGraph,
  nodeAriaLabel, statusDash, statusGlyph,
} from './graph-page-helpers';

// M174/M176 (v1.15 "Atlas"): pure layout + a11y math for the hand-rolled SVG
// graph. Columns ARE the daemon's topo levels; nothing is silently dropped.

function node(name: string, over: Partial<GraphView['nodes'][0]> = {}): GraphView['nodes'][0] {
  return {
    name, baseName: name, status: 'serving', health: 'healthy',
    workspaceLabel: 'main', groups: [], dependsOn: [], dependedOnBy: [], inCycle: false,
    ...over,
  };
}

// web → api → db, plus a c1 ⇄ c2 cycle and `blocked` stuck behind it.
const VIEW: GraphView = {
  workspace: null,
  nodes: [
    node('api', { dependsOn: ['db'], dependedOnBy: ['web'], groups: ['day'] }),
    node('blocked', { dependsOn: ['c1'], status: 'stopped', health: 'unknown' }),
    node('c1', { dependsOn: ['c2'], dependedOnBy: ['blocked', 'c2'], inCycle: true, status: 'error', health: 'unhealthy' }),
    node('c2', { dependsOn: ['c1'], dependedOnBy: ['c1'], inCycle: true }),
    node('db', { dependedOnBy: ['api'] }),
    node('web', { dependsOn: ['api'], groups: ['day'] }),
  ],
  edges: [
    { from: 'api', to: 'db' },
    { from: 'blocked', to: 'c1' },
    { from: 'c1', to: 'c2' },
    { from: 'c2', to: 'c1' },
    { from: 'web', to: 'api' },
  ],
  levels: [['db'], ['api'], ['web']],
  cycles: [['c1', 'c2']],
  unordered: ['blocked'],
  groups: [{ name: 'day', apps: ['web', 'api'], levels: [['db'], ['api'], ['web']], cyclic: [], unknown: [] }],
};

describe('layoutGraph', () => {
  const layout = layoutGraph(VIEW);

  it('places every node exactly once — levels, then cycles, then blocked', () => {
    expect(layout.nodes.map(n => n.node.name).sort()).toEqual(['api', 'blocked', 'c1', 'c2', 'db', 'web']);
    const col = (n: string) => layout.nodes.find(x => x.node.name === n)!.col;
    expect(col('db')).toBe(0);
    expect(col('api')).toBe(1);
    expect(col('web')).toBe(2);
    expect(col('c1')).toBe(3);
    expect(col('c2')).toBe(3);
    expect(col('blocked')).toBe(4);
  });

  it('column order is the topo order — dependencies strictly left of dependents', () => {
    const pos = new Map(layout.nodes.map(n => [n.node.name, n]));
    for (const e of VIEW.edges.filter(e => !['c1', 'c2'].includes(e.from))) {
      expect(pos.get(e.to)!.x).toBeLessThan(pos.get(e.from)!.x);
    }
  });

  it('renders every edge whose endpoints are placed; cycle edges flagged', () => {
    expect(layout.edges).toHaveLength(5);
    const cyc = layout.edges.filter(e => e.inCycle);
    expect(cyc.map(e => `${e.from}→${e.to}`).sort()).toEqual(['c1→c2', 'c2→c1']);
  });

  it('computes a canvas that contains every node', () => {
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(MARGIN);
      expect(n.x + NODE_W).toBeLessThanOrEqual(layout.width);
      expect(n.y + NODE_H).toBeLessThanOrEqual(layout.height);
    }
  });

  it('draws one hull per group covering exactly its members', () => {
    expect(layout.hulls).toHaveLength(1);
    const hull = layout.hulls[0];
    expect(hull.name).toBe('day');
    expect(hull.members.sort()).toEqual(['api', 'web']);
    const pos = new Map(layout.nodes.map(n => [n.node.name, n]));
    for (const m of hull.members) {
      const p = pos.get(m)!;
      expect(p.x).toBeGreaterThanOrEqual(hull.x);
      expect(p.x + NODE_W).toBeLessThanOrEqual(hull.x + hull.w);
      expect(p.y).toBeGreaterThanOrEqual(hull.y);
      expect(p.y + NODE_H).toBeLessThanOrEqual(hull.y + hull.h);
    }
    const db = pos.get('db')!;
    expect(db.x + NODE_W <= hull.x || db.y >= hull.y + hull.h || db.y + NODE_H <= hull.y || db.x >= hull.x + hull.w).toBe(true);
  });

  it('an app in two groups is drawn once but sits in both hulls', () => {
    const v: GraphView = {
      ...VIEW,
      nodes: VIEW.nodes.map(n => n.name === 'api' ? { ...n, groups: ['day', 'night'] } : n),
    };
    const l = layoutGraph(v);
    expect(l.nodes.filter(n => n.node.name === 'api')).toHaveLength(1);
    expect(l.hulls.map(h => h.name).sort()).toEqual(['day', 'night']);
    for (const h of l.hulls) expect(h.members).toContain('api');
  });
});

describe('status channels', () => {
  it('every status has a glyph AND a border treatment distinct from serving (never color-only)', () => {
    const statuses = ['serving', 'compiling', 'starting', 'error', 'stopped'];
    const glyphs = statuses.map(statusGlyph);
    expect(new Set(glyphs).size).toBe(statuses.length);
    for (const s of statuses.filter(s => s !== 'serving')) {
      expect(statusDash(s)).not.toBe(statusDash('serving'));
    }
  });
});

describe('aria', () => {
  it('node label narrates name, status, edges, groups, and cycle membership', () => {
    const label = nodeAriaLabel(VIEW.nodes.find(n => n.name === 'c1')!);
    expect(label).toContain('c1 — error, health unhealthy');
    expect(label).toContain('depends on c2');
    expect(label).toContain('depended on by blocked, c2');
    expect(label).toContain('dependency cycle');
  });

  it('graph summary narrates counts, start order, cycles, and blocked apps', () => {
    const s = graphSummary(VIEW);
    expect(s).toContain('6 apps');
    expect(s).toContain('level 1: db');
    expect(s).toContain('cycle');
    expect(s).toContain('blocked');
  });

  it('empty views narrate emptiness rather than rendering silence', () => {
    const empty = { ...VIEW, nodes: [], edges: [], levels: [], cycles: [], unordered: [] };
    expect(graphSummary({ ...empty, workspace: 'beta' })).toContain('beta');
  });
});

describe('keyboard navigation', () => {
  const layout = layoutGraph(VIEW);

  it('left goes to a dependency, right to a dependent', () => {
    expect(arrowTarget(layout, 'api', 'ArrowLeft')).toBe('db');
    expect(arrowTarget(layout, 'api', 'ArrowRight')).toBe('web');
    expect(arrowTarget(layout, 'db', 'ArrowLeft')).toBeNull();
    expect(arrowTarget(layout, 'web', 'ArrowRight')).toBeNull();
  });

  it('up/down walk the column', () => {
    expect(arrowTarget(layout, 'c1', 'ArrowDown')).toBe('c2');
    expect(arrowTarget(layout, 'c2', 'ArrowUp')).toBe('c1');
    expect(arrowTarget(layout, 'c1', 'ArrowUp')).toBeNull();
  });
});

describe('start-order preview (M176)', () => {
  it('formats the exact plan levels, cycle skips named', () => {
    expect(formatUpPreview(VIEW.groups[0])).toBe('will start — level 1: db · level 2: api · level 3: web');
    expect(formatUpPreview({ name: 'x', apps: [], levels: [], cyclic: [], unknown: [] })).toBe('nothing to start');
    expect(formatUpPreview({ name: 'x', apps: ['a', 'c1'], levels: [['a']], cyclic: ['c1'], unknown: ['ghost'] }))
      .toBe('will start — level 1: a · in cycle (skipped): c1 · unknown: ghost');
  });

  it('cycleLabel closes the walk', () => {
    expect(cycleLabel(['c1', 'c2'])).toBe('c1 → c2 → c1');
  });
});
