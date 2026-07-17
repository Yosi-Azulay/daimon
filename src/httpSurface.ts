import type { Stability } from './stability.js';

// HTTP surface catalog (M87). One row per route handled in server.ts, with its
// stability tier. server.ts's parts[] switch remains the dispatch; this table
// is the *inventory* — build-docs renders it and test/contract.test.mjs pins a
// golden shape for every `frozen` row (a frozen row without a snapshot fails
// the suite). NOTE: catalog↔dispatch sync for stable/experimental rows is a
// review-time obligation, not machine-checked — when you add a route in
// server.ts, add its row here in the same commit or the docs silently
// under-report the surface. (Frozen rows ARE machine-checked via their
// snapshots.)
//
// Path placeholders: `:name` (app), `:profile`, `:task`.
export interface HttpEndpoint {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  stability: Stability;
  summary: string;
}

export const HTTP_ENDPOINTS: HttpEndpoint[] = [
  // ── frozen: the core agent loop ────────────────────────────────────────────
  { method: 'GET', path: '/api/apps', stability: 'frozen', summary: 'List apps (?format=compact|full, ?stream=ndjson, ?explain=1, ?cwd=, ?tag=, ?workspace=, ?group= — v1.1, experimental param).' },
  { method: 'GET', path: '/api/apps/:name', stability: 'frozen', summary: 'One app status (?format=compact|full).' },
  { method: 'GET', path: '/api/apps/:name/errors', stability: 'frozen', summary: 'Deduplicated errors (?since=, ?level=, ?format=).' },
  { method: 'GET', path: '/api/apps/:name/errors/since-last', stability: 'frozen', summary: 'Errors since the previous call for ?client= cursor.' },
  { method: 'GET', path: '/api/apps/:name/logs', stability: 'frozen', summary: 'Recent log lines (?tail=, ?since=, ?grep=, ?level= — v1.2, experimental param).' },
  { method: 'GET', path: '/api/apps/:name/logs/stream', stability: 'frozen', summary: 'Live log tail (SSE; ?grep= filters server-side; ?level= filter and ?levels=1 per-line level field — v1.2, experimental params).' },
  { method: 'POST', path: '/api/apps/:name/start', stability: 'frozen', summary: 'Start an app (?withDeps=1, ?steal=1). Soft-lock gated.' },
  { method: 'POST', path: '/api/apps/:name/stop', stability: 'frozen', summary: 'Stop an app (?steal=1). Soft-lock gated.' },
  { method: 'POST', path: '/api/apps/:name/restart', stability: 'frozen', summary: 'Restart an app (?steal=1). Soft-lock gated.' },
  { method: 'GET', path: '/api/apps/:name/wait', stability: 'frozen', summary: 'Block until target state (?until=, ?timeout=<s>|?timeoutMs=).' },
  { method: 'GET', path: '/api/events', stability: 'frozen', summary: 'Event log (?since=, ?app=, ?stream=ndjson, ?waitMs= long-poll).' },
  { method: 'GET', path: '/api/config', stability: 'frozen', summary: 'Active config (redacted) + etag.' },
  { method: 'GET', path: '/api/signature', stability: 'frozen', summary: 'Daimon identification: { daimon, version, pid, startedAt }. Frozen despite its v0.13 birth: cross-version port forensics and the v0.14 CLI/daemon skew check both depend on every future daimon answering this exact shape.' },
  { method: 'POST', path: '/api/shutdown', stability: 'frozen', summary: 'Graceful daemon shutdown.' },

  // ── stable: v0.4–v0.12 surfaces ────────────────────────────────────────────
  { method: 'PATCH', path: '/api/config', stability: 'stable', summary: 'Config patch with If-Match etag gating.' },
  { method: 'POST', path: '/api/config/reload', stability: 'stable', summary: 'Re-read config from disk.' },
  { method: 'GET', path: '/api/overview', stability: 'stable', summary: 'Decision-ready snapshot (?workspace=, ?profile=, ?budget=).' },
  { method: 'POST', path: '/api/apps/:name/ensure', stability: 'stable', summary: 'Idempotent start+wait (?until=, ?timeoutMs=).' },
  { method: 'POST', path: '/api/apps/:name/focus', stability: 'stable', summary: 'Subscribe-then-act NDJSON stream (?until=, ?timeoutMs=).' },
  { method: 'POST', path: '/api/apps/:name/try-fix', stability: 'stable', summary: 'Auto-fix + restart + wait composite.' },
  { method: 'POST', path: '/api/apps/:name/test', stability: 'stable', summary: 'Run the app\'s own test suite once (?timeoutMs=, ?steal=1).' },
  { method: 'GET', path: '/api/apps/:name/lock', stability: 'stable', summary: 'Soft-lock holder + recent agent interactions.' },
  { method: 'POST', path: '/api/apps/:name/handoff', stability: 'stable', summary: 'Transfer the soft-lock ({ to }).' },
  { method: 'POST', path: '/api/apps/:name/start-with-deps', stability: 'stable', summary: 'Start with declared deps (alias of /start?withDeps=1).' },
  { method: 'GET', path: '/api/apps/:name/tasks', stability: 'stable', summary: 'Discovered non-serve tasks.' },
  { method: 'POST', path: '/api/apps/:name/run/:task', stability: 'stable', summary: 'Run a discovered task ({ args, watch }).' },
  { method: 'POST', path: '/api/apps/:name/run-stop/:task', stability: 'stable', summary: 'Stop a watch task.' },
  { method: 'GET', path: '/api/apps/:name/env', stability: 'stable', summary: 'Legacy env-file activation state ({ candidates, active }).' },
  { method: 'POST', path: '/api/apps/:name/env', stability: 'stable', summary: 'Activate an env file for injection ({ use }).' },
  { method: 'GET', path: '/api/apps/:name/requests', stability: 'stable', summary: 'Request-log rows when requestLog is enabled.' },
  { method: 'POST', path: '/api/apps/:name/clean', stability: 'stable', summary: 'Remove build artifacts (?deep=1, ?yes=1).' },
  { method: 'POST', path: '/api/apps/:name/snapshot', stability: 'stable', summary: 'Diagnostic snapshot (?write=1 persists).' },
  { method: 'POST', path: '/api/apps/:name/health/pin', stability: 'stable', summary: 'Persist a health-probe path override ({ path }).' },
  { method: 'POST', path: '/api/profiles/:profile/ensure-up', stability: 'stable', summary: 'Cascade-start a profile and wait (?until=, ?timeoutMs=).' },
  { method: 'GET', path: '/api/profiles/suggest', stability: 'stable', summary: 'Suggest profiles from recurring co-starts.' },
  { method: 'POST', path: '/api/orchestrate', stability: 'stable', summary: 'Whole-profile bring-up with one try-fix round (?profile=, ?goal=).' },
  { method: 'GET', path: '/api/errors', stability: 'stable', summary: 'All apps\' errors (?group=fingerprint to fold by stack fingerprint; any other ?group= value filters to that named group\'s members — v1.1, experimental; ?level=).' },
  { method: 'GET', path: '/api/context/:name', stability: 'stable', summary: 'Agent context pack (?budget= drops sections).' },
  { method: 'GET', path: '/api/search', stability: 'stable', summary: 'FTS over logs/errors/events (?q=, ?app=, ?since=, ?kind=, ?limit=).' },
  { method: 'GET', path: '/api/why/:name', stability: 'stable', summary: 'One-shot crash forensics composition.' },
  { method: 'GET', path: '/api/tests', stability: 'stable', summary: 'Recorded test runs (?app=, ?since=, ?limit=).' },
  { method: 'GET', path: '/api/tests/flaky', stability: 'stable', summary: 'Flaky tests derived from run history (?app=).' },
  { method: 'POST', path: '/api/doctor/auto-fix', stability: 'stable', summary: 'Run permitted auto-fix rules ({ permitted, dryRun }).' },
  { method: 'GET', path: '/api/history/events', stability: 'stable', summary: 'Persisted events (?app=, ?since=, ?until=, ?type=, ?limit=).' },
  { method: 'GET', path: '/api/history/compile-times', stability: 'stable', summary: 'Compile durations.' },
  { method: 'GET', path: '/api/history/tasks', stability: 'stable', summary: 'Task runs.' },
  { method: 'GET', path: '/api/history/timeline', stability: 'stable', summary: 'Unified chronological timeline (?kinds=).' },
  { method: 'GET', path: '/api/history/bundles', stability: 'stable', summary: 'Bundle-size rows.' },
  { method: 'GET', path: '/api/history/trends', stability: 'stable', summary: 'Bucketed trends (?metric=|?metrics=, ?since=24h|7d|30d).' },
  { method: 'GET', path: '/api/history/summary/:name', stability: 'stable', summary: 'Summary metrics for one app.' },
  { method: 'GET', path: '/api/history/why/:name', stability: 'stable', summary: 'History-derived why summary (predates /api/why).' },
  { method: 'GET', path: '/api/workspaces', stability: 'stable', summary: 'Registered searchRoots with app counts.' },
  { method: 'GET', path: '/api/workspaces/resolve', stability: 'stable', summary: 'Which workspace covers ?cwd=.' },
  { method: 'POST', path: '/api/workspaces/ensure', stability: 'stable', summary: 'Register a path as a searchRoot ({ path, label }).' },
  { method: 'POST', path: '/api/workspaces/remove', stability: 'stable', summary: 'Remove a searchRoot ({ path }).' },
  { method: 'GET', path: '/api/discovery/explain', stability: 'stable', summary: 'Read-only discovery pass with per-folder stats.' },
  { method: 'GET', path: '/api/frameworks', stability: 'stable', summary: 'Framework adapter registry + match counts.' },
  { method: 'GET', path: '/api/agents', stability: 'stable', summary: 'Active agents + per-app soft-locks.' },
  { method: 'GET', path: '/api/self', stability: 'stable', summary: 'Daemon self-metrics snapshot.' },
  { method: 'GET', path: '/api/self/history', stability: 'stable', summary: 'Persisted self-metrics rows.' },
  { method: 'GET', path: '/api/presets', stability: 'stable', summary: 'Built-in config presets.' },
  { method: 'GET', path: '/api/plugins', stability: 'stable', summary: 'Installed doctor plug-ins.' },
  { method: 'POST', path: '/api/plugins/scan', stability: 'stable', summary: 'Run plug-in scans now.' },
  { method: 'POST', path: '/api/session/record', stability: 'stable', summary: 'Toggle session recording (?action=start|stop|toggle).' },
  { method: 'GET', path: '/api/session/status', stability: 'stable', summary: 'Session recording state.' },
  { method: 'POST', path: '/api/snapshot-state', stability: 'stable', summary: 'Write the daemon-handoff state file.' },
  { method: 'GET', path: '/metrics', stability: 'stable', summary: 'Prometheus text export (when metrics.enabled).' },

  // ── experimental: v0.13 surfaces — may change in any release ──────────────
  { method: 'GET', path: '/api/report', stability: 'experimental', summary: 'The digest (?since=, ?app=, ?workspace=, ?group= — v1.1, ?md=1).' },
  { method: 'GET', path: '/api/env/:name', stability: 'experimental', summary: 'Redacted env awareness (names only, never values).' },
  { method: 'GET', path: '/api/env/:name/diff', stability: 'experimental', summary: 'Env snapshot diff (?from=, ?to=).' },
  { method: 'GET', path: '/api/ports', stability: 'experimental', summary: 'Port map + foreign holders.' },
  { method: 'GET', path: '/api/top', stability: 'experimental', summary: 'Live resource table: app → pid → rssMB → cpu → uptimeMs, RSS-sorted; nulls for apps without a reading (v1.3).' },
  { method: 'POST', path: '/api/apps/:name/mute', stability: 'experimental', summary: 'Mute OS notifications ({ forMs }).' },

  // ── experimental: v1.1 groups (M93–M95) ───────────────────────────────────
  { method: 'GET', path: '/api/groups', stability: 'experimental', summary: 'Named app groups: name → { apps, autoStart, statusCounts, healthy, total }.' },
  { method: 'POST', path: '/api/groups/:name/up', stability: 'experimental', summary: 'Start a group: members ∪ depends closure in topo order; readiness summary (?until=, ?timeoutMs=, ?steal=1). Soft-lock gated per member.' },
  { method: 'POST', path: '/api/groups/:name/stop', stability: 'experimental', summary: 'Stop a group\'s members in reverse depends order (?steal=1). Soft-lock gated per member.' },
  { method: 'GET', path: '/api/groups/:name/status', stability: 'experimental', summary: 'Per-member compact statuses + "3/4 healthy" summary.' },
  { method: 'GET', path: '/api/groups/:name/logs', stability: 'experimental', summary: 'Timestamp-merged log tail across members, each line carrying its app (?tail=, ?since=, ?grep=, ?level=).' },
  { method: 'POST', path: '/api/apps/:name/unmute', stability: 'experimental', summary: 'Lift a notification mute.' },
];
