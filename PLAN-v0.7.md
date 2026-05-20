# Daimon v0.7 — Plan

Strategic theme: **Memory and reach.** v0.6 made every signal actionable in the *now*. v0.7 makes the *past* actionable (history surfaces) and broadens *what* daimon can manage (polyglot dev servers, whole-workspace orchestration, refreshed TUI).

Non-goals (still): multi-user, SSO, cloud sync, auto-edits to user source code (including `pip install`, `bundle install`, `cargo build`, `go mod download` — same promise as before), binding off 127.0.0.1, exposing `yosi@flycotech.com` in any published artifact, inbound network anything.

Milestones are tentative; bundles of features will be regrouped as work lands.

---

## M37 — History dashboard surface  (was T1, absorbs X4)

**T1a. Bundle-size persistence.** Per the v0.6 lock-in, new `bundles` table in `~/.daimon/history.db` (`app, ts, initialKB, lazyKB, fileCount`). One row per successful bundle parse. `daimon snapshot` automatically carries the new table.

**T1b. Trends HTTP endpoint.** `GET /api/history/trends?app=<name>&metric=<compile|bundle|errors|restarts>&since=<24h|7d|30d>` returns an aggregated time-series compacted for charting: `{app, metric, since, points:[{t, v}], _meta:{aggregation, count}}`. Aggregation is daemon-side (bucketed by hour for 24h, by day for 7d/30d).

**T1c. Dashboard `Trends` route.** New lazy-loaded page with four charts:
- **Compile time** per app — line chart, last 60 samples already exist on `AppState.compileHistory` for live view; the Trends version pulls from history.db for the long view.
- **Bundle size** (initialKB + lazyKB stacked) per app — the X4 chart. Threshold band overlays `bundleRegression.warnPct` if configured.
- **Error frequency** per app — bar chart of error events per bucket.
- **Restart rate** per app — bar chart of `status: error → starting` transitions per bucket.
Toggle between 24h / 7d / 30d; toggle between "all apps" and a single-app focus. Reuses the chart.js lazy chunk already present from M30. Filter chips by `parsed.tool` (from M33) on the error chart.

**T1d. Carry-over: H1 + H3.** The Vitest + Playwright scaffolding (H1) and WCAG AA contrast audit (H3) deferred from v0.6's M35 land here. H1 includes a fixture daemon harness so the Trends page can be tested without a real history.db.

Acceptance: the Trends route renders four interactive charts on a 30-day history; `npm test` in `dashboard/` passes from cold checkout (H1); AA contrast pass in light + dark (H3); bundle history shows up in `daimon snapshot` output.

## M38 — Whole-workspace orchestration  (was T2)

**T2a. `daimon orchestrate <profile>`.** New CLI / HTTP / MCP verb. `POST /api/orchestrate?profile=<name>&goal=serving|healthy|stable&timeoutMs=<n>`. Logic:
1. Resolve the profile's app list (existing `config.profiles[profile]`).
2. Cascade-start using existing F18 `daimon up` ordering (respects `config.depends`).
3. For each app, wait until `goal` or `timeoutMs/2`.
4. Apps that didn't reach goal get one round of `runAutoFix` + restart + wait (same logic as M34's `try-fix`).
5. Return final per-app result.

Returns: `{profile, goal, perApp:[{name, reached, tries, fixed?:[ruleName], stillFailing?:[…first 3 parsed errors]}], totalMs, allReached:boolean}`. Honors `--budget <tokens>` like `overview` (drops `stillFailing` entries first when over-budget).

**T2b. MCP `orchestrate` tool.** Same surface, exposed to Claude. Documented as the recommended way to "bring up my whole workspace" in one MCP call.

**T2c. Idempotency + dry-run.** Already-healthy apps are no-ops. `--dry-run` reports the planned order and currently-unhealthy apps without starting anything.

**Decision (locked):** orchestrate runs **at most one** round of `try-fix` per app. No recursion. If an app still fails, it lands in `stillFailing` and the user/agent decides the next move. Keeps behavior predictable, prevents infinite-loop scenarios, and preserves a clean granular signal ("which rule fixed what") instead of compounded reports across rounds. If real-world use shows multi-stage breakage is common, the upgrade path is bounded-by-progress retry (stop when a round makes no new progress), **not** an arbitrary N-round cap.

Acceptance: orchestrating a 5-app profile with one broken app reports `{allReached:false, perApp:[…4 reached, 1 stillFailing]}` in a single MCP call.

## M39 — Polyglot dev-server discovery  (was T3)

**T3a. Marker-file detectors.** Extend `discoverApps` beyond nx / angular / vite / storybook:
- **Django** — `manage.py` + (`requirements.txt` or `pyproject.toml`); serve command = `python manage.py runserver`.
- **Rails** — `bin/rails` + `Gemfile`; serve = `bin/rails server`.
- **FastAPI** — `pyproject.toml` containing `fastapi`, OR `requirements.txt` containing `fastapi`; serve = `uvicorn main:app --reload` (configurable).
- **Go air** — `.air.toml` OR `air.toml`; serve = `air`.
- **Rust trunk** — `Trunk.toml`; serve = `trunk serve`.

