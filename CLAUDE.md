# daimon — orientation for future agents

`daimon` is a local-only dev-server manager (Angular/Nx/Vite/Storybook + polyglot) with a TUI, an HTTP API on `127.0.0.1`, a JSON CLI, and an MCP server for Claude Code. Loopback only; no remote, no cloud sync, no multi-user.

If you arrive here mid-task, this file is what you need to know about the codebase.

## Where things live

```
src/
  cli.ts            # Argv dispatch. Adds X-Daimon-Agent + X-Daimon-Cwd to every HTTP call.
  cliSurface.ts     # Single source of truth for CLI verbs (rendered in --help, README, completion).
  main.ts           # Daemon entry point. Boots Registry / History / Server / WebhookDispatcher / TUI.
  server.ts         # HTTP routes. Per-app soft-lock gating + audit log writes live here.
  registry.ts       # In-memory app/event/error book-keeping. Emits 'event' to dispatcher subscribers.
  history.ts        # SQLite-backed events / compiles / bundles / tasks / test runs /
                    # crashes (ring 10/app) / log lines / self-metrics.
                    # Auto-archives a corrupt DB on startup as history.db.corrupt-<ts>.
                    # FTS5 search (M77) uses DEFERRED indexing via fts_state high-water
                    # marks — never add per-insert FTS triggers (measured 4-10× on the
                    # write path); sync runs on idle flush ticks, before retention, and
                    # before every search. FTS failure degrades to LIKE, never blocks.
  agents.ts         # Agent identity (`<host>-<pid>-<rand4>`) + 30s per-app LockManager.
  testRunners.ts    # Test-runner registry (M74): 5 fixture-gated parsers
                    # (vitest-jest/pytest/go-test/cargo-test/dotnet-test), runner
                    # resolution (overrides.<app>.testCommand > profile testRunner hint
                    # > package.json test script), execution with tree-kill timeout,
                    # and query-derived flaky detection (M75).
  audit.ts          # Tab-delimited audit log; 6 columns (5-col rows still parse).
  webhooks.ts       # Outbound webhooks: queue + rate limit + Slack/Discord shape detection.
                    # Per-app scoping via webhooks[].apps + overrides.<app>.webhooks (M72).
  frameworks.ts     # Framework adapter registry (M65): every framework is a declarative
                    # FrameworkProfile row (detect/command/readiness/url/errorParser/badge).
                    # Custom config profiles are validated DATA, never loaded code.
  errorGroups.ts    # Error grouping by stack fingerprint (GET /api/errors?group=fingerprint).
  regressions.ts    # Pattern detection: compile/bundle/error-flap regression detectors.
  doctor.ts         # `daimon doctor` rules.
  autoFix.ts        # Doctor's --auto-fix repairs.
  discovery.ts      # Workspace scan — a loop over the frameworks.ts registry (M65).
                    # Handles enumerators (nx/angular/pnpm/turbo), fallback precedence, overrides.
  mcp.ts            # MCP server. Wraps the HTTP API and forwards X-Daimon-Agent.
  ...
dashboard/          # Angular 20 SPA bundled into dist/dashboard/.
test/               # node --test suite. ~200+ test cases under 30s wall-clock.
vscode-extension/   # VS Code extension (published as flycotech.daimon). Independent package.json.
```

## Build / run / test

```
npm run build            # tsc → dist/*.js
npm test                 # node --test, ~30s
npm run build:dashboard  # Angular build into dist/dashboard
npm run dev:install      # tsc + dashboard + npm link  (use for local iteration)
```

The daemon runs on `127.0.0.1:<config.apiPort>` (default `4999`). Tests **never** start the real daemon — they exercise modules in isolation against synthetic state.

## Things daimon never does

- Never bind a non-loopback interface. The server hard-codes `127.0.0.1`.
- Never edit user source. `daimon doctor --auto-fix` only repairs `~/.daimon/*` and the daemon's own state.
- Never run install commands. `npm install`, `npm ci`, package-manager upgrades — all off-limits.
- Never push to git or run `npm publish`. The human (Yosi) does that, with 2FA.
- Never share `yosi@flycotech.com` in published artifacts. Public author is `Yosi Azulay (https://flycotech.com)`.
- Never mutate global state outside `~/.daimon/*` and a local `daimon.config.json`.
- Plug-ins are opt-in but NOT sandboxed: they run in-process with full Node privileges, so daimon only loads files the user placed in `~/.daimon/plugins` themselves. Treat them as trusted code, not a confined extension (see `src/plugins.ts`).

