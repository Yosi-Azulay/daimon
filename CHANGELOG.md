# Changelog

All notable changes to Daimon are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [1.13.0] — 2026-07-21

"Terminal Native" — part 3 of the UI redesign trilogy (M162–M167), and the one the oldest surface was owed. v1.11 gave the dashboard a visual language; v1.12 gave it an information architecture; v1.13 brings both to the TUI and makes every chord **discoverable**. The TUI had nineteen chords you could only find by reading the source, a footer hand-written in three places (one of which had already drifted out of sync with its own code), a v0.3-era two-box layout, status colors duplicated verbatim across two components, an unwindowed app list, and a 1-second interval that re-rendered the whole tree whether or not anything had changed. This release lives **entirely under `src/tui/`**: zero daemon, CLI, HTTP, or MCP change, no config key, no history migration, no new dependency, no frozen shape moved. **Migration: none. Every chord that worked in v1.12 works in v1.13, same key, same meaning — no remaps, so no legacy aliases.**

### Added

- **`?` help overlay (M163).** A full keyboard reference grouped by pane, with the focused pane's chords listed first, scrollable and usable at 80 columns. `?` / `Esc` / `q` close it.
- **`src/tui/chords.ts` — the chord map (M163).** Every chord as data: key, pane scope, description, group, legacy aliases. Dispatch, the overlay, the per-pane footers, the docs cheat sheet, and the README table all render from it. `test/tui-chords.test.mjs` fails if any surface hand-lists a chord, and App's `Record<MainChordId, Handler>` makes a missing handler a **build** error.
- **A pane system with a visible focus model (M162).** App list / detail / log are three first-class panes; `Tab` cycles focus, the focused pane is marked, and chords are pane-scoped — which is how `l`, `/`, `g`, and `G` each mean one thing in the list and another in the log without colliding.
- **A persistent status bar (M162)** — daemon state and api port, workspace, active filters with a `visible/total` count, muted-app count, live log storms, and transient flash messages folded in as the last segment.
- **Log pane 2.0 (M164).** v1.2 level classification is finally visible (error/warn/info tinted; a `null`-level line stays **plain** — daimon never guesses a level client-side). Follow mode is explicit (`[following]` / `[paused]`, pauses on scroll-up, `G` resumes). Grep keeps narrowing by default as it has since v1.2, with `Tab` toggling a highlight mode where `n`/`N` walk the matches. A storm marker shows while an app is in a v1.2 `log-storm` episode.
- **`src/tui/theme.ts` — one semantic terminal theme (M165).** DESIGN.md's palette as roles, with a truecolor → 16-color → `NO_COLOR` ladder: truecolor gets the design language's own OKLCH values converted to sRGB (four land byte-identical on the dashboard's `--dm-chart-*` dark hex), 16-color gets a **hand-picked** ANSI fallback rather than auto-quantized mud, and `NO_COLOR` renders zero color codes with semantics carried on bold/dim/inverse — every feature intact on every rung.
- **`npm run build:readme-chords`** and a chord section in the generated docs page — both rendered from the chord map, both idempotent.
- **Six new test files** — `tui-chords`, `tui-theme`, `tui-layout`, `tui-log-pane`, `tui-render-budget`, and `tui-render-smoke` (which mounts the real TUI against a fake stdout using ink, no new dependency).

### Changed

- **`STATUS_COLORS` / `HEALTH_COLORS` exist once.** They were duplicated verbatim in `App.tsx` and `AttachApp.tsx`; both now read the theme module, and a test fails any component that hard-codes a color — DESIGN.md's token rule carried from the dashboard to the terminal.
- **The app list is windowed (M166).** A 100-app registry renders one viewport with a `3/40` position indicator instead of 100 rows, with the selection always in view.
- **Narrow terminals degrade in priority order (M166).** Columns drop cpu/mem first (the exact `cols >= 100` cutoff daimon has always used), then the framework badge below 80; below 60 columns the layout collapses to a single pane rather than corrupting two. Status is never dropped.
- **Terminal resize re-layouts immediately (M162)** instead of waiting for the next tick.
- **Idle re-renders cut 5× (M166).** The unconditional 1-second full-tree interval is gone; updates are driven by the registry `change`/`event` subscriptions that already existed, leaving one slow tick for derived clock values. Pinned by `test/tui-render-budget.test.mjs`, which also fails if a second interval or a 1s interval reappears.

### Fixed

- **The log pane's `g`/`G` labels were backwards.** Through v1.12 the footer read `[g/G] bottom/top` while the code did the opposite — `g` scrolled to the oldest lines, `G` to the newest. Code wins: `g` is top/oldest, `G` is bottom/newest (and now also resumes follow), matching vim and the timeline pane's own `g`/`G`. This drift is exactly what motivated making the chord map the single source of truth.

### Notes

- **Zero daemon/CLI/API change.** No new verbs, endpoints, MCP tools, event kinds, or config keys; no history migration. Every new surface is `experimental`; no frozen shape moved.
- **Plain terminals and SSH are first-class.** No feature requires a mouse or truecolor.
- **One deliberate deviation from the plan:** M166's acceptance line asked for `PgUp`/`PgDn` to page the app list. In v1.12 those keys scrolled the **log**, and "muscle memory is sacred" is a locked rule that outranks an acceptance detail — so they still page the log. The 100-app list is fully navigable via `j`/`k` with windowing.


## [1.12.0] — 2026-07-21

"Wayfinding" — part 2 of the UI redesign trilogy (M156–M161). v1.11 gave the dashboard a visual language; v1.12 gives it an **information architecture**. The pages had accreted release-by-release: a flat fourteen-entry nav rail in ship order, a `/` route that was just the apps list, an app-detail page that grew a why panel, tests, and timeline links with no layout, and a command palette that did navigation OR search depending on a `>` prefix. Navigation was never designed — you found features by luck. v1.12 groups routes by task (**observe / investigate / configure**), unifies the palette into one ranked list, turns `/` into a real overview that answers "how are things" before a click, and re-lays the app page as readable anchored sections — while holding the one hard rule: **every URL that worked yesterday still resolves tomorrow.** This release **recomposes existing endpoints** — no new HTTP endpoint, no new config key, no history migration, no new dependency, no frozen shape moved. **Migration: some URLs redirect (all listed in `RELEASE-v1.12.0.md`); nothing 404s.**

### Changed

- **The nav rail is grouped by task, not ship order (M156).** Fourteen destinations now sit under three labelled groups — **Observe** (Apps, Events, Logs, Timeline, Sessions), **Investigate** (Errors, History, Trends, Tests, Regressions, Report, Agents), **Configure** (Settings, Doctor) — defined once in `dashboard/src/app/nav-model.ts` and consumed by both the rail and the new topbar breadcrumb, so they can't drift. The keyboard-shortcuts help table mirrors the same groups.
- **The apps list moved to `/apps`; `/` is now the overview home (M156/M158).** `/` composes existing endpoints into four widgets — status summary, needs-attention errors, test pass-rate, and a resource glance — each degrading independently to a note (a missing data source shows that widget's note, never a spinner forever). The `g a` chord and the palette's app entry retarget to `/apps`. Old `/` deep-links still resolve (to the overview); the group-chip filter now lives at `/apps?group=…`.
- **The command palette is one unified, ranked list (M157).** Navigation, app jumps, actions, and history search merged into a single fuzzy-ranked list (exact-prefix > word-start > scattered, pure-function ranking unit-tested in `command-palette-helpers.ts`). The `>` prefix still forces search-only; plain typing matches commands and surfaces search hits beneath as they arrive. Recents (navigation only, never replayed actions) persist in localStorage and show on open. Palette actions grew to the app header set: start / stop / restart / mute / test. Fully keyboard-reachable with `aria-activedescendant`.
- **The app-detail page is sectioned, not tabbed (M159).** `overview / errors / logs / tests / timeline / why` are now scroll-spy-highlighted sections with **stable `#anchors`** (`/apps/:name#errors`, `#logs`, `#tests`, `#timeline`, `#why`) — a deep-link contract that never renames. A consistent header action row (start/stop/restart/mute/test) matches the apps list and palette. The env panel folded into Overview; the compile-history spark became the Timeline section; a new Tests section recomposes `GET /api/tests`. Legacy `?tab=errors|logs|history|env|why` deep-links map to the corresponding section and still resolve. Removing the Material tabs dependency shrank the app-detail chunk.

### Added

- **`dashboard/src/app/nav-model.ts`** — the IA's single source of truth: the three task groups and a pure `contextForUrl` resolver, unit-tested in `nav-model.spec.ts`.
- **Active-context breadcrumb** in the topbar (group › page › app), replacing per-page ad-hoc titles.
- **`dashboard/e2e/route-audit.ts`** — a checked-in inventory of every URL shape the dashboard has ever exposed, driven by a generated **redirect test suite** (`redirects.spec.ts`) that asserts each one still resolves.
- **Guided fresh-install empty states** on home, errors, tests, and timeline — each names what will appear and which command feeds it, instead of a blank table.

### Notes

- **No new HTTP endpoints, config keys, history migrations, or dependencies.** The redesign recomposes existing APIs; the daemon, CLI, and MCP surfaces are untouched. Deep-link back-compat is a gate: `redirects.spec.ts` drives the full audit map. A11y floor holds — axe zero serious/critical on every route at 1280 + 390px, keyboard specs extended to the grouped nav.

## [1.11.0] — 2026-07-21

"Fresh Coat" — part 1 of the UI redesign trilogy (M150–M155). The dashboard had grown feature-by-feature for eight-plus versions, every page styled by analogy to its neighbours, and no release ever designed the whole: the color roles were Angular Material's system palette aliased one-to-one, radii ran 4–14px with no rationale, and per-page styles had drifted. v1.11 states a **visual language** in `DESIGN.md` — a designed OKLCH palette (cool-neutral surfaces, an iris brand accent, a four-hue semantic set), a rational radius scale (4·6·8·12·16), soft cool elevation, and a deliberate type scale — implements it entirely at the token layer (`dashboard/src/styles/tokens.css`), and restyles every component and page to it. **Visual only:** zero route, daemon, CLI, HTTP, or MCP change; no new config key; no history migration; no frozen shape moved. AA contrast is verified at the token level (every fg/bg pairing computed OKLCH → sRGB → WCAG; all pass 4.5:1 text / 3:1 non-text in both themes with margin). `DESIGN.md` is the contract v1.12 (information architecture) and v1.13 (TUI) inherit. **Migration: none.**

### Changed

- **The dashboard's entire visual language (M150).** `tokens.css` no longer aliases the Material system palette one-to-one — it defines the design language's own OKLCH values (surfaces at hue 275 with a faint iris undertone; an iris primary; green/cyan/amber/red status hues) and re-points the consumed `--mat-sys-*` roles onto them, so Material widgets and every component track the new language identically. Radii rationalised to `4·6·8·12·16`px; elevation is now soft, cool, and deeper in dark; the type scale is a deliberate five-step set (14px body, 22px h1); motion keeps the M3 easings with three named durations. Light + dark + comfortable/compact are each specified per token. **`DESIGN.md` (new, repo root)** is the full specification.
- **Every dashboard component restyled to the token language (M151–M153).** The shared layer (`styles.scss` Material overrides, `.dm-page-header`/`.dm-mono`/`:focus-visible`, `ui-primitives.ts`) and all pages now consume `--dm-*` directly — the ~590 raw `--mat-sys-*` reads across 21 components were migrated to their `--dm-*` roles (a decoupling from Material; visually identical via the re-point). Status dots now match their pill hue (serving → green, compiling → cyan, starting → amber). Every `data-testid`, ARIA attribute, landmark, focus indicator, and `aria-live` region is preserved byte-for-byte — the Playwright drive needs no selector changes.

### Added

- **`DESIGN.md`** — the visual-language contract: principles, the full token scale (color/spacing/type/radius/elevation/motion) for both themes and both densities, and the token-level AA verification table. The v1.12 and v1.13 releases inherit it.
- Additive tokens: `--dm-color-secondary` (muted-iris accent for lint / tool chips), `--dm-color-scrim`, `--dm-color-inverse-surface` / `--dm-color-inverse-on-surface`, and `--dm-chart-grid`. All AA-verified; no existing token name changed.

### Fixed

- **Chart series rendered with Chart.js's default colours, not the themed ones (M153).** The chart tokens resolved (through a `var()` chain) to Material's `light-dark(#…,#…)` value, and Chart.js's colour parser (`@kurkle/color`, reached via `getComputedStyle` on `:root`) accepts neither `light-dark()` nor `oklch()` — so every series silently fell back to a default colour and never adapted to the theme. The four `--dm-chart-*` tokens now ship as pre-resolved, theme-split sRGB **hex** (the one deliberate exception to the file's `light-dark()` authoring), which the parser accepts; `trends`, `history`, and per-app charts now render the designed hues and adapt to light/dark. Each series clears 3:1 against both `bg` and `surface` in both themes.

## [1.10.0] — 2026-07-20

"Featherweight" — performance and scale certification (M145–M149). daimon's perf story had been anecdotal: budgets from a v0.12-era 100k corpus were hand-picked absolutes, cold-start had never been profiled, and nobody could say what the daemon costs at idle or whether search still answers instantly after months of recorded history. v1.10 **measures first**: a bench harness with a two-signal quiet-machine detector records real baselines for the paths users feel (cold-start, CLI round-trip, idle footprint, TUI attach, dashboard route TTI), a deterministic 1M-event corpus (610MB, 3,000,221 FTS rows) certifies six read paths plus the write path under storm load, and every budget is *derived* — `measured quiet-machine baseline p95 × a per-class headroom factor` — never typed in by hand and never loosened to make a run pass. The scale run surfaced real defects a 100k corpus never showed; all are fixed with a measured before/after. **No new feature surface, no new config key, no history migration, no frozen shape moved.** A v1.9 `history.db` and `state.json` open clean both directions. Full certified numbers live in `PERFORMANCE.md`.

### Fixed

- **History open on a large DB cost 8.3s, every time (M146)** — `PRAGMA integrity_check` ran on EVERY History open and is O(database size): 8303ms on the 610MB/1M-event corpus. `close()` now records a clean-shutdown marker in SQLite's previously-unused `user_version` header field; an open that finds the marker gets a bounded structural probe (O(tables), 3.6ms — still catches the recovery suite's corrupted-page case), while a DB that was **not** closed cleanly still gets the full check, since corruption comes from unclean shutdown and disk failure. Result: 8303ms → 7ms. A pre-v1.10 DB has no marker and simply takes the full check both directions.
- **`daimon doctor` opened six History handles per sweep (M146)** — each paying the full integrity check independently. Full sweep on the 1M corpus: ~51s → 5130ms with one shared handle.
- **`daimon why` paid for a health check it then discarded (M146)** — `why` calls doctor on the request path and filters OUT the history-db finding, so it was paying an O(db-size) `quick_check` for a result nobody sees. `why` now passes `historyHealth:false`; doctor on that path went ~51s → 88ms at 1M, and `why` itself: 6284ms p50 → 58.8ms p50 at 100k (143.8ms p50 at 1M, a bigger corpus with a real query cost).
- **Retention blocked the event loop for 28.8s in one bite on the 1M corpus (M147)** — pruning is now time-sliced (p50 slice 73ms, p95 144.2ms, max 325.7ms, 242 slices, 19.9s total) instead of one uninterruptible block that froze the TUI, stalled HTTP, and stopped ingest. Semantics unchanged: every expired row still goes, and `test_failures` still prunes before `test_runs` so an interrupted pass cannot orphan rows.
- **A cold FTS index stalled the first search for 51.5s (M146)** — `search()` no longer syncs an unbounded backlog inline; a backlog over 10,000 rows (derived from a measured 17.2µs/row) now answers from the LIKE path instead (≤1.8s worst case at 1M) while the idle tick heals the index afterward in 5k-row chunks. This trades speed, never correctness — LIKE scans the base tables, so results stay COMPLETE and read-your-writes still holds.
- **CLI startup was slower than node's own boot floor (M148)** — the Claude version-drift nudge ran before the `--help`/`--version` fast paths, and discovery/doctor/portDiag/claude were top-level imports paid on every invocation. `--help` 307ms → 121ms p50, `--version` 312ms → 121ms p50, the no-daemon error 305ms → 185ms p50 (bare-node spawn floor measured at 49ms).

