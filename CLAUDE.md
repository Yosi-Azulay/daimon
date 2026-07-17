# daimon — orientation for future agents

`daimon` is a local-only dev-server manager (Angular/Nx/Vite/Storybook + polyglot) with a TUI, an HTTP API on `127.0.0.1`, a JSON CLI, and an MCP server for Claude Code. Loopback only; no remote, no cloud sync, no multi-user.

If you arrive here mid-task, this file is what you need to know about the codebase.

## Where things live

```
src/
  cli.ts            # Argv dispatch. Adds X-Daimon-Agent + X-Daimon-Cwd to every HTTP call.
                    # Warns once on stderr when the daemon's x-daimon-version header
                    # mismatches (M88) — never hard-fails on skew.
  cliSurface.ts     # Single source of truth for CLI verbs (rendered in --help, README,
                    # completion). Every verb declares a `stability` tier (M87).
  stability.ts      # The Stability type ('frozen'|'stable'|'experimental') — see STABILITY.md.
  httpSurface.ts    # HTTP endpoint catalog (M87): one row per server.ts route, with tier.
  main.ts           # Daemon entry point. Boots Registry / History / Server / WebhookDispatcher / TUI.
                    # Crash-recovery ORDER (M88, documented at the top of startInProcess):
                    # recover state → verify locks → re-adopt/orphan handoff children → serve.
  server.ts         # HTTP routes. Per-app soft-lock gating + audit log writes live here.
                    # Every JSON response carries x-daimon-version (M88 skew detection).
  registry.ts       # In-memory app/event/error book-keeping. Emits 'event' to dispatcher subscribers.
  history.ts        # SQLite-backed events / compiles / bundles / tasks / test runs /
                    # crashes (ring 10/app) / log lines / self-metrics.
                    # Auto-archives a corrupt DB on startup as history.db.corrupt-<ts>.
                    # FTS5 search (M77) uses DEFERRED indexing via fts_state high-water
                    # marks — never add per-insert FTS triggers (measured 4-10× on the
                    # write path); sync runs on idle flush ticks, before retention, and
                    # before every search. FTS failure degrades to LIKE, never blocks.
  groups.ts         # Named app groups (M93, v1.1): resolution (resolveGroup /
                    # groupUpPlan / groupStopOrder), boot autoStartPlan (dedup at
                    # resolution — one spawn, one log line), validateGroups warnings.
                    # Groups READ the depends graph (topoLevels/transitiveClosure),
                    # never change it; they additively subsume the legacy profiles
                    # map (group wins name collisions, with a validate warning).
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
test/               # node --test suite. 571 test cases (v0.14); files run in parallel child processes.
vscode-extension/   # VS Code extension (published as flycotech.daimon). Independent package.json.
```

## Build / run / test (verified commands)

| Purpose | Command (repo root unless noted) | Runtime | Success signal |
|---|---|---|---|
| Build daemon | `npm run build` | ~5s | exit 0, silent; `dist/*.js` refreshed |
| Full test suite | `npm test` | ~2 min | TAP tail: `# pass 571`, `# fail 0` |
| One test file | `node --test test/<name>.test.mjs` | 3–60s | `# fail 0` |
| Dashboard unit | `npx vitest run` (in `dashboard/`) | ~5s | `Tests  17 passed` |
| Dashboard bundle | `npm run build:dashboard` | ~30s | `Application bundle generation complete` → `dist/dashboard` |
| VS Code ext compile | `npm run compile` (in `vscode-extension/`) | ~3s | exit 0 |
| Docs regen | `npm run build:docs` | ~1s | `[build-docs] wrote …docs/index.html` (idempotent — needs fresh `dist/`) |
| CLI smoke | `DAIMON_NO_SPAWN=1 node dist/cli.js --help` | <1s | usage text, exit 0 |

