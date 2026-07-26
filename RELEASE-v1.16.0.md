# daimon v1.16.0 — "Recall"

Search grows a query language, one unified surface, and saved searches
(M179–M184).

daimon has remembered everything since M77 and let you ask about it one word at
a time. Filtering to an app meant knowing `--app`; filtering by time meant
knowing `--since`; error groups and test runs were not searchable at all. The
recall was total; the asking was primitive. v1.16 fixes the asking.

**The load-bearing decision: filters compile to WHERE clauses on real columns,
never to FTS tricks.** That is what lets the same query return the same rows
whether it is answered by the FTS index or by the LIKE fallback a degraded index
falls back to. The fallback is slower and has no ranked snippets. It is never
wrong, and it still says so.

---

## Migration

**None.** Everything is additive.

- **No new config keys. No history migration. No new dependencies.** A v1.15
  `history.db` opens under v1.16 and vice versa; no table, column, or index
  changed.
- **No frozen shape moved.** `GET /api/search` is `stable`, and a pre-v1.16
  call — `?q=` plus any of `app`/`since`/`kind`/`limit`/`workspace` — returns
  the same `{ hits, fallback }` body it always did. The `facets` key and the
  `tests` / `error-groups` hit kinds appear **only** when `?scope=all` (or a
  `kind` naming one of them) is explicitly requested.
- **Saved searches add one additive key to `~/.daimon/state.json`**
  (`savedSearches`), written under the existing merge-write + `.bak` rule. An
  older daimon reading that file ignores the key; a malformed row is dropped on
  load, never fabricated.
- **One deliberate behavior change, on the degraded path only:** a multi-term
  query on the LIKE fallback now ANDs its terms instead of matching the whole
  string as one contiguous substring. The FTS path has always ANDed tokens, so
  this is a parity fix — a broken index used to return *fewer* rows than a
  healthy one for the same query. Single-term queries are unchanged, and no
  query loses a hit.
- **Every new surface ships `experimental`**: the query grammar, `?scope=all`
  and the facets object, `daimon search --all`, the `searches` verb and its four
  routes, the MCP `scope` parameter, and the TUI `F` pane.

---

## What landed

### M179 · Query syntax

`src/searchQuery.ts` — a pure, import-free parser — is the ONE source of the
grammar. The daemon, the CLI, the TUI, and the docs generator all read it, so
there is no second copy to drift.

```bash
daimon search 'app:api level:error "ECONNREFUSED" after:24h'
daimon search 'kind:logs before:2026-07-01 hydration'
daimon search 'level:error'          # filters alone are a valid query
```

- Fields (closed list): `app:`, `kind:`, `level:`, `before:`, `after:`, plus
  `"quoted phrases"` and bare terms. Everything is ANDed. No `OR`, no
  parentheses, no negation — deliberately (grammar growth is a future release
  with its own scale check).
- `level:` spans **both** stores: the `error-*` / `warning-*` / `lint-*` event
  families and the v1.2 log-line `level` column. A log line daimon could not
  classify carries no level and is excluded — documented, never guessed at.
  `crash` belongs to no level family (it has no severity) but is still covered
  by `kind:errors`.
- Time values: `2026-07-01` (UTC midnight), `2026-07-01T14:30`, `24h` / `7d` /
  `30m` / `2w`, or epoch ms. `after:` is the general form of `--since`.
- An unknown field is an error that names the valid fields **and** how to search
  for the token literally — the same message on HTTP 400, CLI stderr, and in the
  TUI pane:

  ```
  error: unknown field 'lvl:' — valid fields: app, kind, level, before, after
    hint: use one of app, kind, level, before, after, or quote the token to
          search for it literally: "lvl:…"
  ```

- Where a query field and the equivalent legacy param disagree (`?app=api` with
  `app:web` in the query), **the query wins** — one rule, applied to every field,
  because the query string is the more specific statement of intent.

### M180 · Unified search

```bash
daimon search 'renders the chunk' --all
```

