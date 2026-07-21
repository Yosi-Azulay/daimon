// The ONE source of terminal color roles (v1.13 "Terminal Native", M165).
// DESIGN.md's palette (v1.11) translated into honest ANSI: every status /
// health / accent color the TUI paints comes from here, so a hard-coded color
// literal in a component is a defect — the same rule the dashboard follows at
// the token layer (DESIGN.md §9). Before v1.13, STATUS_COLORS / HEALTH_COLORS
// were duplicated verbatim in App.tsx AND AttachApp.tsx; this module is what
// they were deduplicated into.
//
// Pure data + pure functions — no ink, no chalk, no env reads at import time —
// so the whole ladder unit-tests without a terminal.
//
// THE DEGRADATION LADDER (plain terminals and SSH are first-class; no feature
// may REQUIRE truecolor):
//   truecolor / 256  → DESIGN.md's own OKLCH values, converted to sRGB hex.
//                      Dark-theme column: terminals are dark surfaces, and
//                      every value clears 4.5:1 against a #0c0c0c background.
//   16-color (basic) → a HAND-PICKED ANSI name per role, never an auto
//                      quantization of the hex (which lands in mud). These are
//                      the colors daimon shipped through v1.12, so a 16-color
//                      terminal looks exactly as familiar as it always did.
//   none (NO_COLOR)  → no SGR color at all. Semantics carry on bold / dim /
//                      inverse instead, and EVERY feature still works.
//
// The truecolor hex values are DESIGN.md §2 "Status hues", dark column,
// converted OKLCH → sRGB (see the release notes for the conversion). Four of
// them land byte-identical on DESIGN.md's own `--dm-chart-*` dark hex, which is
// the cross-check that the conversion is right. `stopped` is the one deliberate
// departure: DESIGN.md's dark `stopped` (L 0.560) reads 4.20:1 on a dark
// terminal, under the AA floor, so the terminal role lifts it to L 0.600
// (#7e8088, 4.97:1). Contrast is fixed at the role, never at the call site.

export type ColorLevel = 'none' | 'basic' | 'ansi256' | 'truecolor';

// Every semantic role the TUI paints. Status + health mirror the AppStatus /
// AppHealth unions; the rest are UI roles.
export type Role =
  // app status
  | 'serving' | 'starting' | 'compiling' | 'stopped' | 'error' | 'orphaned'
  // app health
  | 'healthy' | 'unhealthy' | 'unknown'
  // log levels (v1.2 classification; an unclassified line gets NO role)
  | 'levelError' | 'levelWarn' | 'levelInfo'
  // ui
  | 'primary' | 'accent' | 'muted' | 'selection' | 'focusBorder' | 'blurBorder'
  | 'warning' | 'danger' | 'storm' | 'follow';

// How a role renders. `color` is undefined at the `none` rung — ink then paints
// no SGR color and the attributes below carry the meaning.
export interface RoleStyle {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
  inverse?: boolean;
}

// ── the palette ───────────────────────────────────────────────────────────────

// DESIGN.md §2 status hues + roles, dark column, OKLCH → sRGB.
const TRUECOLOR: Record<Role, string> = {
  serving: '#6dd88e',    // oklch(0.800 0.145 152) green
  starting: '#f6b669',   // oklch(0.820 0.120  70) amber  == --dm-chart-3 dark
  compiling: '#6cc9f7',  // oklch(0.795 0.110 232) cyan   == --dm-chart-2 dark
  stopped: '#7e8088',    // oklch(0.600 0.012 275) neutral, lifted for AA
  error: '#fb7c70',      // oklch(0.730 0.158  27) red    == --dm-chart-4 dark
  orphaned: '#dc9beb',   // oklch(0.780 0.130 320) — no DESIGN.md status hue
                         // covers "orphaned"; derived in-palette at the same
                         // L/C as its siblings so it reads as one family.
  healthy: '#6dd88e',
  unhealthy: '#fb7c70',
  unknown: '#7e8088',
  levelError: '#fb7c70',
  levelWarn: '#f6b669',
  levelInfo: '#6cc9f7',
  primary: '#a3b2fd',    // oklch(0.780 0.108 275) iris   == --dm-chart-1 dark
  accent: '#6cc9f7',     // DESIGN.md's accent IS the cyan hue
  muted: '#a7a9b1',      // oklch(0.735 0.012 275) fg-muted
  selection: '#a3b2fd',  // selection wears the brand
  focusBorder: '#a3b2fd',
  blurBorder: '#7e8088',
  warning: '#f6b669',
  danger: '#fb7c70',
  storm: '#f6b669',
  follow: '#6dd88e',
};

