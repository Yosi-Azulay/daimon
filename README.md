<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="daimon logo" />
</p>

# Daimon

**One local daemon for all your dev servers.** Daimon discovers the runnable apps in your workspaces — Angular / Nx / Next.js / Nuxt / SvelteKit / Astro / Remix / Vite / Storybook, Django / Rails / FastAPI / Flask / Laravel / Spring Boot / .NET / Express / Nest, Go-air / Rust-trunk, Expo / Flutter / Tauri, Deno / Bun, plus a generic `package.json` fallback and custom profiles from config — then starts and stops them, assigns their ports, dedup's their error output, and answers questions about them. You talk to it four ways: a terminal TUI, a loopback HTTP API, a JSON CLI, and an MCP server for AI agents.

Beyond serving, it closes the whole dev loop: `daimon test` runs the project's own test runner and parses the failures, `daimon why` keeps crash forensics that would otherwise evaporate, `daimon search` greps everything the daemon has ever seen, `daimon report` answers "what happened today", `daimon env diff` answers "what changed since it last worked", and `daimon logs --level error` cuts the firehose down to the lines that matter. `daimon top` answers "what is eating my laptop" for the processes daimon owns — and its guardrails suspect leaks and CPU storms against each app's own baseline, warning with a remedy and never touching the process.

Daimon is built for the **single machine with several agents on it**: you in one terminal, a Claude Code session in another repo, a second Claude in a third. All of them talk to the same daemon, see only their own workspace by default, carry distinct agent identities, and coordinate through per-app soft-locks instead of stepping on each other's dev servers.

Loopback only. Single user. No cloud. **No telemetry, ever** — the full posture is written down in [SECURITY.md](SECURITY.md). Every public surface carries an explicit stability tier (`frozen` / `stable` / `experimental`), enforced by contract tests — see [STABILITY.md](STABILITY.md).

**Docs site:** <https://yosi-azulay.github.io/daimon/> (generated from the live CLI surface — also in [`docs/`](docs/)).

## Install

```bash
npm i -g daimon
```

Requires Node ≥ 20. After install, `daimon` is on your PATH globally.

## The first 15 minutes

```bash
cd your-workspace       # anywhere with nx.json / angular.json / vite.config.* / manage.py /
                        # a *.csproj / pubspec.yaml / or just a package.json with a dev script
daimon init --auto      # writes ./daimon.config.json with safe defaults, no prompts
daimon list             # discovers your apps; auto-spawns the daemon on first call
daimon start <name>     # or: daimon ensure <name> — start if needed AND wait until healthy
daimon dashboard        # opens the web dashboard scoped to this workspace
```

What just happened: `init --auto` registered this folder as a search root; the daemon scanned it against the framework registry (`daimon frameworks` shows the whole registry and what matched); `start` spawned the app's own dev command with a port daimon assigned, and began parsing its output for errors. From here, `daimon status <name>`, `daimon errors <name>`, and `daimon logs <name>` are the everyday verbs — every one prints compact JSON, so they compose with scripts and agents.

### When it breaks

1. **`daimon doctor`** — the first stop, always. Checks config, search roots, ports, locks, and daimon's own state; `daimon doctor --auto-fix` repairs what it can (only ever daimon's own state — never your code, never an unverified process).
2. **`daimon why <name>`** — one-shot forensics for a broken app: the last crash (exit code + final log lines), grouped errors, restart storms, env changes since it was last healthy, the suspect commit, and any doctor findings that mention it.
3. **`daimon why-empty`** — when `daimon list` comes back empty, this explains what was scanned and why things were rejected.
4. **`daimon config validate`** — checks your config offline; typo'd keys get a "did you mean" suggestion.

Every recurring failure class maps to a doctor rule, an auto-fix, or a documented reason it can't — the [doctor coverage table](https://yosi-azulay.github.io/daimon/#doctor) in the docs is the full list.

## Framework support (v0.11)

Every framework is a declarative row in the adapter registry (`src/frameworks.ts`) — detection markers, spawn command, readiness/URL patterns, error parser. Run `daimon frameworks` (or `GET /api/frameworks`) to see the registry with per-profile match counts.

| Profile | Detection markers | Command | Readiness · URL | Errors |
| --- | --- | --- | --- | --- |
| `nx` | `nx.json` + per-project `project.json` serve targets | `npx nx serve <name>` | generic (webpack/esbuild banners) | generic |
| `angular` | `angular.json` serve targets | `npx ng serve <name>` | generic | generic |
| `nextjs` | `next.config.*` | `next dev` (pm-aware) | `Ready in …` · `Local:` | generic |
| `nuxt` | `nuxt.config.*` | `nuxi dev` (pm-aware) | `Local:` · `Local:` | generic |
| `sveltekit` | `svelte.config.*` + `@sveltejs/kit` dep | `vite dev` (pm-aware) | `VITE … ready` · `Local:` | vite |
| `astro` | `astro.config.*` | `astro dev` (pm-aware) | `astro … ready` · `Local` | vite |
| `remix` | `react-router.config.*` / `remix.config.*` | `react-router dev` (pm-aware) | `VITE … ready` · `Local:` | vite |
| `vite` | `vite.config.*` | `npx vite` | generic | vite |
| `storybook` | `.storybook/` | `npx storybook dev` | generic | storybook |
| `django` | `manage.py` (django marker) | `python manage.py runserver` | `Quit the server…` · announced URL | python-traceback |
| `rails` | `bin/rails` + `Gemfile` | `bin/rails server` (`ruby bin/rails` on Windows) | `Use Ctrl-C to stop` | rails |
| `fastapi` | `fastapi` in `pyproject.toml`/`requirements.txt` | `uvicorn main:app --reload` | `Uvicorn running on` · announced URL | python-traceback |
| `flask` | `app.py`/`wsgi.py` + `flask` marker | `flask run` | `* Running on` · announced URL | python-traceback |
| `laravel` | `artisan` | `php artisan serve` | `Server running on` · announced URL | php |
| `spring-boot` | `pom.xml`/`build.gradle*` spring-boot marker | `mvnw`/`gradlew` (Windows `.cmd` aware) | `Started … in … seconds` | jvm-gradle |
| `dotnet` | `*.csproj` with `Sdk="Microsoft.NET.Sdk.Web"` | `dotnet watch` | `Now listening on:` · announced URL | dotnet |
| `express-nest` | `express`/`@nestjs/core` dep + dev/start script | `npm run dev` (pm-aware) | TCP port-listen fallback | generic |
| `go-air` | `.air.toml` | `air` | `running...` | go-build |
| `rust-trunk` | `Trunk.toml` | `trunk serve` | `serving static assets at` · announced URL | rust-cargo |
| `expo` | `app.json` + `expo` dep | `expo start` (pm-aware) | `Metro waiting on` · web-preview URL | generic |
| `flutter` | `pubspec.yaml` (flutter sdk) | `flutter run -d web-server` | `is being served at` · web URL | dart file:line |
| `tauri` | `src-tauri/tauri.conf.json` | `npm run tauri dev` (pm-aware) | via underlying vite/next | rust-cargo |
| `deno` (v0.12) | `deno.json` / `deno.jsonc` | `deno task dev` | `Listening on` · announced URL | generic |
| `bun` (v0.12) | `bunfig.toml` / `bun.lock*` + `dev` script | `bun run dev` | TCP port-listen fallback · announced URL | generic |
| `pnpm-workspace` / `turbo` | `pnpm-workspace.yaml` / `turbo.json` | enumerate member packages | per-member profile | per-member |
| `package-json` (fallback) | `package.json` with `dev`/`serve`/`start` script | `npm run <script>` (pm-aware) | announced URL when printed | generic |

Notes:

- **Multi-family coexistence**: a root with both `angular.json` and `manage.py` registers both apps. The fallback never fires when a named profile matched the same directory, and never inside `node_modules` — every skip is explained in `daimon discover`'s rejection stats.
- **Package-manager awareness**: commands adapt to the lockfile (`pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `bun.lock*` → `bun`, else `npm`). Detection only reads lockfile *names* — daimon never runs installs.
- **Mobile profiles** manage the web-preview dev server only; device/emulator flows stay in the framework's own terminal UX.

### Custom profiles

Add your own framework as **data** (validated at config load — regex strings and built-in parser ids, never loaded code):

```jsonc
// daimon.config.json
{
  "frameworks": [
    {
      "id": "phoenix",
      "detect": {
        "files": ["mix.exs"],
        "fileContains": [{ "file": "mix.exs", "pattern": "Mix\\.Project" }]
      },
      "command": "mix phx.server",
      "readiness": { "pattern": "Running \\S+ with cowboy" },
      "url": { "pattern": "Access \\S+ at (https?:\\/\\/\\S+)" },
      "errorParser": "jvm-gradle"
    }
  ]
}
```

`detect` supports `files` (all must exist), `anyFiles` (any), `fileContains` (any file+regex pair), and `packageJson` (`dependsOn` / `script`). Custom profiles are checked after built-ins; invalid entries are skipped with a doctor-surfaced warning. Known `errorParser` ids: `python-traceback`, `go-build`, `rust-cargo`, `dotnet`, `jvm-gradle`, `php`, plus the classic tool ids (`vite`, `webpack`, …).

## The whole loop (v0.12)

v0.11 finished the *serving* story; v0.12 covers everything around it.

### `daimon test` — tests as pipeline citizens

Daimon **wraps the project's own runner** (it never installs or replaces one) and parses the result:

```bash
daimon test web-admin                 # exit 0 all pass · 1 failures · 2 timeout · 5 locked
daimon test api --timeout 120s
daimon test web-admin --failed        # rerun ONLY the last run's failures (v1.7)
daimon test-history web-admin         # recent runs: totals, exit codes, gitHead, failures
daimon test-history web-admin --flaky # tests that flipped pass↔fail ≥3× at the same commit
```

- **Runner resolution**: `overrides.<app>.testCommand` always wins; otherwise the app's framework profile hints the runner — JS profiles pick vitest vs jest by dependency check, `django`/`fastapi`/`flask` → pytest, `go-air` → `go test ./...`, `rust-trunk`/`tauri` → `cargo test`, `dotnet` → `dotnet test`. No resolvable runner → `{ error, hint }`.
- **Parsed failures**: `{suite, test, file, line, message}` + totals, fail-soft (unparsed output still lands in the run log; totals fall back to the exit code). Every parser is gated by a fixture in `test/fixtures/testrunners/` — same convention as framework profiles.
- **History**: runs land in `test_runs`/`test_failures` (`GET /api/tests`), failures carry the same fingerprint scheme as errors, and a test that flips pass↔fail ≥3 times at the same `gitHead` fires a `flaky-test-detected` event (threshold: `tests.flakyThreshold`). Failing runs fire `test-failed` — both are webhook-eligible.
- **Concurrency-safe**: `test` takes the same per-app soft lock as start/stop — a second agent gets exit 5 (`--steal` applies).
- The dashboard **Tests page** shows run history with pass/fail sparklines, failure drill-down with VS Code links, run-to-run diffs (newly failing / newly passing), and flaky badges.

#### Test sense 2 (v1.7) — coverage, quarantine, failed-only reruns

`daimon test` doesn't just know pass/fail; it reads the coverage the run already printed, tracks the flaky tests you've parked, and can rerun just what broke.

- **Coverage** — daimon **parses** the coverage summary the run already emitted (vitest/jest istanbul table or text-summary, pytest-cov `TOTAL`, `go test -cover`); it never adds a coverage flag or edits your test config. It surfaces as `coverage: { linesPct, statementsPct } | null` on `daimon test` / `GET /api/tests`, and as a line + delta on `daimon report`. Fail-soft and honest: absent or unparseable coverage is `null`, never a fabricated number — the same law as test counts. cargo and dotnet have no confirmed documented default summary, so they ship without coverage. Summary numbers only, no per-file storage; daimon never gates or fails a run on coverage. The dashboard **Trends** page charts coverage over time, with gaps (not zeros) where a run had none.
- **Quarantine** — list flaky tests under `tests.quarantine` (glob patterns like `"auth › *"`, matched against `suite > test`). Quarantined tests **still run and still record** — daimon can't and won't skip them — but they're dropped from flaky detection and from test-failure alert noise, and their exit code passes through unchanged. Each pattern's first-seen date is kept so `daimon report` and `daimon why` can say "oldest since <date>". A parked test is dated and visible forever — never a silent memory hole.
- **`--failed`** — `daimon test <app> --failed` reruns only the last recorded run's failures, via the runner's documented mechanism (pytest `--lf`, or a name filter for go/jest/vitest/dotnet). It errors with a remedy when the runner declares no such mechanism, when there's no prior run, or when the failure names can't build a filter — it never silently runs the whole suite.

### Crash forensics — `daimon why`

When an app dies, the *why* no longer evaporates. Every child exit daimon didn't request persists a crash report — exit code, signal, uptime, the last 50 log lines, and the git head — ring-buffered to the last 10 per app:

```bash
daimon why web-admin
# → status, last crash (code/signal/uptime + final log lines), grouped 24h errors,
#   regressions, restart-storm state, suspect commit, matching doctor findings
```

Restart storms (default: >20 unrequested exits/hour, `restartStorm.perHour`) fire a single `restart-storm` event per storm and a doctor finding pointing at `daimon why`. Doctor also gained `searchroot-hygiene` (flags drive roots / system dirs / bare home as search roots — suggest-only).

### Full-text search

Everything daimon has seen, greppable — per-app log lines (indexed by default, opt out via `search.logIndex` or `overrides.<app>.logIndex`), plus all errors and events:

```bash
daimon search "ECONNREFUSED" --app api --since 24h
daimon search "unicor*"                      # trailing * = prefix search
daimon search "hydration" --kind logs
```

Hits are `{kind, app, ts, snippet, ref}`. FTS5 (built into the bundled better-sqlite3) with deferred indexing that stays off the write path; if FTS is unavailable the daemon self-warns once and search degrades to a LIKE scan (`fallback: true`) — it never blocks. The dashboard command palette gets a search mode (`>` prefix). Filtered live tails work too: `daimon logs api --grep "ERROR|refused" --stream`.

### `daimon context` — the agent context pack

Six round-trips become one. Pure composition of existing queries — no new state:

```bash
daimon context web-admin --budget 4000
```

Returns status/framework/uptime, top 5 error fingerprint groups (24h), the last crash report, the last test run with failures, compile p50/p95 + last regression, suspect commits, and active locks/agents. `--budget <chars>` drops sections lowest-priority-first (`compile → agents → crashes → tests → errors`; `status` never drops) and lists what fell in `truncated[]`.

### For agents

The context-first workflow, in order:

1. `daimon overview` — what's going on across the workspace (first call of a session).
2. `daimon context <app>` — the full picture for the app you're debugging, one call.
3. Targeted follow-ups only as needed: `daimon why` (crashes), `daimon errors --since-last` (new compile errors after an edit), `daimon search` (where did I see that string?), `daimon test` (did my change break the suite?).

Everything is compact JSON, budgetable, and soft-lock aware — two agents on one machine coordinate instead of colliding. The same verbs are exposed over MCP (`daimon_context`, `daimon_run_tests`, `daimon_why`, `daimon_search`), and `daimon claude install` teaches the workflow to Claude Code.

## Daily rhythm (v0.13)

Everything daimon records used to be pull-only — nobody asks, nobody knows. v0.13 makes the recall useful across the day.

### `daimon report` — what happened

```bash
daimon report                       # last 24h, compact JSON
daimon report --since 7d --md       # human-first markdown, paste into Slack/PRs
daimon report --app web-admin       # one app; --workspace <label> also works
```

Per-app uptime % and restarts, error groups classified **new / recurring / resolved**, test pass-rate + flakiest tests, compile p50/p95 + the slowest build + regressions, crashes and restart storms, agent activity, and env changes. Pure composition over existing history; a section with no data degrades to a note, never an error. The dashboard gets a Report page with a period switcher. Want it delivered? `webhooks[].digest: "09:00"` sends the report daily through the normal webhook queue, Slack-shaped — one timer, one catch-up if the daemon was down, never more than one per day per webhook.

### `daimon env` — what changed

"It worked yesterday" is an env-file change half the time. Every spawn fingerprints the app's convention env files (from the framework registry: vite/next-style `.env*` chains, flask's `.flaskenv`, generic `.env`) — file mtime/size, **key names**, and per-key salted truncated hashes. Values are parsed and discarded in the same tick; they never reach the DB, logs, webhooks, or notifications, and there is no flag to show them — open the file.

```bash
daimon env web-admin        # convention files (found/missing), key names, snapshot age
daimon env diff web-admin   # files/keys added/removed/changed between the last two spawns
daimon why web-admin        # now includes envChanged since the last healthy run
```

### `daimon ports` — who has what

```bash
daimon ports    # app → port → source (pinned|pool|announced) → pid, + foreign holders
```

Opt into pool auto-assignment with `ports: { "pool": "4200-4299" }`. Ports are injected **only** through mechanisms the framework documents (registry `portFlag`/`portEnv` — `ng serve --port`, `next dev -p`, django's positional `127.0.0.1:{port}`, express's `PORT`); profiles without one simply don't participate. Assignments persist across restarts. And the daemon's own port got forensics: `EADDRINUSE` now names the holder pid, checks whether it answers as a daimon (`GET /api/signature`), prints the remedy, and `daimon doctor --auto-fix` terminates a *verified* orphan daimon — never anything else.

### Notifications you don't turn off

```jsonc
"notifications": {
  "kinds": ["error", "crash", "restart-storm"],   // route only what you want
  "batchMs": 300000,                              // same-fingerprint errors → one notification with a count
  "quietHours": "22:00-08:00"                     // suppressed + one "while you were away: N" summary
}
```

All optional — absent keys keep the old behavior. Per-app: `daimon mute web-admin --for 2h` / `daimon unmute` (persisted, visible in status and the dashboard).

## Runway (v0.14)

The release before 1.0 added nothing new to learn — it froze what exists:

- **Stability tiers on every surface.** Every CLI verb, HTTP endpoint, MCP tool, config key, and event kind declares `frozen` (shape never breaks; additive only), `stable` (breaks only with a major version + migration note), or `experimental` (the v0.13 surfaces, until they've soaked). Tiers render as badges in the [docs](https://yosi-azulay.github.io/daimon/); the promise each tier makes is written down in [STABILITY.md](STABILITY.md). Frozen surfaces are pinned by golden-shape contract tests — a shape change fails the suite forever after.
- **Lifecycle hardening.** `daimon daemon restart` now hands off *running* children to the new daemon — verified by pid + listening port and re-adopted with the same pid, so your dev servers survive a daimon upgrade. A child that can't be verified surfaces as status `orphaned` with a per-case remedy (never silently dropped, never blindly killed). `state.json` writes are atomic with a `.bak`, and a corrupt state file recovers from the backup or archives itself and starts fresh — with a self-warn event either way. A CLI talking to a daemon of a different version warns once on stderr with the exact remedy.
- **Config back-compat, forever.** Any config that ever loaded keeps loading. Unknown keys warn with the nearest valid name (`daimon config validate` checks offline); malformed values fall back to defaults with a warning — never a refusal.
- **The dashboard passed its first WCAG AA audit** — keyboard-only operation on every route, token-level contrast fixes for both themes, landmarks/ARIA, reduced-motion support, and an axe gate in the Playwright drive.

v1.0.0 is not this release: it will be tagged after the freeze survives a real-usage soak, as a near-empty release — the version number catching up to what the contract tests already enforce.

## Morning start (v1.1)

Every morning starts the same way: start the api, wait for it, start the two frontends, run `daimon status`, repeat tomorrow. daimon already knew everything it needed — the apps, their depends graph, even which apps you co-start — but the day's working set still lived in your head and your shell history. v1.1 makes it a first-class noun: a named **group**.

```jsonc
// daimon.config.json
{
  "groups": {
    "day": ["api", "web-admin", "storefront"],          // shorthand — exactly the old profiles shape
    "night": { "apps": ["api", "worker"], "autoStart": true }  // object form: starts at daemon boot
  }
}
```

One command starts the day:

```bash
daimon up day
# → starts api first (depends-aware topo order), then the frontends,
#   waits for each, and answers with a readiness summary:
#   { "group": "day", "apps": [...], "summary": "3/3 healthy", "allReached": true }
```

- **`daimon up <group>` / `daimon stop <group>` / `daimon down <group>`** — start order comes from the existing `depends` graph (dependencies first; stop runs in reverse). One member failing never aborts the rest; the summary says `2/3 healthy` and the exit code is `2`. Groups resolve before legacy profiles; on the frozen `stop` verb an *app* of the same name always wins.
- **`--group <g>` on the read surfaces** — `list`, `status`, `errors`, `report` filter to the group's members (`daimon status --group day` answers with per-app rows + the `3/4 healthy` tail); `daimon logs --group day` merges the members' log tails by timestamp, each line carrying its app.
- **autoStart groups** — `"autoStart": true` starts the group at daemon boot with the same semantics as the per-app `autoStart` list. An app named by several sources starts exactly once, with one log line naming every source.
- **TUI + dashboard** — `G` in the TUI app list cycles the group filter (header shows `group: day · 3/4 healthy`); the dashboard gets group chips, a grouped app list, and group membership on the app detail card.
- **`daimon config validate` knows groups** — unknown app names get a nearest-name suggestion, an app in two autoStart sources gets a "starts once" note, and a group/profile name collision warns that the group wins.

Groups additively subsume the legacy `profiles` map — the shorthand form *is* the profiles shape, `profiles` keeps loading forever, and nothing changes if you never add a `groups` key. Every new surface ships tier `experimental` (post-1.0 rules: frozen/stable shapes never break).

## Log sense (v1.2)

daimon records every log line an app emits — and until v1.2 treated them all the same. A Vite HMR notice, a Django stack trace, and a webpack deprecation warning were equal citizens in the tail, so finding the line that mattered meant scrolling, and an app suddenly emitting 10,000 lines a minute looked identical to a chatty healthy one. v1.2 is **log sense**: every ingested line gets a level, the tail learns to filter, and a volume spike is an event.

### Log levels

Every line is classified at ingest — `error` / `warn` / `info` / `debug`, or `null` when daimon honestly doesn't know. Classification is declared per framework in the adapter registry (the same M65 registry that declares detection and error parsing — never guessed in code): angular/nx CLI prefixes, vite badges, Next.js `⨯`/`⚠`/`✓` markers, Python logging for django/flask, Ruby Logger for rails, and ASP.NET Core's `crit:`/`fail:`/`warn:` shortnames. Frameworks without a documented convention fall back to one conservative shared heuristic. Classification is fail-soft: a miss stores the line unclassified — it can never drop or delay a log line.

### Filtering

```bash
daimon logs web --level error                 # only classified-error lines
daimon logs web --since 15m --grep "EADDR.*"  # filters compose (AND)
daimon logs web --level error --stream        # they work in follow mode too
```

Same filters as `?level=`/`?grep=`/`?since=` on `GET /api/apps/:name/logs` (and the group merge), and as optional `level`/`grep` fields on the MCP `get_logs` tool. `--level` returns only lines *classified* at that level; bare `daimon logs <app>` is byte-identical to v1.1. The TUI log pane gets a level-cycle chord (`l`) and a live grep (`/`); the dashboard log viewer gets level chips with live counts and a regex box.

### Storm detection

A misbehaving app that starts screaming shouldn't need you to notice. daimon keeps a per-app rolling lines-per-minute baseline; a sustained spike (default 10× the app's own baseline over 60s, tune via `logs.storm`) raises one `log-storm` event, and recovery raises one `log-storm-end` — hysteresis, so a flapping rate can't spam the timeline. A storming app is flagged in `daimon status`, `daimon why`, the dashboard (banner), and `daimon doctor` (`log-storm-active`, suggest-only, with the remedy: `daimon logs <app> --since 5m --level error`). Want an OS notification too? Opt in by adding `"log-storm"` to `notifications.kinds` — absent, storms stay silent self-events. `daimon report` closes the loop with a log-volume line: total lines, error-level share, storms in the window.

## Guardrails (v1.3)

**daimon watches, warns, and points — it never kills.** No resource event stops, restarts, throttles, or nices a process, ever; a grep-style test suite proves the resource code paths cannot signal a process. That promise is the whole feature.

Until v1.3 daimon knew everything an app *said* and nothing about what it *weighed*: a leaking dev server died six hours in as an opaque crash with a perfect log trail and no memory trail. Now the pidusage poll that already feeds the live TUI also keeps a downsampled history (`resource_samples`, one row per app per 30s by default — `resources.sampleMs` tunes it, `0` disables), and three warn-only detectors read it.

### `daimon top` — what is eating my machine

```bash
daimon top          # app → pid → rss → cpu → uptime, sorted by RSS
daimon top --json   # compact JSON (GET /api/top, MCP daimon_top)
```

Live state, not history: an app whose first reading hasn't arrived shows dashes, never an error.

### Leak & CPU-storm suspicion — against the app's *own* baseline

The first 5 minutes after each spawn establish a baseline (median + jitter); every threshold derives from it — there are no magic MB or % numbers to mistune, and the multipliers are deliberately not config. RSS growing monotonically for a full 15-minute window, beyond what jitter explains, raises one `resource-leak-suspect` event with the baseline, the growth rate, and a remedy; CPU pinned above the app's own p95 for a full window raises one `cpu-storm`. One event per episode — it re-arms only when the signal returns to baseline or the app restarts (a restart also recalibrates, so a heavier-but-stable process is judged against its own fresh normal). Sawtooth GC patterns, compile bursts, noisy-but-flat contention, and warm-up climbs never fire; too little data means no verdict at all.

### Budgets that warn

```jsonc
"resources": { "rssMb": 1500, "cpuPct": 80 },          // global
"overrides": { "web": { "resources": { "rssMb": 3000 } } }  // per-app wins per key
```

Crossing a budget for a sustained window raises one `resource-budget-exceeded` event naming the observed value, the budget, and what to do next. Absent keys = no checks. Warn-only, like everything here.

Suspicions surface everywhere the rest of daimon does: `daimon why` notes when a crash fell inside an open suspicion window ("RSS grew 3.1× before this crash"), Trends charts rss/cpu series, `daimon report` gains a resources section (peak RSS + suspicion counts), and `daimon doctor` flags `cpu-storm-active` (advise-only — the warn-never-kill rule extends to doctor). OS notifications for all three kinds are opt-in via `notifications.kinds`; absent, they stay silent self-events + webhooks.

## Carry-out (v1.4)

Everything daimon knows, ready to leave the building — without daimon itself growing an inch.

### `daimon export` — the carry-out bundle

```bash
daimon export --since 7d --out week.json      # canonical JSON bundle, written atomically
daimon export --format md                     # paste-ready markdown (report + section summaries)
daimon export --app web-admin --format csv    # flat rows: section,ts,app,summary,detail
```

One self-contained bundle of what happened: persisted events, fingerprint-folded error groups, test runs, compiles, crash reports, and the full report — composed from existing history, never re-derived. The JSON envelope is versioned and boring on purpose:

```jsonc
{
  "schemaVersion": 1,          // integer, additive-only evolution — readers must ignore unknown keys
  "generatedAt": 1780000000000,
  "daimonVersion": "1.4.0",
  "since": 1779400000000, "until": 1780000000000,
  "app": null,                  // or the --app scope
  "sections": { "events": {}, "errorGroups": {}, "testRuns": {}, "compiles": {}, "crashes": {}, "report": {} }
}
```

Sections with no data degrade to `{ note }`, never an error — an empty history exports a valid bundle. Three rules are permanent:

- **Export is one-way.** There is no `daimon import` and no plan for one — bundles are for humans, bug trackers, and external tools, not for round-tripping between daimons.
- **Redaction holds.** Env key names + salted hashes only, exactly like the database — a bundle can never contain an env value. The redaction test suite greps generated bundles in all three formats.
- **No raw log lines.** Crash entries keep their existing bounded tail excerpt; nothing else carries log output.

`--out` writes tmp-then-rename, so a mid-write kill never leaves a torn file. Without `--out` the bundle goes to stdout, pipe-friendly. Also `GET /api/export?since=&app=&format=` and the MCP tool `daimon_export` (all experimental).

### Print-ready reports

The dashboard Report page now carries a print stylesheet: printing (or Save-as-PDF) yields clean black-on-white regardless of theme, with navigation hidden and sections kept whole across page breaks. Nothing changes on screen.

### Shell completion, regenerated for good

`daimon completion <bash|zsh|fish|powershell>` now derives from the same verb table that renders `--help` and the docs, so every verb and flag through v1.4 completes — and a drift test fails the suite if the committed scripts in `completions/` ever lag the surface again.

```bash
source <(daimon completion bash)                      # bash (or drop completions/daimon.bash into /etc/bash_completion.d/)
daimon completion zsh > "${fpath[1]}/_daimon"         # zsh
daimon completion powershell | Out-String | Invoke-Expression   # PowerShell (add to $PROFILE to persist)
```

### Demo script

`node scripts/demo/run-demo.mjs` replays a deterministic session (start → error surfaced → report → export) against a throwaway state dir — the source of the README screencast, and provably unable to touch your real `~/.daimon`.

<!-- MAINTAINER: the dashboard was redesigned in v1.11 ("Fresh Coat"). Any
     dashboard screencast/screenshots recorded before v1.11 are stale — retake:
     apps-list, an app-detail page, the errors panel, Trends (light AND dark),
     and the Report page. See RELEASE-v1.11.0.md § Screenshots. -->


## Plugin API v1 (v1.5)

Drop a file into `~/.daimon/plugins`, restart the daemon, and daimon calls your code:

```js
// ~/.daimon/plugins/my-plugin.mjs
export default {
  name: 'my-plugin',
  apiVersion: 1,
  onEvent(evt) { /* every event, off the write path */ },
  onAppStart(app) { /* { name, framework, port, pid, status } */ },
  onAppStop(app) { },
  registerDoctorRules() { return [/* advise-only rules for `daimon doctor` */]; },
};
```

The surface is deliberately small: **observe + doctor-rule contribution only.** Hooks receive read-only frozen snapshots; a v1 plugin cannot mutate app state, config, or history. Crash isolation is the other half of the contract: a file that explodes at load is skipped (its siblings still load), and a hook that throws disables that plugin for the session with one `plugin-error` self-event — a plugin bug never takes the daemon down. `daimon plugins` shows what loaded, what didn't, and why; `daimon plugin validate <path>` checks a file offline; two runnable examples live in [`examples/plugins/`](examples/plugins/).

The trust model, stated plainly: **plugins are not sandboxed.** They run in-process with full Node privileges — daimon only loads files you placed in your own `~/.daimon/plugins`, and treats them as code you chose to run. No marketplace, no remote fetch, no auto-install, ever. [PLUGINS.md](PLUGINS.md) is the full manual: API reference, lifecycle, `apiVersion` policy, cookbook. All plugin surfaces ship `experimental`.

## Agent accountability (v1.6)

daimon already knew *who* was calling (every request carries an `X-Daimon-Agent`
header) and arbitrated *when* two agents reached for the same app (soft-locks).
v1.6 makes all of it **queryable** — the agent ledger:

```bash
daimon audit                                 # the trail: who did what, when (newest first)
daimon audit --agent host-1234-ab12 --since 2h
daimon audit --app web-admin --json          # every lifecycle + config action on one app
daimon agents                                # the roster: ids, action counts, held locks, contention
```

`daimon audit` reads the append-only audit log (`audit.log` + the rotated
`audit.log.1`) and derives `{ ts, agent, action, app, changedKeys, remote }`
rows from the actions daimon already records — `start`, `stop`, `restart`,
`steal`, `handoff`, `mute`, `unmute`, `test`, group actions, and config writes.
Filters compose (AND); malformed lines are skipped and counted, never faked.

`daimon agents` is the roster: every declared agent merged from the live registry
and the audit history, with per-action counts, currently-held soft-locks, and a
**contention** view — waits (denied acquires), steals (split live vs
after-expiry), and longest holds. The report's `agents` section deepens with the
same signal. Nothing here is stored: the roster and analytics are **derived at
query time** from the audit log + the in-memory registry + the lock manager — no
new table, no new state.

**Agent identity is advisory.** The `<host>-<pid>-<rand4>` id is a self-declared
header — daimon does not, and will not, authenticate it. The ledger records what
each *declared* identity did, not who they really were, and every output says so.
The ledger records; it does not police — no per-agent permissions, quotas, or
rate limits, ever. All v1.6 surfaces (`daimon audit`, `GET /api/audit`, the
roster/contention additions to `daimon agents` / `GET /api/agents`, MCP
`daimon_audit` / `daimon_agents`, and the MCP resources/prompts below) ship
`experimental`.

## Rewind (v1.8)

daimon's history answered point questions well — `search`, `why`, `report` — but
100k events had no shape and no time surface to scrub. v1.8 gives history its
natural unit (the **session**), a way to walk it (the **timeline**), and a
summary that greets you after a gap.

### `daimon sessions` — history by work session

```bash
daimon sessions                       # work sessions, newest first
daimon sessions --since 7d            # only slices overlapping the last week
daimon sessions show s-1721400000000  # one slice expanded into a digest
```

A **session** is a contiguous daemon-uptime slice — the stretch between the
daemon starting and stopping. Each carries its id (`s-<startMs>`, stable
forever), start/end, duration, whether it ended cleanly, whether it's the
current running slice, the apps it touched, and error/test/compile counts.
`sessions show <id>` expands one slice into a closed block list — apps
started/stopped, error groups (new vs recurring), test runs, compiles (p50/p95),
crashes, and env changes (key names only) — each block degrading to a note when
there's nothing to say.

Sessions are **derived, never recorded**: no sessions table, no session events,
no history migration. daimon derives them on demand from the daemon's own
start/stop lifecycle events — pure composition over the history it already has.

### The timeline — walk the event stream

- **TUI:** press `i` to open the timeline. Events bucket by hour or day (Enter
  drills a day into hours, Esc backs out); `←/→` move between buckets, `g`/`G`
  jump to the oldest/newest edge, and `n`/`p` jump the selected app to its
  next/previous start/stop/crash — "when did this last die" in two keystrokes.
- **Dashboard:** the Timeline route brushes and zooms (drag to narrow the
  range), filters by kind and app, and is fully keyboard-navigable with live
  announcements. Every deep-link converges here — a search hit, a why-panel
  entry, and a session all resolve to a timeline position
  (`/timeline?ts=&app=&kind=&session=`).

### "While you were away"

Come back after a gap and the first attach greets you with what changed while
you weren't looking — new errors, resolved errors, crashes, env changes — as one
dismissible line (TUI header) or panel (dashboard). It fires only after a real
gap (over 4 hours), reuses the `report` composition (no new engine, no new
timer), and once you dismiss it (Esc), it never nags again for that gap.

### `daimon why` — the failure, situated

`daimon why <app>` now adds `sessionContext`: the session the failure belongs to
plus what else happened in that slice before it — errors in *other* apps, env
changes, compile regressions. It links to the timeline (`?session=<id>`) so you
can scrub the surrounding events.

All v1.8 surfaces (`daimon sessions`, `GET /api/sessions*`, the timeline routes,
MCP `daimon_sessions`, the `daemon-start`/`daemon-stop` event kinds, and `why`'s
`sessionContext`) ship `experimental`.

## Everywhere (v1.9)

daimon was built on Windows, and for a while it showed in the corners nobody
audited — a port scanner that spoke `netstat` fluently but returned nothing on
Linux, a remedy that told a Mac user to run `taskkill`. v1.9 is **certification**:
every place daimon's behavior forks by OS was inventoried, the POSIX side was
exercised against recorded real tool output, every off-platform test skip was
made loud and counted, and the support below is stated honestly — verified,
fixture-verified, or best-effort, earned rather than asserted.

### Support matrix

| Feature | Windows | macOS | Linux |
|---|---|---|---|
| Port forensics (holder + pool scan) | verified ¹ | fixture-verified ² | fixture-verified ² |
| Process teardown (tree-kill, no orphans) | verified ¹ | best-effort ³ | best-effort ³ |
| OS notifications | best-effort ⁴ | best-effort ⁴ | best-effort ⁴ |
| TUI | verified ¹ | best-effort ³ | best-effort ³ |
| Service install manifest | fixture-verified ² | fixture-verified ² | fixture-verified ² |
| Env snapshots + redaction | verified ¹ | verified ⁵ | verified ⁵ |
| Dashboard + HTTP API (loopback) | verified ¹ | verified ⁵ | verified ⁵ |

1. **verified** — a real test runs on the Windows dev box (the suite runs here).
2. **fixture-verified** — parsers / generated manifests are tested against
   recorded-format fixtures (`test/fixtures/platform/`); confirm on real hardware
   with the smoke script below.
3. **best-effort** — leans on OS behavior (tree-kill's `ps`/`kill`, `open` /
   `xdg-open`); the smoke script exercises it on a live box. Failure is
   non-fatal by design.
4. **best-effort** — routing, batching, quiet-hours and fail-soft are unit-tested
   on every OS; actual desktop toast delivery is smoke-script / manual and never
   crashes the daemon.
5. **verified (OS-agnostic path)** — the code carries no platform branch (SQLite,
   loopback HTTP, HMAC redaction), so the single code path the suite proves is
   the same one that runs on macOS/Linux.

**BSD and anything else Node 20 supports incidentally: best-effort.** daimon runs,
but has no OS-specific code for those platforms — port forensics falls back to
`lsof`, and nothing is hardware-tested. Unsupported, community-territory.

The full branch-by-branch audit (every `process.platform` fork, its Windows and
POSIX behavior, how each side is tested, and the remaining gap) renders in the
[docs "Platform support" table](docs/index.html) straight from the data in
`src/platformInventory.ts` — a grep-driven test fails if any branch escapes it.

### Certify your box before you rely on it

```sh
sh scripts/platform-smoke.sh          # ~2 min: daemon boot, real ss/lsof port
                                      # scan, spawn + tree-kill (no orphans),
                                      # notifier, env redaction, doctor, TUI
sh scripts/platform-smoke.sh --dry-run  # plumbing only (safe on any host)
```

It uses a throwaway `DAIMON_HOME` and workspace and never touches your real
`~/.daimon`. Run it on macOS **and** Linux and paste the summary block into your
notes — that is what upgrades a *fixture-verified* cell to *verified* for your
platform.

## Wayfinding (v1.12)

Part 2 of the UI redesign trilogy. v1.11 gave the dashboard a visual language;
v1.12 gives it an **information architecture** — you find features by looking,
not by luck. Dashboard-only, recompose-only: no new endpoint, config key,
history migration, or dependency, and **every URL that worked before still
resolves** (a redirect is fine, a 404 never is — a checked-in route audit map
drives a redirect test suite as a gate).

### Navigation grouped by task

The nav rail is three labelled groups instead of a flat list in ship order:

- **Observe** — Apps · Events · Logs · Timeline · Sessions
- **Investigate** — Errors · History · Trends · Tests · Regressions · Report · Agents
- **Configure** — Settings · Doctor

A topbar breadcrumb shows where you are (*group › page › app*). The apps list
now lives at `/apps`; `/` is an **overview home** that answers "how are things"
before a click — status, apps needing attention, test pass-rate, and a resource
glance, each degrading independently to a note (a missing data source shows a
note, never an endless spinner).

### One command palette

`⌘K` / `Ctrl+K` opens a single ranked list that unifies navigation, app jumps,
actions (start / stop / restart / mute / test), and history search. Plain typing
fuzzy-matches commands *and* surfaces search hits beneath as they arrive; a
leading `>` still forces search-only. Recent selections show on open. Everything
is reachable with arrows + Enter + Esc alone.

### Keyboard shortcuts

`g` then a key jumps to a page; `?` shows the full grouped list.

| chord | page | chord | page |
|---|---|---|---|
| `g a` | Apps | `g e` | Errors |
| `g v` | Events | `g h` | History |
| `g l` | Logs | `g t` | Trends |
| `g i` | Timeline | `g x` | Tests |
| `g n` | Sessions | `g r` | Regressions |
| `g s` | Settings | `g p` | Report |
| `g d` | Doctor | `g g` | Agents |

The app-detail page is now readable anchored sections —
`/apps/:name#overview`, `#errors`, `#logs`, `#tests`, `#timeline`, `#why` (the
fragment ids are a permanent deep-link contract) — with a consistent
start/stop/restart/mute/test action row.