**T3b. `DiscoveredApp.serverProfile`.** New optional field: `'angular'|'nx'|'vite'|'storybook'|'django'|'rails'|'fastapi'|'go-air'|'rust-trunk'`. Existing JS workspace types stay tagged exactly as before — the field is additive.

**T3c. Polyglot parser hints.** `parseLine` gains per-profile serving/error pattern groups so Django's `Watching for file changes with StatReloader` registers as `compiling`, `Quit the server with CONTROL-C` as `serving`, etc. Each polyglot profile gets a fixture file in `test/fixtures/parsers/` (covered by the M33 corpus test).

**T3d. Discovery `--explain` updates.** `daimon discover --explain` and `daimon list --explain` annotate each detected app with its `serverProfile` and surface a "polyglot apps found" hint when any non-JS profile is detected.

**Decision (locked):** daimon **never invokes** language package managers (`pip install`, `bundle install`, `cargo build`, `go mod download`, etc.). The `orphan-node-modules` doctor rule (M36) gains analogous polyglot siblings — `orphan-venv`, `orphan-bundler-cache`, `orphan-cargo-target` — but all four are **report-only** with a "would suggest" hint, never a shell-out.

**Decision (locked):** polyglot detectors run **unconditionally** on every searchRoot, with two safeguards:
1. **Strict markers** — `manage.py` must contain a `django` import (not just the filename); `pyproject.toml` / `requirements.txt` must declare `fastapi` or `django` (not just exist); `Trunk.toml` and `.air.toml` are specific enough to stand alone.
2. **JS detector precedence** — polyglot detectors only run on folders not already claimed by `nx.json` / `angular.json` / vite / storybook detection.

No `searchRoots[*].polyglot: true` opt-in is added in v0.7. If a real false-positive monorepo surfaces, add a reactive escape hatch (`searchRoots[*].excludeProfiles` or `discovery.ignore`) — do not gate the feature preemptively.

Acceptance: a workspace containing one Angular app + one Django app + one Go air project shows three apps in `daimon list`, all start cleanly via `daimon start`, and parsed errors from each tool are tagged with the correct `parsed.tool` (Python's `Traceback` for Django, Rust compile errors for trunk, etc.).

## M40 — TUI parity refresh  (was T6)

**T6a. Shortcut alignment.** The Ink TUI's keys come into line with the dashboard's M35 shortcuts where they apply (`r` restart focused app with snack-confirm equivalent, `o` open URL is preserved, `g a`/`g e`/`g v`/`g s`/`g n` for view switching, `/` for filter).

**T6b. Per-app event ribbon.** The H5 ribbon idea ported to a 20-cell ASCII bar at the top of each app row (e.g. `▓▓░▒▓▓░░░░░░░░░░░░░░ srv·err·cmp·stp`), same 60-min window as the dashboard.

**T6c. Focus / try-fix / orchestrate from TUI.** New action keys: `f` runs `focus --until stable` on the selected app and streams events to the log pane; `x` runs `try-fix` on the selected app; `O` (shift-O) opens an orchestrate dialog (pick profile + goal).

**T6d. Headless mode unchanged.** `--headless` + `config.headless: true` still skip the TUI entirely.

Acceptance: someone working over SSH or in a no-browser shell gets feature parity with the dashboard's daily-driver flows for status, errors, and the v0.6 agent verbs (`focus`/`try-fix`/`orchestrate`).

---

## Deferred to v0.8+

- **T4. Opt-in webhook notifications.** Outbound-only Discord/Slack/generic webhook delivery for `error`/`unhealthy`/`stale` events. Strict opt-in, no telemetry, no inbound. Deferred — not enough user pressure yet, and gets non-trivial config surface.
- **T5. Plug-in surface for doctor rules.** `~/.daimon/plugins/doctor-*.mjs` loaded at startup. Deferred — needs API stability work first; reconsider after v0.7 ships and the M36 rule set has had real-world wear.

---

## Tarball budget

Keep ≤ 2 MB packed. The Trends page reuses the existing chart.js lazy chunk so M37 shouldn't grow the initial bundle. M39's polyglot detectors are daemon-only (no dashboard bundle impact). M40's TUI changes are daemon-side only (Ink is already a dep).

Dashboard initial-route gzip stays ≤ 130 KB (v0.6 baseline: 126 KB).

## Decisions locked in

- **Bundle history lives in `~/.daimon/history.db`** as a new `bundles` table — carries into `daimon snapshot` automatically (re-confirms v0.6's decision).
- **`orchestrate` runs at most one round of `try-fix` per app** — no recursion, predictable bound.
- **Polyglot discovery never runs language package managers.** New doctor rules (`orphan-venv` etc.) are report-only. Daimon's "never touches user source / user project files" promise stays strict and now extends to Python/Ruby/Go/Rust ecosystems.
- **TUI is staying** — refreshed, not deprecated. SSH and no-browser workflows remain first-class.

## Ship target

End of July 2026 if M37+M38 stay scoped. M39 (polyglot) is the most fixture-heavy milestone and most likely to slip into v0.7.1. M40 (TUI parity) should land in the v0.7.0 window if M38 doesn't grow.

## Open questions

(None remaining — M38 and M39 lock-ins resolved during planning.)
