export type AppStatus = 'stopped' | 'starting' | 'compiling' | 'serving' | 'error';

export interface AppmanConfig {
  searchRoots: string[];
  portRange: [number, number];
  apiPort: number;
  overrides: Record<string, AppOverride>;
}

export interface AppOverride {
  port?: number;
  command?: string;
  hidden?: boolean;
}

export interface DiscoveredApp {
  name: string;
  workspaceRoot: string;
  workspaceType: 'nx' | 'angular';
  command: string;
  hidden: boolean;
  pinnedPort?: number;
}

export interface ErrorEntry {
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface LogEntry {
  ts: number;
  line: string;
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
}

export interface AppSummary {
  name: string;
  status: AppStatus;
  port: number | null;
  url: string | null;
  errorCount: number;
  uptimeMs: number | null;
  lastCompileMs: number | null;
}
