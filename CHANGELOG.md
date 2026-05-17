# Changelog

All notable changes to Daimon are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Changed
- **Renamed from `appman` to `daimon`.** Binary, package, environment variables (`APPMAN_*` → `DAIMON_*`), config file (`appman.config.json` → `daimon.config.json`), state directory (`~/.appman/` → `~/.daimon/`), and Claude integration paths (`~/.claude/skills/appman/` → `~/.claude/skills/daimon/`) all changed. No automated migration — first OSS release does not have prior public users.

## [0.4.2] — 2026-05-17

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
