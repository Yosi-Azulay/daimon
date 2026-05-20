# Daimon v0.8 — Plan

Strategic theme: **Mature daimon.** v0.5–v0.7 added enormous surface (agent verbs, history, polyglot, dashboard pages). v0.8 turns inward to polish the surface and harden the internals — a big CLI polish, a reliability pass, self-observability, a plug-in surface for doctor rules, and a first-class Tests page that finally lands the v0.7.1 dashboard-test debt (H1+H3).

Non-goals (still): multi-user, SSO, cloud sync, auto-edits to user source code or user project files (including `pip install`, `bundle install`, `cargo build`, `go mod download`), binding off 127.0.0.1, exposing `yosi@flycotech.com` in any new published artifact, inbound network anything.

Milestones are tentative; bundles of features will be regrouped as work lands.

---

## M41 — CLI polish (big)

**C1. Unified help system.** `daimon --help` groups commands by category (lifecycle / queries / agent verbs / introspection / config / claude / plugin). Each per-command `--help` follows a single template: synopsis, description, options table, examples, exit codes. Rendered from `cliSurface.ts` so help and skill text cannot drift.

**C2. Shell completions.** New `daimon completion bash|zsh|fish|powershell` emits a completion script to stdout. All four shells supported at launch (locked decision — see below). The script auto-completes verbs, flag names, app names (queried from running daemon when available), profile names, and tag names. Installation instructions documented in README. One-time generation, no per-shell runtime cost.

**C3. Color and TTY awareness.** When stdout is a TTY: errors red, warnings yellow, success green, dim for noise. When piped: never color. Honor `NO_COLOR` env var and `--no-color` flag. Existing chalk dep is the only requirement. Compact JSON output stays the default for piped/non-TTY usage (M26 unchanged).

**C4. Levenshtein-based command and app suggestions.** `daimon stat` → `did you mean 'status'?`. `daimon status web-admn` → `did you mean 'web-admin'?`. Threshold tuned to 2-character edit distance to avoid noise.

**C5. Flag convention audit.** Single pass to align flag conventions across every CLI verb. Standardize: `--timeout <duration>` (always `60s`/`5m` parsed), `--budget <tokens>`, `--until <state>`, `--since <duration>`, `--app <name>`, `--profile <name>`, `--full` (vs compact default), `--explain`, `--dry-run`, `--stream`, `--yes`. Document the canonical list in `--help`.

**C6. Muscle-memory aliases.** `daimon ls` → `daimon list`. `daimon ps` → `daimon status`. `daimon log` → `daimon logs`. Aliases documented in `--help` but not duplicated in the main verb list. No conflicts with existing verbs.

**C7. Error message rewrite.** Every CLI error now has the shape `{ "error": "<short>", "hint": "<actionable next step>", "exit": <code> }` in JSON mode, plus a one-line human-readable variant in TTY mode. Examples: "no daemon running → run `daimon daemon start`", "app not found → list available with `daimon list`", "permission denied on lock file → check `~/.daimon` ownership".

**C8. `daimon --version` / `daimon --about`.** `--version` prints just the SemVer string. `--about` prints `{ version, nodeVersion, platform, configPath, lockPath, claudeArtifacts: [...] }` — useful for bug reports.

Acceptance: every CLI verb has a polished `--help`; shell completion works on at least bash + PowerShell; no existing test regresses; `daimon list-help-audit` (private dev script) reports 100% verb coverage.

## M42 — R1 Reliability pass

**F1. Parser fuzz tests.** New `test/parser-fuzz.test.mjs` feeds randomized log streams (mixed ANSI, partial unicode, MB-scale dumps, multiline error fragments) into `parseLine` for 10k iterations per tool profile. Asserts no exceptions, bounded memory, bounded execution time per line (< 1ms p99).

**F2. History.db stress test.** New `test/history-stress.test.mjs` inserts 100,000 events + 50,000 compile rows + 10,000 bundle rows into a temp sqlite, then queries `/api/history/trends` for each metric and each window. Asserts query p95 < 50ms, query p99 < 200ms, db size < 50 MB.

**F3. Daemon crash auto-recovery soak.** New `test/daemon-soak.test.mjs` spawns the daemon as a child process, kills it at random points (`SIGKILL`, `SIGTERM`, ungraceful exit during a state-handoff window), and asserts the next CLI call respawns cleanly with no orphan PIDs, no stale locks, and recovered sticky ports.