`--all` (`?scope=all`) widens the same query to recorded **test runs**
(`ref: test:<id>`, matched on the runner name and the run's recorded failures)
and live fingerprint-folded **error groups** (`ref: errgroup:<fingerprint>`), and
adds a `facets` object counting the hits per kind in that response. `kind:tests`
and `kind:error-groups` imply it.

Both are **column queries**, on both engines — `test_runs` has no FTS shadow and
never will, because keeping one in sync would mean a per-insert trigger. Error
groups are folded live from the registry (the `?group=fingerprint` shape), so
nothing new is stored or indexed.

### M181 · Saved searches

```bash
daimon searches save today-errors 'level:error after:24h'
daimon searches list
daimon searches rename today-errors errors-today
daimon searches delete errors-today
```

Named query strings in `state.json`, validated by the real parser at save time.
**Inert by construction**: no schedule, no notification kind, no hook, no timer.
daimon has exactly one scheduler — the daily digest — and this feature does not
touch it. `test/saved-searches.test.mjs` greps the compiled daemon to keep that
true, and the persistence tests prove merge-write (saving a search cannot clobber
port assignments) and `.bak` recovery.

### M182 · TUI search parity

`F` opens a search pane over the in-process History — same parser, same compiled
filters, same error text. `↑/↓` walks the results and `Enter` jumps to where the
hit happened: an event to its timeline position, a log line to that app's log
pane, a test run or error group to the app's detail pane. `Tab` returns to the
query, `Esc` closes. An empty query box lists your saved searches; `Enter` runs
the highlighted one. The chord is a row in `src/tui/chords.ts` like every other,
so the footer, the `?` overlay, the docs cheat sheet, and the README table all
render from it.

**A bug the render test found:** `App`'s `useInput` is registered unconditionally
while a modal surface renders *instead of* the main app, so both handlers fired
for the same keypress — `q` in the v1.8 timeline exited the pane **and** quit the
whole TUI, and typing `s` into a search box would have started an app. A modal
now owns every key while it is open.

### M183 · Scale check

The v1.10 harness gates the syntax queries too: filter-heavy (`app:` + `after:`),
phrase, `level:` (the one that spans two stores), and `scope=all` — on the FTS
path **and** on the LIKE fallback, over the 1M-event corpus. Budgets stay derived
(`baseline p95 × class headroom`), recorded in a new
`bench/BASELINE-v1.16-search.json` so the v1.10 file keeps that release's
measurements exactly as they were taken. The no-per-insert-FTS-trigger grep now
scans the whole `src/` tree rather than `history.ts` alone.

---

## Numbers

- Backend suite: **1216** `node:test` cases (v1.15: 1180), 0 fail — plus the
  isolated `quickstart` phase, 3/3. New files: `test/search-query.test.mjs`,
  `test/search-surfaces.test.mjs`, `test/saved-searches.test.mjs`,
  `test/tui-search-chord.test.mjs`.
- Dashboard vitest: **187** (v1.15: 166), 0 fail.
- Playwright: the new `e2e/search-syntax.spec.ts` is **10/10** across both
  viewports (desktop + 390px), including its axe pass; `palette`, `keyboard`,
  `a11y` and the deep-link `redirects` audit re-run green against an isolated
  daemon (38 passed, 5 skipped — the skips need registered apps, which the
  scratch daemon deliberately has none of).
- MCP: **35 tools** (unchanged — `daimon_search` gained a parameter, not a
  sibling).
- Dashboard initial payload: **149.96KB gzip** (budget 150KB) · 133.37KB brotli
  (budget 140KB). **The gzip headroom is now ~40 bytes.** It has been tight
  since v1.11 (149.3KB); v1.16 added ~0.6KB. The budget is not raised — but the
  next release should start with reclaiming room, not spending it.
- npm tarball: **923.1 kB packed / 3.17 MB unpacked, 169 files**;
  `test/pack-audit.test.mjs` green (no tests, fixtures, plans, or toolkit
  internals ship). Delta vs v1.15: the four new modules add **28.5 kB** raw
  (`searchQuery.js` 10.4 · `SearchPane.js` 8.9 · `savedSearches.js` 5.2 ·
  `searchChord.js` 4.0) and the generated `docs/index.html` grew **88.9 → 94.7
  kB** with the query-syntax reference; the rest is growth inside existing
  `dist/` modules. (No prior release recorded a packed figure, so the packed
  total has no committed number to diff against — these are the measured
  additions.) Regenerated completions grew ~0.5 kB but ship OUTSIDE the
  tarball by design.
- 1M-corpus search budgets: all eight query-syntax paths PASS on both engines
  (numbers in PERFORMANCE.md §M183). One PRE-EXISTING red budget remains, on a
  path v1.16 does not touch — see below.

### The one red budget

`context` fails its v1.10 absolute budget on the 1M corpus (188.4ms budget;
measured p50 **63.5ms**, p95 ~856ms). The typical request is *faster* than the
baseline p95 that budget was derived from — only the tail moved, and `why`
shows the same tail shape. v1.16 changes no code either route executes. It is
recorded, not smoothed over: the budget stays where it is, and the tail is
v1.17's to investigate.

---

## Standing NOs reaffirmed

- **No `daimon import`.** Export stays one-way; import edges toward sync.
- **No scheduled searches, no search-driven notifications.** Saved searches are
  data.
- **No regex search over the DB** — there is no budget-safe path at 1M rows.
- **No semantic/embedding search** — daimon has no model runtime and no cloud.
- **No external indexer.** SQLite FTS5 is the engine; no new dependency.
- **No per-insert FTS trigger**, now and ever.
