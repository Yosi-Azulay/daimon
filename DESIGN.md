# daimon — visual design language ("Fresh Coat", v1.11)

This document is the **contract** for how daimon's surfaces look. The dashboard
implements it today; the v1.12 information-architecture release and the v1.13 TUI
redesign inherit it. It is deliberately a *language*, not a component gallery:
principles first, then a complete token scale (color, spacing, type, radius,
elevation, motion) specified for **both themes** (light + dark) and **both
densities** (comfortable + compact).

The single implementation surface is `dashboard/src/styles/tokens.css`. Every
themable value a component consumes is a `--dm-*` custom property defined there.
**A component that hard-codes a color is a defect, not a style choice.** A
contrast fix lands at the token layer, never in a component (the v0.14/M89
discipline).

---

## 1. Principles

1. **Dense but calm.** daimon is a developer's mission-control: many apps, many
   events, many numbers on one screen. The language earns calm by spending color
   sparingly — near-neutral surfaces, one confident accent, semantic hues
   reserved for *meaning* (status, danger, series). Nothing decorative competes
   with the data.
2. **Information first.** Type hierarchy and monospace do the heavy lifting.
   Machine values (ids, ports, paths, counts, timestamps) are always monospace;
   prose is always the sans stack. Whitespace groups; it does not pad.
3. **Motion earns its place.** Motion communicates state change (a route
   entering, a value updating, a panel opening) and nothing else. Durations are
   short, easings are the M3 standard/emphasized curves, and every animation is
   removed under `prefers-reduced-motion`.
4. **One instrument.** Light and dark are the same instrument under different
   lighting, not two designs. Density is a single scaling axis. A token has one
   job and expresses it consistently everywhere.

### Character

A precise instrument, cool at rest. Surfaces are near-neutral greys carrying a
faint **iris** undertone (hue 275); the brand accent is a confident iris/indigo;
status reads through a four-hue semantic set (green · cyan · amber · red) chosen
for wide hue separation so series and states stay distinguishable. The palette
is authored in **OKLCH** for perceptual evenness and predictable contrast.

---

## 2. Color

Authored in OKLCH `oklch(L C H)`. Light and dark are one token via
`light-dark()`, resolved by the `color-scheme` the theme toggle sets on `<html>`
(auto / light / dark; persisted as `daimon.theme`). Chart-series tokens are the
one exception — they ship as pre-resolved sRGB **hex**, theme-split by media
query + attribute selector, because Chart.js reads them through
`getComputedStyle` and its color parser accepts neither `light-dark()` nor
`oklch()` (see tokens.css for the full rationale).

### Roles

| Role | Token | Light `oklch` | Dark `oklch` | Use |
|---|---|---|---|---|
| App background | `--dm-color-bg` | 0.978 0.004 275 | 0.190 0.008 275 | the page |
| Raised surface | `--dm-color-surface` | 0.995 0.002 275 | 0.225 0.010 275 | cards, popovers |
| Surface +1 | `--dm-color-surface-2` | 0.966 0.005 275 | 0.258 0.012 275 | pills, wells, hover |
| Surface +2 | `--dm-color-surface-3` | 0.945 0.007 275 | 0.298 0.013 275 | nested wells, active hover |
| Surface +3 | `--dm-color-surface-4` | 0.924 0.009 275 | 0.338 0.014 275 | highest container |
| Text | `--dm-color-fg` | 0.285 0.017 275 | 0.945 0.006 275 | body, headings |
| Muted text | `--dm-color-fg-muted` | 0.505 0.016 275 | 0.735 0.012 275 | secondary, labels |
| Divider | `--dm-color-border` | 0.902 0.007 275 | 0.370 0.014 275 | hairlines |
| Strong border | `--dm-color-border-strong` | 0.600 0.013 275 | 0.525 0.016 275 | input outline, focus-adjacent |
| Brand / primary | `--dm-color-primary` | 0.505 0.175 275 | 0.780 0.108 275 | actions, links, focus ring |
| On primary | `--dm-color-on-primary` | 0.995 0.002 275 | 0.210 0.030 275 | text on a primary fill |
| Accent | `--dm-color-accent` | 0.510 0.096 232 | 0.795 0.110 232 | secondary emphasis (cyan) |
| Secondary | `--dm-color-secondary` | 0.500 0.045 275 | 0.760 0.045 275 | muted-iris accent (lint, tool chips) |
| Danger | `--dm-color-danger` | 0.545 0.205 27 | 0.730 0.158 27 | destructive, error |

