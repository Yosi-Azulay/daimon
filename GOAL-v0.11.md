Ship daimon v0.11.0 — "Polyglot & Polished": adapter registry, three framework waves (JS/backend/mobile), per-profile intelligence, dashboard redesign. 9 milestones M65–M73. PLAN-v0.11.md is the contract — read it first; if wrong or ambiguous on a point, stop and ask before improvising.

Constraints: loopback 127.0.0.1 only; no remote/multi-user/cloud; never edit user code or run install commands (detection reads lockfile names, never installs); state confined to ~/.daimon/* + daimon.config.json; PolyForm Noncommercial; author `Yosi Azulay (https://flycotech.com)`; yosi@flycotech.com NEVER in artifacts; human publishes (npm/git/vsce); no new deps without justification; surgical additions, no cleanliness refactors; comments only for non-obvious WHY; Windows-first (path.join, tree-kill, never 0.0.0.0).

Locked: registry in src/frameworks.ts — declarative FrameworkProfile rows (detect/command/readiness/url/errorParser/healthProbe); config `frameworks: []` custom profiles are DATA (validated regex strings + built-in parser ids), never loaded code; generic package.json dev/serve/start fallback, lowest precedence, named profiles win; multi-family roots coexist (drop nx/angular short-circuits); dashboard restyle-in-place, not a rewrite; compact list survives as density toggle; WCAG stays v1.0.

Milestones:
- M65 registry: migrate all 9 existing profiles as rows, zero behavior change (existing discovery tests pass unmodified); custom config profiles; `daimon frameworks` verb (+cliSurface); per-profile discovery.stats; M54 perf bench green.
- M66 JS wave: nextjs/nuxt/sveltekit/astro/remix; package.json fallback with rejection stats; pnpm-workspace + turbo.json enumerators; pm-aware commands (pnpm/yarn/bun/npm by lockfile).
- M67 intelligence + test kit: readiness drives compiling→serving; url feeds the announced-URL probe; parsers python-traceback/go-build/rust-cargo/dotnet/jvm-gradle (fail-soft, never drop log lines); test/fixtures/frameworks/<id>/ + parameterized test/frameworks.test.mjs. A profile without a fixture doesn't ship. Verify regressions + ready-time work polyglot.
- M68 backend wave: dotnet watch, spring-boot, laravel, flask, express-nest; upgrade the 5 existing polyglot profiles from spawn-only to full readiness/url/errorParser; tcp-listen readiness fallback; Windows command resolution.
- M69 mobile wave: expo (Metro), flutter (-d web-server), tauri. Web-preview URL only; no device/emulator orchestration.
- M70 design system: tokens.css (light+dark color/spacing/type/radii/motion); ui-primitives + workspace-tone consume tokens; per-profile badges + tones via new GET /api/frameworks; mission-control home as default route (cards: status pill + ready countdown, badge, sparkline, quick actions honoring soft-locks); bundle <150KB gzip.
- M71 responsive: nav-rail collapses <768px, all routes usable at 390px, tables→cards narrow; density comfortable|compact persisted; chords still work; Playwright at 1280px + 390px.
- M72 deferred debt: error grouping by fingerprint (API ?group= + `daimon errors --group`); per-app webhook overrides (backward compatible); VS Code code-lens over package.json scripts; TUI/VS Code badges; MCP daimon_frameworks via callJson.
- M73 ship: README framework matrix + custom-profile how-to; docs regen; CHANGELOG; package→0.11.0; RELEASE-v0.11.0.md with Migration section; CLAUDE.md ("new framework = registry row + fixture, never a discovery.ts branch"); Playwright mixed-workspace drive both viewports.

Order: M65 → M66 → M67 → M68+M69 → M70 → M71+M72 → M73. M65 is the keystone — nothing starts before it lands green. Descope from M69 first, then M68 — never M65–M67.

Gates: tsc clean (3 projects); npm test ≥310 under 35s; perf bench green; bundle <150KB gzip; doctor clean; framework suite covers every registry profile.

Done = M73 gates green, tagged v0.11.0. Stop at "ready to publish" reporting tarball delta, bundle size, test count, profile count, new endpoints/verbs/MCP tools. Human publishes.
