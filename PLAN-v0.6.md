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

## M34 — Agent-first surface

**A1. `daimon focus <app>`.** One round-trip subscribe-then-act: streams status + new errors + announced URL changes until the app reaches a target state (`--until serving|healthy|stable`) or `--timeout`. Designed so Claude can issue one MCP call and read a coherent narrative back instead of polling.

**A2. `daimon diff-errors --since-last --client <id>` exposed as MCP.** F2 already exists as CLI; expose as `daimon_diff_errors` MCP tool with a small-by-default token budget.

**A3. `daimon try-fix <app>`.** Composite: run `doctor --auto-fix` for the rules that touch this app, restart, wait for `--until`, then return `{before, after, fixed:["stale-lock", ...], stillFailing:[]}`. Never edits user source — only daemon state.

**A4. `daimon overview --budget <tokens>`.** Compact-by-default `overview` gets a hard token budget; rows past the budget collapse to `{omitted: N}`. Makes the session-opener predictable for agents.

Acceptance: agent loop "start → fix → verify" needs ≤3 MCP calls on a typical broken workspace.

## M35 — Dashboard depth

**H1. Dashboard unit + smoke tests.** Vitest + a fixture daemon serving canned `/api/*` responses. One spec per signal-bearing component: `dm-apps-list`, `dm-errors-panel`, `dm-events-feed`, `dm-config-editor`, `dm-doctor-page`. Playwright smoke for `route enter → action → state reflected`.

**H2. Keyboard-driven UX.** `?` opens a shortcut sheet. `g a` / `g e` / `g l` / `g s` / `g d` jump to apps/errors/logs/settings/doctor. `/` focuses the global filter on the current page. `r` restarts the focused app (with a confirm step).

**H3. WCAG AA on M3 surfaces.** Audit contrast on `--mat-sys-surface-*` token combinations; fix the 2–3 places where chip/label colors fail at AA. Reduced-motion path already exists from M30 — verify it's complete.

**H4. Dashboard log viewer with search.** SSE log stream already exists. Build a `Logs` page with regex filter, per-app multi-select, level coloring, and a "jump to next error" affordance. Closes the gap that forced the user to read raw daemon stdout to find the esbuild format during v0.5. (was X1)

**H5. Restart/event ribbon per app.** Each card grows a thin top ribbon (~6px) showing the last N status events as colored ticks over a rolling window (60min default). Helps spot flaky apps at a glance without opening the app-detail panel. (was X5)

Acceptance: `npm test` in `dashboard/` passes from cold checkout; tab-only navigation reaches every primary action; the Logs page can locate a known error by regex in <1s on a 10-app workspace.

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
