<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="daimon logo" />
</p>

# Daimon

A local manager for dev servers, polyglot since v0.11: Angular / Nx / Next.js / Nuxt / SvelteKit / Astro / Remix / Vite / Storybook, Django / Rails / FastAPI / Flask / Laravel / Spring Boot / .NET / Express / Nest, Go-air / Rust-trunk, Expo / Flutter / Tauri, Deno / Bun — plus a generic `package.json` fallback and custom profiles from config. One daemon owns all your `serve` processes, auto-assigns ports, dedup's error captures across every supported tool, and exposes a loopback HTTP API + JSON CLI + MCP server. Since v0.12 it also closes **the whole loop**: `daimon test` with parsed failures and flaky detection, crash forensics with `daimon why`, full-text search over everything it has seen, and a one-call `daimon context` pack for agents. v0.13 adds the **daily rhythm**: `daimon report` answers "what happened", env fingerprints answer "what changed", a port pool + forensics answer "who has what", and notifications you can route, batch, and mute — with a scheduled Slack digest.

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

## Framework support (v0.11)

Every framework is a declarative row in the adapter registry (`src/frameworks.ts`) — detection markers, spawn command, readiness/URL patterns, error parser. Run `daimon frameworks` (or `GET /api/frameworks`) to see the registry with per-profile match counts.

| Profile | Detection markers | Command | Readiness · URL | Errors |
| --- | --- | --- | --- | --- |
| `nx` | `nx.json` + per-project `project.json` serve targets | `npx nx serve <name>` | generic (webpack/esbuild banners) | generic |
| `angular` | `angular.json` serve targets | `npx ng serve <name>` | generic | generic |
| `nextjs` | `next.config.*` | `next dev` (pm-aware) | `Ready in …` · `Local:` | generic |
| `nuxt` | `nuxt.config.*` | `nuxi dev` (pm-aware) | `Local:` · `Local:` | generic |
| `sveltekit` | `svelte.config.*` + `@sveltejs/kit` dep | `vite dev` (pm-aware) | `VITE … ready` · `Local:` | vite |
| `astro` | `astro.config.*` | `astro dev` (pm-aware) | `astro … ready` · `Local` | vite |
| `remix` | `react-router.config.*` / `remix.config.*` | `react-router dev` (pm-aware) | `VITE … ready` · `Local:` | vite |
| `vite` | `vite.config.*` | `npx vite` | generic | vite |
| `storybook` | `.storybook/` | `npx storybook dev` | generic | storybook |
| `django` | `manage.py` (django marker) | `python manage.py runserver` | `Quit the server…` · announced URL | python-traceback |
| `rails` | `bin/rails` + `Gemfile` | `bin/rails server` (`ruby bin/rails` on Windows) | `Use Ctrl-C to stop` | rails |
| `fastapi` | `fastapi` in `pyproject.toml`/`requirements.txt` | `uvicorn main:app --reload` | `Uvicorn running on` · announced URL | python-traceback |
| `flask` | `app.py`/`wsgi.py` + `flask` marker | `flask run` | `* Running on` · announced URL | python-traceback |
| `laravel` | `artisan` | `php artisan serve` | `Server running on` · announced URL | php |
| `spring-boot` | `pom.xml`/`build.gradle*` spring-boot marker | `mvnw`/`gradlew` (Windows `.cmd` aware) | `Started … in … seconds` | jvm-gradle |
| `dotnet` | `*.csproj` with `Sdk="Microsoft.NET.Sdk.Web"` | `dotnet watch` | `Now listening on:` · announced URL | dotnet |
| `express-nest` | `express`/`@nestjs/core` dep + dev/start script | `npm run dev` (pm-aware) | TCP port-listen fallback | generic |
| `go-air` | `.air.toml` | `air` | `running...` | go-build |
| `rust-trunk` | `Trunk.toml` | `trunk serve` | `serving static assets at` · announced URL | rust-cargo |
| `expo` | `app.json` + `expo` dep | `expo start` (pm-aware) | `Metro waiting on` · web-preview URL | generic |
| `flutter` | `pubspec.yaml` (flutter sdk) | `flutter run -d web-server` | `is being served at` · web URL | dart file:line |
| `tauri` | `src-tauri/tauri.conf.json` | `npm run tauri dev` (pm-aware) | via underlying vite/next | rust-cargo |
| `deno` (v0.12) | `deno.json` / `deno.jsonc` | `deno task dev` | `Listening on` · announced URL | generic |
| `bun` (v0.12) | `bunfig.toml` / `bun.lock*` + `dev` script | `bun run dev` | TCP port-listen fallback · announced URL | generic |
| `pnpm-workspace` / `turbo` | `pnpm-workspace.yaml` / `turbo.json` | enumerate member packages | per-member profile | per-member |
| `package-json` (fallback) | `package.json` with `dev`/`serve`/`start` script | `npm run <script>` (pm-aware) | announced URL when printed | generic |