### Status hues

Each is used three ways — as a dot/mark, as same-hue text on a faint tint of
itself (the badge pattern), and as a border — so each carries a text-legible
tone in both themes.

| Status | Token | Light | Dark | Hue |
|---|---|---|---|---|
| serving / success | `--dm-color-serving` | 0.500 0.128 152 | 0.800 0.145 152 | green |
| compiling / info | `--dm-color-compiling` | 0.510 0.096 232 | 0.795 0.110 232 | cyan |
| starting / pending | `--dm-color-starting` | 0.525 0.108 70 | 0.820 0.120 70 | amber |
| error | `--dm-color-error` | 0.545 0.205 27 | 0.730 0.158 27 | red |
| stopped | `--dm-color-stopped` | 0.640 0.010 275 | 0.560 0.012 275 | neutral |

### Chart series (theme-split sRGB hex)

| Token | Hue | Light | Dark |
|---|---|---|---|
| `--dm-chart-1` | iris | `#4c54c6` | `#a3b2fd` |
| `--dm-chart-2` | cyan | `#186f93` | `#6cc9f7` |
| `--dm-chart-3` | amber | `#915e10` | `#f6b669` |
| `--dm-chart-4` | red | `#c72e2b` | `#fb7c70` |

### Badge tint

`--dm-badge-tint: 6%` — the mix ratio for "same-hue text on a faint tint of that
hue" (status pills, tags, chips, active nav). 6% clears the 4.5:1 text minimum
for all four status hues in both themes (worst case 4.61:1 light / 5.61:1 dark).
Never hard-code a tint percentage in a component.

### AA verification (measured at the token level)

Every foreground/background pairing was computed OKLCH → sRGB → WCAG relative
luminance. Text pairings target 4.5:1; non-text marks and chart series target
3:1. **All pass in both themes**, with margins:

| Pairing | Light | Dark | Floor |
|---|---|---|---|
| fg / bg | 13.49 | 15.72 | 4.5 |
| fg-muted / bg | 5.52 | 7.86 | 4.5 |
| fg-muted / surface-3 | 5.01 | 5.85 | 4.5 |
| primary text / surface | 6.11 | 8.42 | 4.5 |
| on-primary / primary fill | 6.11 | 8.74 | 4.5 |
| border-strong / surface | 3.90 | 3.17 | 3.0 |
| serving text / 6% tint | 4.72 | 7.95 | 4.5 |
| compiling text / 6% tint | 4.70 | 7.58 | 4.5 |
| starting text / 6% tint | 4.62 | 7.90 | 4.5 |
| error text / 6% tint | 4.61 | 5.61 | 4.5 |
| chart 1–4 / bg (min) | 5.12 | 7.23 | 3.0 |
| chart 1–4 / surface (min) | 5.38 | 6.69 | 3.0 |

The generator + validator lives with the release notes; the same ratios are
echoed in `tokens.css` comments beside each family, in the M89 style.

---

## 3. Spacing

A **4px base** on a `rem` scale. Space groups content; it is never decorative
padding. Comfortable is the default; compact tightens ~25% (a single override
block keyed on `:root[data-density='compact']`).

| Token | Comfortable | Compact | Typical use |
|---|---|---|---|
| `--dm-space-1` | 0.25rem | 0.1875rem | icon gaps, hairline insets |
| `--dm-space-2` | 0.5rem | 0.375rem | chip/pill padding, tight stacks |
| `--dm-space-3` | 0.75rem | 0.5rem | cell padding, control gaps |
| `--dm-space-4` | 1rem | 0.75rem | card padding, row rhythm |
| `--dm-space-5` | 1.25rem | 1rem | header margins |
| `--dm-space-6` | 1.5rem | 1.125rem | section gaps |
| `--dm-space-8` | 2rem | 1.5rem | page gutters |
| `--dm-space-12` | 3rem | 2.25rem | empty-state / hero padding |

---

## 4. Typography

Two families, no web-font requests (the dashboard renders fully offline — M90 /
SECURITY.md). Sans falls back to the platform UI font; mono to the platform UI
monospace. Sizes are a deliberate five-step scale tuned for a data-dense tool
(14px body, not 16px). Machine values are always mono.

