export interface CliSubcommand {
  name: string;
  args: string;
  summary: string;
  example: string;
  needsDaemon: boolean;
}

export const CLI_SUBCOMMANDS: CliSubcommand[] = [
  { name: 'list', args: '[--tag <name>] [--workspace <label>]', summary: 'List apps with current status, port, health.', example: 'appman list', needsDaemon: true },
  { name: 'status', args: '<name>', summary: 'Get the current status of one app.', example: 'appman status web-admin', needsDaemon: true },
  { name: 'errors', args: '<name> [--since 2m] [--since-last] [--client <id>] [--structured]', summary: 'Get deduplicated errors for an app.', example: 'appman errors web-admin --since 5m', needsDaemon: true },
  { name: 'events', args: '[--since 1h] [--app <name>]', summary: 'Get the event log.', example: 'appman events --since 1h', needsDaemon: true },
  { name: 'wait', args: '<name> [--until serving|healthy|stopped|error] [--timeout 60s]', summary: 'Block until app reaches the given state.', example: 'appman wait web-admin --until healthy', needsDaemon: true },
  { name: 'logs', args: '<name> [--tail N] [--since 30s]', summary: 'Recent log lines for an app.', example: 'appman logs web-admin --tail 100', needsDaemon: true },
  { name: 'start', args: '<name> [--with-deps]', summary: 'Start an app.', example: 'appman start web-admin', needsDaemon: true },
  { name: 'stop', args: '<name>', summary: 'Stop an app.', example: 'appman stop web-admin', needsDaemon: true },
  { name: 'restart', args: '<name>', summary: 'Restart an app.', example: 'appman restart web-admin', needsDaemon: true },
  { name: 'up', args: '[<profile>]', summary: 'Start a profile (or autoStart). Waits for each to reach serving.', example: 'appman up fullstack', needsDaemon: true },
  { name: 'down', args: '[<profile>]', summary: 'Stop a profile (or all apps).', example: 'appman down', needsDaemon: true },
  { name: 'history', args: '<name>', summary: 'Summary metrics (uptime%, restarts, compile p50/p95, top errors).', example: 'appman history web-admin', needsDaemon: true },
  { name: 'why', args: '<name>', summary: 'Last status transition + 5 preceding events.', example: 'appman why web-admin', needsDaemon: true },
  { name: 'tasks', args: '<name>', summary: 'List discovered non-serve tasks.', example: 'appman tasks web-admin', needsDaemon: true },
  { name: 'run', args: '<name> <task> [--watch] [-- args...]', summary: 'Run a discovered task.', example: 'appman run web-admin test', needsDaemon: true },
  { name: 'snapshot', args: '<name>', summary: 'Write a snapshot of app state to ~/.appman/snapshots.', example: 'appman snapshot web-admin', needsDaemon: true },
  { name: 'env', args: '<name> [--use <file>]', summary: 'List or set the active env file for an app.', example: 'appman env web-admin --use .env.staging', needsDaemon: true },
  { name: 'clean', args: '<name> [--deep] [--yes]', summary: 'Remove build artifacts for an app.', example: 'appman clean web-admin --yes', needsDaemon: true },
  { name: 'record', args: '', summary: 'Toggle session recording.', example: 'appman record', needsDaemon: true },
  { name: 'replay', args: '<session.jsonl> [--speed N]', summary: 'Replay a recorded session.', example: 'appman replay session.jsonl', needsDaemon: true },
  { name: 'doctor', args: '', summary: 'Sanity-check the current config and environment.', example: 'appman doctor', needsDaemon: false },
  { name: 'free-port', args: '<port> [--force]', summary: 'Diagnose / free a port.', example: 'appman free-port 4200 --force', needsDaemon: false },
  { name: 'daemon', args: 'start|stop|status|restart|attach|install-service [--detach] [--headless]', summary: 'Manage the appman daemon.', example: 'appman daemon status', needsDaemon: false },
  { name: 'claude', args: 'install|update|uninstall|status [--skill] [--commands] [--agent] [--all] [--dir <path>] [--yes]', summary: 'Install/update Claude Code integration artifacts.', example: 'appman claude install --all', needsDaemon: false },
  { name: 'init', args: '[--force]', summary: 'Interactively create an appman config in cwd.', example: 'appman init', needsDaemon: false },
];

export function findSubcommand(name: string): CliSubcommand | undefined {
  return CLI_SUBCOMMANDS.find(c => c.name === name);
}

export function commandsTable(): string {
  const w = Math.max(...CLI_SUBCOMMANDS.map(c => c.name.length));
  return CLI_SUBCOMMANDS.map(c => `${c.name.padEnd(w)}  ${c.summary}`).join('\n');
}

export function usageString(): string {
  return 'usage: appman <' + CLI_SUBCOMMANDS.map(c => c.name).join('|') + '>';
}
