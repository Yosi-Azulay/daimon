# daimon v1.12.0 — "Wayfinding"

Part 2 of the UI redesign trilogy (M156–M161). v1.11 gave the dashboard a visual
language; **v1.12 gives it an information architecture**: navigation grouped by
task, one unified command palette, a real overview home, and an app page you can
actually read — while holding the one hard rule that **every URL that worked
before still resolves**.

This release **recomposes existing APIs**. There are **no new HTTP endpoints, no
new config keys, no history migrations, and no new dependencies**. The daemon,
CLI, and MCP surfaces are untouched; no frozen shape moved. It is a
dashboard-only release.

---

## What changed

- **Grouped navigation (M156).** The flat fourteen-entry rail is now three
  task groups — **Observe** / **Investigate** / **Configure** — defined once in
  `dashboard/src/app/nav-model.ts`. A new **active-context breadcrumb** in the
  topbar shows *group › page › app*.
- **Command palette 2.0 (M157).** One fuzzy-ranked list unifying navigation,
  app jumps, actions, and search. `>` still forces search-only; plain typing
  ranks commands and shows search hits beneath. Recents persist in
  localStorage. Actions cover start/stop/restart/mute/test.
- **Overview home (M158).** `/` is now an overview composing existing
  endpoints (status, needs-attention, test pass-rate, resource glance); each
  widget degrades independently to a note. The apps list moved to `/apps`.
- **Sectioned app detail (M159).** Tabs became scroll-spy-highlighted sections
  with stable `#anchors`, plus a consistent header action row.
- **Responsive + guided empty states (M160).** Full 390px pass on the new IA;
  fresh-install empty states name what will appear and which command feeds it.

---

## Migration — URLs that changed

**Nothing 404s.** Every URL below still resolves to a rendered page. The only
literal route redirect is the pre-existing catch-all (`**` → `/`).

| URL shape (before) | Now resolves to | Note |
|---|---|---|
| `/` | The **overview home** (was the apps list) | Still resolves; the apps list moved to `/apps`. |
| `/apps` | The **apps list** (new canonical route) | Additive; the same component the apps list always used. |
| `/?group=<name>` | The overview home (group param ignored there) | The group-chip filter now lives at **`/apps?group=<name>`**. |
| `/apps/:name` | App detail (unchanged) | No move. |
| `/apps/:name?tab=errors\|logs\|history\|env\|why` | App detail, scrolled to the mapped section | `history` → `#timeline`, `env` → `#overview`, others → their own `#anchor`. Legacy `?tab=` inputs are permanent. |
| `/logs/:name`, `/logs/:name?from=search` | Per-app logs (unchanged) | No move. |
| `/timeline?ts=&app=&kind=&session=`, `/timeline?at=&app=`, `/timeline?session=` | Timeline (unchanged) | v1.8 / v0.13 deep-links preserved. |
| all other routes (`/events`, `/errors`, `/history`, `/trends`, `/tests`, `/sessions`, `/agents`, `/regressions`, `/report`, `/doctor`, `/config`, `/history/:name`, `/requests/:name`) | themselves (unchanged) | No move. |

The complete inventory lives in `dashboard/e2e/route-audit.ts`, and
`dashboard/e2e/redirects.spec.ts` drives every entry and asserts it resolves — a
release gate.

### New section anchors (a deep-link contract from here on)

`/apps/:name#overview`, `#errors`, `#logs`, `#tests`, `#timeline`, `#why`. Once
shipped these ids never rename.

---

## `data-testid` migration table

**No `data-testid` was renamed or removed.** The contract is maintained; the
Playwright specs were updated only where a selector's **page moved**:

| `data-testid` / selector | Change | Where it renders now |
|---|---|---|
| `plugins-badge` | unchanged id | now on `/apps` (the apps-list overview strip moved off `/`) |
| `article.c` (app cards), `dm-framework-badge`, `.dm-group-chip-row` | unchanged | now on `/apps` |
| all app-detail selectors (`.dm-action-bar`, `.dm-panel-title`, `.dm-mute-chip`, `.dm-why-note`, …) | unchanged | same page, sectioned layout |

New (additive) selectors introduced this release: `.dm-section-nav` /
`.dm-section-link` (app-detail section nav), `.dm-widget` (home widgets),
`.dm-context` (topbar breadcrumb). No existing selector changed.

---

## Gates

tsc clean (3 projects) · dashboard unit tests green · perf bench green · bundle
< 150 KB gzip · doctor clean · redaction + contract suites green · axe zero
serious/critical at 1280 + 390px · **redirect suite green (zero broken
pre-existing URLs)**.

## Not shipped (unchanged standing NOs)

New HTTP endpoints, new analytics, new config keys, history migrations, new
deps, remote/non-loopback, multi-user/auth, cloud sync, telemetry. The TUI
navigation redesign is v1.13 (part 3 of the trilogy).

---

*Public author: Yosi Azulay (https://flycotech.com). The human runs `npm publish`
(2FA), `git push`, and `vsce publish`.*
