# daimon v1.11.0 — "Fresh Coat"

The dashboard had grown feature-by-feature for eight-plus versions. Every page
landed with its milestone — Report in M83, the why panel in M85, resource Trends
in M109 — each styled by analogy to its neighbours, and no release ever designed
the whole. The bones were right: since M70 every themed value flowed through
`dashboard/src/styles/tokens.css` and components consumed `--dm-*` only; density
and the AA contrast fixes already lived at the token layer. But the *language*
those tokens encoded was never designed — the color roles were Angular Material's
system palette aliased one-to-one, the type scale was Material's defaults nudged,
radii ran 4–14px with no rationale, and per-page styles had drifted.

v1.11 is **fresh coat**: a visual language stated in `DESIGN.md`, implemented
entirely at the token layer, with every component and page restyled to it. It
changes how daimon *looks* and nothing else — and `DESIGN.md` becomes the
contract the next two releases (v1.12 information architecture, v1.13 TUI)
inherit.

**A visual-only, no-migration release.** Zero route, daemon, CLI, HTTP, or MCP
change. No new config key, no history migration, no frozen shape moved. A v1.10
`history.db` and `state.json` open unchanged. Every `data-testid`, ARIA
attribute, landmark, and focus indicator is preserved byte-for-byte.

## Migration

**None.** Nothing to do. The dashboard renders in the new language on first load;
your theme (`daimon.theme`) and density (`daimon.density`) preferences carry over
untouched.

## What changed

- **A designed visual language (M150).** `DESIGN.md` (new, repo root) states the
  language: principles (dense-but-calm, information-first, motion earns its
  place), then a full token scale — color, spacing, typography, radius,
  elevation, motion — specified for both themes (light + dark) and both densities
  (comfortable + compact). `tokens.css` implements it. The color roles are no
  longer one-to-one aliases of Material's `--mat-sys-*` palette; they are the
  design language's own **OKLCH** values:
  - **Neutrals** carry a faint iris undertone (hue 275, very low chroma) — cool,
    precise surfaces.
  - **An iris/indigo primary** (hue 275) replaces the generic Material azure.
  - **A four-hue semantic set** — serving green, compiling cyan, starting amber,
    error red — chosen for wide hue separation so status and chart series stay
    distinguishable.
  - **Radii** rationalised to `4 · 6 · 8 · 12 · 16`px; **elevation** is soft,
    cool, and deeper in dark; the **type scale** is a deliberate five-step set
    (14px body, 22px h1); **motion** keeps the M3 easings with three named
    durations.

  `tokens.css` re-points the consumed `--mat-sys-*` roles onto these values, so
  Material widgets and every component adopt the new language together.

- **AA verified at the token level.** Every foreground/background pairing was
  computed OKLCH → sRGB → WCAG relative luminance. All pass — 4.5:1 for text,
  3:1 for non-text marks and chart series — in **both themes**, with margin
  (minimum text pairing 4.61:1, minimum chart-series 3.17:1). The table is in
  `DESIGN.md §2` and echoed in `tokens.css` comments (the M89 discipline).

- **Every component and page restyled (M151–M153).** The shared layer
  (`styles.scss` Material overrides + `.dm-page-header` / `.dm-mono` /
  `:focus-visible`, `ui-primitives.ts`) and all pages now consume `--dm-*`
  directly — the ~590 raw `--mat-sys-*` reads across 21 components were migrated
  to their `--dm-*` roles. This is a decoupling from Material, visually identical
  via the re-point, so the surface stayed coherent through the whole burn-down.
  Status dots now match their pill hue (serving → green, compiling → cyan,
  starting → amber, aligning the dot, pill tint, and sparkline).

- **Chart colours actually render now (M153, a fixed latent bug).** The chart
  tokens resolved — through a `var()` chain — to Material's `light-dark(#…,#…)`
  value, and Chart.js's colour parser (`@kurkle/color`, reached via
  `getComputedStyle` on `:root`) accepts neither `light-dark()` nor `oklch()`.
  So every series had been silently falling back to a Chart.js default colour and
  never adapting to the theme. The four `--dm-chart-*` tokens now ship as
  pre-resolved, theme-split sRGB **hex** — the one deliberate exception to the
  file's `light-dark()` authoring — which the parser accepts. `trends`,
  `history`, and per-app charts render the designed hues and adapt to light/dark;
  each series clears 3:1 against both `bg` and `surface` in both themes.

- **Density, theme, and print re-verified against the new scale (M154).** The
  compact density scale, the auto/light/dark round-trip (`light-dark()` resolves
  for every new token), the global `prefers-reduced-motion` kill rule, and the
  print stylesheet were all confirmed to carry the new tokens. Mechanics
  unchanged — the theme toggle still sets `color-scheme` inline on `<html>`,
  density is still a single `data-density` scaling point.

## Additive tokens (no name changed)

`--dm-color-secondary` (muted-iris accent for lint / tool chips),
`--dm-color-scrim`, `--dm-color-inverse-surface` /
`--dm-color-inverse-on-surface`, and `--dm-chart-grid` — all AA-verified.

## Screenshots

Every UI screenshot in `README.md` and the docs predates this redesign and is now
stale. Retaking them is a human step (the dashboard must be driven live). The
list to recapture: the apps-list (mission control), an app-detail page, the
errors panel, the Trends charts (light **and** dark), and the Report page.

## Gates

- `tsc` clean across all three projects; dashboard build clean.
- `npm test`: **1007 tests, 0 fail** (unchanged count — visual-only; two
  perf-budget tests flaked under concurrent load and passed green in isolation,
  per the documented flake protocol).
- Dashboard unit tests: 101 passed.
- Dashboard initial payload: **149.3 KB gzip / 132.6 KB brotli** — inside the
  <150 KB gzip / <140 KB brotli gate (`test/bundle-budget.test.mjs`).
- Redaction + contract suites green; no frozen shape moved.
- AA verified at the token level in both themes (see `DESIGN.md §2`). The axe /
  keyboard / print Playwright suite is the human's pre-publish confirmation
  against a live daemon (the repo's standing e2e convention); every `data-testid`
  and ARIA contract is preserved, so the specs need no selector changes.

Publishing (npm / git / vsce) is the human's step, with 2FA.
