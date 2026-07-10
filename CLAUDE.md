# daimon — orientation for future agents

`daimon` is a local-only dev-server manager (Angular/Nx/Vite/Storybook + polyglot) with a TUI, an HTTP API on `127.0.0.1`, a JSON CLI, and an MCP server for Claude Code. Loopback only; no remote, no cloud sync, no multi-user.

If you arrive here mid-task, this file is what you need to know about the codebase.

## Where things live

```
src/
  cli.ts            # Argv dispatch. Adds X-Daimon-Agent + X-Daimon-Cwd to every HTTP call.
  cliSurface.ts     # Single source of truth for CLI verbs (rendered in --help, README, completion).
  main.ts           # Daemon entry point. Boots Registry / History / Server / WebhookDispatcher / TUI.
  server.ts         # HTTP routes. Per-app soft-lock gating + audit log writes live here.
  registry.ts       # In-memory app/event/error book-keeping. Emits 'event' to dispatcher subscribers.
  history.ts        # SQLite-backed events / compiles / bundles / tasks / self-metrics.
                    # Auto-archives a corrupt DB on startup as history.db.corrupt-<ts>.
  agents.ts         # Agent identity (`<host>-<pid>-<rand4>`) + 30s per-app LockManager.
  audit.ts          # Tab-delimited audit log; 6 columns (5-col rows still parse).
  webhooks.ts       # Outbound webhooks: queue + rate limit + Slack/Discord shape detection.
                    # Per-app scoping via webhooks[].apps + overrides.<app>.webhooks (M72).
  frameworks.ts     # Framework adapter registry (M65): every framework is a declarative
                    # FrameworkProfile row (detect/command/readiness/url/errorParser/badge).
                    # Custom config profiles are validated DATA, never loaded code.
  errorGroups.ts    # Error grouping by stack fingerprint (GET /api/errors?group=fingerprint).
  regressions.ts    # Pattern detection: compile/bundle/error-flap regression detectors.
  doctor.ts         # `daimon doctor` rules.
  autoFix.ts        # Doctor's --auto-fix repairs.
  discovery.ts      # Workspace scan — a loop over the frameworks.ts registry (M65).
                    # Handles enumerators (nx/angular/pnpm/turbo), fallback precedence, overrides.
  mcp.ts            # MCP server. Wraps the HTTP API and forwards X-Daimon-Agent.
  ...
dashboard/          # Angular 20 SPA bundled into dist/dashboard/.
test/               # node --test suite. ~200+ test cases under 30s wall-clock.
vscode-extension/   # VS Code extension (published as flycotech.daimon). Independent package.json.
```

## Build / run / test

```
npm run build            # tsc → dist/*.js
npm test                 # node --test, ~30s
npm run build:dashboard  # Angular build into dist/dashboard
npm run dev:install      # tsc + dashboard + npm link  (use for local iteration)
```

The daemon runs on `127.0.0.1:<config.apiPort>` (default `4999`). Tests **never** start the real daemon — they exercise modules in isolation against synthetic state.

## Things daimon never does

- Never bind a non-loopback interface. The server hard-codes `127.0.0.1`.
- Never edit user source. `daimon doctor --auto-fix` only repairs `~/.daimon/*` and the daemon's own state.
- Never run install commands. `npm install`, `npm ci`, package-manager upgrades — all off-limits.
- Never push to git or run `npm publish`. The human (Yosi) does that, with 2FA.
- Never share `yosi@flycotech.com` in published artifacts. Public author is `Yosi Azulay (https://flycotech.com)`.
- Never mutate global state outside `~/.daimon/*` and a local `daimon.config.json`.
- Plug-ins are opt-in but NOT sandboxed: they run in-process with full Node privileges, so daimon only loads files the user placed in `~/.daimon/plugins` themselves. Treat them as trusted code, not a confined extension (see `src/plugins.ts`).

## Conventions

- TS strict mode (3 tsconfig projects: root, dashboard/app, vscode-extension).
- Tests run against compiled `dist/*.js`, not `src/*.ts` — always `npm run build` before `npm test`.
- New HTTP endpoints belong in `server.ts` and follow the `parts[]` switch pattern.
- New MCP tools belong in `mcp.ts` and use `callJson(...)` so the X-Daimon-Agent header is forwarded.
- New CLI verbs go in `cliSurface.ts` (one entry per verb), then dispatch in `cli.ts`'s `switch (cmd)`.
- New audit columns must keep the older row count parseable — `parseAuditLine` already handles 5- and 6-col rows.
- New tests must be added to the `test` script in `package.json` (`node --test test/foo.test.mjs ...`).
- **New framework = registry row + fixture, never a discovery.ts branch.** Add a `FrameworkProfile` row in `src/frameworks.ts` and a fixture dir in `test/fixtures/frameworks/<id>/` (marker files + `fixture.json` with startup/error output). The parameterized suite (`test/frameworks.test.mjs`) fails if a built-in profile ships without a fixture.

## v0.11 highlights (what landed this release)

- Framework adapter registry (`src/frameworks.ts`): 20 single-app built-in profiles + pnpm/turbo enumerators + a generic package.json fallback, all declarative rows. `daimon frameworks` / `GET /api/frameworks` list the registry; custom profiles come from config as validated data.
- Per-profile intelligence: readiness patterns drive `compiling→serving`, url patterns feed the health probe, and per-profile parsers (python-traceback/go-build/rust-cargo/dotnet/jvm-gradle/php) extract file:line from backend stacks. TCP port-listen readiness for stdout-silent servers.
- Adapter test kit: `test/fixtures/frameworks/<id>/` + parameterized `test/frameworks.test.mjs` — the gate for every profile.
- Dashboard redesign: design tokens (`dashboard/src/styles/tokens.css`), mission-control home (badges, 24h sparklines), responsive to 390px, density toggle.
- Deferred debt: error grouping by fingerprint (`/api/errors?group=fingerprint`, `daimon errors --group`), per-app webhooks, VS Code code-lens, TUI/VS Code badges, MCP `daimon_frameworks`.

## Where to look next

- `PLAN-v0.11.md` — the v0.11 milestones (M65–M73) in spec form.
- `RELEASE-v0.11.0.md` — release notes with migration steps.
- `CHANGELOG.md` — chronological log of every shipped release.
- `daimon.config.example.json` — every config key with safe defaults.
