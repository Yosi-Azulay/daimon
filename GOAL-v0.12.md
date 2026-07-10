Ship daimon v0.12.0 — "The Whole Loop": first-class tests, crash forensics, full-text search, agent context pack. 7 milestones M74–M80. PLAN-v0.12.md is the contract — read it first; if wrong or ambiguous on a point, stop and ask before improvising.

Delegation: you may spawn subagents and choose each one's model + reasoning effort — cheap/fast (Haiku, low effort) for mechanical work (fixtures, restyles, docs, M79); strongest model + high effort for core milestones (M74/M76/M77) and final review. You remain accountable for all gates; merge subagent output only after its tests pass.

Constraints: loopback 127.0.0.1 only; no remote/multi-user/cloud; never edit user code or run install commands (wrap the project's test runner, never install/replace); state confined to ~/.daimon/* + daimon.config.json; PolyForm Noncommercial; author `Yosi Azulay (https://flycotech.com)`; yosi@flycotech.com NEVER in artifacts; human publishes (npm/git/vsce); no new deps (FTS5 is in better-sqlite3); surgical additions, no cleanliness refactors; comments only for non-obvious WHY; Windows-first (path.join, tree-kill, never 0.0.0.0).

Locked: runner parsers fixture-gated like framework profiles (test/fixtures/testrunners/<id>/, parameterized suite — no fixture, no ship); crash reports ring-buffered 10/app; errors/events always FTS-indexed, logs default-on with opt-out; LIKE fallback + self-warn if FTS fails, never blocks the daemon; `daimon context` is composition only, no new state; `test` takes the per-app soft lock (409 + --steal); history migrations additive.

Milestones:
- M74 test verb: registry testRunner hints (vitest/jest/pytest/go/cargo/dotnet; overrides.<app>.testCommand wins); parsers extract {suite,test,file,line,message}+totals, fail-soft; tables test_runs+test_failures; `daimon test <app>` exit 0/1/2; POST /api/apps/<name>/test lock-gated; GET /api/tests; audit-logged.
- M75 flaky + Tests page: ≥3 flips at same gitHead → flaky (tests.flakyThreshold, query-derived); events test-failed + flaky-test-detected (webhook-eligible); Tests page → run history, drill-down with vscodeUri links, run diff, flaky badges; `daimon test-history [--flaky]`.
- M76 crash forensics: on unrequested child exit persist crashes(exitCode, signal, uptimeMs, last 50 log lines, gitHead), ring 10/app; restart-storm event once per storm (restartStorm.perHour default 20) + doctor rule; searchroot-hygiene rule (suggest-only); `daimon why <app>` + GET /api/why: status, last crash, grouped errors, regressions, storm, suspect commit, doctor findings.
- M77 FTS search: FTS5 virtual tables + insert triggers; retention prunes cascade; `daimon search <q> [--app --since --kind logs|errors|events]` + GET /api/search + palette search mode + MCP daimon_search; bench: search <300ms on 100k corpus, insert overhead <10%.
- M78 context pack: `daimon context <app> [--budget <chars>]` + GET /api/context — status/errors/crash/last test run/compile stats/suspect commits/locks; budget drops sections lowest-priority-first (reported); MCP daimon_context, daimon_run_tests, daimon_why via callJson; contract tests + templates updated.
- M79 small wave: deno+bun profiles + fixtures; DAIMON_HOME first-class (e2e uses it; doctor prints it); `daimon logs --grep` (regex length-capped); onboarding tour dismiss-once; PWA manifest (loopback, static caching only).
- M80 ship: README + "for agents" section; docs regen; CHANGELOG; package→0.12.0 + extension bump; RELEASE-v0.12.0.md with Migration; CLAUDE.md; Playwright drive at 1280+390px.

Order: M74+M76 parallel → M75 → M77 → M78 → M79 continuous → M80. Descope M79 items first, then M77 — never M74–M76.

Gates: tsc clean (3 projects); npm test ≥440 under 35s quiet-machine; perf bench green incl. FTS budgets; bundle <150KB gzip; doctor clean; every parser/profile has a fixture.

Done = M80 gates green, tagged v0.12.0. Stop at "ready to publish" reporting tarball delta, bundle size, test count, new verbs/endpoints/MCP tools/event kinds. Human publishes.
