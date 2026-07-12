Ship daimon v0.14.0 — "Runway": the release before 1.0. No new feature surfaces — inventory, repair, label, harden what exists. 6 milestones M87–M92. PLAN-v0.14.md is the contract — read it first; if wrong or ambiguous on a point, stop and ask before improvising.

Delegation: you may spawn subagents and choose each one's model + reasoning effort — cheap/fast (Haiku, low effort) for mechanical work (ARIA/contrast fixes, doc rewrites, M91); strongest model + high effort for M87 (a wrong freeze is permanent), M88 lifecycle, and final review. You remain accountable for all gates; merge subagent output only after its tests pass.

Constraints: loopback 127.0.0.1 only; no remote/multi-user/cloud; never edit user code or .env files; state confined to ~/.daimon/*; PolyForm Noncommercial; author `Yosi Azulay (https://flycotech.com)`; yosi@flycotech.com NEVER in artifacts (SECURITY.md contact = GitHub issues / flycotech.com); human publishes; ONE sanctioned install: `npm i -D @axe-core/playwright` (test-only), no other lockfile changes; no new config keys; surgical additions; Windows-first (path.join, tree-kill, never 0.0.0.0).

Locked: ships as v0.14.0 — do NOT tag v1.0.0 (later human follow-up after soak); every surface (CLI verb+shape, HTTP endpoint, config key, MCP tool, event kind) gets a tier frozen/stable/experimental rendered in docs; v0.13 surfaces (report/env/ports/notifications) stay experimental; last-call breaking fixes in M87 ONLY, each with consumer-facing justification + migration note; config back-compat NEVER breakable (v0.1 configs still load); frozen surfaces get golden-shape contract tests — frozen without a snapshot fails the suite.

Milestones:
- M87 inventory+tiers: stability field where each surface's source of truth lives (cliSurface.ts etc.); build:docs renders tiers; last-call wart review (fix with justification or label experimental); test/contract.test.mjs parameterized golden shapes (key sets + types) for all frozen surfaces; STABILITY.md.
- M88 lifecycle: CLI-vs-daemon version skew → stderr warning + remedy, never hard-fail; state.json atomic write+rename with .bak, recover or archive-corrupt + fresh start (mirror history.db); handoff re-adopts verified running children (pid+port), unverifiable → `orphaned` + remedy, never silent loss or blind kill; crash-recovery order: state → stale locks → re-adopt → serve; torture suite under DAIMON_HOME isolation.
- M89 WCAG AA: keyboard-only pass every route (focus order, traps, Escape, skip link); contrast at token layer; ARIA labels/landmarks/aria-live; prefers-reduced-motion; axe in the existing Playwright drive, both viewports — zero serious/critical.
- M90 first-15: error-string audit — every user-facing error says what to do next (EADDRINUSE forensics is the model); README stranger rewrite + truthfulness pass on clean DAIMON_HOME; SECURITY.md posture; doctor as the support path.
- M91 debt: AttachApp.tsx daimonDir()/DAIMON_HOME fix; parser.ts binary-grep byte; contention-flaky perf tests made contention-immune (never just loosen budgets); `daimon config validate` (unknown key → warn + nearest name); npm package audit (files whitelist, pack --dry-run, email grep); doctor coverage table.
- M92 ship: README; docs regen; CHANGELOG; package→0.14.0 + extension bump; RELEASE-v0.14.0.md with Migration + "Breaking changes (the last)"; CLAUDE.md; Playwright axe + keyboard specs.

Order: M87 strictly first (shapes settle before docs describe them) → M88+M89 parallel → M90+M91 continuous → M92. Descope: M91 items individually, then M90's toast audit — never M87/M88/M89-axe.

Gates: tsc clean (3 projects); npm test ≥560 under 35s quiet-machine; perf bench green; bundle <150KB gzip; doctor clean; redaction + contract suites green; axe zero serious/critical.

Done = M92 gates green, tagged v0.14.0. Stop at "ready to publish" reporting test count, bundle size, tarball delta, breaking-changes list, tier counts. Human publishes.
