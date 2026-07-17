# daimon v1.1.0 — "Morning Start"

Named app groups so one command starts the whole day's working set. The first
feature release under the post-1.0 rules: **everything is additive**, every
new surface ships tier `experimental`, and no frozen or stable shape changed —
the contract suite that pins them ran green throughout.

```jsonc
// daimon.config.json
{
  "groups": {
    "day": ["api", "web-admin", "storefront"],
    "night": { "apps": ["api", "worker"], "autoStart": true }
  }
}
```

```bash
daimon up day          # depends-aware topo start + "3/3 healthy" summary
daimon status --group day
daimon logs --group day    # members' tails merged by timestamp
daimon stop day        # members only, reverse depends order
```

## What's new

- **`groups` config key (M93)** — shorthand form (`name: string[]`) is exactly
  the legacy `profiles` shape; object form adds `autoStart`. Groups additively
  subsume `profiles`: a name in both resolves to the group (validate warns);
  `profiles` keeps loading forever.
- **`daimon up/stop/down <group>` (M94)** — start order from the existing
  `depends` graph (groups read the graph, never change it); readiness summary
  with a `3/4 healthy` tail; exit 0 all reached / 2 otherwise; per-member
  soft-lock gating (a refused member counts unhealthy, never aborts the rest);
  cyclic members reported, not started. App-name precedence is absolute on the
  frozen `stop` verb. HTTP: `POST /api/groups/:name/up|stop`, audit-logged.
- **`--group <g>` read filters (M95)** — `list`, `status`, `errors`, `report`
  (+ `?group=`), plus `GET /api/groups/:name/status|logs`. Byte-identical
  shapes when the flag is absent; unknown group exits 1 naming the valid ones.
- **autoStart groups (M96)** — start at daemon boot with per-app-list
  semantics; overlapping sources dedup at resolution (one spawn, one log line
  naming every source); per-member failure degrades, never blocks boot.
- **TUI + dashboard (M97)** — `G` chord cycles the group filter (header:
  `group: day · 3/4 healthy`); dashboard group chips, grouped app list, and
  membership on the app detail card — WCAG AA maintained (axe gate green at
  1280px and 390px).
- **MCP (M98)** — `ensure_up` resolves groups first; `stop_app` falls back to
  a group only where the app name previously errored; `daimon_report` gains
  `group`; new `daimon_groups` tool. 28 tools.

## Migration

None required — every change is additive:

- The `groups` key is optional; a config without it behaves identically to
  v1.0 (including boot). Any config that ever loaded still loads.
- `profiles` is untouched and keeps working forever; `daimon up <profile>`
  output is byte-identical. If a group and a profile share a name, the group
  wins for `up`/`down`/`stop` — `daimon config validate` warns; rename one to
  silence it.
- No database migration: v1.1 opens a v0.x `history.db` unchanged (and vice
  versa).
- No shape changes to frozen or stable surfaces. New surfaces (all
  `experimental`): CLI `--group` flags and group forms of `up`/`stop`/`down`;
  HTTP `GET /api/groups`, `POST /api/groups/:name/up|stop`,
  `GET /api/groups/:name/status|logs`, `?group=` on `/api/apps`,
  `/api/errors`, `/api/report`; MCP `daimon_groups` + `group` param on
  `daimon_report`; config key `groups`.
- Edge worth knowing: on `daimon errors`, bare `--group` keeps its historical
  fingerprint-grouping meaning; `--group <name>` filters to a group (the value
  `fingerprint` stays reserved for the historical behavior).
- Frozen-verb guard: with no `groups` key in your config, `--group <token>`
  parses exactly as v0.14 did (the token is a positional; the flag stays a
  bare boolean) — scripts written before v1.1 are byte-identical until you
  define groups, which is the opt-in to the value form.

## Publish checklist (human, 2FA)

- `npm publish`
- `git push origin main --tags`
- `vsce publish` (extension bump)
