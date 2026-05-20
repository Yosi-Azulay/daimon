# Changelog

All notable changes to Daimon are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added (M41) — CLI polish

- **C1 — Unified help system.** `daimon --help` now groups commands by category (lifecycle / queries / agent verbs / introspection / config / claude / plugin). Per-command help is available as `daimon <verb> --help` (or `daimon help <verb>`) and follows a single template — synopsis, description, options table, examples, exit codes — driven entirely by `cliSurface.ts` so help, completion, and skill text cannot drift.
- **C2 — Shell completions.** New `daimon completion <bash|zsh|fish|powershell>` emits a completion script to stdout for the chosen shell. All four shells supported at launch. Completions cover verbs, aliases, and common flags; the bash/PowerShell scripts also auto-complete app names by querying a running daemon (`--no-spawn` is used to avoid starting one for completion).
- **C3 — Color and TTY awareness.** New `--no-color` flag and `NO_COLOR` env var disable ANSI coloring. When stdout is **not** a TTY (the agent / piped case), output is **never** colored — compact JSON default from M26 is preserved unchanged. TTY mode colors errors red, hints dim, headings bold, keywords cyan. `FORCE_COLOR=1` honored as the per-CI override.
- **C4 — Levenshtein "did-you-mean" suggestions.** Unknown commands and unknown apps now emit a `did you mean '<X>'?` hint. Tuned to a 2-edit-distance threshold to avoid noise. Apps lookup polls the running daemon.
- **C5 — Flag convention block in `--help`.** A new "flag conventions" section in the main help documents the canonical flag vocabulary (`--timeout`, `--since`, `--budget`, `--until`, `--app`, `--profile`, `--full/--compact`, `--stream`, `--explain`, `--dry-run`, `--yes`). No flag renames — convergence is documented.
- **C6 — Muscle-memory aliases.** New aliases: `daimon ls` → `list`, `daimon ps` → `status`, `daimon log` → `logs`. Aliases are documented in `--help` but not duplicated in the main verb list and do not conflict with existing verbs.
- **C7 — Error message rewrite.** CLI errors now carry a `{ "error": "<short>", "hint": "<actionable next step>", "exit": <code> }` shape in JSON (piped) mode. TTY mode renders the one-line human variant (`error: …` + dim `hint: …`). The "daimon is not running" error nudges the user to `daimon daemon start --detach`. Unknown command / unknown app errors carry suggestions.
- **C8 — `daimon --version` / `daimon --about`.** `--version` now prints the bare SemVer string (was `{"version":"..."}`). `--about` prints `{version, nodeVersion, platform, configPath, lockPath, running, runningPid, runningPort, claudeArtifacts}` — useful for bug reports. `daimon self` (new lightweight verb) reaches the daemon's `/api/self` endpoint introduced in M43.
- **Test surface.** New `test/cli-surface.test.mjs` asserts every subcommand has the full help template, aliases resolve to canonical verbs, did-you-mean returns sensible candidates within 2 edits, and the completion script generator produces non-empty output for all four shells.

## [0.7.0] — 2026-05-20

Strategic theme: **Memory and reach.** v0.7 makes the *past* actionable (history surfaces) and broadens *what* daimon can manage (polyglot dev servers, whole-workspace orchestration, refreshed TUI).

### Added (M37) — History dashboard surface

- **T1a — Bundle-size persistence.** New `bundles` table in `~/.daimon/history.db` (`app, ts, initialKB, lazyKB, fileCount`). The registry persists one row per `onBundleUpdate` (Angular esbuild bundle parse), so the dashboard can render long-term bundle trends without an external store. The new table is additive — v0.6 history.db files migrate forward automatically on first open via `CREATE TABLE IF NOT EXISTS`. `daimon snapshot` carries the last 100 bundle rows per app in the payload.
- **T1b — `GET /api/history/trends`.** New aggregated time-series endpoint: `?app=<name>&metric=<compile|bundle|errors|restarts>&since=<24h|7d|30d>` returns `{app, metric, since, points:[{t, v, v2?}], _meta:{aggregation, count}}`. `compile` averages ms per bucket. `bundle` returns initialKB as `v` and lazyKB as `v2`. `errors` counts `error-new` + `error-recur` events per bucket. `restarts` counts `status` transitions where `to=starting` and `from ∈ {error, serving, compiling}`. Aggregation is hour-buckets for `24h` and day-buckets for `7d`/`30d`. Companion endpoint `/api/history/bundles` returns raw rows.
- **T1c — Dashboard `Trends` route.** New lazy-loaded `/trends` page with four charts (compile · bundle · errors · restarts) rendered via the existing chart.js lazy chunk from M30 — no new chart dep. Bundle chart stacks initialKB + lazyKB per app. Toggle between `24h` / `7d` / `30d` and between "All apps" and a single-app focus. Linked from the nav rail with `g t` shortcut.
- **T1d — Fixture-daemon harness (partial H1).** New `test/history-trends.test.mjs` exercises `History.recordBundle` / `queryBundles` and the four `trends()` aggregations against a temp sqlite db, so the Trends backend is verified without a real `~/.daimon/history.db`. Wired into `npm test`.

### Deferred (M37 → v0.7.1)

