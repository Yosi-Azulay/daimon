# daimon v1.5.0 — "Plugin API v1"

Plugins existed as a trapdoor: daimon loaded whatever sat in `~/.daimon/plugins`
and hoped. No contract, no version handshake, no isolation — one bad `require`
took the daemon down, and nobody could write a plugin without reading daimon's
internals. v1.5 turns that trapdoor into a documented, versioned, crash-isolated
hook surface — **deliberately tiny, observe-only, and honest about what it is.**

```js
// ~/.daimon/plugins/my-plugin.mjs
export default {
  name: 'my-plugin',
  apiVersion: 1,
  onEvent(evt) { /* every event, off the write path */ },
  onAppStart(app) { /* frozen { name, framework, port, pid, status } */ },
  onAppStop(app) { },
  registerDoctorRules() { return [/* advise-only rules */]; },
};
```

```bash
daimon plugins            # what loaded, what didn't, and why
daimon plugin validate ./my-plugin.mjs   # offline shape check
daimon doctor             # includes plugin-contributed rules + plugin-load-error
```

## What's new

- **Hook surface v1 (M116, experimental)** — a plugin exports
  `{ name, apiVersion: 1 }` plus any of four optional hooks: `onEvent(evt)`
  (a frozen copy of each event record, dispatched fire-and-forget AFTER the
  registry/history write — a slow plugin delays nothing, benched),
  `onAppStart(app)` / `onAppStop(app)` (frozen app snapshots on status
  transitions to `starting`/`stopped`), and `registerDoctorRules()` (advise-only
  `{ id, description, check(ctx) }` rules — **no auto-fix capability for plugin
  rules in v1**). Hooks may be sync or async; every return value except doctor
  rules is ignored; mutating a snapshot can never reach registry state.
  Loading: `~/.daimon/plugins` only (via `daimonDir()`; `plugins.dir` config
  still overrides), enumerated once at startup — no watch, no hot reload;
  `daimon daemon restart` is the reload story. Validation at load: missing
  `name`/`apiVersion`, unknown `apiVersion`, a non-function hook field, or a
  duplicate name → that file is skipped with a self-warn naming the file and
  reason; non-JS files are ignored silently. A hookless plugin is valid.
- **Crash isolation (M117)** — the reason the API can exist. Every plugin file
  loads in its own try/catch: a throw at import (syntax error, bad require)
  marks that file `load-error` and its siblings load normally. Every hook call
  is wrapped — sync throws and async rejections both land in the same place:
  the first throw disables the plugin **for the session** (status `disabled`,
  all hooks unhooked, doctor rules deregistered) with exactly one
  `plugin-error` self-event carrying plugin, hook, and stack. No retry, no
  auto-re-enable; a restart reloads fresh. Torture-tested in
  `test/plugin-isolation.test.mjs` — including two spawns of a REAL daemon
  under an isolated `DAIMON_HOME` that boot through import explosions,
  first-event hook throws, and legacy files, keep serving, and exit 0.
