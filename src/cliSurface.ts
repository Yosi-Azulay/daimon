export interface CliSubcommand {
  name: string;
  args: string;
  summary: string;
  example: string;
  needsDaemon: boolean;
}

export const CLI_SUBCOMMANDS: CliSubcommand[] = [
  { name: 'list', args: '[--tag <name>] [--workspace <label>] [--full|--compact] [--stream] [--explain]', summary: 'List apps. Compact by default; --full for v0.4 shape; --stream for NDJSON; --explain wraps with _meta (searchRoots, scanned, rejected, suggestion).', example: 'daimon list', needsDaemon: true },
  { name: 'status', args: '<name> [--full|--compact]', summary: 'Get the current status of one app. Compact by default.', example: 'daimon status web-admin', needsDaemon: true },
  { name: 'errors', args: '<name> [--since 2m] [--since-last] [--client <id>] [--structured] [--full|--compact]', summary: 'Get deduplicated errors for an app. Compact by default ({file,line,col,code,message}).', example: 'daimon errors web-admin --since 5m', needsDaemon: true },
  { name: 'events', args: '[--since 1h] [--app <name>] [--stream]', summary: 'Get the event log. --stream emits NDJSON until SIGINT.', example: 'daimon events --since 1h', needsDaemon: true },
  { name: 'wait', args: '<name> [--until serving|healthy|stopped|error] [--timeout 60s]', summary: 'Block until app reaches the given state.', example: 'daimon wait web-admin --until healthy', needsDaemon: true },
  { name: 'ensure', args: '<name> [--until serving|healthy] [--timeout 180s]', summary: 'One-call: start if needed, block to target state, return terminal state. Idempotent.', example: 'daimon ensure web-admin', needsDaemon: true },
  { name: 'ensure-up', args: '<profile> [--until serving|healthy] [--timeout 300s]', summary: 'One-call: cascade-start every app in the profile and wait for each to reach target.', example: 'daimon ensure-up fullstack', needsDaemon: true },
  { name: 'overview', args: '[--workspace <label>] [--profile <name>] [--budget <tokens>]', summary: 'Decision-ready snapshot: totals, byStatus, needsAttention (with first parsed error), recentlyChanged. First call in a session. --budget caps the response size for agents; overflow collapses to _meta.omitted.', example: 'daimon overview --budget 1500', needsDaemon: true },
  { name: 'focus', args: '<name> [--until serving|healthy|stable] [--timeout 180s]', summary: 'One round-trip subscribe-then-act: streams NDJSON of status/error/url events for one app until target state or timeout. Designed for agents.', example: 'daimon focus web-admin --until stable', needsDaemon: true },
  { name: 'try-fix', args: '<name> [--until serving|healthy] [--timeout 180s]', summary: 'Composite: run doctor --auto-fix on permitted rules, restart the app, wait for target, return {before,after,fixed,stillFailing}. Never edits user source.', example: 'daimon try-fix web-admin', needsDaemon: true },
  { name: 'orchestrate', args: '<profile> [--goal serving|healthy|stable] [--timeout 300s] [--dry-run] [--budget <tokens>]', summary: 'Bring up a whole profile in one call: cascade-start, wait for goal, run ONE try-fix round on stragglers. Returns {profile, goal, perApp, totalMs, allReached}. --dry-run reports planned order only. Designed for agents.', example: 'daimon orchestrate fullstack --goal stable', needsDaemon: true },
  { name: 'pin-health', args: '<name> [--accept] [--path <p>]', summary: 'Show the auto-discovered health-probe path for an app; --accept persists it as overrides.<name>.healthProbePath in daimon.config.json and soft-reloads. Default behaviour is opt-in: nothing is written without --accept.', example: 'daimon pin-health api --accept', needsDaemon: true },
  { name: 'logs', args: '<name> [--tail N] [--since 30s]', summary: 'Recent log lines for an app.', example: 'daimon logs web-admin --tail 100', needsDaemon: true },
  { name: 'start', args: '<name> [--with-deps]', summary: 'Start an app.', example: 'daimon start web-admin', needsDaemon: true },
  { name: 'stop', args: '<name>', summary: 'Stop an app.', example: 'daimon stop web-admin', needsDaemon: true },
  { name: 'restart', args: '<name>', summary: 'Restart an app.', example: 'daimon restart web-admin', needsDaemon: true },
  { name: 'up', args: '[<profile>]', summary: 'Start a profile (or autoStart). Waits for each to reach serving.', example: 'daimon up fullstack', needsDaemon: true },
  { name: 'down', args: '[<profile>]', summary: 'Stop a profile (or all apps).', example: 'daimon down', needsDaemon: true },
  { name: 'history', args: '<name>', summary: 'Summary metrics (uptime%, restarts, compile p50/p95, top errors).', example: 'daimon history web-admin', needsDaemon: true },
  { name: 'why', args: '<name>', summary: 'Last status transition + 5 preceding events.', example: 'daimon why web-admin', needsDaemon: true },
  { name: 'why-empty', args: '', summary: 'Explain why `daimon list` is empty: configured searchRoots, scanned/rejected counts, suggested next step.', example: 'daimon why-empty', needsDaemon: true },
  { name: 'discover', args: '[--dry-run]', summary: 'Run discovery without changing state. Prints _meta: searchRoots, scanned, rejected per folder, suggestion.', example: 'daimon discover --dry-run', needsDaemon: true },
  { name: 'export-config', args: '[--redacted]', summary: 'Emit the active config to stdout. --redacted replaces apiToken with "<redacted>" and rewrites home paths to ~/...', example: 'daimon export-config --redacted', needsDaemon: false },
  { name: 'tasks', args: '<name>', summary: 'List discovered non-serve tasks.', example: 'daimon tasks web-admin', needsDaemon: true },
  { name: 'run', args: '<name> <task> [--watch] [-- args...]', summary: 'Run a discovered task.', example: 'daimon run web-admin test', needsDaemon: true },
  { name: 'snapshot', args: '<name>', summary: 'Write a snapshot of app state to ~/.daimon/snapshots.', example: 'daimon snapshot web-admin', needsDaemon: true },
  { name: 'env', args: '<name> [--use <file>]', summary: 'List or set the active env file for an app.', example: 'daimon env web-admin --use .env.staging', needsDaemon: true },
  { name: 'clean', args: '<name> [--deep] [--yes]', summary: 'Remove build artifacts for an app.', example: 'daimon clean web-admin --yes', needsDaemon: true },
  { name: 'record', args: '', summary: 'Toggle session recording.', example: 'daimon record', needsDaemon: true },
  { name: 'replay', args: '<session.jsonl> [--speed N]', summary: 'Replay a recorded session.', example: 'daimon replay session.jsonl', needsDaemon: true },
  { name: 'doctor', args: '[--auto-fix] [--dry-run]', summary: 'Sanity-check config + env. --auto-fix repairs orphan daemon, stale lock, missing search root, corrupt history db.', example: 'daimon doctor --auto-fix', needsDaemon: false },
  { name: 'free-port', args: '<port> [--force]', summary: 'Diagnose / free a port.', example: 'daimon free-port 4200 --force', needsDaemon: false },
  { name: 'daemon', args: 'start|stop|status|restart|attach|install-service [--detach] [--headless]', summary: 'Manage the daimon daemon.', example: 'daimon daemon status', needsDaemon: false },
  { name: 'claude', args: 'install|update|uninstall|status [--skill] [--commands] [--agent] [--all] [--dir <path>] [--yes]', summary: 'Install/update Claude Code integration artifacts.', example: 'daimon claude install --all', needsDaemon: false },
  { name: 'init', args: '[--force] [--auto]', summary: 'Create a daimon config in cwd; --auto picks safe defaults (no prompts) for workspaces with nx/angular/vite markers.', example: 'daimon init --auto', needsDaemon: false },
];

export function findSubcommand(name: string): CliSubcommand | undefined {
  return CLI_SUBCOMMANDS.find(c => c.name === name);
}

export function commandsTable(): string {
  const w = Math.max(...CLI_SUBCOMMANDS.map(c => c.name.length));
  return CLI_SUBCOMMANDS.map(c => `${c.name.padEnd(w)}  ${c.summary}`).join('\n');
}

export function usageString(): string {
  return 'usage: daimon <' + CLI_SUBCOMMANDS.map(c => c.name).join('|') + '>';
}
