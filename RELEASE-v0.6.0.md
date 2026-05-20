# daimon v0.6.0 — Every signal becomes actionable

Install: `npm i -g daimon@0.6.0`

v0.5 polished the surfaces. v0.6 makes each signal Daimon already collects (errors, bundles, health, restarts, logs) drive a concrete next step for either the human or the agent.

## Highlights

- **3-call agent loop.** `overview` → `try_fix` → `focus --until stable`. The new MCP/CLI verbs make a typical broken-workspace recovery cycle measurable and predictable.
- **Parser knows every tool now.** Vite, Storybook, Jest, Nx, Angular esbuild, webpack, Node native, and TSC-style errors all land structured with a `parsed.tool` tag. Backed by a fixture corpus that fails CI on regression.
- **Opt-in health-probe discovery.** First `serving` probes `/`, `/health`, `/-/health`, `/api/health`, `/ready`, `/healthz`; pins the winning path on `daimon pin-health <app> --accept`.
- **Four new doctor rules.** `port-conflict-pred`, `node-version-mismatch`, `orphan-node-modules` (report-only — daimon never runs `npm install`), `dead-search-root`.
- **Dashboard polish (partial).** Realigned keyboard shortcuts (`g e`/`g s`/`g v`/`g n`), Logs regex filter + jump-to-next-error, 6px per-app event ribbon. Vitest/Playwright tests and the WCAG AA audit (H1/H3) slip to v0.6.1.
- **Initial-route bundle: 126 KB gzip** (down from 151 KB at v0.5 HEAD; under the 130 KB v0.6 ceiling).

## Added (M33) — Parser depth

- **P1 — Parser corpus + tests.** New `test/fixtures/parsers/*.log` for Vite, Storybook, Jest, Nx, Angular esbuild, webpack, and Node native, each paired with a `.expected.json` of `{tool, status, errors:[{file,line,col,code}]}`. New `test/parser-corpus.test.mjs` replays every fixture through `parseLine` and asserts ≥95% capture rate on file-bearing lines plus tool tagging. Captures parser regressions in CI instead of via screenshots.
- **P2 — Multi-tool parsers.** `parseLine` now detects and tags errors from Vite (`[vite]`, `[plugin:vite:…]`, `transformWithEsbuild`), Storybook (`ERR!`, `builder-vite`), Jest (`FAIL <path>`, `● <test>`), Nx (`>  NX … failed`, `Failed tasks:`), webpack (`Module not found:`, `ERROR in <path>[:L:C|<sp>L:C]`), Node native (`Error|TypeError|… at <file>:<L>:<C>`), and TSC-style `file(line,col): error TSnnn`. Parsed entries gain a new optional `tool` field (`ParserTool` in `types.ts`). Stack-trace style `(file:line:col)` locations are extracted and also back-fill the most-recent error entry that has no file.
- **P3 — Errors-panel grouping by tool.** Dashboard `Errors` page gains a fourth `Group by` tab: `tool`. Each tool group renders with a colored chip per tool (esbuild/vite → primary, jest/nx → secondary, storybook/webpack → tertiary, node/typescript → neutral) and lists per-app, per-file rows.

## Fixed (M33)

- **Webpack "compiled with N errors" no longer clears the error map.** The serving pattern was loosened to `webpack compiled (?:successfully|in)` so a build summary that includes errors does not transition the state to `serving` and wipe collected errors.

## Added (M34) — Agent-first surface

- **A1 — `daimon focus <app>`.** New CLI / HTTP / MCP verb. One round-trip subscribe-then-act over `POST /api/apps/:name/focus?until=serving|healthy|stable[&timeoutMs=]` that streams NDJSON events: `{kind:"subscribed"|"status"|"health"|"error"|"done", …}`. `--until stable` resolves when the app is serving + healthy with no event for ≥5s. Designed so an agent issues one MCP call and reads a coherent narrative instead of polling. CLI exits when the stream ends; MCP `focus` aggregates events into `{events, final}`.
- **A2 — `diff_errors` MCP tool.** Wraps the existing F2 `errors --since-last --client <id>` HTTP endpoint as a dedicated MCP tool with a `budget` (token) cap; overflow rows are dropped and reported as `_meta.omitted`. Compact `{file,line,col,code,tool,message}` per entry.
- **A3 — `daimon try-fix <app>`.** New CLI / HTTP / MCP verb. `POST /api/apps/:name/try-fix?until=…` composes `runAutoFix` (permitted rules), `registry.restart(name)`, and `registry.waitFor(name, until)`, then returns `{before:{status,health,errCount,firstError}, after:{status,health,errCount}, fixed:[ruleName], stillFailing:[…first 5 parsed errors], reached, waitedMs}`. Never edits user source — only daemon state, exactly as the F58 rules already did.
- **A4 — `daimon overview --budget <tokens>`.** Both the HTTP endpoint and the CLI accept a token budget. Rows past the budget are dropped from `needsAttention` first, then `recentlyChanged`, with the counts reported as `_meta.omitted.{needsAttention,recentlyChanged}`. Makes the session-opener predictable for agents.
- **Test:** new `test/overview-budget.test.mjs` covers the truncation invariants (no-op under-budget, truncates over-budget, no-op on empty input).

## Added (M35 partial) — Dashboard depth

