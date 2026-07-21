// The dashboard's information architecture (M156, v1.12) — the ONE source of
// truth for how routes are grouped and how a URL maps back to its
// nav context. Both nav-rail.ts (the grouped rail) and topbar.ts (the
// active-context breadcrumb) consume this, so the rail and the breadcrumb can
// never drift from each other. Pure data + a pure resolver so the mapping is
// unit-tested in nav-model.spec.ts without booting Angular.
//
// Grouping is by TASK, not by ship order (the pre-v1.12 rail listed features
// in the order they were built): observe = what's happening now, investigate
// = dig into the past, configure = change the setup.

export interface NavEntry {
  /** Router path this entry links to. */
  path: string;
  /** Material Symbols icon name. */
  icon: string;
  /** Rail label. */
  label: string;
  /** `g <key>` chord that also reaches this page (documented in the help). */
  shortcut: string;
}

export interface NavGroup {
  /** Rendered as a rail section header (expanded rail only). */
  label: string;
  entries: NavEntry[];
}

// Order within each group is deliberate and stable — the redirect/keyboard
// suites and the shortcuts-help table mirror it.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Observe',
    entries: [
      { path: '/apps',     icon: 'apps',                 label: 'Apps',     shortcut: 'g a' },
      { path: '/events',   icon: 'timeline',             label: 'Events',   shortcut: 'g v' },
      { path: '/logs',     icon: 'terminal',             label: 'Logs',     shortcut: 'g l' },
      { path: '/timeline', icon: 'view_timeline',        label: 'Timeline', shortcut: 'g i' },
      { path: '/graph',    icon: 'account_tree',         label: 'Graph',    shortcut: 'g y' },
      { path: '/sessions', icon: 'radio_button_checked', label: 'Sessions', shortcut: 'g n' },
    ],
  },
  {
    label: 'Investigate',
    entries: [
      { path: '/errors',      icon: 'error',          label: 'Errors',      shortcut: 'g e' },
      { path: '/history',     icon: 'query_stats',    label: 'History',     shortcut: 'g h' },
      { path: '/trends',      icon: 'show_chart',     label: 'Trends',      shortcut: 'g t' },
      { path: '/tests',       icon: 'science',        label: 'Tests',       shortcut: 'g x' },
      { path: '/regressions', icon: 'trending_down',  label: 'Regressions', shortcut: 'g r' },
      { path: '/report',      icon: 'summarize',      label: 'Report',      shortcut: 'g p' },
      { path: '/agents',      icon: 'badge',          label: 'Agents',      shortcut: 'g g' },
    ],
  },
  {
    label: 'Configure',
    entries: [
      { path: '/config', icon: 'tune',             label: 'Settings', shortcut: 'g s' },
      { path: '/doctor', icon: 'medical_services', label: 'Doctor',   shortcut: 'g d' },
    ],
  },
];

// Flat list in rail order, for consumers that don't care about the grouping.
export const NAV_ENTRIES: NavEntry[] = NAV_GROUPS.flatMap(g => g.entries);

export interface NavContext {
  /** Group the current page belongs to ('Observe' / 'Investigate' / 'Configure'), or null for the home overview. */
  group: string | null;
  /** Human page name ('Apps', 'Errors', 'Overview', …). */
  page: string;
  /** Present only on a per-entity detail route: the app/session/etc. name. */
  detail?: string;
}

// Detail routes that aren't first-class nav entries but still need a
// breadcrumb — mapped to the group + page they belong under. The `:param`
// segment becomes NavContext.detail.
const DETAIL_ROUTES: { prefix: string; group: string | null; page: string }[] = [
  { prefix: '/apps/',     group: 'Observe',     page: 'Apps' },
  { prefix: '/logs/',     group: 'Observe',     page: 'Logs' },
  { prefix: '/history/',  group: 'Investigate', page: 'History' },
  { prefix: '/requests/', group: 'Investigate', page: 'Requests' },
];

// Resolve a URL (path, optionally with query/fragment) to its nav context.
// Home ('/') is the overview — group null, page 'Overview'. Unknown paths
// return null (the caller renders nothing rather than a wrong crumb).
export function contextForUrl(url: string): NavContext | null {
  // Strip query + fragment; normalize trailing slash (but keep the root '/').
  const path = (url.split('?')[0].split('#')[0] || '/').replace(/(.)\/+$/, '$1');

  if (path === '/' || path === '') return { group: null, page: 'Overview' };

  for (const d of DETAIL_ROUTES) {
    if (path.startsWith(d.prefix) && path.length > d.prefix.length) {
      const detail = decodeURIComponent(path.slice(d.prefix.length).split('/')[0]);
      return { group: d.group, page: d.page, detail };
    }
  }

  for (const g of NAV_GROUPS) {
    for (const e of g.entries) {
      if (path === e.path) return { group: g.label, page: e.label };
    }
  }
  return null;
}
