# daimon v1.2.0 — "Log Sense"

Log levels, live filtering, and storm detection — the firehose made readable.
Every ingested line now gets a classified level (declared per framework in the
registry, never guessed in code), `daimon logs` filters by level/regex/time,
and a volume spike against an app's own baseline is an event, not a discovery.
Everything is additive; every new surface ships tier `experimental`; the
contract suite that pins frozen shapes ran green throughout.

```bash
daimon logs web --level error --since 15m     # only classified-error lines
daimon logs web --level error --grep "EADDR.*" --stream   # filtered live tail
daimon report            # errors section now ends with a log-volume line
daimon doctor            # flags `log-storm-active: <app>` while a storm holds
```

## What's new

- **Level classification (M99)** — a new optional `FrameworkProfile` field
  `logLevelPatterns` (ordered regex→level rows, first match wins, compiled
  once, validated as data). Shipped for the frameworks whose docs define the
  convention: angular/nx (esbuild `✘ [ERROR]` / webpack `ERROR in`), vite,
  next (`⨯`/`⚠`/`✓`), django/flask (Python logging), rails (Ruby Logger),
  dotnet (`crit:`/`fail:`/`warn:`/`info:`/`dbug:`/`trce:`). Everything else
  uses a conservative shared heuristic (error/warn/info word near line start,
  ANSI-stripped, "0 errors" summaries excluded) — explicit non-participation,
  no guessing. Classification is **fail-soft at ingest**: any miss or error
  stores the line with level `null`; a classifier bug can never drop or delay
  a log line. Fixture-gated like every registry field since M65.
- **`daimon logs` filtering (M100)** — new `--level <error|warn|info|debug>`
  (composes AND with the existing `--grep`/`--since`/`--tail`), same
  `?level=` on `GET /api/apps/:name/logs`, its SSE stream, and
  `GET /api/groups/:name/logs`; MCP `get_logs` gains optional `level` and
  `grep` fields. Filters apply in `--stream` follow mode per line at delivery.
  `--level` returns only lines *classified* at that level — unclassified
  lines are excluded by design. Bare `daimon logs <app>` output is
  byte-identical to v1.1.
- **Log-storm detection (M101)** — per-app rolling lines-per-minute baseline
  (in memory, no new tables); a sustained spike ≥ `multiplier` × the app's own
  baseline raises exactly one `log-storm` event, with one `log-storm-end` on
  recovery (baseline frozen at entry, exit at half the entry threshold — no
  event spam from a flapping rate). Apps with under 3 minutes of history never
  storm; a restart resets the baseline. Tune via `logs.storm { multiplier: 10,
  windowSec: 60 }` (optional, safe defaults). The OS-notification kind
  `log-storm` is **opt-in** via `notifications.kinds` — absent = no new noise.
  Doctor gains `log-storm-active: <app>` (suggest-only, names the rate,
  baseline, and remedy); `daimon why` gains `logStorm`; status summaries carry
  a `logStorm` marker while storming.
- **TUI (M102)** — `l` on the log pane cycles the level filter (all → error →
  warn → info → all, indicator in the pane header); `/` is now a live grep
  (narrows per keystroke, invalid regex falls back to substring, Escape
  clears, Enter keeps) — both client-side over the streamed lines.
- **Dashboard (M102)** — level chips with live counts, a regex filter box with
  inline invalid-pattern error, a storm banner while the app storms, and
  jump-to-search deep-links both ways (reusing the M85 plumbing). WCAG AA
  maintained (axe gate green at 1280px and 390px).
- **Report (M103)** — the errors section gains a log-volume line (total lines,
  error-level share, storms in the window), rendered in `--md` and on the
  dashboard Report page; no log data degrades it to a note, never an error.

## Migration

None required — every change is additive:

- **Database**: v1.2 adds a nullable `level` column to `log_lines` via a
  guarded `ALTER TABLE`. A v1.1 `history.db` opens clean under v1.2 (old rows
  read back with level `null`); a v1.2 db opens clean under v1.1 (all inserts
  name their columns). No action needed either direction.
- **Config**: all new keys optional with safe defaults. Absent `logs.storm` =
  detection with defaults; `log-storm` notifications fire only if you add the
  kind to `notifications.kinds`.
- **Shapes**: no frozen or stable shape changed. Bare `daimon logs` output is
  byte-identical; the SSE stream payload stays `{ts,line}` unless you opt in
  with `?levels=1`. New surfaces (all `experimental`): `--level` on `daimon
  logs`; `?level=` on the logs routes + `?levels=1` on the stream; MCP
  `get_logs.level/grep`; config keys `logs.storm`; event kinds `log-storm`,
  `log-storm-end`; notification kind `log-storm`; doctor rule
  `log-storm-active`; registry field `logLevelPatterns`; report
  `errors.logVolume`.
- Edge worth knowing: `--level error` excludes lines daimon could not
  classify. For a superset take the unfiltered tail or `--grep` yourself.

## Publish checklist (human, 2FA)

- `npm publish`
- `git push origin main --tags`
- `vsce publish` (extension bump)