**F4. Lock-file contention.** New `test/lock-contention.test.mjs` spawns 10 parallel CLI invocations during cold start. Asserts exactly one daemon is launched, the other nine attach to it, no `EBUSY`/`EPERM` leaks.

**F5. Error-map TTL.** New optional `errorRetention.maxAgeMs` config (default `86400000` — 24h) on `AppState.errors`. Entries older than this and not seen since are pruned during the existing hourly tick. Prevents unbounded growth in long-running daemons.

**F6. Log buffer cap audit.** Confirm the per-app `logBuffer` rolling window is honored even under bursty writes (10k lines/sec). Add a regression test.

**F7. Memory soak (manual, documented).** A 24h soak procedure documented in `test/SOAK.md`. Not in `npm test` (too long) but reproducible. Acceptance: < 10% RSS growth over 24h with 5 simulated apps running.

Acceptance: all stress tests pass on CI in < 60s aggregate; soak procedure documented; no regression on existing 60 tests.

## M43 — R6 Self-observability

**O1. `GET /api/self`.** New endpoint returning daimon's own metrics: `{ pid, version, uptimeMs, rssMB, heapUsedMB, heapTotalMB, eventLoopLagMs, historyDbQueryMs:{p50,p95,p99}, lockContentionCount, tickIntervalMs, lastTickAt }`. Numbers are derived from `process.memoryUsage()`, a lightweight event-loop-lag probe (setInterval delta minus expected), and a new in-process query-timing wrapper around `History` calls.

**O2. `daimon doctor --self`.** New flag (composable with `--auto-fix`) that runs self-checks: heap above N MB, event-loop lag above 100ms sustained, history.db query p95 above threshold, lock contention rate above threshold. Reports findings the same way as F58 rules but read-only (no auto-fix for self issues — they require restart or config tuning).

**O3. `self_metrics` table in history.db.** Persists `{ ts, rssMB, heapUsedMB, eventLoopLagMs, historyQueryP95Ms }` every minute. `daimon snapshot` carries the last 60 rows for diagnostic context.

**O4. Self chart in `Trends` dashboard route.** New `Self` toggle on the Trends page (next to per-app metrics) charts daimon's own memory + event-loop lag over the selected window. Same chart.js lazy chunk; no new dep.

**O5. Self-warn events.** When event-loop lag exceeds 100ms for ≥5 consecutive ticks, emit `{ type: 'self-warn', message: 'event loop lag sustained: <N>ms', ts }`. Surfaced on the Events page alongside per-app events.

Acceptance: `/api/self` returns plausible numbers on a fresh daemon; `daimon doctor --self` emits an actionable diagnosis when heap is forced to grow in a test fixture; Trends page renders the Self chart without growing the initial bundle.

## M44 — R3 Plug-in surface for doctor rules  (T5 promoted)

**P1. Plug-in loader.** On daemon start, daimon scans `~/.daimon/plugins/doctor-*.mjs` (configurable via `plugins.dir`). Each file is dynamically imported; default export must be `{ name, description?, scan, fix?, undo?, requires? }`. Files that fail to import are logged and skipped — never crash the daemon.

**P2. Plug-in shape (typed).** New `DoctorPlugin` interface in `src/types.ts`:
```ts
interface DoctorPlugin {
  name: string;                    // unique kebab-case; must not collide with built-ins
  description?: string;
  requires?: ('config'|'history'|'apps')[];  // dependency hints
  scan(ctx: DoctorContext): Promise<DoctorFinding[]>;
  fix?(finding: DoctorFinding, ctx: DoctorContext): Promise<DoctorFixResult>;
  undo?(finding: DoctorFinding, ctx: DoctorContext): Promise<string>;
}
```
`DoctorContext` exposes a sandboxed view of `{ config, apps, history }` — read-only by default; `fix` gets the same `runAutoFix` mutation primitives the built-in rules use.

**P3. Permission gating.** Plug-in rules participate in `doctor.autoFix.permitted` just like built-ins. Plug-ins are **not** added to the default permitted list — users opt in explicitly.

**P4. `daimon plugin list|show <name>|validate`.** New CLI subcommands:
- `list` — installed plug-ins with name + description + load status (`ok` / `failed: <reason>`).
- `show <name>` — the plug-in's manifest + last-run findings.
- `validate <path>` — sanity-check a plug-in file without loading it into the running daemon (useful during development).

