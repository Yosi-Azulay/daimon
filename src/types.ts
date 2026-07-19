// 'orphaned' (M88, additive): a child that survived a daemon handoff but could
// not be verified (pid+port) for re-adoption. Reported, never blindly killed.
export type AppStatus = 'stopped' | 'starting' | 'compiling' | 'serving' | 'error' | 'orphaned';
export type AppHealth = 'unknown' | 'healthy' | 'unhealthy';

export interface AutoRestartConfig {
  enabled: boolean;
  maxAttempts: number;
  windowMs: number;
}

export interface HealthProbeConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  path: string;
  host?: string | null;
  scheme?: 'http' | 'https' | null;
  rejectUnauthorized?: boolean;
  fallbackHosts?: string[];
}

export interface HistoryConfig {
  enabled: boolean;
  path: string;
  retentionDays: number;
}

export interface NotificationsConfig {
  enabled: boolean;
  onError: boolean;
  onUnhealthy: boolean;
  tray: boolean;
  // M84 polish — all optional; every field absent = pre-v0.13 behavior.
  // Only these notification kinds fire (default: the current set).
  kinds?: string[];
  // "22:00-08:00": OS notifications suppressed in the window (events/webhooks
  // unaffected); one summary fires when the window ends.
  quietHours?: string | null;
  // Same-fingerprint error notifications within this window collapse to one
  // notification carrying a count.
  batchMs?: number;
}

export interface StaleDetectConfig {
  enabled: boolean;
  silentMs: number;
}

export interface RequestLogConfig {
  enabled: boolean;
  portOffset: number;
}

export interface MetricsConfig {
  enabled: boolean;
}

export interface EditorConfig {
  scheme: string;
}

export interface OutputConfig {
  format: 'compact' | 'full';
  ndjson: boolean;
}

export interface DoctorAutoFixConfig {
  onInit: boolean;
  permitted: string[];
}

export interface DoctorConfig {
  autoFix: DoctorAutoFixConfig;
}

export interface ErrorRetentionConfig {
  maxAgeMs: number;
}

export interface PluginsConfig {
  dir: string | null;
}

export interface WebhookEntry {
  url: string;
  events?: string[];
  headers?: Record<string, string>;
  filter?: { to?: string[]; from?: string[]; app?: string[] };
  // Per-app scoping (M72). Absent = all apps (pre-v0.11 behavior).
  apps?: string[];
  // Scheduled digest (M84): "HH:MM" local time — sends the daily report
  // (since the last digest) to this webhook via the normal delivery queue.
  digest?: string;
}

export interface SearchConfig {
  // Per-app log-line FTS indexing (M77). Errors/events are ALWAYS indexed;
  // this only gates log lines. Default true; overrides.<app>.logIndex wins.
  logIndex: boolean;
}

export interface RestartStormConfig {
  // Unrequested exits per hour before a single restart-storm event fires (M76).
  perHour: number;
}

export interface TestsConfig {
  // Pass↔fail flips at the same gitHead before a test is flagged flaky (M75).
  flakyThreshold: number;
  // Flaky quarantine (M130, v1.7 — experimental): glob-style patterns (`*`)
  // matched against a test's `suite > test` name. Quarantined tests still run
  // and still record; they're excluded from flaky detection + alert noise and
  // surfaced with their age. Absent = behavior unchanged. Optional.
  quarantine?: string[];
}

export interface PortsConfig {
  // Auto-assignment pool "4200-4299" (M81). Absent = no pool auto-assignment:
  // the legacy portRange allocator + blanket `--port` injection stay in force.
  // When set, only profiles that declare portFlag/portEnv participate.
  pool?: string | null;
}

// Resource awareness (v1.3 — experimental). All keys optional; an absent
// `resources` object = default-cadence sampling and no budget checks.
// Budgets WARN, NEVER KILL — crossing one raises a resource-budget-exceeded
// event with a remedy; no code path may touch the process (M108 grep suite).
export interface ResourcesConfig {
  // Sampling cadence for resource_samples in ms (M105). Absent = 30000;
  // 0 disables persistence entirely (live usage display unaffected).
  sampleMs?: number;
  // Warn-only budgets (M108): RSS in MB / CPU in percent, crossed for a
  // full window before one resource-budget-exceeded event fires. Absent
  // key = no check for that axis.
  rssMb?: number;
  cpuPct?: number;
}

// Named app group (M93). Raw config accepts `name: string[]` (the legacy
// profiles shorthand) or `name: { apps, autoStart? }`; both normalize to this
// shape at load. Groups are start units consumed by `up`/`stop <group>`,
// `--group` filters, and boot-time autoStart — they read the depends graph,
// never change it.
export interface GroupDef {
  apps: string[];
  autoStart: boolean;
}

export interface DashboardConfig {
  theme: 'auto' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
}

export interface LogsConfig {
  enabled: boolean;
  dir: string;
  maxFiles: number;
  maxBytesPerFile: number;
  // Log-storm tuning (M101, v1.2 — experimental). Optional with safe
  // defaults; absent = detection still runs with { multiplier: 10,
  // windowSec: 60 } and emits only the self-events (the OS-notification
  // kind is a separate opt-in via notifications.kinds).
  storm?: { multiplier?: number; windowSec?: number };
}

