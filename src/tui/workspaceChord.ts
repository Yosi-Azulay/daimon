// Pure logic for the TUI `w` workspace-filter chord (M173, v1.15 "Atlas"):
// cycling through the configured workspaces and filtering the app list. Side-
// effect-free so it unit-tests without ink (the groupChord.ts pattern).
//
// The preference is CLIENT-SIDE BY DESIGN (v1.15 locked rule): it lives in the
// TUI process's own React state and nowhere else — never persisted, never sent
// to the daemon. Two TUIs watching the same daemon may hold two different
// workspace filters at once (test/tui-workspace-chord.test.mjs greps this file
// for persistence APIs).

import type { AppmanConfig } from '../types.js';
import { effectiveWorkspaceLabel, workspaceLabels } from '../graph.js';

export const WORKSPACE_CHORD_KEY = 'w';

// The cycle order: none -> each configured workspace (config order, effective
// labels — a label-free searchRoot shows as its basename) -> none. An empty
// searchRoots list makes every press a no-op.
export function workspaceCycle(config: Pick<AppmanConfig, 'searchRoots'>): string[] {
  return workspaceLabels(config);
}

export function cycleWorkspaceFilter(labels: string[], current: string | null): string | null {
  if (labels.length === 0) return null;
  if (current === null) return labels[0];
  const idx = labels.indexOf(current);
  // Unknown current (config reloaded, root removed) resets to none.
  if (idx === -1) return null;
  return idx + 1 < labels.length ? labels[idx + 1] : null;
}

export interface WorkspaceAppLike {
  workspaceLabel: string | null;
  workspaceRoot: string | null;
}

// `ws === null` means no workspace filter (pass through). Matching uses the
// effective label (label ?? basename(root)) — the same rule /api/graph and the
// dashboard switcher use, so "the workspace I'm in" means one thing everywhere.
export function filterByWorkspace<T extends WorkspaceAppLike>(apps: T[], ws: string | null): T[] {
  if (ws === null) return apps;
  return apps.filter(a => effectiveWorkspaceLabel(a.workspaceLabel, a.workspaceRoot) === ws);
}