- `--dm-font`: `Roboto, system-ui, -apple-system, sans-serif`
- `--dm-mono`: `'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

| Token | Size | Comfortable | Compact | Use |
|---|---|---|---|---|
| `--dm-text-xs` | 11px | 0.6875rem | 0.6875rem | chips, table headers, micro-labels |
| `--dm-text-sm` | 13px | 0.8125rem | 0.8125rem | secondary text, captions |
| `--dm-text-md` | 14px | 0.875rem | 0.875rem | body (the base) |
| `--dm-text-lg` | 16px | 1rem | 0.9375rem (15px) | card titles |
| `--dm-text-xl` | 22px | 1.375rem | 1.25rem (20px) | page `h1` |

Line-height tokens: `--dm-line-tight` 1rem · `--dm-line-normal` 1.25rem ·
`--dm-line-loose` 1.5rem (compact loose → 1.375rem). Weights: 400 body, 500
labels/titles, 600 emphasis/mono values.

---

## 5. Radius

A rational scale on the 4px base — `4 · 6 · 8 · 12 · 16` px — replacing the
prior 4–14px set that had no rationale. Crisp, not pill-soft: a precise
instrument.

| Token | Value | Use |
|---|---|---|
| `--dm-radius-xs` | 4px | focus inset, tiny tags |
| `--dm-radius-sm` | 6px | inputs, menu items |
| `--dm-radius-md` | 8px | buttons, snackbars |
| `--dm-radius-lg` | 12px | cards, panels, wells |
| `--dm-radius-xl` | 16px | large containers, dialogs |
| `--dm-radius-full` | 999px | pills, dots, avatars |

---

## 6. Elevation

Soft, cool shadows — elevation whispers depth rather than announcing it. Three
steps; dark theme uses deeper, higher-opacity shadows because a glow reads less
on dark surfaces. Shadows are never used to convey status (color does that).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--dm-elev-1` | 0 1px 2px / 0 1px 3px, ~6% | ~30% | resting cards |
| `--dm-elev-2` | 0 2px 6px / 0 6px 14px, ~8% | ~40% | hover, popovers |
| `--dm-elev-3` | 0 6px 16px / 0 12px 28px, ~12% | ~50% | dialogs, menus |

(Exact values in `tokens.css`; the Material `--mat-sys-level*` tokens are
re-pointed to these so Material surfaces inherit the same depth.)

---

## 7. Motion

The M3 easing curves, three durations. Anything longer than `medium` is a
mistake for a tool. All animation is disabled under `prefers-reduced-motion`
(one global rule in `styles.scss`, plus per-component `matchMedia` guards).

| Token | Value | Use |
|---|---|---|
| `--dm-motion-instant` | 120ms | hover/active state layers, tiny toggles |
| `--dm-motion-short` | 180ms | control transitions, chips, tabs |
| `--dm-motion-medium` | 260ms | route enter, panels, dialogs |
| `--dm-motion-easing` | `cubic-bezier(0.2, 0, 0, 1)` | standard (most transitions) |
| `--dm-motion-easing-emphasized` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | entrances, expressive moves |
| `--dm-motion-easing-exit` | `cubic-bezier(0.4, 0, 1, 1)` | dismissals, exits |

---

## 8. Density & theme mechanics (unchanged by this release)

- **Theme** (`theme-toggle.ts`): sets `color-scheme` inline on `<html>` for
  explicit light/dark, removes it for auto (falls back to
  `html { color-scheme: light dark }` + OS preference). `light-dark()` resolves
  against it. Persisted as `daimon.theme`.
- **Density** (`topbar.ts`): `data-density='compact'` on `<html>`, persisted as
  `daimon.density`. The single compact override block in tokens.css tightens
  spacing and the two large type steps; every component that consumes the
  spacing/type tokens tightens automatically. No component has its own density
  logic.
- **Print**: one token-layer override (`@media print`) flattens the palette to
  black-on-white regardless of active theme; the structural half (hiding chrome)
  lives in `styles.scss`.

---

## 9. Rules (binding for v1.11 → v1.13)

1. Themable value ⇒ a `--dm-*` token in `tokens.css`. No exceptions.
2. A hard-coded color literal in a component is a defect. Fix contrast at the
   token, never the component.
3. New tokens are **additive**; existing token *names* components consume keep
   working across the trilogy.
4. AA is a floor, verified at the token level (this document's table) and by the
   axe gate on every route at both viewports.
5. `data-testid`, ARIA, landmarks, focus order, and `aria-live` regions are a
   contract a restyle never touches.