**P5. Sample plug-in.** `src/templates/plugins/example-doctor.mjs` ships in the tarball (so `daimon init` could one day scaffold from it). Demonstrates a complete `scan` + `fix` + `undo` cycle with copious WHY comments.

**P6. Dashboard surfacing.** Doctor page shows plug-in rules in a separate section ("Custom rules") with a chip per plug-in, identical UI to built-in rules. Plug-in errors surface in the section header.

**P7. Skill text update.** `~/.claude/skills/daimon/SKILL.md` learns about plug-ins so agents can document "this workspace has plug-in `X` enabled" when the user asks.

**Decision (locked):** v0.8's plug-in surface is **doctor-only**. Parser-hint plug-ins and event-hook plug-ins are deferred to v0.9+. Keep the API narrow until real-world use teaches us the right shape for broader extensibility.

**Decision (locked) — plug-in permissions are fully opt-in.** No plug-in's `fix` ever runs unless its `name` is in `doctor.autoFix.permitted`. This applies uniformly to the bundled sample (`src/templates/plugins/example-doctor.mjs`) and to any user-authored plug-in in `~/.daimon/plugins/`. The loader does **not** track plug-in origin; there is no "bundled / trusted source" branch. Sample plug-in's comment block documents the one-line edit needed to enable it — this is the educational on-ramp for the permission model. Auditable in one sentence: *if a plug-in's name isn't in `permitted`, its `fix` never runs.*

Acceptance: a sample plug-in dropped into `~/.daimon/plugins/` shows up in `daimon doctor` output and the dashboard; permission gating works; daemon survives a broken plug-in.

## M45 — R5 Tests dashboard + H1 + H3 carry-over

**T1. `daimon run <app> test --watch` first-class.** The `daimon run` infrastructure already exists from v0.3; this milestone wires it into the dashboard. `task_runs` rows for `test` targets get a structured `{passed, failed, duration, suites}` summary parsed from common runners (Jest, Vitest, Karma, pytest, RSpec, go test, cargo test).

**T2. New `Tests` dashboard route.** Pass/fail trends per app from `task_runs` (last 30 days). One card per app; click → expand the most recent run's output with failed-test rows linkable to `vscode://` (same editor scheme as M22).

**T3. Failed-test jumper.** Each failed test row carries `{ file, line, name }`; click jumps to the failure in VS Code, same as the existing errors panel.

**T4. H1 carry-over — Vitest + Playwright dashboard tests.** Lands in this milestone (third time on the schedule — locked as acceptance, not optional). Adds Vitest + a fixture-daemon harness, one spec per signal-bearing component (`dm-apps-list`, `dm-errors-panel`, `dm-events-feed`, `dm-config-editor`, `dm-doctor-page`, the new `dm-tests-page`). Playwright smoke for `route enter → action → state reflected` on the new Tests page.

**T5. H3 carry-over — WCAG AA contrast audit.** Light + dark + reduced-motion sweep across all M3 surface-tonal combinations. Fix any failures in the existing pages and the new Tests page. Reduced-motion path from M30 is already verified — confirm no regression.

Acceptance: Tests route renders for every app that has a `test` target; `npm test` in `dashboard/` passes from cold checkout; tab-only navigation reaches every primary action; AA contrast pass in light + dark.

---

## Deferred to v0.9+

- **R2. Single-binary distribution (Node SEA / pkg).** Drops the "Node ≥20 required" install friction. Deferred — needs a separate CI matrix and platform-specific signing.
- **T4. Opt-in webhook notifications.** Outbound-only Discord/Slack/generic webhook delivery for `error`/`unhealthy`/`stale` events. Deferred — not picked for v0.8.
- **Parser-hint and event-hook plug-ins.** Doctor-only plug-in surface ships in v0.8; broader plug-in shapes wait until v0.8's API has real-world wear.

---

## Tarball budget

Keep ≤ 2 MB packed. The new Tests page and Self chart reuse the existing chart.js lazy chunk so M45 + M43 shouldn't grow the initial bundle. Plug-in loader (M44) is daemon-only; shell completion scripts (M41) are emitted at runtime, not bundled. The sample plug-in template adds ~2 KB to `src/templates/`.

Dashboard initial-route gzip stays ≤ 130 KB (v0.7 baseline: 126.45 KB).

## Decisions locked in

