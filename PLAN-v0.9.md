# daimon v0.9 — "Multi-agent observability"

8 milestones · ~2 weeks · folds in uncommitted v0.8.x-trailing work plus three new theme tracks (multi-workspace, observability, polyglot reach) plus the v0.8 polish carry-overs.

## Theme

Daimon has been a single-workspace tool with one user driving it. v0.9 finishes the pivot to **many agents on one machine, each in their own workspace, all sharing one daemon and one dashboard**. On top of the architectural shift, deepen what daimon *sees* (lint findings as a third signal class beyond errors + warnings) and *shows* (a unified event timeline), and broaden what it *understands* (framework-aware health probes for the polyglot stack landed in v0.7's M39).

## Decisions locked in

- **Single daemon, multi-workspace.** Agents do not get their own port. Daemon stays on `127.0.0.1:4999`. CLI scoping happens by passing `cwd=` to `/api/apps`; commands honor scope; dashboard reads `?cwd=` to set its workspace filter.
- **Name collisions across workspaces (M47):** hard error with disambiguation hint (`use --workspace <label>`). No auto-pick magic.
- **Lint findings (M50):** parse only — read what the dev server already emits. Daimon never spawns linters of its own.
- **Loopback only, no auto-fixing user code, no remote access, no multi-user/SSO/cloud sync.** PolyForm Noncommercial 1.0.0.
- **Public author string:** `Yosi Azulay (https://flycotech.com)`. Email must NOT appear in any new published artifact.
- **State changes confined to `~/.daimon/*` and `daimon.config.json`.**
- **npm publish is human-driven with 2FA.** Agent stops at "ready to publish".

---

## M46 · Multi-workspace foundation — ALREADY DONE (uncommitted)

Scope already implemented on the working tree. Captured here for the release notes.

- `src/pathScope.ts` — `isPathUnder`, `normalizeForCompare` (case-insensitive Win, separator-normalized)
- `POST /api/workspaces/ensure { path }` — idempotent register; returns `{ added, root, addedApps }` or `already covered`
- `GET /api/apps?cwd=<path>` — filter by `workspaceRoot` under cwd; explain meta carries `cwdScope`
- `daimon list` defaults to cwd-scoped; `--all` bypasses; auto-calls `ensureCurrentWorkspace()`
- Warnings: `WARNING_PATTERNS` in parser; `ErrorEntry.level?: 'error'|'warning'`; new `AppEventType` `warning-new` / `warning-recur`; `compactError` carries `level`; `?level=error|warning|all` filter on `/api/apps/:name/errors`
- Errors page: Severity chips (errors / warnings / all); subhead splits counts; warning rows get tertiary accent
- TrendChartComponent: `loading`/`empty`/`title`/`subtitle` are signals — fixes the eternal-skeleton zoneless+OnPush regression
- `scripts/dev-install.mjs` + `npm run dev:install` / `dev:install:fast` / `dev:unlink`
- Fixtures: `ng-warning.{log,expected.json}`; 8 new path-scope tests. **106/106 daemon, 5/5 dashboard.**

Acceptance: already shipped on branch, just needs commit.

---

## M47 · Per-cwd command resolution

Make every single-app command cwd-aware so two agents with same-named apps can coexist.

Targets: `start`, `stop`, `restart`, `status`, `logs`, `errors`, `wait`, `watch`, `run`.

- **Server:** every single-app endpoint accepts a `?cwd=` query param. Before resolving `<name>` to an app, filter the candidate set to apps whose `workspaceRoot` is under cwd. If 1 match → proceed. If 0 → 404 with hint `"no app named '<name>' under cwd '<cwd>'. Use --all or --workspace to broaden search."` If >1 → **412** with body `{ error: 'name-collision', candidates: [{ name, workspaceLabel, workspaceRoot }, ...], hint: "use --workspace <label>" }`.
- **CLI:** every command in the list above sends `?cwd=<process.cwd()>` unless `--all` is set or `--workspace <label>` resolves to a specific one. On 412 collision, render the candidate list with workspace labels in a human-readable form.
- **MCP:** `daimon_start` / `daimon_stop` / `daimon_errors` accept optional `cwd` param (defaults to caller's cwd if discoverable). Same collision UX as CLI.
- **Internal:** add `Registry.resolveByCwd(name, cwd?)` helper used by every endpoint.

Acceptance:
- `tsc -p .` clean.
- `npm test` — new fixture: spin two `editor` apps under two different `workspaceRoot`s; `daimon start editor --cwd <A>` starts A's only.
- Live drive: two workspaces with same-named app; cwd-bound start works; `--all` start fails with collision; `--workspace <label>` resolves.

---

## M48 · Workspace registry CLI + audit attribution

Make workspaces a first-class concept on the CLI surface, and record who-did-what.

- **New verbs:**
  - `daimon workspaces list` — JSON array of `{ path, label, appCount, lastSeenAt }`.
  - `daimon workspaces add <path> [--label <name>]` — same as `/api/workspaces/ensure` but accepts a custom workspace label (which becomes `workspaceLabel` on discovered apps).
  - `daimon workspaces rm <path>` — removes from `searchRoots`, soft-reloads, returns `{ removedApps: […] }`.
  - `daimon workspaces show [--cwd <path>]` — describes which workspace covers the cwd (or current cwd if omitted).
- **Audit trail:** existing `appendAuditEntry` extended to include `cwd` (CLI passes its `process.cwd()` via `X-Daimon-Cwd` header on every authenticated POST). Audit log entries: `{ ts, remote, cwd, action, ... }`. View via `daimon audit tail` (existing).
- **Server endpoints:** `GET /api/workspaces` (list), `POST /api/workspaces/remove { path }`, `GET /api/workspaces/resolve?cwd=<p>` (returns which root covers it).

Acceptance:
- Audit log entries for state-changing ops include `cwd`.
- `daimon workspaces list` returns >0 entries after `daimon list` was invoked from an unknown cwd.
- `daimon workspaces rm <path>` shrinks `searchRoots` and apps disappear from `/api/apps`.

---

## M49 · Dashboard cwd context

Make the web UI workspace-aware without breaking "one dashboard sees everything".

- **URL param:** dashboard reads `?cwd=<path>` from window.location. If present, **pre-selects the workspace filter pill** that contains that cwd. If no matching workspace, shows a banner "the cwd `<X>` isn't registered yet — add it" with a button calling `/api/workspaces/ensure`.
- **Open-from-CLI helper:** `daimon dashboard` (new verb) opens the default browser to `http://127.0.0.1:4999/?cwd=<process.cwd()>`. This is the path from "I'm in folder B, show me my dashboard view".
- **Header badge:** when a workspace filter is active, show a small chip near the header like `scope: <workspace-label>` with an `×` to clear back to "all workspaces".
- **No regressions:** when no `?cwd=` and no manual filter, dashboard still shows everything (preserves current default behavior).

Acceptance:
- `daimon dashboard` from cwd A opens browser, dashboard shows only A's apps.
- Clicking the `×` chip clears scope and reveals all apps.
- Unknown-cwd banner offers register button and works.

---

## M50 · Lint-findings channel

Parse linter output that already flows through the dev-server log stream. **No spawning of linters by daimon.**

- **Parser:** extend `parseLine` with `LINT_PATTERNS`. Tested AFTER warnings, before final no-match return. Patterns cover:
  - `eslint`: ` <file>:<line>:<col>  warning  <message>  <rule>` and `error` variants
  - `biome`: `[<file>:<line>:<col>] <severity>: <message>` / `lint/...`
  - `ruff`: `<file>:<line>:<col>: <code> <message>` where code matches `[A-Z]\d{3,}`
  - `clippy` (rust): `^warning: <message>` followed by `--> <file>:<line>:<col>`
- **Type:** `ErrorEntry.level?: 'error'|'warning'|'lint'`. Status never flips for `lint`. Events: `lint-new` / `lint-recur` (new AppEventType values).
- **Server:** `?level=` filter accepts `lint`. Default response (no `level` param) still returns errors only.
- **Dashboard:** Errors page severity chips become **errors / warnings / lint / all**. Lint rows get a third accent color (`--mat-sys-secondary` tint). Subhead splits all three counts.
- **History:** lint events do NOT count in error trends. New per-app `lintCount` on AppSummary.

Acceptance:
- Fixture `lint-eslint.log` / `lint-biome.log` / `lint-ruff.log` / `lint-clippy.log` parsed; entries tagged `level==='lint'`.
- Status never flips to `error` from a lint line.
- `daimon errors editor --level=lint` returns lint-only.
- Dashboard severity toggle works; lint rows visually distinct from warnings/errors.

---

## M51 · Unified event timeline

A single chronological view of everything that happens.

- **Data:** existing `history.queryEvents` + augment with `compile_times`, `bundles`, `task_runs` joined by ts. Build a unified `TimelineEvent` type: `{ ts, app, kind: 'status'|'error'|'warning'|'lint'|'restart'|'bundle'|'task'|'health', summary, payload }`.
- **Server:** `GET /api/history/timeline?since=<dur>&app=<name>&kinds=<csv>` returns sorted-descending array.
- **Dashboard:** new route `/timeline` (lazy chunk). Vertical scrub list with infinite scroll, color-coded kind chips, filters in header (app multi-select, kind multi-select, time window). Click a row → flyout drawer with full payload.
- **Wire in nav-rail:** add a `Timeline` entry between History and Tests.
- **Performance:** virtual scroll for >500 rows; lazy-load older pages on scroll.

Acceptance:
- 7-day timeline renders in <300ms with 5,000 events.
- Filtering by kind narrows the list client-side.
- Clicking a row reveals payload without navigating away.

---

## M52 · Polyglot v2 health probes

Make daimon understand what "healthy" means for each framework profile, with smart defaults.

- **Profile registry:** new module `src/healthProfiles.ts` with per-profile probe defaults:
  - `django` → probe path `/admin/login/` (200 or 302)
  - `rails` → `/up` (Rails 7.1+) with fallback `/` (200)
  - `fastapi` → `/docs` (200)
  - `go-air` → `/` (200)
  - `rust-trunk` → `/` (200)
  - `nx` / `angular` / `vite` / `storybook` → existing behavior
- **Discovery integration:** when `serverProfile` is set on a discovered app, the resolved health probe path defaults to the profile's recommendation. User override (`healthProbePath` in config) still wins.
- **Smart probe outcome:** treat 200, 302, 401 (auth-gated but alive) as healthy. 5xx is unhealthy. Connection refused is unhealthy. ECONNRESET is unhealthy.
- **Doctor rule:** new rule `health-probe-missing` flags apps with no resolved probe path; auto-fix sets the profile default.

Acceptance:
- Fresh Rails app (Rails 7.1 with `/up`) → health flips to `healthy` automatically.
- Fresh FastAPI app → `/docs` probe works without config.
- `daimon doctor` flags missing probe paths.

---

## M53 · Polish & ship

Carry-overs from v0.8.1 + release prep.

- **Doctor 11-rule UI:** render all rules from `ALL_AUTO_FIX`, dimming the ones not in `doctor.autoFix.permitted`. Per-rule toggle to permit (PATCH config).
- **Help dialog:** new key chord rows for `daimon workspaces` and `daimon dashboard`. Tabs accessible via screen reader.
- **README:** new "Multi-agent / multi-workspace" section explaining the model and `--all` flag. Update `daimon list` example. Document the lint channel.
- **CHANGELOG:** add `[0.9.0]` section listing M46-M53.
- **package.json:** bump 0.8.1 → 0.9.0.
- **RELEASE-v0.9.0.md:** Added / Changed / Fixed / Migration notes (multi-workspace is the migration headline).

Acceptance:
- `tsc -p .` clean; `tsc -p dashboard/` clean.
- `npm test` 100% pass.
- `npm run build:dashboard` clean; initial bundle < 135 KB gzip.
- Live Playwright drive against a workspace with ≥1 `error` + ≥1 `serving` app (the lesson from v0.8.0). Smoke all 11 routes (Apps, App detail, Errors, Logs, History, Trends, Tests, Sessions, Doctor, Config, Plug-ins, Timeline).
- `npm pack` → tarball size delta logged.
- "Ready to publish" status; agent stops, human runs `npm publish` with 2FA.

---

## Out of scope for v0.9 (deferred to v0.10+)

- Agent-identity header (`X-Daimon-Agent`) tracked in audit. Folded into M48 only as cwd attribution.
- App lock / handoff between agents. Cwd scoping covers most cases.
- Mobile / responsive dashboard.
- Error grouping by stack-fingerprint.
- Native test-result parsers beyond what's already in `cliSurface.ts`.
- Deep per-component Angular render specs (H1 from v0.8) and WCAG AA audit (H3) — folded into M53 polish only if cheap; otherwise deferred.

## Sequencing notes

- M46 ships as-is (commit + push). It's the base.
- M47 → M48 → M49 form the multi-workspace chain. M47 unblocks M48 (cwd attribution needs cwd resolution); M48 unblocks M49 (dashboard needs `daimon workspaces` to render a switcher).
- M50 (lint) is independent of the multi-workspace chain — can run in parallel.
- M51 (timeline) depends on M50 only because lint events should be in the timeline.
- M52 (polyglot probes) is independent.
- M53 is the final wrap-up.