## Terminal Native (v1.13)

Part 3 of the UI redesign trilogy, and the one the oldest surface was owed.
v1.11 gave the dashboard a visual language, v1.12 gave it an information
architecture — v1.13 brings both to the TUI, and makes every chord
**discoverable**. Zero daemon, CLI, or API change: this release lives entirely
under `src/tui/`. No config key, no history migration, no new dependency.

**Muscle memory is sacred.** Every chord that worked in v1.12 works in v1.13,
same key, same meaning. Nothing was remapped, so there are no legacy aliases to
learn.

### Press `?`

The TUI had nineteen chords you could only find by reading the source or
squinting at a one-line footer. Now `?` opens a full keyboard reference,
grouped by pane, with the pane you are focused on listed first.

That help overlay, the per-pane footer hints, the docs cheat sheet, and the
table below all render from **one data module** (`src/tui/chords.ts`). They
cannot drift, because a test fails if any of them hand-lists a chord. That is
not hypothetical: through v1.12 the log pane's own footer said `[g/G]
bottom/top` while its code did the exact opposite. Code won; the labels are
fixed.

### A real pane system

The app list, the detail view, and the log are three first-class panes with a
**visible focus model** — `Tab` cycles them, the focused pane is marked, and
chords are *pane-scoped*, which is how the same key can mean two things without
colliding:

| Key | In the app list | In the log pane |
| --- | --- | --- |
| `l` | focus the log pane | cycle the level filter |
| `/` | filter apps by name | grep the log |
| `g` / `G` | view hints / group filter | top / bottom (and resume follow) |

A **persistent status bar** always shows the daemon and its port, the
workspace, any active filters (with a `visible/total` count), the muted-app
count, and live log storms. Resizing the terminal re-layouts immediately
instead of waiting for a tick.

### The log pane finally says what it knows

daimon has classified log levels since v1.2 and detected log storms since v1.2,
and the TUI showed neither. Now error/warn/info lines are tinted — and a line
whose level is `null` stays **plain**, because daimon never guesses a level
client-side. Follow mode stopped being implicit: the header reads `[following]`
or `[paused]`, scrolling up pauses it, `G` resumes. Grep keeps narrowing the
stream by default (exactly as it did in v1.2), with `Tab` switching to a
highlight mode where `n`/`N` walk the matches, and a storm marker appears while
an app is storming.

### Plain terminals and SSH are first-class

No feature requires a mouse or truecolor. DESIGN.md's palette became one
semantic theme module with a degradation ladder: truecolor terminals get the
design language's own OKLCH colors (converted to sRGB — four of them land
byte-identical on the dashboard's `--dm-chart-*` values), 16-color terminals
get a **hand-picked** ANSI fallback rather than auto-quantized mud, and
`NO_COLOR` renders zero color codes while every feature still works, semantics
carried on bold/dim/inverse. `STATUS_COLORS`/`HEALTH_COLORS`, previously
duplicated verbatim in two components, now exist once.

### Robust at 80 columns and 100 apps

Columns hide in priority order as the terminal narrows (cpu/mem first, exactly
the cutoff daimon always used), and below 60 columns the layout drops to a
single pane rather than corrupting two — nothing wraps into garbage. The app
list is windowed, so a 100-app registry renders one viewport with a `3/40`
position indicator instead of 100 rows. And the unconditional 1-second
full-tree re-render is gone: updates are driven by registry events, leaving one
slow tick for clock values — a 5× cut in idle renders, pinned by a budget test.

### Every chord

Generated from the chord map, grouped by scope. `Shift+L` maximizes the log
pane; `q` there returns to the list, exactly as the full-screen log pane always
behaved.

<!-- chords:start (generated from src/tui/chords.ts — npm run build:readme-chords) -->

**Global — every pane**

| Key | Does | Panes |
| --- | --- | --- |
| `?` | open this help overlay | list, detail, log |
| `Tab` | cycle focus: list → detail → log | list, detail, log |
| `Shift+L` | maximize / restore the log pane full-screen | list, detail, log |
| `i` | open the history timeline | list, detail |
| `q` | quit the TUI (the daemon keeps running) | list, detail, log |

**Navigation**

| Key | Does | Panes |
| --- | --- | --- |
| `j/k · ↑/↓` | move the selection | list, detail |

**Lifecycle — acts on the selected app**

| Key | Does | Panes |
| --- | --- | --- |
| `s` | start the selected app | list, detail |
| `S` | stop the selected app | list, detail |
| `r` | restart the selected app (confirm y/n) | list, detail |
| `f` | watch the app until it is stable | list, detail |
| `x` | run permitted auto-fixes, restart, wait | list, detail |
| `T` | run the app's own test suite once | list, detail |
| `O` | bring up a whole profile / group | list, detail |

**Inspect**

| Key | Does | Panes |
| --- | --- | --- |
| `o` | open the app's URL in a browser | list, detail |
| `e` | edit command / port / env (session-only) | list, detail |
| `E` | cycle the active env file | list, detail |
| `V` | edit the session override in $EDITOR | list, detail |
| `l` | focus the log pane | list, detail |

**Filter**

| Key | Does | Panes |
| --- | --- | --- |
| `/` | filter the app list by name | list, detail |
| `t` | filter the app list by tags | list, detail |
| `G` | cycle the group filter (v1.1) | list, detail |
| `g` | view hints: g then a/e/v/s/n | list, detail |

**Log pane**

| Key | Does | Panes |
| --- | --- | --- |
| `l` | cycle level filter: all → error → warn → info | log |
| `/` | grep / live-filter the log (Esc restores) | log |
| `n` | jump to the next grep match | log |
| `N` | jump to the previous grep match | log |
| `g` | scroll to the top (oldest lines) | log |
| `G` | scroll to the bottom (newest) and resume follow | log |
| `↑/↓` | scroll one line (scrolling up pauses follow) | log |
| `PgUp/PgDn` | page the log up / down | list, detail, log |

**Timeline (`i`)**

| Key | Does | Panes |
| --- | --- | --- |
| `←/→ · h/l` | move between time buckets | timeline |
| `g/G` | jump to oldest / newest bucket | timeline |
| `Enter` | drill a day into hours (Esc back to days) | timeline |
| `n/p` | jump to the app’s next / prev state change | timeline |
| `q/Esc` | exit the timeline (Esc steps hours → days first) | timeline |

**grep**

| Key | Does | Panes |
| --- | --- | --- |
| `Tab` | toggle grep between narrowing and highlighting | grep |
| `Enter` | keep the grep pattern and close the input | grep |
| `Esc` | clear the grep pattern and restore the full stream | grep |

**`daimon attach` (HTTP-client TUI)**

| Key | Does | Panes |
| --- | --- | --- |
| `↑/↓` | move the selection | attach |
| `Enter` | toggle the log for the selected app | attach |
| `s` | start the selected app | attach |
| `x` | stop the selected app | attach |
| `r` | restart the selected app | attach |
| `q` | detach (the daemon keeps running) | attach |
<!-- chords:end -->

## Multi-agent on one machine (v0.9 + v0.10)

A single daimon daemon on `127.0.0.1:4999` serves every workspace on your machine. Two agents (e.g. two Claude Code sessions in different repos) can use the same daemon without stepping on each other:

```bash
# In repo A:
daimon list             # only A's apps
daimon start editor     # cwd disambiguates which "editor"

