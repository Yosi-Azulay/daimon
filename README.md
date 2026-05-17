# Bosun

A local manager for Angular / Nx / Vite / Storybook dev servers. One daemon owns all your `serve` processes, auto-assigns ports, dedup'd error captures, exposes a loopback HTTP API + JSON CLI + MCP server. Built so you and Claude Code can both query app state without parsing thousands of log lines.

Loopback only. Single user. No cloud. No telemetry.

## Install

```bash
npm i -g bosun
```

After install, `bosun` is on your PATH globally.

## Quick start

```bash
bosun init             # interactive scaffolder; writes ./bosun.config.json or ~/.bosun/config.json
bosun list             # auto-spawns the daemon on first call
bosun daemon status
```

Config lookup order:

1. `./bosun.config.json` (cwd)
2. `~/.bosun/config.json`

If neither exists, the first call to `bosun` creates a stub and exits — edit `searchRoots` to point at your workspace and try again.

## Config (minimal)

```jsonc
{
  "searchRoots": ["D:\\code\\my-nx-workspace"],
  "portRange": [4200, 4299],
  "apiPort": 4999,

  "autoStart": ["web-admin"],
  "profiles": { "fullstack": ["web-admin", "api"] },
  "depends": { "web-admin": ["api"] },

  "healthProbe": { "enabled": true, "intervalMs": 30000, "path": "/" },

  "overrides": {
    "web-admin": {
      "port": 4250,
      "command": "npx nx serve web-admin --configuration=dev",
      "env": { "API_BASE": "http://localhost:3000" }
    }
  }
}
```

All sections except `searchRoots` are optional with safe defaults. See `bosun.config.example.json` for every field.

## Daemon lifecycle

```bash
bosun daemon start [--detach] [--headless]   # foreground TUI by default
bosun daemon status                          # { running, pid, port, uptime, version }
bosun daemon stop
bosun daemon restart                          # state-handoff: serving apps come back on the same ports
bosun daemon attach                           # HTTP-client TUI against a running detached daemon
bosun daemon install-service                  # emits service unit for Windows (nssm) / macOS (launchd) / Linux (systemd)
```

The daemon auto-spawns on the first `bosun` call that needs it. To suppress: `BOSUN_NO_SPAWN=1` or `--no-spawn`. To target a non-default daemon: `BOSUN_PORT=5000`.

## CLI

```bash
bosun list [--tag <name>] [--workspace <label>]
bosun status <name>
bosun errors <name> [--since 2m] [--since-last] [--client <id>] [--structured]
bosun events [--since 1h] [--app <name>]
bosun wait <name> [--until serving|healthy|stopped|error] [--timeout 60s]
bosun logs <name> [--tail N] [--since 30s]
bosun start <name> [--with-deps]
bosun stop <name>
bosun restart <name>
bosun up [<profile>]              # topological start; waits for each level to reach healthy
bosun down [<profile>]
bosun history <name>              # uptime%, restart count, compile p50/p95, top errors
bosun why <name>                  # last transition + 5 preceding events (great for "what just broke")
bosun tasks <name>                # discovered non-serve tasks
bosun run <name> <task> [--watch] [-- args...]
bosun snapshot <name>             # bundle state for bug reports
bosun env <name> [--use <file>]   # env-file switcher
bosun clean <name> [--deep] [--yes]
bosun record / replay
bosun doctor                      # config sanity checks; does not need the daemon
bosun free-port <port> [--force]
bosun init                        # interactive config scaffolder
```

All CLI commands print compact JSON on stdout. Errors are compact JSON on stderr with non-zero exit. Exit codes: `0` success, `1` generic error, `2` timeout (used by `bosun wait`).

## HTTP API

Bound to `127.0.0.1:<apiPort>` only. The dashboard at `/` lets you inspect state, restart apps, expand error drawers, and (in v0.4) edit configuration.

