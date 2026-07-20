# daimon v1.10.0 — "Featherweight"

daimon's perf story was anecdotal. The budgets that gated every release since
v0.12 were hand-picked absolutes set against a 100k-event corpus; nobody had
ever profiled cold-start, measured what the daemon costs sitting idle, or
proven that search still answers instantly once "everything recorded" means a
million events. Post-1.0, every surface is frozen — which makes this the
right moment to go fast *underneath* them. v1.10 is **certification**: real
baselines recorded on a real machine behind a two-signal quiet detector, a
deterministic 1M-event corpus that certifies six read paths and the write
path under storm load, and every budget derived from measurement —
`baseline p95 × a per-class headroom factor` — never typed in and never
loosened to make a run pass. The scale run found real defects a 100k corpus
never surfaced; each is fixed here with a measured before/after. The
deliverable isn't a feature — it's `PERFORMANCE.md`, with the numbers.

**A no-migration release.** No schema, config, or dependency changes. A v1.9
`history.db` and `state.json` open clean both directions. No frozen shape
moved — the contract suite ran green against both an empty history and the
1M-event corpus.

```sh
node bench/scale.mjs        # certifies the six 1M-corpus read paths against a derived budget
npm run bench                # the full set: baselines + scale + write-path + startup
cat PERFORMANCE.md           # every certified number, with its derivation
```

## What's new

- **The measurement substrate (M145)** — `bench/lib/machine.mjs` is the
  foundation every later gate stands on: a two-signal quiet-machine detector
  (CPU-reference dispersion **and** system-wide busy fraction) and the
  budget-derivation rule itself — `budget = measured quiet-machine baseline
  p95 × a per-class headroom factor` (interactive 2×, startup 2.5×, query 3×,
  batch 3×, write 4×), plus a second contention axis so a parallel build can't
  fake a regression (pass on the absolute budget **or** on the ratio to an
  interleaved CPU-reference workload). Dispersion alone is not enough — it
  reported "quiet" on this 20-core box while the full test suite ran in the
  background, and the resulting baseline would have measured 72% high. A
  contended run is labelled and `--write` refuses it, rather than silently
  baking a bad "before" into every downstream budget. `bench/baselines.mjs`
  records daemon-cold-start (p50 921.5ms / p95 1082.6ms), cli-roundtrip (p50
  323.5ms / p95 399.3ms), idle footprint (RSS p50 68.7MB / p95 85.2MB), and
  tui-attach (p50 917.1ms / p95 1017.6ms), plus per-route dashboard TTI on the
  100k corpus (worst p95 178.7ms on `/doctor`).
- **The 1M-event corpus + six certified read paths (M146)** — `bench/lib/corpus.mjs`
  seeds a deterministic, fixed-seed (`mulberry32`, `SEEDER_VERSION` 2),
  calendar-anchored 1,000,180-event / 2,000,000-log-line / 3,000,221-FTS-row /
  610MB corpus (seeds in ~49s, cached under `bench/.corpus/`, rebuilt past 7
  days old). `bench/scale.mjs` certifies search (both the FTS path and the
  LIKE degraded-fallback path — a search budget means nothing if the fallback
  it can't avoid falls over), `report`, `export`, `sessions`, `why`, and
  `context`, each against a budget derived from its own measured baseline. The
  contract suite runs against the full 1M DB: frozen shapes are identical at 0
  and 1M events.
- **Write-path audit under storm load (M147)** — `bench/writepath.mjs` drives
  sustained event and log-line ingest storms (p95 0.0013ms and 0.0009ms per
  call, both draining to queue depth 0) and measures retention pruning across
  the full 1M corpus, confirming FTS stays entirely off the write path with
  zero per-insert triggers.
- **Startup + the first automated dashboard-bundle gate (M148)** —
  `bench/startup.mjs` certifies the CLI's instant paths against a derived
  budget. `test/bundle-budget.test.mjs` walks the static import graph
  reachable from `index.html` — script/stylesheet/`modulepreload` tags plus
  every transitively statically-imported chunk, deliberately excluding
  dynamic `import()` lazy-route edges — and asserts the real gzipped payload
  stays ≤150KB and real brotli stays ≤140KB. **This is new enforcement, not a
  new number**: nothing previously failed if a stray eager import pushed the
  bundle over budget.
- **Four real bugs the scale run found, each fixed with a measured
  before/after** — `PRAGMA integrity_check` ran on every History open and is
  O(database size): 8303ms → 7ms on the 610MB corpus, via a clean-shutdown
  marker recorded in SQLite's `user_version` header (a DB not closed cleanly
  still gets the full check — corruption comes from unclean shutdown and disk
  failure, and that path is untouched). `daimon doctor`'s full sweep opened
  six independent History handles, each paying that check: ~51s → 5130ms with
  one shared handle. `daimon why` calls doctor on the request path and then
  discards the history-db finding — it was paying the same O(db-size) check
  for a result nobody sees: 6284ms p50 → 58.8ms p50 at 100k (143.8ms p50 at
  1M). Retention pruning blocked the event loop for a single uninterruptible
  28.8s on the 1M corpus (TUI frozen, HTTP stalled, ingest stopped) — now
  time-sliced (p95 144.2ms across 242 slices), semantics unchanged (every
  expired row still goes; `test_failures` still prunes before `test_runs`).
