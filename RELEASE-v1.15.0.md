# daimon v1.15.0 — "Atlas"

Workspaces and the dependency graph become visible, navigable surfaces
(M173–M178) — a map of what daimon already knows.

The depends graph has existed since v0.3 and had never once been *seen*:
`depends.ts` computes cycles, closures, and topo levels; `orchestrate.ts`
orders every `up` with them; and the only trace a user ever got was a cycle
warning string or a `plannedOrder` array buried in dry-run JSON. Workspaces
were the same story from the other side — `searchRoots` labels every app, the
CLI filters by cwd, and yet workspaces stayed labels, not places. v1.15 draws
the map.

**The graph is READ-ONLY visualization, permanently.** It renders what
orchestrate already computes — it never starts, stops, or reorders anything.

---

## Migration

**None.** Everything is additive.

- **No new config keys. No history migration. No new dependencies.** A v0.1
  config still loads unchanged; a v1.14 `history.db` opens unchanged; the
  graph page is hand-rolled SVG, so no chart/graph/layout library entered the
  tree.
- **No frozen shape moved.** `up`'s piped JSON output is byte-identical to
  v1.14 — the start-order preview is TTY/dashboard chrome plus an opt-in
  `--dry-run`.
- **The workspace preference is client-side, so there is nothing to
  migrate.** Dashboard: localStorage per browser. TUI: process state, gone on
  quit. The daemon never carries an "active workspace".
- **Two behavior refinements on existing `?workspace=` filters**, both
  deliberate (M177) and both on the "this was a silent footgun" side:
  1. Matching now uses the EFFECTIVE label — the searchRoot's label, or its
     folder basename when unlabeled. Labeled matching is unchanged;
     previously-unfilterable unlabeled roots become filterable (a query that
     returned `[]` now returns that root's apps).
  2. On the surfaces whose `?workspace=` param is NEW in v1.15 (errors,
     search, trends, graph — plus the experimental report), an unknown label
     answers **400 naming the known labels** (CLI: exit 1 with the same
     remedy) instead of silently returning `[]`. The frozen `/api/apps` and
     stable `/api/overview` keep their historical 200-with-empty response —
     additive-only is the law on those tiers.

---

## What landed

### M173 · Workspace surfacing — a place you stand

The v1.12 header pill is a real switcher: every configured searchRoot (an
unlabeled root shows as its folder basename) plus "All workspaces", persisted
in localStorage, restored on reload; an explicit `?workspace=` deep-link wins
over both the stored choice and the `?cwd=` auto-pick. In the TUI, `w` cycles
the workspace filter and the status bar shows `ws:<label>` with the
visible/total count — held in the TUI's own state, never written to the
daemon, so two attached TUIs can watch two different workspaces at once
(grep-asserted in `test/tui-workspace-chord.test.mjs`).

### M174 · The depends-graph view

`/graph` (Observe group, `g y`): hand-rolled SVG where the columns ARE the
daemon's topo levels — dependencies left, so what you see is literally the
start order. Node color comes from the status tokens with a distinct glyph
and border per status (health is never color-only); cycle members are flagged
with the named cycle path. Keyboard + aria from day one: Tab walks nodes in
topo order, arrows walk the graph itself (left → dependency, right →
dependent, up/down → column), Enter opens the app detail, and an offscreen
paragraph narrates the whole graph for screen readers. Nodes recolor on the
existing refresh path. Axe zero serious/critical at 1280 and 390px.

### M175 · `daimon graph` + `GET /api/graph` + MCP `daimon_graph`

The same map for terminals and pipes (all `experimental`): nodes with live
status/health/workspace/groups, edges from `config.depends` restricted to
known apps, topo `levels`, `cycles[]`, `unordered[]` (apps blocked downstream
of a cycle — reported, never silently dropped), and per-group `up` plans. A
readable tree on a TTY; the endpoint body when piped. `--workspace` filters
(unknown labels error, naming the known ones); cwd scopes implicitly like the
other read verbs; `--all` opts out. `test/graph.test.mjs` greps the module
for process-touching APIs — the read-only law is enforced, not asserted.
MCP is now **35 tools**.

### M176 · Groups × graph — clusters and the start-order preview

v1.1 groups render as labeled hulls on the graph page (a multi-group app is
drawn once, inside each hull). The group panel and `daimon up <group>
--dry-run` (new, additive) preview the start order — computed by the SAME
`groupUpPlan` call the verb executes and carried on `/api/graph`, so the
preview cannot drift from the behavior. On a TTY, `up <group>` prints
`will start: level 1: api · level 2: web` before acting. Ordering, timeouts,
exit codes, and piped JSON are byte-identical to v1.14.

### M177 · Per-workspace filters end-to-end

One matching rule (`effective label`) on every surface: `/api/apps`,
`/api/overview`, `/api/errors` (new param), `/api/search` (new param),
`/api/history/trends` (new param), `/api/report`, `/api/graph`; one
unknown-label error (400 + known labels + remedy) on every surface where the
param is new (apps/overview keep their historical empty response — their
tiers are additive-only). CLI: `errors --workspace` (flat
all-apps shape) and `search --workspace` are new; `report --workspace` and
`list --workspace` were already there and now match consistently. Dashboard:
home, tests, timeline, trends, and report follow the switcher like apps and
errors always did; sessions/agents/settings/doctor stay deliberately
daemon-global. `test/workspace-parity.test.mjs` asserts filtered =
unfiltered ∩ members, row-for-row, per surface — and that an absent param is
byte-identical.

---

## Stability

Every new surface ships `experimental`, declared at its source of truth and
rendered with tier badges in the docs: the `graph` verb, `GET /api/graph`,
MCP `daimon_graph`, `up --dry-run`, the `?workspace=` params on
errors/search/trends, the TUI `w` chord, and the dashboard switcher/graph
page. No `frozen` or `stable` shape changed.

## Out of scope, deliberately

- Graph editing of any kind — depends stays hand-written config.
- Cascade semantics — no dependency-driven restarts, no auto-start-on-dependent.
- A daemon-side "active workspace" — client-local by design, not a deferral.
- Graph/chart/layout libraries — hand-rolled SVG or nothing.
- Remote/multi-user/cloud — standing NOs, unchanged.
