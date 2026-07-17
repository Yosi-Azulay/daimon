// Pure helpers for named app groups (M97 dashboard drive), extracted so
// they're unit-testable under Vitest without spinning up the Angular
// runtime. Mirrors GET /api/groups's response shape (M93): a group is a
// name -> { apps, autoStart, statusCounts, healthy, total } row. Group
// membership itself comes from the daemon's config (opt-in), so every
// function here degrades to "no groups" on an empty/missing map rather than
// throwing -- a pre-v1.1 daemon returns 404, which the caller (DaimonApi)
// already turns into `{}` before any of this ever runs.

export interface GroupInfo {
  apps: string[];
  autoStart: boolean;
  statusCounts: Record<string, number>;
  healthy: number;
  total: number;
}

export interface GroupChip {
  name: string;
  healthy: number;
  total: number;
}

interface NamedApp {
  name: string;
  baseName?: string | null;
}

// Chip list in config order (the object's own key order, which the server
// preserves from daimon.config.json's 'groups' map) -- never sorted.
export function groupChips(groups: Record<string, GroupInfo>): GroupChip[] {
  return Object.entries(groups).map(([name, g]) => ({ name, healthy: g.healthy, total: g.total }));
}

// A group's member list names apps by their daimon.config.json name, which
// may be either the app's live `name` or, for a spawned/instance app, its
// `baseName`.
export function appMatchesGroup(app: NamedApp, members: string[]): boolean {
  return members.includes(app.name) || (!!app.baseName && members.includes(app.baseName));
}

// Restricts `apps` to one group's members. Falls through to the full list
// when `groupName` is null (no filter active) or names a group that no
// longer exists (config changed out from under a stale deep-link).
export function filterByGroup<T extends NamedApp>(apps: T[], groupName: string | null, groups: Record<string, GroupInfo>): T[] {
  if (!groupName) return apps;
  const g = groups[groupName];
  if (!g) return apps;
  return apps.filter(a => appMatchesGroup(a, g.apps));
}

export interface GroupSection<T> {
  // null = the trailing "ungrouped" section.
  name: string | null;
  apps: T[];
}

// Splits `apps` into one section per configured group (config order,
// members in the group's own app-list order) plus a trailing ungrouped
// section for apps that matched nothing. An app in several groups appears
// in each of their sections. Returns [] when there are no groups at all --
// callers use that to fall back to the flat (non-sectioned) list.
export function groupSections<T extends NamedApp>(apps: T[], groups: Record<string, GroupInfo>): GroupSection<T>[] {
  const groupNames = Object.keys(groups);
  if (!groupNames.length) return [];

  const sections: GroupSection<T>[] = [];
  const grouped = new Set<string>();

  for (const [gname, g] of Object.entries(groups)) {
    const members: T[] = [];
    for (const memberName of g.apps) {
      for (const a of apps) {
        if (a.name === memberName || a.baseName === memberName) members.push(a);
      }
    }
    for (const m of members) grouped.add(m.name);
    sections.push({ name: gname, apps: members });
  }

  const ungrouped = apps.filter(a => !grouped.has(a.name));
  if (ungrouped.length) sections.push({ name: null, apps: ungrouped });

  return sections;
}

// Cumulative item counts before each section, for mapping a flat
// keyboard-nav focusedIndex onto per-section child-component indices.
export function sectionOffsets<T>(sections: GroupSection<T>[]): number[] {
  const out: number[] = [];
  let n = 0;
  for (const s of sections) {
    out.push(n);
    n += s.apps.length;
  }
  return out;
}

// Group names an app belongs to, in config order -- used by the app-detail
// "groups" row (empty = the row is omitted entirely).
export function groupsForApp(app: NamedApp, groups: Record<string, GroupInfo>): string[] {
  const out: string[] = [];
  for (const [gname, g] of Object.entries(groups)) {
    if (appMatchesGroup(app, g.apps)) out.push(gname);
  }
  return out;
}
