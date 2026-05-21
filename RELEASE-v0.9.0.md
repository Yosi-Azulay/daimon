# daimon v0.9.0 — Multi-agent observability

Release date: 2026-05-21

## Theme

Daimon has been a single-workspace tool with one user driving it. v0.9 finishes the pivot to **many agents on one machine, each in their own workspace, all sharing one daemon and one dashboard**.

On top of that architectural shift, this release deepens what daimon *sees* (lint as a third signal class), *shows* (a unified event timeline), and *understands* (framework-aware health probes for the v0.7 polyglot stack).

## Added

### Multi-workspace
- `daimon list` defaults to cwd-scoped; pass `--all` to see every workspace's apps.
- New `daimon workspaces list|add|rm|show` for direct registry management.
- New `daimon dashboard` opens the browser to `http://127.0.0.1:4999/?cwd=<cwd>` with the right workspace pre-selected.
- Per-cwd command resolution: `start/stop/restart/status/logs/errors/wait/run` send `?cwd=<process.cwd()>`; a 412 `name-collision` body lists candidates when two workspaces share an app name.
- MCP tools accept an optional `cwd` argument (defaults to the MCP server cwd).

### Lint as a third signal class
- Parser recognizes eslint, biome, ruff, and clippy output. Findings get `level: 'lint'` and never flip app status.
- New events: `lint-new`, `lint-recur`. New filter: `?level=lint`. New summary field: `lintCount`.
- Dashboard severity chips: **errors / warnings / lint / all** with a distinct secondary accent on lint rows.

### Unified event timeline
- New `GET /api/history/timeline` and `daimon timeline` CLI merge events + compile_times + bundles + task_runs into one stream.
- New dashboard route `/timeline` (lazy chunk) with virtual scroll, kind/app filters, and a flyout drawer for the full row payload.

### Polyglot v2 health probes
- Per-framework defaults in `src/healthProfiles.ts` (django → `/admin/login/`, rails → `/up`, fastapi → `/docs`, …).
- Smart probe outcome: 200 / 302 / 401 = healthy; 5xx + connection errors = unhealthy.
- New doctor rule **`health-probe-missing`** writes the profile default into `overrides[<app>].healthProbePath` and soft-reloads.

## Changed

- Audit log gains a 5th column carrying the agent's cwd (sent via the `X-Daimon-Cwd` header).
- Discovery's storage names are uniquified on collision (`<base>@<workspaceLabel>`). `DiscoveredApp.baseName` carries the user-facing identity.
- Smart probe interpretation: explicit allow-list for 200/3xx/401; explicit deny-list for 5xx and `ECONNREFUSED` / `ECONNRESET` / `EHOSTUNREACH`.

## Fixed

- (Carry-over from M46) `TrendChartComponent` skeleton regression: `loading`/`empty`/`title`/`subtitle` now read from signals so the zoneless + OnPush combo reflects late updates.

## Migration

- **Multi-workspace is the migration headline.** Existing single-workspace setups keep working — `daimon list --all` reproduces the v0.8 default behavior. Two agents in different workspaces sharing an app name now coexist; per-app CLI commands resolve automatically from `process.cwd()`.
- **Audit format.** `~/.daimon/audit.log` lines now have 5 tab-delimited columns: `ts \t remote \t sha1 \t changedKeys \t cwd`. Existing 4-column rows still parse (cwd is empty).
- **Discovery storage keys.** Apps with colliding `baseName` get a `<base>@<workspaceLabel>` storage name. Pass `--workspace <label>` or run from a cwd inside the workspace to disambiguate.

## Pre-publish gates passed

- `tsc -p .` clean.
- `tsc -p dashboard/` clean.
- `npm test` green.
- `npm run build:dashboard` clean.
- New parser fixtures (lint-eslint/biome/ruff/clippy) pass.

## Author

Yosi Azulay (https://flycotech.com)
