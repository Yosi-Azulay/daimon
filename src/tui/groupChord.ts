// Pure logic for the TUI `G` group-filter chord (M97): cycling through
// configured groups, filtering the app list to a group's members, and the
// header health line are all side-effect-free so they can be unit tested
// without ink or a real terminal — same pattern as testChord.ts / ribbon.ts.

export const GROUP_CHORD_KEY = 'G';
export const GROUP_CHORD_HELP = '[G] group filter';

// none -> groupNames[0] -> ... -> groupNames[last] -> none, in config order.
// An empty `groupNames` list makes every press a no-op (stays null) — the
// chord is inert when no groups are configured.
export function cycleGroupFilter(groupNames: string[], current: string | null): string | null {
  if (groupNames.length === 0) return null;
  if (current === null) return groupNames[0];
  const idx = groupNames.indexOf(current);
  // Unknown current (e.g. config reloaded and the active group vanished)
  // resets to none rather than guessing a position.
  if (idx === -1) return null;
  return idx + 1 < groupNames.length ? groupNames[idx + 1] : null;
}

export interface GroupMemberLike {
  name: string;
  baseName: string;
}

// Match an app against a group's declared member list by name or baseName —
// baseName lets a workspace-suffixed instance still match a group written
// with the app's short name.
export function appMatchesGroup(app: GroupMemberLike, members: string[]): boolean {
  return members.includes(app.name) || members.includes(app.baseName);
}

// `members === null` means no group filter is active (pass apps through
// unchanged). `members === []` (a configured-but-empty or stale group)
// filters everything out — that's correct: the group has no members.
export function filterByGroup<T extends GroupMemberLike>(apps: T[], members: string[] | null): T[] {
  if (members === null) return apps;
  return apps.filter(a => appMatchesGroup(a, members));
}

export interface GroupHealthLike {
  status: string;
  health: string;
}

// healthy/total semantics match GET /api/groups: total = declared member
// count, healthy = members currently serving AND health healthy. A member
// not found among `apps` simply doesn't count toward healthy (parity with
// the server treating an unresolvable member as status 'unknown').
export function computeGroupHealth<T extends GroupMemberLike & GroupHealthLike>(
  apps: T[],
  members: string[],
): { healthy: number; total: number } {
  let healthy = 0;
  for (const m of members) {
    const a = apps.find(x => x.name === m || x.baseName === m);
    if (a && a.status === 'serving' && a.health === 'healthy') healthy++;
  }
  return { healthy, total: members.length };
}

export function formatGroupHeader(name: string, healthy: number, total: number): string {
  return `group: ${name} · ${healthy}/${total} healthy`;
}
