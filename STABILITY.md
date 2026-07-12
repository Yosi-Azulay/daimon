# Stability

As of v0.14 ("Runway" — the release before 1.0), every public daimon surface
carries an explicit stability tier. A *surface* is anything a consumer can
depend on: a CLI verb and its JSON output shape, an HTTP endpoint and its
response shape, an MCP tool and its result shape, a config key, or an event
kind.

## The three tiers

### `frozen`

**The shape never breaks.** Changes are additive only: new keys, new optional
flags, new enum values may appear; existing keys never disappear, never change
type, and never change meaning. A script or agent written against a frozen
surface today keeps working on every future daimon version.

Every frozen surface has a golden-shape snapshot (key sets + types) in
`test/fixtures/contract/`, enforced by `test/contract.test.mjs`. A frozen
surface **without** a snapshot fails the suite; a shape change on a frozen
surface fails the suite forever after.

### `stable`

**Breaks only with a major version bump**, and then only with a migration note
in the release notes. In practice: safe to build on; if daimon 2.0 ever changes
one of these, the release notes will say exactly what to do.

### `experimental`

**May change in any release.** The young surfaces (everything introduced in
v0.13: `report`, `env`, `ports`, `mute`/`unmute` + notification shaping, the
webhook digest) stay experimental until they've survived real use. Depend on
them, but re-check after upgrades.

## The config back-compat rule (stronger than any tier)

Config files are special: **any `daimon.config.json` that ever loaded keeps
loading, unchanged, forever** — regardless of key tiers. Unknown or legacy keys
warn on stderr; they never fail the load. A v0.1 config loads under every
future version. Tier on a config key speaks to its *semantics* staying put,
not to whether the file parses.

## Where a surface's tier lives

Tiers are declared at each surface's single source of truth and rendered into
`docs/index.html` by `npm run build:docs`:

| Surface | Source of truth |
|---|---|
| CLI verbs | `src/cliSurface.ts` (`stability` field per verb) |
| HTTP endpoints | `src/httpSurface.ts` (`HTTP_ENDPOINTS`) |
| MCP tools | `src/mcp.ts` (`MCP_TOOL_STABILITY`) |
| Config keys | `src/config.ts` (`CONFIG_KEY_STABILITY`) |
| Event kinds | `src/types.ts` (`EVENT_KIND_STABILITY`) |

## Rules for new surfaces

- Every new surface **must** declare a tier at its source of truth; new work
  defaults to `experimental`.
- Promoting to `frozen` requires adding a golden-shape snapshot in
  `test/fixtures/contract/` — the contract suite fails otherwise.
- One deliberate exception to "v0.13 stays experimental": `GET /api/signature`
  is frozen. It is the cross-version identification handshake — port
  forensics, doctor's verify-then-kill, and the CLI/daemon version-skew check
  all depend on every future daimon answering
  `{ daimon, version, pid, startedAt }` on that path.

## The forward-looking promise

v0.14 is the last release with a breaking-changes section (see
`RELEASE-v0.14.0.md`, "Breaking changes (the last)"). After the freeze has
survived a real-usage soak period, v1.0.0 will be tagged as a near-empty
release: same surfaces, same shapes, a version number that says out loud what
the contract tests already enforce.
