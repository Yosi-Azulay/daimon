# daimon performance — certified numbers (v1.10.0 "Featherweight")

This document is the deliverable of v1.10, not a side effect of it. Every
number below was measured on a real run of the bench harness in `bench/`, not
estimated, not carried over from a plan, and never adjusted after the fact to
make a budget pass. Where a fix helped, the before and after are both shown.
Where nothing changed (the dashboard bundle), that is stated plainly.

## What this certifies, and on what hardware

All figures were recorded on one machine:

- **Platform:** win32
- **Cores:** 20
- **Node:** v22.14.0

"Quiet" is not a claim taken on faith — every recorded run is verified by a
two-signal detector (see below), and a run that fails the check is refused for
`--write` rather than silently accepted as a baseline. Numbers here are not
promises for every machine; they are what this machine does, so that a future
run on the *same* machine has something honest to compare against.

## The budget-derivation rule

Every performance budget in v1.10 is derived, never typed in by hand:

```
budget = measured quiet-machine baseline p95 × a per-class headroom factor
```

The headroom factor is chosen once per metric **class**, not per metric, and
is the only policy input — everything else is measurement:

| Class | Headroom | Why |
|---|---|---|
| interactive | 2× | A human is waiting on the keystroke; little slack, a 2× slip is felt. |
| startup | 2.5× | Process launch is dominated by module load + OS scheduling, noisier than in-process work. |
| query | 3× | Read queries over the corpus; disk-cache state legitimately swings these. |
| batch | 3× | Composition (report/export/sessions) fans out over many queries whose noise compounds. |
| write | 4× | Per-insert latency is microsecond-scale, where timer granularity itself is a large share of the measurement. |

### The second axis: contention

External load (a parallel build, a sibling test process) inflates a raw
measurement without the daemon actually getting slower — the M91
contention-immune discipline this release extends. So every budget carries a
**second axis**: a sample passes on the absolute budget **or** on its ratio to
an interleaved CPU-reference workload (a fixed-cost spin, ~5–15ms quiet-machine
cost, run between samples so it sees the same machine at the same instant).

```
ratio ceiling = (budget ÷ baseline cpuRef) × 3
```

Outside load inflates the measurement and the reference together, so the
ratio holds; a genuine regression inflates only the numerator and fails both
axes. **A red budget means investigate. Budgets are never loosened to make a
run pass** — the only legitimate edits are re-deriving from a new committed
baseline after a deliberate, reviewed change, or tightening.

### The quiet-machine detector (why two signals)

A single signal is not enough. `bench/lib/machine.mjs` checks both:

1. **Dispersion of the CPU reference** (relative MAD across repeated spins) —
   catches a machine whose scheduler is descheduling the process
   unpredictably.
2. **System-wide busy fraction** from `os.cpus()` time deltas, sampled during
   a sleep so the bench process itself contributes almost nothing — catches
   what dispersion alone misses: on a many-core box, a single spin can hold a
   dedicated core and run at a rock-steady (but inflated) cost while a
   parallel build saturates every other core.

This was not hypothetical: the first v1.10 baseline attempt reported
`quiet=true` on dispersion alone while the full test suite was running in the
background, and its cold-start p50 came in 72% above the true quiet number.
Recording that would have inflated every budget derived from it. `loadavg` is
deliberately not used — it is always 0 on Windows, the primary dev platform.
A contended run is labelled (`machineQuiet: false`) and refused for
`--write`, never silently folded into a baseline.

## The 1M-event corpus

v1.10 asks the question daimon couldn't answer before: after months of
recording everything, does it still answer instantly? `bench/lib/corpus.mjs`
seeds a corpus at that scale:

| Table | Count |
|---|---|
| events | 1,000,180 |
| log lines | 2,000,000 |
| compiles | 50,000 |
| bundles | 5,000 |
| test runs | 500 |
| test failures | 145 |
| env snapshots | 200 |
| resource samples | 100,000 |
| crashes | 100 |
| daemon sessions | 90 |
| apps | 10 |
| FTS rows | 3,000,221 |

Total on-disk size: **610MB**. The corpus spans a fixed **90-day** window,
**anchored** so its newest rows land on the day it's built — `why` and
`context` query hardcoded last-24h/last-7d windows, so a corpus pinned to a
fixed calendar epoch would eventually certify the speed of querying nothing.