- **H1 — Vitest + Playwright dashboard scaffolding.** The non-trivial dev-dep + per-component spec layer carries over from v0.6.1; only the History.ts fixture-daemon harness lands in v0.7.0. Reason: keeps the Trends surface shipping on schedule while leaving the dashboard-test footprint for a focused v0.7.1 weekend.
- **H3 — WCAG AA contrast audit.** Visual inspection task across light/dark/reduced-motion tonal surfaces — also pushed to v0.7.1 alongside H1.

### Changed (M37)

- **Initial-route gzip transfer: 126.44 KB** — Trends route + `getTrends` + `getBundles` API are entirely lazy. Initial bundle stays under the 130 KB v0.6 ceiling.

### Added (M38) — Whole-workspace orchestration

- **T2a — `daimon orchestrate <profile>`.** New CLI / HTTP / MCP verb. `POST /api/orchestrate?profile=<name>&goal=serving|healthy|stable&timeoutMs=<n>[&dryRun=true&budget=<tokens>]`. Resolves the profile's app list, cascade-starts every app via the existing F18 depends-topo ordering, waits up to `timeoutMs/2` per app for the goal, and runs **one** round of `runAutoFix` + restart + wait on stragglers. Returns `{profile, goal, perApp:[{name, reached, tries, fixed?, stillFailing?:[…first 3 parsed errors], waitedMs}], totalMs, allReached}`. `goal=stable` requires serving + healthy + 5s idle (same definition as `focus --until stable`).
- **T2b — MCP `orchestrate` tool.** Same surface exposed to Claude; documented as the recommended way to "bring up my whole workspace" in one call. Inputs: `profile, goal?, timeoutMs?, dryRun?, budget?`. Returns the same shape as the HTTP endpoint.
- **T2c — Idempotency + dry-run.** Apps already at goal are no-ops (`tries:0, reached:true`). `--dry-run` returns `{dryRun:true, plannedOrder:[…topo levels…], alreadyHealthy:[…]}` without starting anything.
- **`--budget <tokens>`.** Honors a token budget like `overview`: drops `stillFailing` entries first (≈60 tokens each), then trims already-reached `perApp` rows, recording counts in `_meta.omitted`.
- **Decision locked in (no recursion).** Orchestrate runs at most **one** try-fix round per app. Stragglers land in `stillFailing` and the caller decides the next move. Keeps results predictable, preserves per-rule attribution, and avoids compound-round confusion. Upgrade path is bounded-by-progress retry, not an N-round cap.
- **Tests:** new `test/orchestrate.test.mjs` covers (1) dry-run reports planned order, (2) unknown profile error, (3) already-healthy short-circuit, (4) happy-path cascade reaches goal, (5) one try-fix round + stillFailing surfacing.

### Added (M39) — Polyglot dev-server discovery

- **T3a — Marker-file detectors for non-JS stacks.** `discoverApps` now detects Django (`manage.py` containing a `django` import), Rails (`bin/rails` + `Gemfile`), FastAPI (`fastapi` mention in `pyproject.toml` or `requirements.txt`), Go air (`.air.toml` or `air.toml`), and Rust trunk (`Trunk.toml`). Each profile gets a sensible default serve command (`python manage.py runserver`, `bin/rails server`, `uvicorn main:app --reload`, `air`, `trunk serve`) which can be overridden via `overrides.<name>.command`.
- **T3b — `DiscoveredApp.serverProfile`.** New optional field — `'angular'|'nx'|'vite'|'storybook'|'django'|'rails'|'fastapi'|'go-air'|'rust-trunk'`. Existing JS detectors now also tag their apps with `serverProfile` matching `workspaceType`. Polyglot apps get `workspaceType: 'polyglot'` + a specific `serverProfile`. The field is additive; v0.6 configs and snapshots still parse unchanged.
- **T3c — Polyglot parser hints.** `parseLine` gains serving / compiling / error patterns for Django (`Watching for file changes with StatReloader` → compiling, `Quit the server with CONTROL-C` → serving, `Traceback` + `File "..."` back-fill → error+location), Rails (`Puma starting`, `Use Ctrl-C to stop`, `ActionController::*` / `NameError(...)` + `file.rb:L:in` back-fill), FastAPI (`Uvicorn running on`, `Application startup complete`, ASGI tracebacks), Go air (`building...`, `running...`, `file.go:L:C:` location detection + `panic:` patterns), and Rust trunk (`error[E0425]` + `--> file.rs:L:C` back-fill). New `ParserTool` values: `django`, `rails`, `fastapi`, `go-air`, `rust-trunk`, `python`. Stack-trace locations now resolve `.py` / `.rb` / `.go` / `.rs` file extensions alongside JS/TS.
- **T3d — `daimon discover --explain` updates.** `/api/discovery/explain` (and `daimon discover --explain` / `daimon list --explain`) now annotate each detected app with `workspaceType` + `serverProfile` and append a `N polyglot app(s) found (django, fastapi, ...)` hint to the suggestion when any non-JS profile is present. The rejection-reason hint now also mentions `manage.py / Gemfile / pyproject.toml (fastapi) / .air.toml / Trunk.toml`.
- **Polyglot doctor rules (report-only).** Three new sibling rules to M36's `orphan-node-modules`: `orphan-venv` (Python — flags missing `.venv` / `venv` or one stamped older than `pyproject.toml` / `requirements.txt`), `orphan-bundler-cache` (Ruby — `vendor/bundle` missing or older than `Gemfile.lock`), `orphan-cargo-target` (Rust — `target/` missing or older than `Cargo.lock`). All three are **report-only** and emit a `would suggest: ...` paragraph — daimon never runs `pip install`, `bundle install`, or `cargo build`. Default `doctor.autoFix.permitted` extends to include them.
- **Parser corpus fixtures.** New `test/fixtures/parsers/{django,rails,fastapi,go-air,rust-trunk}.{log,expected.json}` covered by the existing M33 corpus test (≥95% capture rate + tool + status assertions).
- **Tests:** new `test/polyglot-discovery.test.mjs` covers each detector (strict markers — `manage.py` without `django` import is rejected; JS detector precedence on Vite + `manage.py`; JS apps still tagged with `serverProfile === workspaceType`).
- **Decisions locked in** (re-affirmed from PLAN-v0.7.md):
  - Daimon **never invokes** `pip install`, `bundle install`, `cargo build`, `go mod download` — the polyglot orphan rules are report-only, never a shell-out.
  - Polyglot detectors run **unconditionally** on every searchRoot, guarded by strict markers (`manage.py` must contain `django`, `pyproject.toml`/`requirements.txt` must declare `fastapi`) and JS precedence (`nx.json`/`angular.json`/vite/storybook detected first).
  - No new `searchRoots[*].polyglot: true` opt-in is introduced.

