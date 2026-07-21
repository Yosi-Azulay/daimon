// Route audit map (M156, v1.12) — the checked-in inventory of EVERY URL shape
// the dashboard has ever exposed. Deep-link back-compat is a hard rule: each
// of these must keep resolving to a rendered page forever (a redirect is fine,
// a 404 never is). redirects.spec.ts drives this list and asserts each entry
// lands on its expected pathname with real content, so a route rename that
// forgets a redirect fails the suite.
//
// A plain data module (no test() calls) so importing it never registers stray
// Playwright tests, same discipline as routes.ts.

export interface AuditRoute {
  /** URL to visit. `:name` is substituted with a real registered app at drive time. */
  url: string;
  /**
   * The pathname the URL must resolve to. Defaults to the url's own pathname.
   * A different value means a redirect is expected (a moved route). Query and
   * fragment are preserved by Angular but not asserted here — only the
   * pathname decides whether a URL still resolves vs. fell through to `**`.
   */
  resolvesTo?: string;
  /** Requires a real app name; the spec substitutes `:name` and skips if the workspace has none. */
  needsApp?: boolean;
  /** Why this shape exists / where it came from. */
  note: string;
}

// `:name` placeholder — replaced with a discovered app at drive time.
const APP = ':name';

export const AUDIT_ROUTES: AuditRoute[] = [
  // ── Static top-level routes (each resolves to itself) ───────────────────
  { url: '/', note: 'Overview home (was the apps list pre-v1.12; still resolves)' },
  { url: '/apps', note: 'Canonical apps list (v1.12)' },
  { url: '/events', note: 'Events feed' },
  { url: '/logs', note: 'Logs page (no app selected)' },
  { url: '/errors', note: 'Errors panel' },
  { url: '/doctor', note: 'Doctor' },
  { url: '/config', note: 'Settings / config editor' },
  { url: '/history', note: 'History' },
  { url: '/trends', note: 'Trends' },
  { url: '/timeline', note: 'Timeline' },
  { url: '/tests', note: 'Tests' },
  { url: '/sessions', note: 'Sessions' },
  { url: '/graph', note: 'Depends-graph view (v1.15)' },
  { url: '/agents', note: 'Agents' },
  { url: '/regressions', note: 'Regressions' },
  { url: '/report', note: 'Report' },

  // ── Per-entity detail routes ────────────────────────────────────────────
  { url: `/apps/${APP}`, needsApp: true, note: 'App detail' },
  { url: `/logs/${APP}`, needsApp: true, note: 'Per-app logs' },
  { url: `/history/${APP}`, needsApp: true, note: 'Per-app history' },
  { url: `/requests/${APP}`, needsApp: true, note: 'Per-app request log' },

  // ── v0.13 search / why deep-links (must survive) ────────────────────────
  { url: `/apps/${APP}?tab=errors`, resolvesTo: `/apps/${APP}`, needsApp: true, note: 'search-hit → errors tab (v0.13); maps to #errors section since M159' },
  { url: `/apps/${APP}?tab=logs`, resolvesTo: `/apps/${APP}`, needsApp: true, note: 'why/tab deep-link → logs' },
  { url: `/apps/${APP}?tab=history`, resolvesTo: `/apps/${APP}`, needsApp: true, note: 'tab deep-link → history/timeline section' },
  { url: `/apps/${APP}?tab=env`, resolvesTo: `/apps/${APP}`, needsApp: true, note: 'tab deep-link → env (overview) section' },
  { url: `/apps/${APP}?tab=why`, resolvesTo: `/apps/${APP}`, needsApp: true, note: 'tab deep-link → why section' },
  { url: `/logs/${APP}?from=search`, resolvesTo: `/logs/${APP}`, needsApp: true, note: 'M102 search deep-link (clears active log filter)' },

  // ── v1.8 timeline query deep-links (must survive) ───────────────────────
  { url: '/timeline?ts=1700000000000&app=x&kind=start&session=s-1', resolvesTo: '/timeline', note: 'M137 timeline deep-link (ts/app/kind/session)' },
  { url: '/timeline?session=s-1', resolvesTo: '/timeline', note: 'M136 session deep-link into the timeline' },
  { url: '/timeline?at=1700000000000&app=x', resolvesTo: '/timeline', note: 'M85 event search-hit deep-link (at/app)' },

  // ── Home query params (must survive) ────────────────────────────────────
  { url: '/?group=web', resolvesTo: '/', note: 'M97 group chip filter (now the overview scope; still resolves)' },
  { url: '/?cwd=/tmp/x', resolvesTo: '/', note: 'cwd auto-pick deep-link' },

  // ── Catch-all: an unknown URL lands home, never 404 ─────────────────────
  { url: '/this-route-does-not-exist', resolvesTo: '/', note: '** catch-all → home' },
];