Seeding is deterministic: a fixed-seed `mulberry32` PRNG drives every choice
(app, agent, message, row count), so two machines seeding the same scale get
byte-comparable results — nothing calls `Date.now()` or `Math.random()`
inside the seeder itself. `SEEDER_VERSION` (currently 2) invalidates any
cached corpus whose composition has since changed.

**Regenerating it:**

```sh
node bench/scale.mjs           # builds/reuses the corpus, gates against the committed baseline
```

The corpus caches under `bench/.corpus/` (gitignored, never shipped in the
tarball) and is rebuilt automatically once it is older than **7 days**, or
whenever `SEEDER_VERSION` has been bumped. Seeding the 1M corpus from scratch
takes **~49s**; it is reused across every bench run after that, so the cost is
paid once, not per invocation.

## M145 — baselines (empty daemon / 100k dashboard corpus)

The "before" column for the whole release — recorded before any optimization
touched code.

| Metric | p50 | p95 | n | Method |
|---|---|---|---|---|
| daemon-cold-start | 921.5ms | 1082.6ms | 7 | fresh `DAIMON_HOME`, empty history: spawn → `/api/signature` answering |
| cli-roundtrip | 323.5ms | 399.3ms | 50 | `daimon list --json` against a warm daemon |
| idle-footprint RSS | 68.7MB | 85.2MB | 22 samples / 60s | idle daemon, empty workspace |
| idle-footprint CPU | 0% | 1.03% | 22 samples / 60s | same window |
| tui-attach | 917.1ms | 1017.6ms | 5 | launch → first rendered frame |

**dashboard-route-tti**, 14 routes on the 100k corpus: worst p95 **178.7ms**
(`/doctor`); fastest route (`/`) at p50 **84.8ms**.

**Repeatability across 3 runs** (documented tolerance: ±20%):

| Metric | Spread |
|---|---|
| cold-start p95 | ±5.0% |
| cli-roundtrip p95 | ±0.7% |
| tui-attach p95 | ±6.6% |

## M146 — scale certification (1M-event corpus)

Six read paths, each certified against a budget derived from its own measured
baseline (see the derivation rule above). All figures below are the measured
baseline numbers, not the derived budgets.

| Path | p50 | p95 | Class |
|---|---|---|---|
| search-fts-common | 0.9ms | 1.2ms | interactive |
| search-fts-rare | 0.9ms | 1.3ms | interactive |
| search-like-common | 0.7ms | 1.0ms | query |
| search-like-rare | 252.8ms | 326.5ms | query |
| search-like-miss (no match, full scan — true worst case) | 1570.2ms | 1764.3ms | query |
| report | 2838ms | 3087.3ms | batch |
| export | 3245.6ms | 3370.2ms | batch |
| sessions | 696.2ms | 852ms | batch |
| why | 143.8ms | 212.2ms | interactive |
| context | 37.9ms | 94.2ms | interactive |

