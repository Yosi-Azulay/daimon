# daimon v1.4.0 — "Carry-Out"

Get data out of daimon cleanly. daimon knows everything that happened on this
machine and, until now, shared none of it beyond its own surfaces — people
screenshotted the dashboard to hand a colleague "what happened here this
week". v1.4 is the carry-out release: one versioned export bundle composed
from existing history, a print stylesheet for the Report page, shell
completion that provably matches the verb surface, and a deterministic demo
script. A deliberately small release: **nothing new is recorded; everything
new is a door.**

```bash
daimon export --since 7d --out week.json    # canonical JSON bundle, atomic write
daimon export --format md                   # paste-ready markdown
daimon export --app web --format csv        # flat rows: section,ts,app,summary,detail
daimon completion powershell | Out-String | Invoke-Expression   # every verb through v1.4
node scripts/demo/run-demo.mjs              # deterministic screencast session
```

## What's new

- **`daimon export` (M111, experimental)** — a self-contained bundle of
  events, fingerprint-folded error groups, test runs, compiles, crash
  reports, and the full report over a window (default 7d), composed from the
  queries that already exist. The envelope is versioned — `schemaVersion: 1`,
  additive-only evolution, readers ignore unknown keys — and snapshot-pinned
  in the contract suite from day one, because it is a consumed format.
  Sections degrade independently to `{ note }`; an empty history exports a
  valid bundle. Three permanent rules: **export is one-way** (no `daimon
  import`, ever — import edges toward sync, a standing NO); **redaction
  holds** (env key names + salted hashes only, never values, never the
  personal email — grep-asserted in json, md, and csv); **no raw log lines**
  (crash entries keep only their existing bounded tail). `--out` writes
  tmp-then-rename; stdout otherwise. Same surface on
  `GET /api/export?since=&app=&format=json|md|csv` and MCP `daimon_export`
  (30 tools). Bench: full JSON bundle over the 100k-event corpus < 750ms.
- **Report print stylesheet (M112)** — print (or Save-as-PDF) the dashboard
  Report page and get clean black-on-white regardless of theme: chrome
  hidden, sections kept whole across page breaks, headings glued to their
  content, shadows and animations stripped. Token-layer only (one
  `@media print` override of the color tokens + structural hides) — no JS,
  no component changes, screen rendering untouched. Verified via Playwright
  `emulateMedia({ media: 'print' })` against a dark-themed seeded page; axe
  stays zero serious/critical.
- **Shell completion, regenerated for good (M113)** — all four generators
  (bash/zsh/fish/PowerShell) now derive from `cliSurface.ts` through one
  shared model: every verb, alias, flag, and dispatch subword through v1.4
  completes. Committed output in `completions/` + `npm run build:completions`
  to regenerate, and a byte-for-byte drift test so hand edits or forgotten
  regens fail the suite. Install one-liners are in the README.
- **Deterministic demo script (M114)** — `scripts/demo/run-demo.mjs` spawns a
  real daemon under a throwaway `DAIMON_HOME`, seeds two fixture apps, drives
  a fixed session (start → error surfaced → report → export), and cleans up
  after itself. A test runs it end-to-end and asserts the real `~/.daimon` is
  untouched. GIF recording stays human; the session is now replayable.

## Migration

None required — every change is additive:

- **Database**: no schema changes at all this release — no new tables, no new
  columns. A v1.3 `history.db` opens clean under v1.4 and vice versa.
- **Config**: zero new config keys. An untouched config behaves exactly as
  under v1.3.
- **Shapes**: no frozen or stable shape changed. New surfaces (all
  `experimental`): CLI `export`; HTTP `GET /api/export`; MCP `daimon_export`.
  The export envelope carries `schemaVersion: 1` and evolves additive-only —
  consumers should ignore unknown keys.
- Edge worth knowing: `daimon export --format csv` is a flat convenience
  view (`section,ts,app,summary,detail`, report section not flattened), not
  a second schema — anything programmatic should consume the JSON bundle.

## Deferred-stretch sweep (M114)

Every still-open deferred/stretch item from the v0.13–v1.3 cycles was
re-read and dispositioned (full table in `goals/v1.4-stretch-sweep.md`).
Absorbed by this release: `daimon export` (M111), the report print
stylesheet (M112), completion regen (M113), the screencast/demo script
(M114). Still deferred — carried forward explicitly, not silently dropped:

- **Bundle-size deep pass** (v0.14 Tier 3) — open-ended dependency/tree-shake
  audit; the <150KB gzip gate still holds each release, but the deep pass
  remains investigative work.
- **Per-workspace report filter beyond `--workspace`** (v0.13 stretch) —
  repeatable/multi-workspace scoping needs new CLI/HTTP surface.
- **Group-level webhook/notification routing** (v1.1) — needs per-group
  config schema + dispatch logic.
- **Log bookmarks** (v1.2) — needs persisted state plus a create/list/delete
  surface.
- **GPU / disk-IO / network / container stats** (v1.3 stretch) — whole new
  sampling domains beyond RSS/CPU.
- **`daimon top --watch` live mode** (v1.3 stretch) — needs a polling render
  loop with its own test coverage.

## Verification

- `npm test` — full suite green (count and timing recorded in the release
  summary), including the new `test/export.test.mjs`,
  `test/completion.test.mjs`, `test/demo-script.test.mjs`, the extended
  redaction suite (bundle greps in all three formats), and the new export
  contract snapshot.
- Export bench < 750ms on the 100k corpus; report bench unchanged < 500ms.
- Playwright drive incl. the new print spec; axe zero serious/critical.
- One caveat logged honestly: the zsh completion script is verified by
  parity with the execution-tested bash generator and by manual quoting
  trace — no zsh binary was available on the build machine. A zsh smoke test
  (`source <(daimon completion zsh)`) on a machine with zsh is a worthwhile
  post-release check.

## Publish checklist (human, 2FA)

1. `npm publish` (prepublishOnly runs build + tests + bundle + dashboard).
2. `git push origin main --tags`.
3. `cd vscode-extension && vsce publish` (extension bumped to 1.4.0).
4. Optional: re-record the README GIF from `node scripts/demo/run-demo.mjs`.
