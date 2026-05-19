export type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'string-array' | 'number-pair' | 'path' | 'token';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  help: string;
  enumValues?: string[];
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  restartRequired?: boolean;
}

export interface Section {
  id: string;
  title: string;
  icon: string;
  description: string;
  fields: FieldDef[];
}

export const SECTIONS: Section[] = [
  {
    id: 'network',
    title: 'Network',
    icon: 'lan',
    description: 'Ports and bind behavior. daimon always binds to 127.0.0.1 — never the LAN.',
    fields: [
      { key: 'apiPort', label: 'API port', kind: 'number', help: 'The port the daimon daemon serves the HTTP API and dashboard on. Default 4999. If something else is on this port, daimon refuses to start.', min: 1024, max: 65535, restartRequired: true },
      { key: 'portRange', label: 'Dev server port range', kind: 'number-pair', help: 'Range of ports daimon hands out to apps when their config does not pin one. Ports outside this range will not be auto-assigned, but explicit pins in overrides[].port still work.', min: 1024, max: 65535 },
      { key: 'headless', label: 'Headless mode', kind: 'boolean', help: 'When ON, daimon never opens the TUI in this daemon instance — useful when running as a background service. The CLI still works the same.', restartRequired: true },
    ],
  },
  {
    id: 'discovery',
    title: 'Discovery',
    icon: 'travel_explore',
    description: 'Which folders daimon scans for Angular / Nx / Vite / Storybook projects.',
    fields: [
      { key: 'searchRoots', label: 'Search roots', kind: 'string-array', help: 'Absolute paths to workspace folders. daimon will look for nx.json / angular.json / vite.config.* / .storybook in each. Soft-reloaded on save — no daemon restart needed.', placeholder: 'C:\\path\\to\\workspace' },
    ],
  },
  {
    id: 'apps',
    title: 'Apps',
    icon: 'apps',
    description: 'Which apps run automatically and what runs together.',
    fields: [
      { key: 'autoStart', label: 'Auto-start apps', kind: 'string-array', help: 'Apps to start automatically when the daemon spawns. Match the discovered app names. Empty list means nothing auto-starts.', placeholder: 'app-name' },
      { key: 'cascadeRestart', label: 'Cascade restart on error', kind: 'boolean', help: 'When ON, an app entering error state restarts any apps that depend on it. Use with caution if you have noisy compile errors.' },
    ],
  },
  {
    id: 'healthProbe',
    title: 'Health probe',
    icon: 'monitor_heart',
    description: 'How daimon decides an app is "healthy" — a HEAD/GET against the announced URL.',
    fields: [
      { key: 'healthProbe.enabled', label: 'Enabled', kind: 'boolean', help: 'Master switch. When OFF, "serving" is treated as the terminal state for daimon wait / daimon ensure.' },
      { key: 'healthProbe.intervalMs', label: 'Interval', kind: 'number', help: 'How often to re-probe a serving app. Lower values catch outages faster but spend CPU.', min: 1000, max: 600000, unit: 'ms' },
      { key: 'healthProbe.timeoutMs', label: 'Per-probe timeout', kind: 'number', help: 'How long to wait for a single probe response before marking unhealthy.', min: 200, max: 30000, unit: 'ms' },
      { key: 'healthProbe.path', label: 'Path', kind: 'string', help: 'URL path to probe. "/" is fine for most apps; some Nx apps need "/index.html" or a custom health route.', placeholder: '/' },
      { key: 'healthProbe.host', label: 'Host override', kind: 'string', help: 'Optional. Force a specific host (e.g. "127.0.0.1") instead of what the dev server announced. Leave blank to use the announced host.', placeholder: '(announced)' },
      { key: 'healthProbe.scheme', label: 'Scheme override', kind: 'enum', enumValues: ['(announced)', 'http', 'https'], help: 'Force a specific scheme. Leave on "(announced)" to use whatever the dev server printed in its "Local:" line.' },
      { key: 'healthProbe.rejectUnauthorized', label: 'Strict HTTPS certs', kind: 'boolean', help: 'When OFF, self-signed certs (mkcert, Vite\'s auto-cert) are accepted. v0.5 forces this OFF for loopback hosts regardless — this setting only affects off-loopback probes.' },
    ],
  },
  {
    id: 'autoRestart',
    title: 'Auto-restart',
    icon: 'restart_alt',
    description: 'How daimon recovers from crashed dev servers.',
    fields: [
      { key: 'autoRestart.enabled', label: 'Enabled', kind: 'boolean', help: 'When ON, daimon respawns an app that exits non-zero, up to the cap below.' },
      { key: 'autoRestart.maxAttempts', label: 'Max attempts per window', kind: 'number', help: 'Stops retrying after this many consecutive restarts inside the time window. Prevents thrashing.', min: 1, max: 50 },
      { key: 'autoRestart.windowMs', label: 'Retry window', kind: 'number', help: 'Time window over which max-attempts is counted. Resets after a successful "serving" state.', min: 10000, max: 3600000, unit: 'ms' },
    ],
  },
  {
    id: 'history',
    title: 'History',
    icon: 'history',
    description: 'Persistent SQLite database of events, compile times, and task runs.',
    fields: [
      { key: 'history.enabled', label: 'Enabled', kind: 'boolean', help: 'When OFF, daimon still tracks live state but does not persist history across daemon restarts.', restartRequired: true },
      { key: 'history.path', label: 'Database path', kind: 'path', help: 'Where the SQLite file lives. Defaults to ~/.daimon/history.db. Use forward slashes or the path syntax of your OS.', restartRequired: true },
      { key: 'history.retentionDays', label: 'Retention', kind: 'number', help: 'Days of history to keep. Older rows are purged at startup. 0 disables pruning.', min: 0, max: 3650, unit: 'days' },
    ],
  },
  {
    id: 'notifications',
    title: 'Desktop notifications',
    icon: 'notifications',
    description: 'OS notifications via node-notifier. Disable if they\'re too noisy.',
    fields: [
      { key: 'notifications.enabled', label: 'Enabled', kind: 'boolean', help: 'Master switch for desktop notifications.' },
      { key: 'notifications.onError', label: 'On compile error', kind: 'boolean', help: 'Notify when an app transitions into "error" state.' },
      { key: 'notifications.onUnhealthy', label: 'On health failure', kind: 'boolean', help: 'Notify when an app fails its health probe enough times to flip to unhealthy.' },
      { key: 'notifications.tray', label: 'Show tray icon', kind: 'boolean', help: 'Reserve space in the OS tray (where supported). Most users leave this off.' },
    ],
  },
  {
    id: 'staleDetect',
    title: 'Stale detection',
    icon: 'hourglass_empty',
    description: 'Flag apps that have gone quiet without printing anything.',
    fields: [
      { key: 'staleDetect.enabled', label: 'Enabled', kind: 'boolean', help: 'When ON, daimon marks an app "stale" if it has not printed output for the duration below — useful for catching hung dev servers.' },
      { key: 'staleDetect.silentMs', label: 'Silent threshold', kind: 'number', help: 'Quiet duration before marking stale. Most dev servers print at least heartbeats, so 30s is a safe default.', min: 5000, max: 600000, unit: 'ms' },
    ],
  },
  {
    id: 'logs',
    title: 'Log persistence',
    icon: 'description',
    description: 'Save app stdout/stderr to disk for later inspection.',
    fields: [
      { key: 'logs.enabled', label: 'Enabled', kind: 'boolean', help: 'When ON, daimon writes per-app log files to the directory below. Default OFF — daimon already keeps the last 500 lines per app in memory for the dashboard.' },
      { key: 'logs.dir', label: 'Directory', kind: 'path', help: 'Where rotated log files live. Defaults to ~/.daimon/logs.' },
      { key: 'logs.maxFiles', label: 'Files per app', kind: 'number', help: 'Rotation depth. After this many files, the oldest is deleted.', min: 1, max: 100 },
      { key: 'logs.maxBytesPerFile', label: 'Max size per file', kind: 'number', help: 'Rotate when a single file reaches this many bytes. 10000000 = 10 MB.', min: 100000, max: 1000000000, unit: 'bytes' },
    ],
  },
  {
    id: 'requestLog',
    title: 'Request log (proxy)',
    icon: 'compare_arrows',
    description: 'Reverse-proxy your dev server through a sibling port to capture every HTTP request.',
    fields: [
      { key: 'requestLog.enabled', label: 'Enabled', kind: 'boolean', help: 'When ON, daimon proxies the dev server on a sibling port (announced port + offset). The Requests page becomes useful. OFF by default because it adds a hop.', restartRequired: true },
      { key: 'requestLog.portOffset', label: 'Proxy port offset', kind: 'number', help: 'Added to the app\'s dev-server port to compute the proxy port (e.g. dev=4200 + offset=1000 → 5200).', min: 100, max: 50000, restartRequired: true },
    ],
  },
  {
    id: 'metrics',
    title: 'Prometheus metrics',
    icon: 'monitoring',
    description: 'Expose CPU / memory / status / compile-time as Prometheus text on /metrics.',
    fields: [
      { key: 'metrics.enabled', label: 'Enabled', kind: 'boolean', help: 'Turn this on if you scrape the dashboard with Prometheus. The /metrics endpoint stays loopback-only — no remote scraping.' },
    ],
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: 'tune',
    description: 'How this web UI looks. Applies after page reload.',
    fields: [
      { key: 'dashboard.theme', label: 'Theme', kind: 'enum', enumValues: ['auto', 'light', 'dark'], help: '"auto" follows your OS preference. The theme toggle in the topbar overrides this per-browser via localStorage.' },
      { key: 'dashboard.density', label: 'Density', kind: 'enum', enumValues: ['comfortable', 'compact'], help: 'Material 3 density. Compact shows more rows per screen at the cost of click targets.' },
    ],
  },
  {
    id: 'output',
    title: 'CLI output',
    icon: 'terminal',
    description: 'Defaults for the daimon CLI (the `daimon list` / `status` / `errors` you invoke from a shell).',
    fields: [
      { key: 'output.format', label: 'Default format', kind: 'enum', enumValues: ['compact', 'full'], help: '"compact" returns ~10 fields per app, optimized for agents. "full" returns the v0.4 verbose shape. The --full / --compact flags at the call site always win.' },
      { key: 'output.ndjson', label: 'Default NDJSON', kind: 'boolean', help: 'When ON, `daimon list` emits one JSON record per line instead of a single JSON array.' },
    ],
  },
  {
    id: 'doctor',
    title: 'Doctor auto-fix',
    icon: 'medical_services',
    description: 'Which repair routines `daimon doctor --auto-fix` is allowed to run.',
    fields: [
      { key: 'doctor.autoFix.onInit', label: 'Run after `daimon init`', kind: 'boolean', help: 'When ON, daimon will run auto-fix at the end of `daimon init`. Most users leave this OFF — init only writes a config file and doesn\'t need fixes.' },
      { key: 'doctor.autoFix.permitted', label: 'Allowed routines', kind: 'string-array', help: 'Subset of: orphan-daemon, stale-lock, missing-search-root, corrupt-history-db. Removing a name disables that routine entirely.' },
    ],
  },
  {
    id: 'editor',
    title: 'Editor integration',
    icon: 'edit_note',
    description: 'How clicking on error file paths opens your editor.',
    fields: [
      { key: 'editor.scheme', label: 'URL scheme', kind: 'enum', enumValues: ['vscode', 'vscode-insiders', 'cursor', 'jetbrains'], help: 'When you click a file:line:col in the dashboard, daimon opens `<scheme>://file/<path>:<line>:<col>`. Pick the editor you actually use.' },
    ],
  },
  {
    id: 'auth',
    title: 'API authentication',
    icon: 'lock',
    description: 'Optional bearer token. Most users leave this empty since daimon is loopback-only.',
    fields: [
      { key: 'apiToken', label: 'Bearer token', kind: 'token', help: 'When set, mutating endpoints require an Authorization: Bearer <token> header. The CLI reads this from DAIMON_TOKEN env var. Leave blank if you trust everything on this machine.', restartRequired: true },
    ],
  },
];

export function get(obj: any, path: string): any {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function set(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}
