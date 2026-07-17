# Changelog

All notable changes to Daimon are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