import type { FrameworkProfile } from './frameworks.js';

export interface AppmanConfig {
  searchRoots: (string | SearchRoot)[];
  portRange: [number, number];
  apiPort: number;
  overrides: Record<string, AppOverride>;
  autoStart: string[];
  profiles: Record<string, string[]>;
  tags: Record<string, string[]>;
  autoRestart: AutoRestartConfig;
  healthProbe: HealthProbeConfig;
  logs: LogsConfig;
  depends: Record<string, string[]>;
  cascadeRestart: boolean;
  history: HistoryConfig;
  notifications: NotificationsConfig;
  staleDetect: StaleDetectConfig;
  headless: boolean;
  envFiles: Record<string, string[]>;
  requestLog: RequestLogConfig;
  metrics: MetricsConfig;
  editor: EditorConfig;
  apiToken: string | null;
  output: OutputConfig;
  doctor: DoctorConfig;
  dashboard: DashboardConfig;
  errorRetention: ErrorRetentionConfig;
  plugins: PluginsConfig;
  webhooks: WebhookEntry[];
  // Custom framework profiles (M65) — validated data rows, never loaded code.
  frameworks: FrameworkProfile[];
  // Optional: absent in older configs/tests — consumers default per-field.
  tests?: TestsConfig;
  restartStorm?: RestartStormConfig;
  search?: SearchConfig;
  ports?: PortsConfig;
  // Named app groups (M93, v1.1) — normalized at load; absent = no groups.
  groups?: Record<string, GroupDef>;
  // Resource sampling + warn-only budgets (v1.3) — absent = v1.2 behavior
  // with default-cadence sampling.
  resources?: ResourcesConfig;
}

export interface SearchRoot {
  path: string;
  viteSubfolders?: boolean;
  label?: string;
}

export interface AppOverride {
  port?: number;
  command?: string;
  hidden?: boolean;
  env?: Record<string, string>;
  url?: string;
  healthProbePath?: string;
  // Compile-regression threshold as a multiple of the rolling median; default 2.0.
  compileRegressionFactor?: number;
  // Per-app webhooks (M72), merged with the global `webhooks` list and scoped
  // to this app's events.
  webhooks?: WebhookEntry[];
  // Explicit test command (M74) — always wins over registry testRunner hints.
  testCommand?: string;
  // Per-app opt-out of log-line FTS indexing (M77).
  logIndex?: boolean;
  // Per-app resource budgets (M108) — merged over the global `resources`
  // budgets key-by-key (override wins per key). sampleMs is global-only.
  resources?: { rssMb?: number; cpuPct?: number };
}

// Built-in profile ids. DiscoveredApp.serverProfile is a plain string because
// custom config profiles introduce ids outside this set.
export type ServerProfile =
  | 'angular' | 'nx' | 'vite' | 'storybook'
  | 'django' | 'rails' | 'fastapi' | 'go-air' | 'rust-trunk';

export interface DiscoveredApp {
  // Storage key — globally unique across the daemon. Equals baseName when no
  // collision; otherwise discovery appends `@<workspaceLabel>` (or a numeric
  // suffix) to keep the registry's Map keys unique. This is what events,
  // history rows, and registry methods use internally.
  name: string;
  // What the user typed in package.json / project.json / their workspace.
  // Two workspaces can share the same baseName ("editor", "web"). The CLI/MCP
  // resolves a baseName + cwd back to a single `name` via Registry.resolveByCwd.
  baseName?: string;
  workspaceRoot: string;
  workspaceType: 'nx' | 'angular' | 'vite' | 'storybook' | 'polyglot';
  command: string;
  hidden: boolean;
  pinnedPort?: number;
  env?: Record<string, string>;
  tags: string[];
  tasks?: string[];
  workspaceLabel?: string;
  serverProfile?: string;
}

export type ParserTool =
  | 'esbuild'
  | 'vite'
  | 'storybook'
  | 'jest'
  | 'nx'
  | 'webpack'
  | 'node'
  | 'typescript'
  | 'django'
  | 'rails'
  | 'fastapi'
  | 'go-air'
  | 'rust-trunk'
  | 'python'
  // Per-profile parser ids (M67), referenced from FrameworkProfile.errorParser.
  | 'python-traceback'
  | 'go-build'
  | 'rust-cargo'
  | 'dotnet'
  | 'jvm-gradle'
  | 'php';

export interface ParsedError {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  tool?: ParserTool;
}

export type IssueLevel = 'error' | 'warning' | 'lint';

export interface ErrorEntry {
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  parsed?: ParsedError;
  // Default 'error' when omitted (back-compat). 'warning' entries do NOT flip status to 'error'.
  level?: IssueLevel;
}

export interface LogEntry {
  ts: number;
  line: string;
  // Classified log level (M99), absent/null when classification found nothing
  // — additive: pre-v1.2 session snapshots round-trip without it.
  level?: import('./frameworks.js').LogLevel | null;
}