# In repo B (concurrent, different terminal):
daimon list             # only B's apps
daimon start editor     # B's editor — even though A also has one

# To see every workspace's apps:
daimon list --all

# Manage the workspace registry directly:
daimon workspaces list
daimon workspaces add /path/to/another-repo --label other
daimon workspaces show              # which workspace covers cwd?

# Open the dashboard scoped to the current cwd:
daimon dashboard        # opens http://127.0.0.1:4999/?cwd=<cwd>
```

When two workspaces register apps with the same name, daimon stores the second under `<name>@<workspaceLabel>` so both coexist. CLI commands resolve from `process.cwd()`; a 412 `name-collision` body with candidate workspaces is returned only when no cwd disambiguates.

### Agent identity & soft-locks (v0.10)

Every CLI call carries an `X-Daimon-Agent: <host>-<pid>-<hex>` header — a stable per-session identity, so two Claudes on the same daemon are distinct actors in the daemon's eyes (and in the audit log).

Lifecycle verbs (`start` / `stop` / `restart`) take a **30-second per-app soft-lock**. If another agent holds the lock, the call is refused with exit code `5` instead of silently killing a server someone else is watching. You can override or cooperate:

```bash
daimon start editor --steal                 # override the lock (HTTP: POST …/start?steal=1)
daimon agents                               # who's active on this daemon + current locks
daimon handoff editor claude-host-1234-abcd # "I'm done — you take this app"
```

The agent id is also recorded as the 6th column of `~/.daimon/audit.log`, so you can reconstruct which agent restarted what, and when.

### Profile suggestions

Daimon notices which apps you repeatedly start together and proposes profiles:

```bash
daimon profiles suggest --since 30d --min 5
```

Clusters that already match an existing profile are skipped.

## Three signal classes: errors, warnings, lint

Errors flip app status to `error`. Warnings (TS6133, NG8107, deprecation notes) are surfaced as a separate signal class — they do not flip status. **Lint findings** (eslint, biome, ruff, clippy) are a third channel: parsed from the dev-server log stream, never spawn a linter, never flip status, and live behind a dedicated severity chip on the Errors page.

```bash
daimon errors editor                       # errors only (back-compat default)
daimon errors editor --level warning
daimon errors editor --level lint
daimon errors editor --level all
```

## Unified event timeline

`daimon timeline` and the dashboard `/timeline` route merge status, errors, warnings, lint, health, bundle, compile, and task-run rows into one chronological stream:

```bash
daimon timeline --since 7d --kinds status,error,lint
daimon timeline --app editor --since 24h
```

## Pattern detection (v0.10)

Daimon watches its own history for regressions and emits a `regression-detected` event when it spots one:

- **Compile-time spikes** — recent compiles significantly slower than the app's baseline (tune per app with `overrides.<name>.compileRegressionFactor`).
- **Bundle-size jumps** — initial bundle suddenly heavier than its trend.
- **Error flapping** — the same error appearing/disappearing across restarts.

Each detection includes a `git log -1` suspect-commit hint when the workspace is a git repo. In the dashboard, the **Regressions** tab collects them (keyboard chord: `g` then `r`). `regression-detected` is also a webhook-able event type — see below.

## Webhooks (v0.10)

Push events out instead of polling. Global `webhooks` config array; each entry is `{url, events?, headers?, filter?}`:

```jsonc
{
  "webhooks": [
    {
      "url": "https://hooks.slack.com/services/T000/B000/XXXXXXXX",
      "events": ["error", "regression-detected", "status"],
      "headers": { "x-extra-header": "optional" },
      "filter": { "app": ["web-admin"], "to": ["error", "unhealthy"] }
    }
  ]
}
```

- `events` — event types to forward (`error` / `warning` / `lint` aliases cover the `-new`/`-recur` pairs). Omit for all events.
- `headers` — extra HTTP headers (e.g. auth tokens).
- `filter` — narrow by `app`, and/or status transition `from` / `to`.

Slack and Discord URLs get native attachment/embed shaping automatically. Everything else receives a generic JSON envelope: `{ event, app, ts, payload }` where `payload` carries the event-specific fields (`from`, `to`, `message`); the same fields are also flattened at the top level for back-compat. Deliveries are queued, rate-limited to 1 req/sec, and retried with backoff — an event storm never hammers your endpoint or blocks the daemon.

## CI integration (v0.10)

`daimon ci start <profile>` is a one-shot CI step: start a profile, block until every app reaches the target state, print a structured JSON report, and exit with a meaningful code:

```bash
daimon ci start fullstack --until ready --timeout 5m --json
# exit 0 = all apps reached target
# exit 1 = error (e.g. unknown profile)
# exit 2 = timeout — some app never got there
```

See [`docs/ci-integration.md`](docs/ci-integration.md) for a complete GitHub Actions workflow and a webhook-to-Slack failure alert.

## VS Code extension (v0.10)

`vscode-extension/` ships a companion extension (marketplace id: `flycotech.daimon`): a status-bar item with daemon/app state, an Errors tree view, and Start / Stop / Open-Dashboard commands. It talks to the same loopback API, so it composes with the TUI, CLI, and MCP server. It has its own `package.json` and is built independently of the npm package.

## Config (minimal)

```jsonc
{
  "searchRoots": ["D:\\code\\my-nx-workspace"],
  "portRange": [4200, 4299],
  "apiPort": 4999,

  "autoStart": ["web-admin"],
  "profiles": { "fullstack": ["web-admin", "api"] },
  "depends": { "web-admin": ["api"] },

  "healthProbe": { "enabled": true, "intervalMs": 30000, "path": "/" },

  "webhooks": [
    { "url": "https://hooks.slack.com/services/T000/B000/XXXXXXXX", "events": ["error", "regression-detected"] }
  ],

  "overrides": {
    "web-admin": {
      "port": 4250,
      "command": "npx nx serve web-admin --configuration=dev",
      "env": { "API_BASE": "http://localhost:3000" },
      "compileRegressionFactor": 2.0
    }
  }
}
```

All sections except `searchRoots` are optional with safe defaults. See `daimon.config.example.json` for every field.

Config lookup order:

1. `./daimon.config.json` (cwd)
2. `~/.daimon/config.json`

If neither exists, the first call to `daimon` creates a stub and exits — edit `searchRoots` to point at your workspace and try again.

## Daemon lifecycle

```bash
daimon daemon start [--detach] [--headless]   # foreground TUI by default
daimon daemon status                          # { running, pid, port, uptimeMs, version }
daimon daemon stop
daimon daemon restart                          # handoff: RUNNING apps survive and are re-adopted (same pid, v0.14)
daimon daemon attach                           # HTTP-client TUI against a running detached daemon
daimon daemon install-service                  # emits service unit for Windows (nssm) / macOS (launchd) / Linux (systemd)
```

The daemon auto-spawns on the first `daimon` call that needs it. To suppress: `DAIMON_NO_SPAWN=1` or `--no-spawn`. To target a non-default daemon: `DAIMON_PORT=5000`.

## CLI

Generated from `src/cliSurface.ts` — the single source of truth that also renders `--help`, shell completion, and the docs site.

```bash
# lifecycle
daimon start <name> [--with-deps] [--steal]
daimon stop <name> [--steal]
daimon restart <name> [--steal]
daimon test <name> [--timeout <dur>] [--steal]   # run the app's own test suite; exit 0/1/2/5 (v0.12)
daimon mute <name> [--for <dur>] / daimon unmute <name>   # silence OS notifications per app (v0.13)
daimon up [<profile>]              # topological start; waits for each to reach serving
daimon down [<profile>]
daimon run <name> <task> [--watch] [-- args...]
daimon clean <name> [--deep] [--yes]
daimon daemon start|stop|status|restart|attach|install-service

