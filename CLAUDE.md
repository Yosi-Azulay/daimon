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
  ports.ts          # PortAllocator (persisted assignments) + parsePortPool ("4200-4299").
  portDiag.ts       # Port forensics (M81): findPortHolder, one-shot scanListeningPorts
                    # (netstat -ano / ss), daimon signature probe, EADDRINUSE
                    # message composition, verify-then-kill helper.
  envFiles.ts       # Env awareness (M82): dotenv parse + spawn snapshots.
                    # REDACTION RULE: raw values die in the same tick — parsed,
                    # HMAC'd (per-install salt at ~/.daimon/salt, truncated to
                    # 12 hex), and discarded inside snapshotEnvFiles. Only key
                    # names + hashes exist beyond that frame; API responses
                    # carry names only (hashes stay server-side). No flag may
                    # ever print a value.
  report.ts         # `daimon report` (M83): pure composition over history
                    # queries; closed section list; every section degrades to a
                    # { note } independently. Bench budget <500ms on 100k events.
  testRunners.ts    # Test-runner registry (M74): 5 fixture-gated parsers
                    # (vitest-jest/pytest/go-test/cargo-test/dotnet-test), runner
                    # resolution (overrides.<app>.testCommand > profile testRunner hint
                    # > package.json test script), execution with tree-kill timeout,
                    # and query-derived flaky detection (M75).
  audit.ts          # Tab-delimited audit log; 6 columns (5-col rows still parse).
  webhooks.ts       # Outbound webhooks: queue + rate limit + Slack/Discord shape detection.
                    # Per-app scoping via webhooks[].apps + overrides.<app>.webhooks (M72).
                    # DigestScheduler (M84): webhooks[].digest "HH:MM" — ONE 1-min
                    # interval check (not a cron engine), catch-up at most once,
                    # never more than one send per day per webhook (persisted
                    # last-sent in state.json), delivery via the normal queue.
  notifier.ts       # OS notifications (M84): kind routing (notifications.kinds,
                    # absent = legacy set), same-fingerprint batching (batchMs),
                    # quiet hours + one exit summary, per-app mute via
                    # Registry.isMuted. Injectable sink/clock for tests.
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
- **Port injection is registry-declared (M81).** Profiles get a pool port ONLY via `portFlag` (template with `{port}`) / `portEnv` fields — set them only where the framework documents the mechanism. No `ports.pool` config = legacy behavior (blanket `--port` + `PORT`). Never guess a flag.
- **Env values are redacted at the storage layer (M82).** `snapshotEnvFiles` parses, hashes, and discards raw values in one tick. Nothing downstream (DB, events, webhooks, notifications, API, CLI) may ever carry a value — `test/env-awareness.test.mjs` has a grep-style suite enforcing it. There is deliberately no `--show-values`.
- **Orphan takeover is verify-then-kill (M81).** Doctor's `port-holder-no-lock` auto-fix kills the apiPort holder only when it answers on `GET /api/signature` AND no live lock exists, re-verified at fix time. Anything else: identify + advise.
- **The digest is not a cron engine (M84).** One 1-minute interval in `DigestScheduler`; catch-up at most once; per-webhook last-sent persisted in state.json. Don't add more timers.
- **New test runner = parser + fixture, same convention (M74).** Add the parser in `src/testRunners.ts`, its id to `KNOWN_TEST_RUNNER_IDS`, and a fixture in `test/fixtures/testrunners/<id>/` (marker files + `fixture.json` with pass/fail/mixed cases). `test/testrunners.test.mjs` fails on a runner without a fixture. Parsers are fail-soft: no totals is acceptable, fabricated totals are not.
- **State paths go through `daimonDir()`** (`src/daemon.ts`) — never `os.homedir() + '.daimon'` directly. `DAIMON_HOME` relocates the whole state dir; tests isolate with it instead of overriding HOME/USERPROFILE.
- **History migrations are additive** (`CREATE TABLE IF NOT EXISTS` only) — a v0.11 DB must open cleanly under v0.12 and vice versa.

## v0.13 highlights (what landed this release)

- **Ports (M81)**: `ports.pool` opt-in auto-assignment; `portFlag`/`portEnv` registry fields (documented mechanisms only); `daimon ports` / `GET /api/ports`; `GET /api/signature`; EADDRINUSE startup forensics (holder pid/name/start + signature probe + remedy + crash dump); lock written only after a successful bind; doctor `port-holder-no-lock` (verify-then-kill) + pool-aware `port-conflict-pred`.
- **Env awareness (M82)**: registry `envFiles` conventions; spawn snapshots → `env_snapshots` table (names + salted truncated hashes, values discarded same-tick, salt at `~/.daimon/salt`); `daimon env` / `env diff`; `why` gains `envChanged`; doctor `env-file-missing` (suggest-only); redaction suite.
- **Report (M83)**: `daimon report [--since --app --workspace --md]` / `GET /api/report[?md=1]` — composition only, closed section list, per-section degradation to notes; bench <500ms on the 100k corpus; dashboard Report page (lazy chunk).
- **Notifications (M84)**: `notifications.{kinds,quietHours,batchMs}` (all optional = legacy behavior); same-fingerprint batching; quiet hours + one exit summary; `daimon mute/unmute` persisted in state.json and surfaced as `muted` in summaries; `webhooks[].digest "HH:MM"` daily report via the normal queue, Slack-shaped, catch-up once; `digest-sent` event.
- **M85**: TUI `T` chord (run tests inline; `t` = tag filter); dashboard why panel, search deep-links, Trends test pass-rate + flaky series, mute badge.
- MCP: `daimon_report`, `daimon_env` (27 tools).

Key v0.12 context that still matters: `daimon test` wraps the project's own runner (soft-lock gated, flaky detection via `tests.flakyThreshold`); crash reports ring-buffer 10/app; FTS search is deferred-indexed (see history.ts note); `daimon context` is composition-only with a drop order.

## Where to look next

- `PLAN-v0.13.md` — the v0.13 milestones (M81–M86) in spec form.
- `RELEASE-v0.13.0.md` — release notes with migration steps.
- `CHANGELOG.md` — chronological log of every shipped release.
- `daimon.config.example.json` — every config key with safe defaults.
