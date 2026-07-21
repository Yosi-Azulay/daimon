# daimon v1.14.0 — "First Run"

Onboarding (M168–M172). Every doc daimon shipped was written for its author.
This release is written for the stranger: from `npm i -g daimon` to a working
setup in five minutes, without reading source.

The doorstep, before today: `daimon init` hard-coded four marker files while
`discovery.ts` knew the whole framework registry — the wizard and the daemon
literally disagreed about what was in the folder. A dashboard with zero apps
was an empty table. The README opened with architecture. And "I ran it in the
wrong directory" produced silence instead of a doctor finding.

**Nothing here records anything new, and nothing phones home.**

---

## Migration

**None.** Everything is additive.

- **`daimon init` keeps its `stable` tier and its flags.** `--auto` and
  `--force` mean exactly what they meant; only the detection underneath
  changed (a hard-coded marker list → the real discovery scan). The new
  proposal flow, `--yes`, and the proposal JSON ship `experimental`.
- **The wizard's `~/.daimon/config.json` target is gone from the flow.** The
  file is still honored if you have one — only the prompt that offered to
  write it is gone. init now writes exactly one file: `daimon.config.json` in
  the current directory.
- **The Claude-install prompt is gone from `init`.** `daimon claude install`
  is unchanged; init points at it instead of running it.
- **One new persisted field:** `tuiHintSeen` in `~/.daimon/state.json`
  (additive, optional, merge-written). A v1.13 state file loads unchanged, and
  a v1.14 state file loads under v1.13.
- **No new HTTP endpoint, config key, dependency, or history migration.** No
  frozen shape moved.
- Config-missing hints now say `daimon init --yes` instead of
  `daimon init --auto`. Both still work.

One behavior change worth knowing about, because it is a fix you can feel:
**consecutive daimon commands from the same terminal now share one advisory
agent identity** (see *The bug the docs gate found*, below). If you have
scripts that relied on every invocation being a distinct agent, pin
`DAIMON_AGENT_ID` per call — it still wins over the derived value.

---

## What landed

### M168 · `daimon init` rebuilt on the real discovery scan

init is now a thin interactive UI over `discoverApps()`. Its private
`MARKERS` list — `nx.json`, `angular.json`, `vite.config.*`, `.storybook` —
is **deleted, not extended**. One scan, one truth:

- It proposes exactly what `daimon list` will find, because it is the same
  code path, honoring the framework registry, the workspace enumerators, and
  the fallback precedence.
- Every profile in the registry now reaches the wizard for free. A Django
  project, a Rails app, a `*.csproj`, a bare `package.json` with a `dev`
  script — all invisible to the old wizard, all detected now. **A new
  framework row lights up in init with no init change at all.**
- `--yes` accepts the proposal non-interactively and prints the proposal JSON
  it accepted, for scripts and agents.

**Overwrite safety is the release's one correctness-critical surface**, and it
is tested from both directions: `--yes` against an existing config exits
non-zero with the file's mtime and bytes asserted unchanged; an interactive
decline leaves the file byte-identical; `--force` keeps its documented
meaning. A filesystem-sentinel test asserts the run created **exactly one
file** and touched nothing else — no `~/.daimon` write, no source edit, no
daemon start. A directory where discovery finds nothing still succeeds,
writing a usable config and explaining what was rejected and why.

### M169 · Dashboard first-run

A zero-app workspace renders a walkthrough card on `/` and `/apps` — the
copy-able `daimon init` command, what happens next, a pointer to QUICKSTART —
instead of an empty table. The errors / tests / report / logs empty states
explain what will appear there and which action produces it. Dismissal lives
in **localStorage only**: no telemetry, no phone-home, no request that is not
loopback. Strictly presentational, on the v1.12 IA — no new route, no new
endpoint, nothing in `server.ts`.

### M170 · QUICKSTART, README, and a TUI hint

**QUICKSTART.md is executable documentation.** `test/quickstart.test.mjs`
extracts every fenced `bash` block and runs it, in page order, against a clean
`DAIMON_HOME` in a temp workspace. Only two blocks are exempt — the global
install and the browser-opening `daimon dashboard` — and each carries a stated
reason the test asserts. The page opens with the **three-line hand-written
config**, because a hand-written config stays first-class and the wizard is
optional; `daimon init` follows as the shortcut.

The README now leads with install and the first-run path, linking QUICKSTART
from the first screen; architecture moved below the fold. The TUI shows one
hint on its first attach ever, pointing at v1.13's `?` overlay — with the key
read from the chord map, so a future remap can't leave the hint lying.

### M171 · Doctor learns the first-run mistakes

Four suggest-only rules, each naming what to do next:

| Rule | Fires when |
| --- | --- |
| `config-wrong-directory` | No config in cwd, but one exists in a parent — or only the global `~/.daimon/config.json` was found. Names the file daimon actually loaded. It never invents a `--config` flag, because daimon doesn't have one. |
| `daemon-not-started` | A config is present and **nothing at all** answers on apiPort. Distinct from the port-holder rules, which own the "something else has it" case. |
| `no-apps-detected` | Config loads, discovery returns zero apps. Surfaces the single likeliest cause from discovery's own `stats.rejected` tally — a missing searchRoot, no serve target, a fallback superseded by a named profile — never a generic guess. |
| `port-pool-absent` | Detected profiles declare `portFlag`/`portEnv` but no `ports.pool` is set, so they will collide on the framework's default port. Proposes the key; never writes it. |

None of them gets an auto-fix: nothing here meets the verify-then-kill bar.

---

## The bug the docs gate found

The QUICKSTART test was written to prove the five-minute path works. On its
first run it proved the opposite, twice.

**`daimon daemon start` runs in the foreground.** The page said it backgrounded
the daemon. The gate exited non-zero and printed a TUI. The page now says
`daimon daemon start --detach`, and explains the flag.

**And then the real one.** The CLI derived its advisory agent identity as
`<host>-<pid>-<rand4>` — freshly minted per process. Two consecutive commands
from one shell were therefore two different agents, so `daimon start web` took
its 30-second soft lock and the `daimon stop web` typed a second later was
**denied by it**:

```
error: app 'hello-web' is locked by agent desktop-nka51dj-32644-c2c2 (expires …)
hint: pass --steal to override, or wait
```

That is the second command a new user ever runs, refused by daimon's own
coordination machinery. The identity is now derived from the parent process —
the terminal — so one shell keeps one identity across invocations, while a
second terminal, an editor, or a Claude Code session each still get their own
and the multi-agent protection those exist for. The shape is unchanged, the
identity stays **advisory** (an unauthenticated header, never an authorization
decision), and an explicit `DAIMON_AGENT_ID` still wins.

Neither bug was found by reading. Both were found by making the documentation
run.

### And one the Playwright gate found

Running the dashboard drive against a daemon that actually had apps registered
surfaced a third, older bug — a **deep-link break that shipped in v1.12 and
survived v1.13**:

```js
history.replaceState(history.state, '', '#' + id);   // in scrollToSection
```

A **bare** fragment resolves against the document's base URL, and index.html
sets `<base href="/">` — so this threw the `/apps/<name>` path away. Every
legacy `?tab=errors|logs|history|why` deep link (a permanent back-compat shape
since M85) landed on `/#errors`: the overview home, not the app. Scrolling to
any section corrupted the address bar the same way, so a URL copied after a
click pointed somewhere else entirely.

It survived two releases because **the gate skipped itself**: the redirect
suite called `test.skip()` for every `:name` route when no app was registered
on the daemon under test, and the e2e environment had none — so it reported
green while verifying nothing. Both are fixed: the fragment now preserves path
and query, and a missing app is a loud failure with a remedy instead of a
silent skip. The deep-link suite passes 31/31 against a daemon with a mixed
multi-framework workspace, and a regression test asserts the app path survives
a section scroll.

---

## Numbers

- **Backend suite: 1130 tests, 0 fail** (v1.13.0: 1102), verified green on three
  consecutive runs. New files: `init-wizard`, `quickstart`, `tui-first-run`,
  `doctor-onboarding`.
- **Dashboard vitest: 140** (v1.13.0: 130).
- **Playwright: 57/57** on the gates this release owns — first-run states (6),
  the full a11y/axe sweep (20, zero serious/critical), and deep-link
  back-compat (31/31, both viewports for the first-run spec).
- **Dashboard bundle: unchanged budget, still under the 150KB gzip gate.**
- No new dependency in any of the three projects.

### A note on how the suite stays honest

The quickstart gate starts a real daemon and a real dev server. Inside the
40-way parallel suite that load made two timing-sensitive files
(`plugin-isolation`, `resource-sampling`) flake 1–2 tests per run. The fix was
to **remove the contention, not to accommodate it**: `npm test` now runs the
parallel suite first and this one integration gate after it, sequentially.
`resource-sampling.test.mjs` keeps its committed thresholds byte-for-byte — no
perf budget was loosened, which is the standing rule.

---

## Out of scope, permanently

Accounts, signup, identity. Telemetry, analytics, install pings, "anonymous
usage stats". Auto-installing anything. Editing user projects, source files, or
`.env`. A hosted onboarding site. Remote or non-loopback access, multi-user,
cloud sync.

daimon has no users but the one at the keyboard.