# queries
daimon list [--tag <name>] [--workspace <label>] [--full|--compact] [--stream] [--explain]
daimon status <name> [--full|--compact]
daimon errors <name> [--since 2m] [--since-last] [--client <id>] [--structured]
daimon events [--since 1h] [--app <name>] [--stream]
daimon logs <name> [--tail N] [--since 30s] [--level error|warn|info|debug] [--grep <regex>] [--stream]   # --level: classified lines only (v1.2); --grep/--stream: filtered live tail (v0.12)
daimon history <name>              # uptime%, restart count, compile p50/p95, top errors
daimon search <query> [--app <a>] [--since <dur>] [--kind logs|errors|events]   # full-text search (v0.12)
daimon test-history <name> [--flaky] [--limit N]   # recent test runs / flaky tests (v0.12)
daimon report [--since 24h|7d] [--app <a>] [--workspace <l>] [--md]   # the digest (v0.13)
daimon export [--since 7d] [--app <a>] [--format json|md|csv] [--out <file>]   # one-way carry-out bundle, schemaVersion 1 (v1.4)

# agent verbs
daimon wait <name> [--until serving|healthy|stopped|error] [--timeout 120s]
daimon ensure <name> [--until serving|healthy] [--timeout 180s]
daimon ensure-up <profile> [--until serving|healthy] [--timeout 300s]
daimon overview [--workspace <label>] [--profile <name>] [--budget <tokens>]   # decision-ready snapshot
daimon context <name> [--budget <chars>]   # agent context pack: 6 round-trips in 1 (v0.12)
daimon focus <name> [--until serving|healthy|stable] [--timeout 180s]          # one-shot subscribe-then-act
daimon try-fix <name> [--until serving|healthy] [--timeout 180s]               # doctor + restart + wait
daimon orchestrate <profile> [--goal serving|healthy|stable] [--dry-run] [--budget <tokens>]
daimon agents [--json]             # roster: ids, action counts, held locks, contention (v1.6 deepened; identity advisory)
daimon audit [--agent <id>] [--app <name>] [--since 2h] [--limit 100] [--json]   # the queryable audit trail (v1.6)
daimon handoff <app> <agentId>     # transfer a soft-lock to another agent (v0.10)
daimon profiles suggest [--since 30d] [--min 5]   # profile candidates from co-starts (v0.10)
daimon ci start <profile> [--until ready|healthy] [--timeout 5m] [--json]      # CI helper (v0.10)

