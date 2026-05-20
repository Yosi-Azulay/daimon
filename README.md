# Daimon

A local manager for dev servers: Angular / Nx / Vite / Storybook out of the box, plus Django / Rails / FastAPI / Go-air / Rust-trunk (v0.7). One daemon owns all your `serve` processes, auto-assigns ports, dedup'd error captures across every supported tool, exposes a loopback HTTP API + JSON CLI + MCP server. Built so you and Claude Code can both query app state without parsing thousands of log lines.

Loopback only. Single user. No cloud. No telemetry.

## Install

```bash
npm i -g daimon
```

After install, `daimon` is on your PATH globally.

## Quick start

```bash
daimon init             # interactive scaffolder; writes ./daimon.config.json or ~/.daimon/config.json
daimon list             # auto-spawns the daemon on first call
daimon daemon status
```

Config lookup order:

1. `./daimon.config.json` (cwd)
2. `~/.daimon/config.json`

If neither exists, the first call to `daimon` creates a stub and exits — edit `searchRoots` to point at your workspace and try again.

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

All sections except `searchRoots` are optional with safe defaults. See `daimon.config.example.json` for every field.

## Daemon lifecycle

```bash
daimon daemon start [--detach] [--headless]   # foreground TUI by default
daimon daemon status                          # { running, pid, port, uptime, version }
daimon daemon stop
daimon daemon restart                          # state-handoff: serving apps come back on the same ports
daimon daemon attach                           # HTTP-client TUI against a running detached daemon
daimon daemon install-service                  # emits service unit for Windows (nssm) / macOS (launchd) / Linux (systemd)
```

The daemon auto-spawns on the first `daimon` call that needs it. To suppress: `DAIMON_NO_SPAWN=1` or `--no-spawn`. To target a non-default daemon: `DAIMON_PORT=5000`.

## CLI

```bash
daimon list [--tag <name>] [--workspace <label>] [--explain] [--full] [--stream]
daimon status <name> [--full]
daimon errors <name> [--since 2m] [--since-last] [--client <id>] [--structured]
daimon events [--since 1h] [--app <name>] [--stream]
daimon wait <name> [--until serving|healthy|stopped|error] [--timeout 60s]
daimon logs <name> [--tail N] [--since 30s]
daimon start <name> [--with-deps]
daimon stop <name>
daimon restart <name>
daimon up [<profile>]              # topological start; waits for each level to reach healthy
daimon down [<profile>]
daimon overview [--workspace <label>] [--profile <name>] [--budget <tokens>]   # decision-ready snapshot
daimon ensure <name> [--until serving|healthy] [--timeout 60s]
daimon ensure-up <profile> [--until serving|healthy] [--timeout 60s]
daimon focus <name> [--until serving|healthy|stable] [--timeout 180s]          # one-shot subscribe-then-act (v0.6)
daimon try-fix <name> [--until healthy] [--timeout 60s]                        # doctor + restart + wait (v0.6)
daimon orchestrate <profile> [--goal serving|healthy|stable] [--dry-run] [--budget <tokens>]   # whole-workspace bring-up (v0.7)
daimon trends <name> --metric compile|bundle|errors|restarts [--since 24h|7d|30d]   # history time-series (v0.7)
daimon discover [--explain] [--dry-run]   # what daimon would (or did) detect
daimon why-empty                   # alias of `daimon list --explain`
daimon history <name>              # uptime%, restart count, compile p50/p95, top errors
daimon why <name>                  # last transition + 5 preceding events
daimon tasks <name>                # discovered non-serve tasks
daimon run <name> <task> [--watch] [-- args...]
daimon snapshot <name>             # bundle state for bug reports
daimon env <name> [--use <file>]   # env-file switcher
daimon clean <name> [--deep] [--yes]
daimon record / replay
daimon doctor [--auto-fix] [--dry-run]    # config sanity checks + rule-based self-repair (v0.5+)
daimon pin-health <name> [--accept] [--path <p>]   # opt-in health-probe path discovery (v0.6)
daimon export-config [--redacted]   # paste-ready config for bug reports
daimon free-port <port> [--force]
daimon init [--auto]               # interactive (or non-interactive) config scaffolder
```

All CLI commands print compact JSON on stdout by default (`--full` for the verbose v0.4 shape). Errors are compact JSON on stderr with non-zero exit. Exit codes: `0` success, `1` generic error, `2` timeout (used by `daimon wait`, `daimon focus`, `daimon ensure*`).

## HTTP API

Bound to `127.0.0.1:<apiPort>` only. The dashboard at `/` is an Angular 20 SPA (Material 3, zoneless, signals) bundled into the published tarball — it shows apps, errors grouped by file/app/tool, live logs, doctor, trends (v0.7), settings editor, and one-click actions.

```
GET  /api/apps                                  # compact by default; ?format=full for v0.4 shape
GET  /api/apps/:name
GET  /api/apps/:name/errors[?since=2m]
GET  /api/apps/:name/errors/since-last?client=<id>
GET  /api/apps/:name/logs?tail=N&since=30s
GET  /api/apps/:name/logs/stream                # Server-Sent Events
GET  /api/apps/:name/wait?until=serving&timeout=60
GET  /api/events[?since=5m&app=<name>&stream=ndjson]
GET  /api/overview[?budget=<tokens>&workspace=&profile=]      # v0.5
GET  /api/discovery/explain                                    # v0.5
GET  /api/history/{events,compile-times,tasks,summary/:name,why/:name}
GET  /api/history/trends?app=&metric=&since=                  # v0.7
GET  /api/history/bundles?app=                                # v0.7
GET  /api/config                                # current config (env redacted)
POST /api/apps/:name/(start|stop|restart|snapshot|clean|run/:task)
POST /api/apps/:name/focus?until=…              # NDJSON event stream (v0.6)
POST /api/apps/:name/try-fix?until=…            # v0.6
POST /api/apps/:name/health/pin                 # v0.6 (with --accept)
POST /api/orchestrate?profile=&goal=&timeoutMs=&dryRun=&budget=   # v0.7
POST /api/doctor/auto-fix[?dryRun=true]
PATCH /api/config                               # If-Match: <etag>; 412 on conflict
POST /api/config/reload                         # soft reload — no running children killed
POST /api/shutdown
```

