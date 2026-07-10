# daimon v0.12.0 — "The Whole Loop"

v0.11 finished the *serving* story for 20+ frameworks. v0.12 covers everything around serving: **tests as pipeline citizens**, **crash forensics**, **full-text search** over everything daimon has seen, and a **one-call context pack** for agents. Milestones M74–M80.

## Highlights

### `daimon test` — first-class test runs (M74–M75)

- `daimon test <app>` runs the project's **own** runner (daimon wraps — it never installs, replaces, or watch-orchestrates one). Resolution: `overrides.<app>.testCommand` wins; otherwise the framework profile hints the runner — JS profiles pick vitest vs jest by dependency check, `django`/`fastapi`/`flask` → pytest, `go-air` → `go test ./...`, `rust-trunk`/`tauri` → `cargo test`, `dotnet` → `dotnet test`.
- Failures come back parsed — `{suite, test, file, line, message}` + totals — and land in the new `test_runs`/`test_failures` history tables (`GET /api/tests`). Parsers are fail-soft and fixture-gated (`test/fixtures/testrunners/<id>/`), exactly like framework profiles.
- Exit codes: `0` all pass · `1` failures · `2` timeout (runner tree-killed) · `5` soft-lock held by another agent (`--steal` applies). `test` takes the same per-app soft lock as start/stop, so two agents can't run one app's suite concurrently unaware.
- **Flaky detection:** a fingerprint that flips pass↔fail ≥3× at the same `gitHead` fires `flaky-test-detected` once (threshold: `tests.flakyThreshold`). Failing runs fire `test-failed`. Both are webhook-eligible. `daimon test-history <app> [--flaky]`.
- The dashboard **Tests page** is now run history: pass/fail sparklines, drill-down with VS Code links, run-to-run diff, flaky badges.

### Crash forensics + `daimon why` (M76)

- Every child exit daimon didn't request persists a **crash report** — exit code, signal, uptime, the last 50 log lines, the git head — ring-buffered to the last 10 per app.
- **Restart storms** (> `restartStorm.perHour` unrequested exits/hour, default 20) fire exactly one `restart-storm` event per storm, plus a doctor rule with the top exit code and a pointer to `daimon why`.
- `daimon why <app>` (+ `GET /api/why/<app>`) answers "why is this broken" in one shot: status, last crash, fingerprint-grouped 24h errors, regressions, storm state, suspect commit, matching doctor findings. TTY gets a readable panel.
- New suggest-only doctor rule `searchroot-hygiene` flags drive roots / system dirs / bare home as searchRoots.

### Full-text search (M77)

- FTS5 (already inside the bundled better-sqlite3 — zero new dependencies) over **events, errors, and per-app log lines**. Log indexing defaults on; opt out globally (`search.logIndex: false`) or per app (`overrides.<app>.logIndex: false`). Errors/events are always indexed.
- `daimon search <q> [--app] [--since 24h] [--kind logs|errors|events]` → `{kind, app, ts, snippet, ref}` hits; trailing `*` = prefix search. Also `GET /api/search`, MCP `daimon_search`, and a dashboard palette search mode (`>` prefix).
- Indexing is **deferred** (high-water-mark sync on idle ticks / before retention / before every search), keeping the insert path clean — measured well under the 10% overhead budget where synchronous triggers cost 4–10×. Search on a 100k-event corpus stays under 300ms in the perf suite.
- If FTS setup or sync ever fails, search degrades to a LIKE scan (`fallback: true`) with a one-time self-warn — the daemon never blocks on search.

### `daimon context` — the agent context pack (M78)

- `daimon context <app> [--budget <chars>]` (+ `GET /api/context/<app>`) assembles status/framework/uptime, top error groups, last crash, last test run + failures, compile stats, suspect commits, and active locks/agents — **one call instead of six**. Pure composition; no new state.
- Budget drops sections lowest-priority-first (`compile → agents → crashes → tests → errors`; `status` never drops) and reports the drops in `truncated[]`.
- MCP grows `daimon_context`, `daimon_run_tests`, `daimon_why`, `daimon_search` (25 tools); `daimon claude update` refreshes the skill/agent templates to teach the context-first workflow.

### Small wave (M79)

- **Deno + Bun** runtime profiles (fixture-gated, like every profile).
- **`DAIMON_HOME`** relocates the entire `~/.daimon` state dir; `daimon doctor` prints the active home.
- **`daimon logs --grep <regex> [--stream]`** — server-side filtered live tails (pattern length-capped).
- Dashboard: first-run **onboarding tour** (dismiss-once) and a **PWA manifest** (installable, loopback-only, static assets only).

## Migration

Nothing breaks; everything below is additive.

1. **History DB** — new tables (`test_runs`, `test_failures`, `crashes`, `log_lines`, `fts_state`) and FTS5 virtual tables are created automatically on first startup (`CREATE TABLE IF NOT EXISTS`). Existing rows are preserved; historical events are indexed for search in the background after upgrade. The v0.10 corrupt-DB auto-rebuild covers the new tables too.
2. **Log-line indexing is on by default.** Per-app log lines now land in the history DB (pruned by the same `history.retentionDays`). If you don't want an app's logs searchable, set `search: { "logIndex": false }` globally or `overrides.<app>.logIndex: false`.
3. **`daimon test` is soft-lock gated** like start/stop/restart: a concurrent `test` from another agent gets HTTP 409 / exit 5; pass `--steal` to override.
4. **New event kinds** — `test-run`, `test-failed`, `flaky-test-detected`, `crash`, `restart-storm` — flow to the events feed and webhooks. If your webhook entries use an `events` allow-list, add the kinds you want; entries without `events` receive them automatically.
5. **`DAIMON_HOME`** (optional) relocates `~/.daimon`. Unset = unchanged behavior.
6. **New config keys** (all optional, safe defaults): `tests.flakyThreshold` (3), `restartStorm.perHour` (20), `search.logIndex` (true), `overrides.<app>.testCommand`, `overrides.<app>.logIndex`.

## Numbers

- Test suite: **471+ tests** (from 387), all green; includes perf budgets for FTS search (<300ms on 100k events) and insert-path overhead (<10%).
- MCP surface: **25 tools** (from 21). New CLI verbs: `test`, `test-history`, `search`, `context` (+ upgraded `why`, `logs --grep/--stream`).
- New HTTP endpoints: `POST /api/apps/:name/test`, `GET /api/tests`, `GET /api/tests/flaky`, `GET /api/search`, `GET /api/why/:name`, `GET /api/context/:name`.

Published by Yosi Azulay (https://flycotech.com) under PolyForm Noncommercial 1.0.0.