`npm run dev:install` = tsc + dashboard + npm link, for local iteration (links the global `daimon`).
Dashboard Playwright e2e needs a live daemon and seeds the real `~/.daimon/history.db` — see `/verify` before running it.

The daemon runs on `127.0.0.1:<config.apiPort>` (default `4999`). Tests **never** start the real daemon — they exercise modules in isolation against synthetic state.

**Flaky-failure protocol:** since v0.14 (M91) the two historically contention-flaky files are contention-immune — `history-stress` passes on an absolute budget OR a ratio to an interleaved CPU reference (external load inflates both; a real regression inflates only the numerator), and `ports` forensics tests use a generous probe ceiling (they assert classification, not speed). A failure there is now likely REAL: re-run the file alone to confirm, then investigate. Never loosen a perf budget to silence a flake. One residual flake class: running two copies of `ports.test.mjs` simultaneously collides on its fixed 434xx test ports — don't do that.

## Claude toolkit (`.claude/`)

- `/verify` — the local CI gate; run it before claiming any change done.
- `/add-framework` — new `FrameworkProfile` registry row + fixture.
- `/add-test-runner` — new test-runner parser + fixture.
- `/add-cli-verb` — new verb across the whole surface (cliSurface → cli → server → mcp → docs).
- `/cut-release` — version bump → gates → tag. User-invoked only; never publishes or pushes.
- `/review-daimon` — multi-agent diff review across daimon's five recurring failure classes.
- `/daimon-pm` — product planning / milestone-review playbook.
- Agents: `daimon-test-runner` (haiku — runs the suite, returns structured failures), `daimon-reviewer` (opus — single-agent review against the failure classes).

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
- **Every surface declares a stability tier (M87).** New CLI verbs, HTTP endpoints, MCP tools, config keys, and event kinds MUST carry `frozen`/`stable`/`experimental` at their source of truth (`cliSurface.ts` / `httpSurface.ts` / `mcp.ts` MCP_TOOL_STABILITY / `config.ts` CONFIG_KEY_STABILITY / `types.ts` EVENT_KIND_STABILITY). New work defaults to experimental. A `frozen` surface needs a golden-shape snapshot in `test/fixtures/contract/` — `test/contract.test.mjs` fails without one, and fails forever on a frozen-shape change (regenerate with `UPDATE_CONTRACT_SNAPSHOTS=1` only for reviewed ADDITIVE changes). See STABILITY.md.
- **State writes are atomic with a .bak (M88).** Every `~/.daimon/*.json` the daemon rewrites (state.json, session-state.json, config rewrites) goes tmp → copy-current-to-.bak → rename. `state.json` load order: main → `.bak` → archive as `state.json.corrupt-<ts>` + fresh start, with a self-warn event (never silent). Torture coverage: `test/lifecycle-torture.test.mjs`.
- **Daemon handoff is verify-then-adopt (M88).** `daimon daemon restart` leaves children RUNNING (registry handoff flag, 60s window); the incoming daemon re-adopts a child only when the handoff-recorded LISTENING pid is alive AND still the port's listener. Anything else → status `orphaned` + a per-case remedy, never a blind kill. The handoff file records the listener pid (findPortHolder at snapshot time), NOT the spawn/shell pid — on Windows the wrapper dies with the daemon's pipes.
- **Config back-compat is unbreakable.** Unknown config keys warn (with a nearest-name suggestion) and are ignored — `daimon config validate` checks offline; loading NEVER fails on old or unknown keys.
- **Error strings carry remedies (M90).** Every user-facing error says what to do next; `test/error-remedies.test.mjs` scans cli.ts/server.ts/main.ts and fails on bare errors. EADDRINUSE forensics is the model.
- **Groups subsume profiles additively (M93, v1.1).** The `groups` config key's shorthand form is exactly the legacy `profiles` shape; `profiles` keeps loading forever and its behavior is byte-identical. Precedence: groups resolve first on `up`/`down`; on the frozen `stop` verb an APP of the name always wins and the group resolves only where the verb previously errored. Name collisions warn ("group wins") in `daimon config validate`. Groups consume the depends graph via depends.ts — never add ordering logic outside src/groups.ts/orchestrate.ts. On `daimon errors`, bare `--group` keeps fingerprint grouping; `--group <name>` filters (value `fingerprint` reserved). Post-1.0 rule: every new surface declares a stability tier at its source of truth and ships `experimental`.

