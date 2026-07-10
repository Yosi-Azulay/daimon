# daimon v0.13 — "Daily Rhythm"

6 milestones (M81–M86) · feature release; the v1.0 runway moves to v0.14. v0.12 gave daimon total recall; v0.13 makes it useful across the day: a digest verb, env-change awareness, port management (including the daemon's own port), and notifications people don't turn off.

## Theme

Everything daimon records is pull-only — nobody asks, nobody knows. "It worked yesterday" is an env-file change half the time and daimon can't say so. Port conflicts surface as raw `EADDRINUSE`, and the daemon's own startup proved it today: an unlocked orphan held 4999 and the error was "failed to start within 5s" with the holder's identity one netstat away. Notifications are v0.3-era all-or-nothing, so they get ignored. v0.13 is **daily rhythm**: `daimon report` answers "what happened", env fingerprints answer "what changed", a port pool + forensics answer "who has what", and routed/batched/mutable notifications with a scheduled digest close the loop.

## Decisions locked in

- **Report is composition only** — like the context pack, it assembles existing history queries; no new analytics state. Its section list is closed: uptime, errors (new vs recurring), tests (pass rate + flakiest), compiles (p50/p95 + regressions), crashes/storms, agents, env changes.
- **Env awareness is read-only and redacted at the storage layer.** Raw values are parsed and discarded in the same tick; they never reach the history DB, logs, webhooks, or notifications. Per-key change detection uses salted truncated hashes (per-install random salt in `~/.daimon/salt`). There is **no** `--show-values` flag — open the file.
- **Port injection is registry-declared.** Only profiles with `portFlag`/`portEnv` fields get pool assignment; profiles that can't declare it, don't participate — partial coverage is explicit, never guessed.
- **Orphan takeover is verify-then-kill:** doctor's new `port-holder-no-lock` auto-fix terminates the apiPort holder only when it answers as a daimon (signature endpoint) AND no lock file exists. Anything else: identify + advise, never kill.
- **No cron engine.** The digest is one interval check (1-min granularity) with a single catch-up send if the daemon was down at the scheduled time.
- **Loopback only, no remote/multi-user/cloud sync, PolyForm Noncommercial 1.0.0, never edit user code or `.env` files, never run install commands, state confined to ~/.daimon/* and daimon.config.json, human runs npm publish with 2FA, no push to origin/main without confirmation.**
- **Public author:** `Yosi Azulay (https://flycotech.com)`. `yosi@flycotech.com` NEVER in published artifacts.

---

## M81 · Port management + port forensics

Sharpest pain first — today's orphan incident becomes a solved class.

- **Config:** `ports: { pool: "4200-4299" }` (optional; absent = no auto-assignment, current behavior).
- **Registry fields:** `portFlag` (template, e.g. `--port {port}`, `-p {port}`) and/or `portEnv` (e.g. `PORT`) added to profiles where the framework documents them (angular/nx/vite/next/nuxt/astro/sveltekit/storybook/flask/django/express-nest at minimum). Auto-assign from the pool when: no `pinnedPort`, profile declares injection, pool configured. Assignments persist in state (stable across restarts) and release when the app is removed.
- **`daimon ports [--json]`:** app→port→source (`pinned|pool|announced`)→pid, plus foreign holders of pool/pinned ports (Windows: parse `netstat -ano`; POSIX: `ss`/`lsof` best-effort). Compact JSON per convention.
- **Daemon startup forensics:** on `EADDRINUSE` for the apiPort, identify the holder (pid, process name, start time, and whether it responds to the daimon signature endpoint) and print exactly that plus the remedy (`daimon doctor --auto-fix` or the pid to kill). Failure message includes the crash-dump path (Tier-2.5 folded in).
- **Doctor:** new rule `port-holder-no-lock` — apiPort held + no lock file + responds as daimon → flagged; `--auto-fix` terminates it (verify-then-kill rule above). Non-daimon holder → advise only. Extend `port-conflict-pred` to the pool range.

Acceptance: fixture app with a vite profile gets a pool port injected via `--port`; assignment survives daemon restart; `daimon ports` lists it with source `pool`; seeded fake holder on the apiPort → startup error names the pid; doctor auto-fix kills a spawned daimon-like orphan (test double) and refuses a non-daimon holder.

---

## M82 · Env awareness — read-only, redacted

"What changed" finally includes the environment.

- **Registry field `envFiles`:** ordered per-profile conventions (vite: `.env`, `.env.local`, `.env.[mode]`; next: `.env`, `.env.local`, `.env.development(.local)`; nuxt/astro/sveltekit per their docs; generic fallback: `.env`). Data in the registry row, like everything since M65.
- **Spawn snapshot:** at each app spawn, record per convention file `{ file, exists, mtime, size, keyNames[], keyHashes{} }` — dotenv-format parse for key names, per-key salted truncated hash for change detection, raw values discarded immediately. New history table `env_snapshots (app, ts, json)`, additive migration, pruned with existing retention.
- **`daimon env <app>`:** files (found/missing per convention), key names, snapshot age; `daimon env diff <app> [--from <ts>] [--to <ts>]` (default: last two spawns): files added/removed, keys added/removed/changed. Values never shown.
- **`daimon why` + crash reports:** gain `envChanged` — diff summary between the current snapshot and the last snapshot preceding a healthy run.
- **Doctor rule `env-file-missing`:** a convention file that existed in the last snapshot but is now gone (or `overrides.<app>.env` references a missing file) → flagged, suggest-only.
- **Redaction tests:** grep-style assertions that no raw env value appears in the history DB file, any log, webhook payload, or notification body after a full exercise.

Acceptance: spawn fixture with `.env.local` → snapshot recorded with key names only; edit a value → `env diff` reports that key changed (not its value); `daimon why` shows envChanged after a value edit precedes a crash; redaction test suite green; salt file created once and reused.

---

## M83 · `daimon report` — the digest engine

One verb for "what happened".

- **`daimon report [--since 24h|7d] [--app <a>] [--workspace <label>] [--json|--md]`** (+ `GET /api/report?since=&app=&workspace=`): the closed section list — per-app uptime %, error groups (new vs recurring vs resolved), test pass-rate + flakiest tests, compile p50/p95 + slowest + regressions, crashes + storms, agent activity, env changes. Composition over existing queries; each section independently degradable (no test data → section omitted with a note, never an error).
- **`--md`:** human-first markdown rendering (suitable for pasting into Slack/PRs). JSON remains the default per CLI convention.
- **Dashboard Report page:** new lazy-chunk route + nav entry + free chord; renders the same sections with the token system; period switcher (24h / 7d / custom since).
- **Perf:** report over the 100k-event bench corpus < 500ms (new bench budget).

Acceptance: seeded history produces a report where every section matches independently-queried values; `--md` renders all sections; empty-history report emits notes not errors; bench budget green; Playwright covers the page at both viewports.

---

## M84 · Notification polish + scheduled digest

Notifications people don't turn off.

- **Config `notifications: { kinds?: string[], quietHours?: "22:00-08:00", batchMs?: 300000 }`** — all optional; absent = current behavior unchanged.
- **Routing:** only listed kinds notify (default: current set). **Batching:** repeated `error-new` for the same fingerprint within `batchMs` collapse to one notification with a count. **Quiet hours:** OS notifications suppressed in the window (events/webhooks unaffected); one "while you were away: N events" summary fires when the window ends.
- **`daimon mute <app> [--for <dur>]` / `daimon unmute <app>`:** per-app notification mute, persisted, surfaced in `daimon status` and the dashboard app card.
- **Scheduled digest:** `webhooks[].digest: "HH:MM"` — daily, sends the M83 report (since the last digest) to that webhook, Slack-shaped when the host is detected. One interval check; if the daemon was down at the scheduled time, send once on the next check (catch-up, never more than one per day per webhook). Delivery uses the existing queue/rate-limit/retry path.
- **Events:** `digest-sent` self-event for the timeline.

Acceptance: batched error test (5 same-fingerprint errors in a window → 1 notification, count 5); quiet-hours suppression + exit summary; mute honored and visible; digest fires at a mocked clock time, catch-up fires exactly once after a simulated down window; webhook payload passes the Slack-shape test.

---

## M85 · Leftovers wave (v0.12 debt + longitudinal views)

Parallelizable, cheap-model territory.

- **TUI `t` chord:** run tests on the selected app, inline pass/fail summary.
- **Dashboard `why` panel:** app-detail section rendering `GET /api/why` (crash card, env-changed hint, storm state, suspect commit).
- **Search deep-links:** palette search results link to timeline position / error group / log context.
- **Trends page additions:** test pass-rate and flaky count over time (data already in history).

Acceptance: chord runs and renders; why panel populated on a seeded app; a search hit navigates to the right timeline slice; trends show the two new series.

---

## M86 · Polish & ship

- **README:** report/env/ports/notifications sections; "daily rhythm" positioning paragraph.
- **Docs regen** (new verbs: `report`, `env`, `env diff`, `ports`, `mute`/`unmute`; config: `ports`, `notifications`, `webhooks[].digest`).
- **CHANGELOG `[0.13.0]`**; **package.json** 0.12.x → 0.13.0 (+ extension bump).
- **RELEASE-v0.13.0.md** Migration: additive `env_snapshots` table, `~/.daimon/salt`, new config keys (all optional), pool-port injection opt-in semantics, doctor auto-fix now able to kill verified orphan daimons.
- **CLAUDE.md:** ports/env registry fields, redaction rule ("values die in the same tick"), digest timer note.
- **MCP:** `daimon_report`, `daimon_env` via `callJson`; contract tests; templates updated.
- **Playwright drive:** Report page, why panel, mute indicator, both viewports.
- **Gates:** tsc clean (3 projects); `npm test` ≥520 (from 471) under 35s quiet-machine; bench green incl. report budget; bundle < 150KB gzip; doctor clean; redaction suite green.

Acceptance: all gates green. Stop at "ready to publish"; report tarball delta, bundle size, test count, new verbs/endpoints/MCP tools/config keys. Tag **v0.13.0** here. Human publishes (npm/git/vsce).

---

## Out of scope for v0.13 (deferred or never)

- v1.0 runway (WCAG AA, API freeze, security/docs hardening) → **v0.14**.
- Editing `.env` files, injecting or displaying secret values — never; read-only awareness with storage-layer redaction.
- A cron engine — one digest timer, catch-up once; nothing else scheduled.
- Email or any cloud delivery — webhooks + OS notifications only.
- Port injection for profiles without documented flags/env — explicit non-participation, no guessing.
- Remote/non-loopback, multi-user/auth, cloud sync, general process manager, loaded-code plugins — standing NOs.
- `daimon export`, report print stylesheet, per-workspace report filter beyond `--workspace` → v0.13.x stretch.

## Sequencing notes

- **M81 first** — smallest blast radius, sharpest proven pain, and its netstat/holder plumbing is used by nothing else (safe to parallelize against M82).
- **M82 early** — the redaction layer needs the most careful review of the release; do it while attention is fresh, and M83's env-changes section consumes its data.
- **M83 → M84** — the digest is the report over a webhook; strict order.
- **M85 anytime** after M74-era surfaces (all exist) — ideal for cheap-model subagents.
- **M86 last.**
- **Delegation guidance:** M81 forensics + M82 redaction + final review → strongest model, high effort (redaction is security-adjacent). M85, docs, fixtures, dashboard restyles → cheap/fast subagents. Main agent owns every gate; merge subagent work only after its tests pass.
- **Descope order:** Tier-3 stretch, then M85 items individually, then M84's scheduled digest (keep routing/batch/mute) — never M81–M83.

Rough order: M81 + M82 in parallel → M83 → M84 → M85 (continuous) → M86.