```
GET  /api/apps
GET  /api/apps/:name
GET  /api/apps/:name/errors[?since=2m]
GET  /api/apps/:name/errors/since-last?client=<id>
GET  /api/apps/:name/logs?tail=N&since=30s
GET  /api/apps/:name/logs/stream         # Server-Sent Events
GET  /api/apps/:name/wait?until=serving&timeout=60
GET  /api/events?since=5m&app=<name>
GET  /api/history/{events,compile-times,tasks,summary/:name,why/:name}
GET  /api/config                          # current config (env redacted)
POST /api/apps/:name/(start|stop|restart|snapshot|clean|run/:task)
PATCH /api/config                         # If-Match: <etag>; 412 on conflict
POST /api/config/reload                   # soft reload — no running children killed
POST /api/shutdown
```

If `config.apiToken` is set, mutating endpoints require `Authorization: Bearer <token>`. Read endpoints stay open.

## Claude Code integration

```bash
bosun claude install --all
# or pick: --skill, --commands, --agent
# or interactive: bosun claude install
```

Three selectable artifacts:

- **Skill** at `~/.claude/skills/bosun/SKILL.md` — comprehensive how-to and recipes.
- **Slash commands** at `~/.claude/commands/bosun-{status,start,stop,restart,errors,logs,up,doctor,why,wait}.md`.
- **Subagent** at `~/.claude/agents/bosun-runner.md` — specialized dev-loop orchestrator.

Templates are rendered from a single source of truth (`src/cliSurface.ts`), so they cannot drift from the actual command surface.

Bosun stamps the current version into the artifact frontmatter. When you upgrade bosun, the next CLI call nudges you (once per 24h) to run `bosun claude update`. Silence with `BOSUN_NO_CLAUDE_NUDGE=1`.

```bash
bosun claude status        # what's installed and at which version
bosun claude update        # refresh based on the install manifest
bosun claude uninstall [--all|--skill|--commands|--agent]
```

For raw MCP use (without slash commands or a subagent):

```bash
claude mcp add bosun -- bosun mcp
```

The MCP server exposes: `list_apps`, `get_status`, `get_errors`, `get_logs`, `start_app`, `stop_app`, `restart_app`, `wait_for_app`.

## State files (in `~/.bosun/`)

- `config.json` — your config (above)
- `daemon.lock` — `{ pid, apiPort, version, startedAt, headless }`
- `state.json` — sticky port assignments
- `cursors.json` — per-client error cursors for `--since-last`
- `history.db` — SQLite of events, compile times, task runs
- `logs/<name>.log[.N]` — when `logs.enabled` is true
- `snapshots/<name>-<ts>.json` — `bosun snapshot` output
- `notifications.log` — desktop notification audit
- `crashes/<ts>.txt` — daemon fatal dumps
- `audit.log` — dashboard config edits
- `secrets.json` — `${NAME}` substitutions for `overrides.env`
- `sessions/<ts>.jsonl` — `bosun record` output

## Migrating from v0.3 (when it was `appman`)

- Binary renamed: `appman` → `bosun`. `npm start` is no longer the way; use `npm i -g bosun` then `bosun daemon start`.
- Environment variables: `APPMAN_PORT` → `BOSUN_PORT`, `APPMAN_NO_SPAWN` → `BOSUN_NO_SPAWN`, `APPMAN_TOKEN` → `BOSUN_TOKEN`, `APPMAN_NO_CLAUDE_NUDGE` → `BOSUN_NO_CLAUDE_NUDGE`.
- Config file: `appman.config.json` → `bosun.config.json` (filename change only; schema is preserved).
- State directory: `~/.appman/` → `~/.bosun/`. If you had v0.3 state, move it: `mv ~/.appman ~/.bosun`.
- Claude artifacts: `~/.claude/skills/appman/`, `~/.claude/commands/appman-*.md`, `~/.claude/agents/appman-runner.md` → run `bosun claude install --all` after upgrading to write the new paths. Delete the old appman-named files manually if desired.

## Migrating from v0.2 (`summary.url` semantics)

The `summary.url` field returned by the API was synthetic `http://127.0.0.1:<port>` in v0.2. From v0.3 onwards it is the **resolved probe URL** — `overrides.<name>.url` overrides win, then `healthProbe.scheme`/`host`, then the URL the dev server announced (`Local: …`), then a fallback host. Field name unchanged; value is more accurate (HTTPS, IPv6, custom paths all preserved).

## Tests

```bash
npm test
```

Four small `node:test` files cover dependency-graph math, bundle parsing, notifier throttling, and compile-time regression. No vitest dependency.

## License

MIT — see `LICENSE`.