// The 16-color rung. Hand-picked, NOT quantized: ANSI `blue` is close to
// illegible on the dark backgrounds terminals actually use, so the iris roles
// (primary / selection / focus) fall back to `cyan` — which is both the closest
// legible cool accent and exactly what daimon painted through v1.12.
const BASIC: Record<Role, string> = {
  serving: 'green',
  starting: 'yellow',
  compiling: 'cyan',
  stopped: 'gray',
  error: 'red',
  orphaned: 'magenta',
  healthy: 'green',
  unhealthy: 'red',
  unknown: 'gray',
  levelError: 'red',
  levelWarn: 'yellow',
  levelInfo: 'cyan',
  primary: 'cyan',
  accent: 'cyan',
  muted: 'gray',
  selection: 'cyan',
  focusBorder: 'cyan',
  blurBorder: 'gray',
  warning: 'yellow',
  danger: 'red',
  storm: 'yellow',
  follow: 'green',
};

// The monochrome rung. No color survives, so the semantics move onto
// attributes: anything that DEMANDS attention goes bold, anything de-emphasized
// goes dim, and the selection inverts.
const MONO_ATTRS: Partial<Record<Role, Omit<RoleStyle, 'color'>>> = {
  error: { bold: true },
  unhealthy: { bold: true },
  levelError: { bold: true },
  danger: { bold: true },
  orphaned: { bold: true },
  warning: { bold: true },
  levelWarn: { bold: true },
  storm: { bold: true },
  stopped: { dimColor: true },
  unknown: { dimColor: true },
  muted: { dimColor: true },
  blurBorder: { dimColor: true },
  selection: { inverse: true },
  focusBorder: { bold: true },
  primary: { bold: true },
  serving: { bold: true },
  healthy: { bold: true },
  follow: { bold: true },
};

// ── detection ─────────────────────────────────────────────────────────────────

// Pure function of the environment — no import-time side effects, no chalk, no
// new dependency. Precedence follows the de-facto standards: NO_COLOR
// (no-color.org: any non-empty value disables color) and FORCE_COLOR override
// everything, then explicit terminal capability hints.
export function detectColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return 'none';
  const force = env.FORCE_COLOR;
  if (force != null && force !== '') {
    if (force === '0' || force === 'false') return 'none';
    if (force === '1' || force === 'true') return 'basic';
    if (force === '2') return 'ansi256';
    if (force === '3') return 'truecolor';
  }
  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'dumb') return 'none';
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  // Windows Terminal and modern VS Code terminals are truecolor but often ship
  // no COLORTERM; conhost is not, and lands on the 16-color rung below.
  if (env.WT_SESSION) return 'truecolor';
  if (env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app') return 'truecolor';
  if (term.includes('256color')) return 'ansi256';
  // Everything else — including Windows conhost, which sets no TERM at all —
  // lands on the 16-color rung. Deliberately NOT a `process.platform` fork:
  // the fallback is identical on every OS, so there is no branch to inventory
  // (M140's platform-inventory rule).
  return 'basic';
}

// ── the theme ─────────────────────────────────────────────────────────────────

export interface Theme {
  level: ColorLevel;
  style(role: Role): RoleStyle;
  /** The color for a role, or undefined at the `none` rung. */
  color(role: Role): string | undefined;
}

export function makeTheme(level: ColorLevel = detectColorLevel()): Theme {
  const table = level === 'truecolor' || level === 'ansi256' ? TRUECOLOR : level === 'basic' ? BASIC : null;
  const style = (role: Role): RoleStyle => {
    if (table === null) return { ...(MONO_ATTRS[role] ?? {}) };
    return { color: table[role] };
  };
  return { level, style, color: (role: Role) => style(role).color };
}

// ── role lookups ──────────────────────────────────────────────────────────────
// Narrow helpers so callers never index a color map directly. The AppStatus /
// AppHealth unions are structural here (a plain string) to keep this module
// import-free — the compiler still checks the call sites, which pass the real
// union types.

const STATUS_ROLES: Record<string, Role> = {
  stopped: 'stopped', starting: 'starting', compiling: 'compiling',
  serving: 'serving', error: 'error', orphaned: 'orphaned',
};

const HEALTH_ROLES: Record<string, Role> = {
  healthy: 'healthy', unhealthy: 'unhealthy', unknown: 'unknown',
};

const LEVEL_ROLES: Record<string, Role> = {
  error: 'levelError', warn: 'levelWarn', info: 'levelInfo',
};

export function statusRole(status: string): Role {
  return STATUS_ROLES[status] ?? 'unknown';
}

export function healthRole(health: string): Role {
  return HEALTH_ROLES[health] ?? 'unknown';
}

// A log line's v1.2 level → its role, or null when the line is UNCLASSIFIED.
// Null means "paint nothing" — the TUI never guesses a level client-side
// (M164 / the v1.2 fail-soft rule: a missing level is data, not a default).
export function levelRole(level: string | null | undefined): Role | null {
  if (level == null) return null;
  return LEVEL_ROLES[level] ?? null;
}
