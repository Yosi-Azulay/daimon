export interface CycleError {
  cycle: string[];
}

export function findCycle(graph: Record<string, string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  let cycle: string[] | null = null;

  const visit = (n: string): void => {
    if (cycle) return;
    color.set(n, GRAY);
    for (const dep of graph[n] || []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const path: string[] = [dep, n];
        let cur: string | null | undefined = parent.get(n);
        while (cur && cur !== dep) {
          path.push(cur);
          cur = parent.get(cur);
        }
        if (cur === dep) path.push(dep);
        cycle = path.reverse();
        return;
      }
      if (c === WHITE) {
        parent.set(dep, n);
        visit(dep);
        if (cycle) return;
      }
    }
    color.set(n, BLACK);
  };

  for (const n of Object.keys(graph)) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      parent.set(n, null);
      visit(n);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function transitiveClosure(graph: Record<string, string[]>, root: string): string[] {
  const result = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (result.has(n)) continue;
    result.add(n);
    for (const d of graph[n] || []) stack.push(d);
  }
  return [...result];
}

export function topoLevels(graph: Record<string, string[]>, nodes: string[]): string[][] {
  const inSet = new Set(nodes);
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n, 0);
    adj.set(n, []);
  }
  for (const n of nodes) {
    for (const d of graph[n] || []) {
      if (!inSet.has(d)) continue;
      adj.get(d)!.push(n);
      indeg.set(n, (indeg.get(n) ?? 0) + 1);
    }
  }
  const levels: string[][] = [];
  let frontier = nodes.filter(n => (indeg.get(n) ?? 0) === 0);
  while (frontier.length) {
    levels.push([...frontier].sort());
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 1) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    }
    frontier = next;
  }
  return levels;
}

export function dependants(graph: Record<string, string[]>, target: string): string[] {
  const out: string[] = [];
  for (const [k, deps] of Object.entries(graph)) {
    if (deps.includes(target)) out.push(k);
  }
  return out;
}
