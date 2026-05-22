# daimon v0.10 — "Mature & Aware"

11 milestones · ~5-6 weeks · the biggest release yet. Pulls from all four directions on the v0.10 brainstorm: maturity hardening, agent-native deepening, smarter-from-history, external integration. v1.0 still comes after, when you decide it's ready — no 1.0 ceremony in this release.

## Theme

v0.7 was reach (polyglot). v0.8 was polish (CLI/UX). v0.9 was multi-agent (cwd-scoped daemon). v0.10 is **mature and aware**: daimon stops being something you fight to keep running and starts being something that tells you about itself. Performance at real scale (50+ apps, 100K events) so it doesn't bog down on big workspaces; bullet-proof recovery so corrupt state self-heals; agent identity so two Claude sessions don't step on each other; pattern detection so regressions surface themselves; an out-of-process integration story (VS Code, webhooks, CI) so daimon is the hub other tools plug into.

## Decisions locked in

- **Agent identity (M58)** is **always-on, auto-generated**. CLI generates a stable per-session ID (e.g., `<hostname>-<pid>-<rand4>`) and ships it as `X-Daimon-Agent`. Audit log gains a 6th column. No flag to enable.
- **VS Code extension (M62)** lives in `vscode-extension/` inside the daimon repo and **publishes to the VS Code marketplace** as a separate package on the same release cycle.
- **Webhooks (M63)** are configured **globally with per-event-type filters**. One `webhooks: [{ url, events: [...], headers?: {} }]` block in config. No per-app override (deferred).
- **Stress test target (M54):** 50 apps, 100K events, 30-day retention.
- **WCAG audit** deferred to **v1.0** — kept out of v0.10 scope. v0.10's accessibility is "no new regressions".
- **Loopback only, no remote, no multi-user/SSO/cloud sync, PolyForm Noncommercial 1.0.0, never edit user code, state confined to ~/.daimon/* and daimon.config.json, human runs npm publish with 2FA, no push to origin/main without confirmation, plug-ins fully opt-in.**
- **Public author:** `Yosi Azulay (https://flycotech.com)`. `yosi@flycotech.com` NEVER in published artifacts.

---

## M54 · Perf at scale — 50 apps / 100K events

Make daimon comfortable on a power-user workspace.

- **Bench harness:** `test/perf-50apps.test.mjs` — spins up a registry with 50 synthetic discovered apps, seeds 100K history events across 30 days, asserts hot paths stay under budget:
  - `GET /api/apps` cold start < 200ms
  - `GET /api/apps?cwd=<path>` < 250ms
  - `GET /api/history/timeline?since=24h` < 300ms
  - `daimon doctor` full run < 500ms
  - SSE stream catch-up after 5s offline < 1s
- **Optimizations identified during bench:**
  - History query: prepared statement caching, indexed `(app, ts)` lookups, batched bucket aggregation
  - Registry.list: avoid array allocs in hot summary loop; precomputed app→state map
  - SSE: ring-buffer per client with overflow detection (drop oldest, log dropped count)
  - Discovery: warmup cache invalidated only on `searchRoots` change
- **Memory budget:** RSS under 150MB with full corpus loaded (current ~60MB on 5 apps).

Acceptance: bench file in `npm test`, all budgets green.

---

## M55 · Error-recovery hardening

When daimon's state goes weird, daimon fixes itself.

- **Corrupt history DB → auto-rebuild.** On startup, run `PRAGMA integrity_check`. If non-OK, rename to `history.db.corrupt-<ts>`, create fresh DB, log a `self-warn` event. `daimon doctor` flags the corruption with a "previous DB archived" pointer.
- **Crash-mid-write atomicity.** All config + audit writes already use temp+rename. Extend to history pragma `journal_mode=WAL` (already on) + checkpoint-on-shutdown. Add crash-survival test: spawn daemon, send SIGKILL during heavy write, assert reopen succeeds with no corruption.
- **Malformed config safe-defaults.** If `daimon.config.json` is unparseable, daemon refuses to start and prints the JSON line/col. If it parses but fails validation, log warning, fall back to in-memory defaults for the broken field, surface in `daimon doctor`.
- **Orphaned-app cleanup.** Apps no longer in `searchRoots` after a soft-reload are detached cleanly; their child processes are terminated; their state is removed; `daimon doctor` reports the cleanup count.
- **Daemon-restart preserves session.** Stop+start cycles (or auto-restart from crash) restore: per-app status, error history, log buffer (last 200 lines), workspace registry. Test: kill -9 daemon mid-session, restart, `daimon status <app>` shows recent state.

Acceptance: 4 new tests in `test/recovery.test.mjs`. `daimon doctor` rule `history-db-healthy` added.

---

## M56 · Regression suite expansion

From 130 tests at v0.9 to 200+ at v0.10.

- **Parser fuzz:** extend existing fuzz to also try byte-level corruption mid-line, mixed line endings (\r\n vs \n), embedded ANSI escapes, NUL bytes, 100KB lines.
- **History property tests** (using fast-check or hand-rolled generators): every event written can be queried back via every relevant API endpoint and yields the same payload. No event leaks across `app` filter. Window queries respect bucket boundaries.
- **Scope property tests** (`isPathUnder`): random path pairs round-trip through normalize. Edge cases: drive letters, UNC paths, trailing-dot Windows paths, very long paths.
- **Lock-contention torture:** 50 concurrent CLI calls against the daemon, no data races, no deadlocks, all requests served within 5s.
- **MCP surface contract:** for every MCP tool, schema validation + happy-path response shape. New file `test/mcp-contract.test.mjs`.
- **Goal: >= 200 test cases, daemon test suite still under 30s wall-clock.**

Acceptance: `npm test` reports >=200 tests passing, all under 30s.

---

## M57 · Docs site + branding polish

Daimon stops being "the README". Becomes something you can hand to a colleague.

- **README rewrite:** lead with what daimon is, who it's for, what makes it different. Drop the install-anywhere generic flavor; lean into the multi-agent + single-machine power-user story.
- **Mini docs site:** single self-contained `docs/index.html` (no JS framework). Sections: Install, Quickstart (3 min), CLI reference (auto-generated from `daimon --help` recurse), MCP reference (from `dist/mcp.js` introspection), Config reference, FAQ. Built by a script (`scripts/build-docs.mjs`); commit the HTML so GitHub Pages can serve it.
- **Logo refinement:** if there's an existing one, refine it; if not, generate. SVG, monochrome + accent-color variants. Replace any current ASCII branding.
- **Screencast:** one 30-60s GIF in README showing the multi-workspace flow (two agents, two cwds, `daimon list` from each).
- **CLAUDE.md** in repo root — orientation file for future agents on this codebase: where files live, build commands, test commands, the dev-install loop, "things daimon never does".

Acceptance: `docs/index.html` builds, README references it, screencast renders cleanly on GitHub.

---

## M58 · Agent identity + app handoff

When two agents are loose on the same machine, daimon knows who did what and prevents friendly-fire.

- **Identity:** CLI generates a session ID at startup (`<short-hostname>-<pid>-<4-hex>`), persists in env for child processes, sends on every authenticated request as `X-Daimon-Agent`. MCP server inherits and forwards.
- **Agent registry:** in-memory map `agents: Map<id, { firstSeen, lastSeen, cwd, callCount }>`. Endpoint `GET /api/agents` lists active agents. Inactive after 5min of silence.
- **Audit log gains 6th column:** `ts \t remote \t sha1 \t changedKeys \t cwd \t agent`. 5-col rows still parse (agent empty).
- **Soft locks per app:** when an agent calls `start`/`restart`/`stop`, daimon records `lockedBy: <agentId>` for 30s. Another agent's call within the window returns **409 `locked-by-other-agent`** with `{ agent: <id>, lockedAt, expiresAt }`. The locking agent can re-call freely. Force flag (`--steal`) overrides.
- **Handoff verb:** `daimon handoff <app> <agentId>` transfers the lock. Useful for "I'm done with this app, you can have it".

Acceptance: two `daimon` processes from different shell sessions get different agent IDs. Concurrent starts of the same app → 409 for the second. `--steal` overrides. Audit log records both agents.

---

## M59 · MCP expansion + dashboard "who's watching" indicators

Make the agent presence visible.

- **New MCP tools:**
  - `daimon_subscribe_events { app?, kinds?, sinceMs? }` — long-poll returning new events. Used by agents to react to errors/status changes without blocking.
  - `daimon_notify_on_error { app, timeoutMs }` — blocks until next error-new event for app or timeout. Convenience wrapper.
  - `daimon_who_owns { app }` — returns current lock holder + last 3 agents who interacted with the app.
- **Dashboard agent chips:** in the app card / app detail header, render a chip-row of active agents touching that app (e.g., `🤖 claude-yosi-pc-12345`). Tooltip shows last action + last-seen.
- **Lock indicator:** if app is currently locked by an agent, show a small 🔒 with the agent ID and remaining TTL in the app header.
- **Help dialog row:** key chord `g a` opens an "Agents" sheet listing all active agents.

Acceptance: dashboard shows agent chips for active sessions. Lock indicator appears when an agent calls start. MCP `who_owns` returns the right agent.

---

## M60 · Pattern detection — regressions surface themselves

Daimon mines its own history to spot trouble.

- **Compile-time regression:** when a single compile exceeds `2.0 × rolling-median(last 20 compiles)` for an app, emit `regression-detected` event with `{ kind: 'compile', factor, baseline, current, suspectCommit: <last git-rev or null> }`. Threshold configurable per app.
- **Bundle-size regression:** when initial KB grows >10% over rolling median, same event. Already partially implemented (M40-era) — formalize, surface in events feed.
- **Error-rate regression:** when error-recur count for a fingerprint over the last 1h exceeds 3× the previous 24h baseline, emit `regression-detected` with `{ kind: 'error-flap', fingerprint, factor }`.
- **Suspect-commit hint:** if cwd is a git repo, run `git log -1 --format=%h:%s` at event time and attach. If app has changed git HEAD since last clean baseline, include the diff hash range.
- **Dashboard surface:** new "Regressions" tab (lazy chunk), or fold into Timeline as a distinct `kind=regression`. New nav-rail entry, key chord `g r`.

Acceptance: artificial test: seed 20 fast compiles + 1 slow one, assert event emitted with correct factor. Real-world drive on a workspace, confirm zero false positives across a clean session.

---

## M61 · Predictive UX — ready-time + learned suggestions

- **Ready-time estimate:** during `compiling` state, show `~Xs to ready` based on `p50` of the last 10 successful compiles for that app. Surface in:
  - CLI `daimon status <app>` — append ` (~12s)` when compiling
  - Dashboard app card status pill — add a small countdown
  - MCP `get_status` — new field `estimatedReadyAtMs`
- **Startup-order suggestions:** track which apps the user starts together within a 60s window. After 5 sessions of the same pattern, suggest a profile: `Suggested: profile "frontend-dev" → [editor, api, storybook]. Save with: daimon profile save frontend-dev`. CLI verb `daimon profiles suggest`.
- **Smart restart policies:** per-app, observe how often a restart succeeds on the 1st / 2nd / 3rd attempt over the last 50 failures. If 1st-attempt success rate is <30%, raise `maxAttempts` to 5 and `windowMs` to 2× current. Surface as a doctor suggestion (`smart-restart-tune`), not auto-applied without user OK.

Acceptance: ready-time estimates appear during compile. Profile suggestion fires after the 5th repeat session. Doctor rule `smart-restart-tune` shows up when warranted.

---

## M62 · VS Code extension

Daimon, in your editor.

- **Location:** `vscode-extension/` folder in monorepo. Separate `package.json`. Published to VS Code Marketplace as `flycotech.daimon` (or similar).
- **Features (MVP):**
  - **Status bar item:** shows current cwd's daimon-discovered app health (`✅ 3 apps healthy` / `⚠️ 1 unhealthy` / `❌ daemon down`). Click → opens dashboard.
  - **Errors view:** sidebar panel listing errors from `daimon` for current cwd (uses `?cwd=` filtering from v0.9). Click error → opens file at line:col.
  - **Commands palette:** `Daimon: Start`, `Daimon: Stop`, `Daimon: Open Dashboard`, `Daimon: Show Logs`.
  - **Code action:** on TS error in editor, offer "Open daimon log for this app" if file is under a daimon-known workspace.
- **Build/CI:** `npm run build:vscode` produces `.vsix`. Marketplace publish requires a token (human runs once per release).

Acceptance: `.vsix` builds; install loads in VS Code; status bar reflects daemon state; errors panel populates; commands work.

---

## M63 · Webhooks + CI verb

Daimon as the source of truth for everyone else.

- **Webhook config:**
  ```json
  "webhooks": [
    { "url": "https://hooks.slack.com/...", "events": ["error-new", "regression-detected"], "headers": {} },
    { "url": "https://discord.com/api/webhooks/...", "events": ["status"], "filter": { "to": ["error", "unhealthy"] } }
  ]
  ```
- **Delivery:** outbound POST with `{ event, app, ts, payload }` as JSON. 3 retries with exponential backoff. Failed deliveries logged but never block the daemon loop. Total outbound budget: 1 req/sec aggregated (drop oldest if exceeded; log drop count).
- **Slack/Discord/Sentry-friendly payloads:** detect URL host and shape payload accordingly (e.g., Slack `attachments` block for `error-new`). Generic JSON otherwise.
- **`daimon ci` verb:** for CI environments. `daimon ci start <profile> --until ready --timeout 5m --json` — starts a profile, waits for all apps to reach `serving+healthy`, exits 0 on success or non-zero with a structured failure report. Designed for GitHub Actions / Jenkins jobs that need to bring up the dev environment before tests run.

Acceptance: webhook delivery to a local httptest server. `daimon ci` returns 0 when all healthy, 1 with structured failure on timeout. CI workflow example in `docs/ci-integration.md`.

---

## M64 · Polish & ship

- **Help dialog:** new chord rows for `g a` (Agents), `g r` (Regressions), `daimon handoff`, `daimon ci`, `daimon profiles suggest`.
- **v0.9 carry-overs:** Doctor 11-rule UI tightening (M53 was light), confirm health-probe-missing auto-fix is solid.
- **README:** add VS Code extension link, webhook example, agent-identity behavior.
- **CHANGELOG:** `[0.10.0]` section listing M54-M64.
- **package.json:** 0.9.0 → 0.10.0.
- **RELEASE-v0.10.0.md** with Migration heading covering audit-log column add and webhook config.
- **Playwright live drive** against a workspace with: ≥1 error-state app, ≥1 serving app, regressions seeded, 2 active agent IDs. All 12+ routes (Apps, Detail, Errors, Logs, History, Trends, Tests, Sessions, Timeline, Regressions, Agents, Doctor, Config, Plug-ins).
- **VS Code marketplace publish:** human runs once after `gh release create` for the daimon main package.

Acceptance: all gates green. Stop at "ready to publish" and report tarball size, dashboard bundle, test count, marketplace publish status, list of new endpoints/verbs/chords.

---

## Out of scope for v0.10 (deferred to v0.11+ or v1.0)

- WCAG AA accessibility audit → v1.0 (the "others build on it" bar).
- Mobile/responsive dashboard → v0.11 or v1.0.
- Error grouping by stack-fingerprint → v0.11.
- Per-app webhook overrides → v0.11.
- VS Code extension: code-lens hints over package.json scripts → v0.11.
- IDE plugins beyond VS Code (JetBrains/Zed) → backlog.

## Sequencing notes

- **M54 → M55 → M56 chain** (maturity). M54 establishes the perf baseline; M55 hardens against the failures M54 surfaces; M56 codifies them as tests.
- **M58 → M59** (agent-native chain). Identity unblocks who-watches indicators.
- **M60 → M61** (smarter chain). Pattern detection unblocks suggestions (suggestion needs events).
- **M62 (VS Code)** is independent. Heavy chunk; needs API stability from M54-M55.
- **M63 (webhooks/CI)** independent. Depends only on event types being stable.
- **M57 (docs)** runs in parallel with everything else. Update as features land.
- **M64 (ship)** last.

Rough order: M54, M58 in parallel → M55, M59 → M56, M60 → M61, M63 → M62 → M57 (continuous) → M64.
