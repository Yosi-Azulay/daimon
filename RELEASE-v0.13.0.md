# daimon v0.13.0 — "Daily Rhythm"

v0.12 gave daimon total recall; v0.13 makes it useful **across the day**: `daimon report` answers "what happened", env fingerprints answer "what changed", a port pool + forensics answer "who has what", and routed/batched/mutable notifications with a scheduled digest close the loop. Milestones M81–M86.

## Highlights

### Port management + forensics (M81)

- **`ports.pool: "4200-4299"`** (optional) auto-assigns ports — but only to frameworks whose registry row *documents* the mechanism: new `portFlag` (template: `--port {port}`, `-p {port}`, django's positional `127.0.0.1:{port}`) and/or `portEnv` (`PORT`, `FLASK_RUN_PORT`) fields on the profiles that support them. Profiles without a documented flag never get a port injected — partial coverage is explicit, never guessed. Assignments persist across restarts and release when an app is removed. **No `ports.pool` = exact v0.12 behavior.**
- **`daimon ports`** — app → port → source (`pinned|pool|announced`) → pid, plus foreign holders of pool/pinned ports (one `netstat -ano`/`ss` pass).
- **Startup forensics** — the v0.12 orphan incident becomes a solved class. `EADDRINUSE` on the api port now names the holder (pid, name, start time), probes the new `GET /api/signature` endpoint ("does it answer as a daimon?"), prints the exact remedy, and leaves a crash dump whose path the CLI surfaces. The daemon also writes `daemon.lock` only **after** a successful bind, so a losing daemon can't clobber the winner's lock.
- **Doctor** — new rule `port-holder-no-lock`: apiPort held + no live lock + answers as a daimon = verified orphan; `daimon doctor --auto-fix` terminates it (verify-then-kill, re-checked at fix time). A non-daimon holder is identified and advised on — **never killed**. `port-conflict-pred` now checks the pool.

### Env awareness — read-only, redacted (M82)

- "It worked yesterday" is an env-file change half the time. Every app spawn now fingerprints its convention env files (registry `envFiles` per framework: vite/next/astro/sveltekit `.env*` order, nuxt `.env`, flask `.flaskenv`+`.env`; fallback `.env`; `envFiles.<app>` config wins) into the new `env_snapshots` table: file mtime/size, **key names**, and per-key salted truncated hashes.
- **Redacted at the storage layer:** raw values are parsed and discarded in the same tick — they never reach the history DB, logs, webhooks, or notifications, and a grep-style test suite enforces it. The salt lives at `~/.daimon/salt` (per-install, created once). There is **no** `--show-values` flag — open the file.
- **`daimon env <app>`** — convention files (found/missing), key names, snapshot age. **`daimon env diff <app> [--from --to]`** — files/keys added/removed/changed between spawns (default: the last two). `daimon why` gains `envChanged` — the diff between now and the last snapshot preceding a healthy signal. New suggest-only doctor rule `env-file-missing`.

### `daimon report` — the digest (M83)

- `daimon report [--since 24h|7d] [--app <a>] [--workspace <label>] [--md]` (+ `GET /api/report`): per-app uptime % + restarts, error groups (**new vs recurring vs resolved**), test pass-rate + flakiest tests, compile p50/p95 + slowest + regressions, crashes/storms, agent activity, env changes (key names only). Pure composition over existing history — no new analytics state.
- Sections degrade independently: no test data → a note, never an error. `--md` renders human-first markdown you can paste into Slack or a PR; JSON stays the default.
- New perf budget in the suite: report over the 100k-event corpus < 500ms.
- Dashboard **Report page**: lazy chunk, nav entry + chord, 24h / 7d / custom period switcher.

### Notifications people don't turn off (M84)

- **Routing:** `notifications.kinds` — only listed kinds notify (absent = the current set unchanged). New opt-in kinds: `error-new`, `crash`, `restart-storm`, `test-failed`, `flaky-test-detected`.
- **Batching:** `notifications.batchMs` — repeated same-fingerprint errors inside the window collapse to **one** notification with a count.
- **Quiet hours:** `notifications.quietHours: "22:00-08:00"` — OS notifications suppressed in the window (events/webhooks unaffected); one "while you were away: N" summary when it ends.
- **`daimon mute <app> [--for 2h]` / `daimon unmute`** — persisted per-app mute, auto-expiring, visible in `daimon status` and on the dashboard app card.
- **Scheduled digest:** `webhooks[].digest: "HH:MM"` sends the M83 report (since the last digest) daily via the existing queue/rate-limit/retry path, Slack-shaped where detected. One 1-minute timer — not a cron engine; a daemon that was down at the scheduled time catches up **once** on the next tick (never more than one per day per webhook). `digest-sent` self-event.

### Leftovers wave (M85)

- TUI: `T` chord runs the selected app's tests with an inline pass/fail summary.
- Dashboard: app-detail **why panel** (crash card, env-changed hint, storm state, suspect commit); palette **search deep-links** into timeline/errors/logs; **Trends** adds test pass-rate + flaky-count series.

## Migration

Nothing breaks; everything below is additive.

1. **History DB** — one new table (`env_snapshots`), created automatically (`CREATE TABLE IF NOT EXISTS`). A v0.12 DB opens cleanly under v0.13 and vice versa. Retention prunes it like everything else.
2. **`~/.daimon/salt`** — created on the first spawn after upgrade (per-install random salt for env-value hashes). Deleting it just resets change-detection baselines.
3. **`~/.daimon/state.json`** — now also carries `mutes` and `digests` next to `ports`. Older files load unchanged; writes merge.
4. **New config keys — all optional; absent = v0.12 behavior:** `ports.pool`, `notifications.kinds`, `notifications.quietHours`, `notifications.batchMs`, `webhooks[].digest`. Custom framework profiles may add `portFlag`/`portEnv`/`envFiles` (validated data, never code).
5. **Pool-port injection is opt-in.** Without `ports.pool`, daimon keeps the legacy behavior (portRange allocation + `--port` + `PORT` appended to every app). With a pool configured, only profiles that declare `portFlag`/`portEnv` get a port injected — check `daimon ports` to see who participates.
6. **Doctor auto-fix can now kill a process** — exactly one class: a *verified* orphan daimon (answers on `/api/signature`, no live `daemon.lock`) holding the api port. It re-verifies at fix time and refuses everything else. Remove `port-holder-no-lock` from `doctor.autoFix.permitted` if you don't want that.
7. **New event kind** `digest-sent` flows to the feed and webhooks (entries with an `events` allow-list must add it to receive it).

## Numbers

- Test suite: **529 tests** (from 471), all green; new budgets: report < 500ms on the 100k corpus, plus the env redaction suite.
- MCP surface: **27 tools** (from 25): `daimon_report`, `daimon_env`.
- New CLI verbs: `report`, `env`, `env diff`, `ports`, `mute`, `unmute`.
- New HTTP endpoints: `GET /api/report`, `GET /api/env/:name`, `GET /api/env/:name/diff`, `GET /api/ports`, `GET /api/signature`, `POST /api/apps/:name/mute`, `POST /api/apps/:name/unmute`.

Published by Yosi Azulay (https://flycotech.com) under PolyForm Noncommercial 1.0.0.
