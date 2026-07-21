// Pure helpers for the workspace switcher + per-page filtering (M173/M177,
// v1.15 "Atlas"). The EFFECTIVE-label rule matches the daemon's src/graph.ts:
// a labeled searchRoot keeps its label; an unlabeled one is called by its
// folder basename — so a label-free config still gets a usable switcher, and
// "the workspace I'm in" means the same thing on every surface.
//
// The active workspace itself is CLIENT-SIDE state (localStorage
// `daimon.workspace` + the `daimon:workspace` CustomEvent bus) — never a
// daemon-global; two browsers may watch two different workspaces at once.

export function baseName(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

export function effectiveLabel(
  label: string | null | undefined,
  path: string | null | undefined,
): string | null {
  return label || baseName(path);
}

// The switcher list: configured searchRoots first (config order, effective
// labels, deduped), then any label seen on a live app (belt-and-braces for a
// daemon where the /api/workspaces fetch failed).
export function workspaceOptionsFrom(
  rows: { path: string; label: string | null }[],
  apps: { workspaceLabel: string | null; workspaceRoot?: string | null }[],
): string[] {
  const out: string[] = [];
  const push = (l: string | null) => { if (l && !out.includes(l)) out.push(l); };
  for (const w of rows) push(effectiveLabel(w.label, w.path));
  for (const a of apps) push(effectiveLabel(a.workspaceLabel, a.workspaceRoot ?? null));
  return out;
}

// `ws === null` = no filter (pass through) — the one predicate every page
// uses, so no page can invent its own matching rule.
export function appMatchesWorkspace(
  app: { workspaceLabel: string | null; workspaceRoot?: string | null },
  ws: string | null,
): boolean {
  if (ws === null) return true;
  return effectiveLabel(app.workspaceLabel, app.workspaceRoot ?? null) === ws;
}

export function filterAppsByWorkspace<T extends { workspaceLabel: string | null; workspaceRoot?: string | null }>(
  apps: T[],
  ws: string | null,
): T[] {
  if (ws === null) return apps;
  return apps.filter(a => appMatchesWorkspace(a, ws));
}

// Shared membership derivation (M177, v1.15) for rows that carry an app NAME
// but no workspaceLabel of their own — test runs, timeline events, needs-
// attention rows — so those pages cross-reference the live app registry
// instead of inventing their own name-matching. `null` means "no filter
// active"; callers skip filtering entirely rather than allocating a Set that
// would match everything.
export function workspaceMemberNames(
  apps: { name: string; workspaceLabel: string | null; workspaceRoot?: string | null }[],
  ws: string | null,
): Set<string> | null {
  if (ws === null) return null;
  return new Set(filterAppsByWorkspace(apps, ws).map(a => a.name));
}
