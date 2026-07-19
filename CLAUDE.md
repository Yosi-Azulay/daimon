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
  logLevels.ts      # Log-level classification (M99, v1.2): registry patterns first
                    # (first match wins) chained to a conservative generic heuristic;
                    # FAIL-SOFT — any miss/throw stores level null, never drops a line.
  logStorm.ts       # Log-storm detection (M101, v1.2): per-app rolling lines/min
                    # baseline in memory; one log-storm event on entry, one
                    # log-storm-end on recovery. Baseline FROZEN at entry, exit at
                    # half the entry threshold (hysteresis) — flapping can't spam.
                    # One 15s unref'd tick only to end storms of silent apps.
  usage.ts          # UsageMonitor: the ONE 2s pidusage poll (live TUI numbers) +
                    # the M105 per-app downsampler (resources.sampleMs, default 30s,
                    # 0 disables) feeding resource_samples + the resource guard.
                    # Never add a second poller.
  resources.ts      # Resource guardrails (v1.3, M107/M108): pure, IMPORT-FREE
                    # detector module — leak suspicion, cpu-storm, warn-only
                    # budgets. Self-calibrating (warm-up median + MAD per run;
                    # multipliers are internal constants, never config). One
                    # event per episode, re-arm on return-to-baseline/restart.
                    # WARN, NEVER KILL: no resource code path can signal a
                    # process — test/resource-guardrails.test.mjs greps for it.
  export.ts         # `daimon export` (M111, v1.4): the ONE-WAY carry-out bundle —
                    # composition over existing queries + the M83 report in a
                    # versioned envelope (schemaVersion 1, additive-only, readers
                    # ignore unknown keys). No import exists, ever (import edges
                    # toward sync — standing NO). Sections degrade to { note };
                    # md/csv renderers + the atomic --out helper live here too.
  plugins.ts        # Plugin API v1 (M116, v1.5): loadPlugins (validate-per-file,
                    # never throws) + PluginHost (off-write-path dispatch via one
                    # setImmediate; frozen snapshots; first hook throw = session-
                    # disable + one plugin-error event). Observe + advise-only
                    # doctor rules ONLY — no mutating hooks in v1. NOT sandboxed
                    # (trusted-by-placement); see PLUGINS.md.
  agents.ts         # Agent identity (`<host>-<pid>-<rand4>`) + 30s per-app LockManager.
                    # LockManager ring tags each event outcome (denied / steal-live /
                    # steal-after-expiry / acquired / handoff) and derives contention
                    # analytics (waits, steal split, longest hold) — memory-only,
                    # never persisted (M124, v1.6). Identity stays ADVISORY.
  auditQuery.ts     # Queryable view over the audit trail (M122, v1.6): PURE reader
                    # over audit.log + audit.log.1. Derives { ts, agent, action,
                    # app, changedKeys, remote } rows from the verb:<app> convention
                    # (NO new column). Fail-soft: malformed lines counted in
                    # `skipped`, never fabricated. Roster + report analytics DERIVE
                    # from these rows at query time (no new state, no timer).
  sessions.ts       # Session derivation (M134, v1.8): sessions are DERIVED,
                    # never stored — a session is a contiguous daemon-uptime
                    # slice bounded by the __daemon__ daemon-start/daemon-stop
                    # lifecycle events. Pure composition over History queries
                    # (deriveBoundaries → listSessions/showSession); unclean
                    # closure at last-observed event; deterministic s-<startMs>
                    # ids; per-slice counts via history.sliceCounts (windowed
                    # SQL aggregates, NOT a 100k-row JS scan — benched <300ms so
                    # NO cache ships). buildSessionContext feeds `why` (M138).
  away.ts           # "While you were away" (M135, v1.8): gap detection (4h
                    # fixed constant, NO config key) + report-subset extraction.
                    # REUSES the report composition — no new engine, no new
                    # timer. Dismissal acks to state.json (awayAck). Pure.
  ports.ts          # PortAllocator (persisted assignments) + parsePortPool ("4200-4299").
  portDiag.ts       # Port forensics (M81): findPortHolder, one-shot scanListeningPorts
                    # (netstat -ano / ss), daimon signature probe, EADDRINUSE
                    # message composition, verify-then-kill helper. v1.9 (M141):
                    # pure per-tool parsers (parseNetstat/parseSs/parseLsof*) +
                    # an injectable command-runner seam (CmdRunner + platform) so
                    # the POSIX side is fixture-tested; the ss parser is field-
                    # addressed (M140 fix — the old regex read the Recv-Q column).
  platformInventory.ts # Platform-branch inventory (M140, v1.9): PLATFORM_BRANCHES
                    # data table — one row per process.platform fork (behavior +
                    # verdict + named gap). Rendered as the docs "Platform support"
                    # table; test/platform-inventory.test.mjs greps dist/ and fails
                    # if any platform token escapes the table (completeness gate).
  platformRemedy.ts # Platform-aware remedy phrasing (M143, v1.9): killCmd /
                    # inspectPortCmd / killHint — taskkill vs kill, netstat vs
                    # lsof. One helper, injectable platform; no per-callsite
                    # `process.platform ===` sprawl.
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
                    # and query-derived flaky detection (M75). v1.7 adds TEST_RUNNER_META
                    # rows: supportsCoverage + parseCoverage (M128) and rerunFlag (M131,
                    # composeRerunCommand) — declared per runner, documented formats only.
  quarantine.ts     # Flaky quarantine (M130, v1.7): pure `*`-glob matcher over a
                    # test's `suite > test` name + first-seen reconciliation. Quarantined
                    # tests still run + record — annotated, excluded from flaky detection
                    # + alert noise, dated so a parked test can't rot invisibly.
  audit.ts          # Tab-delimited audit log; 6 columns (5-col rows still parse).
                    # v1.6 widened WRITE coverage: lifecycle actions (start/stop/
                    # restart/steal/handoff/mute/unmute) leave a `verb:<app>` row in
                    # the SAME 6-col format — appendAuditEntry unchanged, no new column.
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
completions/        # GENERATED shell completion (bash/zsh/powershell) — never hand-edit.
                    # Regen: npm run build:completions; drift-gated by test/completion.test.mjs.