## Conventions

- TS strict mode (3 tsconfig projects: root, dashboard/app, vscode-extension).
- Tests run against compiled `dist/*.js`, not `src/*.ts` — always `npm run build` before `npm test`.
- New HTTP endpoints belong in `server.ts` and follow the `parts[]` switch pattern.
- New MCP tools belong in `mcp.ts` and use `callJson(...)` so the X-Daimon-Agent header is forwarded.
- New CLI verbs go in `cliSurface.ts` (one entry per verb), then dispatch in `cli.ts`'s `switch (cmd)`.
- New audit columns must keep the older row count parseable — `parseAuditLine` already handles 5- and 6-col rows.
- New tests must be added to the `test` script in `package.json` (`node --test test/foo.test.mjs ...`).
- **New framework = registry row + fixture, never a discovery.ts branch.** Add a `FrameworkProfile` row in `src/frameworks.ts` and a fixture dir in `test/fixtures/frameworks/<id>/` (marker files + `fixture.json` with startup/error output). The parameterized suite (`test/frameworks.test.mjs`) fails if a built-in profile ships without a fixture.
- **New test runner = parser + fixture, same convention (M74).** Add the parser in `src/testRunners.ts`, its id to `KNOWN_TEST_RUNNER_IDS`, and a fixture in `test/fixtures/testrunners/<id>/` (marker files + `fixture.json` with pass/fail/mixed cases). `test/testrunners.test.mjs` fails on a runner without a fixture. Parsers are fail-soft: no totals is acceptable, fabricated totals are not.
- **State paths go through `daimonDir()`** (`src/daemon.ts`) — never `os.homedir() + '.daimon'` directly. `DAIMON_HOME` relocates the whole state dir; tests isolate with it instead of overriding HOME/USERPROFILE.
- **History migrations are additive** (`CREATE TABLE IF NOT EXISTS` only) — a v0.11 DB must open cleanly under v0.12 and vice versa.

## v0.12 highlights (what landed this release)

- **`daimon test` (M74–M75)**: wraps the project's own runner (never installs one); parsed failures with file:line; `test_runs`/`test_failures` tables; soft-lock gated (409/exit 5); flaky detection (≥3 pass↔fail flips at the same gitHead → one `flaky-test-detected` event, threshold `tests.flakyThreshold`); dashboard Tests page = run history + run diff + flaky badges.
- **Crash forensics (M76)**: unrequested child exits persist crash reports (exit info + last 50 log lines + gitHead), ring-buffered 10/app; `restart-storm` fires once per storm (`restartStorm.perHour`, default 20); `daimon why <app>` / `GET /api/why/<app>` one-shot composition; doctor rules `restart-storm`, `searchroot-hygiene` (suggest-only), `daimon-home`.
- **FTS search (M77)**: `daimon search` / `GET /api/search` over events, errors, and per-app log lines; log indexing default-on with `search.logIndex` / `overrides.<app>.logIndex` opt-out; deferred indexing (see history.ts note above); LIKE fallback + one-time self-warn on FTS failure.
- **Context pack (M78)**: `daimon context <app> [--budget <chars>]` / `GET /api/context/<app>` — composition only, no new state; drop order compile→agents→crashes→tests→errors, status never drops, drops listed in `truncated[]`; MCP `daimon_context`/`daimon_run_tests`/`daimon_why`/`daimon_search` (25 tools).
- **M79**: deno + bun runtime profiles; `DAIMON_HOME`; `daimon logs --grep [--stream]` (server-side regex, live SSE filter); dashboard onboarding tour (dismiss-once) + PWA manifest.
- New event kinds (all webhook-eligible): `test-run`, `test-failed`, `flaky-test-detected`, `crash`, `restart-storm`.

## Where to look next

- `PLAN-v0.12.md` — the v0.12 milestones (M74–M80) in spec form.
- `RELEASE-v0.12.0.md` — release notes with migration steps.
- `CHANGELOG.md` — chronological log of every shipped release.
- `daimon.config.example.json` — every config key with safe defaults.
