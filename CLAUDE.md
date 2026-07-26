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
                    # v1.10 (M146): open-time verification is depth-tiered — full
                    # integrity_check only when the clean-shutdown marker
                    # (user_version) is absent; otherwise a bounded structural probe.
                    # FTS5 search (M77) uses DEFERRED indexing via fts_state high-water
                    # marks — never add per-insert FTS triggers (measured 4-10× on the
                    # write path); sync runs on idle flush ticks, before retention, and
                    # before search — but BOUNDED since v1.10: a backlog over
                    # FTS_INLINE_SYNC_MAX answers from the complete LIKE path instead
                    # of stalling. FTS failure degrades to LIKE, never blocks.
                    # Retention is TIME-SLICED (M147): ~50ms slices, never one long
                    # block; RETENTION_TABLES order is load-bearing (children first).
  groups.ts         # Named app groups (M93, v1.1): resolution (resolveGroup /
                    # groupUpPlan / groupStopOrder), boot autoStartPlan (dedup at
                    # resolution — one spawn, one log line), validateGroups warnings.
                    # Groups READ the depends graph (topoLevels/transitiveClosure),
                    # never change it; they additively subsume the legacy profiles
                    # map (group wins name collisions, with a validate warning).
  graph.ts          # READ-ONLY depends-graph view (M175, v1.15): buildGraphView
                    # composes registry summaries + config.depends + v1.1 groups
                    # into { nodes, edges, levels, cycles, unordered, groups } —
                    # pure, never starts/stops anything (grep-gated by
                    # test/graph.test.mjs). Owns the ONE workspace-matching rule
                    # (effectiveWorkspaceLabel = label ?? basename(root)) every
                    # ?workspace= surface + both switchers use. Group rows carry
                    # the EXACT groupUpPlan `up` executes, so previews can't
                    # drift. TTY tree renderer lives here too.
  tui/chords.ts     # The ONE chord map (M163, v1.13): every TUI chord as data
                    # (key, pane scope, description, group, legacy aliases).
                    # Dispatch + the `?` overlay + per-pane footers + the docs
                    # cheat sheet + the README table ALL render from it. Chords
                    # are PANE-SCOPED — `l`/`/`/`g`/`G` each mean one thing in
                    # the app list and another in the log pane.
  tui/theme.ts      # The ONE terminal palette (M165, v1.13): DESIGN.md's roles
                    # with a truecolor → 16-color → NO_COLOR ladder. A
                    # hard-coded color in a TUI component is a DEFECT.
  tui/layout.ts     # Pure pane geometry, narrow-terminal column priority, list
                    # windowing, status-bar segments (M162/M166, v1.13).
  tui/SearchPane.tsx# The TUI search pane (M182, v1.16) + tui/searchChord.ts (its
                    # pure logic). Runs the SAME parser and prints the SAME
                    # error text as the daemon — searching IN-PROCESS via the
                    # shared History, never a second grammar or a second code
                    # path. Row formatting is width-bounded and strips control
                    # characters (a log line may not repaint the terminal).
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
  searchQuery.ts    # The search query language (M179, v1.16): the ONE source of
                    # the grammar (app:/kind:/level:/before:/after:/"phrases"/
                    # bare terms) as a PURE, IMPORT-FREE parser. It parses; it
                    # never queries — compilation into SQL lives in history.ts,
                    # where filters become WHERE clauses on real columns (never
                    # FTS tricks), which is what makes the syntax behave
                    # identically on the LIKE fallback. SEARCH_FIELDS is the
                    # docs table too — no second copy of the grammar exists.
  savedSearches.ts  # Saved searches (M181, v1.16): pure list transforms
                    # (save/rename/delete + validation via the real parser).
                    # INERT BY CONSTRUCTION — nothing here schedules, runs, or
                    # notifies; the caller owns persistence (state.json
                    # merge-write). test/saved-searches.test.mjs greps dist/.
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
  init.ts           # `daimon init` (M168, v1.14): a UI over discoverApps(), NOT a
                    # second detector — buildProposal() runs the real scan with cwd
                    # as the proposed searchRoot. Writes EXACTLY ONE file
                    # (daimon.config.json in cwd) and starts nothing.
  mcp.ts            # MCP server. Wraps the HTTP API and forwards X-Daimon-Agent.
  ...
dashboard/          # Angular 20 SPA bundled into dist/dashboard/.
bench/              # Perf harness + committed baselines (M145-M148, v1.10). Corpora cached
                    # under bench/.corpus (gitignored, never shipped). npm run bench.
completions/        # GENERATED shell completion (bash/zsh/powershell) — never hand-edit.
                    # Regen: npm run build:completions; drift-gated by test/completion.test.mjs.
scripts/demo/       # Deterministic screencast session (M114) — throwaway DAIMON_HOME only.
scripts/platform-smoke.sh # (M143, v1.9) ~2-min PASS/FAIL probe for a REAL Mac/Linux box.
                    # POSIX sh, zero deps, throwaway DAIMON_HOME; --dry-run runs the
                    # plumbing on any host. The human runs it before publish.
test/               # node --test suite. 1216 test cases (v1.16); files run in parallel child processes.
                    # NEVER run a bench (npm run bench) and npm test at the same
                    # time — they contend and produce spurious failures.
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

