# daimon v0.10.1 — review hardening

A full milestone audit of v0.10.0 (M54–M64 verified line-by-line against `PLAN-v0.10.md`) found real bugs and acceptance criteria that had been quietly weakened. v0.10.1 ships every fix.

## Highlights

- **Event double-emit fixed.** `Registry.recordEvent` emitted each event twice — SSE/ndjson consumers and webhooks were seeing duplicates of everything. The single most impactful fix in this patch.
- **Pattern detection actually detects now.** The compile-regression baseline excluded priors by *duration value*, so stable builds (many identical timings) emptied their own baseline and suppressed detection — now excluded by row identity. Error-flap detection existed but had zero callers; it's wired end-to-end with per-fingerprint 24h windows, fires on spikes from a zero baseline (factor capped at 99), and throttles to one alert per fingerprint per hour. Bundle regression compares against a rolling median of the last 10 builds. The `git log -1` suspect-commit hint runs async — no more event-loop stalls in the compile path. New per-app `overrides.<app>.compileRegressionFactor` (default 2.0).
- **Agent identity has no blind spots.** The attach TUI and doctor auto-fix now send `X-Daimon-Agent`; header-less callers (dashboard polling) no longer pollute the agent registry as a fat `unknown` record; stale agents are pruned every 60s; lifecycle endpoints 404 on unknown apps *before* taking the lock.
- **The daemon survives abuse.** Parser input is capped at 2KB before regex matching (a 100KB unbroken token previously backtracked quadratically); the log stream and `/api/events?stream=ndjson` ring-buffer against slow clients and report drop counts in-stream (`stream-overflow`); invalid config fields warn + run on defaults instead of refusing to start (unparseable JSON still refuses, now with line/column); soft-reload detaches orphaned apps and kills their children; per-app session state (errors, 200-line log tail, compile history) snapshots to `~/.daimon/session-state.json` every 30s and restores after kill -9.
- **Long-poll MCP.** `daimon_subscribe_events` holds the request server-side (`GET /api/events?waitMs=`, max 55s) and returns the next event as it lands; `daimon_notify_on_error` rides the same mechanism instead of 1.5s busy-polling.
- **Dashboard presence.** App cards and the detail header show per-app agent chips, a 🔒 lock indicator with live TTL countdown, and a `~Xs` ready-time countdown on the status pill while compiling. Command-palette chord hints match the real chord map.
- **VS Code extension.** "Open daimon log for this app" code action on TypeScript diagnostics; the errors view now hides when the daemon dies.
- **Docs + branding.** README rewritten for v0.10 (and the private email removed from published artifacts — contact is https://flycotech.com); SVG logo in `assets/`; new `docs/ci-integration.md` with a complete GitHub Actions workflow; example config covers `webhooks` and `compileRegressionFactor`.
- **Tests: 262 / ~15s** (up from 225). Real MCP contract tests (SDK client over an in-memory transport, every tool's schema + invocation validated), 50-agent lock torture against a live in-process HTTP server, NUL/100KB parser fuzz, session-state and orphan-cleanup recovery tests, a `registry.list()` 200ms bench.

## Migration

1. **Webhook envelope** — the generic payload now nests event fields under `payload` per the documented contract; the flattened `from`/`to`/`message` fields remain for back-compat.
2. **Config validation softened** — invalid *fields* warn on stderr, run on defaults, and surface in `daimon doctor` under `config-valid`. Unparseable JSON still refuses to start.
3. **New state file** — `~/.daimon/session-state.json` (30s-cadence per-app snapshot; ignored after 24h; safe to delete).

## New surface

- HTTP: `GET /api/events?waitMs=<ms>` (long-poll)
- Config: `overrides.<app>.compileRegressionFactor`
- Doctor rules: `config-valid`, `orphaned-app-cleanup`
- Event: `stream-overflow` (slow-client drop report)
- State file: `~/.daimon/session-state.json`

## Gates

| Gate | Status |
| ---- | ------ |
| `tsc --noEmit` clean (root + dashboard + vscode-extension) | ✅ |
| `npm test` | ✅ 262 tests / ~15s |
| `npm publish --dry-run` pipeline (build → test → bundle → dashboard → pack) | ✅ tarball 588.5 kB / 68 files |
| `.vsix` builds | ✅ |
| No private email in published artifacts | ✅ |

## Author

Yosi Azulay · <https://flycotech.com> · PolyForm Noncommercial 1.0.0