## v1.1 highlights (what landed this release)

- **Named app groups (M93–M98)**: `groups` config key (shorthand string[] or `{ apps, autoStart }`, normalized at load; `src/groups.ts` resolution module); `daimon up/stop/down <group>` with depends-aware topo order, `"3/4 healthy"` readiness summary, per-member soft-lock gating, exit 0/2 semantics; `POST /api/groups/:name/up|stop` (audit-logged) + `GET /api/groups` and `/api/groups/:name/status|logs`; `--group <g>` filters on list/status/errors/report (`?group=` server-side, byte-identical shapes when absent); autoStart groups at boot (dedup at resolution — one spawn, one log line naming every source); TUI `G` chord + dashboard group chips/sections/detail row; MCP `ensure_up` group-first + `daimon_groups` (28 tools). All new surfaces `experimental`. Tests live in `test/groups.test.mjs`, `test/group-updown.test.mjs`, `test/group-filters.test.mjs`, `test/group-autostart.test.mjs`.

## v0.14 highlights

- **Stability tiers (M87)**: every CLI verb / HTTP endpoint / MCP tool / config key / event kind declares frozen/stable/experimental at its source of truth; docs render badges; `test/contract.test.mjs` pins golden shapes (key sets + types) for all frozen surfaces from a synthetic Registry+startServer harness (fixtures in `test/fixtures/contract/`; regenerate via `UPDATE_CONTRACT_SNAPSHOTS=1`). STABILITY.md defines the tiers. Deliberate exception: `GET /api/signature` is frozen despite its v0.13 birth (cross-version identification).
- **Last-call breaking fixes (M87, the last ever)**: compact-status `uptime` → `uptimeMs` (CLI status / HTTP compact / ensure / MCP get_status / daemon status); `daimon list --tag/--workspace` filters server-side (`?tag=&workspace=`) instead of silently switching to the full shape (also fixed `--tag --compact` returning `[]`). Additive: `/wait` accepts `timeoutMs`.
- **Lifecycle (M88)**: version-skew stderr warning via `x-daimon-version` response header; atomic state + `.bak` + archive-corrupt recovery (stateFile/sessionState/configManager/health-pin); handoff re-adoption (children survive `daimon daemon restart`; verify-then-adopt by listener pid + port; `orphaned` status + remedy for the unverifiable); crash-recovery order documented in main.ts; `test/lifecycle-torture.test.mjs` (real daemon spawns under DAIMON_HOME isolation).
- **WCAG AA dashboard pass (M89)**: keyboard-only routes, token-layer contrast, ARIA landmarks/labels/aria-live, prefers-reduced-motion, `@axe-core/playwright` gate (zero serious/critical, both viewports) in the Playwright drive.
- **First-15 + errors (M90)**: README stranger rewrite (verified end-to-end on clean DAIMON_HOME); SECURITY.md; every error names its remedy (`test/error-remedies.test.mjs`).
- **Debt (M91)**: AttachApp uses `daimonDir()`; parser.ts literal NUL bytes replaced with \u0000 string escapes (grep-clean tree); contention-immune perf tests; `daimon config validate` + load-time unknown-key warnings with nearest-name suggestions (`CONFIG_KEY_STABILITY` is the schema); fixed `daimon profiles suggest` (multi-word alias dispatch — shipped broken in v0.12–v0.13); npm pack audit test + files whitelist now ships docs/ and daimon.config.example.json; doctor coverage table (`DOCTOR_COVERAGE` in doctor.ts → docs).

## v0.13 highlights

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
