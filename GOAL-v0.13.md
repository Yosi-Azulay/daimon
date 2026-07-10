Ship daimon v0.13.0 — "Daily Rhythm": digest report, env-change awareness, port management + forensics, notification polish. 6 milestones M81–M86. PLAN-v0.13.md is the contract — read it first; if wrong or ambiguous on a point, stop and ask before improvising.

Delegation: you may spawn subagents and choose each one's model + reasoning effort — cheap/fast (Haiku, low effort) for mechanical work (fixtures, restyles, docs, M85); strongest model + high effort for core work (M81 forensics, M82 redaction — security-adjacent) and final review. You remain accountable for all gates; merge subagent output only after its tests pass.

Constraints: loopback 127.0.0.1 only; no remote/multi-user/cloud; never edit user code or .env files, never run install commands; state confined to ~/.daimon/* + daimon.config.json; PolyForm Noncommercial; author `Yosi Azulay (https://flycotech.com)`; yosi@flycotech.com NEVER in artifacts; human publishes (npm/git/vsce); no new deps; surgical additions, no cleanliness refactors; comments only for non-obvious WHY; Windows-first (path.join, tree-kill, never 0.0.0.0).

Locked: report is composition only with a closed section list (per plan); env values redacted at the STORAGE layer — parsed and discarded same tick, never in DB/logs/webhooks/notifications, per-key salted truncated hashes (salt in ~/.daimon/salt), NO --show-values flag; port injection only via registry portFlag/portEnv fields — no guessing; orphan takeover verify-then-kill (daimon signature + no lock file, else advise only); no cron engine — one digest interval check + single catch-up.

Milestones:
- M81 ports: config ports.pool "4200-4299"; registry portFlag/portEnv on profiles that document them; pool auto-assign when no pinnedPort + profile declares injection, persisted; `daimon ports` (app→port→source→pid + foreign holders); EADDRINUSE startup forensics (holder pid/name/signature + remedy + crash-dump path); doctor port-holder-no-lock (auto-fix kills verified daimon orphan only) + pool-aware port-conflict-pred.
- M82 env: registry envFiles conventions per profile; spawn snapshot {file, mtime, size, keyNames, keyHashes} → env_snapshots (additive, retention-pruned); `daimon env <app>` + `daimon env diff` (files/keys added/removed/changed, values never shown); `daimon why` + crashes gain envChanged vs last-healthy snapshot; doctor env-file-missing (suggest-only); redaction suite asserts no raw value in DB/logs/webhooks/notifications.
- M83 report: `daimon report [--since --app --workspace --md]` + GET /api/report; sections independently degradable (missing data → note, never error); --md human rendering; dashboard Report page (lazy chunk, free chord, period switcher); bench budget <500ms on 100k corpus.
- M84 notifications: notifications {kinds, quietHours, batchMs} optional (absent = current behavior); same-fingerprint error batching with count; quiet-hours suppression + one exit summary; `daimon mute <app> [--for]`/unmute persisted + shown in status/dashboard; webhooks[].digest "HH:MM" sends the report daily via existing queue/retry, Slack-shaped, catch-up once max; digest-sent self-event.
- M85 leftovers: TUI `t` chord (run tests); dashboard why panel on app detail; search deep-links; Trends adds test pass-rate + flaky count series.
- M86 ship: README; docs regen; CHANGELOG; package→0.13.0 + extension bump; RELEASE-v0.13.0.md with Migration; CLAUDE.md; MCP daimon_report + daimon_env via callJson + contract tests; Playwright drive at 1280+390px.

Order: M81+M82 parallel → M83 → M84 → M85 continuous → M86. Descope M85 items first, then M84's scheduled digest (keep routing/batch/mute) — never M81–M83.

Gates: tsc clean (3 projects); npm test ≥520 under 35s quiet-machine; perf bench green incl. report budget; bundle <150KB gzip; doctor clean; redaction suite green.

Done = M86 gates green, tagged v0.13.0. Stop at "ready to publish" reporting tarball delta, bundle size, test count, new verbs/endpoints/MCP tools/config keys. Human publishes.
