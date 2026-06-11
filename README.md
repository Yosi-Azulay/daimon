<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="daimon logo" />
</p>

# Daimon

A local manager for dev servers: Angular / Nx / Vite / Storybook out of the box, plus Django / Rails / FastAPI / Go-air / Rust-trunk. One daemon owns all your `serve` processes, auto-assigns ports, dedup's error captures across every supported tool, and exposes a loopback HTTP API + JSON CLI + MCP server.

Daimon is built for the **single machine with several agents on it**: you in one terminal, a Claude Code session in another repo, a second Claude in a third. All of them talk to the same daemon, see only their own workspace by default, carry distinct agent identities, and coordinate through per-app soft-locks instead of stepping on each other's dev servers.

Loopback only. Single user. No cloud. No telemetry.

**Docs site:** <https://yosi-azulay.github.io/daimon/> (generated from the live CLI surface — also in [`docs/`](docs/)).

## Install

```bash
npm i -g daimon
```

After install, `daimon` is on your PATH globally.

## Quick start

```bash
daimon init             # interactive scaffolder; writes ./daimon.config.json or ~/.daimon/config.json
daimon list             # auto-spawns the daemon on first call (defaults to cwd-scoped — pass --all for every workspace)
daimon daemon status
```

## Multi-agent on one machine (v0.9 + v0.10)

A single daimon daemon on `127.0.0.1:4999` serves every workspace on your machine. Two agents (e.g. two Claude Code sessions in different repos) can use the same daemon without stepping on each other:

```bash
# In repo A:
daimon list             # only A's apps
daimon start editor     # cwd disambiguates which "editor"

# In repo B (concurrent, different terminal):
daimon list             # only B's apps
daimon start editor     # B's editor — even though A also has one

# To see every workspace's apps:
daimon list --all

# Manage the workspace registry directly:
daimon workspaces list
daimon workspaces add /path/to/another-repo --label other
daimon workspaces show              # which workspace covers cwd?

# Open the dashboard scoped to the current cwd:
daimon dashboard        # opens http://127.0.0.1:4999/?cwd=<cwd>
```

When two workspaces register apps with the same name, daimon stores the second under `<name>@<workspaceLabel>` so both coexist. CLI commands resolve from `process.cwd()`; a 412 `name-collision` body with candidate workspaces is returned only when no cwd disambiguates.

### Agent identity & soft-locks (v0.10)

Every CLI call carries an `X-Daimon-Agent: <host>-<pid>-<hex>` header — a stable per-session identity, so two Claudes on the same daemon are distinct actors in the daemon's eyes (and in the audit log).

Lifecycle verbs (`start` / `stop` / `restart`) take a **30-second per-app soft-lock**. If another agent holds the lock, the call is refused with exit code `5` instead of silently killing a server someone else is watching. You can override or cooperate:

```bash
daimon start editor --steal                 # override the lock (HTTP: POST …/start?steal=1)
daimon agents                               # who's active on this daemon + current locks
daimon handoff editor claude-host-1234-abcd # "I'm done — you take this app"
```

The agent id is also recorded as the 6th column of `~/.daimon/audit.log`, so you can reconstruct which agent restarted what, and when.

### Profile suggestions

Daimon notices which apps you repeatedly start together and proposes profiles:

```bash
daimon profiles suggest --since 30d --min 5
```

Clusters that already match an existing profile are skipped.

## Three signal classes: errors, warnings, lint

Errors flip app status to `error`. Warnings (TS6133, NG8107, deprecation notes) are surfaced as a separate signal class — they do not flip status. **Lint findings** (eslint, biome, ruff, clippy) are a third channel: parsed from the dev-server log stream, never spawn a linter, never flip status, and live behind a dedicated severity chip on the Errors page.

```bash
daimon errors editor                       # errors only (back-compat default)
daimon errors editor --level warning
daimon errors editor --level lint
daimon errors editor --level all
```

## Unified event timeline