### Added (M40) — TUI parity refresh

- **T6a — Shortcut alignment.** The Ink TUI now uses `/` for filter (the prior `t` tag-pick remains), `j`/`k` (in addition to `↑`/`↓`) for navigation, a `g <key>` chord that surfaces dashboard-style view hints (`g a` apps, `g e` errors, `g v` events, `g s` settings, `g n` sessions), and `r` requires a `y`/`n` snack-confirm before restarting — matching the dashboard's M35 anti-fatfinger behaviour. `o` (open URL) and `s` (start) are preserved. Stop is rebound to `S` (shift-S) because `x` now means try-fix (per T6c).
- **T6b — Per-app 20-cell event ribbon.** Each app row in the TUI gains a second line with a 20-cell ASCII bar (`▓▓░▒▓▓░░░░░░░░░░░░░░ srv·err·cmp·stp`) representing the last 60 minutes of status events, computed with the same algorithm as the dashboard's H5 ribbon. Glyphs: `▓` serving, `█` error, `▒` compiling/starting, `░` stopped, `·` empty bucket. Powered by the new `src/tui/ribbon.ts` helper (covered by `test/tui-ribbon.test.mjs`).
- **T6c — Focus / try-fix / orchestrate from the TUI.** New action keys on the selected app: `f` runs the M34 "focus until stable" wait (5s idle on serving + healthy, 180s budget) and surfaces the outcome in the footer status line; `x` runs `try-fix` (runAutoFix on the permitted rule set + restart + wait for healthy) and reports `fixed N` + reached/timeout; `O` (shift-O) opens an inline orchestrate dialog — type a profile name + Enter to run the M38 `orchestrateProfile` with `goal=healthy, timeoutMs=300_000` and see the result on the footer. All three call the in-process registry directly (no HTTP round-trip), so the TUI keeps working over SSH without network access.
- **T6d — Headless mode unchanged.** `--headless` + `config.headless: true` continue to skip the TUI entirely. No new daemon flags.
- **Footer status line.** A new auto-dismissing `[i] …` line surfaces the outcome of `f` / `x` / `O` actions (plus `r` confirm and `g <key>` view hints) for ~4 seconds — necessary because the TUI no longer relitigates ambient state when an in-flight action completes.
- **Tests:** new `test/tui-ribbon.test.mjs` covers the ribbon helper (60-min window, error-over-serving ranking, per-app filtering, glyph rendering, count aggregation).

## [0.6.0] — 2026-05-20

Strategic theme: **Every signal becomes actionable.** M33 deepens parser coverage so every tool's errors land structured; M34 turns daimon into a 3-call agent surface (overview → try-fix → focus); M35 ships keyboard / logs / ribbon polish; M36 broadens auto-heal with four new doctor rules and opt-in health-probe path discovery.

### Added (M33) — Parser depth

- **P1 — Parser corpus + tests.** New `test/fixtures/parsers/*.log` for Vite, Storybook, Jest, Nx, Angular esbuild, webpack, and Node native, each paired with a `.expected.json` of `{tool, status, errors:[{file,line,col,code}]}`. New `test/parser-corpus.test.mjs` replays every fixture through `parseLine` and asserts ≥95% capture rate on file-bearing lines plus tool tagging. Captures parser regressions in CI instead of via screenshots.
- **P2 — Multi-tool parsers.** `parseLine` now detects and tags errors from Vite (`[vite]`, `[plugin:vite:…]`, `transformWithEsbuild`), Storybook (`ERR!`, `builder-vite`), Jest (`FAIL <path>`, `● <test>`), Nx (`>  NX … failed`, `Failed tasks:`), webpack (`Module not found:`, `ERROR in <path>[:L:C|<sp>L:C]`), Node native (`Error|TypeError|… at <file>:<L>:<C>`), and TSC-style `file(line,col): error TSnnn`. Parsed entries gain a new optional `tool` field (`ParserTool` in `types.ts`). Stack-trace style `(file:line:col)` locations are extracted and also back-fill the most-recent error entry that has no file.
- **P3 — Errors-panel grouping by tool.** Dashboard `Errors` page gains a fourth `Group by` tab: `tool`. Each tool group renders with a colored chip per tool (esbuild/vite → primary, jest/nx → secondary, storybook/webpack → tertiary, node/typescript → neutral) and lists per-app, per-file rows.