**FTS catch-up from a cold high-water mark:** 31.9s to index all 3,000,221
rows — this now runs off the search path (see fix #5 below), so a cold index
no longer costs a user a stalled search.

The contract suite runs green against the 1M DB — every frozen shape is
identical at 0 events and at 1M events.

## M147 — write path (1M corpus)

| Metric | p50 | p95 | p99 | Load |
|---|---|---|---|---|
| event-ingest | 0.0003ms | 0.0013ms | 0.0022ms | 50,000-call storm |
| logline-ingest | 0.0003ms | 0.0009ms | 0.0015ms | 100,000-call storm |

Both drain to queue depth 0 after the storm — ingest never falls behind.

**FTS stays off the write path:** FTS-enabled inserts cost **×0.857** of
FTS-unavailable ones (ceiling 1.10) — i.e. indistinguishable from, and in this
run actually faster than, inserting with FTS unavailable, within measurement
noise. Zero per-insert triggers exist anywhere in the write path.

**Retention pruning**, time-sliced rather than one uninterruptible block:

| Metric | Value |
|---|---|
| slice p50 | 73ms |
| slice p95 | 144.2ms |
| slice max | 325.7ms |
| slices | 242 |
| total prune time | 19.9s |

## Before / after — the fixes the scale run found

Measuring at 1M scale surfaced real defects that a 100k corpus never showed.
Each was fixed with a measured before/after number; semantics never changed.

| # | What | Before | After | Cause → fix |
|---|---|---|---|---|
| 1 | History open on a 610MB DB, clean close | 8303ms | 7ms | `PRAGMA integrity_check` ran on every open — O(database size). `close()` now records a clean-shutdown marker in SQLite's previously-unused `user_version` header field; a cleanly-closed DB gets a bounded structural probe (O(tables), 3.6ms, still catches the recovery suite's corrupted-page case), while a DB that was **not** closed cleanly still gets the full check (corruption comes from unclean shutdown / disk failure). |
| 2 | `daimon doctor` full sweep on 1M | ~51s | 5130ms | Doctor opened **six** independent History handles per sweep, each paying the 8.5s integrity check. Fixed to one shared handle. |
| 3 | `daimon why` at 100k | 6284ms p50 | 58.8ms p50 (143.8ms p50 at 1M) | `why` calls doctor on the request path, then **discards** the history-db finding — it was paying an O(db-size) quick_check for a result nobody sees. Fixed by passing `historyHealth:false`; doctor on that path went from ~51s to 88ms at 1M. |
| 4 | Retention on 1M | one uninterruptible 28.8s block (TUI frozen, HTTP stalled, ingest stopped) | time-sliced: p95 144.2ms across 242 slices | Semantics unchanged — every expired row still goes, and `test_failures` still prunes before `test_runs` so an interrupted pass cannot orphan rows. |
| 5 | First search on a cold FTS index at 1M | 51.5s stall | answers from the LIKE path (≤1.8s worst case) | Backlogs over 10,000 rows (derived from a measured 17.2µs/row) now skip the inline sync. This trades speed, never correctness — LIKE scans the base tables, so results stay COMPLETE and read-your-writes still holds; the idle tick heals the index afterward in 5k-row chunks. |
| 6 | CLI startup — `--help` | 307ms p50 | 121ms p50 | The Claude version-drift nudge ran before the help/version fast paths, and discovery/doctor/portDiag/claude were top-level imports. Bare-node spawn floor is 49ms. |
| 6 | CLI startup — `--version` | 312ms p50 | 121ms p50 | Same cause/fix as above. |
| 6 | CLI startup — no-daemon error | 305ms p50 | 185ms p50 | Same cause/fix as above. |
| 7 | Dashboard bundle | raw 492.7KB / gzip 148.5KB / brotli 132.0KB | **unchanged** | No dashboard code was modified in v1.10 — reported here for completeness, not as a win. |

## The dashboard bundle: a documentation correction

Release notes since v1.7 quoted **"135.39 KB gz"** for the dashboard's
initial payload. That figure is Angular's "Estimated transfer size" column,
which since Angular 17 is a **brotli** estimate, not gzip. Measured directly
on this build:

| Compression | Size |
|---|---|
| raw | 492.7KB |
| gzip | 148.5KB |
| brotli | 132.0KB (135.39KB is what Angular printed) |

The **"<150KB gzip"** claim made in every prior release still holds — but with
roughly **1% headroom**, not the ~10% everyone believed. v1.10 adds the first
automated gate for this: a **150KB gzip ceiling** plus a **140KB brotli
budget**, measured by walking the static import graph reachable from
`index.html` (script tags, stylesheets, `modulepreload` links, and every
transitively-imported `.js` chunk reached via static ESM `import`/`from` —
dynamic `import()` edges, i.e. lazy routes, are deliberately excluded, since
counting them would punish moving work *off* the critical path rather than
onto it). Before this release, nothing failed if a stray eager import pushed
the bundle over budget; now something does.

## How to run the benches

```sh
npm run build              # bench measures compiled dist/, same as npm test

npm run bench              # the full set: baselines + scale + write-path + startup
npm run bench:baselines    # M145 — cold-start, cli-roundtrip, idle, tui-attach, dashboard TTI
npm run bench:scale        # M146 — the six read paths on the 1M corpus (builds/reuses it)
npm run bench:write        # M147 — event/logline ingest storm + retention pruning
npm run bench:startup      # M148 — cli --help/--version/no-daemon-error + module-load audit
```

Every command above **gates** against the committed baseline
(`bench/BASELINE-v1.10*.json`) by default. Passing `--write` instead
**records** a fresh baseline — and refuses to do so on a machine the
two-signal detector doesn't consider quiet, or on a `--quick` (short-window)
run, since either would silently bake a bad "before" column into every
budget derived from it:

```sh
node bench/baselines.mjs --write     # refuses unless machineQuiet
node bench/scale.mjs --write         # refuses unless machineQuiet
```

Don't run a bench and `npm test` at the same time — they contend, and the
contention shows up as spurious failures in `lifecycle-torture` and
`demo-script`, not in the bench numbers themselves (the bench gates are
built to survive contention; those two test files are not).