// Event-kind catalog with stability tiers (M87). This const is the single
// source of truth for which event kinds exist — AppEventType derives from it,
// build-docs renders it, and the contract suite pins the frozen kinds.
// Frozen kinds never disappear or change meaning; additive kinds start
// experimental. See STABILITY.md.
export const EVENT_KIND_STABILITY = {
  'status': 'frozen',
  'error-new': 'frozen',
  'error-recur': 'frozen',
  'health': 'frozen',
  'crash': 'stable',
  'warning-new': 'stable',
  'warning-recur': 'stable',
  'lint-new': 'stable',
  'lint-recur': 'stable',
  'restart-scheduled': 'stable',
  'stale': 'stable',
  'bundle-regression': 'stable',
  'compile-regression': 'stable',
  'regression-detected': 'stable',
  'task-run': 'stable',
  'test-run': 'stable',
  'test-failed': 'stable',
  'flaky-test-detected': 'stable',
  'restart-storm': 'stable',
  'self-warn': 'stable',
  'digest-sent': 'experimental', // v0.13 (M84)
  'log-storm': 'experimental', // v1.2 (M101)
  'log-storm-end': 'experimental', // v1.2 (M101)
  'resource-leak-suspect': 'experimental', // v1.3 (M107)
  'cpu-storm': 'experimental', // v1.3 (M108)
  'resource-budget-exceeded': 'experimental', // v1.3 (M108)
  'plugin-error': 'experimental', // v1.5 (M117)
  'daemon-start': 'experimental', // v1.8 (M134) — session boundary marker
  'daemon-stop': 'experimental', // v1.8 (M134) — session boundary marker
} as const satisfies Record<string, import('./stability.js').Stability>;

export type AppEventType = keyof typeof EVENT_KIND_STABILITY;

export interface AppEvent {
  ts: number;
  app: string;
  type: AppEventType;
  from?: string;
  to?: string;
  message?: string;
}

export interface BundleInfo {
  initialKB: number;
  lazyKB: number;
  files: { name: string; sizeKB: number }[];
}

export interface AppState {
  name: string;
  status: AppStatus;
  port: number | null;
  pid: number | null;
  startedAt: number | null;
  compileStartedAt: number | null;
  lastCompileMs: number | null;
  lastCompileAt: number | null;
  logBuffer: LogEntry[];
  errors: Map<string, ErrorEntry>;
  lastStatusMessage?: string;
  compileHistory: number[];
  health: AppHealth;
  lastHealthAt: number | null;
  cpu: number | null;
  memMB: number | null;
  restartAttempts: number;
  restartWindowStart: number | null;
  nextRestartAt: number | null;
  tags: string[];
  announcedUrl: string | null;
  lastHealthError: string | null;
  cachedProbeHost: string | null;
  lastLogTs: number | null;
  stale: boolean;
  bundle: BundleInfo | null;
  bundleRegressionPct: number | null;
  activeEnvFile: string | null;
  sessionOverrides: { command?: string; port?: number; env?: Record<string, string> } | null;
  dependsOn: string[];
  recoveringFromError?: boolean;
  workspaceLabel: string | null;
  workspaceRoot: string | null;
  baseName: string;
  lastErrorHash?: string | null;
  discoveredHealthPath?: string | null;
  // Re-adopted after a daemon handoff (M88): the child predates this daemon
  // process, so there is no AppProcess/stdio — pid+port only. stop() tree-kills
  // the pid; log capture resumes on the next restart.
  adopted?: boolean;
}

export interface AppSummary {
  name: string;
  status: AppStatus;
  port: number | null;
  url: string | null;
  errorCount: number;
  warningCount?: number;
  uptimeMs: number | null;
  lastCompileMs: number | null;
  health: AppHealth;
  lastHealthAt: number | null;
  cpu: number | null;
  memMB: number | null;
  compileHistoryMs: number[];
  tags: string[];
  restartAttempts: number;
  nextRestartAt: number | null;
  announcedUrl: string | null;
  lastHealthError: string | null;
  stale: boolean;
  bundle: BundleInfo | null;
  bundleRegressionPct: number | null;
  dependsOn: string[];
  activeEnvFile: string | null;
  workspaceLabel: string | null;
  workspaceRoot: string | null;
  baseName: string;
  lastChangeMs?: number;
  lintCount?: number;
  // ms-since-epoch when the app is *projected* to reach `serving`, computed
  // from the p50 of the last 10 successful compile times. Only populated when
  // status === 'compiling'. Use with `Date.now()` to render countdowns.
  estimatedReadyAtMs?: number;
  // Framework registry profile id ('nextjs', 'django', custom id, ...) —
  // drives the dashboard/TUI badge + tone (M70).
  serverProfile?: string | null;
  // Notification mute (M84): true while muted; muteUntil null = indefinite.
  muted?: boolean;
  muteUntil?: number | null;
  // Log-storm marker (M101, v1.2 — experimental): present only while the app
  // is storming (lines/min vs its own rolling baseline; see logStorm.ts).
  logStorm?: { since: number | null; observedPerMin: number; baselinePerMin: number | null };
}
