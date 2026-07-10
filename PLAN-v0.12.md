# daimon v0.12 — "The Whole Loop"

7 milestones (M74–M80) · normal feature release, not the v1.0 runway. v0.11 finished the serving story for every framework; v0.12 covers everything around serving: tests as pipeline citizens, crash forensics, full-text search, and a one-verb context pack for agents.

## Theme

Developers and agents run tests dozens of times a day and daimon treats that as someone else's problem. Apps die and the why (exit code, last log lines, what changed) evaporates — the editor app restarts ~100×/day and daimon's answer is a counter. An agent debugging an app makes 4–6 CLI calls and still misses history. v0.12 closes those gaps: **the whole loop** — `daimon test` with parsed failures and run history, flaky detection, crash reports + `daimon why`, FTS5 search over everything daimon has ever seen, and `daimon context` to hand an agent the full picture in one call.

## Decisions locked in

- **Normal feature release.** v1.0 prep (WCAG AA, API freeze) stays its own later release.
- **First-class test verb**, not just task surfacing: parse failures, store runs, detect flakes. daimon **wraps the project's own runner** — it never installs, replaces, or watch-orchestrates one.
- **Test-runner parsers are fixture-gated** exactly like framework profiles: `test/fixtures/testrunners/<id>/` + a parameterized suite. A runner without a fixture doesn't ship.
- **Crash reports are ring-buffered** (last 10 per app) in the history DB — bounded by design.
- **FTS5 comes from the existing better-sqlite3** — no new dependency. Errors/events always indexed; per-app log indexing defaults on with config opt-out.
- **`daimon context` is composition only** — it assembles existing queries; it introduces no new state.
- **`test` acquires the per-app soft lock** like start/stop/restart — two agents can't run the same app's suite concurrently unaware; `--steal` applies.
- **Loopback only, no remote/multi-user/cloud sync, PolyForm Noncommercial 1.0.0, never edit user code, never run install commands, state confined to ~/.daimon/* and daimon.config.json, human runs npm publish with 2FA, no push to origin/main without confirmation.**
- **Public author:** `Yosi Azulay (https://flycotech.com)`. `yosi@flycotech.com` NEVER in published artifacts.

---

## M74 · `daimon test` — test verb + run history

Tests get what serving got in v0.11.

- **Runner resolution:** registry profiles gain a `testRunner` hint; JS profiles resolve vitest vs jest by lockfile-aware dependency check, python → pytest, go → `go test ./...`, rust → `cargo test`, dotnet → `dotnet test`. Explicit `overrides.<app>.testCommand` always wins. No resolvable runner → `{ error, hint }` (suggest the override), exit 1.
- **Runner parsers** (new module, same shape as error parsers): `vitest-jest`, `pytest`, `go-test`, `cargo-test`, `dotnet-test`. Each extracts `{ suite, test, file?, line?, message }` per failure plus totals `{ total, passed, failed, skipped, durationMs }`. Fail-soft: unparsed output still lands in the run's raw log; totals fall back to exit code only.
- **History schema (additive migration, CREATE TABLE IF NOT EXISTS):** `test_runs (id, app, ts, runner, durationMs, total, passed, failed, skipped, exitCode, gitHead)` + `test_failures (runId, suite, test, file, line, message, fingerprint)`. Fingerprint reuses the existing error-fingerprint scheme so grouping works.
- **Surface:** `daimon test <app> [--timeout <dur>] [--json]` (cliSurface entry; exit 0 all pass, 1 failures, 2 timeout); `POST /api/apps/<name>/test` (soft-lock gated, 409 `locked-by-other-agent` applies); `GET /api/tests?app=&limit=`. Audit-logged like other lifecycle calls.
- **Fixtures:** `test/fixtures/testrunners/<id>/` — marker files + `fixture.json` with real runner output (pass + fail + mixed cases). Parameterized `test/testrunners.test.mjs` gates every parser.

Acceptance: `daimon test` on a vitest fixture returns parsed failures with file:line; run recorded and queryable via `GET /api/tests`; unresolvable runner errors with hint; second agent's concurrent `test` gets 409; all 5 runner fixtures pass the parameterized suite.

---

## M75 · Flaky detection + Tests page upgrade

- **Flaky rule:** a test (by fingerprint) that flips pass→fail or fail→pass **≥3 times with the same `gitHead`** is flagged flaky. Threshold configurable: `tests: { flakyThreshold: 3 }`. Query-derived from `test_runs`/`test_failures` — no new table.
- **Events:** `test-failed` (per run with failures: `{ app, runId, failed, total }`) and `flaky-test-detected` (`{ app, fingerprint, test, flips, gitHead }`). Both flow to the events feed and are webhook-eligible automatically (existing event-type filter).
- **Dashboard Tests page upgrade:** from harness display to run history — per-app run list (pass/fail sparkline), run drill-down (failures with file:line, VS Code links via existing `vscodeUri`), diff between two runs (newly-failing / newly-passing), flaky badges on tests. Reuses tokens + card primitives from v0.11.
- **CLI:** `daimon test-history <app> [--flaky]` compact JSON.

Acceptance: seeded history with 3 same-head flips fires `flaky-test-detected` exactly once per fingerprint; Tests page shows run history + drill-down at 1280px and 390px; webhook receives `test-failed` on a local httptest server.

---

## M76 · Crash forensics + `daimon why`

When an app dies, keep the why.

- **Crash capture:** on every child exit that daimon didn't request, persist `crashes (app, ts, exitCode, signal, uptimeMs, lastLines, gitHead)` — `lastLines` = last 50 log lines (from the existing ring buffer), ring-buffered to the **last 10 crashes per app** (older rows pruned on insert).
- **`restart-storm` event:** when restarts exceed `restartStorm.perHour` (default 20, config-optional) emit once per storm (not per restart) with `{ app, count, windowMs, lastExitCode }`. Webhook-eligible. Doctor rule `restart-storm` surfaces active storms with the top exit code and a pointer to `daimon why`.
- **Doctor rule `searchroot-hygiene`:** flags suspicious roots (system directories like C:\Windows, drive roots, nonexistent paths already covered) with a suggested config edit — surfaced, never auto-applied.
- **`daimon why <app>`** (+ `GET /api/why/<app>`): one-shot composition — current status/health, last crash report, grouped recent errors (fingerprint groups, last 24h), regression events, active storm state, suspect commit (`git log -1` at workspaceRoot), matching doctor findings. Compact JSON; TTY mode renders a readable panel.

Acceptance: SIGKILL a fixture child → crash row with exit info + last lines; 21 restarts in an hour → exactly one `restart-storm` event + doctor finding; `daimon why` returns every section populated on a seeded app; crash ring never exceeds 10 rows per app.

---

## M77 · Full-text search

Everything daimon has seen, greppable.

- **FTS5 virtual tables** (better-sqlite3 built-in — no new dep) over errors, events, and logs. Errors/events always indexed (triggers keep FTS in sync with inserts). Log lines indexed per app, default on, opt-out via `search: { logIndex: false }` global or `overrides.<app>.logIndex: false`. Existing retention/pruning cascades into FTS.
- **Migration safety:** FTS tables created on startup if missing; if creation or sync fails, search degrades to LIKE-based fallback with a `self-warn` event — never blocks the daemon. Corrupt-DB auto-rebuild (v0.10) covers FTS too.
- **Surface:** `daimon search <query> [--app <a>] [--since <dur>] [--kind logs|errors|events]` → compact JSON hits `{ kind, app, ts, snippet, ref }`; `GET /api/search?q=&app=&since=&kind=`; dashboard command palette gains a search mode (`>` prefix or dedicated chord) with grouped results; MCP `daimon_search`.
- **Perf:** M54 bench gains a budget — search over the 100k-event corpus < 300ms; insert-path overhead from FTS triggers < 10% on the event-write benchmark.

Acceptance: seeded corpus finds a known string in logs/errors/events with correct refs; `--app`/`--since` filter correctly; FTS-creation failure path degrades to fallback with warning; bench budgets green.

---

## M78 · `daimon context` — the agent context pack

Six round-trips become one.

- **`daimon context <app> [--budget <chars>]`** (+ `GET /api/context/<app>?budget=`): compact JSON assembling — status/url/framework/uptime, grouped recent errors (top 5 fingerprints), last crash report, last test run + failures, compile stats (p50/p95, last regression), suspect commits since last clean baseline, active locks/agents. **Composition of existing queries only — no new state.**
- **Budget behavior:** sections dropped lowest-priority-first (compile stats → agents → crashes → tests → errors → status is never dropped) until under budget; `truncated: [sections]` lists what was dropped.
- **MCP wave:** `daimon_context`, `daimon_run_tests`, `daimon_why` — all via `callJson` (X-Daimon-Agent forwarded). MCP contract tests extended.
- **Claude templates:** `daimon claude update` artifacts teach the new verbs (context first, then targeted calls).

Acceptance: context on a seeded app returns all sections; `--budget 2000` drops sections in documented order and stays under budget; MCP contract suite covers all 3 new tools; templates mention `daimon context`.

---

## M79 · Small wave (v0.11 deferrals + DX)

Parallelizable, cheap-model territory.

- **Deno/Bun runtime profiles:** registry rows (deno.json / bunfig.toml or bun.lock+dev script) + fixtures, per the M65 convention.
- **`DAIMON_HOME` first-class:** env override relocating `~/.daimon/*` (state, lock, history, plugins). Documented for test harnesses; daimon's own e2e drive uses it instead of HOME/USERPROFILE games. Doctor prints the active home.
- **`daimon logs <app> --grep <pattern>`:** streaming filter on live tails (regex, length-capped like custom profiles).
- **Dashboard onboarding tour:** first-run overlay (5–6 steps: mission control, badges, palette, density, tests), dismiss-once persisted.
- **PWA manifest + icons:** installable dashboard, still loopback-only; no service-worker network magic beyond static caching.

Acceptance: both new profiles pass the frameworks suite; e2e drive runs with `DAIMON_HOME` and never touches the real `~/.daimon`; `--grep` filters a live stream; tour shows once and never again after dismiss; Lighthouse recognizes the manifest.

---

## M80 · Polish & ship

- **README:** test/why/search/context sections + a "for agents" subsection (context-first workflow); framework matrix gains Deno/Bun.
- **Docs regen** (CLI reference picks up 5 new verbs; config reference picks up `tests`, `restartStorm`, `search`, `logIndex`, `testCommand`).
- **CHANGELOG `[0.12.0]`** listing M74–M80. **package.json** 0.11.x → 0.12.0 (+ vscode-extension bump).
- **RELEASE-v0.12.0.md** with Migration heading: additive history-DB migration (new tables + FTS, auto-created), `test` now soft-lock gated, new event kinds for webhook filters, `DAIMON_HOME`.
- **CLAUDE.md:** testRunners module + fixtures convention, crash/FTS notes, `DAIMON_HOME`.
- **Playwright live drive:** Tests page run history + drill-down, palette search, `why`-fed detail additions, onboarding tour, both viewports (1280/390).
- **Gates:** tsc clean (3 projects); `npm test` ≥440 cases (from 387) under 35s on a quiet machine (spawn-contention variance is environmental — recorded in v0.11); perf bench green incl. new FTS budgets; bundle < 150KB gzip; doctor clean; every runner parser and new profile has a fixture.

Acceptance: all gates green. Stop at "ready to publish" and report tarball delta, bundle size, test count, new verbs/endpoints/MCP tools/event kinds. Tag **v0.12.0** here. Human publishes (npm/git/vsce).

---

## Out of scope for v0.12 (deferred or never)

- WCAG AA audit + API-stability freeze → the dedicated v1.0-prep release.
- Coverage collection/reporting — the runner's job; daimon stores outcomes, not instrumentation.
- Watch-mode test orchestration — same trap as TS-watch coordination (standing NO).
- Replacing or installing test runners — wrap, don't replace; installs are inviolable.
- Auto-fixing failing tests or user source — standing NO.
- Remote/non-loopback, multi-user/auth, cloud sync, general process manager, desktop GUI, loaded-code plugins — standing NOs.
- TUI `t` test chord, dashboard `why` panel, search deep-links → v0.12.x stretch.

## Sequencing notes

- **M74 → M75** (test chain): flaky detection and the Tests page need run data.
- **M76 is independent** of tests — can run parallel with M74/M75.
- **M77 after M74 + M76:** the FTS schema work should land once the new tables exist, so search covers them from day one.
- **M78 last of the big five** — it composes M74–M77 output; starting it earlier means rework.
- **M79 anytime** — fully parallel, ideal for cheap-model subagents (fixtures, tour, manifest).
- **M80 last.**
- **Delegation guidance:** M74/M76/M77 core logic + final review → strongest model, high effort. M79, fixture authoring, dashboard restyles, docs regen → cheap/fast subagents. Main agent owns every gate; merge subagent work only after its tests pass.
- **Descope order:** Tier-3 stretch first, then M79 items individually, then M77 — never M74–M76.

Rough order: M74 + M76 in parallel → M75 → M77 → M78 → M79 (continuous) → M80.