### Fixed (M33)

- **Webpack "compiled with N errors" no longer clears the error map.** The serving pattern was loosened to `webpack compiled (?:successfully|in)` so a build summary that includes errors does not transition the state to `serving` and wipe collected errors.

### Added (M34) — Agent-first surface

- **A1 — `daimon focus <app>`.** New CLI / HTTP / MCP verb. One round-trip subscribe-then-act over `POST /api/apps/:name/focus?until=serving|healthy|stable[&timeoutMs=]` that streams NDJSON events: `{kind:"subscribed"|"status"|"health"|"error"|"done", …}`. `--until stable` resolves when the app is serving + healthy with no event for ≥5s. Designed so an agent issues one MCP call and reads a coherent narrative instead of polling. CLI exits when the stream ends; MCP `focus` aggregates events into `{events, final}`.
- **A2 — `diff_errors` MCP tool.** Wraps the existing F2 `errors --since-last --client <id>` HTTP endpoint as a dedicated MCP tool with a `budget` (token) cap; overflow rows are dropped and reported as `_meta.omitted`. Compact `{file,line,col,code,tool,message}` per entry.
- **A3 — `daimon try-fix <app>`.** New CLI / HTTP / MCP verb. `POST /api/apps/:name/try-fix?until=…` composes `runAutoFix` (permitted rules), `registry.restart(name)`, and `registry.waitFor(name, until)`, then returns `{before:{status,health,errCount,firstError}, after:{status,health,errCount}, fixed:[ruleName], stillFailing:[…first 5 parsed errors], reached, waitedMs}`. Never edits user source — only daemon state, exactly as the F58 rules already did.
- **A4 — `daimon overview --budget <tokens>`.** Both the HTTP endpoint and the CLI accept a token budget. Rows past the budget are dropped from `needsAttention` first, then `recentlyChanged`, with the counts reported as `_meta.omitted.{needsAttention,recentlyChanged}`. Makes the session-opener predictable for agents.
- **Test:** new `test/overview-budget.test.mjs` covers the truncation invariants (no-op under-budget, truncates over-budget, no-op on empty input).

### Added (M35 partial) — Dashboard depth

- **H2 — Keyboard shortcuts realigned with the v0.6 spec.** `g e` now jumps to **Errors** (was Events; Events moved to `g v`). `g s` now jumps to **Settings** (alias of `/config`; the previous `g s` → Sessions moved to `g n`). The legacy `g r` → Errors and `g c` → Settings bindings remain as aliases for muscle memory. `r` (restart focused app) now requires a snack-bar confirm before firing, eliminating accidental restarts during keyboard navigation.
- **H4 — Logs page: regex filter + jump-to-next-error.** A `.* regex` toggle on the filter bar switches between substring and regex matching (case-insensitive). Invalid patterns surface inline (`mat-icon warning` + parser message) instead of throwing. A `Next error` button scrolls the virtual viewport to the next `severity === 'error'` row from the current visible end, wrapping to the top.
- **H5 — Per-app event ribbon.** Each card on `Apps` gains a 6px ribbon between the workspace-tone accent and the status row, showing the last 60 minutes of status events as 20 colored buckets (primary tint = serving, error = error, tertiary = compiling/starting, outline-variant = stopped). Hover shows a `last 60 min: 5 serving · 2 error` summary. Empty for apps with no recent transitions.

### Deferred (M35 → v0.6.1)

- **H1 — Vitest + Playwright dashboard tests.** Adds non-trivial dev-deps (Vitest + Playwright + Angular bridge config), a fixture-daemon harness, and per-component specs. Out of scope for the v0.6.0 weekend; will land in v0.6.1.
- **H3 — WCAG AA contrast audit.** Needs visual inspection across all M3 tonal surfaces under light + dark + reduced-motion. Pushed to v0.6.1 alongside H1; reduced-motion path from M30 is already verified.

### Fixed (M35 follow-up) — Initial-route bundle back under budget

