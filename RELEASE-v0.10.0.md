# daimon v0.10.0 — "Mature & Aware"

The biggest release yet. v0.7 was reach, v0.8 was polish, v0.9 was multi-agent.
**v0.10 is mature and aware**: daimon stops being something you fight to keep running and starts being something that tells you about itself.

11 milestones (M54–M64).

## Highlights

- **Agent identity + soft-locks** (M58). Every CLI call sends an `X-Daimon-Agent: <host>-<pid>-<hex>` header. Two Claudes on the same daemon get distinct IDs; start/stop/restart serialise per-app with a 30-second soft-lock. `--steal` overrides; `daimon handoff <app> <agentId>` transfers ownership cleanly.
- **MCP expansion** (M59). New tools: `daimon_who_owns`, `daimon_subscribe_events`, `daimon_notify_on_error`. The lock holder + recent interactions are queryable per-app.
- **Pattern detection** (M60). New `regression-detected` event fires when compile-time spikes above 2× the rolling median, bundle initialKB grows >10%, or error-rate exceeds 3× the 24h baseline. Each event carries a `git log -1` suspect-commit hint when the workspace is a git repo.
- **Predictive UX** (M61). `AppSummary.estimatedReadyAtMs` projects ready-time from the p50 of the last 10 compiles. Surfaces in the compact CLI status and MCP `get_status`.
- **Webhooks + CI verb** (M63). Configure global `webhooks: [{url, events, headers?, filter?}]`. Slack/Discord payloads are auto-shaped by URL host; outbound budget is 1 req/sec with drop-oldest. New `daimon ci start <profile> --until ready --timeout 5m --json` emits a structured report and exits 2 on timeout — designed for GitHub Actions / Jenkins.
- **Recovery hardening** (M55). The history.db gets a `PRAGMA integrity_check` on startup. If it fails, the bad file is renamed `history.db.corrupt-<ts>` and a fresh db is created. WAL checkpoint runs on close so SIGKILLs don't leave bloated sidecars. New doctor rule `history-db-healthy`.
- **Perf at scale** (M54). New `test/perf-50apps.test.mjs` bench: 50 apps × 100k events × 30d retention, hot-path budgets enforced (events<250ms p95, timeline<300ms, doctor pass <500ms, SSE catchup<1s, RSS<150MB).
- **VS Code extension** (M62). New `vscode-extension/` subpackage published as `flycotech.daimon`. Status bar reflects cwd app health, errors panel lists cwd-filtered errors, command palette exposes Start/Stop/Dashboard/Logs. `--steal` is wired into the Start dialog.
- **Docs + branding** (M57). New `scripts/build-docs.mjs` generates `docs/index.html` from the live CLI surface + MCP tool list. New `CLAUDE.md` orientation file.
- **Tests** (M56). 219 test cases, up from 130 in v0.9. Full suite under 16s.

## Migration

Two breaking-ish changes worth flagging:

1. **Audit log gains a 6th column** — every row now ends with the agent id (or empty for legacy callers). Existing parsers that split on `\t` and only consume 5 columns continue to work; `parseAuditLine` in `src/audit.ts` returns `{ ts, remote, sha1, changedKeys, cwd, agent }`.

2. **`webhooks` is a new top-level config key**. Default is `[]` (no outbound deliveries). To enable Slack notifications, add to `daimon.config.json`:

   ```json
   "webhooks": [
     { "url": "https://hooks.slack.com/services/T/B/X",
       "events": ["error", "regression-detected"] }
   ]
   ```

Lock behaviour is invisible by default. If a stale agent process is holding a lock, the second agent gets HTTP 409 `locked-by-other-agent`. Pass `--steal` (or send the `?steal=1` query) to override.

## New surface

- HTTP: `GET /api/agents`, `GET /api/apps/<n>/lock`, `POST /api/apps/<n>/handoff`
- CLI: `daimon agents`, `daimon handoff <app> <agentId>`, `daimon ci start <profile>`, plus `--steal` on start/stop/restart
- MCP: `daimon_who_owns`, `daimon_subscribe_events`, `daimon_notify_on_error`
- Doctor rule: `history-db-healthy`
- Event type: `regression-detected`
- Config key: `webhooks: WebhookEntry[]`

## Gates (release readiness)

| Gate | Status |
| ---- | ------ |
| `tsc --noEmit` clean (root + dashboard + vscode-extension) | ✅ root green; dashboard/vscode-extension build via their own scripts |
| `npm test` ≥ 200 tests under 30s | ✅ 219 tests / 15.2s |
| Dashboard initial gzip < 135KB | (unchanged from v0.9) |
| `.vsix` builds | ✅ scripted (`npm run build:vscode` after `cd vscode-extension && npm install`) |
| `daimon doctor` clean | ✅ |
| Playwright drive ≥ 12 routes | (carried from v0.9 — `regressions` + `agents` routes are dashboard-side TODOs) |

## Out of scope (deferred)

- WCAG AA accessibility audit → v1.0.
- Per-app webhook overrides → v0.11.
- VS Code code-lens hints over package.json scripts → v0.11.
- Smart-restart-tune doctor rule (M61 stretch) → v0.11.
- Dashboard "Regressions" + "Agents" routes — backend is wired, UI carries over to v0.11.

## Author

Yosi Azulay · <https://flycotech.com> · PolyForm Noncommercial 1.0.0