# introspection
daimon why <name>                  # crash forensics: last crash + errors + storms + envChanged + suspect commit
daimon why-empty                   # explain an empty `daimon list`
daimon env <name> [--use <file>]   # env-file awareness: files, key names, snapshot age (v0.13); --use sets the active file
daimon env diff <name> [--from <ts>] [--to <ts>]   # files/keys added/removed/changed between spawns (v0.13)
daimon ports                       # app → port → source (pinned|pool|announced) → pid + foreign holders (v0.13)
daimon discover                    # read-only discovery pass: scanned/rejected counts per folder
daimon timeline [--since 7d] [--app <name>] [--kinds status,error,warning,lint,bundle,task]
daimon tasks <name>                # discovered non-serve tasks
daimon snapshot <name>             # bundle state for bug reports
daimon record / replay <session.jsonl> [--speed N]
daimon doctor [--auto-fix] [--dry-run] [--self]
daimon free-port <port> [--force]
daimon self                        # daimon's own runtime metrics
daimon dashboard                   # open the dashboard scoped to cwd

# config
daimon init [--force] [--auto]
daimon config validate [<path>]    # unknown keys warn with the nearest valid name (v0.14)
daimon pin-health <name> [--accept] [--path <p>]
daimon export-config [--redacted]
daimon workspaces list|add|rm|show
daimon completion <bash|zsh|fish|powershell>