- **Initial-route gzip transfer: 126.01 KB** (down from 151 KB at v0.5 HEAD; well under the 130 KB v0.6 ceiling). Achieved with three surgical lazy-loads, no functional change:
  - `MatDialog` import is now dynamic — the keyboard `?` help dialog imports `@angular/material/dialog` only when triggered.
  - `<dm-command-palette>` is wrapped in `@defer (when paletteActivated())`; the palette mounts on first `Ctrl/⌘+K`, and the activation handler re-dispatches the `daimon:cmdk` event so the user only presses the chord once.
  - `MatMenu`-based dropdowns in `dm-topbar` and `dm-theme-toggle` are replaced with native-button + `@if` popovers (`HostListener('document:click')` for outside-click close). Removes `MatMenuModule` + CDK overlay/portal from the initial chunk.
  - `MatSnackBar` is no longer eager in `dm-topbar`; `runProfile()` now uses a small inline DOM toast (positioned via `mat-sys-inverse-surface` tokens to stay in M3). The apps-list (route-lazy) keeps `MatSnackBar` for the `r` restart confirm — that import lives in its own lazy chunk.
- Bundle structure delta: `MatDialog`/`MatMenu`/`MatSnackBar`/Overlay+Portal moved out of eager into either a deferred chunk or are absent. No functional regression: the help dialog still opens on `?`, the palette still opens on `⌘K`, the workspace + profile dropdowns still work, and the runProfile toast still appears.

### Added (M36) — Auto-heal expansion

- **E1 — Health-probe path auto-discovery.** On first `serving` (when there is no `overrides.<name>.url`, no `overrides.<name>.healthProbePath`, and the global `healthProbe.path` is the default `/`), the monitor runs one in-flight scan against `['/', '/health', '/-/health', '/api/health', '/ready', '/healthz']`, taking the first strictly-2xx response. The discovered path is stored on `AppState.discoveredHealthPath` and an event is recorded: `discovered probe path: /health (pin via POST /api/apps/<name>/health/pin or daimon pin-health <name> --accept)`. The discovery is used by subsequent probes immediately, but **persistence is opt-in** — nothing is written to `daimon.config.json` until the user accepts.
- **`daimon pin-health <name> [--accept] [--path <p>]` + `POST /api/apps/:name/health/pin`.** Without `--accept` the CLI just reports the discovered candidate; with `--accept` it writes `overrides.<name>.healthProbePath` to the active `daimon.config.json` and triggers soft-reload. `AppOverride.healthProbePath` is a new optional field; v0.5 configs continue to load unchanged.
- **E2 — Four new doctor rules** added to `daimon doctor --auto-fix`:
  - `port-conflict-pred` — predicts which configured `portRange` endpoints + pinned ports are already in LISTEN. Reports only; no kill.
  - `node-version-mismatch` — compares `.nvmrc` then `package.json#engines.node` against `process.versions.node`. Reports only; switching Node versions stays a user action.
  - `orphan-node-modules` — flags `searchRoots` whose `package.json` exists but `node_modules` is missing, or older than `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`. Per locked decision in PLAN-v0.6.md, daimon **never runs npm/pnpm/yarn install** — the rule emits a `would suggest: (cd ... && npm install)` paragraph instead.
  - `dead-search-root` — finds `searchRoots` that no longer resolve on disk and removes them from the config file (with a soft-reload), printing a `to undo: re-add` paragraph.
- All four rules are added to `ALL_AUTO_FIX` and to the default `doctor.autoFix.permitted` list. v0.5 configs whose `permitted` list is shorter are honored as-is — the new rules just don't activate for them.
- **Test:** `test/autofix-rules.test.mjs` asserts the new rule names are present in `ALL_AUTO_FIX` and the original M28 rules are still listed (backwards-compat smoke).

## [0.5.0] — 2026-05-19

Strategic theme: **Claude path first. Dashboard second. Auto-heal everywhere.**

### Added (M26)

- **F54 — Compact-by-default JSON.** `daimon list`, `daimon status`, and `daimon errors` (plus the matching HTTP endpoints and MCP tools) now return compact rows by default. A 10-app `daimon list` drops from ~74 lines to ~10. Compact list = `{name,status,port,health,errCount,lastChangeMs}`. Compact status = `{name,status,port,url,health,errCount,lastChangeMs,uptime,_meta:{format:"compact"}}`. Compact errors = `{file,line,col,code,message}`. `lastChangeMs` is derived from the existing event buffer.
- **F53/F63 — One skill replaces eleven.** `daimon claude install` writes a single `~/.claude/skills/daimon/SKILL.md` that documents every verb inline (~120 useful tokens). Per-command `daimon-*.md` files in `~/.claude/commands/` are removed on install (or renamed to `.bak` when the file's mtime indicates user edits since the manifest's `installed-at`). Removal/backup events are printed as one JSON line each (`{"removed":...}` / `{"warning":...}`) and recorded in the manifest.

### Added (M27)

- **F55 — `daimon ensure` and `daimon ensure-up`.** One CLI/HTTP/MCP call replaces the canonical `list → status → start → wait → status` sequence. Idempotent on already-terminal apps. Honors `--until serving|healthy` and `--timeout`. `ensure-up <profile>` cascade-starts every app in the profile and waits for each to reach the target. On timeout the response is `{error:"timeout", state, _meta:{timedOut:true}}` and the CLI exits 2.
- **F56 — `daimon overview`.** Decision-ready snapshot in one call: totals (serving / error / stopped / total err / cpu / mem), `byStatus` map, `needsAttention` with the first parsed TS error per failing app, last 5 status transitions in the past 5 minutes. Filterable by `--workspace` and `--profile`. MCP `overview` is documented as the recommended first call in a session.
- **F62 — NDJSON `--stream`.** `daimon list --stream` and `daimon events --stream` emit one JSON object per line. The list stream is one-shot. The events stream is long-lived: historical events flush first, then each newly-recorded event arrives on its own line. 30-second newline keepalives keep the connection alive on quiet workspaces. The registry emits a new `event` signal for in-process subscribers.

