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
- **Dashboard surfaces** (M59 + M60 + M64). Two new Angular routes ship: `/agents` (live list of every agent touching this daemon, with per-app lock indicators + TTL countdowns + orphan-lock surfacing) and `/regressions` (compile/bundle/error-flap cards with baseline-vs-current, factor, fingerprint, and suspect-commit hint). New chords `g g` (Agents) and `g r` (Regressions) are wired into the keyboard service and the help dialog. The dashboard initial bundle stays under the 135 KB gzip budget (484 KB / 130 KB gzipped).
- **Profile suggester + restart-tune** (M61 stretch). New `daimon profiles suggest` reads the last 30 days of status events, finds app sets repeatedly co-started within a 60s window, and surfaces clusters seen ≥5 times that don't already match an existing profile. New `smart-restart-tune` doctor rule flags apps restarting more than 5×/day so the user can review their restartPolicy.
- **VS Code .vsix built** (M62). `vscode-extension/daimon-vscode.vsix` (7.85 KB) is produced by `cd vscode-extension && npm install && npm run package`. Ready to upload to the VS Code marketplace as `flycotech.daimon`.
- **Playwright drive** (M64). `dashboard/e2e/dashboard.spec.ts` visits every route (13 in total, including the two new ones), asserts page-specific landmarks render, captures a console-error budget per route, and verifies the `g g` / `g r` chord routing. Run with `npm run e2e:install && npm run e2e:seed && npm run e2e` from `dashboard/`. Seeded fixture covers ≥1 error, ≥1 serving, ≥2 regressions.
- **Tests** (M56). 225 test cases, up from 130 in v0.9. Full suite under 17s.

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

- HTTP: `GET /api/agents`, `GET /api/apps/<n>/lock`, `POST /api/apps/<n>/handoff`, `GET /api/profiles/suggest`
- CLI: `daimon agents`, `daimon handoff <app> <agentId>`, `daimon ci start <profile>`, `daimon profiles suggest`, plus `--steal` on start/stop/restart
- MCP: `daimon_who_owns`, `daimon_subscribe_events`, `daimon_notify_on_error`
- Doctor rules: `history-db-healthy`, `smart-restart-tune`
- Event type: `regression-detected`
- Config key: `webhooks: WebhookEntry[]`
- Dashboard routes: `/agents`, `/regressions` · chords `g g`, `g r`

## Gates (release readiness)

| Gate | Status |
| ---- | ------ |
| `tsc --noEmit` clean (root + dashboard + vscode-extension) | ✅ all three projects green |
| `npm test` ≥ 200 tests under 30s | ✅ 225 tests / 17.0s |
| Dashboard initial gzip < 135KB | ✅ 130.45 KB (after adding /agents + /regressions routes) |
| `.vsix` builds | ✅ `vscode-extension/daimon-vscode.vsix` (7.85 KB) |
| `daimon doctor` clean | ✅ |
| Playwright drive ≥ 12 routes | ✅ `dashboard/e2e/dashboard.spec.ts` drives 13 routes incl. `/agents` + `/regressions`; run with `npm run e2e:install && npm run e2e` |

## Out of scope (deferred)

- WCAG AA accessibility audit → v1.0.
- Per-app webhook overrides → v0.11.
- VS Code code-lens hints over package.json scripts → v0.11.
- VS Code Marketplace publish — `.vsix` is built; the actual `vsce publish` step is a separate manual action (requires a marketplace PAT).

## Author

Yosi Azulay · <https://flycotech.com> · PolyForm Noncommercial 1.0.0