# claude / plugins
daimon claude install|update|uninstall|status
daimon plugins [--json]            # loaded plug-ins: apiVersion, status, hooks, errors (v1.5 — see PLUGINS.md)
daimon plugin list|show <name>|validate <path>   # validate checks a file offline against Plugin API v1
```

All CLI commands print compact JSON on stdout by default (`--full` for the verbose v0.4 shape). Errors are compact JSON on stderr with non-zero exit. Exit codes: `0` success, `1` generic error, `2` timeout (used by `daimon wait`, `daimon focus`, `daimon ensure*`, `daimon ci`), `5` soft-lock held by another agent (pass `--steal` to override).

## HTTP API

Bound to `127.0.0.1:<apiPort>` only. The dashboard at `/` is an Angular 20 SPA (Material 3, zoneless, signals) bundled into the published tarball — it shows apps, errors grouped by file/app/tool, live logs, doctor, trends, regressions (chord `g r`), settings editor, and one-click actions.

```
GET  /api/apps                                  # compact by default; ?format=full for v0.4 shape; ?tag=&workspace= filter server-side (v0.14)
GET  /api/apps/:name
GET  /api/apps/:name/errors[?since=2m]
GET  /api/apps/:name/errors/since-last?client=<id>
GET  /api/apps/:name/logs?tail=N&since=30s&grep=<regex>&level=error|warn|info|debug
GET  /api/apps/:name/logs/stream[?grep=<regex>&level=<lvl>&levels=1]  # SSE filtered live tail (v0.12); level/levels=1: v1.2
GET  /api/apps/:name/wait?until=serving&timeout=60   # seconds; ?timeoutMs= also accepted (v0.14)
GET  /api/events[?since=5m&app=<name>&stream=ndjson]
GET  /api/agents                                # active agents + soft-locks (v0.10)
GET  /api/profiles/suggest                      # profile candidates from co-starts (v0.10)
GET  /api/overview[?budget=<tokens>&workspace=&profile=]
GET  /api/discovery/explain
GET  /api/history/{events,compile-times,tasks,summary/:name,why/:name}
GET  /api/history/trends?app=&metric=&since=
GET  /api/history/bundles?app=
GET  /api/tests?app=&limit=&since=              # test-run history + failures (v0.12)
GET  /api/tests/flaky?app=                      # flaky tests at each gitHead (v0.12)
GET  /api/search?q=&app=&since=&kind=           # full-text search (v0.12)
GET  /api/why/:name                             # crash forensics composition (v0.12; + envChanged v0.13)
GET  /api/context/:name?budget=                 # agent context pack (v0.12)
GET  /api/report?since=&app=&workspace=[&md=1]  # the digest (v0.13)
GET  /api/export?since=&app=&format=json|md|csv # one-way carry-out bundle, schemaVersion 1 (v1.4)
GET  /api/audit?agent=&app=&since=&limit=100    # queryable audit trail (v1.6, experimental; advisory identity)
GET  /api/agents                                # active agents + locks; v1.6 adds derived roster + contention
GET  /api/env/:name                             # env-file awareness — names only, never values (v0.13)
GET  /api/env/:name/diff?from=&to=              # env diff between spawns (v0.13)
GET  /api/ports                                 # port map + foreign holders (v0.13)
GET  /api/signature                             # daimon identification for port forensics (v0.13)
GET  /api/config                                # current config (env redacted)
POST /api/apps/:name/(start|stop|restart|snapshot|clean|run/:task)[?steal=1]
POST /api/apps/:name/(mute|unmute)              # per-app notification mute (v0.13)
POST /api/apps/:name/test?timeoutMs=[&steal=1]  # run the test suite, soft-lock gated (v0.12)
POST /api/apps/:name/handoff                    # transfer soft-lock (v0.10)
POST /api/apps/:name/focus?until=…              # NDJSON event stream
POST /api/apps/:name/try-fix?until=…
POST /api/apps/:name/health/pin
POST /api/orchestrate?profile=&goal=&timeoutMs=&dryRun=&budget=
POST /api/doctor/auto-fix[?dryRun=true]
PATCH /api/config                               # If-Match: <etag>; 412 on conflict
POST /api/config/reload                         # soft reload — no running children killed
POST /api/shutdown
```

Every request may carry `X-Daimon-Agent` (the CLI and MCP server always send it); lifecycle routes use it for soft-lock gating, and it lands in the audit log. If `config.apiToken` is set, mutating endpoints require `Authorization: Bearer <token>`. Read endpoints stay open.

## Claude Code integration

```bash
daimon claude install        # writes a single SKILL.md (no per-command slash files since v0.5)
```

Daimon installs a single skill at `~/.claude/skills/daimon/SKILL.md` (~120 useful tokens) that documents every verb inline. Old per-command `~/.claude/commands/daimon-*.md` files from v0.3/v0.4 are removed (or renamed to `.bak` if you've edited them since install). An optional `~/.claude/agents/daimon-runner.md` subagent can be installed with `--agent`.

The skill is rendered from a single source of truth (`src/cliSurface.ts`) so it cannot drift from the actual command surface.

Daimon stamps the current version into the artifact frontmatter. When you upgrade daimon, the next CLI call nudges you (once per 24h) to run `daimon claude update`. Silence with `DAIMON_NO_CLAUDE_NUDGE=1`.

```bash
daimon claude status        # what's installed and at which version
daimon claude update        # refresh based on the install manifest
daimon claude uninstall
```

For raw MCP use:

```bash
claude mcp add daimon -- daimon mcp
```

The MCP server exposes 33 tools: `list_apps`, `get_status`, `get_errors`, `get_logs`, `start_app`, `stop_app`, `restart_app`, `wait_for_app`, the agent-first verbs `overview`, `ensure`, `ensure_up`, `focus`, `try_fix`, `diff_errors`, `orchestrate`, the v0.10 coordination tools `daimon_who_owns`, `daimon_subscribe_events`, `daimon_notify_on_error`, `daimon_frameworks`, the v0.12 whole-loop tools `daimon_context`, `daimon_run_tests`, `daimon_why`, `daimon_search`, the v0.13 pair `daimon_report`, `daimon_env`, the v1.1 `daimon_groups` (with `ensure_up` resolving groups first and `stop_app` falling back to a group where the app name previously errored), the v1.3 `daimon_top` (live RSS/CPU table — warn-only, never kills), the v1.4 `daimon_export` (the one-way carry-out bundle), the v1.6 agent-ledger pair `daimon_audit` / `daimon_agents`, and the v1.8 `daimon_sessions` (walk history by derived work session). Every MCP call forwards the same `X-Daimon-Agent` identity as the CLI. The recommended session opener is `overview`; when debugging one app, `daimon_context` first, then targeted calls.

The v1.6 server also grows the protocol's own shapes (all `experimental`): three read-only **resources** — `daimon://report`, `daimon://context/{app}`, and `daimon://logs/{app}` (200-line tail), each a thin wrapper over the matching HTTP endpoint — and two **prompts** rendered from live API data, `triage` (why + errors + recent logs for one app) and `handoff` (current state + lock holder for the next agent). A client can read a resource or expand a prompt without the model choosing a tool call.

