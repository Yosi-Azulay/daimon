# daimon v0.14 — "Runway"

6 milestones (M87–M92) · the release before 1.0. Ships as **v0.14.0**; **v1.0.0 is NOT tagged here** — it is a near-empty follow-up tag after a real-usage soak period, once the freeze has survived daily use.

## Theme

This is the last release where breaking anything is cheap. Every hour spent here is one we don't spend maintaining a frozen wart for years. So v0.14 inverts the usual shape: **no new feature surfaces**. It inventories, repairs, labels, and hardens the ones that exist — a stability contract with per-surface tiers, daemon lifecycle edges v0.13 didn't cover, a WCAG AA pass the dashboard has never had, and a first-15-minutes experience written for strangers instead of us.

## Decisions locked in

- **v0.14.0 only.** The v1.0.0 tag happens later, by the human, after soak. Nothing in this plan says "1.0" in shipped artifacts except STABILITY.md's forward-looking promise.
- **Stability tiers on every surface.** Each CLI verb (and its JSON shape), HTTP endpoint, config key, MCP tool, and event kind gets an explicit tier: `frozen` (shape never breaks; additive only), `stable` (breaks only with a major version + migration note), `experimental` (may change in any release). Young v0.13 surfaces (report section shapes, `env diff` output, `ports` output, `notifications` config) stay **experimental** — do not freeze them.
- **Last-call breaking fixes are allowed in M87 only**, each with a consumer-facing justification (not aesthetics) and a migration note. This is the last breaking-changes section a daimon release will ever have. **Config back-compat is NOT breakable** — v0.1 configs must still load unchanged; warts fixable are CLI/HTTP output shapes and flag names only.
- **One new devDependency, sanctioned:** `@axe-core/playwright` (test-only — the only practical automated-a11y gate; wraps axe-core script injection). Installing it is the single permitted `npm install` of the release; no other lockfile changes.
- **No new config keys.** A runway release adds nothing that must then be frozen.
- **Standing:** loopback only, no remote/multi-user/cloud sync, PolyForm Noncommercial 1.0.0, never edit user code or `.env` files, state confined to `~/.daimon/*` + `daimon.config.json`, human runs npm publish with 2FA, no push to origin without confirmation.
- **Public author:** `Yosi Azulay (https://flycotech.com)`. `yosi@flycotech.com` NEVER in published artifacts — SECURITY.md's report channel is GitHub issues / https://flycotech.com.

---

## M87 · Surface inventory, stability tiers, last-call wart review

Everything else in the release describes these surfaces — their final shape must land first.