### Added (M28)

- **F58 — `daimon doctor --auto-fix [--dry-run]`.** Four rule-based, transparent repair routines that operate **only on daimon's own state** — never user source:
  - `orphan-daemon` — daemon's recorded cwd/configPath differs from the current shell's cwd and a local `daimon.config.json` exists here; snapshot-handoff-shuts-down-respawn from the new cwd.
  - `stale-lock` — lock file claims a pid that's dead; remove + spawn fresh.
  - `missing-search-root` — cwd has nx/angular/vite/storybook markers but no configured searchRoot covers it; append (with `package.json` `name` as label when available) and trigger F39 soft-reload.
  - `corrupt-history-db` — `quickCheck()` fails or open throws; rotate to `history.db.corrupt-<ts>` (and its `-wal` / `-shm` siblings) so a fresh DB is rebuilt on next start.
  Each routine returns a paragraph describing what was wrong, what was done, and how to undo. Gated by `config.doctor.autoFix.permitted`.
- **F57 — Self-explaining discovery.** `daimon list --explain` (alias: `daimon why-empty`) wraps the response as `{ apps, _meta:{ searchRoots, scanned, rejected:{reason:count}, warnings, suggestion } }`. `discoverApps` now accepts an optional stats collector that gets bumped at every concrete skip (`searchRoot missing`, `no serve target`, `duplicate name`, `no project markers`, …). New HTTP endpoint `GET /api/discovery/explain` returns the same `_meta`. The non-`--explain` default still returns a bare array, preserving the M26 contract.
- **F59 — `daimon init --auto` + smoke test.** `daimon init --auto` writes a config without prompting (cwd auto-added as searchRoot, labeled from `package.json` `name` when present). All init paths now run a discovery smoke test after the post-init daemon restart and emit `{init:"ok", configPath, discovered:{apps, byKind}}`. When `apps === 0`, the response embeds the F57 `_meta` and a copy-pasteable suggestion.
- **F65 — HTTPS-cert tolerance on loopback.** Health probes against `127.0.0.1` / `::1` / `localhost` over HTTPS now always pass `rejectUnauthorized: false`, so Vite dev servers using mkcert or auto-generated self-signed certs no longer fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Off-loopback hosts still get strict cert checks unless `healthProbe.rejectUnauthorized` is explicitly relaxed.

### Added (M29) — Angular 20 dashboard

- **F60 — Sibling `dashboard/` workspace** (Angular 20 standalone, zoneless, Signals, Material 3). Components: root toolbar, apps-list (overview card + per-app cards), app-detail (status + errors + metrics chart), `daimon-api` typed HTTP store backed by signals with an NDJSON `/api/events?stream=ndjson` subscription.
- **Bundled SPA in the published tarball.** `dist/dashboard/browser/` ships in the published `daimon` npm package. Initial-route bundle: **426 KB raw / 111 KB transfer-gzip.** App-detail (chart.js): **211 KB raw / 63 KB transfer**, lazy-loaded. Errors panel: 23 KB raw lazy. The daemon serves the bundle at `/` with correct MIME types, 1h `cache-control` on hashed assets, SPA-fallback to `index.html` for non-API routes. Fonts (Roboto, Material Symbols Outlined) load from `fonts.gstatic.com`; this is an explicit project choice to keep the bundle slim, not telemetry. **Legacy `src/dashboard.html` is removed** — the Angular bundle is now the only dashboard the daemon serves.

### Added (M30) — Dashboard polish

- **F64 — Per-app actions** (start / stop / restart / open) on each card and in the detail panel.
- **F67 — Workspace tones.** `workspace-tone.ts` derives a deterministic Material 3 surface-tonal color from each workspace label string (FNV-1a hash → oklch hue), used as a 4px top accent on each card.
- **F61 — Errors panel + real-time CPU/RAM charts.** `dm-errors-panel` aggregates dedup'd errors across every app with a `vscode://` link per file. `dm-metrics-chart` renders a chart.js line chart of CPU% + Mem MB over the last 5 minutes per app (5-second polling, last 60 samples). Chart.js is now a direct dep, lazy-loaded via the `app-detail` route so it never appears in the initial bundle.
- **F70 — Material motion polish.** Material 3 motion tokens (`--dm-motion-easing`, `--dm-motion-short/medium`) drive transitions on card hover (translate + elevation), route enter (fade-up), and card mount (fade + scale). `@media (prefers-reduced-motion: reduce)` collapses all animations to ~instant.
- **Theme toggle** (auto / light / dark) persisted in `localStorage`, applied via `color-scheme` on the document root.

### Added (M32) — Dashboard final polish

