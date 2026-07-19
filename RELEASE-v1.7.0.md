# daimon v1.7.0 — "Test Sense 2"

`daimon test` already knew pass/fail, and it knew flaky. But that's where its
sense ended. Coverage was invisible even when the runner printed it right there
in the output daimon already parses — so "are we trending up or down" had no
answer. Flaky tests got quarantined informally, in someone's head or a muted
alert, and rotted for months with nobody able to say how long they'd been
parked. And a red run meant the whole suite again, even when the runner
documented a perfectly good failed-only mechanism. v1.7 is **test sense 2**:
parse the coverage summaries that already exist (fail-soft, never fabricated),
give quarantine a real home that can't become a memory hole, and rerun only
what failed — but only where the runner's registry row says how.

```bash
daimon test web-admin                 # now also parses coverage → { linesPct, statementsPct }
daimon test web-admin --failed        # rerun only the last run's failures (where the runner documents how)
daimon report                         # tests section gains coverage delta + quarantine age
```

daimon **parses** coverage; it never **produces** it. It reads the summary the
run already printed — it never adds a coverage flag, injects a collector, or
touches anyone's test config. And it never fabricates: absent or unparseable
coverage is `null`, the same law that has always governed test counts.

## What's new

- **Coverage capture (M128, experimental)** — per-runner parsers over output the
  runner already produced: vitest/jest istanbul (the `text` reporter's "All
  files" row and the `text-summary` block), pytest-cov's `TOTAL` line, and
  `go test -cover`'s "coverage: NN.N% of statements". The result surfaces as
  `coverage: { linesPct, statementsPct } | null` on `daimon test`,
  `GET /api/tests`, and MCP `daimon_run_tests`, backed by additive nullable
  `covLinesPct`/`covStmtsPct` columns on `test_runs`. A runner opts in via
  `TEST_RUNNER_META[id].supportsCoverage` + a `parseCoverage`, which **gates a
  coverage block in that runner's fixture** — `test/testrunners.test.mjs` fails
  on a claim without fixtures and on any parser returning non-null for the
  malformed case. Fail-soft is absolute: absent / unparseable / out-of-range
  (`<0` or `>100`) → `null`, always. cargo and dotnet ship **without** coverage
  — no documented default machine-readable summary was confirmed against real
  captured output, so they don't participate (never a guess). Summary numbers
  only — no per-file coverage storage, ever.
- **Coverage trends (M129, experimental)** — the dashboard Trends page gains a
  "Test coverage" line beside pass-rate and flaky, bucketed the same way.
  Null-coverage runs render as true **gaps**, not zeros; an app with no coverage
  data shows the existing series unchanged, no chart error. No new CLI verb.
- **Flaky quarantine (M130, experimental)** — an optional `tests.quarantine`
  list of glob patterns (`*` wildcard) matched against a test's `suite > test`
  name. Quarantined tests **still run and still record** — daimon never edits a
  test config, so it couldn't skip them and wouldn't. Their failures gain the
  additive `quarantined` column, are excluded from flaky detection and from
  test-failure alert noise, and the runner's exit code passes through unchanged.
  Per-pattern first-seen timestamps persist in `state.json` for "oldest since
  <date>". Parked, dated, and visible forever — silenced never.
- **`daimon test <app> --failed` (M131, experimental)** — rerun only the last
  recorded run's failures, via the runner's registry-declared `rerunFlag`
  (pytest `--lf`; go `-run` as an anchored regex-escaped alternation; jest/vitest
  `-t` and dotnet `--filter` name filters). No `rerunFlag` = explicit
  non-participation. It **never** silently runs the full suite: no prior run, an
  undeclared runner, and unparseable failure names each error with a remedy; an
  all-green prior run is an honest no-op. The rerun records with the additive
  `failedOnly` flag; totals reflect only what ran.
- **Report + why deepening (M132, experimental)** — the report's tests section
  gains current coverage + a signed delta vs the previous period and a
  quarantine count with "oldest since"; `daimon why` gains a quarantine line;
  the scheduled digest inherits both. Degradable notes, never errors.

## Coverage is parsed, never produced — stated plainly

daimon reads the coverage number the run already emitted. It does not add
`--coverage`, install a collector, configure a reporter, or edit anyone's test
config — the same standing rule that keeps daimon from ever editing user source.
It does not enforce a threshold, gate a run, or fail anyone on a coverage drop:
daimon reports the number, full stop. And it never fabricates one — a summary it
can't parse is `null`, exactly as an unparseable test count has always been.

## Migration

**A v1.6 install upgrades to v1.7 with zero action.** Everything added is
additive:

- **`test_runs` gains nullable `covLinesPct`, `covStmtsPct`, `failedOnly`
  columns; `test_failures` gains a nullable `quarantined` column** — via the
  guarded `ALTER TABLE … ADD COLUMN` discipline (checked against
  `PRAGMA table_info` first; every INSERT names its columns). A v1.6 `history.db`
  opens clean under v1.7, and a v1.7 `history.db` opens clean under v1.6 (old
  rows read the new columns `null`). No rename, drop, retype, or NOT-NULL
  addition.
- **`tests.quarantine?: string[]` is a new optional config sub-key** under the
  existing `tests` object. Absent = behavior unchanged. Invalid entries warn at
  load and are skipped — the config stays loadable. No new top-level key, so
  `CONFIG_KEY_STABILITY` is unchanged.
- **`state.json` gains an additive `quarantineFirstSeen` map** (pattern →
  first-seen ts), written with the same merge-write + `.bak` atomicity as
  `ports`/`mutes`/`digests`. A v1.6 `state.json` loads unchanged; the map is
  reconciled against the configured patterns at boot and on config reload.
- **No frozen shape moved.** The coverage / `failedOnly` / `quarantined` fields
  are additive on the `stable` `daimon test`, `GET /api/tests`, and
  `daimon_run_tests` surfaces; `--failed` is a new flag on the existing `test`
  verb; the report's tests section deepened inside the closed section list. All
  new surfaces are tier `experimental`.

Nothing to run, no config to touch. To opt in: add coverage output to your own
test command (daimon parses whatever it prints), list flaky tests under
`tests.quarantine`, and pass `--failed` after a run.

## What v1.7 deliberately does not add

- **Per-file coverage storage** — summary numbers only, ever (size discipline).
- **Coverage thresholds / gating** — daimon reports the number; it never fails a
  run on it. No doctor rule on coverage drops.
- **Injecting coverage flags or collectors** — never; parse what the run already
  produced.
- **Coverage for runners without a documented machine-readable summary** —
  explicit non-participation (cargo, dotnet), no guessing.
- **`daimon import`** — there is none, and never will be (import edges toward
  sync, a standing no).
- **Test-impact analysis / changed-file selection**, remote / non-loopback,
  multi-user, cloud sync, telemetry — standing nos, unchanged.