- **Inventory:** extend `cliSurface.ts` entries (and parallel catalogs for HTTP endpoints, MCP tools, config keys, event kinds — put them where each surface's single source of truth already lives) with a `stability` field. `npm run build:docs` renders the tier next to every verb/endpoint/tool/key.
- **Tier assignment (starting point — adjust with justification):** frozen = core lifecycle (`list/start/stop/restart/status/wait/logs/errors/daemon/config` shapes, core config keys, core MCP tools); stable = v0.11–v0.12 surfaces (`test`, `search`, `why`, `context`, frameworks registry fields); experimental = v0.13 surfaces (report, env, ports, notifications, digest).
- **Last-call wart review:** sweep every surface for naming inconsistencies, shape warts, wrong defaults. Fix only with a consumer-facing justification + migration note; anything not worth breaking gets labeled experimental or documented as-is. Collect every fix into RELEASE-v0.14.0.md "Breaking changes (the last)".
- **Golden-shape contract tests:** `test/contract.test.mjs` (parameterized) snapshots the JSON shape (key sets + types, not values) of every `frozen` surface — CLI stdout shapes, HTTP response shapes, MCP tool results. A shape change on a frozen surface fails the suite forever after. Missing snapshot for a frozen surface also fails (fixture-gating convention).
- **STABILITY.md:** defines the three tiers, the promise each makes, the additive-only rule for frozen surfaces, and where to read a surface's tier.

Acceptance: docs show a tier for every surface; contract suite fails when a frozen CLI shape is mutated in a scratch build and passes on HEAD; every last-call fix has a migration note; a frozen surface without a snapshot fails the suite.

---

## M88 · Lifecycle hardening

The daemon edges v0.13 didn't cover. Strongest-model territory.

- **Version skew:** every CLI call already hits the daemon — compare CLI version against `/api/signature` version; on mismatch, append a one-line warning to stderr with the exact remedy (`daimon daemon restart` performs the handoff). Never hard-fail on skew alone.
- **Atomic state:** all `state.json` writes become write-tmp + rename, keeping a `.bak` of the last good version. On parse failure at startup: recover from `.bak`; if that also fails, archive as `state.json.corrupt-<ts>` and start fresh (mirror history.db's existing behavior). Same treatment for any other `~/.daimon/*.json` the daemon rewrites.
- **Handoff with running apps:** define and test the contract — managed children survive `daimon daemon restart`; the new daemon re-adopts them (pid liveness + announced port verified). A child that can't be verified is reported with status `orphaned` and a remedy, never silently dropped or blindly killed (verify-then-kill discipline from M81 applies).
- **Crash-recovery ordering:** on startup after an unclean exit, the sequence is: recover state → verify locks (stale locks from a dead pid are cleared) → re-adopt or mark orphans → then serve. Document the order in a comment where it lives; test it.
- **Torture suite:** `test/lifecycle-torture.test.mjs` — kill the daemon mid-write, corrupt `state.json` (truncate + garbage), double-start, restart under load with fixture apps running, skewed-version probe. All against `DAIMON_HOME` isolation, never the real state dir.

Acceptance: corrupted state.json recovers from .bak; truncated .bak archives + fresh start with a self-warn event; restart with a running fixture app re-adopts it (same pid) and `daimon list` shows it healthy; unverifiable child surfaces as orphaned with remedy; skew warning appears with mismatched dist versions and disappears after restart.

---

## M89 · WCAG AA dashboard audit

Eight versions of UI, zero accessibility passes. Runs parallel to M88 (disjoint code).

- **Keyboard-only pass** on every route: logical focus order, no traps, Escape closes palette/modals/drawers, visible focus indicators, a skip-to-content link.
- **Contrast at the token layer** — fix `--dm-*` tokens, not per-component overrides, so both themes inherit the fix.
- **ARIA:** labels on icon-only buttons, landmarks (nav/main), `aria-live` region for toast/status updates, table headers associated, chart alt summaries.
- **`prefers-reduced-motion`:** all animation/transition honors it.
- **Automated gate:** `@axe-core/playwright` checks added to the existing Playwright drive, both viewports (1280 + 390px), every route. Gate = **zero serious/critical violations**. Moderate/minor get fixed or individually waived with a comment explaining why.

Acceptance: axe green (no serious/critical) on all routes at both viewports; full keyboard round-trip on the busiest page (apps list → detail → action → back) documented in the Playwright spec; contrast tokens pass AA for text; reduced-motion verified.

---

## M90 · First-15-minutes + error-message sweep

Every doc so far was written for us. 1.0 users won't file good bug reports.

- **Error-string audit:** inventory every user-facing error (CLI stderr JSON, daemon fatal output, doctor findings, dashboard toasts). Rule: each must say *what to do next* — v0.13's EADDRINUSE forensics is the model. Fix the ones that just state facts.
- **README stranger rewrite:** assume no context; verify every claim and command against the shipped build (truthfulness pass); "when it breaks" section pointing at `daimon doctor`.
- **SECURITY.md:** the posture in writing — loopback-only binding, no telemetry/analytics ever, env-value redaction (values die in the same tick), plugin trust model (opt-in, unsandboxed, user-placed only), state confinement, report channel (GitHub issues / flycotech.com — never the personal email).
- **Doctor as the support path:** confirm every failure class from v0.11–v0.13 has either a doctor rule or a documented reason it can't (table in M91's coverage review feeds this).

Acceptance: grep-style test that no error string ends without a remedy on the audited list; README commands execute as written on a clean `DAIMON_HOME`; SECURITY.md present and linked from README; doctor referenced as the first support step.

---

## M91 · Debt wave (carried punch-list + freeze enforcement)

Parallelizable, cheap-model territory.

- **`AttachApp.tsx` `daimonDir()` fix** — currently bypasses it, ignoring `DAIMON_HOME`.
- **`parser.ts` binary-to-grep byte fix** (carried from the toolkit bootstrap punch-list).
- **Contention-flaky perf tests** (`history-stress` p50/p95, `ports` forensics timing): restructure to be contention-immune — self-calibrating baseline or isolated-run detection — never just loosen the budget.
- **`daimon config validate`:** validates `daimon.config.json` against the (about-to-freeze) schema; unknown keys warn with the nearest valid name; exit 0 warnings / 1 errors. Load-time unknown-key warnings too (warn, never fail — old configs stay loadable).
- **npm package audit:** `files` whitelist review, inspect the tarball (`npm pack --dry-run`), grep for the personal email, confirm LICENSE/README/docs included and fixtures/tests excluded.
- **Doctor coverage table:** `docs`-rendered table mapping v0.11–v0.13 failure classes → doctor rule or documented gap.

Acceptance: `DAIMON_HOME` honored end-to-end in the dashboard attach flow; both perf tests green 5/5 while `npm test` runs alongside a parallel build; `config validate` catches a typo'd key with a suggestion; tarball contains no personal email and no test fixtures.

---

## M92 · Polish & ship

- **README** final pass; **docs regen** (tier badges, `config validate`, doctor coverage table).
- **CHANGELOG `[0.14.0]`**; **package.json** 0.13.x → 0.14.0 (+ extension bump).
- **RELEASE-v0.14.0.md:** Migration + **"Breaking changes (the last)"** listing every M87 last-call fix with before/after shapes; note the v1.0.0 soak plan.
- **CLAUDE.md:** stability-tier convention (new surfaces must declare a tier; frozen needs a snapshot), atomic-state rule, torture-suite pointer.
- **MCP:** no new tools; contract tests confirm existing tool shapes match their declared tiers.
- **Playwright drive:** axe gate + keyboard spec + both viewports.
- **Gates:** tsc clean (3 projects); `npm test` ≥560 (from 529) under 35s quiet-machine; perf bench green; bundle < 150KB gzip; doctor clean; redaction suite green; contract suite green; axe zero serious/critical.

Acceptance: all gates green. Stop at "ready to publish"; report test count, bundle size, tarball delta, the full breaking-changes list, and tier counts (N frozen / N stable / N experimental). Tag **v0.14.0** here. **Do NOT tag v1.0.0.** Human publishes (npm/git/vsce).

---

## Out of scope for v0.14 (deferred or never)

- **Tagging v1.0.0** — after soak, by the human, as a near-empty release.
- New feature surfaces, new config keys — runway means nothing new to freeze.
- Docs site / landing page — repo-level polish only this round (user decision).
- Telemetry/analytics of any kind — never; SECURITY.md says so in writing.
- Auto-update mechanism — human publishes, human updates.
- Renames for taste alone — last-call fixes need a consumer-facing justification.
- Shell-completion regen, report print stylesheet, bundle-size deep pass, screencast GIF script → v0.14.x stretch (Tier 3).
- Remote/non-loopback, multi-user/auth, cloud sync, general process manager, loaded-code plugins, cron engine — standing NOs.

## Sequencing notes

- **M87 strictly first** — its last-call fixes change shapes that M90's docs, M87's own contract tests, and the README then describe. Nothing downstream starts until the wart review is decided.
- **M88 + M89 in parallel** — disjoint code (daemon core vs dashboard); ideal for the delegation split.
- **M90 + M91 continuous** after M87 settles shapes.
- **M92 last.**
- **Delegation guidance:** M87 wart review + contract tests and M88 lifecycle → strongest model, high effort (correctness-critical; a wrong freeze is permanent). M89 ARIA/contrast mechanical fixes, M90 doc rewrites, M91 items → cheap/fast subagents, but the a11y *audit* judgment and the error-string *rule* judgment stay with a capable model. Main agent owns every gate; merge subagent work only after its tests pass.
- **Descope order:** Tier-3 stretch, then M91 items individually, then M90's dashboard-toast audit — **never M87, M88, or M89's axe gate.**

Rough order: M87 → M88 + M89 in parallel → M90 + M91 continuous → M92.
