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

## M36 — Auto-heal expansion

**E1. Health probe auto-discovery.** On first `serving`, probe a short candidate list (`/`, `/health`, `/-/health`, `/api/health`, `/ready`, `/healthz`) and offer to pin the first 200/2xx response into `healthProbe.path` override for that app. Eliminates the most common config friction. Pinning is opt-in (one-click in the dashboard, `--accept` flag in CLI) — never silent. (was X2)

**E2. Doctor rule expansion.** New rules added to `daimon doctor --auto-fix`: (was X3)
- `port-conflict-pred` — predicts which configured `portRange` ports are already in LISTEN before start.
- `node-version-mismatch` — compares `.nvmrc` / `engines.node` against `process.versions.node`.
- `orphan-node-modules` — apps whose `package.json` exists but `node_modules` is missing or older than `package-lock.json`. Reports only — never runs `npm install` (see open questions).
- `dead-search-root` — searchRoot whose path no longer exists (was renamed/unmounted); offer to remove from config.

All new rules gated by `config.doctor.autoFix.permitted` like existing rules. Each rule returns a paragraph describing what was wrong, what was done (or would be done in `--dry-run`), and how to undo.

Acceptance: `daimon doctor` on a freshly-cloned workspace with no `node_modules` and an outdated `.nvmrc` produces actionable output without false positives on a healthy workspace.

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