Notes:

- **Multi-family coexistence**: a root with both `angular.json` and `manage.py` registers both apps. The fallback never fires when a named profile matched the same directory, and never inside `node_modules` — every skip is explained in `daimon discover`'s rejection stats.
- **Package-manager awareness**: commands adapt to the lockfile (`pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `bun.lock*` → `bun`, else `npm`). Detection only reads lockfile *names* — daimon never runs installs.
- **Mobile profiles** manage the web-preview dev server only; device/emulator flows stay in the framework's own terminal UX.

### Custom profiles

Add your own framework as **data** (validated at config load — regex strings and built-in parser ids, never loaded code):

```jsonc
// daimon.config.json
{
  "frameworks": [
    {
      "id": "phoenix",
      "detect": {
        "files": ["mix.exs"],
        "fileContains": [{ "file": "mix.exs", "pattern": "Mix\\.Project" }]
      },
      "command": "mix phx.server",
      "readiness": { "pattern": "Running \\S+ with cowboy" },
      "url": { "pattern": "Access \\S+ at (https?:\\/\\/\\S+)" },
      "errorParser": "jvm-gradle"
    }
  ]
}
```

`detect` supports `files` (all must exist), `anyFiles` (any), `fileContains` (any file+regex pair), and `packageJson` (`dependsOn` / `script`). Custom profiles are checked after built-ins; invalid entries are skipped with a doctor-surfaced warning. Known `errorParser` ids: `python-traceback`, `go-build`, `rust-cargo`, `dotnet`, `jvm-gradle`, `php`, plus the classic tool ids (`vite`, `webpack`, …).

## The whole loop (v0.12)

v0.11 finished the *serving* story; v0.12 covers everything around it.

### `daimon test` — tests as pipeline citizens

Daimon **wraps the project's own runner** (it never installs or replaces one) and parses the result:

```bash
daimon test web-admin                 # exit 0 all pass · 1 failures · 2 timeout · 5 locked
daimon test api --timeout 120s
daimon test-history web-admin         # recent runs: totals, exit codes, gitHead, failures
daimon test-history web-admin --flaky # tests that flipped pass↔fail ≥3× at the same commit
```

- **Runner resolution**: `overrides.<app>.testCommand` always wins; otherwise the app's framework profile hints the runner — JS profiles pick vitest vs jest by dependency check, `django`/`fastapi`/`flask` → pytest, `go-air` → `go test ./...`, `rust-trunk`/`tauri` → `cargo test`, `dotnet` → `dotnet test`. No resolvable runner → `{ error, hint }`.
- **Parsed failures**: `{suite, test, file, line, message}` + totals, fail-soft (unparsed output still lands in the run log; totals fall back to the exit code). Every parser is gated by a fixture in `test/fixtures/testrunners/` — same convention as framework profiles.
- **History**: runs land in `test_runs`/`test_failures` (`GET /api/tests`), failures carry the same fingerprint scheme as errors, and a test that flips pass↔fail ≥3 times at the same `gitHead` fires a `flaky-test-detected` event (threshold: `tests.flakyThreshold`). Failing runs fire `test-failed` — both are webhook-eligible.
- **Concurrency-safe**: `test` takes the same per-app soft lock as start/stop — a second agent gets exit 5 (`--steal` applies).
- The dashboard **Tests page** shows run history with pass/fail sparklines, failure drill-down with VS Code links, run-to-run diffs (newly failing / newly passing), and flaky badges.

### Crash forensics — `daimon why`

When an app dies, the *why* no longer evaporates. Every child exit daimon didn't request persists a crash report — exit code, signal, uptime, the last 50 log lines, and the git head — ring-buffered to the last 10 per app:

```bash
daimon why web-admin
# → status, last crash (code/signal/uptime + final log lines), grouped 24h errors,
#   regressions, restart-storm state, suspect commit, matching doctor findings
```

Restart storms (default: >20 unrequested exits/hour, `restartStorm.perHour`) fire a single `restart-storm` event per storm and a doctor finding pointing at `daimon why`. Doctor also gained `searchroot-hygiene` (flags drive roots / system dirs / bare home as search roots — suggest-only).

### Full-text search

Everything daimon has seen, greppable — per-app log lines (indexed by default, opt out via `search.logIndex` or `overrides.<app>.logIndex`), plus all errors and events:

```bash
daimon search "ECONNREFUSED" --app api --since 24h
daimon search "unicor*"                      # trailing * = prefix search
daimon search "hydration" --kind logs
```

Hits are `{kind, app, ts, snippet, ref}`. FTS5 (built into the bundled better-sqlite3) with deferred indexing that stays off the write path; if FTS is unavailable the daemon self-warns once and search degrades to a LIKE scan (`fallback: true`) — it never blocks. The dashboard command palette gets a search mode (`>` prefix). Filtered live tails work too: `daimon logs api --grep "ERROR|refused" --stream`.

### `daimon context` — the agent context pack

Six round-trips become one. Pure composition of existing queries — no new state:

```bash
daimon context web-admin --budget 4000
```

Returns status/framework/uptime, top 5 error fingerprint groups (24h), the last crash report, the last test run with failures, compile p50/p95 + last regression, suspect commits, and active locks/agents. `--budget <chars>` drops sections lowest-priority-first (`compile → agents → crashes → tests → errors`; `status` never drops) and lists what fell in `truncated[]`.

### For agents

The context-first workflow, in order:

1. `daimon overview` — what's going on across the workspace (first call of a session).
2. `daimon context <app>` — the full picture for the app you're debugging, one call.
3. Targeted follow-ups only as needed: `daimon why` (crashes), `daimon errors --since-last` (new compile errors after an edit), `daimon search` (where did I see that string?), `daimon test` (did my change break the suite?).

Everything is compact JSON, budgetable, and soft-lock aware — two agents on one machine coordinate instead of colliding. The same verbs are exposed over MCP (`daimon_context`, `daimon_run_tests`, `daimon_why`, `daimon_search`), and `daimon claude install` teaches the workflow to Claude Code.

## Daily rhythm (v0.13)

Everything daimon records used to be pull-only — nobody asks, nobody knows. v0.13 makes the recall useful across the day.

### `daimon report` — what happened

```bash
daimon report                       # last 24h, compact JSON
daimon report --since 7d --md       # human-first markdown, paste into Slack/PRs
daimon report --app web-admin       # one app; --workspace <label> also works
```

Per-app uptime % and restarts, error groups classified **new / recurring / resolved**, test pass-rate + flakiest tests, compile p50/p95 + the slowest build + regressions, crashes and restart storms, agent activity, and env changes. Pure composition over existing history; a section with no data degrades to a note, never an error. The dashboard gets a Report page with a period switcher. Want it delivered? `webhooks[].digest: "09:00"` sends the report daily through the normal webhook queue, Slack-shaped — one timer, one catch-up if the daemon was down, never more than one per day per webhook.

### `daimon env` — what changed

"It worked yesterday" is an env-file change half the time. Every spawn fingerprints the app's convention env files (from the framework registry: vite/next-style `.env*` chains, flask's `.flaskenv`, generic `.env`) — file mtime/size, **key names**, and per-key salted truncated hashes. Values are parsed and discarded in the same tick; they never reach the DB, logs, webhooks, or notifications, and there is no flag to show them — open the file.

```bash
daimon env web-admin        # convention files (found/missing), key names, snapshot age
daimon env diff web-admin   # files/keys added/removed/changed between the last two spawns
daimon why web-admin        # now includes envChanged since the last healthy run
```

### `daimon ports` — who has what

```bash
daimon ports    # app → port → source (pinned|pool|announced) → pid, + foreign holders
```

Opt into pool auto-assignment with `ports: { "pool": "4200-4299" }`. Ports are injected **only** through mechanisms the framework documents (registry `portFlag`/`portEnv` — `ng serve --port`, `next dev -p`, django's positional `127.0.0.1:{port}`, express's `PORT`); profiles without one simply don't participate. Assignments persist across restarts. And the daemon's own port got forensics: `EADDRINUSE` now names the holder pid, checks whether it answers as a daimon (`GET /api/signature`), prints the remedy, and `daimon doctor --auto-fix` terminates a *verified* orphan daimon — never anything else.

### Notifications you don't turn off

```jsonc
"notifications": {
  "kinds": ["error", "crash", "restart-storm"],   // route only what you want
  "batchMs": 300000,                              // same-fingerprint errors → one notification with a count
  "quietHours": "22:00-08:00"                     // suppressed + one "while you were away: N" summary
}
```

All optional — absent keys keep the old behavior. Per-app: `daimon mute web-admin --for 2h` / `daimon unmute` (persisted, visible in status and the dashboard).

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
daimon test <name> [--timeout <dur>] [--steal]   # run the app's own test suite; exit 0/1/2/5 (v0.12)
daimon mute <name> [--for <dur>] / daimon unmute <name>   # silence OS notifications per app (v0.13)
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
daimon logs <name> [--tail N] [--since 30s] [--grep <regex>] [--stream]   # --grep/--stream: filtered live tail (v0.12)
daimon history <name>              # uptime%, restart count, compile p50/p95, top errors
daimon search <query> [--app <a>] [--since <dur>] [--kind logs|errors|events]   # full-text search (v0.12)
daimon test-history <name> [--flaky] [--limit N]   # recent test runs / flaky tests (v0.12)
daimon report [--since 24h|7d] [--app <a>] [--workspace <l>] [--md]   # the digest (v0.13)

# agent verbs
daimon wait <name> [--until serving|healthy|stopped|error] [--timeout 60s]
daimon ensure <name> [--until serving|healthy] [--timeout 180s]
daimon ensure-up <profile> [--until serving|healthy] [--timeout 300s]
daimon overview [--workspace <label>] [--profile <name>] [--budget <tokens>]   # decision-ready snapshot
daimon context <name> [--budget <chars>]   # agent context pack: 6 round-trips in 1 (v0.12)
daimon focus <name> [--until serving|healthy|stable] [--timeout 180s]          # one-shot subscribe-then-act
daimon try-fix <name> [--until serving|healthy] [--timeout 180s]               # doctor + restart + wait
daimon orchestrate <profile> [--goal serving|healthy|stable] [--dry-run] [--budget <tokens>]
daimon agents                      # active agents + per-app soft-locks (v0.10)
daimon handoff <app> <agentId>     # transfer a soft-lock to another agent (v0.10)
daimon profiles suggest [--since 30d] [--min 5]   # profile candidates from co-starts (v0.10)
daimon ci start <profile> [--until ready|healthy] [--timeout 5m] [--json]      # CI helper (v0.10)

# introspection
daimon why <name>                  # crash forensics: last crash + errors + storms + envChanged + suspect commit
daimon why-empty                   # explain an empty `daimon list`
daimon env <name> [--use <file>]   # env-file awareness: files, key names, snapshot age (v0.13); --use sets the active file
daimon env diff <name> [--from <ts>] [--to <ts>]   # files/keys added/removed/changed between spawns (v0.13)
daimon ports                       # app → port → source (pinned|pool|announced) → pid + foreign holders (v0.13)
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
GET  /api/apps/:name/logs?tail=N&since=30s&grep=<regex>
GET  /api/apps/:name/logs/stream[?grep=<regex>] # Server-Sent Events, filtered live tail (v0.12)
GET  /api/apps/:name/wait?until=serving&timeout=60
GET  /api/events[?since=5m&app=<name>&stream=ndjson]
GET  /api/agents                                # active agents + soft-locks (v0.10)
GET  /api/profiles/suggest                      # profile candidates from co-starts (v0.10)
GET  /api/overview[?budget=<tokens>&workspace=&profile=]
GET  /api/discovery/explain
GET  /api/history/{events,compile-times,tasks,summary/:name,why/:name}
GET  /api/history/trends?app=&metric=&since=
GET  /api/history/bundles?app=
GET  /api/tests?app=&limit=&since=              # test-run history + failures (v0.12)
GET  /api/tests/flaky?app=                      # flaky tests at each gitHead (v0.12)
GET  /api/search?q=&app=&since=&kind=           # full-text search (v0.12)
GET  /api/why/:name                             # crash forensics composition (v0.12; + envChanged v0.13)
GET  /api/context/:name?budget=                 # agent context pack (v0.12)
GET  /api/report?since=&app=&workspace=[&md=1]  # the digest (v0.13)
GET  /api/env/:name                             # env-file awareness — names only, never values (v0.13)
GET  /api/env/:name/diff?from=&to=              # env diff between spawns (v0.13)
GET  /api/ports                                 # port map + foreign holders (v0.13)
GET  /api/signature                             # daimon identification for port forensics (v0.13)
GET  /api/config                                # current config (env redacted)
POST /api/apps/:name/(start|stop|restart|snapshot|clean|run/:task)[?steal=1]
POST /api/apps/:name/(mute|unmute)              # per-app notification mute (v0.13)
POST /api/apps/:name/test?timeoutMs=[&steal=1]  # run the test suite, soft-lock gated (v0.12)
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

The MCP server exposes: `list_apps`, `get_status`, `get_errors`, `get_logs`, `start_app`, `stop_app`, `restart_app`, `wait_for_app`, the agent-first verbs `overview`, `ensure`, `ensure_up`, `focus`, `try_fix`, `diff_errors`, `orchestrate`, the v0.10 coordination tools `daimon_who_owns`, `daimon_subscribe_events`, `daimon_notify_on_error`, `daimon_frameworks`, plus the v0.12 whole-loop tools `daimon_context`, `daimon_run_tests`, `daimon_why`, and `daimon_search`. Every MCP call forwards the same `X-Daimon-Agent` identity as the CLI. The recommended session opener is `overview`; when debugging one app, `daimon_context` first, then targeted calls.

## State files (in `~/.daimon/`)

Relocatable since v0.12: set `DAIMON_HOME=<dir>` to move the entire state directory (lock, config, history DB, logs, plugins, snapshots, sessions) — handy for test harnesses and side-by-side setups. `daimon doctor` prints the active home.

- `config.json` — your config (above)
- `daemon.lock` — `{ pid, apiPort, version, startedAt, headless }`
- `state.json` — sticky port assignments; since v0.13 also per-app notification mutes and digest last-sent timestamps
- `salt` — per-install random salt for env-snapshot value hashes (v0.13; deleting it only resets change-detection baselines)
- `cursors.json` — per-client error cursors for `--since-last`
- `history.db` — SQLite of events, compile times, task runs, test runs, crashes, env snapshots, and per-app bundle sizes (powers the Trends dashboard). If it's corrupt at startup, daimon archives it as `history.db.corrupt-<ts>` and rebuilds automatically (v0.10).
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

529 `node:test` cases across small focused files: dependency-graph math, bundle parsing, notifier throttling, regression detectors (compile-time / bundle / error-flap), the parser fixture corpus (see `test/fixtures/parsers/`), the framework adapter test kit (one fixture per registry profile under `test/fixtures/frameworks/` — a profile without a fixture doesn't ship), `overview` budget truncation, auto-fix rule registry, `orchestrate` dry-run/cascade/try-fix paths, polyglot discovery, agent identity + lock contention, audit-log round-trips, webhook dispatch (including a real HTTP delivery and per-app scoping), error-fingerprint grouping, corrupt-history recovery, a 50-app / 100k-event perf bench with hot-path budgets, and MCP contract checks. Tests run against compiled `dist/` and never start the real daemon.

## License

**[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)** — see `LICENSE`.

- Free for personal, hobby, academic, and other noncommercial use
- Free for charities, schools, government, and other noncommercial organizations
- **Not licensed for commercial use** (use by or for a for-profit business)

For a commercial license, get in touch via <https://flycotech.com>.