- **H2 — Keyboard shortcuts realigned with the v0.6 spec.** `g e` now jumps to **Errors** (was Events; Events moved to `g v`). `g s` now jumps to **Settings** (alias of `/config`; the previous `g s` → Sessions moved to `g n`). The legacy `g r` → Errors and `g c` → Settings bindings remain as aliases for muscle memory. `r` (restart focused app) now requires a snack-bar confirm before firing, eliminating accidental restarts during keyboard navigation.
- **H4 — Logs page: regex filter + jump-to-next-error.** A `.* regex` toggle on the filter bar switches between substring and regex matching (case-insensitive). Invalid patterns surface inline (`mat-icon warning` + parser message) instead of throwing. A `Next error` button scrolls the virtual viewport to the next `severity === 'error'` row from the current visible end, wrapping to the top.
- **H5 — Per-app event ribbon.** Each card on `Apps` gains a 6px ribbon between the workspace-tone accent and the status row, showing the last 60 minutes of status events as 20 colored buckets (primary tint = serving, error = error, tertiary = compiling/starting, outline-variant = stopped). Hover shows a `last 60 min: 5 serving · 2 error` summary. Empty for apps with no recent transitions.

## Deferred (M35 → v0.6.1)

- **H1 — Vitest + Playwright dashboard tests.** Adds non-trivial dev-deps (Vitest + Playwright + Angular bridge config), a fixture-daemon harness, and per-component specs. Out of scope for the v0.6.0 weekend; will land in v0.6.1.
- **H3 — WCAG AA contrast audit.** Needs visual inspection across all M3 tonal surfaces under light + dark + reduced-motion. Pushed to v0.6.1 alongside H1; reduced-motion path from M30 is already verified.

## Fixed (M35 follow-up) — Initial-route bundle back under budget

- **Initial-route gzip transfer: 126.01 KB** (down from 151 KB at v0.5 HEAD; well under the 130 KB v0.6 ceiling). Achieved with three surgical lazy-loads, no functional change:
  - `MatDialog` import is now dynamic — the keyboard `?` help dialog imports `@angular/material/dialog` only when triggered.
  - `<dm-command-palette>` is wrapped in `@defer (when paletteActivated())`; the palette mounts on first `Ctrl/⌘+K`, and the activation handler re-dispatches the `daimon:cmdk` event so the user only presses the chord once.
  - `MatMenu`-based dropdowns in `dm-topbar` and `dm-theme-toggle` are replaced with native-button + `@if` popovers (`HostListener('document:click')` for outside-click close). Removes `MatMenuModule` + CDK overlay/portal from the initial chunk.
  - `MatSnackBar` is no longer eager in `dm-topbar`; `runProfile()` now uses a small inline DOM toast (positioned via `mat-sys-inverse-surface` tokens to stay in M3). The apps-list (route-lazy) keeps `MatSnackBar` for the `r` restart confirm — that import lives in its own lazy chunk.
- Bundle structure delta: `MatDialog`/`MatMenu`/`MatSnackBar`/Overlay+Portal moved out of eager into either a deferred chunk or are absent. No functional regression: the help dialog still opens on `?`, the palette still opens on `⌘K`, the workspace + profile dropdowns still work, and the runProfile toast still appears.

## Added (M36) — Auto-heal expansion

- **E1 — Health-probe path auto-discovery.** On first `serving` (when there is no `overrides.<name>.url`, no `overrides.<name>.healthProbePath`, and the global `healthProbe.path` is the default `/`), the monitor runs one in-flight scan against `['/', '/health', '/-/health', '/api/health', '/ready', '/healthz']`, taking the first strictly-2xx response. The discovered path is stored on `AppState.discoveredHealthPath` and an event is recorded: `discovered probe path: /health (pin via POST /api/apps/<name>/health/pin or daimon pin-health <name> --accept)`. The discovery is used by subsequent probes immediately, but **persistence is opt-in** — nothing is written to `daimon.config.json` until the user accepts.
- **`daimon pin-health <name> [--accept] [--path <p>]` + `POST /api/apps/:name/health/pin`.** Without `--accept` the CLI just reports the discovered candidate; with `--accept` it writes `overrides.<name>.healthProbePath` to the active `daimon.config.json` and triggers soft-reload. `AppOverride.healthProbePath` is a new optional field; v0.5 configs continue to load unchanged.
- **E2 — Four new doctor rules** added to `daimon doctor --auto-fix`:
  - `port-conflict-pred` — predicts which configured `portRange` endpoints + pinned ports are already in LISTEN. Reports only; no kill.
  - `node-version-mismatch` — compares `.nvmrc` then `package.json#engines.node` against `process.versions.node`. Reports only; switching Node versions stays a user action.
  - `orphan-node-modules` — flags `searchRoots` whose `package.json` exists but `node_modules` is missing, or older than `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`. Per locked decision in `PLAN-v0.6.md`, daimon **never runs npm/pnpm/yarn install** — the rule emits a `would suggest: (cd ... && npm install)` paragraph instead.
  - `dead-search-root` — finds `searchRoots` that no longer resolve on disk and removes them from the config file (with a soft-reload), printing a `to undo: re-add` paragraph.
- All four rules are added to `ALL_AUTO_FIX` and to the default `doctor.autoFix.permitted` list. v0.5 configs whose `permitted` list is shorter are honored as-is — the new rules just don't activate for them.
- **Test:** `test/autofix-rules.test.mjs` asserts the new rule names are present in `ALL_AUTO_FIX` and the original M28 rules are still listed (backwards-compat smoke).

## Verification

- `tsc -p .` + `tsc -p dashboard/` — both clean
- `npm test` — 31/31 pass (was 18 at v0.5; M33+M34+M36 added 13 new tests)
- Tarball — 492.4 KB packed / 1.8 MB unpacked / 49 files (budget: ≤ 2 MB)
- License — PolyForm Noncommercial 1.0.0 (unchanged)

**Full plan:** [`PLAN-v0.6.md`](https://github.com/Yosi-Azulay/daimon/blob/v0.6.0/PLAN-v0.6.md)
**Full changelog:** [`CHANGELOG.md`](https://github.com/Yosi-Azulay/daimon/blob/v0.6.0/CHANGELOG.md)