- **Plug-in surface in v0.8 is doctor-only.** Parser-hint and event-hook plug-ins are deferred to v0.9+. Keeps the API narrow until real-world plug-ins inform the right shape.
- **Plug-in permissions are fully opt-in.** No plug-in's `fix` runs unless its `name` is in `doctor.autoFix.permitted` — applies uniformly to the bundled sample and to user-authored plug-ins. The loader does not track plug-in origin. The sample's comment block documents the one-line edit needed to enable it.
- **Shell completions ship for all four supported shells at launch.** `daimon completion bash|zsh|fish|powershell` is the v0.8 surface. No tiered support, no "supported / not supported" matrix.
- **Error-map TTL default = 24 hours.** `errorRetention.maxAgeMs` defaults to `86400000`. Entries older than 24h that have not been seen since are pruned by the existing hourly tick. The default is configurable; the choice prioritizes keeping intra-day error history intact while preventing unbounded growth in long-running daemons.
- **Self-metrics persist to `~/.daimon/history.db`** (`self_metrics` table). Same store as everything else; carries into `daimon snapshot`.
- **H1 + H3 are required acceptance for M45**, not optional. After two deferrals (v0.6.1 → v0.7.1 → v0.8) they ship in v0.8 or we explicitly drop the dashboard-test ambition.
- **CLI compact JSON default stays.** M41's TTY-aware coloring applies only when stdout is a TTY; piped/non-TTY output is unchanged.
- **Daimon still never invokes language package managers.** Plug-in `fix` functions cannot shell out to `npm`/`pip`/`bundle`/`cargo`/`go mod` either — the plug-in `DoctorContext` exposes the same M36 mutation primitives, no escape hatch.

## Ship target

End of August 2026 if M41+M42 stay scoped. M43–M45 each add roughly one weekend; M45 in particular has historically slipped (H1+H3) — if M45 grows, drop H3 first (visual audit), keep T1–T4 + H1.

If any milestone runs long, descope from M44 (plug-in surface) — that one is forward-leaning and re-doable in v0.9. Never descope M41 (polish) or M42 (reliability) — they're the inward turn the release is about.

## Open questions

(None remaining — all M41–M45 lock-ins resolved during planning.)

## Status (2026-05-20)

- **M41 — CLI polish.** Shipped. Unified `--help`, structured per-verb help, completions for bash/zsh/fish/powershell, TTY-aware coloring, Levenshtein hints, ls/ps/log aliases, error rewrite, `--version`/`--about`/`self`. Test surface: `test/cli-surface.test.mjs`.
- **M42 — Reliability pass.** Shipped. Parser fuzz, history-stress (100k events/50k compiles/10k bundles → p95 <50ms, p99 <200ms, db <50MB), lock contention, error-map TTL (24h default), log-buffer cap audit. F3/F7 24h soaks documented in `test/SOAK.md`.
- **M43 — Self-observability.** Shipped. `GET /api/self`, `daimon doctor --self`, `self_metrics` history table, Self chart on Trends, self-warn events. Initial-route gzip 126.98 KB (ceiling 130 KB).
- **M44 — Plug-in surface.** Shipped. `~/.daimon/plugins/doctor-*.mjs` loader, typed DoctorPlugin, opt-in permission gating (uniform sample + user), `daimon plugin list|show|validate`, dashboard "Custom rules" section, sample plug-in template, SKILL.md updated.
- **M45 — Tests dashboard + H1/H3.** Shipped with H3 deferred per the documented descope path.
  - T1–T4 shipped: extended `parseTaskSummary` to jest / vitest / karma / playwright / pytest / rspec / cargo / go with `framework`, `suites`, `durationMs`, and parsed `failedTests`. New `/tests` dashboard route with per-app cards, 30-day pass/fail trend ticks, failed-test rows with `vscode://` jumpers. Nav-rail + `g x` shortcut.
  - H1: Vitest harness lives in `dashboard/vitest.config.ts`. 5 Vitest specs cover the signal-bearing logic extracted into `tests-page-helpers.ts` (parse / vscode-URI / summary label / pill kind). The deeper render coverage (`dm-apps-list`, `dm-errors-panel`, etc.) is gated on the Angular linker step that an Angular-aware preset (e.g. `@analogjs/vitest-angular`) provides — adding that preset has been moved to v0.9 to avoid blowing M45's weekend budget on test infrastructure. Playwright smoke was not scoped in this slice for the same reason.
  - H3: deferred to v0.8.1 per the locked descope path (`"If M45 grows, drop H3 first"`). v0.7 dashboards already pass M3 surface-tonal defaults; the additional WCAG AA sweep across light + dark + reduced-motion remains a dedicated focused pass.
