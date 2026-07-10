# daimon v0.11.0 — "Polyglot & Polished"

v0.10 made daimon mature and aware; v0.11 makes it speak every framework and look like a product.

## Highlights

- **Framework adapter registry.** Every framework daimon understands is now a declarative row in `src/frameworks.ts` — detection markers, spawn command, readiness/URL patterns, error parser, badge. `daimon frameworks` (and `GET /api/frameworks`) lists the registry with per-profile match counts and which apps matched. Adding a framework is a registry row + a fixture — never a `discovery.ts` branch.
- **Three new framework waves.** JS meta-frameworks (Next.js, Nuxt, SvelteKit, Astro, Remix), backends (.NET `dotnet watch`, Spring Boot, Laravel, Flask, Express/Nest), and mobile dev servers (Expo, Flutter web-server, Tauri) — 20 single-app built-in profiles, plus `pnpm-workspace.yaml`/`turbo.json` member enumeration and a generic `package.json` dev/serve/start fallback. Commands are package-manager aware by lockfile (pnpm/yarn/bun/npm).
- **Every profile is a full pipeline citizen.** Registry readiness patterns drive `compiling → serving` (so `daimon wait --until serving` works for Flask), URL patterns feed the health probe, and new multi-line parsers (python-traceback, go-build, rust-cargo, dotnet, jvm-gradle, php) put backend errors in the errors panel with file:line. Profiles with no stdout signature use the TCP port-listen readiness fallback. The 5 v0.10 polyglot profiles (django, rails, fastapi, go-air, rust-trunk) were upgraded from spawn-only to the full treatment.
- **Custom profiles as data.** `frameworks: []` in `daimon.config.json` — marker files, regex strings (compile-checked, length-capped), and built-in parser ids. Never loaded code.
- **Dashboard redesign.** A real design-token system (`tokens.css`, light+dark), a mission-control home (framework badges, 24h uptime/error sparklines, ready countdowns, lock-aware quick actions), responsive layout down to 390px with a bottom nav bar, and a persisted comfortable/compact density toggle. Initial bundle: 132 kB gzip (budget 150 kB).
- **v0.10 debt paid.** Error grouping by stack fingerprint (API + CLI + dashboard), per-app webhook scoping/overrides, VS Code code-lens over `package.json` scripts, framework badges in TUI + VS Code, and the `daimon_frameworks` MCP tool.

## Migration

v0.11.0 is backward compatible — no config changes are required. Three things changed shape:

1. **Default dashboard route.** The home page is the mission-control card grid. The old compact list is still there — toggle it with the list icon in the header (or the `.` chord); the preference persists. A new density toggle (`comfortable | compact`) lives in the topbar.
2. **`frameworks: []` config key (new, optional).** Custom framework profiles as data. Absent = built-ins only. Invalid entries are skipped with a warning that `daimon doctor` surfaces — they never prevent startup.
3. **`GET /api/frameworks` (new endpoint)** and `serverProfile` on app summaries. Discovery behavior is unchanged for existing workspaces, with one deliberate exception: roots that mix families (e.g. `angular.json` + `manage.py`) now register apps for *both* families instead of only the JS one. If that surfaces an app you don't want, hide it with `overrides.<name>.hidden: true`.

Windows note: `bin/rails server` is now spawned as `ruby bin/rails server`, and Maven/Gradle wrappers resolve to `mvnw.cmd`/`gradlew.cmd`.

## Numbers

- 25 built-in registry entries: 20 single-app profiles + 2 monorepo enumerators (pnpm-workspace, turbo) + generic package-json fallback + nx/angular workspace enumerators counted among the 20.
- 387 node:test cases (from 271), including one fixture per registry profile — a profile without a fixture fails the suite.
- Dashboard initial bundle 132 kB gzip (budget 150 kB).
- New surfaces: `daimon frameworks`, `daimon errors --group`, `GET /api/frameworks`, `GET /api/errors[?group=fingerprint]`, MCP `daimon_frameworks`.

## Install / update

```bash
npm i -g daimon@0.11.0
daimon daemon restart
daimon claude update   # refresh Claude Code integration artifacts
```