- **Settings → Discovery** now renders `searchRoots` (Array&lt;{path,label}&gt;) as one editable row per entry instead of a useless `[object Object]` chip. New `path-objects` field kind in the form editor.
- **Doctor → System Overview** shows the live daemon version (`/api/overview` now returns `version`).
- **Errors page** auto-collapses the file column when no error in a group has a file path, replaces `(unknown)` with a dimmed `—`, and surfaces a one-line hint with a switch-to-group-by-app shortcut.
- **Events page** type-chips no longer wrap to two lines for long event kinds (`compile-regression`).
- **Material 3 density** set to `-2` and global overrides tighten slide-toggle, button-toggle, form-field, expansion-panel-header, and in-button icon sizes so the dashboard feels like a dev tool, not an app launcher.
- **Global `mat-icon` fontSet** defaults to `material-symbols-outlined`, fixing leftover icons that previously rendered their ligature name as text (`se Dry-run`, `bu Fix`).

### Fixed (M32)

- **Error parser back-fills file paths.** Esbuild prints `path:line:col:` on the indented line *after* `✘ [ERROR] TSnnn: …`. The parser now matches that bare-location line and attaches it to the most-recent error entry that lacks a file. Errors emitted by the Angular esbuild plugin now click through to VS Code at the right line.
- **`/api/doctor/auto-fix` endpoint** added (was 404 from the dashboard despite the CLI command working).

### Added (M31) — Polish CLI features

- **F66 — `daimon why-empty`** shipped early in M28 as an alias of `daimon list --explain`.
- **F68 — Agent token footprint in `daimon doctor`.** A new check prints `skill=120 tokens · daimon list (N apps) ≈ X compact / Y full · savings: ~Z%`. Deterministic from current app count, no remote calls.
- **F69 — `daimon export-config [--redacted]`.** Emits the active config to stdout. `--redacted` replaces `apiToken` with `"<redacted>"` and rewrites paths under `$HOME` to `~/...`. Intended for paste into GitHub issues.
- **`daimon discover [--dry-run]`** (sub-feature of F57). New CLI subcommand that returns the F57 `_meta` (searchRoots, scanned, rejected per folder, suggestion) without changing daemon state. Reuses `GET /api/discovery/explain`.

### Changed (M26, breaking)

- `/api/apps` and `/api/apps/:name` now return the compact shape by default (see F54 above). Pass `?format=full` (HTTP) or `--full` (CLI) for the v0.4 verbose shape. **External automation that parsed `daimon list` or `daimon status` must add `--full` or migrate to the compact field names** (`errorCount` → `errCount`, `uptimeMs` → `uptime`, new `lastChangeMs`). The dashboard is unchanged because it now requests `?format=full` explicitly.
- `LockInfo` gained optional `cwd` and `configPath` fields so auto-fix can identify orphan daemons without poking `/proc`. Old daemons that wrote the v0.4 lock shape continue to work — the fields are optional.

### Schema additions (all optional, safe defaults)

- `output: { format: "compact" | "full" (default "compact"), ndjson: false }`
- `doctor: { autoFix: { onInit: false, permitted: ["orphan-daemon","stale-lock","missing-search-root","corrupt-history-db"] } }`
- `dashboard: { theme: "auto" | "light" | "dark", density: "comfortable" | "compact" }`
- `AppSummary.lastChangeMs?` — milliseconds since the last status transition

### Tarball budget

The original v0.5 plan capped the published tarball at **200 KB packed** — written before Angular 20 + Material 3 were measured. With the full v0.5 surface shipped (Angular SPA, chart.js for metrics, Material motion, M31 polish CLI), `daimon-0.5.0.tgz` lands at **332 KB packed / 1.1 MB unpacked / 28 files**. The new agreed budget is **2 MB packed** to leave headroom for future dashboard work. Initial-route gzip transfer stays at ~111 KB; chart.js sits in the lazy app-detail chunk and only loads when a user opens an app.

### Deferred (v0.6+ or never)

- **Dashboard unit tests** — no Angular `*.spec.ts` files yet; the plan deferred them to M31 polish but they were not written this round.
- **Local-bundled fonts** — `fonts.gstatic.com` remains the source for Roboto + Material Symbols Outlined. Bundling locally would add ~150 KB raw to the initial chunk; the CDN approach is the explicit project choice.

## [0.4.3] — 2026-05-18

