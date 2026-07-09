# daimon v0.11 — "Polyglot & Polished"

9 milestones · framework reach + dashboard redesign. v0.10 made daimon mature and aware; v0.11 makes it speak every framework and look like a product. No 1.0 ceremony — that still comes later, when you decide it's ready.

## Theme

daimon manages anything but only *understands* Angular/Nx. Vite/Storybook get partial treatment; the five polyglot profiles (django, rails, fastapi, go-air, rust-trunk) are spawn-only — no readiness parsing, no error extraction, no URL announcement, so the errors panel, regressions, and ready-time predictions silently don't work for them. And most of the JS world (Next.js, Nuxt, SvelteKit, plain `npm run dev`) is invisible entirely. v0.11 is **polyglot and polished**: framework support becomes a declarative adapter registry instead of an if-chain; three waves of new profiles (JS meta-frameworks, backend stacks, mobile/native) land on it; per-profile intelligence makes every framework a full pipeline citizen; and the dashboard gets the redesign it has deferred for six versions — a real design system, a mission-control home, and responsive layout at last.

## Decisions locked in

- **All framework families in one release, phased**: JS meta-frameworks (M66) → backend (M68) → mobile/native (M69). If time compresses, descope from M69 backward — never from M65–M67.
- **Adapter architecture (M65)**: built-in declarative registry + user-defined custom profiles in `daimon.config.json`. Custom profiles are **data** (markers, command, regex strings), never loaded code. No plugin-based adapters.
- **Generic `package.json` fallback (M66)** is in: any directory with a `dev`/`start`/`serve` script registers. Named profiles always win over the fallback for the same directory.
- **Dashboard redesign (M70–M71)** is restyle-in-place on new design tokens, not a rewrite. Mission-control home replaces the apps list as the default route; the compact list survives as a density option.
- **Regex safety**: custom-profile regexes are validated at config load (compile check + length cap), applied line-by-line against length-capped input. Custom profiles reference built-in error parsers by id; they cannot define new parse logic.
- **WCAG AA audit** stays deferred to v1.0. v0.11's bar remains "no new regressions"; the design-token work must not make it worse.
- **Loopback only, no remote, no multi-user/SSO/cloud sync, PolyForm Noncommercial 1.0.0, never edit user code, never run install commands, state confined to ~/.daimon/* and daimon.config.json, human runs npm publish with 2FA, no push to origin/main without confirmation, plug-ins fully opt-in.**
- **Public author:** `Yosi Azulay (https://flycotech.com)`. `yosi@flycotech.com` NEVER in published artifacts.

---

## M65 · Framework adapter registry

The foundation. Everything after this milestone is a table row.

- **`src/frameworks.ts`** — new module exporting the registry. Each profile:
  ```ts
  interface FrameworkProfile {
    id: string;                      // 'nextjs', 'django', ...
    family: 'js' | 'python' | 'ruby' | 'go' | 'rust' | 'dotnet' | 'jvm' | 'php' | 'mobile';
    detect: {
      files?: string[];              // marker files relative to root
      fileContains?: { file: string; pattern: string }[];
      packageJson?: { dependsOn?: string[]; script?: string[] };
    };
    command: string;                 // spawn command
    readiness?: { pattern: string; timeoutMs?: number };   // "server is up" line
    url?: { pattern: string };       // announced-URL extraction (feeds F36 probe)
    errorParser?: string;            // id of a built-in parser in errorParsers.ts
    healthProbe?: 'http' | 'tcp' | 'none';
    workspace?: 'nx' | 'angular' | 'pnpm' | 'turbo';  // enumerator for multi-project roots
  }
  ```
- **Migrate all 9 existing profiles** (nx, angular, vite, storybook, django, rails, fastapi, go-air, rust-trunk) into registry rows. `discoverApps()` becomes a loop over the registry. **Zero behavior change** — existing discovery tests pass unmodified.
- **Multi-family coexistence:** remove the nx/angular `continue` short-circuits. A root with both `angular.json` and `manage.py` registers both apps (existing `uniqueKey` dedup applies). `discovery.stats` gains per-profile match counts.
- **Custom user profiles:** `frameworks: [{ id, detect, command, readiness?, url?, errorParser? }]` in `daimon.config.json`. Validated at load: unknown `errorParser` id → doctor warning + profile skipped; invalid regex → same. Custom profiles are checked **after** built-ins.
- **`daimon frameworks` CLI verb** (+ `cliSurface.ts` entry): compact JSON listing built-in + custom profiles, which apps each matched, and rejection stats. `--json` default like everything else.
- **Perf guard:** M54 bench budgets stay green. Registry iteration adds no per-root fs calls beyond what markers require (stat markers once, share results across profiles).

Acceptance: all existing discovery tests green unmodified; a fixture root with angular.json + manage.py yields two apps; custom profile in config discovers a fixture app; `daimon frameworks` lists ≥9 built-ins; perf bench green.

---

## M66 · JS wave + generic fallback + monorepo awareness

The biggest reach gain in the release.

- **New profiles:** `nextjs` (next.config.*, `next dev`), `nuxt` (nuxt.config.*, `nuxi dev`), `sveltekit` (svelte.config.* + vite plugin, `vite dev`), `astro` (astro.config.*, `astro dev`), `remix` (react-router.config.*/remix.config.*, `react-router dev`). Each with readiness + url patterns (e.g. Next `✓ Ready in`, `- Local:`; Nuxt `Local:`; Astro `Local`).
- **Generic `package.json` fallback profile** (`id: 'package-json'`): matches any root/package with a `dev`, `serve`, or `start` script (checked in that order; command is `npm run <script>`). Rejection heuristics: never inside `node_modules`; skipped when any named profile already matched the same directory; `discovery.stats.rejected` explains every skip. Lowest precedence — always checked last.
- **Monorepo enumerators:** `pnpm-workspace.yaml` and `turbo.json` roots enumerate member packages (globs from the workspace file) and run per-package profile detection, the way nx.json enumerates project.json today. Respect `followSymbolicLinks: false` and the node_modules/dist ignore set.
- **Package-manager awareness:** if `pnpm-lock.yaml` → `pnpm run <script>`; `yarn.lock` → `yarn <script>`; `bun.lock*` → `bun run <script>`; else `npm run <script>`. Applied to fallback + meta-framework commands (detection only reads lockfile names — never runs installs).