### Added

- **Bench harness + committed baselines (M145, experimental infra)** — `bench/lib/machine.mjs` is the measurement substrate: a two-signal quiet-machine detector (CPU-reference dispersion **and** system-wide busy fraction — dispersion alone reported "quiet" on this 20-core box while the full test suite ran, inflating a first baseline attempt by 72%; `loadavg` is deliberately unused, it's always 0 on Windows) plus the budget-derivation rule (`budget = baseline p95 × class headroom`: interactive 2×, startup 2.5×, query 3×, batch 3×, write 4×) and its second contention axis (pass on the absolute budget OR the ratio to an interleaved CPU-reference workload, ceiling = `budget ÷ baseline cpuRef × 3`). `bench/baselines.mjs` records daemon-cold-start, cli-roundtrip, idle RSS/CPU, tui-attach, and 14-route dashboard TTI against a fresh/empty and a 100k corpus. `--write` refuses on a non-quiet or `--quick` run — a contended baseline would inflate every downstream budget.
- **1M-event corpus + six certified read paths (M146, experimental infra)** — `bench/lib/corpus.mjs` seeds a deterministic (fixed-seed `mulberry32`, `SEEDER_VERSION` 2), anchored (newest rows land "today", 90-day span — `why`/`context` query hardcoded last-24h/7d windows, so a stale-anchored corpus would certify querying nothing) 1,000,180-event / 2,000,000-log-line / 3,000,221-FTS-row / 610MB corpus, cached under `bench/.corpus/` (gitignored, not shipped) and rebuilt past 7 days old. `bench/scale.mjs` certifies search-fts-common/rare, search-like-common/rare/miss, `report`, `export`, `sessions`, `why`, and `context` against derived budgets, plus FTS catch-up from a cold high-water mark (31.9s for 3M rows, now off the search path). The contract suite runs against the 1M DB — frozen shapes identical at 0 and 1M events.
- **Write-path audit under storm load (M147, experimental infra)** — `bench/writepath.mjs` drives event-ingest and logline-ingest storms (p95 0.0013ms and 0.0009ms per call respectively, draining to queue depth 0) and measures retention pruning under the 1M corpus. Confirms FTS stays off the write path with zero insert triggers — FTS-enabled inserts cost ×0.857 of FTS-unavailable ones, within the 1.10 ceiling.
- **Startup + dashboard-bundle gates (M148, experimental infra)** — `bench/startup.mjs` certifies the CLI's instant paths (`--help`, `--version`, no-daemon error) against a budget derived from the M145 baseline. `test/bundle-budget.test.mjs` is the **first automated gate** on the dashboard's initial payload: it walks the static import graph reachable from `index.html` (script/stylesheet/modulepreload tags plus every transitively statically-imported chunk — dynamic `import()` lazy-route edges are deliberately excluded) and asserts real gzip ≤150KB and real brotli ≤140KB. Previously nothing failed if a stray eager import grew the bundle.
- **`PERFORMANCE.md` (M149)** — the release deliverable: every baseline, every budget's derivation, the full before/after table, the 1M-corpus composition and regeneration steps, and the dashboard bundle figures.

### Fixed (documentation)

- **The dashboard bundle figure quoted since v1.7 ("135.39 KB gz") was brotli, not gzip.** Angular's "Estimated transfer size" column has been a brotli estimate since Angular 17; every release note through v1.9 quoted it under a gzip label. Measured directly: raw 492.7KB, gzip 148.5KB, brotli 132.0KB. The "<150KB gzip" claim still holds, but with ~1% headroom rather than the ~10% previously believed — hence the new automated gate above.

### Changed

- No config keys added. No history schema change. No frozen or stable shape moved — the contract suite ran green against both the empty-history and 1M-event corpus. `daimon.config.example.json` is unchanged.

## [1.9.0] — 2026-07-20

"Everywhere" — macOS/Linux go from "probably works" to first-class (M140–M144). daimon was built on Windows, and it showed in the unaudited corners: a port scanner that spoke `netstat` fluently but returned **nothing** on Linux, remedies that told a Mac user to run `taskkill`, and a dozen `process.platform` branches with exactly one tested side. Worse, the suite was quietly complicit — platform-conditional tests passed vacuously off-platform, so a green run on Windows proved nothing about the other half of the installs. v1.9 is **certification**: every platform branch is inventoried and grep-gated, the POSIX side is exercised against recorded real tool output through the production parse path, every off-platform skip is loud and counted, and the README states an honest support matrix — verified / fixture-verified / best-effort, earned not asserted. **No new config keys, no history migration** — a v1.8 `history.db` and `state.json` open clean both directions. Every new surface ships tier `experimental`; no frozen shape changed.

### Fixed

- **Port forensics were silently blind on Linux (M140)** — `scanListeningPorts`' `ss -ltnp` parser matched the **Recv-Q** column (`0`) on every standard line and returned an empty map, so `daimon ports` never reported a holder on its primary POSIX platform. The parser is now field-addressed (the local endpoint is the first field ending in `:<numeric-port>`), robust to the leading `Netid` column that BusyBox/container `ss` prints, and fixture-gated. macOS `lsof` and Windows `netstat` paths were correct and are now fixture-covered too.

### Added

- **Platform-branch inventory + completeness gate (M140, experimental)** — every `process.platform` / `os.platform()` fork in the codebase is a row in `src/platformInventory.ts` (file:symbol → Windows behavior → POSIX behavior → how each side is tested → named gap → verdict `verified`/`fixture`/`untestable-locally`/`bug`). It renders as the docs "Platform support" table straight from the data (`npm run build:docs`), and `test/platform-inventory.test.mjs` greps compiled `dist/` for every platform token and **fails if one is missing from the table** — the inventory can never rot. No row may have an empty gap ("none" is a named value); every `bug` row documents its fix.
- **POSIX fixtures + injectable command-runner seam (M141, experimental)** — `portDiag.ts`'s scan/holder functions take an injectable command-runner (default: real `spawnSync`), so tests feed **recorded** `ss` / `lsof` / `netstat` / `ps` / PowerShell output through the exact production parse path — no test-only fork of the parsing logic. `test/fixtures/platform/<tool>/` carries the samples (incl. no-permission, IPv6, and container-flavored variants) with provenance notes, and `test/port-forensics.test.mjs` runs every assertion in parity as `win32` and `linux`/`darwin`. Non-port seams (`frameworks.resolveCommand`, `serviceInstaller.buildServiceArtifact`, `doctor.isSystemDir`, `pathScope.normalizeForCompare`) gained an injectable `platform` parameter and both-branch unit tests (`test/platform-seams.test.mjs`).
- **Loud platform skips + accounting (M142, experimental)** — a `platformSkip(t, plat, note)` helper (`test/helpers/platformSkip.mjs`) replaces every silent `if (isWin)` / `process.platform … return`; a skipped test now announces `requires <platform>: <what it would verify>`. `test/platform-skips.test.mjs` statically inventories every skip, asserts the set against a committed expectation, prints `# platform-skips: N` with per-test notes at the suite tail, and **fails if any test smuggles in a silent platform gate** — symmetric, so a future Mac/Linux run of the suite is equally honest.
- **Platform-aware doctor remedies (M143, experimental)** — remedy phrasing now matches the reader's OS through one helper (`src/platformRemedy.ts`): `taskkill /PID … /F` vs `kill …`, `netstat -ano | findstr` vs `lsof -iTCP:… -sTCP:LISTEN`. The EADDRINUSE port-conflict message (the model error string) names the platform-correct command on both branches; both are unit-tested and the M90 remedy audit stays green.
- **`scripts/platform-smoke.sh` (M143)** — a ~2-minute, zero-dependency PASS/FAIL probe for a real Mac/Linux box: daemon boot + `/api/signature` (loopback), `daimon ports` scan via real `ss`/`lsof`, spawn + tree-kill of a process group (no orphans), notifier no-crash, env snapshot + redaction spot-check, `daimon doctor`, TUI launch. Uses a throwaway `DAIMON_HOME` + workspace (never touches the real `~/.daimon`), prints a paste-able summary, and has a `--dry-run` mode that exercises the plumbing on any host (incl. Windows). Statuses in the README matrix are earned from it.
- **Honest support matrix (M144)** — the README gains a Windows/macOS/Linux × feature table with `verified` / `fixture-verified` / `best-effort` statuses and footnotes on what each means; BSD and other incidental Node-20 platforms are labeled best-effort in those words. The docs render the full branch-by-branch audit table.

### Notes

- No schema, config, or dependency changes. tree-kill and node-notifier are unchanged — tested around, not replaced.
- **Before publishing, run `scripts/platform-smoke.sh` on a real macOS box and a real Linux box** and confirm PASS. The fixtures verify the parse logic; only the smoke script confirms the actual OS tools behave as recorded.

## [1.8.0] — 2026-07-19

"Rewind" — history becomes walkable, not just queryable (M134–M139). daimon's 100k events answered point questions well (`search`, `why`, `report`) but had no shape and no time surface to scrub. v1.8 gives history its natural unit — the **session**, a contiguous daemon-uptime slice — makes it navigable with a **timeline** (TUI chord + dashboard route), and greets you on the first attach after a gap with **"while you were away."** Sessions are **DERIVED, never recorded**: no sessions table, no session events, no new analytics state, no history migration — a pure function over existing history plus two additive daemon-lifecycle boundary markers. Every new surface ships tier `experimental`; no frozen shape changed. There is **nothing to migrate** — a v1.7 `history.db` and `state.json` open clean both directions.

### Added

- **Session derivation + `daimon sessions` (M134, experimental)** — a session is a contiguous daemon-uptime slice bounded by the daemon's own start/stop. To mark those boundaries exactly, the daemon now records two additive lifecycle events under the synthetic `__daemon__` app — `daemon-start` at boot, `daemon-stop` at clean shutdown (both tier `experimental`, exactly like the existing `self-warn`/`digest-sent` markers). Sessions are then **pure composition** over history (`src/sessions.ts`): `daemon-start` opens a slice, the matching `daemon-stop` closes it cleanly; a boot with no intervening stop closes the previous slice **unclean** (`endedCleanly:false`) at its last observed event (a crash/kill); the newest open slice is `current:true, end:null`. IDs are deterministic — `s-<startMs>`, stable across re-derivations so deep links never rot. `daimon sessions [--since 7d] [--json]` + `GET /api/sessions` list each slice (id, start/end, duration, endedCleanly, current, apps touched, error/test/compile counts, newest first); `daimon sessions show <id>` + `GET /api/sessions/<id>` expand one slice into a closed block list (apps started/stopped, error groups new/recurring, test runs, compiles p50/p95, crashes, env changes — key names only) with every block degrading to a `{ note }`. MCP `daimon_sessions` (**33 tools**). **Derivation on the 100k-event corpus benches < 300ms**, so no cache ships (per-slice counts use windowed SQL aggregates in the DB layer, not a 100k-row JS scan).
- **"While you were away" (M135, experimental)** — the first attach after a gap answers "what did I miss" unprompted. Gap baseline = the later of the last acknowledgement and the previous session's last event; a gap over **4 hours** (a fixed constant — zero new config keys) composes one summary of new errors, resolved errors, crashes, and env changes. It **reuses the M83 report composition** — NOT a new engine, NOT a new timer (the digest's single 1-min interval stays the only scheduler) — the TUI composes it in-process at start, the dashboard calls the existing `GET /api/report?since=`. One dismissible line in the TUI header (Esc to dismiss); dismissal merge-writes an `awayAck` timestamp to `state.json` (additive key) so it never re-nags. Nothing to say → nothing shown (no "0 events" noise).
- **TUI timeline chord (M136, experimental)** — press `i` to walk the event stream without leaving the terminal: events bucketed by hour or day (drill day→hour with Enter, Esc back out), a density sparkline strip, `←/→` between buckets, `g`/`G` to the oldest/newest edge, and `n`/`p` to jump the selected app to its next/previous start/stop/crash ("when did this last die" in two keystrokes). Windowed history query on open — never a per-keystroke table scan; empty history renders a note, not a crash.
- **Dashboard timeline + deep-link convergence (M137, experimental)** — the timeline route gains a density strip with drag-to-brush (narrow the visible range), kind + app filters, and full keyboard navigation (arrows + Home/End) with `aria-live` announcements. Deep links converge on one "when" surface: the route accepts `?ts=&app=&kind=&session=` and search hits + the why panel resolve to a timeline position (`?session=<id>` sets the window to that slice). A dismissible "while you were away" panel greets a gapped load, computed from `GET /api/sessions` + `GET /api/report`. Lazy chunk — the initial bundle stays under budget.
- **`daimon why` session context (M138, experimental additive)** — `why` gains `sessionContext`: the id of the session the failure belongs to plus a compact line of what else happened in that slice before it — errors in **other** apps, env changes, compile regressions (the failure's own errors stay out; they are the rest of the response). Composed from the M134 slice queries; degrades to a note (a pre-history failure omits the id; a quiet session says so rather than fabricate relevance) and links to the timeline via `?session=`. Surfaced on `GET /api/why`, the CLI `why` panel, and the dashboard why panel.

### Changed

- The daemon records `daemon-start`/`daemon-stop` under `__daemon__` (additive event kinds; `parseAuditLine` and every existing consumer are unaffected). `state.json` gains an optional `awayAck` key (merge-write, additive — old and new daimon read each other's file cleanly). README gains sessions / timeline / "while you were away" sections and a "rewind" positioning paragraph; docs regenerated with `experimental` badges on the new verbs, endpoints, MCP tool, and event kinds; CLAUDE.md records the **sessions-are-derived** rule (never a sessions table; derivation is pure composition; a cache only if the bench demands it and always rebuildable). `daimon.config.example.json` is unchanged — v1.8 adds no config keys.

## [1.7.0] — 2026-07-19

"Test Sense 2" — `daimon test` learns coverage, quarantine, and failed-only reruns (M128–M133), deepening the wrap around the project's own runner without ever replacing it. daimon already knew pass/fail and flaky; now it parses the coverage the run **already printed** (never a flag it injects, never a config it edits), gives a parked flaky test a real dated home that can't become a memory hole, and reruns only what failed — but only where the runner documents how. Every new surface ships tier `experimental`; no frozen shape changed. History migration is additive-only (three nullable columns + an optional config sub-key); a v1.6 `history.db` and `state.json` open clean both directions, and a v1.7 install upgrades with zero action.

### Added

- **Coverage capture (M128, experimental)** — per-runner parsers over output the runner already produced: vitest/jest istanbul (`text` table's "All files" row + `text-summary` block), pytest-cov `TOTAL` line, `go test -cover` "coverage: NN.N% of statements". Additive nullable `covLinesPct`/`covStmtsPct` columns on `test_runs` (guarded ALTER) surface as `coverage: { linesPct, statementsPct } | null` on `daimon test`, `GET /api/tests`, and MCP `daimon_run_tests`. Runners opt in via `TEST_RUNNER_META[id].supportsCoverage` + a `parseCoverage`, which gates a `coverage` block in the runner's fixture (`test/testrunners.test.mjs` fails on a claim without fixtures, and on any parser returning non-null for the malformed case). **Fail-soft is absolute**: absent / unparseable / out-of-range (`<0`/`>100`) → null, always; a fabricated percentage is the same violation as a fabricated pass count. cargo/dotnet ship WITHOUT coverage support — no confirmed documented default output, so explicit non-participation, never a guess. Summary numbers only — no per-file coverage storage, ever.
- **Coverage trends (M129, experimental)** — the dashboard Trends page gains a "Test coverage" line chart beside pass-rate and flaky, bucketed the same way. Null-coverage runs render as true GAPS, not zeros (a gap-preserving `alignSeriesNullable` + `spanGaps: false`); an app with no coverage data shows the existing series unchanged with no chart error. No new CLI verb — a view over `GET /api/tests`.
- **Flaky quarantine (M130, experimental)** — optional `tests.quarantine: string[]` glob patterns (`*` wildcard) matched against a test's `suite > test` name (absent = behavior unchanged; invalid entries warn at load and are skipped, config stays loadable). Quarantined tests **still run and still record** — daimon never edits a test config, so it couldn't skip them and wouldn't. Their failures gain the additive `quarantined` column on `test_failures`, are excluded from flaky detection (the M75 query) and from test-failure notification noise (a run whose only failures are quarantined doesn't alert), and the runner's exit code passes through unchanged. Per-pattern first-seen timestamps persist in `state.json` (merge-write, additive key) for "oldest since <date>"; an overview badge counts parked patterns when nonzero. **Not a memory hole**: parked, dated, and visible forever — silenced never.
- **`daimon test <app> --failed` (M131, experimental)** — rerun only the last recorded run's failures, via the runner's registry-declared `rerunFlag` (pytest `--lf` stateful; go `-run {tests}` as an anchored regex-escaped alternation; jest/vitest `-t {tests}` and dotnet `--filter {tests}` name filters). Templates come from the runner's docs, never guessed — **no `rerunFlag` = explicit non-participation.** The rerun goes through the normal test path (soft lock, timeout, parse, record) and lands with the additive `failedOnly` column; totals reflect only what ran (never scaled up). It NEVER silently falls back to a full run: no prior run, an undeclared runner, and unparseable failure names each return an error naming the gap plus a remedy; an all-green prior run is an honest no-op (nothing spawned, exit 0, a note). Quarantined failures are included — they ran, they failed, they rerun. Exposed as `POST /api/apps/<app>/test?failedOnly=1` and MCP `daimon_run_tests` `failedOnly`.
- **Report + why deepening (M132, experimental)** — the report's (closed-list) **tests** section deepens with current coverage + a signed delta vs the previous equal period (null-safe — no coverage data yields a note, never an error) and a quarantine count with "oldest since <date>"; `--md` renders both. `daimon why` gains a quarantine line (count + oldest age) alongside `envChanged`. The scheduled digest inherits both for free (it sends the M83 report — no digest-side change). No new MCP tools; `daimon_report` carries the deepened section.

### Changed

- `daimon test` output, `GET /api/tests` rows, and MCP `daimon_run_tests` carry the additive `coverage`, `failedOnly`, and per-failure `quarantined` fields (all `stable` endpoints stay additive; no frozen shape moved). README gains coverage / quarantine / `--failed` sections and a "test sense" positioning paragraph; docs regenerated with `experimental` badges on `--failed`, `tests.quarantine`, and the coverage fields; CLAUDE.md records the coverage fail-soft law (parsed where documented, fixture-gated, null over fabricated — the same law as test totals) and the `rerunFlag` discipline. `daimon.config.example.json` documents `tests.quarantine`.

## [1.6.0] — 2026-07-19

"Agent Ledger" — full accountability for the AI agents that drive daimon: who did what, when, and with what contention (M122–M127). daimon already knew who was calling (`X-Daimon-Agent` on every request), the audit log already had an agent column, and the LockManager already arbitrated concurrent Claudes — v1.6 makes all of it **queryable**. `daimon audit` reads the trail, `daimon agents` names the actors and their contention, the report deepens, the dashboard shows it, and the MCP server grows resources + prompts so agents consume daimon the way the protocol intends. **Agent identity stays ADVISORY** — a self-declared header, never authenticated; the docs and every output say so plainly. Everything is DERIVED at query time from the existing audit log + in-memory registry + lock manager: **no new table, no new persisted state, no new timer, no history migration.** All new surfaces ship tier `experimental`; no frozen shape changed. A v1.5 `history.db` opens clean both directions.

### Added

- **`daimon audit [--agent --app --since --limit --json]` + `GET /api/audit` (M122, experimental)** — the queryable trail. Reads `audit.log` + the rotated `audit.log.1` and derives `{ ts, agent, action, app, changedKeys, remote }` rows from the existing 6-col `verb:<app>` changedKeys convention that `test:<app>` established — **no new column, no format change, rotation untouched.** Mutating lifecycle actions the daemon already gates now leave a row: `start`, `stop`, `restart`, `steal` (a `?steal=1` override — durable, so live-steal counts survive a restart), `handoff`, `mute`, `unmute` (config writes and group actions were already audited). Filters compose (AND), newest first, default limit 100. Fail-soft: malformed or truncated lines are **skipped and counted** in a `skipped` field — never an error, never a fabricated row; a legacy 5-col row surfaces with `agent: null`.
- **`daimon agents [--json]` + `GET /api/agents` roster (M123, experimental additive)** — the roster names every actor. `GET /api/agents` keeps its `agents`/`locks`/`self` keys byte-for-byte and ADDS `roster` and `contention`. Each roster row — `{ id, lastSeen, active, cwd, callCount, firstSeen, actions, locks, waits, steals }` — MERGES the live in-memory registry (5-min activity window) with audit-derived history (firstSeen + per-action counts across both files) and the LockManager's held locks. An agent that acted earlier but is idle now still appears (`active: false`); rows with no declared agent aggregate under `(unknown)`. Computed on demand — nothing persisted.
- **Lock analytics + report deepening (M124, experimental)** — contention becomes visible instead of merely lived-through. The LockManager's in-memory interaction ring (widened 16 → 64, still memory-only) now tags each event's outcome: `denied` (an acquire refused because another agent held a live lock), `steal-live` vs `steal-after-expiry`, `acquired`, `handoff`. `GET /api/agents.contention.hotspots` surfaces per-app waits / steals (durable count from `steal:<app>` audit rows) / steals-after-expiry / longest-hold; per-agent `waits`/`steals` ride each roster row. The report's existing (closed-list) **agents** section deepens with top agents by action count and contention hotspots, degrading to its `{ note }` with no agent data; `--md` renders both; the report perf budget (<500ms on the 100k corpus) still holds.
- **MCP deepening — resources + prompts + tools (M125, experimental)** — the shipped SDK (`@modelcontextprotocol/sdk` 1.29.0) was verified to expose resource + prompt registration cleanly (no upgrade, no new dep). **Resources** (read-only, thin `callJson` wrappers with `X-Daimon-Agent` forwarded, JSON contents): `daimon://report`, `daimon://context/{app}`, `daimon://logs/{app}` (200-line cap). **Prompts** (rendered from LIVE API data, never canned): `triage` (why + errors + recent logs for one app) and `handoff` (current state + lock holder + what the next agent should know). **Tools**: `daimon_audit` and `daimon_agents` (**32 tools**). Every addition is contract-tested (`test/mcp-contract.test.mjs` enumerates tools, resources, and prompts and invokes each with the daemon down → structured error, never a hang).
- **Dashboard — agents panel + lock badge (M126, experimental)** — the agents page renders the roster (id, last-seen, per-action count chips, held locks) plus a contention section and a timeline deep-link per agent; app cards carry a soft-lock badge (holder id + expiry in the tooltip) that clears on TTL expiry without a reload. Token-layer styling, both themes, 1280 + 390px; Playwright + `@axe-core/playwright` (zero serious/critical) via `/api/agents` route interception.

### Changed

- `GET /api/agents` is unchanged for existing consumers (additive `roster`/`contention`/`advisoryIdentity` keys only); its stability summary now notes the derived additions. The audit log gains `verb:<app>` action rows in the existing 6-col format — **old parsers are unaffected** (`parseAuditLine` reads 5- and 6-col rows identically). README gains an "Agent accountability" section (audit, roster, lock analytics, the advisory-identity caveat) and the MCP section documents the new resources/prompts; docs regenerated with `experimental` badges; CLAUDE.md records the audit action-row convention, the derived-not-stored rule for the roster/analytics, and the MCP resource/prompt + SDK-gate note.

## [1.5.0] — 2026-07-19

"Plugin API v1" — the `~/.daimon/plugins` trapdoor becomes a documented, versioned, crash-isolated hook surface (M116–M121). Deliberately tiny: **observe + doctor-rule contribution only** — a v1 plugin cannot mutate app state, config, or history. The trust model is unchanged and stated without euphemism everywhere it matters: plugins are opt-in, **NOT sandboxed**, in-process with full Node privileges, user-placed files only; no marketplace, no remote fetch, no auto-install, ever. Every new surface ships tier `experimental`; no frozen shape changed; no config or history migrations (`plugin-error` rides the existing events pipeline). A v1.4 `history.db` opens clean both directions.

### Added

- **Hook surface v1 (M116, experimental)** — a plugin file (`.mjs`/`.js`/`.cjs` in `~/.daimon/plugins`; other files ignored silently) exports `{ name, apiVersion: 1 }` plus any of four optional hooks: `onEvent(evt)` — a frozen copy of every event record, dispatched fire-and-forget AFTER the registry/history write (benched: the write-path cost is one array check + one `setImmediate`, and zero scheduling when no plugin declares an observe hook); `onAppStart(app)` / `onAppStop(app)` — frozen `{ name, framework, port, pid, status }` snapshots on status transitions to `starting`/`stopped`; `registerDoctorRules()` — called once at load, returning advise-only `{ id, description, check(ctx) }` rules (**no auto-fix capability for plugin rules in v1**; findings render in `daimon doctor` as `plugin:<name>/<rule>`). Hooks may be sync or async; all return values except doctor rules are ignored; mutating a snapshot can never reach registry state. Load validation per file: missing `name`/`apiVersion`, unknown `apiVersion` (skip names the file and the supported version), non-function hook, duplicate name, malformed rules → `load-error` + one self-warn, siblings unaffected; a hookless plugin is valid. Enumerated once at startup — no watcher; `daimon daemon restart` reloads.
- **Crash isolation (M117)** — the daemon's uptime is never a plugin's problem to lose. Load throws are contained per file; every hook call is wrapped (sync throws and async rejections alike): the first throw disables the plugin **for the session** — status `disabled`, all hooks unhooked, doctor rules deregistered — with exactly one `plugin-error` self-event (new experimental event kind) carrying plugin, hook, and stack. No retry, no auto-re-enable. Torture suite `test/plugin-isolation.test.mjs`: throw-at-load, throw-in-`onEvent`/`onAppStart`, async rejection, Nth-call throw, throwing doctor-rule `check`, plus two REAL daemon spawns under isolated `DAIMON_HOME` that boot through hostile plugin dirs, keep serving, and exit 0.
- **`daimon plugins [--json]` (M118, experimental)** — what loaded, what didn't, and why: name, file, apiVersion, status (`active` | `disabled` | `load-error`), declared hooks, error for non-active states; TTY table, compact JSON otherwise. Same rows on `GET /api/plugins` and MCP `daimon_plugins` (31 tools). `POST /api/plugins/scan` runs plugin-contributed doctor rules in-daemon. Doctor: new `plugin-load-error: <file>` finding (advise-only — **doctor never deletes or edits a user's plugin files**) and plugin rules run as `plugin:<name>/<rule>` checks with a throwing `check` unable to break built-in rules; `DOCTOR_COVERAGE` gains the plugin-failure row. `/api/overview` (and the dashboard overview) carry an additive `plugins: { total, active, nonActive }` badge when plugin files exist — pointer only.
- **PLUGINS.md (M119)** — the honest manual: trust model first (including the explicit statement that an in-process sandbox for trusted-by-placement code would be security theater — daimon offers crash isolation, a reliability guarantee, not privilege isolation), full API reference, lifecycle, `apiVersion` policy, migration guide for pre-v1.5 `scan()` plug-ins, and a cookbook whose snippets are the actual example sources. Drift-gated by `test/plugins-docs.test.mjs`: documented hooks must match the shipped `PLUGIN_HOOK_NAMES`, cookbook embeds are diffed byte-for-byte against `examples/plugins/`, the no-sandbox statements are grep-asserted, and the personal email is asserted absent.
- **Example plugins (M120)** — `examples/plugins/events-to-jsonl.mjs` (observe hook → one JSON line per event beside the plugin file) and `examples/plugins/custom-doctor-rule.mjs` (advise-only rule flagging a zero-app workspace), each under 60 lines. Exercised code, not decoration: `test/plugin-examples.test.mjs` loads both from a clean isolated `DAIMON_HOME` and asserts real behavior, then asserts `npm pack --dry-run` ships no `examples/` entry.

### Changed

- **Pre-v1.5 doctor plug-ins (`doctor-*.mjs` exporting `{ name, scan }` — the v0.8 escape hatch, whose `fix` surface was never implemented) no longer load.** They surface in `daimon plugins` / doctor as `load-error` with a specific migration message: wrap `scan()` findings in `registerDoctorRules()` and add `apiVersion: 1` (PLUGINS.md, "Migrating a pre-v1.5 plug-in"). The loader now accepts any `.mjs`/`.js`/`.cjs` filename, not just `doctor-*.mjs`; the bundled template `src/templates/plugins/example-doctor.mjs` is rewritten to the v1 shape.
- **`GET /api/plugins` rows changed shape** (rows now carry `apiVersion` + `hooks`; `status` values are `active`/`disabled`/`load-error`, were `ok`/`failed`) and both plugin endpoints are re-tiered `experimental` as part of the Plugin API v1 reshape — see RELEASE-v1.5.0.md Migration. `daimon plugin list|show|validate` keeps working against the new rows; `validate` now checks the v1 shape offline and reports declared hooks.
- README gains a "Plugin API v1 (v1.5)" section (trust model summary, hello-world, PLUGINS.md link); docs regenerated with `experimental` badges for the new verb/endpoint/tool/event kind; CLAUDE.md records the hook-surface, isolation, no-mutation, and examples-not-in-tarball rules.

## [1.4.0] — 2026-07-18

"Carry-Out" — get data out of daimon cleanly (M111–M115): one versioned export bundle, a print stylesheet for the Report page, shell completion that provably matches the verb surface, and a deterministic demo script. A deliberately small release: **nothing new is recorded; everything new is a door.** All additive, every new surface ships tier `experimental`, no frozen or stable shape changed, zero new config keys, no schema changes. A v1.3 `history.db` opens clean both directions and an untouched config behaves identically.

### Added

- **`daimon export [--since 7d] [--app <a>] [--format json|md|csv] [--out <file>]` (M111, experimental)** — the one-way carry-out bundle: persisted events, fingerprint-folded error groups, test runs, compiles, crash reports (each keeping only its existing bounded log tail — no other log lines, by design), and the full M83 report, composed from existing history queries, never re-derived. The JSON envelope is versioned — `{ schemaVersion: 1, generatedAt, daimonVersion, since, until, app, sections }` — with additive-only evolution; readers must ignore unknown keys. Its shape is snapshot-pinned in the contract suite despite the experimental tier: it is a consumed format from day one. Sections degrade independently to `{ note }` (an empty history exports a valid bundle of notes). **Export is one-way: there is no `daimon import` and no plan for one** (import edges toward sync, a standing NO). **Redaction holds in bundles**: env key names + salted hashes only, never values, and never the personal email — grep-asserted against generated bundles in all three formats by the redaction suite. `--format md` renders the report plus per-section summaries (paste-ready); `--format csv` is a flat `section,ts,app,summary,detail` view (documented lowest-common-denominator, not a second schema; the report section is not flattened). `--out` writes atomically (tmp + rename, the M88 rule) — a mid-write kill can never leave a torn file; without it the bundle goes to stdout, pipe-friendly. Same surface on `GET /api/export?since=&app=&format=` (proper `text/markdown`/`text/csv` content types) and MCP `daimon_export` (30 tools). Bench budget: full JSON bundle over the 100k-event corpus < 750ms, alongside report's 500ms.
- **Report print stylesheet (M112)** — printing (or Save-as-PDF) the dashboard Report page now yields clean black-on-white regardless of the active theme: navigation/topbar/toasts/period-switcher hidden, sections flow as blocks with `break-inside: avoid` and headings kept with their content, charts fall back to their token-driven monochrome rendering, shadows/animations stripped. Token-layer implementation (one `@media print { :root { … } }` override block + structural hides) — no JS, no route, no Angular component changed; screen rendering is byte-identical. Verified by a Playwright spec using `emulateMedia({ media: 'print' })` against a dark-themed seeded Report page, plus a screen-media regression guard; axe stays zero serious/critical.
- **Shell completion regenerated from the surface (M113)** — all four completion generators (bash/zsh/fish/PowerShell) now derive from `cliSurface.ts`'s `CLI_SUBCOMMANDS` through one shared model: every verb, alias, and flag through v1.4 completes (including `export`, `report`, `env diff`, `ports`, `mute`, and the post-freeze verbs the old hand-maintained lists had drifted past), flags with values complete, and subcommand verbs (`daemon start|stop|…`, `workspaces list|add|rm|show`, `env diff`, `config validate`) complete their subwords. Generated output is committed under `completions/` (bash/zsh/PowerShell, LF-pinned) with `npm run build:completions` to regenerate — and a drift test (`test/completion.test.mjs`) regenerates in-memory and diffs byte-for-byte, so a hand edit or a forgotten regen after a surface change fails the suite. `completions/` deliberately stays out of the npm tarball; users run `daimon completion <shell>`.
- **Deterministic demo script (M114)** — `scripts/demo/run-demo.mjs` spawns a real daemon under a throwaway `DAIMON_HOME` + throwaway workspace, seeds two fixture apps, and drives a fixed CLI session (list → start → wait → error surfaced → `report --md` → `export --format md` → stop → daemon stop), then removes both temp dirs. Headless, stable ordering, exit 0. `test/demo-script.test.mjs` runs it end-to-end and asserts the real `~/.daimon` is untouched. Recording the GIF stays human (standing rule) — the script just makes the session replayable.
- **Deferred-stretch sweep (M114)** — every still-open deferred/stretch item from the v0.13–v1.3 cycles was re-read and dispositioned; four were absorbed by this release's own milestones (export, print stylesheet, completion regen, demo script), six carry forward explicitly in RELEASE-v1.4.0.md's still-deferred list — nothing silently dropped, nothing implemented that would have needed a new surface, config key, or schema.

### Changed

- README gains a "Carry-out (v1.4)" section (bundle shape, one-way statement, redaction rules, completion install one-liners, demo pointer); docs regenerated with `experimental` badges for the new verb/endpoint/tool; CLAUDE.md records the export-composition, completion-drift, and demo-isolation conventions.

## [1.3.0] — 2026-07-17

"Guardrails" — resource awareness: daimon finally sees RSS and CPU (M105–M110). Persisted sampling, `daimon top`, self-calibrating leak/CPU-storm suspicion, and budgets that **warn and never kill** — no resource code path can signal, stop, restart, or throttle a process, and a grep-style suite proves it. **Everything is additive**, every new surface ships tier `experimental`, and no frozen or stable shape changed. A v1.2 `history.db` opens clean both directions; an untouched config behaves exactly as v1.2 (with default-cadence sampling).

### Added

- **Resource sampling (M105, experimental)** — the existing 2s pidusage poll (`UsageMonitor`, which fed the live TUI and threw the numbers away) gains a per-app downsampler writing one row per app per `resources.sampleMs` (default 30s; `0` disables persistence, live display unaffected) to a new additive `resource_samples` table (`app, ts, rss` bytes`, cpu` percent, indexed `(app, ts)`), pruned by the existing retention pass. No second timer, no second poll. Fail-soft per app: a dead pid or write failure self-warns once and sampling continues for the others. Two bench measurements landed with the milestone: write-path p50/p95 with sampling rows interleaved at 20× the realistic worst-case volume, and the sampling path's direct CPU attribution — both indistinguishable from baseline (contention-immune arms).
- **`daimon top [--json]` (M106, experimental)** — the point-in-time answer to "what is eating my machine, of the things daimon owns": app → pid → RSS(MB) → CPU% → uptime, sorted by RSS descending, from live UsageMonitor state (not history). An app whose first reading hasn't arrived renders dashes (nulls in JSON), never an error. Same shape on `GET /api/top` and MCP `daimon_top` (29 tools; agent identity forwarded via `callJson`).
- **Leak suspicion (M107, experimental)** — self-calibrating: the first 5 minutes after each spawn establish baseline RSS (median) + jitter (MAD), recalibrated on every restart; too few samples = no baseline = no verdicts, ever. RSS monotonic-with-tolerance across a full 15-minute window with total growth beyond max(4× jitter, 10% of baseline median) raises one `resource-leak-suspect` event (baseline, current, growth rate, window, remedy). Multipliers are internal constants — deliberately not config. One event per episode; re-arms only when RSS returns within jitter of baseline or the app restarts (hysteresis is structural: the dip that re-arms also breaks the next window's monotonicity). Sawtooth GC patterns, warm-up climbs, noisy-but-flat contention shapes, sampling gaps, and drift-within-noise never fire — pinned by synthetic-series unit tests over a pure, import-free detector module (`src/resources.ts`).
- **CPU storms + budgets (M108, experimental)** — `cpu-storm`: every sample in a full window above the app's own baseline p95 AND window mean ≥ baseline median + 4× jitter (floored for near-idle baselines, the logStorm 1-line/min ethos) — a single hot sample or compile burst never fires; same episode/re-arm semantics. Budgets: optional `resources.{rssMb,cpuPct}` + `overrides.<app>.resources` (override wins per key); crossing one for a sustained window raises one `resource-budget-exceeded` naming observed value, budget, and remedy. Absent keys = no checks. **Warn-never-kill enforcement suite**: `resources.ts` imports nothing (grep-verified), the sampling path has no kill/spawn surface, no consumer wires a resource event kind to process control, and a behavioral test fires all three kinds against a live registry and asserts app state moved by zero fields.
- **Surfacing (M109)** — Trends gains per-app `rss` (MB) and `cpu` (%) series (`?metrics=rss,cpu` on `/api/history/trends`, dashboard charts with the existing token system + period switcher); `daimon why` gains `resources` (open episodes + baseline) and a `resourceNote` when the crash under diagnosis fell inside an open suspicion window ("RSS grew 3.1× baseline over the ~15 min before this crash"); doctor rule `cpu-storm-active: <app>` (advise-only by contract — no auto-fix exists); `daimon report` gains a `resources` section (peak RSS, avg CPU, suspicion/budget counts per app), degradable to a note like every section, report bench unchanged.
- **Notification kinds `resource-leak-suspect` / `cpu-storm` / `resource-budget-exceeded`** — all three **opt-in** via `notifications.kinds`; absent = zero new noise (self-events + webhooks flow regardless). Event kinds tiered experimental in `EVENT_KIND_STABILITY`.

### Changed

- `daimon.config.example.json` documents `resources.{sampleMs,rssMb,cpuPct}` (nulls = absent); docs regenerated with tier badges for every new surface (all experimental); CLAUDE.md records the warn-never-kill convention.

## [1.2.0] — 2026-07-17

"Log Sense" — log levels, live filtering, and storm detection: the firehose made readable (M99–M104). **Everything is additive**, every new surface ships tier `experimental`, and no frozen or stable shape changed. A config that loaded under any earlier version loads unchanged; a v1.1 `history.db` opens clean both directions.

### Added

- **Log-level classification (M99, experimental)** — every ingested line gets a level (`error`/`warn`/`info`/`debug`, or `null` when honestly unknown). Declared per framework as a new optional `FrameworkProfile` field `logLevelPatterns` (ordered regex→level rows, first match wins, compiled once at profile load, validated as data — never loaded code), fixture-gated like every registry field since M65: a profile shipping patterns without covering `logLines` fixture cases fails the suite, and so does a pattern no fixture line exercises. Shipped for frameworks with documented output conventions only: angular/nx (esbuild `✘ [ERROR]`/`▲ [WARNING]`, webpack `ERROR in`/`WARNING in`), vite (esbuild diagnostics + `ERROR`/`WARN` badges), nextjs (`⨯`/`⚠`/`✓`), django + flask (Python logging), rails (Ruby Logger `SEVERITY -- :`), dotnet (`crit:`/`fail:`/`warn:`/`info:`/`dbug:`/`trce:`). Everything else classifies via one conservative shared heuristic (error/warn/info word near line start, ANSI-stripped, "0 errors" summary lines excluded) — explicit non-participation, no guessing. **Fail-soft at ingest**: any miss, invalid pattern, or classifier error stores the line with level `null` — a classifier bug can never drop or delay a log line. Storage is an additive nullable `level` column on `log_lines` (guarded `ALTER TABLE`; old rows read back `null`; the write-path bench gained a before/after measurement and stays within budget). Custom config profiles may declare `logLevelPatterns` too — an invalid row warns and drops the field, never the profile.
- **`daimon logs --level` (M100, experimental flag)** — `--level <error|warn|info|debug>` keeps only lines classified at that level (unclassified lines are excluded by design), composing AND with the existing `--tail`/`--since`/`--grep`. Same `?level=` param on `GET /api/apps/:name/logs`, its SSE stream, and `GET /api/groups/:name/logs`; invalid values are a 400/exit-1 naming the accepted set. Filters apply in `--stream` follow mode per line at delivery — never buffered. MCP `get_logs` gains optional `level` and `grep` fields (additive on the frozen tool). The SSE stream also accepts `?levels=1` to include a per-line `level` field in the payload (absent = the classic `{ts,line}` shape, byte for byte — the dashboard uses it). Bare `daimon logs <app>` output is byte-identical to v1.1.
- **Log-storm detection (M101, experimental)** — per-app rolling lines-per-minute baseline maintained in memory from the existing ingest path (no new tables). A sustained spike ≥ `multiplier` × the app's own baseline (default 10× over 60s; tune via the new optional `logs.storm { multiplier, windowSec }` key) raises exactly one `log-storm` event; recovery raises one `log-storm-end`. Hysteresis: the baseline freezes at entry and the storm ends only at half the entry threshold — a flapping rate can't spam the timeline. Apps with under 3 minutes of history never storm; a restart resets the baseline. New event kinds `log-storm`/`log-storm-end` (experimental); OS-notification kind `log-storm` is **opt-in** via `notifications.kinds` (absent = no new noise; batching, quiet hours, and mutes apply unchanged); doctor rule `log-storm-active: <app>` (suggest-only — names the observed rate, baseline, and remedy); `daimon why` gains `logStorm`; status summaries carry a `logStorm` marker while storming.
- **TUI log filters (M102)** — `l` on the log pane cycles the level filter (all → error → warn → info → all, `[level: x]` indicator in the pane header); `/` upgrades the pane's search into a live grep (narrows per keystroke; invalid regex falls back to case-insensitive substring; Escape clears, Enter keeps the filter). Both client-side over the streamed lines, no new server state; the pane's `n`/`N` jump-to-match keys retired (narrowing makes them meaningless — every visible line matches).
- **Dashboard log sense (M102)** — level chips with live counts on the log viewer (click to filter; unclassified lines excluded while filtered), a regex filter box with an inline invalid-pattern error, a storm banner while the app's status carries `logStorm` (one click applies the error filter), and jump-to-search deep-links both ways over the M85 plumbing. Token-layer styling, both themes, WCAG AA maintained (axe zero serious/critical at 1280px and 390px).
- **Report log-volume line (M103)** — the errors section gains `logVolume` (total lines, error-level share, storms in the window), rendered by `--md` and the dashboard Report page; no log data degrades it to a `{ note }`, never an error; the 100k-corpus report bench stays under its 500ms budget.

### Fixed

- **Errors page WCAG A violation** — the "Open app" link was nested inside the expansion panel's button-role header (axe `nested-interactive`, surfaced once the new axe drive ran against a workspace with real error panels); it now sits at the top of the panel body. The log viewer's virtual-scroll region is keyboard-focusable (`scrollable-region-focusable`).

### Changed

- `daimon.config.example.json` documents `logs.storm`; docs regenerated with tier badges for every new surface (all experimental).

## [1.1.0] — 2026-07-17

"Morning Start" — named app groups so one command starts the whole day's working set (M93–M98). First post-1.0-freeze feature release: **everything here is additive**, every new surface ships tier `experimental`, and no frozen or stable shape changed. A config that loaded under any earlier version loads unchanged.

### Added

- **`groups` config key (M93, experimental)** — named app groups: `"day": ["api", "web"]` (shorthand — exactly the legacy `profiles` shape) or `"day": { "apps": [...], "autoStart": true }`. Both forms normalize at load. Groups additively subsume `profiles`: a name defined in both resolves to the group (with a `config validate` warning); `profiles` keeps loading forever. New resolution module `src/groups.ts` (depends-aware ordering via the existing graph — groups read the graph, never change it).
- **`GET /api/groups` (experimental)** — name → `{ apps, autoStart, statusCounts, healthy, total }`.
- **`daimon up <group>` / `stop <group>` / `down <group>` (M94)** — groups resolve first, then legacy profiles (documented precedence; legacy invocations byte-identical). `up` starts members ∪ their depends closure in topological order, waits per level, and returns a per-app readiness summary with a `"3/4 healthy"` tail — exit 0 all reached, 2 otherwise (existing meanings). `stop`/`down` stop members only (never shared external deps), in reverse depends order. On the frozen `stop` verb, app-name precedence is absolute — the group resolves only where the verb previously errored. Per-member soft-lock gating: a lock-refused member counts unhealthy and never aborts the rest. Cyclic members are reported, not started. HTTP: `POST /api/groups/:name/up|stop` (experimental, audit-logged).
- **`--group <g>` read filters (M95, experimental)** — additive flag on `list`, `status`, `errors`, `report` (+ `?group=` on `/api/apps`, `/api/errors`, `/api/report`) and new `GET /api/groups/:name/status|logs`. Shapes are byte-identical when the flag is absent. `daimon logs --group day` merges member log tails by timestamp with app attribution. Unknown group → exit 1 naming the valid groups. Frozen-verb guard: with NO groups configured, `--group <token>` parses exactly as v0.14 did (token = positional, flag = bare boolean) — defining groups is the opt-in to the value form. On `errors`, bare `--group` keeps its historical fingerprint-grouping meaning; `--group <name>` filters (the value `fingerprint` stays reserved). `report --group` names the group in the header. Group stop keeps `stop`'s exit codes: a lock-blocked member exits 5, any member left running exits 1.
- **autoStart groups (M96)** — `"autoStart": true` groups start at daemon boot after the per-app `autoStart` list, same semantics. Dedup happens at resolution, before any spawn: an app named by several sources (two groups, or list + group) spawns exactly once with one log line naming every source. Per-member failure degrades; boot never blocks. A config without autoStart groups boots exactly as v1.0 did.
- **TUI group filter (M97)** — `G` on the app list cycles the group filter (none → each group → none); header shows `group: <name> · 3/4 healthy`. Pane-scoped: LogPane's local `G` (jump to end) is untouched.
- **Dashboard group surfaces (M97)** — group filter chips on the apps list (keyboard-operable, both themes), grouped app list (one section per group + "ungrouped"), group membership on the app detail card, deep-linkable filter. Data from `GET /api/groups`; a pre-v1.1 daemon simply shows no chips.
- **MCP (M98)** — `ensure_up` resolves groups first (same precedence as `daimon up`); `stop_app` falls back to a group only where the app name previously errored; `daimon_report` gains an optional `group` param; new `daimon_groups` tool (experimental). 28 tools.
- **`daimon config validate` group checks (M93)** — unknown app name in a group warns with a nearest-name suggestion; an app in two autoStart sources gets a "starts once" note; a group/profile collision warns that the group wins.

### Changed

- `daimon.config.example.json` documents the empty `groups` map; docs regenerated with tier badges for every new surface (all experimental).

## [0.14.0] — 2026-07-12

"Runway" — the release before 1.0. No new feature surfaces: v0.14 inventories, repairs, labels, and hardens what exists (M87–M92). Every public surface now carries a stability tier enforced by contract tests, the daemon survives its own restart without killing your dev servers, the dashboard passed its first WCAG AA audit, and this is the **last release with a breaking-changes section**. v1.0.0 will be tagged later, after a real-usage soak, as a near-empty release.

### Breaking (the last)

- **Compact status `uptime` → `uptimeMs`** — `daimon status` (compact/default), `GET /api/apps/:name` (compact), the `ensure` response, MCP `get_status`, and `daimon daemon status`. The value was always milliseconds; the unsuffixed key read as seconds and caused real unit bugs. Migration: read `uptimeMs`.
- **`daimon list --tag/--workspace` no longer switches to the full shape** — filters now run on the daemon (new `GET /api/apps?tag=&workspace=` params) and the output stays compact unless `--full` is passed. Also fixes `--tag <t> --compact` always returning `[]`. Migration: add `--full` if you scripted against the verbose filtered rows.

### Added

- **Stability tiers (M87)** — every CLI verb, HTTP endpoint, MCP tool, config key, and event kind declares `frozen` / `stable` / `experimental` at its source of truth; `npm run build:docs` renders the badge next to each; `STABILITY.md` defines the promise each tier makes. `test/contract.test.mjs` pins golden shapes (key sets + types, never values) for every frozen surface — a frozen surface without a snapshot fails the suite; a frozen-shape change fails it forever. Deliberate exception: `GET /api/signature` is frozen despite being born in v0.13 (it is the cross-version identification handshake).
- **Daemon handoff re-adoption (M88)** — `daimon daemon restart` leaves managed children RUNNING; the incoming daemon verifies each (the pid the outgoing daemon saw LISTENING on the app's port, still alive and still the listener) and re-adopts it with the same pid — health probing resumes, log capture resumes on the next app restart. Unverifiable children surface as the new `orphaned` status with a per-case remedy — never silently dropped, never blindly killed. Pre-v0.14 handoff files keep the legacy restart behavior.
- **Atomic state with recovery (M88)** — every `~/.daimon/*.json` the daemon rewrites (state.json, session-state.json, config rewrites via PATCH/pin-health) is written tmp→`.bak`→rename. A corrupt `state.json` recovers from `.bak`; if both are unreadable it's archived as `state.json.corrupt-<ts>` with a fresh start — each path records a self-warn event (mirrors history.db). Crash-recovery order documented and tested: recover state → verify locks → re-adopt/orphan → serve. New `test/lifecycle-torture.test.mjs` (kill-mid-write, double corruption, double-start forensics, restart-under-load re-adoption, skew probe — all under DAIMON_HOME isolation with real daemon spawns).
- **Version-skew warning (M88)** — every daemon response carries `x-daimon-version`; a CLI seeing a mismatch (or a pre-v0.14 daemon) warns once on stderr with the remedy (`daimon daemon restart`) — never a hard fail.
- **WCAG AA dashboard audit (M89)** — keyboard-only operation on every route (skip link, focus order, Escape, visible focus), contrast fixed at the `--dm-*` token layer for both themes, ARIA landmarks/labels/aria-live, `prefers-reduced-motion` honored, and an automated axe gate (`@axe-core/playwright`, the release's single sanctioned devDependency) across all routes at 1280px and 390px — zero serious/critical.
- **`daimon config validate` (M91)** — offline config check: unknown keys warn with the nearest valid name, malformed values report the same field-level warnings the daemon applies at load; exit 0 with warnings / 1 on errors. The daemon now also warns (never fails) on unknown keys at load time — config back-compat is contractually unbreakable (STABILITY.md).
- **SECURITY.md (M90)** — the posture in writing: loopback-only binding, no telemetry ever, same-tick env-value redaction, state confinement, the plugin trust model, verify-then-kill, and the report channel (GitHub issues / flycotech.com).
- **Doctor coverage table (M91)** — every recurring failure class from v0.11–v0.14 mapped to its doctor rule, auto-fix, built-in remedy, or documented gap (`DOCTOR_COVERAGE` in doctor.ts, rendered in the docs).
- **Error-remedy audit (M90)** — every user-facing error now says what to do next (unknown-app 404s suggest the nearest name and `daimon list`; timeouts, stream failures, config fatals, and doctor findings all carry remedies); `test/error-remedies.test.mjs` scans the source and fails on bare errors.

### Fixed

- **`daimon profiles suggest` dispatched as "unknown command" since v0.12** — the alias rewrote the verb to its canonical multi-word name but the dispatch switch never matched it (M91).
- `daimon list --tag <t> --compact` returned `[]` (compact rows carry no tags to filter on client-side) — see Breaking above.
- `src/tui/AttachApp.tsx` bypassed `daimonDir()` — the attach token now honors `DAIMON_HOME` (M91).
- `src/parser.ts` contained literal NUL bytes that made grep treat it as binary; replaced with string escapes (M91).
- Doctor's `node_modules` check no longer fires for non-JS workspace roots, and its finding now names the remedy (M90).
- The `history-stress` and `ports` forensics tests are contention-immune: ratio-to-CPU-reference budgets and a generous probe ceiling replace wall-clock-only assertions — budgets were NOT loosened for the quiet-machine case (M91).

### Changed

- npm package now ships `docs/` and `daimon.config.example.json` (the annotated example the config stub copies from); a pack-audit test keeps fixtures/tests/personal-email out of the tarball forever (M91).
- `GET /api/apps/:name/wait` additionally accepts `?timeoutMs=` (legacy `?timeout=` seconds unchanged).
- New event: none. New config keys: none — a runway release adds nothing that must then be frozen.
- Suite: **571 tests** (from 529): contract golden shapes, lifecycle torture, config-validate, pack-audit, error-remedies.

### Migration

See `RELEASE-v0.14.0.md` — two mechanical edits (`uptime` → `uptimeMs`; `--full` on filtered `list` calls if you needed verbose rows), nothing else. Configs are untouched; v0.1 configs still load.

## [0.13.0] — 2026-07-11

"Daily Rhythm" — v0.12 gave daimon total recall; v0.13 makes it useful across the day: `daimon report` answers "what happened", env fingerprints answer "what changed", a port pool + forensics answer "who has what", and routed/batched/mutable notifications with a scheduled digest close the loop (M81–M86).

### Added

- **Port management (M81)** — optional `ports.pool` ("4200-4299") auto-assigns ports ONLY to frameworks whose registry row documents the mechanism: new `FrameworkProfile.portFlag` (template, e.g. `--port {port}`, `-p {port}`, django's positional `127.0.0.1:{port}`) and/or `portEnv` (e.g. `PORT`) on angular/nx/vite/next/nuxt/astro/sveltekit/remix-adjacent rows plus storybook/django/flask/fastapi/rails/laravel/rust-trunk/express-nest. Profiles without a documented flag never get a port injected — explicit non-participation, never guessed. Assignments persist in `~/.daimon/state.json` (stable across restarts, released when the app is removed). Custom config profiles may declare `portFlag`/`portEnv` (validated data). With no `ports.pool`, the legacy portRange + blanket `--port` behavior is unchanged.
- **`daimon ports` (M81)** — app → port → source (`pinned|pool|announced`) → pid, plus foreign holders of pool/pinned ports (one `netstat -ano`/`ss` pass, per-holder enrichment). `GET /api/ports`.
- **Daemon startup forensics (M81)** — `EADDRINUSE` on the api port now identifies the holder (pid, process name, start time), probes the new `GET /api/signature` endpoint to say whether it answers as a daimon, prints the remedy, writes a crash dump, and exits non-zero. `daimon daemon start`'s old "failed to start within 5s" now surfaces the crash-dump gist + path. The daemon writes `daemon.lock` only AFTER a successful bind — an EADDRINUSE loser can no longer clobber the winner's lock (the v0.12 orphan incident class).
- **Doctor `port-holder-no-lock` (M81)** — apiPort held + no live lock: if the holder answers on the daimon signature endpoint it's a verified orphan and `--auto-fix` terminates it (verify-then-kill, re-checked at fix time); any other holder is identified and advised on, never killed. `port-conflict-pred` is pool-aware (pool endpoints + persisted assignments + pinned).
- **Env awareness (M82)** — read-only, **redacted at the storage layer**. New `FrameworkProfile.envFiles` conventions (vite/next/astro/sveltekit/remix `.env*` order, nuxt `.env`, flask `.flaskenv`+`.env`; generic fallback `.env`). Every spawn fingerprints the convention files into the new `env_snapshots` history table: `{file, exists, mtime, size, keyNames[], keyHashes{}}` — per-key salted truncated HMAC hashes (per-install salt at `~/.daimon/salt`, created once, 0600); raw values are parsed and discarded in the same tick and never reach the DB, logs, webhooks, or notifications. There is no `--show-values` — open the file.
- **`daimon env` (M82)** — `daimon env <app>`: convention files (found/missing), key names, snapshot age; `daimon env diff <app> [--from <ts>] [--to <ts>]`: files/keys added/removed/changed between spawns (default: last two). `GET /api/env/<app>[/diff]` (responses carry names only — hashes stay server-side). `daimon why` gains `envChanged` (diff vs the last snapshot preceding a healthy signal). New doctor rule `env-file-missing` (suggest-only). Redaction test suite asserts no raw value in the DB bytes, events, or webhook payload shapes.
- **`daimon report` (M83)** — the digest: `daimon report [--since 24h|7d] [--app <a>] [--workspace <label>] [--md]` + `GET /api/report`. Closed section list, all composition over existing queries: per-app uptime % + restarts, error groups (new vs recurring vs resolved), test pass-rate + flakiest tests, compile p50/p95 + slowest + regressions, crashes/storms, agent activity, env changes (key names only). Every section degrades independently to a `note` — never an error. `--md` renders human-first markdown (Slack/PR-ready); `?md=1` on the API. New perf budget in-suite: report over the 100k-event corpus < 500ms. Dashboard Report page (lazy chunk, nav entry, `g p` chord, 24h/7d/custom period switcher).
- **Notification polish (M84)** — `notifications.kinds` routes exactly the listed kinds (absent = the pre-v0.13 set; new opt-in kinds: `error-new`, `crash`, `restart-storm`, `test-failed`, `flaky-test-detected`); `notifications.batchMs` collapses same-fingerprint error notifications inside the window into ONE with a count; `notifications.quietHours` ("22:00-08:00") suppresses OS notifications in the window (events/webhooks unaffected) and fires one "while you were away: N" summary when it ends.
- **`daimon mute <app> [--for <dur>]` / `daimon unmute` (M84)** — per-app notification mute, persisted in state.json, auto-expiring with `--for`, surfaced as `muted`/`muteUntil` in summaries, `daimon status`, and the dashboard app card.
- **Scheduled digest (M84)** — `webhooks[].digest: "HH:MM"` sends the M83 report (since the last digest) daily through the existing queue/rate-limit/retry path, Slack-shaped (`text` = markdown) when the host is detected. One 1-minute interval check — not a cron engine; if the daemon was down at the scheduled time, ONE catch-up fires on the next tick (never more than one per day per webhook, tracked in state.json). `digest-sent` self-event on the timeline.
- **TUI (M85)** — `T` chord runs the selected app's test suite with an inline pass/fail summary (`t` was already the tag filter).
- **Dashboard (M85)** — app-detail "why" panel (crash card, env-changed hint, storm state, suspect commit); palette search results deep-link to the timeline position / error group / log context; Trends adds test pass-rate and flaky-count series; mute badge on app cards.
- **MCP (M86)** — `daimon_report`, `daimon_env` (27-tool surface); contract tests extended; `daimon claude` templates teach the report/env-diff patterns.

### Changed

- New event kind `digest-sent` (webhook-eligible like everything else).
- `~/.daimon/state.json` now also persists `mutes` and `digests` (merged writes — additive, older files load unchanged).
- History DB migration is additive as always: new `env_snapshots` table; retention prunes it.
- Suite: **529 tests** (from 471), including the ports/forensics kit, the env redaction suite, report correctness + bench, and notification batching/quiet-hours/digest semantics.

### Migration

See `RELEASE-v0.13.0.md` — additive `env_snapshots` table, `~/.daimon/salt` created on first spawn, all new config keys optional (absent = v0.12 behavior), pool-port injection is opt-in via `ports.pool`, doctor auto-fix can now kill a VERIFIED orphan daimon (signature-checked; non-daimon holders never touched).

## [0.12.0] — 2026-07-10

"The Whole Loop" — v0.11 finished the serving story; v0.12 covers everything around it: tests as pipeline citizens (M74–M75), crash forensics (M76), full-text search over everything daimon has seen (M77), a one-call agent context pack (M78), and a small wave of runtime profiles + DX (M79).

### Added

- **`daimon test` (M74)** — run the project's own test runner once (daimon wraps, never installs or replaces): runner resolution via registry `testRunner` hints (JS profiles pick vitest vs jest by dependency check; pytest / `go test ./...` / `cargo test` / `dotnet test` for the polyglot rows), with `overrides.<app>.testCommand` always winning. Failures parsed to `{suite, test, file, line, message}` + totals (fail-soft), recorded in new `test_runs`/`test_failures` history tables. `POST /api/apps/<name>/test` (soft-lock gated, `?steal=1`, audit-logged), `GET /api/tests`, exit codes 0/1/2/5. Five runner parsers (`vitest-jest`, `pytest`, `go-test`, `cargo-test`, `dotnet-test`), each gated by a fixture in `test/fixtures/testrunners/<id>/` + parameterized `test/testrunners.test.mjs` — a runner without a fixture doesn't ship.
- **Flaky detection + Tests page (M75)** — a test fingerprint that flips pass↔fail ≥3 times at the same `gitHead` fires `flaky-test-detected` (once per fingerprint; threshold `tests.flakyThreshold`); failing runs fire `test-failed` — both webhook-eligible. `daimon test-history <app> [--flaky]`, `GET /api/tests/flaky`. Dashboard Tests page becomes run history: pass/fail sparklines, drill-down with VS Code links, run-to-run diff (newly failing / newly passing), flaky badges.
- **Crash forensics (M76)** — every child exit daimon didn't request persists a crash report (`exitCode`, `signal`, `uptimeMs`, last 50 log lines, `gitHead`), ring-buffered to 10 per app in the history DB; `crash` event on the feed. Restart storms (> `restartStorm.perHour`, default 20) fire ONE `restart-storm` event per storm + a doctor rule pointing at `daimon why`. New doctor rules: `restart-storm`, `searchroot-hygiene` (drive roots / system dirs / bare home as searchRoots — suggest-only), `daimon-home`.
- **`daimon why <app>` (M76)** — one-shot forensics composition (`GET /api/why/<app>`): status/health, last crash report, fingerprint-grouped 24h errors, regression events, active storm state, suspect commit, matching doctor findings. Readable panel on a TTY, compact JSON when piped.
- **Full-text search (M77)** — FTS5 (built into the bundled better-sqlite3 — no new dependency) over events, errors, and per-app log lines (log indexing default-on, opt out via `search.logIndex` / `overrides.<app>.logIndex`). Deferred high-water-mark indexing keeps the write path clean (measured <10% insert overhead; trigger-per-insert costs 4–10× and was rejected); retention pruning cascades into the index; FTS failure degrades to a LIKE scan with a one-time self-warn — never blocks the daemon. `daimon search <q> [--app --since --kind logs|errors|events]`, `GET /api/search`, MCP `daimon_search`, dashboard palette search mode (`>` prefix). Perf budgets in-suite: search <300ms on a 100k corpus.
- **`daimon context <app>` (M78)** — the agent context pack (`GET /api/context/<app>?budget=`): status/url/framework/uptime, top 5 error fingerprint groups, last crash, last test run + failures, compile p50/p95 + last regression, suspect commits, active locks/agents — composition of existing queries only, no new state. `--budget <chars>` drops sections lowest-priority-first (`compile → agents → crashes → tests → errors`; `status` never drops), reporting drops in `truncated[]`.
- **MCP wave (M78)** — `daimon_context`, `daimon_run_tests`, `daimon_why`, `daimon_search` (25-tool surface); contract tests extended; `daimon claude` templates teach the context-first workflow.
- **Runtime profiles (M79)** — `deno` (`deno.json[c]` → `deno task dev`) and `bun` (`bunfig.toml`/`bun.lock*` + dev script → `bun run dev`), fixtures per the M65 convention.
- **`DAIMON_HOME` (M79)** — first-class env override relocating the entire `~/.daimon` state dir (lock, config, history, logs, plugins, snapshots, sessions); `daimon doctor` prints the active home; daimon's own e2e suites use it instead of HOME/USERPROFILE games.
- **`daimon logs --grep` (M79)** — server-side case-insensitive regex filter (length-capped at 512 chars) on both the one-shot tail and the SSE live stream; `--stream` follows the filtered live tail as NDJSON.
- **Dashboard (M79)** — first-run onboarding tour (dismiss-once, persisted) and a PWA manifest + icons (installable, loopback-only, static assets only).

### Changed

- New event kinds on the feed (all webhook-eligible via the existing filter): `test-run`, `test-failed`, `flaky-test-detected`, `crash`, `restart-storm`.
- History DB migrations are additive (`CREATE TABLE IF NOT EXISTS`): `test_runs`, `test_failures`, `crashes`, `log_lines`, `fts_state` + `events_fts`/`log_fts` virtual tables. Retention prunes all of them.
- History book-keeping timers are `unref`'d — history can never be what keeps a process alive.
- Suite: **471+ tests** (from 387), including the test-runner kit, crash forensics, FTS budgets, and the context-pack contract.

### Migration

See `RELEASE-v0.12.0.md` — additive history-DB migration (auto-created on startup), `daimon test` is soft-lock gated, new event kinds for webhook filters, `DAIMON_HOME`.

## [0.11.0] — 2026-07-10

"Polyglot & Polished" — framework support becomes a declarative adapter registry with three new waves of profiles (M65–M69), every profile becomes a full pipeline citizen (readiness / URL / error parsing), and the dashboard gets its long-deferred redesign (M70–M71). M72 pays the v0.10 debt; 20 single-app built-in profiles + 2 monorepo enumerators + the generic fallback ship with fixtures.

### Added

- **Framework adapter registry (M65)** — `src/frameworks.ts`: every framework is a declarative `FrameworkProfile` row (detect markers / command / readiness / url / errorParser / healthProbe / badge+tone). `discoverApps()` is a loop over the registry; new frameworks are registry rows + fixtures, never `discovery.ts` branches. New verb `daimon frameworks` + `GET /api/frameworks`; `discovery.stats` gains per-profile match counts.
- **Custom profiles** — `frameworks: []` in `daimon.config.json`: data-only rows (marker files, regex strings, built-in parser ids — never loaded code), validated at load with doctor-surfaced warnings, checked after built-ins.
- **Multi-family coexistence (M65)** — the nx/angular short-circuits are gone: a root with both `angular.json` and `manage.py` registers both apps.
- **JS wave (M66)** — `nextjs`, `nuxt`, `sveltekit`, `astro`, `remix` profiles with readiness + URL patterns; a meta-framework's `vite.config` no longer double-registers a vite app.
- **Generic `package.json` fallback (M66)** — any directory with a `dev`/`serve`/`start` script registers (lowest precedence, never inside `node_modules`, every skip explained in rejection stats).
- **Monorepo enumerators (M66)** — `pnpm-workspace.yaml` and `turbo.json` roots enumerate member packages through the full profile pass, nx-style.
- **Package-manager awareness (M66)** — commands adapt to the lockfile (`pnpm`/`yarn`/`bun`/`npm`); members inherit the workspace root's lockfile. Detection only reads lockfile names.
- **Per-profile intelligence (M67)** — registry `readiness` patterns drive `compiling → serving`, `url` patterns feed the announced-URL health probe. New multi-line error parsers: `python-traceback`, `go-build`, `rust-cargo`, `dotnet`, `jvm-gradle` (+ `php` in M68) — fail-soft, additive, never drop or reorder log lines.
- **Adapter test kit (M67)** — `test/fixtures/frameworks/<id>/` per profile + parameterized `test/frameworks.test.mjs` asserting detection, command, readiness, URL, and a parsed error with file:line. A built-in profile without a fixture fails the suite.
- **Backend wave (M68)** — `dotnet` (watch), `spring-boot` (mvnw/gradlew with Windows `.cmd` resolution), `laravel`, `flask`, `express-nest`; the 5 v0.10 polyglot profiles upgraded from spawn-only to full readiness/URL/error parsing; TCP-listen readiness fallback (`healthProbe: "tcp"`) flips port-silent servers to `serving` when the port accepts connections (loopback only); `bin/rails` runs through `ruby` on Windows.
- **Mobile wave (M69)** — `expo` (Metro), `flutter` (`-d web-server`), `tauri`. Web-preview URL only; no device/emulator orchestration.
- **Design system (M70)** — `dashboard/src/styles/tokens.css`: color (light+dark), spacing, type, radii, elevation, motion; primitives and workspace tones consume tokens (dark-mode tones fixed as a side effect).
- **Mission control (M70)** — the home card grid gains per-app framework badges (inline SVG glyph + registry tone) and a 24h uptime/error sparkline from the history timeline; ready countdowns, soft-lock chips and quick actions as before; the compact list stays as a toggle. `AppSummary` gains `serverProfile`.
- **Responsive (M71)** — nav-rail collapses to a bottom bar under 768px; every route usable at 390px (tables stack to cards, grids clamp); density `comfortable | compact` toggle persisted; focus outlines from tokens; Playwright viewport matrix (1280 + 390) with per-route zero-horizontal-overflow assertions.
- **Error grouping (M72)** — `GET /api/errors?group=fingerprint`, `daimon errors --group`, and a fingerprint group mode in the dashboard errors panel: same source location (or number-normalized message) folds into one group with count, first/last-seen and affected apps.
- **Per-app webhooks (M72)** — `webhooks[].apps` scoping + `overrides.<app>.webhooks` blocks merged with the global list; absent fields keep the exact v0.10 behavior.
- **VS Code (M72)** — code-lens over `package.json` scripts ("▶ Start via daimon" / "■ Stop" / dashboard, lock-aware) and framework badge tags on error tree items.
- **TUI (M72)** — app rows show the profile badge tag (`[next]`, `[flask]`).
- **MCP (M72)** — `daimon_frameworks` tool (21-tool surface).

### Changed

- `ServerProfile` widened to plain string on `DiscoveredApp`/`AppSummary` (custom profile ids).
- Announced-URL extraction and location parsing extended (`.astro`, `.dart` files; profile URL patterns catch Flask/Astro-style announcements the generic patterns miss).
- Suite: **387 tests** (from 271), including the framework kit, backend-wave TCP readiness, and fuzz coverage for every per-profile parse context.

### Migration

See `RELEASE-v0.11.0.md` — default dashboard home is the mission-control card grid (list survives as a toggle), `frameworks: []` config addition, `GET /api/frameworks`.

## [0.10.2] — 2026-07-02

Security & robustness hardening from a five-area code review (daemon core, persistence, CLI/MCP surface, process/ops, security posture). No new features; all fixes.

### Security

- **CSRF / DNS-rebinding gate on the HTTP API.** Every state-changing request (non-GET) must now come from a loopback `Host` with a loopback (or absent) `Origin`/`Referer`. A web page the developer merely visits can no longer drive `start`/`stop`/`run`/`config` on the local daemon via `fetch('http://127.0.0.1:…')`, and a rebinding domain resolving to 127.0.0.1 is rejected. Read-only GETs are exempt.
- **Command-injection hardening.** Discovered project names, and task names/args from the CLI/API, are validated against an allow-list before being interpolated into `shell: true` commands (`src/shellSafe.ts`). A cloned repo with a `project.json` `name` like `app && calc.exe`, or a `run` request with `args: ["; calc.exe"]`, is refused instead of executed.
- **Audit-log integrity.** Audit fields are stripped of tab/newline so a crafted `X-Daimon-Cwd` header (or a config key with a comma) can no longer forge columns / agent attribution.
- **Constant-time API-token comparison** (`crypto.timingSafeEqual`).
- **Secret redaction.** Webhook URLs (which embed Slack/Discord tokens) are reduced to origin in failure logs; crash dumps now redact URL credentials and `secret-ish-key = value` assignments from the app-log tail.
- **Static-file guard** tightened to a path-separator boundary; discovery no longer follows symlinks out of a searchRoot; snapshot filenames sanitize the app name; `portDiag` validates the port before interpolating it into a PowerShell command.
- **Plugin docs corrected:** plug-ins are opt-in but run in-process with full privileges — the inaccurate "sandboxed" wording was removed (they are trusted code the user places themselves).

### Fixed

- **`retentionDays: 0` wiped the entire history DB** instead of disabling pruning (the dashboard documents `0` as "disables pruning"). Now `<= 0` keeps everything.
- **Corrupt-DB recovery** no longer reopens and migrates the still-corrupt file when the archive rename fails (e.g. a stale Windows handle); it disables history instead.
- **`ensure` / `try-fix` now honour the per-app soft lock** like `start`/`stop`/`restart`, so a second agent can't act underneath the lock holder.
- **Atomic writes + no-clobber:** `state.json` and the handoff file use temp+rename (a crash mid-write no longer resets ports / drops app re-adoption); `doctor --auto-fix` and `health/pin` refuse to write when the target config is malformed JSON instead of clobbering it; a debounced state write is flushed on clean shutdown.
- **Request-body handling:** a shared reader caps body size, drains `Transfer-Encoding: chunked` requests, and resolves on socket abort/error (previously an aborted upload left the handler pending forever).
- **Unbounded map leak:** `errorFlapAlerted` is now pruned alongside its sibling window map.
- **CLI exit codes:** `focus` exits 2 on timeout (was always 0); `ci start` exits 1 (not 2) for an empty profile; the name-collision code (4) is documented on every name-taking command; `wait`'s documented default (120s) matches the code.
- **`profiles suggest`** now auto-spawns the daemon and resolves `daimon help profiles` (the space-in-name verb was unreachable to `findSubcommand`).
- **`health/pin`** writes an audit entry like other config mutations.
- **Cascade restart** rejections are swallowed so they can't surface as an `unhandledRejection`.
- Failed history flush batches are re-queued (bounded) instead of dropped; `diskLogger` no longer leaves an orphan `.1` when `maxFiles === 1`.

### Changed

- **`orchestrate`** defaults to a conservative auto-fix subset (`ORCHESTRATE_SAFE_AUTO_FIX`) — it no longer rewrites the user's config or restarts the daemon as a side effect — and now surfaces dependency cycles instead of silently dropping the apps in them.
- **Client-side request timeout** on CLI and MCP daemon calls (above the 600s server deadline) so a stalled daemon can't hang a call forever.
- **Registry `setMaxListeners(0)`** — many concurrent dashboard tabs / streams no longer trip a spurious `MaxListenersExceededWarning`.
- Suite: **271 tests** (added `test/review-hardening.test.mjs` covering the shell-safety guards, audit escaping, and the CSRF/rebinding gate).

## [0.10.1] — 2026-06-11

Review-hardening patch: a full milestone audit of v0.10.0 (run before realizing 0.10.0 had already shipped) found real bugs and quietly-weakened acceptance criteria. All of it lands here.

### Fixed

- **Event double-emit:** `Registry.recordEvent` emitted `'event'` twice, double-delivering every event to SSE/ndjson streams and webhooks. Now emits once.
- **Compile-regression baseline:** the just-recorded compile is excluded from the baseline by row identity (ts) instead of by duration value — equal-duration priors no longer empty the baseline and suppress detection.
- **Suspect-commit hint is async:** `git log -1` now runs via `execFile` off the hot path; a compile can no longer stall the daemon while git resolves.
- **Error-flap detection wired:** the daemon now tracks per-fingerprint sliding windows (24h) and emits `regression-detected { kind: 'error-flap' }` — including spikes from a zero baseline (factor capped at 99). One alert per fingerprint per hour.
- **Bundle regression uses a rolling median** of the last 10 recorded builds (falls back to the previous build when history is empty/disabled).
- **Per-app threshold:** new optional `overrides.<app>.compileRegressionFactor` (default 2.0).
- **Medians are true medians** (average of the two middles on even samples) in regression baselines and the ready-time p50.
- **TUI attach + doctor auto-fix now send `X-Daimon-Agent`** — locks taken from the attach TUI no longer masquerade as `unknown`.
- **Agent registry hygiene:** header-less callers (e.g. the dashboard's polling) are no longer recorded as an `unknown` agent, and stale agent records are pruned every 60s.
- **Lock ordering:** lifecycle endpoints validate the app name (404) before acquiring the soft-lock — no more 409s for apps that don't exist.
- **Parser line cap:** `parseLine` now slices input to 2KB before regex matching; 100KB stdout lines (base64 blobs, minified dumps) can no longer trigger quadratic backtracking.
- **SSE/ndjson backpressure:** both the log stream and `/api/events?stream=ndjson` now ring-buffer against slow clients, drop oldest on overflow, and report the drop count in-stream (`stream-overflow`) and on stderr.
- **README no longer ships a private email** — commercial-license contact points at https://flycotech.com.
- Command palette chord hints matched to the actual chord map (`g v` Events, `g e` Errors, `g r` Regressions).
- VS Code extension: `daimonAttached` context resets when the daemon goes down; new "Open daimon log for this app" code action on TypeScript diagnostics.

### Changed

- **M54 follow-through:** prepared-statement cache in History; `registry.list()` no longer rescans the event buffer per app (incremental last-status map, single-pass error counts); discovery results cached for 10s keyed on `searchRoots`; bench now asserts the `/api/apps` 200ms budget against `registry.list()` and uses a real SSE-catchup backlog.
- **M55 follow-through:** corrupt-DB rebuild now records a `self-warn` event; invalid config fields warn + fall back to defaults instead of refusing to start (unparseable JSON still refuses, now with line/column); soft-reload detaches orphaned apps (children terminated, state removed, `self-warn` event) with a `daimon doctor` `orphaned-app-cleanup` count; new `config-valid` doctor rule; per-app session state (errors, last-200-line log tail, compile history) snapshots to `~/.daimon/session-state.json` every 30s and restores after a crash or restart.
- **M56 follow-through:** parser fuzz covers NUL bytes, byte corruption, mixed line endings, and 100KB lines; lock torture is now 50 concurrent agents against a live in-process HTTP server (one winner, 49 structured 409s, <5s); the MCP contract test connects a real SDK client over an in-memory transport and validates every tool's schema + invocation shape.
- **M59 follow-through:** `daimon_subscribe_events` is now a true long-poll (`GET /api/events?waitMs=` holds the request until the next matching event, max 55s); `daimon_notify_on_error` rides the same mechanism instead of busy-polling; dashboard app cards/detail show per-app agent chips + a lock indicator with live TTL; status pills count down `~Xs` while compiling.
- **M63 follow-through:** the generic webhook envelope now includes the documented `payload` object (flattened `from`/`to`/`message` kept for back-compat); new `docs/ci-integration.md` with a GitHub Actions workflow.
- **M57/M64 follow-through:** README rewritten for v0.10 (agent identity, webhooks, ci verb, VS Code extension, docs-site link); SVG logo (`assets/logo.svg` + accent variant); example config covers `webhooks` + `compileRegressionFactor`.
- Suite: **262 tests / ~15s wall-clock** (up from 225 in 0.10.0).

### Migration

- Webhook consumers: the generic envelope gained a nested `payload` field; the flattened `from`/`to`/`message` fields remain.
- Invalid config **fields** no longer abort startup — they warn and run on defaults (`daimon doctor` lists them under `config-valid`). Unparseable config still refuses to start.
- New state file: `~/.daimon/session-state.json` (per-app error/log/compile snapshot, refreshed every 30s, ignored after 24h).

## [0.10.0] — 2026-05-22

Strategic theme: **Mature & Aware.** The biggest release yet. 11 milestones (M54–M64) covering perf at scale, recovery hardening, agent identity, pattern detection, predictive UX, webhooks, a VS Code extension, and a generated docs site.

### Added (M54) — Perf at scale (50 apps / 100K events)

- `test/perf-50apps.test.mjs` bench: 50 synthetic apps, 100k events, 30-day retention. Asserts hot-path budgets: events query p95 < 250ms, timeline 24h < 300ms, 50× summary doctor pass < 500ms, SSE catchup < 1s, RSS < 150MB.
- New `events_app_ts` SQLite index for the (app, ts) lookup pattern that powers `/api/apps?cwd=` + per-app timeline.

### Added (M55) — Recovery hardening

- History.db auto-rebuild on startup: `PRAGMA integrity_check` runs at open time; on failure the bad file is renamed `history.db.corrupt-<ts>` and a fresh db is created. Surface flows through to `daimon doctor` so the user can decide whether to delete the snapshot.
- WAL checkpoint on close: `PRAGMA wal_checkpoint(TRUNCATE)` runs during shutdown to keep `-wal` sidecars from ballooning across SIGKILL cycles.
- New doctor rule `history-db-healthy` — reports any archived `.corrupt-*` snapshots left behind by previous startups.

### Added (M56) — Tests to 200+ under 30s

- New test files: `agents.test.mjs`, `audit.test.mjs`, `regressions.test.mjs`, `webhooks.test.mjs`, `recovery.test.mjs`, `perf-50apps.test.mjs`, `history-property.test.mjs`, `scope-property.test.mjs`, `mcp-contract.test.mjs`.
- Suite: **219 tests / 15.2s wall-clock** (up from 130 / 14s in v0.9).

### Added (M57) — Docs site + branding

- `scripts/build-docs.mjs` → generates `docs/index.html` from the live CLI surface + MCP tool list. Single self-contained HTML, no JS framework.
- New `CLAUDE.md` — orientation for future agents (where files live, conventions, "things daimon never does").
- New `npm run build:docs` script.

### Added (M58) — Agent identity + handoff (locked decision)

- `src/agents.ts`: `generateAgentId()` returns `<host>-<pid>-<rand4>`; `AgentRegistry` tracks who's calling (active = touched within 5 min); `LockManager` enforces 30-second per-app soft-locks.
- Audit log gains a **6th column** (agent id). `parseAuditLine()` exposed for tooling; legacy 5-col rows still parse.
- New endpoints: `GET /api/agents`, `GET /api/apps/<n>/lock`, `POST /api/apps/<n>/handoff`.
- `start`/`stop`/`restart` now return HTTP 409 `locked-by-other-agent` when another agent holds the soft-lock. Pass `?steal=1` to override.
- CLI: every call ships `X-Daimon-Agent`. New `daimon agents` and `daimon handoff <app> <agentId>` verbs. `--steal` on lifecycle verbs.
- MCP forwards `X-Daimon-Agent` and `X-Daimon-Cwd` on every request.

### Added (M59) — MCP expansion + who's watching

- New MCP tools: `daimon_who_owns`, `daimon_subscribe_events`, `daimon_notify_on_error`.
- Per-app lock + recent-interaction list queryable via `/api/apps/<n>/lock`.
- New dashboard `/agents` route: live list of every agent touching this daemon with per-agent cards showing call counts, last-seen, cwd, and the apps each agent currently holds. Orphan-lock surface lists locks held by agents that have gone inactive. Chord `g g` jumps straight to it; the help dialog and command palette pick it up automatically.

### Added (M60) — Pattern detection

- New event type `regression-detected` with structured payload `{ kind, factor, baseline, current, suspectCommit }`.
- Compile-time: factor 2.0 vs rolling median of last 20 successful compiles.
- Bundle: 10% initialKB growth vs the previous baseline.
- Error-flap: ≥5 errors/hour AND ≥3× the 23h-prior baseline.
- Suspect-commit hint pulled via `git log -1 --format=%h:%s` (best-effort; null on non-git workspaces).
- New dashboard `/regressions` route: filterable cards (all / compile / bundle / error-flap) showing baseline-vs-current, factor, fingerprint, and suspect-commit. Live-updates from the SSE stream and seeds from `/api/history/events?type=regression-detected`. Chord `g r`.

### Added (M61) — Predictive UX (ready-time)

- `AppSummary.estimatedReadyAtMs` projected from p50 of last 10 compiles during `compiling` state. Surfaced in compact CLI status and MCP `get_status` payloads.
- `daimon profiles suggest` CLI verb backed by `GET /api/profiles/suggest`. Sweeps the last 30d of `status → starting` events into co-start sessions (60s windows), counts canonical app-sets, and emits suggestions for clusters seen ≥5 times that don't already match an existing profile. Each suggestion carries a name, app list, occurrence count, last-seen, and reason string. `--since` and `--min` flags tune the window.
- `smart-restart-tune` doctor rule. Scans the last 7d of `status` events for non-stopped→starting transitions per app; flags any app restarting ≥5×/day with `restartPolicy` review guidance.

### Added (M62) — VS Code extension

- New `vscode-extension/` subpackage. Marketplace name `flycotech.daimon`.
- Features: status bar (cwd app health), errors sidebar (cwd-filtered, click-to-open), commands `Daimon: Start / Stop / Open dashboard / Show logs`, soft-lock-aware Start (offers to steal on 409).
- New root `npm run build:vscode` script (delegates to `vscode-extension` after `npm install`).
- `.vsix` built: `vscode-extension/daimon-vscode.vsix` (7.85 KB). LICENSE bundled. Ready for `vsce publish` to the marketplace.

### Added (M63) — Webhooks + CI verb

- New top-level config key `webhooks: WebhookEntry[]`.
- `WebhookDispatcher` subscribes to registry events, filters per-config, shapes payloads per host (Slack `attachments`, Discord `embeds`, generic envelope otherwise), and posts with up to 3 retries + exponential backoff. Global budget 1 req/sec, drop-oldest on overflow.
- New CLI verb `daimon ci start <profile> --until ready|healthy --timeout <duration> [--json]`. Exit code 0 on full success, 2 on timeout, 1 on unknown profile.

### Added (M64) — Polish + ship

- Help dialog automatically picks up new chords (`agents`, `handoff`, `ci`, `--steal`) from `cliSurface.ts`. Two new chord entries surfaced: `g g` (Agents), `g r` (Regressions), `g i` (Timeline).
- Playwright drive landed at `dashboard/e2e/dashboard.spec.ts`. Visits 13 routes (all existing + new `/agents`, `/regressions`), asserts page-specific landmarks, enforces a console-error budget, and verifies the `g g` / `g r` chord routing. Seed helper at `dashboard/e2e/seed.ts` writes 6 fixture events (≥1 serving, ≥1 error, ≥2 regressions). Run with `npm run e2e:install && npm run e2e:seed && npm run e2e` from `dashboard/`.
- Doctor 11-rule UI tightening carry-over from v0.9.
- `RELEASE-v0.10.0.md` with migration steps for the audit-column add and webhooks config.
- Test suite now at 225 / 17.0s (added 6 profile-suggester / restart-cadence tests).

### Migration

- Audit log gains a 6th column (agent). 5-column rows still parse.
- New `webhooks: []` config key. Default is the empty array — no outbound deliveries unless you opt in.
- HTTP 409 `locked-by-other-agent` is a new response code for lifecycle endpoints. Old CLIs (no `X-Daimon-Agent` header) get `agentId = 'unknown'` and never collide with named agents.

## [0.9.0] — 2026-05-21

Strategic theme: **Multi-agent observability.** v0.9 finishes the pivot to many agents on one machine, each in their own workspace, all sharing one daemon and one dashboard. On top of the architectural shift, deepen what daimon *sees* (lint findings as a third signal class beyond errors + warnings) and *shows* (a unified event timeline), and broaden what it *understands* (framework-aware health probes for the polyglot stack landed in v0.7).

### Added (M46) — Multi-workspace foundation

- `src/pathScope.ts` (`isPathUnder`, `normalizeForCompare`) — case-insensitive on Windows, separator-normalized.
- `POST /api/workspaces/ensure` — idempotent register; returns `{ added, root, addedApps }` or `{ added: false, reason: 'already covered' }`.
- `GET /api/apps?cwd=<path>` — filter by workspaceRoot under cwd (bidirectional: either direction counts).
- `daimon list` defaults to cwd-scoped; `--all` bypasses; auto-calls `ensureCurrentWorkspace()`.
- Warnings as a second signal class: parser `WARNING_PATTERNS`, `ErrorEntry.level?: 'error'|'warning'`, `warning-new` / `warning-recur` events, `?level=` filter, severity chips on the Errors page, tertiary-accent warning rows.
- `TrendChartComponent` skeleton regression fix: `loading`/`empty`/`title`/`subtitle` are signals (zoneless + OnPush).
- `scripts/dev-install.mjs` + `npm run dev:install` / `dev:install:fast` / `dev:unlink`.

### Added (M47) — Per-cwd command resolution

- `Registry.resolveByCwd(name, cwd?)`: returns `{ kind: 'unique'|'collision'|'none', key?, candidates }`. Discovery now uniquifies storage names on collision (`<base>@<workspaceLabel>`), keeping the user-facing `baseName` intact.
- Every per-app endpoint resolves `<name>` via `?cwd=`. **412 `name-collision`** body `{ error, candidates: [...], hint }` when two workspaces share the same app name and no cwd disambiguates.
- CLI `start/stop/restart/status/logs/errors/wait/run` all send `?cwd=<process.cwd()>` unless `--all` is set. New `reportCollisionAndExit` renders candidates by `workspaceLabel`.
- MCP tools `get_status`, `get_status_full`, `get_errors`, `get_logs`, `start_app`/`stop_app`/`restart_app` accept an optional `cwd` param (defaults to the MCP server's `process.cwd()`).

### Added (M48) — Workspace registry CLI + audit attribution

- `daimon workspaces list|add [path] [--label <name>] | rm <path> | show [path]`.
- `GET /api/workspaces`, `POST /api/workspaces/remove`, `GET /api/workspaces/resolve?cwd=<p>`.
- CLI sends `X-Daimon-Cwd: <process.cwd()>` on every authenticated POST.
- `appendAuditEntry` now records the cwd as the 5th column. Two agents sharing an IP can be told apart in `~/.daimon/audit.log`.

### Added (M49) — Dashboard cwd context

- Dashboard reads `?cwd=<path>` and pre-selects the workspace pill that covers it.
- Unknown-cwd banner offers a one-click **Register** that POSTs `/api/workspaces/ensure` and then re-resolves.
- New `daimon dashboard` verb opens the default browser to `http://127.0.0.1:4999/?cwd=<process.cwd()>`.
- Header **scope chip** (`scope: <label> ×`) gives a one-click clear back to "all workspaces". No regression when no `?cwd=` is present.

### Added (M50) — Lint findings channel

- Parser `LINT_PATTERNS` for eslint, biome, ruff, clippy. Lint runs **first** (before error/warning) so a tight `F401`/`lint/correctness/...` signal beats the generic `<file>:<line>:<col>:` error rule.
- `ErrorEntry.level` adds `'lint'`. `AppEventType` adds `lint-new` / `lint-recur`. **Status never flips on lint.**
- `?level=lint` filter on `/api/apps/:name/errors`. `AppSummary.lintCount`.
- Errors page severity chips become **errors / warnings / lint / all** with a secondary accent for lint rows. Lint events excluded from error trends.
- Fixtures: `lint-eslint.log`, `lint-biome.log`, `lint-ruff.log`, `lint-clippy.log`.
- **Daimon never spawns linters.** This is parse-only — read what the dev server already emits.

### Added (M51) — Unified event timeline

- `History.queryTimeline()`: merges events + compile_times + bundles + task_runs into `{ ts, app, kind, summary, payload }`. Sorted desc; 5000-row cap.
- `GET /api/history/timeline?since=&app=&kinds=<csv>`.
- New lazy-loaded `/timeline` dashboard route with virtual scroll, kind/app filters, flyout drawer. Nav-rail entry between History and Trends, keyboard chord `g i`.
- New CLI verb: `daimon timeline [--since 24h] [--app <name>] [--kinds status,error,…]`.

### Added (M52) — Polyglot v2 health probes

- `src/healthProfiles.ts` with per-profile probe defaults: django → `/admin/login/`, rails → `/up`, fastapi → `/docs`, go-air → `/`, rust-trunk → `/`.
- Probe resolution uses (in order): user override → prior auto-discovery → profile default → fallback `/`. The first probe cycle on a fresh Rails/FastAPI app now hits the right path instead of churning through `HEALTH_PROBE_CANDIDATES`.
- Smart probe outcome: 200, 301/302/304/307/308, and 401 (auth-gated but alive) classify healthy; 5xx and `ECONNREFUSED` / `ECONNRESET` / `EHOSTUNREACH` classify unhealthy.
- New doctor rule **`health-probe-missing`** with auto-fix: writes the profile-suggested `healthProbePath` into `overrides[<app>]` and triggers a soft-reload.

### Added (M53) — Polish + release prep

- Doctor `ALL_AUTO_FIX` now lists 12 rules (added `health-probe-missing`).
- `CHANGELOG.md` + `RELEASE-v0.9.0.md`. `package.json` 0.8.1 → 0.9.0.

### Migration notes

- **Multi-workspace is the migration headline.** Existing single-workspace setups keep working — `daimon list --all` reproduces the v0.8 default. Two agents in different workspaces sharing an app name now coexist; CLI commands run from a workspace cwd resolve automatically. Pass `--all` to see / act on apps across all workspaces.
- **Audit format change.** `~/.daimon/audit.log` gains a 5th tab-delimited column carrying the agent's cwd. Existing 4-column rows continue to parse — the cwd is empty for them.
- **Discovery storage keys.** When two workspaces have apps with the same `baseName`, the second is stored under `<baseName>@<workspaceLabel>`. Its `baseName` field stays as the user-facing name. `daimon list` shows the storage key in the `name` column; `workspaceLabel` distinguishes the rows.

## [0.8.1] — 2026-05-21

Hotfix for three regressions caught running v0.8.0 against a real workspace.

### Fixed

- **Dashboard Errors page no longer storms the daemon.** The errors-panel `effect()` was tied to the `api.apps()` signal, which emits a new array reference on every SSE tick even when membership is unchanged — causing N parallel `/api/apps/<name>/errors` fetches per emission (1,690 in-flight requests observed during the post-publish smoke test). Replaced with two narrower effects: one keyed on a membership `computed` (refetches only when the app set changes), and a push-driven effect that watches `api.events()` and only refetches when an `error-new` / `error-recur` / `status` event arrives on the existing SSE stream. The dashboard now consumes the event stream instead of polling it via HTTP.
- **Parser captures real-world Nx serve failures.** v0.7's M33 patterns required a leading `>` decoration (`^\s*>\s+NX\s+.*failed`) — the actual `nx run …:serve` output omits it. Loosened the regex to `^\s*(?:>\s+)?NX\s+.*failed`, added new patterns for `Failed tasks:` and `Task "…" is continuous but exited with code N`, and updated the nx tool-routing regex to recognize the same shapes. New fixture `test/fixtures/parsers/nx-serve-fail.{log,expected.json}` covers the workspace-realistic case where the failure signal lands without a structured `file/line/col`. Resolves the v0.8.0 status/errors disagreement where an app's status flipped to `error` (via process exit code) but the Errors tab said "No errors".
- **Nav-rail tooltip dismisses on click.** Material tooltip persisted on the just-clicked rail link because the link kept focus through the route change, leaving a stuck "g l" / "g e" floater after keyboard or mouse navigation. Added `matTooltipHideDelay="0"`, `matTooltipShowDelay="300"`, and an explicit `blur()` on click.

### Changed

- `parser-corpus.test.mjs` gains a branch for fixtures whose `expected.errors` is empty — it now asserts the failure signal lands (status flips, at least one error entry is recorded) but does not require a parsed file/line/col.

## [0.8.0] — 2026-05-20

Strategic theme: **Mature daimon.** v0.5–v0.7 added enormous surface; v0.8 turns inward to polish the surface and harden the internals — a big CLI polish, a reliability pass, self-observability, and a plug-in surface for doctor rules, plus a first-class Tests page that finally lands part of the v0.7.1 dashboard-test debt (H3 contrast audit deferred again to v0.8.1).

### Added (M45) — Tests dashboard + H1 carry-over

- **T1 — Structured `test`-target summaries.** `parseTaskSummary` (in `src/taskRunner.ts`) now recognizes seven runners: Jest, Vitest, Karma, Playwright, pytest, RSpec, `cargo test`, and `go test` (the last sums multi-package `ok|FAIL pkg D.DDDs` lines). Output shape is now `{ passed, failed, total, suites?, durationMs?, framework, failedTests? }`. `failedTests` captures `{ name, file, line }` from the per-runner failure formatting and is the source of the dashboard's failed-test jumper. `task_runs.summary` continues to be a JSON blob — the new fields are additive.
- **T2 — `Tests` dashboard route (`/tests`).** New lazy-loaded route. One expansion-panel per app with at least one `test`-named run in the last 30 days. Title row carries an OK / FAIL pill + `passed/total · N failed` label + framework + duration + "<N>m ago" + run count. Body shows a 30-row pass/fail trend ribbon (one tick per run) and, when the most-recent run failed, an inline list of failed tests.
- **T3 — Failed-test jumper.** Each failed-test row that carries a `{ file, line? }` payload renders a clickable `vscode://file/<path>:<line>` link, identical scheme to the M22 errors panel.
- **T4 — Nav + shortcut.** New `/tests` entry on the nav rail (`science` icon) and `g x` keyboard chord, alongside the existing `g t`/`g h`/etc. shortcuts.
- **H1 (carry-over — third schedule slot, partial).** Vitest harness shipped at `dashboard/vitest.config.ts`. Five specs in `dashboard/src/app/tests-page.spec.ts` cover the pure signal-bearing logic — `parseSummary`, `vscodeUri`, `summaryLabel`, `pillKindFor` — extracted into `tests-page-helpers.ts` to keep them runtime-independent. `dashboard/package.json` `test` script is now `vitest run` (no `ng test --watch=false` blocker). The deeper per-component render coverage requires an Angular-linker preset (e.g. `@analogjs/vitest-angular`) — that preset has been moved to v0.9 to keep M45 inside one weekend. Playwright smoke similarly deferred. See `PLAN-v0.8.md` Status section for the trade-off.
- **H3 — WCAG AA contrast audit.** Deferred to v0.8.1 per the locked descope path (`"If M45 grows, drop H3 first"`). M3 surface-tonal defaults from v0.7 still apply; the dedicated AA sweep across light + dark + reduced-motion remains a focused future pass.
- **Test surface.** New `test/task-summary.test.mjs` asserts the parser for jest / vitest / pytest / rspec / cargo / go / playwright / null. `dashboard/src/app/tests-page.spec.ts` exercises the five tests-page helpers under Vitest.

### Added (M44) — Plug-in surface for doctor rules

- **P1 — Plug-in loader.** New `src/plugins.ts`. On daemon start, daimon scans `~/.daimon/plugins/doctor-*.mjs` (configurable via `plugins.dir` in `daimon.config.json`). Each file is dynamically imported with a cache-busting query string so plug-ins can be hot-edited and reloaded by restarting the daemon. Files that fail to import (or fail shape validation) are logged as `[daimon] plug-in skipped: <file> — <reason>` and never crash the daemon.
- **P2 — Typed `DoctorPlugin` interface.** Defaults to a read-only `scan(ctx)`. Optional `fix(finding, ctx)` and `undo(finding, ctx)`. `DoctorContext` exposes `{ config, apps, history.querySelfMetrics, mutations }` — the `mutations` surface is intentionally narrow and re-uses the M36 mutation primitives (no shell-out, no package-manager calls, no edits to user source).
- **P3 — Permission gating is fully opt-in.** No plug-in's `fix` ever runs unless its `name` is in `doctor.autoFix.permitted` — the same gate built-in rules use. This applies uniformly to the bundled sample (`src/templates/plugins/example-doctor.mjs`) and to any user-authored plug-in. The loader does **not** track plug-in origin; there is no "bundled / trusted" branch. The loader also rejects names that collide with built-in rules or with another plug-in already loaded in the same pass.
- **P4 — `daimon plugin list|show <name>|validate <path>`.** New CLI subcommands. `list` returns installed plug-ins with `{name, description, file, status, error, findings}`. `show <name>` prints one plug-in's manifest + last-run findings. `validate <path>` sanity-checks a plug-in file *without* loading it into the running daemon (useful during development). New HTTP endpoints: `GET /api/plugins`, `POST /api/plugins/scan`.
- **P5 — Sample plug-in template.** `src/templates/plugins/example-doctor.mjs` ships in the tarball (~1.8 KB). Demonstrates a complete `scan` + `fix` cycle with the one-line opt-in instruction. Used as the on-ramp for the permission model — the comment block documents the exact `permitted: [..., 'example-doctor']` line a user must add to enable the `fix`.
- **P6 — Dashboard surfacing.** Doctor page gains a "Custom rules" section. One card per plug-in with a status chip (`ok` / `failed`), description, file path, error detail (when failed), and per-finding rows with severity chips. Errors surface in the card header. Reuses existing M3 token styling — no new tokens.
- **P7 — Skill text update.** `~/.claude/skills/daimon/SKILL.md` now lists `daimon plugin list|show|validate`, `daimon self`, `daimon doctor --self`, and `daimon completion` so agents can document a workspace's plug-in surface when asked.
- **Decisions locked in.** Plug-in surface in v0.8 is **doctor-only** — parser-hint and event-hook plug-ins are deferred to v0.9+ until real-world plug-ins inform the right shape.
- **Test surface.** New `test/plugins.test.mjs` asserts (1) only `doctor-*.mjs` files are picked up, (2) malformed plug-ins are reported as failed without crashing the loader, (3) names that collide with built-ins are rejected, (4) `runPluginScans` populates `lastFindings` and survives a throwing scan by quarantining the plug-in, and (5) `validatePluginFile` works standalone.

### Added (M43) — Self-observability

- **O1 — `GET /api/self`.** New endpoint returning daimon's own metrics: `{ pid, version, uptimeMs, rssMB, heapUsedMB, heapTotalMB, eventLoopLagMs, eventLoopLagP95Ms, historyDbQueryMs:{p50,p95,p99}, lockContentionCount, tickIntervalMs, lastTickAt }`. Backed by a new `SelfMetricsCollector` (in `src/selfMetrics.ts`) that probes event-loop lag with a 1s `setInterval` delta and rolls a 60-sample sliding window. `lockContentionCount` and the `historyDbQueryMs` percentiles are wired through call-site instrumentation (additive).
- **O2 — `daimon doctor --self`.** New `--self` flag on `daimon doctor` runs self-checks: heap above 256 MB, event-loop lag p95 above 100 ms, history-db query p95 above 50 ms. Reports findings in the same `{ok, checks, metrics}` shape as the existing F58 doctor rules. Read-only by design (no auto-fix — self issues require a daemon restart or config tuning).
- **O3 — `self_metrics` table in history.db.** New `self_metrics(id, ts, rssMB, heapUsedMB, eventLoopLagMs, historyQueryP95Ms)` table created by the existing `CREATE TABLE IF NOT EXISTS` migration — v0.7 databases upgrade in place. The daemon persists one row per minute via the new `History.recordSelfMetric`. Retention follows the existing `history.retentionDays` policy. `daimon snapshot <name>` carries the last 60 rows as `payload.selfMetrics` for diagnostic context.
- **O4 — Self chart on the Trends dashboard route.** New "Apps / Self" toggle on `/trends`. When **Self** is selected, an additional `dm-trend-chart` card renders rssMB / heapUsedMB / eventLoopLagMs as line series from `/api/self/history`. Reuses the existing chart.js lazy chunk — initial-route gzip stays at **126.46 KB** (v0.7 baseline 126.45 KB, ceiling 130 KB).
- **O5 — Self-warn events.** When the event-loop lag exceeds 100 ms for ≥5 consecutive ticks, `SelfMetricsCollector` emits a synthetic `{ app:'__daemon__', type:'self-warn', message:'event loop lag sustained: <N>ms (<K> consecutive ticks)' }` event. Surfaces on the existing Events feed alongside per-app events. New `'self-warn'` value in `AppEventType`; the loader only re-fires on rising-edge transitions to avoid flooding.
- **Test surface.** New `test/self-metrics.test.mjs` asserts (1) `snapshot()` returns plausible pid/version/rss/heap/uptime/lag numbers, (2) `recordQueryMs` correctly feeds the p50/p95/p99 percentile estimates, and (3) the self-warn setter is wired without throwing.

### Added (M42) — Reliability pass

- **F1 — Parser fuzz tests.** New `test/parser-fuzz.test.mjs` feeds 2,000 deterministically-random mixed-ANSI / multibyte / lone-surrogate / multiline-fragment lines into `parseLine`. Asserts no exceptions, no >10ms slow tail above 2% of iterations, and total time <10s per run. Two regression cases cover empty / whitespace / ANSI-only input and lone surrogate halves.
- **F2 — History.db stress test.** New `test/history-stress.test.mjs` inserts 100,000 events + 50,000 compile rows + 10,000 bundle rows into a temp sqlite (flushing in 5k-row batches via a new `History._flushForTest()` escape hatch), then queries `/api/history/trends` for every (metric × window × app) combination across three passes. Asserts trends p95 <50ms, p99 <200ms, db size <50MB.
- **F4 — Lock-file contention.** New `test/lock-contention.test.mjs` isolates `~/.daimon` via temp `HOME`/`USERPROFILE`, then asserts (1) `readLock` tolerates missing/corrupt files, (2) it prunes stale locks pointing at dead PIDs, and (3) parallel `writeLock` calls leave exactly one parseable JSON lock — atomic rename never produces a partial payload.
- **F5 — Error-map TTL.** New optional `errorRetention.maxAgeMs` config (default `86400000` — 24h) prunes `AppState.errors` entries older than `maxAgeMs` and not seen since. A new `Registry.pruneOldErrors()` walks every app's error map; the daemon wires it on an hourly tick in `main.ts`. Prevents unbounded growth in long-running daemons.
- **F6 — Log buffer cap audit.** New regression in `test/reliability.test.mjs` exercises the per-app `logBuffer` with a 10,000-line burst and asserts the rolling window stays at `LOG_BUFFER_MAX` and contains exactly the latest 500 lines.
- **F3 — Daemon crash auto-recovery soak (manual).** Documented in `test/SOAK.md` — 30-iteration kill-and-respawn loop with assertions on orphan PIDs and stale-lock pruning. Not run in CI (would dominate suite budget).
- **F7 — Memory soak (manual).** Documented in `test/SOAK.md` — 24h procedure with 5 simulated apps, capturing baseline RSS via `daimon self` and the new M43 `self_metrics` table. Acceptance: <10% RSS growth over 24h.

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