- **`daimon plugins [--json]` (M118, experimental)** — one row per file:
  name, file, apiVersion, status (`active` | `disabled` | `load-error`),
  declared hooks, and the error message for non-active states. Same shape on
  `GET /api/plugins` and MCP `daimon_plugins` (31 tools).
  `POST /api/plugins/scan` now runs plugin-contributed doctor rules.
  Doctor gains `plugin-load-error: <file>` (advise-only — doctor never deletes
  or edits a user's plugin files) and runs plugin rules as
  `plugin:<name>/<rule>` checks. `/api/overview` (and the dashboard overview)
  carry a `plugins` count badge when plugin files exist — pointer only.
- **PLUGINS.md (M119)** — the honest manual: trust model first (see Migration
  below for the one-sentence version), full API reference, lifecycle,
  `apiVersion` policy, and a cookbook whose snippets are the actual example
  sources (drift-tested, not paraphrased).
- **Example plugins (M120)** — `examples/plugins/events-to-jsonl.mjs` (observe
  hook → JSONL file) and `examples/plugins/custom-doctor-rule.mjs` (doctor-rule
  contribution end-to-end). Both are exercised code — loaded from an isolated
  `DAIMON_HOME` in the suite — and ship in the repo but **not** in the npm
  tarball (`npm pack --dry-run` asserted in the suite).

## The trust model, stated plainly

Plugins are opt-in and **NOT sandboxed**. They run in-process with full Node
privileges; daimon only loads files you placed in your own `~/.daimon/plugins`
directory yourself, and treats them as code you chose to run. Claiming a
sandbox for in-process trusted-by-placement Node code would be a lie, so
PLUGINS.md says exactly that instead. **No marketplace, no remote fetch, no
auto-install — ever.** What v1.5 adds is *crash* isolation (a throwing plugin
is disabled, never daemon-down), not *privilege* isolation.

## Migration

No config changes, no history migrations (the `plugin-error` event kind rides
the existing events pipeline). One behavior change to know about:

- **Existing `~/.daimon/plugins` files are now validated against Plugin API
  v1.** Files without `{ name, apiVersion: 1 }` stop loading and surface in
  `daimon plugins` (and doctor's `plugin-load-error`) with the reason. This
  includes pre-v1.5 `doctor-*.mjs` plug-ins (`{ name, scan }` — the v0.8
  escape hatch, whose `fix` surface was never implemented): they get a
  specific migration message — wrap your `scan()` findings in
  `registerDoctorRules()` (see PLUGINS.md, "Migrating a pre-v1.5 plug-in").
  The loader now accepts any `.mjs`/`.js`/`.cjs` filename, not just
  `doctor-*.mjs`.
- **`GET /api/plugins` rows changed shape** (was the v0.8 doctor-plug-in
  listing; both plugin endpoints are re-tiered `experimental` as part of this
  reshape): rows now carry `apiVersion` + `hooks`, and `status` values are
  `active`/`disabled`/`load-error` (were `ok`/`failed`). `daimon plugin
  list|show|validate` keeps working against the new rows; `validate` now
  checks the v1 shape offline.
- Everything else is additive: new CLI verb `plugins`, MCP tool
  `daimon_plugins`, event kind `plugin-error`, the `/api/overview` `plugins`
  key (present only when plugin files exist) — all `experimental`. No frozen
  shape changed. A v1.4 `history.db` opens clean under v1.5 and vice versa.

## Verification

- `npm test` — 835 tests, full suite green (v1.4.0: 795; one ambient-load
  flake observed in `lifecycle-torture` restart-under-load — a file v1.5
  did not touch, green in isolation and on re-run, same class v1.4's release
  notes named), including
  the rewritten `test/plugins.test.mjs` (loader + host + write-path bench),
  the new `test/plugin-isolation.test.mjs` (torture, incl. real-daemon
  spawns), `test/plugin-surfaces.test.mjs` (HTTP/doctor/overview shapes), and
  `test/plugin-examples.test.mjs` (examples exercised from a clean isolated
  home + tarball exclusion).
- Hook-dispatch bench: 10k dispatch schedulings with a no-op plugin loaded
  stay under the generous absolute budget — the synchronous cost on the event
  write path is one array check + one `setImmediate`.
- Playwright 136/136 (v1.4: 128; +8 = the plugins-badge spec across both
  viewports), axe zero serious/critical, driven against an isolated
  `DAIMON_HOME` daemon on a side port — never the real state dir.
- Dashboard initial transfer 134.24 kB gzip (<150 kB gate; v1.4: 134.25).
- `npm pack --dry-run`: 773.5 kB / 146 files (v1.4: 764.2 kB / 146) — no
  `examples/`, no test files, no personal email.

## Publish checklist (human, 2FA)

1. `npm publish` (prepublishOnly runs build + tests + bundle + dashboard).
2. `git push origin main --tags`.
3. `cd vscode-extension && vsce publish` (extension bumped to 1.5.0).