## State files (in `~/.daimon/`)

Relocatable since v0.12: set `DAIMON_HOME=<dir>` to move the entire state directory (lock, config, history DB, logs, plugins, snapshots, sessions) — handy for test harnesses and side-by-side setups. `daimon doctor` prints the active home.

- `config.json` — your config (above)
- `daemon.lock` — `{ pid, apiPort, version, startedAt, headless }`
- `state.json` — sticky port assignments; since v0.13 also per-app notification mutes and digest last-sent timestamps. Written atomically with a `.bak` of the last good version; a corrupt file recovers from the `.bak` or is archived as `state.json.corrupt-<ts>` with a fresh start (v0.14)
- `salt` — per-install random salt for env-snapshot value hashes (v0.13; deleting it only resets change-detection baselines)
- `cursors.json` — per-client error cursors for `--since-last`
- `history.db` — SQLite of events, compile times, task runs, test runs, crashes, env snapshots, and per-app bundle sizes (powers the Trends dashboard). If it's corrupt at startup, daimon archives it as `history.db.corrupt-<ts>` and rebuilds automatically (v0.10).
- `logs/<name>.log[.N]` — when `logs.enabled` is true
- `snapshots/<name>-<ts>.json` — `daimon snapshot` output
- `notifications.log` — desktop notification audit
- `crashes/<ts>.txt` — daemon fatal dumps
- `audit.log` — config edits + lifecycle actions, tab-delimited, with the acting agent id in the 6th column (v0.10)
- `secrets.json` — `${NAME}` substitutions for `overrides.env`
- `sessions/<ts>.jsonl` — `daimon record` output

## Migrating from v0.3 (when it was `appman`)

- Binary renamed: `appman` → `daimon`. `npm start` is no longer the way; use `npm i -g daimon` then `daimon daemon start`.
- Environment variables: `APPMAN_PORT` → `DAIMON_PORT`, `APPMAN_NO_SPAWN` → `DAIMON_NO_SPAWN`, `APPMAN_TOKEN` → `DAIMON_TOKEN`, `APPMAN_NO_CLAUDE_NUDGE` → `DAIMON_NO_CLAUDE_NUDGE`.
- Config file: `appman.config.json` → `daimon.config.json` (filename change only; schema is preserved).
- State directory: `~/.appman/` → `~/.daimon/`. If you had v0.3 state, move it: `mv ~/.appman ~/.daimon`.
- Claude artifacts: `~/.claude/skills/appman/`, `~/.claude/commands/appman-*.md`, `~/.claude/agents/appman-runner.md` → run `daimon claude install --all` after upgrading to write the new paths. Delete the old appman-named files manually if desired.

## Migrating from v0.2 (`summary.url` semantics)

The `summary.url` field returned by the API was synthetic `http://127.0.0.1:<port>` in v0.2. From v0.3 onwards it is the **resolved probe URL** — `overrides.<name>.url` overrides win, then `healthProbe.scheme`/`host`, then the URL the dev server announced (`Local: …`), then a fallback host. Field name unchanged; value is more accurate (HTTPS, IPv6, custom paths all preserved).

## Tests

```bash
npm test
```

1102 `node:test` cases across small focused files: dependency-graph math, bundle parsing, notifier throttling, regression detectors (compile-time / bundle / error-flap), the parser fixture corpus (see `test/fixtures/parsers/`), the framework adapter test kit (one fixture per registry profile under `test/fixtures/frameworks/` — a profile without a fixture doesn't ship), `overview` budget truncation, auto-fix rule registry, `orchestrate` dry-run/cascade/try-fix paths, polyglot discovery, agent identity + lock contention, audit-log round-trips, webhook dispatch (including a real HTTP delivery and per-app scoping), error-fingerprint grouping, corrupt-history recovery, a 50-app / 100k-event perf bench with hot-path budgets, and MCP contract checks. Tests run against compiled `dist/` and never start the real daemon.

## License

**[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)** — see `LICENSE`.

- Free for personal, hobby, academic, and other noncommercial use
- Free for charities, schools, government, and other noncommercial organizations
- **Not licensed for commercial use** (use by or for a for-profit business)

For a commercial license, get in touch via <https://flycotech.com>.