If `config.apiToken` is set, mutating endpoints require `Authorization: Bearer <token>`. Read endpoints stay open.

## Claude Code integration

```bash
daimon claude install        # writes a single SKILL.md (no per-command slash files since v0.5)
```

Daimon installs a single skill at `~/.claude/skills/daimon/SKILL.md` (~120 useful tokens) that documents every verb inline. Old per-command `~/.claude/commands/daimon-*.md` files from v0.3/v0.4 are removed (or renamed to `.bak` if you've edited them since install). An optional `~/.claude/agents/daimon-runner.md` subagent can be installed with `--agent`.

The skill is rendered from a single source of truth (`src/cliSurface.ts`) so it cannot drift from the actual command surface.

Daimon stamps the current version into the artifact frontmatter. When you upgrade daimon, the next CLI call nudges you (once per 24h) to run `daimon claude update`. Silence with `DAIMON_NO_CLAUDE_NUDGE=1`.

```bash
daimon claude status        # what's installed and at which version
daimon claude update        # refresh based on the install manifest
daimon claude uninstall
```

For raw MCP use:

```bash
claude mcp add daimon -- daimon mcp
```

The MCP server exposes: `list_apps`, `get_status`, `get_errors`, `get_logs`, `start_app`, `stop_app`, `restart_app`, `wait_for_app`, plus the agent-first verbs added in v0.5–v0.7: `overview`, `ensure`, `ensure_up`, `focus`, `try_fix`, `diff_errors`, `orchestrate`. The recommended session opener is `overview` (compact-by-default, token-budgetable); the recommended one-call workspace bring-up is `orchestrate <profile> goal=stable`.

## State files (in `~/.daimon/`)

- `config.json` — your config (above)
- `daemon.lock` — `{ pid, apiPort, version, startedAt, headless }`
- `state.json` — sticky port assignments
- `cursors.json` — per-client error cursors for `--since-last`
- `history.db` — SQLite of events, compile times, task runs, and per-app bundle sizes (the last powers the v0.7 Trends dashboard)
- `logs/<name>.log[.N]` — when `logs.enabled` is true
- `snapshots/<name>-<ts>.json` — `daimon snapshot` output
- `notifications.log` — desktop notification audit
- `crashes/<ts>.txt` — daemon fatal dumps
- `audit.log` — dashboard config edits
- `secrets.json` — `${NAME}` substitutions for `overrides.env`
- `sessions/<ts>.jsonl` — `daimon record` output

## Migrating from v0.3 (when it was `appman`)

- Binary renamed: `appman` → `daimon`. `npm start` is no longer the way; use `npm i -g daimon` then `daimon daemon start`.
- Environment variables: `APPMAN_PORT` → `DAIMON_PORT`, `APPMAN_NO_SPAWN` → `DAIMON_NO_SPAWN`, `APPMAN_TOKEN` → `DAIMON_TOKEN`, `APPMAN_NO_CLAUDE_NUDGE` → `DAIMON_NO_CLAUDE_NUDGE`.
- Config file: `appman.config.json` → `daimon.config.json` (filename change only; schema is preserved).
- State directory: `~/.appman/` → `~/.daimon/`. If you had v0.3 state, move it: `mv ~/.appman ~/.daimon`.
- Claude artifacts: `~/.claude/skills/appman/`, `~/.claude/commands/appman-*.md`, `~/.claude/agents/appman-runner.md` → run `daimon claude install --all` after upgrading to write the new paths. Delete the old appman-named files manually if desired.

## Migrating from v0.2 (`summary.url` semantics)

The `summary.url` field returned by the API was synthetic `http://127.0.0.1:<port>` in v0.2. From v0.3 onwards it is the **resolved probe URL** — `overrides.<name>.url` overrides win, then `healthProbe.scheme`/`host`, then the URL the dev server announced (`Local: …`), then a fallback host. Field name unchanged; value is more accurate (HTTPS, IPv6, custom paths all preserved).

## Tests

```bash
npm test
```

60 `node:test` cases across small focused files: dependency-graph math, bundle parsing, notifier throttling, compile-time regression, the parser fixture corpus (Vite/Storybook/Jest/Nx/Angular esbuild/webpack/Node/Django/Rails/FastAPI/Go-air/Rust-trunk — see `test/fixtures/parsers/`), `overview` budget truncation, auto-fix rule registry, `orchestrate` dry-run/cascade/try-fix paths, polyglot discovery (strict markers + JS precedence), and the TUI ribbon helper. No vitest dependency. The dashboard's Vitest + Playwright layer is deferred to v0.7.1.

## License

**[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)** — see `LICENSE`.

- Free for personal, hobby, academic, and other noncommercial use
- Free for charities, schools, government, and other noncommercial organizations
- **Not licensed for commercial use** (use by or for a for-profit business)

For a commercial license, contact yosi@flycotech.com.
