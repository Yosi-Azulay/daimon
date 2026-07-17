# daimon v1.3.0 — "Guardrails"

Resource awareness — daimon finally sees RSS and CPU. The pidusage poll that
already fed the live TUI now keeps a downsampled history, `daimon top`
answers "what is eating my machine, of the things daimon owns", leaks and CPU
storms are suspected against each app's *own* baseline, and budgets warn with
a remedy. **Watch, warn, point — never touch**: no resource code path can
signal, stop, restart, or throttle a process, and a grep-style enforcement
suite proves it. Everything is additive; every new surface ships tier
`experimental`; the contract suite that pins frozen shapes ran green
throughout.

```bash
daimon top                     # app → pid → rss → cpu → uptime, RSS-sorted
daimon why web                 # notes when a crash fell inside a leak window
daimon report --md             # gains a Resources section (peak RSS, suspicions)
daimon doctor                  # flags `cpu-storm-active: <app>` (advise-only)
```

## What's new

- **Resource sampling (M105)** — the existing 2s `UsageMonitor` tick gains a
  per-app downsampler: one row per app per `resources.sampleMs` (default 30s,
  `0` disables persistence; the live display is unaffected either way) into a
  new additive `resource_samples` table (rss in bytes, cpu in percent,
  indexed `(app, ts)`), pruned by the existing retention pass. One timer
  total — no second poller. Fail-soft per app: a dead pid or write hiccup
  self-warns once and the other apps keep sampling. The write-path and
  sampling-CPU bench measurements landed with the milestone and are
  indistinguishable from the v1.2 baseline.
- **`daimon top [--json]` (M106)** — live table of the running apps daimon
  owns: pid, RSS (MB), CPU %, uptime, sorted by RSS descending, from live
  poll state (this is *now*, not history). An app whose first reading hasn't
  arrived renders dashes — nulls in JSON, never an error. Same shape on
  `GET /api/top` and MCP `daimon_top` (29 tools).
- **Leak suspicion (M107)** — self-calibrating, trust-critical by design.
  The first 5 minutes after each spawn establish baseline RSS (median) and
  jitter (median absolute deviation); every threshold derives from them — no
  magic MB figures, and the multipliers are internal constants, deliberately
  not config. RSS monotonic-with-tolerance across a full 15-minute window,
  with total growth beyond max(4× jitter, 10% of baseline), raises **one**
  `resource-leak-suspect` event carrying baseline, current, growth rate, and
  a remedy. Episodes re-arm only when RSS returns to baseline or the app
  restarts (restart also recalibrates — a heavier-but-stable process is
  healthy against its own fresh normal). Sawtooth GC, warm-up climbs,
  contention noise, sampling gaps, and drift-within-noise never fire; too
  little data means no verdict at all. Pure, import-free detector module,
  unit-tested on synthetic series.
- **CPU storms + budgets (M108)** — `cpu-storm`: every sample of a full
  window above the app's own baseline p95 AND the window mean well above the
  baseline median (floored for near-idle baselines) — one hot sample or a
  compile burst never fires; same episode semantics. Budgets:
  `resources.{rssMb,cpuPct}` globally, `overrides.<app>.resources` per app
  (override wins per key); a sustained crossing raises one
  `resource-budget-exceeded` naming observed value, budget, and what to do
  next. Absent keys = no checks at all. The **warn-never-kill enforcement
  suite** pins the contract: `resources.ts` imports nothing, the sampling
  path has no kill/spawn surface, no consumer wires a resource event kind to
  process control, and firing all three kinds moves app state by zero fields.
- **Surfacing (M109)** — Trends: per-app RSS (MB) and CPU (%) series with the
  existing period switcher; `daimon why`: `resources` (open episodes +
  baseline) and a `resourceNote` when the crash fell inside an open suspicion
  window ("RSS grew 3.1× baseline over the ~15 min before this crash");
  doctor: `cpu-storm-active: <app>`, advise-only by contract; report: a
  `resources` section (peak RSS, avg CPU, suspicion/budget counts per app),
  degradable to a note, bench budget unchanged.
- **Notifications** — three new opt-in kinds (`resource-leak-suspect`,
  `cpu-storm`, `resource-budget-exceeded`) via `notifications.kinds`; absent
  = zero new noise (self-events and webhooks flow regardless).

## Migration

None required — every change is additive:

- **Database**: v1.3 adds one new table, `resource_samples`, via
  `CREATE TABLE IF NOT EXISTS`. A v1.2 `history.db` opens clean under v1.3
  (the table appears empty — there is no backfill of pre-1.3 data); a v1.3 db
  opens clean under v1.2 (the extra table is simply ignored). No action
  needed either direction.
- **Config**: all new keys optional. Absent `resources` = v1.2 behavior plus
  default-cadence sampling (30s); set `"resources": { "sampleMs": 0 }` to
  disable persistence entirely. Budgets run only if you set
  `resources.rssMb` / `resources.cpuPct` (or per-app overrides). Resource
  notifications fire only if you add the kinds to `notifications.kinds`.
- **Shapes**: no frozen or stable shape changed. New surfaces (all
  `experimental`): CLI `top`; HTTP `GET /api/top`; MCP `daimon_top`; config
  key `resources.{sampleMs,rssMb,cpuPct}` + `overrides.<app>.resources`;
  event kinds `resource-leak-suspect`, `cpu-storm`,
  `resource-budget-exceeded`; notification kinds (same three names); trends
  metrics `rss`/`cpu`; `why.resources` + `why.resourceNote`; doctor rule
  `cpu-storm-active`; report section `resources`.
- Edge worth knowing: suspicion needs data — with `sampleMs: 0` the
  detectors are silent (nothing to read), and an app with under ~5 minutes of
  samples after spawn never gets a verdict.

## Publish checklist (human, 2FA)

- `npm publish`
- `git push origin main --tags`
- `vsce publish` (extension bump)
