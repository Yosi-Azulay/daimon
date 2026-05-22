Ship daimon v0.10.0 — "Mature & Aware". 11 milestones, biggest yet. See PLAN-v0.10.md. Theme: scale perf, self-healing, agent identity/locks, pattern detection, predictive UX, VS Code extension, webhooks/CI. No 1.0 ceremony.

Constraints: loopback 127.0.0.1 only; no remote/multi-user/SSO/cloud; never edit user code or run install commands; state confined to ~/.daimon/* + daimon.config.json; PolyForm Noncommercial 1.0.0; author `Yosi Azulay (https://flycotech.com)`; yosi@flycotech.com NEVER in artifacts; human runs npm publish with 2FA; no push to origin/main without confirmation; plug-ins opt-in.

Locked: M58 agent ID always-on `<host>-<pid>-<rand4>` as X-Daimon-Agent + audit 6th column; M62 VS Code ext in `vscode-extension/` published as flycotech.daimon; M63 webhooks global with per-event-type filter; M54 stress 50 apps/100K events/30d retention; WCAG to v1.0.

Milestones:
- M54 perf at scale: test/perf-50apps.test.mjs budgets apps<200ms, cwd<250ms, timeline<300ms, doctor<500ms, SSE catchup<1s, RSS<150MB. Prepared stmts + (app,ts) index + batched buckets + precomputed Registry.list map + SSE ring buffer + discovery warmup cache.
- M55 recovery: corrupt history DB auto-rebuild on integrity_check fail; WAL checkpoint + SIGKILL torture; malformed config → defaults + doctor warn; orphaned-app cleanup; restart preserves status+errors+logs+workspaces. New rule history-db-healthy.
- M56 tests to 200+ under 30s: parser fuzz (byte corruption/mixed EOLs/ANSI/NUL/100KB); history property tests (no app-filter leak); scope property (UNC/trailing-dot); 50 concurrent CLI<5s; MCP contract tests every tool.
- M57 docs+branding: README rewrite for multi-agent power-user story; docs/index.html single-file built by scripts/build-docs.mjs from --help + MCP introspection; SVG logo; 30-60s GIF screencast; new CLAUDE.md in repo root.
- M58 agent identity + handoff: CLI session ID, X-Daimon-Agent header (MCP forwards); in-memory agents registry + GET /api/agents; audit 6th column (5-col still parses); 30s per-app soft lock returning 409 locked-by-other-agent + --steal override; new `daimon handoff <app> <agentId>`.
- M59 MCP+who's watching: new MCP daimon_subscribe_events, daimon_notify_on_error, daimon_who_owns; dashboard agent chips per app + 🔒 lock indicator with agent+TTL; chord `g a` Agents sheet.
- M60 pattern detection: regression-detected events for compile-time>2×rolling median, bundle>+10%, error-rate>3×24h baseline. Suspect-commit via git log -1 if git repo. Dashboard Regressions surface + chord `g r`.
- M61 predictive UX: ready-time from p50 of last 10 compiles in CLI status + dashboard pill countdown + MCP get_status.estimatedReadyAtMs. Track 60s co-starts; after 5 same patterns suggest profile via `daimon profiles suggest`. Smart restart tuning as doctor rule smart-restart-tune.
- M62 VS Code ext: vscode-extension/ folder, marketplace flycotech.daimon. MVP: status bar (cwd app health), errors sidebar (cwd-filtered), commands palette Start/Stop/Dashboard/Logs, code-action open-daimon-log on TS errors. npm run build:vscode → .vsix.
- M63 webhooks+CI: config webhooks:[{url,events,headers?,filter?}]; POST + retries + 1 req/sec budget + drop-oldest; Slack/Discord shape detection by host; new `daimon ci start <profile> --until ready --timeout 5m --json`; docs/ci-integration.md.
- M64 polish+ship: help dialog new chords; v0.9 Doctor 11-rule UI tightening; README updates; CHANGELOG [0.10.0]; package 0.9.0→0.10.0; RELEASE-v0.10.0.md with Migration (audit column + webhooks); Playwright drive ≥1 error + ≥1 serving + seeded regressions + 2 agents across all 12+ routes.

Order: M54+M58 → M55+M59 → M56+M60 → M61+M63 → M62 → M57 continuous → M64.

Gates: tsc clean (3 projects); npm test ≥200 under 30s; dashboard initial gzip<135KB; .vsix builds; daimon doctor clean; Playwright 12+ routes.

Stop at "ready to publish" reporting tarball delta, bundle size, .vsix size, test count, new endpoints+verbs+MCP+chords.
