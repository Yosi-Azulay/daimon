# daimon v1.13.0 — "Terminal Native"

Part 3 of the UI redesign trilogy (M162–M167), and the one the oldest surface
was owed. v1.11 gave the dashboard a visual language. v1.12 gave it an
information architecture. v1.13 brings both to the TUI — and makes every chord
discoverable.

**This release lives entirely under `src/tui/`.** Zero daemon, CLI, HTTP, or MCP
change. No new config key, no history migration, no new dependency, no frozen
shape moved.

---

## Migration

**None.** Upgrade and carry on.

- **Chord changes: NONE.** Every chord that worked in v1.12 works in v1.13 —
  same key, same meaning, same pane. Nothing was remapped, so there are **no
  legacy aliases** to learn or remember. `test/tui-chords.test.mjs` holds a
  frozen inventory of the v1.12 chord set and fails if any of it moves.
- **No daemon, CLI, HTTP, or MCP surface changed.** No new verbs, endpoints, MCP
  tools, or event kinds.
- **No config key added or changed.** No `daimon.config.json` edit is needed.
- **No history migration.** The SQLite schema is untouched; a v1.12 database
  opens unchanged, and a v1.13 database opens under v1.12.
- **No new dependency.** The ink stack is exactly what it was.

The one visible difference to a returning user is that **`compiling` now renders
cyan instead of yellow** on color terminals, so it is distinguishable from
`starting` at a glance. That is DESIGN.md's own status mapping (v1.11), applied
to the terminal.

---

## What changed

### Press `?`

The TUI had nineteen chords you could find only by reading the source or
squinting at a one-line footer. `?` now opens a full keyboard reference, grouped
by pane, with the pane you are focused on listed first. It scrolls, and it works
at 80 columns.

### One chord map, and it cannot drift

Every chord is now a row in `src/tui/chords.ts`: key, pane scope, description,
group, legacy aliases. Dispatch reads it. The `?` overlay renders from it. The
per-pane footer hints render from it. The docs cheat sheet and the README table
are generated from it.

Two mechanisms keep that true:

- **Compile time** — App's handler table is `Record<MainChordId, Handler>`, so a
  chord added to the map with no handler (or a handler for a chord that is not
  in the map) fails `tsc`.
- **Test time** — `test/tui-chords.test.mjs` fails if any compiled TUI component
  hand-lists a chord ribbon, or if the docs or README fall behind the map.

This is not hypothetical. Through v1.12 the log pane's footer read
`[g/G] bottom/top` while its code did the exact opposite: `g` scrolled to the
**oldest** lines and `G` to the newest. Per the locked rule, code wins — `g` is
top/oldest, `G` is bottom/newest, which also matches vim and the timeline pane's
own `g`/`G`. That bug is what motivated the milestone.

