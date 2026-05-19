# Changelog

All notable changes to Daimon are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