`daimon timeline` and the dashboard `/timeline` route merge status, errors, warnings, lint, health, bundle, compile, and task-run rows into one chronological stream:

```bash
daimon timeline --since 7d --kinds status,error,lint
daimon timeline --app editor --since 24h
```

## Pattern detection (v0.10)

Daimon watches its own history for regressions and emits a `regression-detected` event when it spots one:

- **Compile-time spikes** — recent compiles significantly slower than the app's baseline (tune per app with `overrides.<name>.compileRegressionFactor`).
- **Bundle-size jumps** — initial bundle suddenly heavier than its trend.
- **Error flapping** — the same error appearing/disappearing across restarts.

Each detection includes a `git log -1` suspect-commit hint when the workspace is a git repo. In the dashboard, the **Regressions** tab collects them (keyboard chord: `g` then `r`). `regression-detected` is also a webhook-able event type — see below.

## Webhooks (v0.10)

Push events out instead of polling. Global `webhooks` config array; each entry is `{url, events?, headers?, filter?}`:

```jsonc
{
  "webhooks": [
    {
      "url": "https://hooks.slack.com/services/T000/B000/XXXXXXXX",
      "events": ["error", "regression-detected", "status"],
      "headers": { "x-extra-header": "optional" },
      "filter": { "app": ["web-admin"], "to": ["error", "unhealthy"] }
    }
  ]
}
```

- `events` — event types to forward (`error` / `warning` / `lint` aliases cover the `-new`/`-recur` pairs). Omit for all events.
- `headers` — extra HTTP headers (e.g. auth tokens).
- `filter` — narrow by `app`, and/or status transition `from` / `to`.

Slack and Discord URLs get native attachment/embed shaping automatically. Everything else receives a generic JSON envelope: `{ event, app, ts, payload }` where `payload` carries the event-specific fields (`from`, `to`, `message`); the same fields are also flattened at the top level for back-compat. Deliveries are queued, rate-limited to 1 req/sec, and retried with backoff — an event storm never hammers your endpoint or blocks the daemon.

## CI integration (v0.10)

`daimon ci start <profile>` is a one-shot CI step: start a profile, block until every app reaches the target state, print a structured JSON report, and exit with a meaningful code:

```bash
daimon ci start fullstack --until ready --timeout 5m --json
# exit 0 = all apps reached target
# exit 1 = error (e.g. unknown profile)
# exit 2 = timeout — some app never got there
```

See [`docs/ci-integration.md`](docs/ci-integration.md) for a complete GitHub Actions workflow and a webhook-to-Slack failure alert.

## VS Code extension (v0.10)

`vscode-extension/` ships a companion extension (marketplace id: `flycotech.daimon`): a status-bar item with daemon/app state, an Errors tree view, and Start / Stop / Open-Dashboard commands. It talks to the same loopback API, so it composes with the TUI, CLI, and MCP server. It has its own `package.json` and is built independently of the npm package.

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

  "webhooks": [
    { "url": "https://hooks.slack.com/services/T000/B000/XXXXXXXX", "events": ["error", "regression-detected"] }
  ],

  "overrides": {
    "web-admin": {
      "port": 4250,
      "command": "npx nx serve web-admin --configuration=dev",
      "env": { "API_BASE": "http://localhost:3000" },
      "compileRegressionFactor": 2.0
    }
  }
}
```

All sections except `searchRoots` are optional with safe defaults. See `daimon.config.example.json` for every field.

Config lookup order:

1. `./daimon.config.json` (cwd)
2. `~/.daimon/config.json`

If neither exists, the first call to `daimon` creates a stub and exits — edit `searchRoots` to point at your workspace and try again.

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

Generated from `src/cliSurface.ts` — the single source of truth that also renders `--help`, shell completion, and the docs site.

```bash
# lifecycle
daimon start <name> [--with-deps] [--steal]
daimon stop <name> [--steal]
daimon restart <name> [--steal]
daimon up [<profile>]              # topological start; waits for each to reach serving
daimon down [<profile>]
daimon run <name> <task> [--watch] [-- args...]
daimon clean <name> [--deep] [--yes]
daimon daemon start|stop|status|restart|attach|install-service