Acceptance: fixture workspaces for each of the 5 meta-frameworks + 1 pnpm workspace + 1 turbo repo discover correctly; a bare `package.json` with a dev script is found by fallback; a repo where next.config.js and package.json both match yields exactly one app with `serverProfile: 'nextjs'`.

---

## M67 · Per-profile intelligence + adapter test kit

Breadth without this is a demo. Depth before more breadth.

- **Readiness wiring:** `readiness.pattern` drives the `compiling → serving` transition for profiles without webpack/vite-style output. `daimon wait --until serving` works for a Flask app.
- **URL wiring:** `url.pattern` feeds the F36 announced-URL health probe. Flask's `* Running on http://127.0.0.1:5000` produces a probed URL like Angular's does today.
- **New error parsers** in the existing parser module, ids referenced from profiles: `python-traceback` (multi-line `Traceback ... File "x", line N`), `go-build` (`file.go:12:5: message`), `rust-cargo` (`error[E0308]: ... --> src/main.rs:4:5`), `dotnet` (`Program.cs(12,5): error CS1002`), `jvm-gradle` (javac + Spring stacktrace first-frame). Each extracts `{ file, line, col?, message }` fingerprint-compatible with the existing dedup. **Fail-soft:** unparsed lines flow to raw logs exactly as today; a parser must never drop or reorder log lines.
- **Adapter test kit:** `test/fixtures/frameworks/<id>/` — one minimal fixture per profile (marker files + a fake server script that prints that framework's real startup/error output). One parameterized suite (`test/frameworks.test.mjs`) asserts per profile: detection, command, readiness transition, URL extraction, ≥1 parsed error with correct file:line. **This suite is the gate for every profile added in M66/M68/M69 — a profile without a fixture doesn't ship.**
- **Downstream check:** regressions (M60) and ready-time estimates (M61) work for any profile that reports compile/ready cycles — verify with a polyglot fixture, fix any Angular-shaped assumptions found.

Acceptance: parameterized suite covers every registry profile; `daimon wait` reaches `serving` on the Flask fixture; errors panel shows a parsed Python traceback with file:line; parser fuzz suite extended to the new parsers.

---

## M68 · Backend wave

Deepen the polyglot set to full pipeline citizenship.

- **New profiles:** `dotnet` (*.csproj with Sdk="Microsoft.NET.Sdk.Web", `dotnet watch`, readiness `Now listening on:`), `spring-boot` (pom.xml/build.gradle with spring-boot marker, `./mvnw spring-boot:run` or `./gradlew bootRun`, readiness `Started .* in .* seconds`), `laravel` (artisan file, `php artisan serve`, readiness `Server running on`), `flask` (app.py/wsgi.py + flask in requirements/pyproject, `flask run`, readiness `* Running on`), `express-nest` (packageJson dependsOn express/@nestjs/core + start/dev script; readiness via url announce or port-listen fallback).
- **Upgrade the 5 existing polyglot profiles** (django, rails, fastapi, go-air, rust-trunk) with readiness/url/errorParser rows — they were spawn-only.
- **TCP-listen readiness fallback:** profiles with no reliable stdout signature may set `healthProbe: 'tcp'`; readiness fires when the announced/pinned port accepts a connection. Loopback only, obviously.
- Windows-first: every command verified on Windows (`./mvnw` → `mvnw.cmd` resolution; `bin/rails` → `ruby bin/rails` shim note in profile).

Acceptance: fixtures + parameterized-suite rows for all 5 new profiles; the 5 upgraded profiles pass readiness/error assertions; a seeded dotnet build error appears in the errors panel with file:line.

---

## M69 · Mobile/native wave

Dev-server aspects only — never device/emulator orchestration.

- **New profiles:** `expo` (app.json + expo dep, `npx expo start`, readiness `Metro waiting on`, url from `Web is waiting on` when present), `flutter` (pubspec.yaml with flutter sdk, `flutter run -d web-server`, readiness `is available at`), `tauri` (src-tauri/tauri.conf.json, `npm run tauri dev`, readiness from the underlying vite/next dev server line).
- Expo/Flutter apps expose the web-preview URL as the app URL; QR-code/device flows are out of scope and stay in the framework's own terminal UX (daimon logs still capture them).

Acceptance: fixtures + suite rows for expo/flutter/tauri; Flutter fixture reaches `serving` with a probed web-server URL.

---

## M70 · Design system + mission-control home

The dashboard stops being 16 pages that share a file.

- **Design tokens:** `dashboard/src/styles/tokens.css` — CSS custom properties for color (light+dark), spacing scale, type scale, radii, elevation, motion. `ui-primitives.ts` and `workspace-tone.ts` refactored to consume tokens; no page references raw hex/px for themed values after this milestone.
- **Framework identity:** per-profile badge (monochrome SVG glyph set, bundled inline — no external assets) + accent color via extended `workspace-tone`. Registry ships `badge` + `tone` fields per profile; dashboard/TUI read them from `GET /api/frameworks` (new endpoint mirroring the CLI verb).
- **Mission-control home** (new default route): responsive card grid, one card per app — status pill with ready-time countdown (M61), framework badge, workspace label, uptime/error sparkline from history (last 24h, tiny inline SVG), quick actions (start/stop/restart/logs) honoring soft-locks with the 🔒 indicator. Filter/search on top; command palette unchanged. The old compact list remains as a toggle (persisted preference).
- **Bundle budget:** initial gzip < 150KB (was <135KB; +15KB budget for tokens/badges — hold this line).

Acceptance: tokens file exists and all primitives consume it; home renders card grid with live data; badge + tone visible per framework; light/dark both from tokens; bundle under budget.

---

## M71 · Responsive + page restyles

The v0.10 deferral, paid in full.

- **Responsive shell:** nav-rail collapses to a bottom bar (or hamburger sheet) under 768px; topbar condenses; every page usable at 390px width. Tables (history, sessions, requests, agents) switch to stacked cards on narrow viewports.
- **Page-by-page restyle onto tokens:** all ~16 pages (apps, detail, errors, logs, history, trends, tests, sessions, timeline, regressions, agents, doctor, config, requests, plus dialogs) — spacing/type from the scale, no visual regression to information density on desktop.
- **Density mode:** `comfortable | compact` toggle (persisted); compact ≈ current density.
- **Keyboard polish:** existing chords all work post-redesign; focus outlines from tokens; help dialog restyled.
- **Playwright viewport matrix:** the live-drive suite runs key routes at 1280px and 390px.

Acceptance: all routes pass Playwright at both viewports; no horizontal scroll at 390px; density toggle persists across reload; chord coverage test green.

---

## M72 · Deferred debt (v0.10 carry-overs)

- **Error grouping by stack fingerprint:** errors panel groups by fingerprint with count + first/last-seen + affected apps; expand for instances. API `GET /api/errors?group=fingerprint`. CLI `daimon errors --group`.
- **Per-app webhook overrides:** `webhooks[].apps?: string[]` filter + per-app `overrides.<app>.webhooks` block merging with global list. Config stays backward compatible (absent = all apps, current behavior).
- **VS Code code-lens:** lens over `package.json` scripts and detected framework markers — "▶ Start via daimon" / "■ Stop" / "Open dashboard", using the existing extension HTTP client.
- **Framework badges in TUI + VS Code:** TUI app rows show a short profile tag (`[next]`, `[flask]`); VS Code tree items get the badge glyph.
- **MCP:** `daimon_frameworks` tool wrapping `GET /api/frameworks` via `callJson`.

Acceptance: grouped errors render + CLI verb works; webhook app-filter test (local httptest) green; code-lens appears in a fixture workspace; MCP tool passes the contract suite.

---

## M73 · Polish & ship

- **Docs:** README framework-support matrix (profile · markers · readiness · errors); `docs/` regenerated (CLI reference picks up `daimon frameworks`, config reference picks up `frameworks[]`); custom-profile how-to with one worked example.
- **CHANGELOG:** `[0.11.0]` listing M65–M73. **package.json:** 0.10.x → 0.11.0.
- **RELEASE-v0.11.0.md** with Migration heading: default dashboard route change (list → mission control, toggle documented), `frameworks[]` config addition, `GET /api/frameworks`.
- **CLAUDE.md** updated: `frameworks.ts` in the file map, adapter-registry convention ("new framework = registry row + fixture — never a discovery.ts branch").
- **Playwright live drive:** mission control + detail + errors across a mixed workspace (≥1 JS meta-framework, ≥1 backend, ≥1 mobile fixture), both viewports.
- **Full gates:** tsc clean (3 projects); `npm test` ≥310 cases under 35s; perf bench green; bundle < 150KB gzip; doctor clean; `daimon claude update` templates current.

Acceptance: all gates green. Stop at "ready to publish" and report tarball delta, bundle size, test count, profile count (built-in), new endpoints/verbs/MCP tools. Tag **v0.11.0** here. Human then runs npm publish / git push / vsce publish.

---

## Out of scope for v0.11 (deferred)

- WCAG AA accessibility audit → v1.0.
- Deno/Bun *runtime* profiles, Vitest/Playwright surfaced as tasks, dashboard onboarding tour, PWA manifest → v0.11.x stretch or v0.12.
- docker-compose / arbitrary service orchestration — **never** (dev-server manager, not a process manager).
- Auto-installing framework CLIs — never (install commands are inviolable).
- Code-based framework plugins — custom profiles are data; no loaded adapter code.
- Profile marketplace / sharing — cloud sync stays a NO.
- Device/emulator orchestration for mobile — dev-server lifecycle only.
- JetBrains/Zed extensions → backlog.

## Sequencing notes

- **M65 is the keystone.** Nothing in M66–M69 starts before the registry lands with existing tests green. If M65 slips, the release slips — do not parallelize around it.
- **M66 → M67 order matters:** breadth first would be tempting, but M67's test kit is what keeps M68/M69 honest — land it immediately after the first wave, then every later profile ships against it.
- **M68 and M69 are independent** of each other once M67 exists; either can be descoped without touching the other. Descope order: M69 first, then M68 — never M65–M67.
- **M70 → M71** (design chain). Tokens before restyles. The redesign runs **after** the framework waves so mission control is designed around real multi-framework data (badges, per-profile states), not retrofitted.
- **M72** depends on stable webhook/error/extension surfaces only — can run parallel with M70–M71.
- **M73 (ship)** last.

Rough order: M65 → M66 → M67 → M68 + M69 → M70 → M71 + M72 → M73.