The three hand-written footers v1.12 shipped (App's ribbon, LogPane's ribbon,
and `keys.ts`'s `KEY_HELP`) are gone. `src/tui/keys.ts` was deleted.

### A real pane system

App list, detail, and log are three first-class panes with a **visible focus
model**. `Tab` cycles focus; the focused pane is marked on its border and title.
`l` still focuses the log, `Shift+L` still maximizes it, and `q` in the
maximized pane still returns to the list — exactly as the full-screen log pane
always behaved.

Chords are **pane-scoped**, which is how the same physical key means two things
without colliding:

| Key | In the app list | In the log pane |
| --- | --- | --- |
| `l` | focus the log pane | cycle the level filter |
| `/` | filter apps by name | grep the log |
| `g` | view hints (`g` then `a/e/v/s/n`) | scroll to top (oldest) |
| `G` | cycle the group filter | scroll to bottom (newest), resume follow |

That coexistence predates this release — v1.12 had it too, undocumented and
enforced by nothing. Now it is data, and a test asserts that no two chords in
the same pane ever claim the same key.

### A persistent status bar

One always-visible line: daemon state and api port, workspace, active filters
(name / tags / group) with a `visible/total` count, muted-app count, live log
storms, and the transient flash messages folded in as the last segment so they
never displace permanent state. It truncates to the terminal width and can never
wrap the layout down a row.

Resizing the terminal re-layouts **immediately**, on the resize signal, instead
of waiting for the next tick.

### The log pane finally says what it knows

daimon has classified log levels and detected log storms since v1.2. The TUI
showed neither.

- **Levels** — error / warn / info lines render tinted. A line whose level is
  `null` stays **plain**. daimon never guesses a level client-side; the v1.2
  fail-soft rule says an unclassified line is data, not a default.
- **Follow mode** — was implicit (whatever happened when `scroll === 0`). Now
  the header reads `[following]` or `[paused]`; scrolling up pauses it, `G`
  resumes it.
- **Grep** — still narrows the stream by default, byte-identical to v1.2. `Tab`
  inside the search input switches to a highlight mode that keeps every line in
  view so `n`/`N` can walk the matches. `Esc` still clears the pattern.
- **Storms** — an app in a v1.2 `log-storm` episode shows a marker in the pane
  header and the status bar; it clears on `log-storm-end`.

### Plain terminals and SSH are first-class

No feature requires a mouse or truecolor. `src/tui/theme.ts` is the one place
terminal color lives, with a three-rung ladder:

- **truecolor / 256** — DESIGN.md's own OKLCH status hues converted to sRGB.
  Four of them (`#a3b2fd`, `#6cc9f7`, `#f6b669`, `#fb7c70`) land byte-identical
  on the dashboard's `--dm-chart-*` dark values, which is the cross-check that
  the conversion is right. Every value clears 4.5:1 on a dark terminal; the one
  deliberate departure is `stopped`, lifted from L 0.560 to L 0.600 because
  DESIGN.md's value reads 4.20:1 in a terminal.
- **16-color** — a hand-picked ANSI name per role, never an auto-quantization of
  the hex. These are the colors daimon painted through v1.12, so a 16-color
  terminal looks exactly as familiar as it always did.
- **`NO_COLOR`** — zero SGR color codes, verified by mounting the real TUI and
  scanning the emitted bytes. Semantics carry on bold / dim / inverse, and every
  feature still works.

`STATUS_COLORS` and `HEALTH_COLORS` were duplicated verbatim in `App.tsx` and
`AttachApp.tsx`; they now exist once, and a test fails any component that
hard-codes a color — DESIGN.md's token rule carried from the dashboard to the
terminal.

**Verification matrix:** Windows Terminal (truecolor, via `WT_SESSION`), Windows
conhost (16-color — no `TERM`, no `COLORTERM`), and a plain SSH-style
`TERM=xterm` (16-color) are each covered by a detection test, and the `NO_COLOR`
rung is verified by a real render. Detection is a pure function of the
environment — no chalk import, no new dependency.

### Robust at 80 columns and 100 apps

- **Narrow terminals** — columns hide in priority order: cpu/mem first (the
  exact `cols >= 100` cutoff daimon has always used), then the framework badge
  below 80. Status is never dropped. Below 60 columns the layout collapses to a
  single pane rather than corrupting two. A real render at 80 and at 56 columns
  asserts that no row overflows the width.
- **Long lists** — the app list is windowed. A 100-app registry renders one
  viewport with a `3/40` position indicator instead of 100 rows, and the
  selection is always in view (asserted walking 0 → 99).
- **Flicker** — the unconditional 1-second full-tree interval is gone. Updates
  ride the registry `change` / `event` subscriptions that already existed,
  leaving one slow tick for derived clock values (uptime). Idle timer-driven
  re-renders drop from 60/min to 12/min, pinned by a budget test that also fails
  if a second interval or a 1s interval reappears.

---

## Deliberate deviation from the plan

M166's acceptance line asked for `PgUp`/`PgDn` to page the **app list**. In
v1.12 those keys scrolled the **log**, and *muscle memory is sacred* is a locked
rule that outranks an acceptance detail — so `PgUp`/`PgDn` still page the log,
in every pane. The 100-app list is fully navigable via `j`/`k` with windowing,
which the tests cover end to end.

Raising this rather than silently choosing: if list paging is wanted, it needs a
key that was previously unbound, in a later release.

---

## Gates

| Gate | Result |
| --- | --- |
| `tsc` (3 projects) | clean |
| `npm test` | 1102 cases, 0 fail |
| Bundle (dashboard untouched) | unchanged, under the 150KB gzip budget |
| Chord-map drift test | green |
| Redaction + contract suites | green |
| Platform-branch inventory | green (no new `process.platform` fork) |

---

## Pre-tag review

`/review-daimon` ran 19 agents across the five recurring failure classes; 7 raw
findings, 4 survived adversarial verification. All four were in this release's
own new code, and all four are fixed:

- **The anti-drift gate had a hole, and a real ribbon was already through it.**
  The gate scanned only compiled output, where tsc splits a JSX literal at its
  interpolation — so LogPane's hand-written `[Tab] … [Enter] keep [Esc] clear`
  grep hint read as two pairs, not three, and passed. The grep input's keys are
  chords in the map now (a modal `grep` scope), the hint renders from it, and
  the gate counts `[key]` tokens per line across **source and** compiled output.
  Verified against all three historical ribbons, with no false positives.
- **The README/docs drift gates only compared descriptions**, so re-binding a
  key would have rotted both generated tables silently. The README gate now
  compares whole (key, description, panes) rows for set equality; the docs gate
  checks keys too.
- **The `NO_COLOR` test passed vacuously.** ink paints through chalk, and chalk
  resolves to level 0 whenever stdout is a pipe — always true under
  `node --test` — so no color was emitted either way and a monochrome-rung
  regression would have shipped green. There is now a CONTROL test proving the
  harness detects color when chalk can paint, and the `NO_COLOR` assertion runs
  with chalk forced on, so it tests the theme rather than the pipe.
- **The new session-bench ratio ceiling was miscalibrated.** It was derived from
  an assumed ~10ms CPU reference; the spin actually measures ~18ms here, which
  made the effective budget ~1.6s instead of 300ms — a loosened budget, which
  this repo does not allow. The reference is measured now (15 samples, median
  18.1ms) and the ceiling is 48.

Rejected by verification: an unquoted `$EDITOR` temp path (real mechanism, but a
byte-identical line unchanged since v0.3, so not this diff's defect), Tab being
undiscoverable (it is in the map and rendered inline), and harness flakiness
(the claimed failure mode is already guarded).

---

## Files

New: `src/tui/chords.ts`, `src/tui/theme.ts`, `src/tui/layout.ts`,
`src/tui/renderBudget.ts`, `src/tui/HelpOverlay.tsx`,
`scripts/build-readme-chords.mjs`, and six test files (`tui-chords`,
`tui-theme`, `tui-layout`, `tui-log-pane`, `tui-render-budget`,
`tui-render-smoke`).

Deleted: `src/tui/keys.ts` (its `KEY_HELP` was a hand-written ribbon, now
generated).

---

© Yosi Azulay · <https://flycotech.com> · PolyForm Noncommercial 1.0.0