- **Deep-link back-compat is a HARD RULE, and dashboard work RECOMPOSES — it never adds endpoints (M156–M161, v1.12).** Every URL shape the dashboard ever exposed must keep resolving — a redirect is fine, a 404 never is. That includes every `routes.ts` path, the v0.13 search/why deep-links, the v1.8 timeline query links (`/timeline?ts=&app=&kind=&session=`), the app-detail `?tab=` inputs, AND the app-detail **section anchors** `#overview/#errors/#logs/#tests/#timeline/#why` (once shipped, a fragment id never renames — the rule applies to fragments too). `dashboard/e2e/route-audit.ts` is the checked-in inventory of every shape and `redirects.spec.ts` drives it as a gate. The information architecture is defined ONCE in `dashboard/src/app/nav-model.ts` (the three task groups Observe/Investigate/Configure + the pure `contextForUrl` resolver) — the nav rail, the topbar breadcrumb, and the shortcuts-help table all consume it so they cannot drift. The home (`/`), app-detail, and command palette COMPOSE what `daimon-api.ts` already exposes — **nothing lands in `server.ts`**; no new HTTP endpoint, no new analytics, no new state, no new config key, no new dep. A dashboard feature that needs a new endpoint is out of scope, not a new route. The apps list lives at `/apps` since v1.12; `/` is the overview home (old `/` deep-links still resolve to it). The command palette is one fuzzy-ranked list (ranking is pure functions in `command-palette-helpers.ts`, unit-tested; `>` still forces search-only; recents are navigation-only, never replayed actions).
- **The dashboard has a designed visual language, and it lives in tokens (M150, v1.11).** `DESIGN.md` (repo root) is the contract — principles + the full `--dm-*` token scale (color/spacing/type/radius/elevation/motion) for both themes and both densities, with the token-level AA table. Everything themable is a `--dm-*` custom property in `dashboard/src/styles/tokens.css`; a component that hard-codes a color is a **defect**, not a style choice. Contrast fixes land at the token layer, never in a component (the M89 discipline). Color roles are the language's own OKLCH values (authored as `light-dark()`), and tokens.css **re-points** the consumed `--mat-sys-*` Material roles onto them — so Material widgets track the language too; do not re-introduce raw `--mat-sys-*` reads in components. The one exception: `--dm-chart-*` ship as theme-split sRGB **hex** (not `light-dark()`/`oklch()`), because Chart.js reads them via `getComputedStyle` and its parser accepts only hex/rgb — see the tokens.css header. `DESIGN.md` is inherited by v1.12 (IA) and v1.13 (TUI); AA is a floor verified at the token level AND by the axe gate on every route at both viewports.
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
- **Performance budgets are DERIVED from a committed baseline, never typed in (M145–M148, v1.10).**
  The rule, in one line: `budget = measured quiet-machine baseline p95 × a
  per-class headroom factor` (interactive 2×, startup 2.5×, query 3×, batch 3×,
  write 4× — the factors are policy and live in `bench/lib/machine.mjs`;
  everything else is measurement). Baselines live in `bench/BASELINE-v1.10*.json`
  and are recorded by `--write`, which REFUSES to run on a machine that is not
  quiet — quietness is two signals, CPU-reference dispersion **and** system-wide
  busy fraction, because dispersion alone reported "quiet" on a 20-core box
  while the full suite was running. Every budget carries a second, contention
  axis (pass on the absolute OR on the ratio to an interleaved CPU reference,
  ceiling derived as `budget ÷ baseline cpuRef × 3`), so external load cannot
  fake a regression. **A red budget means investigate; loosening it is not an
  available move.** MEASURE FIRST: no optimization lands without a before/after
  number against the committed baseline.
- **The 1M-event corpus is the scale fixture (M146, v1.10).** `bench/lib/corpus.mjs`
  seeds it deterministically (fixed-seed mulberry32 — the seeder never reads the
  clock; the anchor is a parameter) and caches it under `bench/.corpus/`, which
  is gitignored and never shipped. It is ANCHORED so its newest rows land today
  and it stretches 90 days back, and `corpusReady` rebuilds it once it is older
  than 7 days — `why` and `context` query hardcoded last-24h/last-7d windows, so
  a corpus pinned to a fixed calendar epoch would silently certify the speed of
  querying nothing. Bump `SEEDER_VERSION` on any composition change. Run the
  gates with `npm run bench` (or `bench:baselines` / `bench:scale` / `bench:write`
  / `bench:startup`); never run a bench and `npm test` at the same time — they
  contend, and the contention shows up as spurious failures in
  `lifecycle-torture` and `demo-script`.
- **History verification is depth-tiered, and the tier is earned (M146, v1.10).**
  `PRAGMA integrity_check` is O(database size) — 8.5s per open on the 1M corpus —
  so it no longer runs on every open. `close()` records a clean-shutdown marker
  in SQLite's `user_version` header field; an open whose DB carries that marker
  gets a bounded structural probe (O(tables)), and an open WITHOUT it still gets
  the full check, because corruption comes from unclean shutdown and disk
  failure. Secondary handles pass `{ verify: 'skip' }` and must never write the
  clean marker — the primary owner is still running. `daimon doctor` keeps the
  deep check and opens history exactly ONCE per sweep (grep-gated in
  `test/history-verify.test.mjs`); request paths that don't surface the finding
  pass `historyHealth: false`. Old and new DBs interoperate in both directions:
  a pre-v1.10 DB has no marker and simply takes the full check.