# queries
daimon list [--tag <name>] [--workspace <label>] [--full|--compact] [--stream] [--explain]
daimon status <name> [--full|--compact]
daimon errors <name> [--since 2m] [--since-last] [--client <id>] [--structured]
daimon events [--since 1h] [--app <name>] [--stream]
daimon logs <name> [--tail N] [--since 30s]
daimon history <name>              # uptime%, restart count, compile p50/p95, top errors

# agent verbs
daimon wait <name> [--until serving|healthy|stopped|error] [--timeout 60s]
daimon ensure <name> [--until serving|healthy] [--timeout 180s]
daimon ensure-up <profile> [--until serving|healthy] [--timeout 300s]
daimon overview [--workspace <label>] [--profile <name>] [--budget <tokens>]   # decision-ready snapshot
daimon focus <name> [--until serving|healthy|stable] [--timeout 180s]          # one-shot subscribe-then-act
daimon try-fix <name> [--until serving|healthy] [--timeout 180s]               # doctor + restart + wait
daimon orchestrate <profile> [--goal serving|healthy|stable] [--dry-run] [--budget <tokens>]
daimon agents                      # active agents + per-app soft-locks (v0.10)
daimon handoff <app> <agentId>     # transfer a soft-lock to another agent (v0.10)
daimon profiles suggest [--since 30d] [--min 5]   # profile candidates from co-starts (v0.10)
daimon ci start <profile> [--until ready|healthy] [--timeout 5m] [--json]      # CI helper (v0.10)

# introspection
daimon why <name>                  # last transition + 5 preceding events
daimon why-empty                   # explain an empty `daimon list`
daimon discover [--dry-run]        # what daimon would (or did) detect
daimon timeline [--since 7d] [--app <name>] [--kinds status,error,warning,lint,bundle,task]
daimon tasks <name>                # discovered non-serve tasks
daimon snapshot <name>             # bundle state for bug reports
daimon record / replay <session.jsonl> [--speed N]
daimon doctor [--auto-fix] [--dry-run] [--self]
daimon free-port <port> [--force]
daimon self                        # daimon's own runtime metrics
daimon dashboard                   # open the dashboard scoped to cwd

# config
daimon init [--force] [--auto]
daimon env <name> [--use <file>]
daimon pin-health <name> [--accept] [--path <p>]
daimon export-config [--redacted]
daimon workspaces list|add|rm|show
daimon completion <bash|zsh|fish|powershell>