- **Two more fixes, same discipline** — a cold FTS index stalled the first
  search for 51.5s; large backlogs (>10,000 rows, derived from a measured
  17.2µs/row) now answer from the complete-but-slower LIKE path instead
  (≤1.8s worst case) while the idle tick heals the index in the background —
  this trades speed, never correctness, since LIKE scans the base tables and
  read-your-writes still holds. CLI startup cost more than node's own boot
  floor (49ms): `--help` 307ms → 121ms, `--version` 312ms → 121ms, the
  no-daemon error 305ms → 185ms, from deferring the Claude version-drift
  nudge past the fast paths and lazy-loading modules that were previously
  imported at the top level on every invocation.
- **A documentation correction: the dashboard bundle figure was never gzip.**
  Every release note since v1.7 quoted "135.39 KB gz" for the dashboard's
  initial payload. That figure is Angular's "Estimated transfer size" column,
  which since Angular 17 is a **brotli** estimate — it was quoted under the
  wrong label for three releases. Measured directly on this build: raw
  492.7KB, gzip 148.5KB, brotli 132.0KB. The "<150KB gzip" claim still holds,
  but with roughly **1% headroom, not the ~10% everyone believed** — which is
  exactly why the new bundle gate above exists. No dashboard code changed in
  v1.10; the bundle size itself is unchanged from v1.9.
- **`PERFORMANCE.md`** — every number in this release, in one place: the
  measurement environment, the budget-derivation rule with its headroom table
  and contention axis, the 1M-corpus composition and how to regenerate it,
  every baseline and scale table above, the full before/after fix table, the
  dashboard bundle figures, and how to run the benches yourself.

## Migration

**None.** No schema, config, or dependency changes; nothing to migrate in
either direction. A v1.9 `history.db` and `state.json` open cleanly under
v1.10 and vice versa.

## What did not change

- No new CLI verb, HTTP endpoint, MCP tool, config key, or event kind. Every
  surface added this release is bench-harness plumbing (`bench/`) and test
  infrastructure (`test/bundle-budget.test.mjs`), not a product surface — none
  of it needs a stability tier.
- The dashboard bundle itself: unchanged at 492.7KB raw / 148.5KB gzip /
  132.0KB brotli. v1.10 adds the first gate that would have caught a
  regression here; it did not add a diet.

## Gates at tag time

- tsc clean (all three tsconfig projects); full suite green.
- Full bench suite green — baselines, scale (1M corpus), write-path, and
  startup — including on a machine with a parallel build running (the
  contention-immune proof: pass on the absolute budget or the ratio axis).
- Contract suite green against **both** an empty history and the 1M-event
  corpus; no frozen shape moved.
- Dashboard bundle gate green: 148.5KB gzip / 132.0KB brotli, both under
  their (150KB / 140KB) ceilings.
- No dependency added.

_PERFORMANCE.md is the record of every number above — treat it as the source
of truth if a future release needs to re-derive a budget._
