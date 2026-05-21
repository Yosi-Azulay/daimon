Ship daimon v0.9.0 — "Multi-agent observability". 8 milestones; M46 already on disk (uncommitted). See PLAN-v0.9.md. Theme: finish multi-workspace pivot, add lint as a third signal class, ship unified event timeline, broaden polyglot probes, wrap v0.8 carry-overs.

Constraints: loopback 127.0.0.1 only; no 0.0.0.0/remote/multi-user; never edit user code or run npm/pip/bundle/cargo/go install; M50 lint is PARSE-ONLY (never spawn linters); state changes confined to ~/.daimon/* and daimon.config.json; PolyForm Noncommercial 1.0.0; author `Yosi Azulay (https://flycotech.com)`; yosi@flycotech.com NEVER in published artifacts; human runs `npm publish` with 2FA; don't push to origin/main without confirmation; plug-ins fully opt-in.

Locked: single daemon 127.0.0.1:4999 + multi-workspace via ?cwd=; name collision (M47) = hard error with disambiguation; lint (M50) = parse only; v0.8 carry-overs folded into M53 only if cheap.

Milestones:
- M46 (done, uncommitted): src/pathScope.ts, POST /api/workspaces/ensure, ?cwd= filter on /api/apps, daimon list cwd-scoped with --all, warnings + ErrorEntry.level field + /api/apps/:name/errors?level=, severity chips errors/warnings/all, TrendChart signal fix, scripts/dev-install.mjs + dev:install*, ng-warning fixture, 8 path-scope tests (106/106 pass).
- M47 per-cwd resolution: start/stop/restart/status/logs/errors/wait/watch/run accept ?cwd=; server 412 with {error:'name-collision', candidates:[…]} on >1 match; CLI renders by workspaceLabel; MCP tools accept optional cwd; new Registry.resolveByCwd().
- M48 workspaces CLI: `daimon workspaces list/add/rm/show`; GET /api/workspaces, POST /api/workspaces/remove, GET /api/workspaces/resolve?cwd=; CLI adds X-Daimon-Cwd header to all POSTs; audit entries include `cwd`.
- M49 dashboard cwd context: dashboard reads ?cwd= and pre-selects workspace pill; banner+register button for unknown cwd; new `daimon dashboard` verb opens browser with ?cwd=process.cwd(); header scope chip with × clear; no regression when no ?cwd= present.
- M50 lint channel: extend parseLine with LINT_PATTERNS (eslint, biome, ruff, clippy); ErrorEntry.level accepts 'lint'; new AppEventType lint-new/lint-recur; status NEVER flips on lint; ?level=lint filter; dashboard severity chips become errors/warnings/lint/all with tertiary-accent rows; lintCount on AppSummary; lint excluded from error trends. Fixtures: lint-eslint/biome/ruff/clippy.log.
- M51 unified event timeline: TimelineEvent {ts,app,kind,summary,payload} merged from events+compile_times+bundles+task_runs; GET /api/history/timeline?since=&app=&kinds=; lazy dashboard route /timeline with virtual scroll, kind/app filters, flyout drawer; <300ms for 7d × 5000 events; nav-rail entry between History and Tests.
- M52 polyglot v2 probes: new src/healthProfiles.ts with per-profile defaults (django /admin/login/, rails /up→/, fastapi /docs, go-air /, rust-trunk /); discovery picks profile default unless user override; 200/302/401=healthy, 5xx/ECONNREFUSED/ECONNRESET=unhealthy; new doctor rule `health-probe-missing` with auto-fix.
- M53 polish & ship: Doctor 11-rule UI renders ALL_AUTO_FIX with permit toggle; help dialog adds workspaces+dashboard chords; README "Multi-agent" section + list/lint examples; CHANGELOG [0.9.0]; package.json 0.8.1→0.9.0; RELEASE-v0.9.0.md with Migration heading; Playwright drive against workspace with ≥1 error + ≥1 serving (v0.8 lesson) covering all 11 routes incl. Timeline.

Sequencing: M47→M48→M49 chain. M50 parallel. M51 after M50 typing lands. M52 independent. M53 last.

Pre-publish gates (all must pass): tsc -p . clean; tsc -p dashboard/ clean; `npm test` green (extend test list for new fixtures); `npm run build:dashboard` initial gzip <135 KB; `daimon doctor` clean; live Playwright drive against workspace with ≥1 error and ≥1 serving app on all 11 routes.

Stop at "ready to publish" and report: tarball size delta, dashboard bundle size, test counts, list of new endpoints + CLI verbs.