# claude / plugins
daimon claude install|update|uninstall|status
daimon plugin list|show <name>|validate <path>
```

All CLI commands print compact JSON on stdout by default (`--full` for the verbose v0.4 shape). Errors are compact JSON on stderr with non-zero exit. Exit codes: `0` success, `1` generic error, `2` timeout (used by `daimon wait`, `daimon focus`, `daimon ensure*`, `daimon ci`), `5` soft-lock held by another agent (pass `--steal` to override).

## HTTP API

Bound to `127.0.0.1:<apiPort>` only. The dashboard at `/` is an Angular 20 SPA (Material 3, zoneless, signals) bundled into the published tarball — it shows apps, errors grouped by file/app/tool, live logs, doctor, trends, regressions (chord `g r`), settings editor, and one-click actions.

```
GET  /api/apps                                  # compact by default; ?format=full for v0.4 shape
GET  /api/apps/:name
GET  /api/apps/:name/errors[?since=2m]
GET  /api/apps/:name/errors/since-last?client=<id>
GET  /api/apps/:name/logs?tail=N&since=30s
GET  /api/apps/:name/logs/stream                # Server-Sent Events
GET  /api/apps/:name/wait?until=serving&timeout=60
GET  /api/events[?since=5m&app=<name>&stream=ndjson]
GET  /api/agents                                # active agents + soft-locks (v0.10)
GET  /api/profiles/suggest                      # profile candidates from co-starts (v0.10)
GET  /api/overview[?budget=<tokens>&workspace=&profile=]
GET  /api/discovery/explain
GET  /api/history/{events,compile-times,tasks,summary/:name,why/:name}
GET  /api/history/trends?app=&metric=&since=
GET  /api/history/bundles?app=
GET  /api/config                                # current config (env redacted)
POST /api/apps/:name/(start|stop|restart|snapshot|clean|run/:task)[?steal=1]
POST /api/apps/:name/handoff                    # transfer soft-lock (v0.10)
POST /api/apps/:name/focus?until=…              # NDJSON event stream
POST /api/apps/:name/try-fix?until=…
POST /api/apps/:name/health/pin
POST /api/orchestrate?profile=&goal=&timeoutMs=&dryRun=&budget=
POST /api/doctor/auto-fix[?dryRun=true]
PATCH /api/config                               # If-Match: <etag>; 412 on conflict
POST /api/config/reload                         # soft reload — no running children killed
POST /api/shutdown
```

Every request may carry `X-Daimon-Agent` (the CLI and MCP server always send it); lifecycle routes use it for soft-lock gating, and it lands in the audit log. If `config.apiToken` is set, mutating endpoints require `Authorization: Bearer <token>`. Read endpoints stay open.

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

The MCP server exposes: `list_apps`, `get_status`, `get_errors`, `get_logs`, `start_app`, `stop_app`, `restart_app`, `wait_for_app`, the agent-first verbs `overview`, `ensure`, `ensure_up`, `focus`, `try_fix`, `diff_errors`, `orchestrate`, plus the v0.10 coordination tools `daimon_who_owns`, `daimon_subscribe_events`, and `daimon_notify_on_error`. Every MCP call forwards the same `X-Daimon-Agent` identity as the CLI. The recommended session opener is `overview` (compact-by-default, token-budgetable); the recommended one-call workspace bring-up is `orchestrate <profile> goal=stable`.

## State files (in `~/.daimon/`)

- `config.json` — your config (above)
- `daemon.lock` — `{ pid, apiPort, version, startedAt, headless }`
- `state.json` — sticky port assignments
- `cursors.json` — per-client error cursors for `--since-last`
- `history.db` — SQLite of events, compile times, task runs, and per-app bundle sizes (powers the Trends dashboard). If it's corrupt at startup, daimon archives it as `history.db.corrupt-<ts>` and rebuilds automatically (v0.10).
- `logs/<name>.log[.N]` — when `logs.enabled` is true
- `snapshots/<name>-<ts>.json` — `daimon snapshot` output
- `notifications.log` — desktop notification audit
- `crashes/<ts>.txt` — daemon fatal dumps
- `audit.log` — config edits + lifecycle actions, tab-delimited, with the acting agent id in the 6th column (v0.10)
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

262 `node:test` cases across small focused files (~15s wall-clock): dependency-graph math, bundle parsing, notifier throttling, regression detectors (compile-time / bundle / error-flap), the parser fixture corpus (Vite/Storybook/Jest/Nx/Angular esbuild/webpack/Node/Django/Rails/FastAPI/Go-air/Rust-trunk — see `test/fixtures/parsers/`), `overview` budget truncation, auto-fix rule registry, `orchestrate` dry-run/cascade/try-fix paths, polyglot discovery, agent identity + lock contention, audit-log round-trips, webhook dispatch (including a real HTTP delivery), corrupt-history recovery, a 50-app / 100k-event perf bench with hot-path budgets, and MCP contract checks. Tests run against compiled `dist/` and never start the real daemon.

## License

**[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)** — see `LICENSE`.

- Free for personal, hobby, academic, and other noncommercial use
- Free for charities, schools, government, and other noncommercial organizations
- **Not licensed for commercial use** (use by or for a for-profit business)

For a commercial license, get in touch via <https://flycotech.com>.
