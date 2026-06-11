export type AppStatus = 'stopped' | 'starting' | 'compiling' | 'serving' | 'error';
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
}

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
  serverProfile?: ServerProfile;
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
  | 'python';

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

export type AppEventType =
  | 'status'
  | 'error-new'
  | 'error-recur'
  | 'warning-new'
  | 'warning-recur'
  | 'lint-new'
  | 'lint-recur'
  | 'health'
  | 'restart-scheduled'
  | 'stale'
  | 'bundle-regression'
  | 'compile-regression'
  | 'regression-detected'
  | 'task-run'
  | 'self-warn';

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
}
