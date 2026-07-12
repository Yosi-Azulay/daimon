# daimon v0.14.0 — "Runway"

The release before 1.0. No new feature surfaces: v0.14 inventories, repairs,
labels, and hardens what exists. Every surface now carries a stability tier
(see `STABILITY.md`), frozen surfaces are guarded by golden-shape contract
tests, and this is the **last release with a breaking-changes section**.

**The inventory:** 208 public surfaces across five catalogs —
**47 frozen / 145 stable / 16 experimental**
(CLI verbs 11/38/6 · HTTP endpoints 14/53/6 · MCP tools 10/15/2 ·
config keys 8/23/1 · event kinds 4/16/1).

## Breaking changes (the last)

Each change below has a consumer-facing justification — not aesthetics — and
its migration is one mechanical edit. After v0.14.0, frozen surfaces only ever
change additively.

### 1. Compact status: `uptime` → `uptimeMs`

**Surfaces:** `daimon status <name>` (compact, the default), `GET /api/apps/:name`
(compact), the `ensure` response (CLI/HTTP/MCP), MCP `get_status`, and
`daimon daemon status` (`uptime` → `uptimeMs`).

**Why:** the value has always been milliseconds, but the unsuffixed key read
as seconds — a real unit bug we've watched agents make. Every sibling key
(`lastChangeMs`, `uptimeMs` in the full shape, `waitedMs`, `timeoutMs`)
already carries the suffix. This is the last chance to fix the key before the
compact shape freezes forever.

**Migration:** read `uptimeMs` instead of `uptime`. Same value, same position.

### 2. `daimon list --tag/--workspace` no longer switches to the full shape

**Surfaces:** `daimon list --tag <t>`, `daimon list --workspace <label>`,
and (additively) `GET /api/apps?tag=&workspace=`.

**Why:** filter flags silently changed the output shape — `daimon list` emitted
compact rows but `daimon list --tag web` emitted the verbose v0.4 shape,
because the CLI filtered client-side on fields only the full shape carries.
Worse, `daimon list --tag web --compact` always returned `[]` (compact rows
have no `tags` field to match). A frozen verb's output shape must depend only
on `--full`/`--compact`. Filtering now happens on the daemon via the new
`?tag=` / `?workspace=` query params.

**Migration:** pass `--full` if you scripted against the verbose rows of a
filtered list. Plain `daimon list --tag <t>` now returns the same compact rows
as plain `daimon list` — and `--tag` + `--compact` actually works.

## Additive consistency fixes (not breaking)

- `GET /api/apps/:name/wait` accepts `?timeoutMs=` alongside the legacy
  `?timeout=` (seconds) param, matching every other wait-style endpoint.
- `GET /api/apps` accepts `?tag=` (repeatable, AND semantics) and
  `?workspace=` server-side filters.
- `daimon wait` usage text now states the real default (`--timeout 120s`).

## Stability tiers (M87)

Every CLI verb, HTTP endpoint, MCP tool, config key, and event kind now
declares `frozen` / `stable` / `experimental` at its source of truth, rendered
in `docs/index.html`. Frozen surfaces are pinned by golden-shape snapshots in
`test/fixtures/contract/` (`test/contract.test.mjs`); a frozen surface without
a snapshot fails the suite. See `STABILITY.md` for the promise each tier makes.

Deliberate exception: `GET /api/signature` (born v0.13) is **frozen** — it is
the cross-version identification handshake that port forensics, doctor's
verify-then-kill, and the v0.14 CLI/daemon skew warning all rely on.

## What else landed

- **Lifecycle hardening (M88).** `daimon daemon restart` hands off RUNNING
  children: the new daemon verifies each (the pid the old daemon saw listening
  on the app's port — alive and still the listener) and re-adopts it with the
  same pid. Unverifiable children get the new `orphaned` status with a
  per-case remedy — never silently dropped, never blindly killed. All
  daemon-rewritten `~/.daimon/*.json` files are written atomically with a
  `.bak`; a corrupt `state.json` recovers from the backup or archives itself
  (`state.json.corrupt-<ts>`) and starts fresh, with a self-warn event either
  way. A CLI↔daemon version mismatch warns once on stderr with the remedy —
  never a hard fail. Torture-tested in `test/lifecycle-torture.test.mjs`.
- **WCAG AA dashboard audit (M89).** Keyboard-only operation on every route,
  contrast fixed at the `--dm-*` token layer for both themes, ARIA
  landmarks/labels/aria-live, `prefers-reduced-motion` support, and an
  automated axe gate (zero serious/critical, 1280px + 390px) in the Playwright
  drive via `@axe-core/playwright` — the release's single new devDependency.
- **First-15-minutes pass (M90).** README rewritten for strangers and verified
  command-by-command against a clean `DAIMON_HOME`; `SECURITY.md` states the
  posture (loopback-only, no telemetry ever, same-tick env redaction, plugin
  trust model, verify-then-kill); every user-facing error now names its next
  step, enforced by `test/error-remedies.test.mjs`.
- **Debt wave (M91).** `daimon config validate` + load-time unknown-key
  warnings with nearest-name suggestions; fixed `daimon profiles suggest`
  (dispatched as "unknown command" since v0.12); `DAIMON_HOME` honored in the
  TUI attach-token path; `src/parser.ts` de-binarified for grep; the two
  historically contention-flaky perf tests made contention-immune (ratio
  budgets — absolute quiet-machine budgets unchanged); npm tarball audited by
  test (ships `docs/` + `daimon.config.example.json`; never fixtures or a
  personal email); a doctor coverage table in the docs mapping every recurring
  failure class to its rule, auto-fix, or documented gap.

## Migration

1. Replace `uptime` with `uptimeMs` wherever you read compact status,
   `ensure` results, MCP `get_status`, or `daimon daemon status`.
2. Add `--full` to `daimon list --tag/--workspace` invocations that expected
   verbose rows.
3. Nothing else. Configs are untouched — any config that loaded under v0.1
   still loads under v0.14. The history DB schema is unchanged; state.json
   gains only a `.bak` sibling.

## The v1.0.0 plan

v1.0.0 is **not** tagged here. After the freeze survives a real-usage soak
period, v1.0.0 will be tagged by hand as a near-empty release: same surfaces,
same shapes, a version number that says what the contract tests already
enforce.
