# daimon v1.6.0 — "Agent Ledger"

daimon has always known who was calling. Every request carries an
`X-Daimon-Agent` header, the audit log has recorded the agent column since the
6-column format landed, and the LockManager arbitrates when two Claudes reach
for the same app. But none of it was **queryable**: the audit log was a file you
opened by hand, the agent registry answered only "who's here right now", and
lock contention evaporated the moment it resolved. v1.6 is the agent ledger —
the trail becomes a query, the actors get names, contention becomes visible, the
dashboard shows it, and the MCP server grows resources and prompts so agents
consume daimon the way the protocol intends.

```bash
daimon audit --agent host-1234-ab12 --since 2h   # who did what, when
daimon audit --app web-admin --json              # every action on one app
daimon agents                                     # the roster + contention
```

Agent identity stays **advisory** — a self-declared header, never authenticated.
The ledger records what each *declared* identity did, not who they really were,
and every output and doc says so.

## What's new

- **`daimon audit [--agent --app --since --limit --json]` + `GET /api/audit`
  (M122, experimental)** — the queryable trail. It reads `audit.log` + the
  rotated `audit.log.1` and derives `{ ts, agent, action, app, changedKeys,
  remote }` rows from the existing 6-column `verb:<app>` changedKeys convention
  that `test:<app>` established — **no new column, no format change, rotation
  untouched.** The mutating lifecycle actions the daemon already gates now leave
  a row: `start`, `stop`, `restart`, `steal` (a `?steal=1` override — written
  durably so live-steal counts survive a restart), `handoff`, `mute`, `unmute`
  (config writes and group actions were already audited). Filters compose (AND),
  newest first, default limit 100. Fail-soft: malformed or truncated lines are
  **skipped and counted** in a `skipped` field — never an error, never a
  fabricated row; a legacy 5-column row surfaces with `agent: null`.
- **`daimon agents [--json]` + roster on `GET /api/agents` (M123, experimental
  additive)** — the roster names every actor. The endpoint keeps its
  `agents`/`locks`/`self` keys byte-for-byte and ADDS `roster` and `contention`.
  Each roster row — `{ id, lastSeen, active, cwd, callCount, firstSeen, actions,
  locks, waits, steals }` — MERGES the live in-memory registry (5-minute
  activity window) with audit-derived history (firstSeen + per-action counts
  across both files) and the LockManager's held locks. An agent that acted
  earlier but is idle now still appears (`active: false`); rows with no declared
  agent aggregate under `(unknown)`. Computed on demand — **nothing persisted.**
- **Lock analytics + report deepening (M124, experimental)** — the LockManager's
  in-memory interaction ring (widened 16 → 64, still memory-only) now tags each
  event's outcome: `denied` (an acquire refused because another agent held a
  live lock), `steal-live` vs `steal-after-expiry`, `acquired`, `handoff`.
  `GET /api/agents.contention.hotspots` surfaces per-app waits / steals (the
  durable count from `steal:<app>` audit rows) / steals-after-expiry /
  longest-hold; per-agent `waits`/`steals` ride each roster row. The report's
  existing (closed-list) **agents** section deepens with top agents by action
  count and contention hotspots, degrading to its `{ note }` with no agent data;
  `--md` renders both; the report perf budget (<500 ms on the 100k corpus) still
  holds.
- **MCP deepening — resources + prompts + tools (M125, experimental)** — the SDK
  gate ran first: the shipped `@modelcontextprotocol/sdk` **1.29.0** was verified
  to expose `registerResource` (string URI + `ResourceTemplate`) and
  `registerPrompt` cleanly — **no upgrade, no new dependency, lockfile
  untouched.** Resources (read-only, thin `callJson` wrappers with the agent
  header forwarded, JSON contents): `daimon://report`, `daimon://context/{app}`,
  `daimon://logs/{app}` (200-line cap). Prompts (rendered from LIVE API data,
  never canned): `triage` (why + errors + recent logs for one app) and `handoff`
  (current state + lock holder + what the next agent should know). Tools:
  `daimon_audit` and `daimon_agents` — **32 tools.** Every addition is
  contract-tested: `test/mcp-contract.test.mjs` enumerates tools, resources, and
  prompts and invokes each with the daemon down → structured error, never a hang.
- **Dashboard — agents panel + lock badge (M126, experimental)** — the agents
  page renders the roster (id, last-seen, per-action count chips, held locks)
  plus a contention section and a timeline deep-link per agent; app cards carry
  a soft-lock badge (holder id + expiry in the tooltip) that clears on TTL
  expiry without a reload. Token-layer styling, both themes, 1280 + 390 px;
  Playwright + `@axe-core/playwright` (zero serious/critical) via `/api/agents`
  route interception.

## Identity is advisory — stated plainly

daimon does not and will not authenticate agents. The `<host>-<pid>-<rand4>` id
is a self-declared HTTP header; anyone can send any value. The ledger answers
"what did each declared identity do", not "who really did it". Per-agent
permissions, quotas, and rate limits are out of scope forever — **the ledger
records, it does not police.** This is written into `daimon audit` / `daimon
agents` `--help`, the JSON responses (`advisoryIdentity: true`), the report, the
dashboard, and the MCP tool/prompt descriptions.

## Migration

**No history migration** (v1.6 adds no tables and no columns — a v1.5 `history.db`
opens clean both directions, and vice versa). **No new config keys.**

- **The audit log gains `verb:<app>` action rows** in the existing 6-column
  format (`start:<app>`, `stop:<app>`, `restart:<app>`, `steal:<app>`,
  `handoff:<app>`, `mute:<app>`, `unmute:<app>`). Old parsers are unaffected —
  `parseAuditLine` reads 5- and 6-column rows identically, and nothing about the
  column layout or the 1 MB → `.1` rotation changed. If you grep the audit log
  yourself, you'll now see these lifecycle rows alongside the config-write rows
  you saw before.
- **`GET /api/agents` is unchanged for existing consumers** — the `agents`,
  `locks`, and `self` keys are byte-for-byte identical; `roster`, `contention`,
  and `advisoryIdentity` are additive.
- Everything else is additive: new verbs `audit` and `agents` (the latter's
  output enriched, its stability tier unchanged at `stable`), endpoint
  `GET /api/audit`, MCP tools `daimon_audit` / `daimon_agents`, three MCP
  resources, and two MCP prompts — all tier `experimental`. No frozen shape
  moved; the contract suite stays green.

## What v1.6 deliberately does not add

Authentication or identity verification (identity stays advisory, forever);
per-agent permissions, quotas, or rate limits; audit-log rewriting, editing, or
retention changes (append + rotate only, exactly as before); cross-machine agent
tracking (one machine, one loopback daemon); any new persisted state for the
roster or analytics (derived at query time only); an MCP SDK upgrade or any new
dependency. Standing NOs unchanged: remote/non-loopback, multi-user/auth, cloud
sync, telemetry, a cron engine, a general process manager, loaded-code plugins.