scripts/demo/       # Deterministic screencast session (M114) — throwaway DAIMON_HOME only.
scripts/platform-smoke.sh # (M143, v1.9) ~2-min PASS/FAIL probe for a REAL Mac/Linux box.
                    # POSIX sh, zero deps, throwaway DAIMON_HOME; --dry-run runs the
                    # plumbing on any host. The human runs it before publish.
test/               # node --test suite. 971 test cases (v1.9); files run in parallel child processes.
                    # test/helpers/platformSkip.mjs + test/fixtures/platform/<tool>/ (M141-M142).
vscode-extension/   # VS Code extension (published as flycotech.daimon). Independent package.json.
```

## Build / run / test (verified commands)

| Purpose | Command (repo root unless noted) | Runtime | Success signal |
|---|---|---|---|
| Build daemon | `npm run build` | ~5s | exit 0, silent; `dist/*.js` refreshed |
| Full test suite | `npm test` | ~1–2 min | TAP tail: `# pass 865`, `# fail 0` |
| One test file | `node --test test/<name>.test.mjs` | 3–60s | `# fail 0` |
| Dashboard unit | `npx vitest run` (in `dashboard/`) | ~5s | `Tests  68 passed` (count grows; signal is 0 failed) |
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
- Plug-ins are opt-in but NOT sandboxed: they run in-process with full Node privileges, so daimon only loads files the user placed in `~/.daimon/plugins` themselves. Treat them as trusted code, not a confined extension. No marketplace, no remote fetch, no auto-install — ever (see `src/plugins.ts`, PLUGINS.md).

## Conventions

- TS strict mode (3 tsconfig projects: root, dashboard/app, vscode-extension).
- Tests run against compiled `dist/*.js`, not `src/*.ts` — always `npm run build` before `npm test`.
- New HTTP endpoints belong in `server.ts` and follow the `parts[]` switch pattern.
- New MCP tools belong in `mcp.ts` and use `callJson(...)` so the X-Daimon-Agent header is forwarded. Resources (`registerResource`) and prompts (`registerPrompt`) go there too (M125, v1.6) — resources wrap existing endpoints via `callJson`; prompts render from live API data (never canned); each declares a tier in `MCP_RESOURCE_STABILITY` / `MCP_PROMPT_STABILITY` and gets a `test/mcp-contract.test.mjs` case. Never bump the MCP SDK for a new capability — verify the shipped version supports it, else STOP and ask.
- New CLI verbs go in `cliSurface.ts` (one entry per verb), then dispatch in `cli.ts`'s `switch (cmd)`.
- New audit columns must keep the older row count parseable — `parseAuditLine` already handles 5- and 6-col rows.
- New tests must be added to the `test` script in `package.json` (`node --test test/foo.test.mjs ...`).
- **New framework = registry row + fixture, never a discovery.ts branch.** Add a `FrameworkProfile` row in `src/frameworks.ts` and a fixture dir in `test/fixtures/frameworks/<id>/` (marker files + `fixture.json` with startup/error output). The parameterized suite (`test/frameworks.test.mjs`) fails if a built-in profile ships without a fixture.
- **Port injection is registry-declared (M81).** Profiles get a pool port ONLY via `portFlag` (template with `{port}`) / `portEnv` fields — set them only where the framework documents the mechanism. No `ports.pool` config = legacy behavior (blanket `--port` + `PORT`). Never guess a flag.
- **Env values are redacted at the storage layer (M82).** `snapshotEnvFiles` parses, hashes, and discards raw values in one tick. Nothing downstream (DB, events, webhooks, notifications, API, CLI) may ever carry a value — `test/env-awareness.test.mjs` has a grep-style suite enforcing it. There is deliberately no `--show-values`.
- **Orphan takeover is verify-then-kill (M81).** Doctor's `port-holder-no-lock` auto-fix kills the apiPort holder only when it answers on `GET /api/signature` AND no live lock exists, re-verified at fix time. Anything else: identify + advise.
- **The digest is not a cron engine (M84).** One 1-minute interval in `DigestScheduler`; catch-up at most once; per-webhook last-sent persisted in state.json. Don't add more timers.
- **New test runner = parser + fixture, same convention (M74).** Add the parser in `src/testRunners.ts`, its id to `KNOWN_TEST_RUNNER_IDS`, and a fixture in `test/fixtures/testrunners/<id>/` (marker files + `fixture.json` with pass/fail/mixed cases). `test/testrunners.test.mjs` fails on a runner without a fixture. Parsers are fail-soft: no totals is acceptable, fabricated totals are not.

- **Coverage is parsed where documented, fixture-gated, null over fabricated — the same law as test totals (M128, v1.7).** daimon reads the coverage summary the run ALREADY printed (istanbul text table/summary, pytest-cov `TOTAL`, go `-cover`) — it never injects a coverage flag or edits a test config. A runner opts in via `TEST_RUNNER_META[id].supportsCoverage` + a `parseCoverage`; that gates a `coverage` block in its fixture (with-coverage → the documented %, without/malformed → null) enforced by `test/testrunners.test.mjs`. Fail-soft is absolute: absent/unparseable/out-of-range (`<0`/`>100`) → null, always; a fabricated percentage is the same violation as a fabricated pass count. cargo/dotnet ship WITHOUT coverage (no confirmed documented default) — explicit non-participation, never a guess. Storage is the additive nullable `covLinesPct`/`covStmtsPct` columns on `test_runs` (guarded ALTER); summary numbers only, no per-file storage ever.

- **`--failed` rerun is registry-declared — the portFlag discipline (M131, v1.7).** `daimon test <app> --failed` reruns only the last recorded run's failures, and ONLY where the runner's `TEST_RUNNER_META` row declares a `rerunFlag` (pytest `--lf` stateful; go `-run {tests}` regex-escaped alternation; jest/vitest/dotnet name-filter). Templates come from the runner's docs, never guessed — no `rerunFlag` = explicit non-participation. It NEVER silently falls back to a full run: no prior run, undeclared runner, and unparseable names each return an error naming the gap + a remedy; an all-green prior run is an honest no-op. The run records with the additive `failedOnly` flag; totals reflect only what ran.
- **Sessions are DERIVED, never stored (M134, v1.8).** A session is a
  contiguous daemon-uptime slice bounded by the `__daemon__` `daemon-start` /
  `daemon-stop` lifecycle events already in history — there is NO sessions
  table, NO session events, NO new analytics state, NO history migration.
  `src/sessions.ts` derives them by pure composition over existing History
  queries (the report/context discipline): a start opens a slice, its matching
  stop closes it cleanly; a boot with no intervening stop closes the previous
  slice unclean at its last observed event; the newest open slice is `current`.
  IDs are deterministic (`s-<startMs>`) so deep links never rot. Per-slice
  counts use `history.sliceCounts` (windowed, indexed SQL COUNT/DISTINCT — never
  a full-table JS scan). Derivation benched **< 300ms on the 100k corpus**, so
  no cache ships; any future cache must be a rebuildable in-memory boundary map
  (never a table) and invalidate on retention — measure first. The two boundary
  event kinds are the ONLY new storage, and they are additive `experimental`
  markers recorded exactly like `self-warn`/`digest-sent` (main.ts records
  `daemon-start` first at boot so recovery self-warns land inside the slice, and
  `daemon-stop` before `history.close()` which flushes synchronously — a handoff
  restart records it too, since each daemon uptime is one session).
- **"While you were away" reuses the report composition (M135, v1.8).** The away
  summary is NOT a new engine and NOT a new timer — `src/away.ts` derives the
  gap baseline from the session list + the `awayAck` state.json key and pulls a
  strict subset (new/resolved errors, crashes, env changes) out of a `buildReport`
  window. The 4h gap is a fixed constant (zero new config keys). The TUI composes
  it in-process at start; the dashboard calls `GET /api/report?since=`. Dismissal
  merge-writes `awayAck` (additive state.json key). The digest's single 1-min
  interval stays the ONLY scheduler.
- **State paths go through `daimonDir()`** (`src/daemon.ts`) — never `os.homedir() + '.daimon'` directly. `DAIMON_HOME` relocates the whole state dir; tests isolate with it instead of overriding HOME/USERPROFILE.
- **Every platform branch is inventoried, fixture-tested, and honestly labeled (M140–M143, v1.9).** The dev box is Windows; POSIX behavior is proven via recorded-output fixtures + injectable seams (the `platform`/`CmdRunner` parameter pattern), NEVER by pretending to run on Linux. Three binding rules: (1) **a `process.platform`/`os.platform()` fork needs a row in `src/platformInventory.ts`** — `test/platform-inventory.test.mjs` greps `dist/` and fails if any token escapes the table (the docs "Platform support" page renders from that same data). (2) **A parser/branch with a Windows fixture gets a POSIX one** in `test/fixtures/platform/<tool>/` with a provenance note, fed through the production parse path via the injectable runner (no test-only fork) — deleting a fixture fails the suite. (3) **Platform-conditional tests SKIP LOUDLY** via `platformSkip(t, plat, note)` (`test/helpers/platformSkip.mjs`) — a bare `if (isWin)` or `process.platform … return` is a defect; `test/platform-skips.test.mjs` asserts the skip set against a committed expectation and fails on a silent gate. Support-matrix statuses are earned: `verified` (real test on that OS), `fixture-verified` (recorded-output test), `best-effort` (only `scripts/platform-smoke.sh` on real hardware) — never asserted. User-facing OS commands route through `src/platformRemedy.ts` (taskkill vs kill), never a per-callsite `process.platform ===`.
- **History migrations are additive** — `CREATE TABLE IF NOT EXISTS`, plus (since v1.2) a guarded nullable `ALTER TABLE … ADD COLUMN` (check `PRAGMA table_info` first; column must be nullable; every INSERT names its columns so an older daimon keeps writing the same table). Never a rename, drop, retype, or NOT NULL addition — a v0.11 DB must open cleanly under v1.2 and vice versa.
- **Every surface declares a stability tier (M87).** New CLI verbs, HTTP endpoints, MCP tools, config keys, and event kinds MUST carry `frozen`/`stable`/`experimental` at their source of truth (`cliSurface.ts` / `httpSurface.ts` / `mcp.ts` MCP_TOOL_STABILITY / `config.ts` CONFIG_KEY_STABILITY / `types.ts` EVENT_KIND_STABILITY). New work defaults to experimental. A `frozen` surface needs a golden-shape snapshot in `test/fixtures/contract/` — `test/contract.test.mjs` fails without one, and fails forever on a frozen-shape change (regenerate with `UPDATE_CONTRACT_SNAPSHOTS=1` only for reviewed ADDITIVE changes). See STABILITY.md.
- **State writes are atomic with a .bak (M88).** Every `~/.daimon/*.json` the daemon rewrites (state.json, session-state.json, config rewrites) goes tmp → copy-current-to-.bak → rename. `state.json` load order: main → `.bak` → archive as `state.json.corrupt-<ts>` + fresh start, with a self-warn event (never silent). Torture coverage: `test/lifecycle-torture.test.mjs`.
- **Daemon handoff is verify-then-adopt (M88).** `daimon daemon restart` leaves children RUNNING (registry handoff flag, 60s window); the incoming daemon re-adopts a child only when the handoff-recorded LISTENING pid is alive AND still the port's listener. Anything else → status `orphaned` + a per-case remedy, never a blind kill. The handoff file records the listener pid (findPortHolder at snapshot time), NOT the spawn/shell pid — on Windows the wrapper dies with the daemon's pipes.
- **Config back-compat is unbreakable.** Unknown config keys warn (with a nearest-name suggestion) and are ignored — `daimon config validate` checks offline; loading NEVER fails on old or unknown keys.
- **Error strings carry remedies (M90).** Every user-facing error says what to do next; `test/error-remedies.test.mjs` scans cli.ts/server.ts/main.ts and fails on bare errors. EADDRINUSE forensics is the model.
- **Groups subsume profiles additively (M93, v1.1).** The `groups` config key's shorthand form is exactly the legacy `profiles` shape; `profiles` keeps loading forever and its behavior is byte-identical. Precedence: groups resolve first on `up`/`down`; on the frozen `stop` verb an APP of the name always wins and the group resolves only where the verb previously errored. Name collisions warn ("group wins") in `daimon config validate`. Groups consume the depends graph via depends.ts — never add ordering logic outside src/groups.ts/orchestrate.ts. On `daimon errors`, bare `--group` keeps fingerprint grouping; `--group <name>` filters (value `fingerprint` reserved). Post-1.0 rule: every new surface declares a stability tier at its source of truth and ships `experimental`.

- **Log-level classification is registry-declared and fail-soft (M99, v1.2).** A framework's level convention lives in its `FrameworkProfile.logLevelPatterns` row (ordered `{ pattern, level }`, first match wins, compiled once) — set ONLY where the framework documents its output format, fixture-gated like every registry field: a profile shipping patterns without covering `logLines` cases in its fixture fails `test/frameworks.test.mjs`, and so does a pattern no fixture line exercises. Profiles without documented conventions get NO patterns (the shared generic heuristic in logLevels.ts applies — never guess). Classification chains registry rows → generic heuristic → null and is FAIL-SOFT at ingest: any miss or throw stores the line with `level` null — a classifier bug may never drop or delay a log line. Storage is the additive nullable `level` column on `log_lines` (guarded ALTER; old rows read null). `--level` filters exclude unclassified lines by design.
- **Log-storm detection is hysteresis-gated (M101, v1.2).** `src/logStorm.ts` keeps a per-app rolling lines/min baseline in memory (no tables); entry = observed ≥ `multiplier` × max(baseline, 1 line/min) with the baseline FROZEN at entry; exit at half the entry threshold — a flapping rate cannot spam events. Apps with <3 min of history never storm; `registry.start()` resets the app's rate history (fresh process, fresh baseline). Exactly one `log-storm` and one `log-storm-end` event per episode. The OS-notification kind `log-storm` is opt-in via `notifications.kinds`; the only timer is one 15s unref'd sweep that ends storms of silent apps — never add more.

- **Resource guardrails WARN, NEVER KILL (v1.3, M105–M108).** No enforcement, no
  auto-restart, no throttling, ever: the resource modules contain no code path
  that can stop a process — `resources.ts` imports NOTHING (grep-enforced by
  `test/resource-guardrails.test.mjs`, which also asserts behaviorally that
  firing every resource event kind moves app state by zero fields). Sampling
  rides the existing UsageMonitor poll (one timer — the digest-is-not-a-cron
  ethos); heuristics self-calibrate against each app's own warm-up baseline
  (median + MAD) with internal-constant multipliers — never a config knob, never
  a magic absolute (the one floor pattern follows logStorm's 1-line/min
  precedent). Budgets (`resources.rssMb/cpuPct` + per-app overrides) are the
  only absolute comparisons because the USER set them — and they still only
  warn. New notification kinds are opt-in via `notifications.kinds`. Every
  remedy string restates "daimon only warns — it never kills".

- **Export is ONE-WAY and versioned (v1.4, M111).** `src/export.ts` composes the
  carry-out bundle from EXISTING queries (events / live fingerprint-folded error
  groups / test runs / compiles / crashes / the M83 report) — never re-derives,
  never adds analytics state. The envelope carries `schemaVersion` (integer,
  starts at 1): evolution is ADDITIVE-ONLY and readers must ignore unknown keys;
  its shape is snapshot-pinned in `test/fixtures/contract/http-get-api-export.json`
  even though the surface is `experimental` — it is a consumed format. There is
  NO `daimon import` and never will be (import edges toward sync, a standing NO).
  Redaction extends to bundles: no env value and no personal email in ANY format
  (json/md/csv) — asserted by `test/export.test.mjs` and the env-awareness
  redaction suite. No raw log-line section, ever — crash rows keep only their
  existing bounded tail. `--out` writes tmp+rename (M88 rule). CSV is a flat
  `section,ts,app,summary,detail` view, documented as lowest-common-denominator,
  not a second schema. Export bench: full JSON bundle over the 100k corpus
  < 750ms (`test/export.test.mjs`), alongside report's 500ms.

- **Completion is generated, never hand-edited (M113, v1.4).** All four shell
  completion generators in `src/cliHelp.ts` derive from `CLI_SUBCOMMANDS` — one
  shared model, so the shells cannot drift from each other or from the surface.
  Committed output lives in `completions/` (bash/zsh/powershell; LF-pinned via
  `.gitattributes`), regenerated by `npm run build && npm run build:completions`;
  `test/completion.test.mjs` diffs regenerated-vs-committed byte-for-byte, so a
  hand edit or a forgotten regen after a cliSurface change fails the suite. The
  only hand-maintained piece is `VERB_SUBWORDS` (literal dispatch subwords for
  verbs whose `args` is free text, e.g. `daemon start|stop`, `env diff`) — a new
  such verb needs a row there. `completions/` deliberately ships OUTSIDE the npm
  tarball (users run `daimon completion <shell>`), keeping pack-audit stable.

- **The demo script owns a throwaway home (M114, v1.4).** `scripts/demo/run-demo.mjs`
  spawns a real daemon under a temp `DAIMON_HOME` + separate temp workspace
  (the lifecycle-torture recipe), drives a fixed CLI session, and removes both
  temp dirs in a `finally` — it must never touch the real `~/.daimon`, and
  `test/demo-script.test.mjs` asserts it (exact mtime/size snapshot equality
  when no real daemon is live; structural no-paths-added/removed when one is,
  because a live daemon rewrites session-state.json on its own clock). Gotchas
  it codifies: fixture banners must match a `SERVING_PATTERNS` regex to reach
  'serving'; an ERROR_PATTERNS line flips status to 'error' even while the
  process serves; sequential CLI calls need one pinned `DAIMON_AGENT_ID` or
  they trip each other's soft-locks; CLI `cwd` (workspace) and `DAIMON_HOME`
  (state) must stay separate params. GIF recording stays human.

- **Plugin API v1 is observe-only and crash-isolated (v1.5, M116–M117).** A
  plugin exports `{ name, apiVersion: 1, onEvent?, onAppStart?, onAppStop?,
  registerDoctorRules? }` — nothing a hook returns is consumed except doctor
  rules (advise-only, no auto-fix), and hooks receive FROZEN copies: no v1
  hook can mutate app state, config, or history (a mutating hook is a
  different, unplanned apiVersion). Dispatch is off the event write path (one
  setImmediate, zero when no plugin subscribes — benched in
  `test/plugins.test.mjs`). Isolation semantics: throw at load → that file is
  `load-error`, siblings load; first throw in any hook (sync or async
  rejection) → session-disable with exactly one `plugin-error` self-event —
  NEVER a daemon-down, torture-gated by `test/plugin-isolation.test.mjs`.
  Unknown `apiVersion` → skip + self-warn naming the supported version.
  `registerDoctorRules()` runs once at load; its throw is a load-error, while
  a rule `check()` throw is a session-disable. Example plugins live in
  `examples/plugins/` and ship in the repo but NOT the npm tarball
  (pack-asserted); PLUGINS.md cookbook embeds are diffed byte-for-byte
  (`test/plugins-docs.test.mjs`) — edit the example and the manual together.
  Legacy `{ name, scan }` doctor plug-ins deliberately stopped loading in
  v1.5 (migration message points at PLUGINS.md).

- **The agent ledger is DERIVED, never stored (M122–M124, v1.6).** Agent
  identity stays ADVISORY — the `X-Daimon-Agent` header, unauthenticated, said
  so in every output/doc. `daimon audit` / `GET /api/audit` read the audit log
  (`audit.log` + `audit.log.1`) through `src/auditQuery.ts` and derive rows from
  the append-forever `verb:<app>` changedKeys convention — the ONE permanent
  decision of the release: widened WRITE coverage (start/stop/restart/steal/
  handoff/mute/unmute) reuses the existing 6-col format, adds NO column, and
  `parseAuditLine` keeps reading 5- and 6-col rows. Parsing is fail-soft:
  malformed lines are counted in `skipped`, never fabricated, never an error.
  The roster (`daimon agents` / the additive `roster`+`contention` keys on the
  UNCHANGED `GET /api/agents`) and the report's deepened `agents` section are
  computed at query time from audit rows + the in-memory `AgentRegistry` +
  `LockManager` — NO new table, NO new persisted file, NO new timer, NO history
  migration. Lock contention (waits/steals/longest-hold) lives in the
  LockManager's memory-only ring; durable live-steal counts come from
  `steal:<app>` audit rows so they survive a restart. New MCP surfaces
  (`daimon_audit`, `daimon_agents`, the `daimon://report|context/{app}|logs/{app}`
  resources, the `triage`/`handoff` prompts) go through `callJson` with
  `X-Daimon-Agent` forwarded and are contract-tested in `test/mcp-contract.test.mjs`.
  SDK gate (M125): the shipped `@modelcontextprotocol/sdk` 1.29.0 exposes
  `registerResource`/`registerPrompt`/`ResourceTemplate` cleanly — verified, no
  upgrade, no new dep. Every v1.6 surface ships `experimental`; the roster,
  resources, and prompts declare tiers at their source of truth
  (`httpSurface.ts`, `MCP_TOOL_STABILITY` / `MCP_RESOURCE_STABILITY` /
  `MCP_PROMPT_STABILITY`).

## v1.9 highlights (what landed this release)

- **Everywhere (M140–M144)**: macOS/Linux certification — no schema/config/dep
  change, no history migration; every new surface `experimental`. **Platform
  inventory (M140)**: `src/platformInventory.ts` tables every `process.platform`
  fork (behavior + verdict + named gap), rendered as the docs "Platform support"
  table, grep-gated by `test/platform-inventory.test.mjs` so no branch escapes.
  **Flagship fix (M140)**: the `ss -ltnp` parser read the Recv-Q column and
  returned nothing on Linux — now field-addressed + fixture-gated (`daimon ports`
  was silently blind on its main POSIX platform). **POSIX fixtures + seam
  (M141)**: `portDiag.ts` gains pure per-tool parsers + an injectable
  `CmdRunner`/`platform` seam; `test/fixtures/platform/<tool>/` (ss/lsof/netstat/
  ps/powershell, incl. no-permission/IPv6/container variants + provenance) run
  through the production path in `test/port-forensics.test.mjs` as win32 AND
  linux/darwin; non-port seams (`resolveCommand`/`buildServiceArtifact`/
  `isSystemDir`/`normalizeForCompare`) got a `platform` param + both-branch tests.
  **Loud skips (M142)**: `platformSkip` helper + `test/platform-skips.test.mjs`
  accounting (asserts the committed skip set, prints `# platform-skips: N`, fails
  on any silent `if (isWin)`/`process.platform … return`). **Remedies + matrix +
  smoke (M143)**: `src/platformRemedy.ts` (taskkill vs kill, netstat vs lsof)
  feeds the EADDRINUSE remedy; README support matrix (verified/fixture-verified/
  best-effort, BSD = best-effort in those words); `scripts/platform-smoke.sh` — a
  ~2-min real-hardware PASS/FAIL probe (throwaway DAIMON_HOME, `--dry-run` for any
  host). Suite **971 tests**, 0 fail. Tests: `test/platform-inventory.test.mjs`,
  `test/port-forensics.test.mjs`, `test/platform-seams.test.mjs`,
  `test/platform-skips.test.mjs`, `test/platform-remedies.test.mjs`,
  `test/smoke-script.test.mjs`.

## v1.8 highlights (what landed this release)

- **Rewind (M134–M139)**: history becomes walkable. **Session derivation
  (M134)**: `daimon sessions [--since --json]` / `sessions show <id>` /
  `GET /api/sessions*` / MCP `daimon_sessions` (**33 tools**) — DERIVED
  daemon-uptime slices (see the sessions-are-derived rule above), deterministic
  `s-<startMs>` ids, unclean-exit closure, per-slice counts, `< 300ms` bench,
  no cache. Two additive `experimental` event kinds `daemon-start`/`daemon-stop`
  under `__daemon__` are the only new storage. **While you were away (M135)**:
  4h-gap summary reusing the report composition (no new engine/timer), TUI
  header line + dashboard panel, `awayAck` in state.json. **TUI timeline chord
  (M136)**: `i` opens hour/day bucket navigation (density strip, arrows, g/G
  edges, Enter drill, n/p app state-change jumps), windowed query on open. **Dashboard
  timeline (M137)**: brush/zoom + kind filter + keyboard/aria-live; deep-link
  convergence `?ts=&app=&kind=&session=` (search hits + why panel resolve here).
  **why sessionContext (M138)**: additive same-session errors/env/regressions,
  degradable, links to the timeline. All new surfaces `experimental`; no frozen
  shape moved; no config or history migration. Tests: `test/sessions.test.mjs`,
  `test/away.test.mjs`, `test/tui-timeline-chord.test.mjs`, plus the dashboard
  timeline Playwright/axe spec.

## v1.7 highlights (what landed this release)

- **Test Sense 2 (M128–M133)**: `daimon test` learns coverage, quarantine, and
  failed-only reruns — deepening the wrap around the project's own runner, never
  replacing it. **Coverage capture (M128)**: per-runner parsers over
  already-emitted output (vitest/jest istanbul, pytest-cov `TOTAL`, go `-cover`;
  cargo/dotnet explicitly out), additive nullable `covLinesPct`/`covStmtsPct` on
  `test_runs`, `coverage: { linesPct, statementsPct } | null` on `daimon test` /
  `GET /api/tests`, `supportsCoverage` fixture gate incl. malformed→null.
  **Coverage trends (M129)**: dashboard Trends coverage line beside pass-rate +
  flaky, nulls render as gaps (`alignSeriesNullable`), no new CLI verb. **Flaky
  quarantine (M130)**: optional `tests.quarantine: string[]` glob patterns —
  matched tests still run + record, gain the additive `quarantined` column,
  excluded from flaky detection + notification noise; per-pattern first-seen in
  state.json ("oldest since"), overview badge. **`daimon test --failed` (M131)**:
  registry-declared `rerunFlag` per runner, reruns only the last run's failures,
  additive `failedOnly` column, never a silent full-run fallback. **Report + why
  deepening (M132)**: tests section gains coverage delta + quarantine count/age;
  `why` gains a quarantine line; digest inherits. All new surfaces
  `experimental`; no frozen shape moved; no config or history migration beyond
  additive columns + an optional config sub-key. Tests: `test/coverage-capture.test.mjs`,
  `test/quarantine.test.mjs`, `test/failed-rerun.test.mjs`, plus coverage/rerun
  cases in `test/testrunners.test.mjs` and coverage+quarantine in `test/report.test.mjs`.

## v1.6 highlights (what landed this release)

- **Agent Ledger (M122–M127)**: `daimon audit [--agent --app --since --limit
  --json]` / `GET /api/audit` (queryable trail over the audit log; 5/6-col rows
  fail-soft with a `skipped` count); `daimon agents [--json]` roster deepened
  (`roster` + `contention` additive on `GET /api/agents`; `(unknown)`
  aggregation; advisory-identity disclaimer); lock analytics (denial /
  steal-after-expiry vs live tagging, waits + longest holds) + report `agents`
  section deepening (top agents, contention hotspots) inside the closed section
  list, report bench budget kept; MCP deepening — resources `daimon://report`,
  `daimon://context/{app}`, `daimon://logs/{app}` + prompts `triage`/`handoff`
  (rendered from live API data) + tools `daimon_audit`/`daimon_agents`
  (**32 tools**); dashboard agents panel (roster, action chips, contention,
  timeline deep-links) + soft-lock badge on app cards. All new surfaces
  `experimental`; no frozen shape moved; no config or history migration. Tests:
  `test/agent-ledger.test.mjs` (query + roster + routes + report deepening),
  `test/agents.test.mjs` (LockManager analytics), `test/mcp-contract.test.mjs`
  (tools + resources + prompts).

## v1.5 highlights (what landed this release)

- **Plugin API v1 (M116–M121)**: the hook surface + isolation above;
  `daimon plugins [--json]` / `GET /api/plugins` / MCP `daimon_plugins`
  (31 tools) with status `active`|`disabled`|`load-error`; doctor
  `plugin-load-error` (advise-only, never touches user plugin files) +
  plugin rules as `plugin:<name>/<rule>` checks; `/api/overview` additive
  `plugins` count badge (dashboard overview tile, Playwright + axe covered
  via `dashboard/e2e/plugins-badge.spec.ts` route interception); PLUGINS.md
  (trust model verbatim, no-sandbox statement) + two exercised examples.
  All new surfaces `experimental`. Tests: `test/plugins.test.mjs` (rewritten),
  `test/plugin-isolation.test.mjs`, `test/plugin-surfaces.test.mjs`,
  `test/plugin-examples.test.mjs`, `test/plugins-docs.test.mjs`.

## v1.4 highlights (what landed this release)

- **Carry-out (M111–M115)**: `daimon export [--since --app --format json|md|csv]
  [--out]` / `GET /api/export` / MCP `daimon_export` (30 tools) — the one-way
  versioned bundle (see the convention above); dashboard Report print stylesheet
  (token-layer `@media print`, Playwright `emulateMedia` verified); shell
  completion regenerated from `cliSurface.ts` with committed `completions/`
  output + drift test; deterministic demo script in `scripts/demo/` (throwaway
  `DAIMON_HOME`, real state dir provably untouched); deferred-stretch sweep
  recorded in RELEASE-v1.4.0.md. All new surfaces `experimental`. Tests:
  `test/export.test.mjs`, `test/completion.test.mjs`, `test/demo-script.test.mjs`.

## v1.3 highlights

- **Guardrails (M105–M110)**: `resource_samples` table (additive, retention-pruned)
  fed by a downsampler on the UsageMonitor poll (`resources.sampleMs`, 0 disables;
  fail-soft per app; write-path + sampling-CPU benches in
  `test/resource-sampling.test.mjs`); `daimon top` / `GET /api/top` / MCP
  `daimon_top` (29 tools) — live RSS-sorted table, nulls never errors;
  self-calibrating leak suspicion (`resource-leak-suspect`) and CPU storms
  (`cpu-storm`) with episode/re-arm semantics; warn-only budgets
  (`resource-budget-exceeded`); Trends rss/cpu series; `why` gains
  `resources` + `resourceNote` (crash inside an open suspicion window); doctor
  `cpu-storm-active` (advise-only); report `resources` section (degradable).
  All new surfaces `experimental`. Tests: `test/resource-sampling.test.mjs`,
  `test/resource-top.test.mjs`, `test/resource-leak.test.mjs`,
  `test/resource-guardrails.test.mjs`, `test/resource-surfacing.test.mjs`.

## v1.2 highlights

- **Log sense (M99–M104)**: registry-declared `logLevelPatterns` for angular/nx/vite/nextjs/django/flask/rails/dotnet + generic fallback, additive nullable `level` column; `daimon logs --level` (+ `?level=` on `/api/apps/:name/logs`, its SSE stream (also `?levels=1` per-line level field), `/api/groups/:name/logs`; MCP `get_logs` gains `level`/`grep`); log-storm detector (`logs.storm` config, `log-storm`/`log-storm-end` events, opt-in notification kind, doctor `log-storm-active` suggest-only rule, `logStorm` in `why` + status summaries); report errors section gains a `logVolume` line (degrades to a note); TUI level-cycle + inline-grep chords; dashboard level chips / regex filter / storm banner / search deep-links. All new surfaces `experimental`. Tests: `test/log-levels.test.mjs`, `test/logs-filtering.test.mjs`, `test/log-storm.test.mjs`, `test/tui-log-chord.test.mjs`.

## v1.1 highlights

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
