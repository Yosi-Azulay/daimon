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
}

export interface PortsConfig {
  // Auto-assignment pool "4200-4299" (M81). Absent = no pool auto-assignment:
  // the legacy portRange allocator + blanket `--port` injection stay in force.
  // When set, only profiles that declare portFlag/portEnv participate.
  pool?: string | null;
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
}
