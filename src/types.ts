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
}

export interface SearchRoot {
  path: string;
  viteSubfolders?: boolean;
}

export interface AppOverride {
  port?: number;
  command?: string;
  hidden?: boolean;
  env?: Record<string, string>;
  url?: string;
}

export interface DiscoveredApp {
  name: string;
  workspaceRoot: string;
  workspaceType: 'nx' | 'angular' | 'vite' | 'storybook';
  command: string;
  hidden: boolean;
  pinnedPort?: number;
  env?: Record<string, string>;
  tags: string[];
  tasks?: string[];
}

export interface ParsedError {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
}

export interface ErrorEntry {
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  parsed?: ParsedError;
}

export interface LogEntry {
  ts: number;
  line: string;
}

export type AppEventType =
  | 'status'
  | 'error-new'
  | 'error-recur'
  | 'health'
  | 'restart-scheduled'
  | 'stale'
  | 'bundle-regression'
  | 'compile-regression'
  | 'task-run';

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
}

export interface AppSummary {
  name: string;
  status: AppStatus;
  port: number | null;
  url: string | null;
  errorCount: number;
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
}