- **Retention is time-sliced and search degrades rather than stalls (M146–M147, v1.10).**
  Pruning yields every ~50ms (`RETENTION_SLICE_MS`) instead of blocking the loop
  for 28.8s, but its SEMANTICS are unchanged — every expired row still goes, and
  `RETENTION_TABLES` order is load-bearing (`test_failures` before `test_runs`,
  or an interrupted pass orphans rows). `search()` no longer syncs FTS
  unbounded: a backlog over `FTS_INLINE_SYNC_MAX` answers from the LIKE path
  instead, which is COMPLETE (it scans the base tables, so read-your-writes
  still holds) and merely slower. That distinction is the rule — **a
  wrong-but-fast answer is worse than a slow one**; never cache or truncate a
  result to hit a budget.
- **`daimon init` is a UI over discovery, and it writes ONE file (M168, v1.14).**
  init must never carry its own detection logic — `buildProposal()` calls
  `discoverApps()` with cwd as the proposed searchRoot, so a new
  `FrameworkProfile` row reaches the wizard for free and init can never
  disagree with `daimon list` about what is in the folder. The forked
  four-marker `MARKERS` list was deleted in v1.14; do not reintroduce one. The
  `runInit` module writes **exactly `daimon.config.json` in cwd** — no
  `~/.daimon` write, no second file, no source edit, no `.env` read beyond
  discovery's own, no daemon start (the closing lines POINT at `daimon daemon
  start` / `daimon claude install`). A filesystem-sentinel test in
  `test/init-wizard.test.mjs` asserts it, with its own isolated `DAIMON_HOME`
  (never guard that assertion behind optional env — the branch silently dies).
  Note the CLI *process* may still touch daimon's own state dir for ordinary
  bookkeeping (`cli-sessions.json`, the version nudge); the promise is about
  the user's project, so phrase it that way in user-facing copy.
  **Overwrite safety is absolute**: `--yes` refuses when a config exists,
  interactive asks and leaves the file byte-identical on decline, `--force` is
  the only silent overwrite — all three tested. Decide occupancy with
  **`lstat`, never `existsSync`**: a dangling symlink at the config path reads
  as "nothing here" and the write then lands on the link's target outside cwd.
  The write is tmp+rename, and writing THROUGH a symlink is refused outright.
- **Documentation that claims a command is TESTED as a command (M170, v1.14).**
  `QUICKSTART.md` is executed by `test/quickstart.test.mjs`: every fenced
  `bash` block runs, in page order, against a clean `DAIMON_HOME` in a temp
  workspace. A block is exempt only via `<!-- quickstart:skip <reason> -->`,
  the reason is asserted non-empty, and the exemption count is capped — so the
  page cannot quietly stop being true. Markers: `quickstart:config` (the one
  json block, validated by the daemon's own loader and written as the
  fixture's config), `quickstart:fresh` (runs in a pristine copy — the `daimon
  init` alternative path), `quickstart:exit 0,1 <why>` (allowed exit codes).
  This gate starts a REAL daemon: it must use a fresh random port per run and
  verify-then-kill its own daemon in `finally`, or an orphan squats the port
  forever once its DAIMON_HOME is deleted. It also runs **alone** — the `test`
  script is `node --test <parallel files> && node --test test/quickstart.test.mjs`
  — because a real daemon plus a real dev server inside the 40-way parallel
  suite made `plugin-isolation` and `resource-sampling` flake. When a heavy
  integration test destabilises neighbours, isolate the load; **never loosen
  the neighbour's budget** to absorb it.
- **One terminal is ONE agent (v1.14).** `generateAgentId()` keys identity off
  a TERMINAL SESSION, because a fresh id per CLI process made `daimon start
  web` and the `daimon stop web` typed a second later look like two competing
  agents, so the 30s soft lock denied the second command — the first thing a
  stranger tries. Two rules that a first attempt got wrong, so don't repeat
  them: (1) **`process.ppid` is NOT a session key** — Git Bash/MSYS forks a
  process per command, so a ppid-derived id silently degrades to per-process
  there; the emulator vars (`WT_SESSION`, `TERM_SESSION_ID`, `ITERM_SESSION_ID`,
  `TMUX_PANE`, `SSH_TTY`) come first and ppid is only the fallback. (2) **The
  4-hex suffix must stay real entropy** — deriving it from the session key made
  two shells that reuse an OS pid byte-identical, and `LockManager.acquire`
  then REFRESHES the other agent's live lock instead of denying it: no denial,
  no steal, no audit row, M124's protection invisible rather than merely
  permissive. The suffix is random, minted once per session and remembered in
  `~/.daimon/cli-sessions.json` (TTL'd, tmp+rename). Identity stays ADVISORY,
  and an explicit `DAIMON_AGENT_ID` still wins. Tests must spawn from
  genuinely DIFFERENT sessions — children of one test process share a parent by
  construction, which is how the first version's test passed while asserting
  nothing.
- **First-run doctor rules are suggest-only (M171, v1.14).**
  `config-wrong-directory`, `daemon-not-started`, `no-apps-detected`, and
  `port-pool-absent` catch the mistakes strangers actually make. None gets an
  auto-fix — nothing here meets the verify-then-kill bar. `no-apps-detected`
  names the likeliest cause from discovery's own `stats.rejected` tally, never
  a generic guess, and `config-wrong-directory` fires only when the CALLER
  passes the path it actually loaded (doctor never re-resolves config itself,
  and never invents a `--config` flag daimon does not have).
- **State paths go through `daimonDir()`** (`src/daemon.ts`) — never `os.homedir() + '.daimon'` directly. `DAIMON_HOME` relocates the whole state dir; tests isolate with it instead of overriding HOME/USERPROFILE.
- **Every platform branch is inventoried, fixture-tested, and honestly labeled (M140–M143, v1.9).** The dev box is Windows; POSIX behavior is proven via recorded-output fixtures + injectable seams (the `platform`/`CmdRunner` parameter pattern), NEVER by pretending to run on Linux. Three binding rules: (1) **a `process.platform`/`os.platform()` fork needs a row in `src/platformInventory.ts`** — `test/platform-inventory.test.mjs` greps `dist/` and fails if any token escapes the table (the docs "Platform support" page renders from that same data). (2) **A parser/branch with a Windows fixture gets a POSIX one** in `test/fixtures/platform/<tool>/` with a provenance note, fed through the production parse path via the injectable runner (no test-only fork) — deleting a fixture fails the suite. (3) **Platform-conditional tests SKIP LOUDLY** via `platformSkip(t, plat, note)` (`test/helpers/platformSkip.mjs`) — a bare `if (isWin)` or `process.platform … return` is a defect; `test/platform-skips.test.mjs` asserts the skip set against a committed expectation and fails on a silent gate. Support-matrix statuses are earned: `verified` (real test on that OS), `fixture-verified` (recorded-output test), `best-effort` (only `scripts/platform-smoke.sh` on real hardware) — never asserted. User-facing OS commands route through `src/platformRemedy.ts` (taskkill vs kill), never a per-callsite `process.platform ===`.
- **History migrations are additive** — `CREATE TABLE IF NOT EXISTS`, plus (since v1.2) a guarded nullable `ALTER TABLE … ADD COLUMN` (check `PRAGMA table_info` first; column must be nullable; every INSERT names its columns so an older daimon keeps writing the same table). Never a rename, drop, retype, or NOT NULL addition — a v0.11 DB must open cleanly under v1.2 and vice versa.
- **Every surface declares a stability tier (M87).** New CLI verbs, HTTP endpoints, MCP tools, config keys, and event kinds MUST carry `frozen`/`stable`/`experimental` at their source of truth (`cliSurface.ts` / `httpSurface.ts` / `mcp.ts` MCP_TOOL_STABILITY / `config.ts` CONFIG_KEY_STABILITY / `types.ts` EVENT_KIND_STABILITY). New work defaults to experimental. A `frozen` surface needs a golden-shape snapshot in `test/fixtures/contract/` — `test/contract.test.mjs` fails without one, and fails forever on a frozen-shape change (regenerate with `UPDATE_CONTRACT_SNAPSHOTS=1` only for reviewed ADDITIVE changes). See STABILITY.md.
- **State writes are atomic with a .bak (M88).** Every `~/.daimon/*.json` the daemon rewrites (state.json, session-state.json, config rewrites) goes tmp → copy-current-to-.bak → rename. `state.json` load order: main → `.bak` → archive as `state.json.corrupt-<ts>` + fresh start, with a self-warn event (never silent). Torture coverage: `test/lifecycle-torture.test.mjs`.
- **Daemon handoff is verify-then-adopt (M88).** `daimon daemon restart` leaves children RUNNING (registry handoff flag, 60s window); the incoming daemon re-adopts a child only when the handoff-recorded LISTENING pid is alive AND still the port's listener. Anything else → status `orphaned` + a per-case remedy, never a blind kill. The handoff file records the listener pid (findPortHolder at snapshot time), NOT the spawn/shell pid — on Windows the wrapper dies with the daemon's pipes.
- **Config back-compat is unbreakable.** Unknown config keys warn (with a nearest-name suggestion) and are ignored — `daimon config validate` checks offline; loading NEVER fails on old or unknown keys.
- **Error strings carry remedies (M90).** Every user-facing error says what to do next; `test/error-remedies.test.mjs` scans cli.ts/server.ts/main.ts and fails on bare errors. EADDRINUSE forensics is the model.
- **The graph is READ-ONLY visualization, and the workspace preference is client-side (M173–M177, v1.15).**
  Three binding rules. (1) The graph view (`/graph`), `daimon graph`, `GET
  /api/graph`, and MCP `daimon_graph` RENDER what depends.ts/orchestrate.ts
  already compute — no cascade changes, no auto-restart, no start/stop from the
  graph, ever; `src/graph.ts` imports nothing that can touch a process and
  `test/graph.test.mjs` greps to keep it that way. The `up <group>` start-order
  preview (TTY chrome + `--dry-run` + the graph page's group panel) comes from
  the SAME `groupUpPlan` call the verb executes, carried on `/api/graph` —
  never recomputed client-side. (2) The dashboard graph page is **hand-rolled
  SVG** — no chart/graph/layout library will ever be added for it; layout math
  is pure in `dashboard/src/app/graph-page-helpers.ts`, columns ARE the topo
  levels, and keyboard+aria are part of the page's contract (Tab walks nodes,
  arrows walk edges, offscreen summary narrates the graph; axe gates it).
  (3) The active workspace is CLIENT-SIDE state: dashboard localStorage
  (`daimon.workspace` + the `daimon:workspace` CustomEvent bus), TUI process
  state (`w` chord) — never a daemon key, never state.json; two clients may
  watch two workspaces at once. Workspace matching everywhere is the ONE
  effective-label rule (`label ?? basename(root)`, `src/graph.ts` /
  `dashboard/src/app/workspace-helpers.ts`). Unknown labels 400 naming the
  known ones on every surface whose param arrived in v1.15+
  (errors/search/trends/graph/report) — but the FROZEN `/api/apps` and STABLE
  `/api/overview` keep their pre-v1.15 200-with-empty response forever
  (additive-only law; server.ts has both helpers: `resolveWorkspaceFilter`
  400s, `resolveWorkspaceMembers` never errors). A new read surface taking
  `?workspace=` goes through `resolveWorkspaceFilter` and gets a case in
  `test/workspace-parity.test.mjs`, the per-surface parity gate.
- **The query language is single-sourced, the parser is pure, and LIKE parity is
  the price of any search feature (M179–M183, v1.16).**
  Four binding rules. (1) The grammar lives ONCE, in `src/searchQuery.ts` — a
  pure, import-free parser (no history, no server, no node builtins) whose
  `SEARCH_FIELDS` table IS the docs table, the CLI help text, and the
  unknown-field error message. Adding a field means adding a row there; a second
  hand-written copy of the grammar anywhere is a defect. (2) **Filters compile to
  WHERE clauses on the real columns, never to FTS tricks** — `app:` → the app
  column, `before:`/`after:` → `ts` bounds, `level:` → the `error-*`/`warning-*`/
  `lint-*` event families AND the v1.2 `log_lines.level` column, `kind:` → the
  store selection. That is what makes a query return the SAME rows on the FTS
  path and on the LIKE fallback (`test/search-query.test.mjs` asserts row-for-row
  parity for every query shape); the fallback differs in speed and snippet
  quality, never in which rows match, and it still reports `fallback: true`. Any
  future search feature must work on both paths or it does not ship. (3) The
  unified scope (`?scope=all`) is **opt-in forever**: `GET /api/search` without
  it returns the pre-v1.16 `{ hits, fallback }` body byte for byte, and the
  `tests` / `error-groups` kinds plus the `facets` object appear only when asked
  for. Test runs and error groups are searched with COLUMN queries precisely
  because an FTS shadow for them would need a per-insert trigger — the one thing
  the deferred-indexing rule forbids (that grep now scans the whole `src/` tree,
  not just history.ts). Error groups are folded live from the registry by the
  CALLER (server or TUI), never stored. (4) **Saved searches are inert data**:
  named query strings in `state.json` under the merge-write rule, parser-
  validated at save time, and wired to nothing that fires on its own — no
  schedule, no notification kind, no hook. daimon has exactly one scheduler and
  this is not it; `test/saved-searches.test.mjs` greps `dist/` for the whole
  claim, including a targeted check that `main.js`'s only mention is the TUI's
  read-only getter, nowhere near a timer.

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

- **The TUI chord map is the single source of truth, and muscle memory is sacred (M162–M167, v1.13).**
  Every TUI chord is a row in `src/tui/chords.ts` — key, pane scope,
  description, group, legacy aliases. **Adding a chord = adding a map row**;
  dispatch, the `?` overlay, the per-pane footer hints, the generated docs cheat
  sheet, and the README table all render from it, and NOTHING may hand-list a
  chord (`test/tui-chords.test.mjs` greps the compiled TUI for a `[key] label`
  ribbon and fails on one). Two enforcement layers: App's handler table is
  `Record<MainChordId, Handler>`, so a map row with no handler fails **tsc**;
  the drift test covers the display surfaces. Chords are **PANE-SCOPED** — the
  same physical key legitimately means two things in two panes (`l` focuses the
  log pane / cycles the log level; `/` filters apps / greps; `g`/`G` are
  view-hint+group-filter / scroll-top+scroll-bottom), and a test asserts no two
  chords in ONE pane ever claim the same key. **Muscle memory is sacred**: every
  chord that shipped keeps working, same key, same meaning — a remap is allowed
  ONLY with a permanent legacy alias recorded in the chord's `legacy` field and
  the release notes (v1.13 has none). The v1.12 chord inventory is frozen in the
  test as the regression contract. When a label and the code disagree, **the
  code wins and the label is fixed** (that is how the v1.12 `[g/G] bottom/top`
  footer bug was resolved). README/docs regen: `npm run build &&
  npm run build:readme-chords && npm run build:docs`.
- **Terminal color lives in ONE module, and every rung keeps every feature (M165, v1.13).**
  `src/tui/theme.ts` is the terminal's token layer — DESIGN.md's palette as
  semantic roles, with a truecolor → 16-color → `NO_COLOR` ladder. A hard-coded
  color in a TUI component is a **defect**, not a style choice (the dashboard's
  DESIGN.md §9 rule, carried to the terminal, and grep-gated by
  `test/tui-theme.test.mjs` — which also fails a re-introduced `STATUS_COLORS`
  or `HEALTH_COLORS` map). The 16-color rung is **hand-picked**, never an auto
  quantization of the hex. **No feature may REQUIRE mouse or truecolor** — they
  may enhance; `NO_COLOR` and 16-color terminals get the full feature set with a
  degraded palette, and a real render asserts `NO_COLOR` emits zero SGR color
  codes. Detection is a pure function of the environment (no chalk import, no
  new dep) and must NOT become a `process.platform` fork — the platform
  inventory gate (M140) will catch it.
- **TUI tests are pure-module, plus ONE real render (v1.13).** Chord/theme/
  layout/log/budget logic lives in side-effect-free modules that unit-test
  without ink or a terminal (the `ribbon.ts`/`testChord.ts` pattern) — that is
  why no ink test harness is a dependency. `test/tui-render-smoke.test.mjs` is
  the deliberate exception: it mounts the REAL `App` with ink against a fake
  stdout + a synthetic registry (no daemon — tests never start one) to catch
  what pure modules cannot: a component that throws on mount, a prop ink
  rejects, an empty pane, a row overflowing 80 columns, or a `NO_COLOR` leak.
  The TUI keeps **exactly one interval** — updates are change-driven off the
  registry's `change`/`event` events, and `test/tui-render-budget.test.mjs`
  fails if a second interval or a 1s full-tree tick reappears.

## v1.16 highlights (what landed this release)

- **Recall (M179–M184)**: search grows a query language, one unified surface,
  and saved searches. Zero new config keys, dependencies, or history migrations;
  no frozen shape moved; every new surface `experimental`.
  **Query syntax (M179)**: `app:` `kind:` `level:` `before:` `after:`
  `"phrases"` and bare terms, all ANDed, parsed by a pure `src/searchQuery.ts`
  and compiled into the EXISTING FTS/LIKE machinery as WHERE clauses; unknown
  field → an error naming the valid ones plus how to quote it literally; a
  filter-only query (no text) is valid and answered by column predicates.
  **Unified search (M180)**: `?scope=all` / `daimon search --all` adds test-run
  (`test:<id>`) and live error-group (`errgroup:<fingerprint>`) hits plus a
  per-kind `facets` count — opt-in, so a v1.15 call is byte-identical.
  **Saved searches (M181)**: `daimon searches list|save|rename|delete` +
  `GET/POST /api/searches`, `POST /api/searches/rename`,
  `DELETE /api/searches/:name`, stored in state.json, inert by construction.
  **TUI parity (M182)**: `F` opens a search pane on the same parser with the
  same error text; `Enter` jumps a hit to its timeline position / log pane /
  detail pane. **Scale (M183)**: filter-heavy, phrase, `level:` and `scope=all`
  queries certified on the 1M corpus on BOTH paths against
  `bench/BASELINE-v1.16-search.json`. **Two fixes**: the LIKE fallback now ANDs
  a multi-term query's terms (the FTS path always did — a degraded index used to
  return fewer rows), and a TUI modal's keys no longer reach the app underneath
  it (`q` in the v1.8 timeline used to quit the whole TUI). Backend suite
  **1216 tests**, dashboard vitest 187. New tests: `search-query`,
  `search-surfaces`, `saved-searches`, `tui-search-chord`.

## v1.15 highlights

- **Atlas (M173–M178)**: workspaces and the depends graph become visible,
  navigable surfaces. Zero new config keys, dependencies, or history
  migrations; no frozen shape moved; every new surface `experimental`.
  **Workspace surfacing (M173)**: the dashboard header pill is a real switcher
  (configured searchRoots + "all"; unlabeled roots show as their basename;
  localStorage-persisted; `?workspace=` deep-link wins over stored + cwd
  auto-pick); TUI `w` chord cycles the filter, status bar shows `ws:<label>` —
  both CLIENT-SIDE only. **Graph view (M174)**: `/graph` lazy chunk, hand-rolled
  SVG, columns = topo levels, status via token color + glyph + border (never
  color-only), full keyboard walk + offscreen narration, axe-gated both
  viewports. **`daimon graph` (M175)**: verb + `GET /api/graph` + MCP
  `daimon_graph` (35 tools) — nodes/edges/levels/cycles/unordered/groups; TTY
  tree; unknown workspace labels 400 naming known ones. **Groups × graph
  (M176)**: cluster hulls + the `up <group>` start-order preview (`--dry-run`,
  TTY chrome, group panel) from the same groupUpPlan the verb runs; `up` piped
  JSON byte-identical. **Workspace parity (M177)**: ONE effective-label rule
  (`label ?? basename(root)`) + ONE unknown-label 400 across
  apps/overview/errors/search/trends/report/graph; `?workspace=` added to
  errors/search/trends; `errors --workspace` / `search --workspace`;
  history.trends gained an additive `apps` set filter; dashboard
  home/tests/timeline/trends/report follow the switcher
  (sessions/agents/settings/doctor deliberately daemon-global). New tests:
  `graph`, `workspace-parity`, `tui-workspace-chord`; dashboard
  `graph-page-helpers.spec`, `workspace-helpers.spec`; Playwright `graph.spec`,
  `workspace-switcher.spec`.

## v1.14 highlights

- **First Run (M168–M172)**: the onboarding release — from `npm i -g daimon` to
  a working setup in five minutes, without reading source. Zero new HTTP
  endpoint, config key, dependency, or history migration; no frozen shape
  moved; `init` keeps its `stable` tier and `--auto`/`--force` semantics, and
  every new surface ships `experimental`. **init rebuilt (M168)**: a UI over
  `discoverApps()`, its forked four-marker list deleted, one-file write,
  overwrite safety tested from both directions, `--yes` for scripts/agents with
  a contract-pinned proposal JSON. **Dashboard first-run (M169)**: walkthrough
  card on `/` and `/apps` at zero apps, guided empty states elsewhere,
  dismissal in localStorage only — no telemetry, loopback-only requests.
  **QUICKSTART.md (M170)**: executable documentation (every fenced command run
  by `test/quickstart.test.mjs` on a clean `DAIMON_HOME`), README restructured
  to lead with it, TUI first-attach hint rendered from the chord map.
  **Doctor onboarding rules (M171)**: `config-wrong-directory`,
  `daemon-not-started`, `no-apps-detected`, `port-pool-absent` — all
  suggest-only. **Two bugs the docs gate found**: `daimon daemon start` runs in
  the FOREGROUND (the page now says `--detach`), and — the real one — the CLI
  minted a fresh agent identity per invocation, so `daimon start web` soft-
  locked the `daimon stop web` typed a second later out. Backend suite **1130
  tests**, dashboard vitest 140. New tests: `init-wizard`, `quickstart`,
  `tui-first-run`, `doctor-onboarding`.

## v1.13 highlights

- **Terminal Native (M162–M167)**: part 3 of the UI redesign trilogy — the TUI
  catches up with the v1.11 design language and every chord becomes
  discoverable. Lives **entirely under `src/tui/`**: zero daemon/CLI/HTTP/MCP
  change, no config key, no history migration, no new dependency, no frozen
  shape moved. **Chord changes: NONE** — every v1.12 chord works identically, so
  no legacy aliases exist. **Pane system + focus model (M162)**: app list /
  detail / log as first-class panes, `Tab` cycles, focused pane marked,
  `Shift+L` maximizes (and `q` there returns to the list, as the old
  full-screen log pane did); persistent status bar (daemon+port, workspace,
  filters with `visible/total`, muted count, live storms, flash folded in);
  resize re-layouts on the resize signal, not the next tick. **Discoverability
  (M163)**: `src/tui/chords.ts` + a `?` overlay grouped by pane (focused pane
  first) + per-pane footers + a generated docs cheat sheet + a generated README
  table, with a drift test and `Record<MainChordId, Handler>` tsc
  exhaustiveness. `src/tui/keys.ts` deleted. **Fixed a shipped bug**: the log
  pane's footer said `[g/G] bottom/top` while the code did the opposite — code
  won. **Log pane 2.0 (M164)**: v1.2 level tints (null-level lines stay plain —
  never guess), explicit follow indicator (`[following]`/`[paused]`, `G`
  resumes), grep keeps its v1.2 narrowing default with `Tab` → highlight mode +
  `n`/`N` match walking, and a v1.2 storm marker. **Theming (M165)**:
  `src/tui/theme.ts` dedupes the two duplicated color maps and adds the
  truecolor → 16-color → `NO_COLOR` ladder (truecolor values converted from
  DESIGN.md's OKLCH land byte-identical on four `--dm-chart-*` dark hex).
  **Robustness + perf (M166)**: priority column hiding, single-pane mode below
  60 columns, windowed app list with a position indicator, and idle re-renders
  cut 60/min → 12/min by going change-driven. Backend suite **1102 tests**. New
  tests: `tui-chords`, `tui-theme`, `tui-layout`, `tui-log-pane`,
  `tui-render-budget`, `tui-render-smoke`.

## v1.12 highlights

- **Wayfinding (M156–M161)**: part 2 of the UI redesign trilogy — an
  **information architecture** on top of v1.11's visual language. Dashboard-only
  and recompose-only: zero new HTTP endpoint / config key / history migration /
  dependency; no frozen shape moved; the daemon/CLI/MCP surfaces untouched.
  **IA + nav model (M156)**: `dashboard/src/app/nav-model.ts` is the single
  source of truth — three task groups (**Observe** Apps/Events/Logs/Timeline/
  Sessions · **Investigate** Errors/History/Trends/Tests/Regressions/Report/
  Agents · **Configure** Settings/Doctor) + a pure `contextForUrl` resolver
  feeding the grouped rail, the topbar breadcrumb, and the shortcuts help.
  Route audit map (`e2e/route-audit.ts`) + generated redirect suite
  (`e2e/redirects.spec.ts`) enforce deep-link back-compat. **Palette 2.0
  (M157)**: one fuzzy-ranked list unifying nav/apps/actions/search (ranking pure
  + unit-tested; `>` still search-only; localStorage recents; keyboard-reachable
  with `aria-activedescendant`; actions cover start/stop/restart/mute/test).
  **Overview home (M158)**: `/` composes status + needs-attention + test
  pass-rate + resource glance from existing endpoints, each widget degrading
  independently to a note; the apps list moved to `/apps` (`g a` retargeted).
  **Sectioned app detail (M159)**: tabs became scroll-spy-highlighted sections
  with **stable `#anchors`** (`#overview/#errors/#logs/#tests/#timeline/#why` — a
  deep-link contract), a consistent start/stop/restart/mute/test header row, env
  folded into overview, a new Tests section over `GET /api/tests`; legacy `?tab=`
  still maps to the right section (Material tabs dropped — the app-detail chunk
  shrank). **Responsive + empty states (M160)**: 390px pass on the new IA;
  guided fresh-install empty states on home/errors/tests/timeline. All new UI
  surfaces `experimental`; deep-link back-compat + a11y floor verified
  per-milestone. Backend suite **1007 tests**, dashboard vitest 130. New specs:
  `nav-model.spec.ts`, `home-page-helpers.spec.ts`, palette ranking/recents in
  `command-palette.spec.ts`; Playwright `redirects/palette/home/app-detail/
  empty-states.spec.ts`.

## v1.11 highlights (what landed this release)

- **Fresh Coat (M150–M155)**: part 1 of the UI redesign trilogy — a **visual
  language** designed as a whole, implemented entirely at the token layer.
  Visual only: zero route/daemon/CLI/HTTP/MCP change, no config key, no history
  migration, no frozen shape moved; every `data-testid`/ARIA/landmark preserved.
  **Design language (M150)**: `DESIGN.md` (repo root) states principles + the
  full `--dm-*` scale (color/space/type/radius/elevation/motion) for both themes
  and both densities; `tokens.css` implements it as the language's own **OKLCH**
  values (cool-neutral iris-undertone surfaces, iris primary, green/cyan/amber/red
  status set, rational `4·6·8·12·16` radii, soft cool elevation) and **re-points**
  the consumed `--mat-sys-*` roles onto them so Material widgets track it too. AA
  verified at the token level (OKLCH→sRGB→WCAG; all pairings pass 4.5:1 text /
  3:1 non-text in both themes with margin). **Component + page restyle
  (M151–M153)**: shared layer + all pages migrated from ~590 raw `--mat-sys-*`
  reads to their `--dm-*` roles (a decoupling, visually identical via the
  re-point); status dots now match their pill hue. **Chart fix (M153)**: the four
  `--dm-chart-*` tokens ship as theme-split sRGB **hex** — Chart.js reads them via
  `getComputedStyle` and its parser accepts neither `light-dark()` nor `oklch()`,
  so series had been silently defaulting; they now render the designed hues and
  adapt to theme. **Density/theme/print (M154)** re-verified against the new
  scale. `DESIGN.md` is the contract v1.12 (IA) and v1.13 (TUI) inherit. Additive
  tokens only: `--dm-color-secondary`, `--dm-color-scrim`,
  `--dm-color-inverse-surface`/`-on-surface`, `--dm-chart-grid`. Suite **1007
  tests**, 0 fail; bundle 149.3KB gz / 132.6KB br. No new test files (visual-only
  — the axe/keyboard/print Playwright drive needs no selector changes).

## v1.10 highlights

- **Featherweight (M145–M149)**: performance & scale certification — no new
  feature surface, no config key, no history migration, no frozen shape moved.
  **Baselines first (M145)**: `bench/` harness + committed `BASELINE-v1.10*.json`
  for cold-start, CLI round-trip, idle RSS/CPU, TUI attach and per-route
  dashboard TTI; two-signal quiet detection; the budget-derivation rule above.
  **1M corpus (M146)**: 1M events / 2M log lines / 610MB / 3M FTS rows,
  deterministic and anchored; six read paths certified; contract suite green
  against the 1M DB. **Write-path audit (M147)**: ingest p95 0.0013ms/call with
  the queue draining to zero, FTS provably off the write path (×0.857).
  **Startup + bundle (M148)**: lazy-required CLI graph and the first automated
  dashboard payload gate.
- **Four real bugs the scale run found**, each fixed with a measured
  before/after: `PRAGMA integrity_check` ran on EVERY History open (8303ms →
  7ms on a 610MB DB); `daimon doctor` opened six History handles per sweep
  (~51s → 5.1s); `daimon why` paid an O(db-size) health check for a finding it
  discarded (6284ms → 58.8ms p50 at 100k); and retention blocked the event loop
  for 28.8s in one bite (→ p95 144ms slices). Plus: a first search on a cold FTS
  index stalled 51.5s (→ complete LIKE answer), and `daimon --help` cost 307ms
  (→ 121ms).
- **A documentation correction**: the "135.39 KB gz" dashboard figure quoted
  since v1.7 is Angular's *brotli* estimate. Real numbers: raw 492.7KB, gzip
  148.5KB, brotli 132.0KB. The <150KB gzip claim holds, with ~1% headroom rather
  than the ~10% assumed — and is now actually enforced by
  `test/bundle-budget.test.mjs`.
- Tests: `test/bench-harness.test.mjs`, `test/history-verify.test.mjs`,
  `test/bundle-budget.test.mjs`. Certified numbers live in **PERFORMANCE.md**.

## v1.9 highlights

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
