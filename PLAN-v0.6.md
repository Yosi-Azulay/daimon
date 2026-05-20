# Daimon v0.6 — Plan

Strategic theme: **Every signal becomes actionable.** v0.5 polished the surfaces. v0.6 makes each signal Daimon already collects (errors, bundles, health, restarts, logs) drive a concrete next step for either the human or the agent.

Non-goals (still): multi-user, SSO, cloud sync, auto-edits to user source code, binding off 127.0.0.1, exposing `yosi@flycotech.com` in any published artifact.

Milestones are tentative; bundles of features will be regrouped as work lands.

---

## M33 — Parser depth ✅ shipped

**P1. Parser corpus + tests.** ✅ `test/fixtures/parsers/*.log` (+ `.expected.json`) for vite/storybook/jest/nx/angular-esbuild/webpack/node. Driven by `test/parser-corpus.test.mjs` (≥95% capture rate + tool + status assertions).

**P2. Multi-tool parsers.** ✅ `parseLine` now tags errors with `parsed.tool ∈ {esbuild, vite, storybook, jest, nx, webpack, node, typescript}`. Added location patterns for TSC-style `file(line,col):`, stack-trace `(file:line:col)`, webpack `ERROR in <path>`, and Jest `FAIL <path>`. Stack-trace lines back-fill the most-recent error that has no file.

**P3. Errors-panel grouping by tool.** ✅ `dm-errors-panel` gains a `tool` group chip; each tool group has a tinted chip header.

**Fix:** `webpack compiled with N errors` no longer triggers the serving pattern (which had been clearing the error map on every webpack build summary line).

## M34 — Agent-first surface ✅ shipped

**A1. `daimon focus <app>`** ✅ — CLI + `POST /api/apps/:name/focus?until=serving|healthy|stable[&timeoutMs=]` (NDJSON). MCP `focus` aggregates events into `{events, final}`. Stable = serving+healthy+5s idle.

**A2. `diff_errors` MCP** ✅ — wraps `/api/apps/:name/errors/since-last?client=…` with a `budget` (token) cap; overflow → `_meta.omitted`.

**A3. `daimon try-fix <app>`** ✅ — CLI + `POST /api/apps/:name/try-fix` runs `runAutoFix` (permitted rules), restarts, waits, returns `{before, after, fixed, stillFailing, reached, waitedMs, _meta:{autoFix, restartErr, timedOut}}`.

**A4. `daimon overview --budget <tokens>`** ✅ — CLI + `/api/overview?budget=…`. Drops from `needsAttention` first, then `recentlyChanged`; reports counts via `_meta.omitted`.

**Acceptance:** start→fix→verify is now `overview` → `try_fix` → `focus until=stable` = 3 MCP calls.

## M35 — Dashboard depth (partial — ships in v0.6.0)

**H2** ✅ — `g e` → Errors, `g s` → Settings (alias of `/config`), `g v` → Events, `g n` → Sessions. `r` requires snack-bar confirm. Legacy `g r` / `g c` kept as aliases.

**H4** ✅ — Logs page gains `.* regex` toggle (case-insensitive) with inline parse error, plus `Next error` jump button that scrolls the virtual viewport to the next error row.

**H5** ✅ — Apps cards grow a 6px ribbon between accent and status row showing 20 buckets over the last 60 min. Hover tooltip summarises counts per state.

**H1** ⏭ deferred to v0.6.1 — Vitest + Playwright dev-deps + per-component specs + fixture daemon. One full session of scaffolding.

**H3** ⏭ deferred to v0.6.1 — WCAG AA audit across M3 surface tokens in light + dark + reduced-motion. Visual inspection task.

Acceptance left for v0.6.1: `dashboard/npm test` from cold checkout; tab-only nav coverage; AA contrast pass.

## M36 — Auto-heal expansion ✅ shipped

**E1** ✅ — Health monitor scans `['/', '/health', '/-/health', '/api/health', '/ready', '/healthz']` on first serving; stores winner on `AppState.discoveredHealthPath`; emits an event with the pin instructions. Pin = `POST /api/apps/:name/health/pin {path}` → writes `overrides.<name>.healthProbePath`. CLI: `daimon pin-health <name> [--accept] [--path]`. New optional `AppOverride.healthProbePath` field; v0.5 configs load unchanged.

**E2** ✅ — `runAutoFix` gains four rules: `port-conflict-pred`, `node-version-mismatch`, `orphan-node-modules` (report-only, never runs npm install per the decision lock-in), `dead-search-root` (removes dead entries + soft-reload). All gated by `doctor.autoFix.permitted`; default `permitted` list extended to include them. Backwards-compatibility test in `test/autofix-rules.test.mjs`.

---

## Deferred to v0.7+

**X4. Bundle regression timeline.** `bundleRegressionPct` is already collected. Persist per-app bundle size to `history.db`; render a sparkline (initialKB over the last 30 commits, derived from history events) on each app card; alert in `events-feed` when growth crosses a threshold per `bundleRegression.warnPct` config. Deferred — the signal exists but no measurable user pressure yet.

---

## Tarball budget

Keep ≤2 MB packed (v0.5 budget). Vitest + Playwright are dev-only, never shipped. Any new lazy chunk must justify >50 KB raw against a measurable agent or human workflow.

## Decisions locked in

- **`try-fix` and `orphan-node-modules` never shell out to package managers.** The rule reports the missing/stale `node_modules` and emits a "would suggest: `npm install`" hint. Daimon's "never touches user source / user project files" promise stays strict.
- **Bundle history (if/when X4 lands) lives in the existing `~/.daimon/history.db`** as a new table, so `daimon snapshot` automatically carries it into bug-report exports.

## Ship target

End of June 2026 if M33+M34 stay scoped. M35/M36 can slip into v0.6.1 if either grows past one weekend of work.
