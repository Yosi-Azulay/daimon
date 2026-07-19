# daimon v1.8.0 — "Rewind"

daimon's history answered point questions well — `search` found a line, `why`
explained a crash, `report` summed a window. But 100k events were a flat stream
with no shape: no notion of "that work session on Tuesday," no time surface to
scrub, and nothing that greeted you after a weekend to say what happened while
you were away. v1.8 is **rewind**: history gets its natural unit (the session),
a way to walk it (the timeline), and a summary that answers "what did I miss"
before you ask.

```bash
daimon sessions                       # work sessions, newest first — each a daemon-uptime slice
daimon sessions show s-1721400000000  # one slice expanded: apps, errors, tests, compiles, crashes, env
daimon why web-admin                  # now situates the failure in its session
# TUI: press `i` to walk the timeline by hour/day; the header greets a gapped attach
# Dashboard: the timeline route brushes/zooms, and every deep-link lands there
```

Sessions are **derived, never recorded.** A session is a contiguous
daemon-uptime slice — there is no sessions table, no session events, no new
analytics state, and no history migration. Derivation is a pure function over
existing history plus two additive daemon-lifecycle boundary markers, recomputed
on demand (and benched under budget, so no cache ships).

## What's new

- **Session derivation + `daimon sessions` (M134, experimental)** — the daemon
  now records `daemon-start` at boot and `daemon-stop` at clean shutdown under
  the synthetic `__daemon__` app (two additive `experimental` event kinds, the
  same category as the existing `self-warn`/`digest-sent` markers). From those,
  `src/sessions.ts` **derives** sessions by pure composition: a start opens a
  slice, its matching stop closes it cleanly; a boot with no intervening stop
  closes the previous slice **unclean** (`endedCleanly:false`) at its last
  observed event (a crash or kill); the newest open slice is `current:true,
  end:null`. IDs are deterministic — `s-<startMs>`, stable across
  re-derivations so a deep link minted today still resolves tomorrow.
  `daimon sessions [--since 7d] [--json]` and `GET /api/sessions` list each
  slice with its apps touched and error/test/compile counts; `daimon sessions
  show <id>` and `GET /api/sessions/<id>` expand one slice into a closed block
  list, every block degrading to a `{ note }`. MCP `daimon_sessions`
  (**33 tools**). Derivation on the 100k-event corpus benches **< 300ms**.
- **"While you were away" (M135, experimental)** — the first attach after a gap
  answers "what did I miss." The baseline is the later of the last
  acknowledgement and the previous session's last event; a gap over **4 hours**
  (a fixed constant — v1.8 adds zero config keys) composes one summary of new
  errors, resolved errors, crashes, and env changes. It **reuses the report
  composition** — not a new engine, not a new timer — the TUI in-process, the
  dashboard via `GET /api/report?since=`. One dismissible line in the TUI header
  (Esc); dismissal merge-writes an `awayAck` timestamp to `state.json` so it
  never re-nags. Nothing happened → nothing shown.
- **TUI timeline chord (M136, experimental)** — press `i` to walk the event
  stream in the terminal: hour/day buckets (drill day→hour with Enter, Esc
  back), a density sparkline, `←/→` between buckets, `g`/`G` to the oldest/
  newest edge, and `n`/`p` to jump the selected app to its next/previous
  start/stop/crash. Windowed query on open — never a per-keystroke scan; empty
  history shows a note.
- **Dashboard timeline + deep-link convergence (M137, experimental)** — the
  timeline route gains drag-to-brush range narrowing, kind/app filters, and
  keyboard navigation (arrows + Home/End) announced via `aria-live`. It accepts
  `?ts=&app=&kind=&session=`, and search hits + the why panel resolve to a
  timeline position — one convergent "when" surface. A dismissible "while you
  were away" panel greets a gapped load. Lazy chunk; the initial bundle stays
  under budget.
- **`daimon why` session context (M138, experimental additive)** — `why` gains
  `sessionContext`: the failure's session id plus what else happened in that
  slice before it — errors in **other** apps, env changes, compile regressions.
  Composed from the M134 slice queries; degrades to a note and links to the
  timeline via `?session=`. On `GET /api/why`, the CLI panel, and the dashboard.

## Migration & compatibility

**Nothing to migrate.** Sessions are derived from existing history — there are no
new tables, no history migration, and no new config keys.

- **No history migration.** v1.8 adds no columns and no tables. A v1.7
  `history.db` opens unchanged; a v1.8 `history.db` opens clean under v1.7. The
  only new rows are `daemon-start`/`daemon-stop` events in the existing `events`
  table — old daimon reads them as ordinary event rows and ignores the kinds it
  doesn't know.
- **`state.json` gains one additive key, `awayAck`** (a number), written with
  the same merge-write + `.bak` atomicity as `ports`/`mutes`/`digests`. A v1.7
  `state.json` loads unchanged; a v1.8 `state.json` loads clean under v1.7.
- **No new config keys.** The away-gap threshold is a fixed 4h constant.
  `daimon.config.example.json` is unchanged.
- **No frozen shape moved.** The `sessions` verb, `/api/sessions*` endpoints,
  `daimon_sessions` tool, the `daemon-start`/`daemon-stop` event kinds, and
  `why`'s additive `sessionContext` field are all tier `experimental` (or
  additive on a `stable` surface). The contract suite passes untouched.

To opt in: nothing. Run `daimon sessions` to see your work sessions, press `i`
in the TUI or open the dashboard timeline to walk them, and the away summary
appears on its own after a gap.

## What v1.8 deliberately does not add

- **A sessions table / persisted sessions** — sessions are derived, always; at
  most a rebuildable in-memory cache, and only if a bench demands it (it didn't).
- **Event replay or re-execution** — rewind is read-only navigation, forever.
- **Editing or annotating history** (session names, tags, notes) — history is
  what happened; daimon never rewrites it.
- **A new "away" engine, endpoint, or timer** — the summary reuses the report
  composition; the digest's single 1-min interval remains the only scheduler.
- **New config keys** — the 4h gap is a constant.
- **`daimon import`, video/screenshot capture, remote / non-loopback,
  multi-user, cloud sync, telemetry** — standing nos, unchanged.