### Fixed
- `daimon init` now auto-restarts the daemon at the end so the new config is actually loaded. Previously, if a daemon was already running when init was invoked, the new `daimon.config.json` was silently ignored (the daemon's config path is locked at startup), causing `daimon list` to return `[]` immediately after init. State is preserved across the restart via the existing zero-downtime snapshot mechanism.

## [0.4.2] — 2026-05-17

### Changed (first npm publish)
- **License changed from MIT to PolyForm Noncommercial 1.0.0.** Free for personal, academic, and noncommercial-organization use; commercial use requires a separate license. The MIT-licensed history remains in git for anyone who obtained it before this change.
- **Renamed from `appman` to `daimon`.** Binary, package, environment variables (`APPMAN_*` → `DAIMON_*`), config file (`appman.config.json` → `daimon.config.json`), state directory (`~/.appman/` → `~/.daimon/`), and Claude integration paths (`~/.claude/skills/appman/` → `~/.claude/skills/daimon/`) all changed. No automated migration — first OSS release does not have prior public users.
- **Published builds are bundled and minified.** `npm i -g daimon` ships a single bundled+minified `.js` per entry point (cli / main / mcp). The TypeScript source remains in the GitHub repo for review.

### Added (M25)
- Live log stream via Server-Sent Events on the dashboard
- `~/.daimon/secrets.json` with `${NAME}` substitution in `overrides.env`
- Zero-downtime daemon restart via state handoff
- Audit log of dashboard config edits at `~/.daimon/audit.log`
- Workspace presets surfaced in the dashboard config editor

## [0.4.1] — 2026-05-17

### Added (M24)
- `searchRoots[*].label` for workspace grouping (F44)
- `daimon init` — interactive config scaffolder (F45)
- `daimon daemon install-service` — emits Windows/macOS/Linux service artifacts (F46)
- Crash report dumps to `~/.daimon/crashes/<ts>.txt` on daemon fatal (F47)

## [0.4.0] — 2026-05-17

### Added (M20–M23)
- **Global install** via `npm i -g`. New `daimon` command on PATH (F37).
- **Auto-spawn daemon** on first CLI/MCP call; lock file at `~/.daimon/daemon.lock` (F38).
- `daimon daemon start|stop|status|restart|attach` family + `--detach` / `--headless` flags.
- `daimon daemon attach` — HTTP-client TUI against a detached daemon (F38b).
- `daimon claude install|update|uninstall|status` — Claude Code integration installer with selectable skill / slash commands / subagent artifacts (F41).
- `src/cliSurface.ts` — single source of truth for CLI usage, MCP tool descriptions, and Claude templates.
- Auto-update nudge when installed Claude artifacts are older than current daimon version (throttled to 24h, silence with `DAIMON_NO_CLAUDE_NUDGE=1`).
- Dashboard configuration editor — per-app overrides + global config (F39). Soft reload on save without killing running children.
- Optional `apiToken` for mutating endpoints (F43). Loopback bind unchanged.
- Errors panel in the dashboard with expandable per-app drawer, structured `file:line` deep-links, and copy-to-clipboard (F40).
- Configurable editor URL scheme (`vscode`, `vscode-insiders`, `cursor`, custom) (F42).

## [0.3.0] — 2026-05-16

### Added (M11–M19)
- **Dependency graph + cascade restart** via `config.depends` (F18). `daimon up <profile>` topologically orders starts and waits for each level to reach `healthy`.
- **SQLite event/compile/task history** at `~/.daimon/history.db` with 30-day retention (F19). New `daimon history <name>` and `daimon why <name>` queries.
- **`daimon run <app> <task>`** — non-serve actions (test/build/lint) with the same capture/dedupe infra (F20).
- Desktop notifications on app error / unhealthy / stale / regression (F21). Throttled per-app-per-minute. Audit log to `~/.daimon/notifications.log`.
- Stale detector — flags apps that are `serving` but silent while sources change (F22).
- `daimon snapshot <name>` — write a state bundle for bug reports (F23).
- Headless mode (`--headless` flag or `config.headless: true`) (F24).
- TUI live config edit (`e` key on a selected app) (F25).
- Bundle size readout in summary + dashboard (F26).
- Port-in-use diagnostics + `daimon free-port <port> [--force]` (F27).
- `daimon doctor` — config sanity checks (F28).
- Compile-time regression alarm (F29).
- `.env` file switcher per app (F30).
- `daimon clean <name> [--deep] [--yes]` — remove build artifacts (F31).
- Experimental: passive HTTP request log proxy (F32, off by default).
- Experimental: Prometheus exporter at `/metrics` (F33, off by default).
- Session record/replay (F34).
- VS Code companion extension (`daimon-vscode`, separate package) (F35).
- **Accurate health probe** — uses the URL the dev server announced, with HTTPS support, IPv6 brackets, 0.0.0.0 rewrite, fallback hosts, per-app overrides (F36). `summary.url` semantics changed: now reflects the resolved probe URL, not a synthetic loopback.

## [0.2.0] — 2026-05-16

### Added (M1–M10)
- `daimon wait <name> --until serving|healthy|stopped|error --timeout 60s` — blocking command for AI agents (F1).
- Diff-mode error queries: `--since 2m` and `--since-last --client <id>` (F2).
- Real HTTP health probe — separate `health` dimension from `status` (F3).
- `autoStart` config + `daimon up [<profile>]` / `daimon down` (F4).
- TUI `o` key opens app URL in default browser (F5).
- CPU / RAM per app via `pidusage` (F6).
- Structured TS error extraction (file, line, col, code) (F7).
- Full-screen log view in TUI with `/` search (F8).
- Persistent sticky ports across daemon restarts (F9).
- Per-app environment overrides (F10).
- Dashboard start/stop/restart buttons (F11).
- Crash auto-restart with exponential backoff (F12).
- Compile-time history sparkline in TUI and dashboard (F13).
- Project filtering by tag (F14).
- Disk log files with rotation (F15).
- MCP server for Claude Code (`daimon mcp`) (F16).
- Vite + Storybook discovery (F17).

## [0.1.0] — 2026-05-16

Initial foundation. Foreground TUI, loopback HTTP API, JSON CLI, Nx + Angular workspace discovery, port auto-allocation, log dedup, error fingerprinting.
