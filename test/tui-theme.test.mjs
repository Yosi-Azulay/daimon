// Terminal theming (v1.13 "Terminal Native", M165).
//
// The binding claim of the milestone is that plain terminals and SSH are
// first-class: NO_COLOR and a 16-color terminal get the FULL feature set with a
// degraded palette, never a degraded feature set. These tests hold the whole
// ladder to that — most importantly that the `none` rung emits no color at all
// while still carrying every semantic through bold/dim/inverse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectColorLevel, makeTheme, statusRole, healthRole, levelRole,
} from '../dist/tui/theme.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALL_ROLES = [
  'serving', 'starting', 'compiling', 'stopped', 'error', 'orphaned',
  'healthy', 'unhealthy', 'unknown',
  'levelError', 'levelWarn', 'levelInfo',
  'primary', 'accent', 'muted', 'selection', 'focusBorder', 'blurBorder',
  'warning', 'danger', 'storm', 'follow',
];

// ── detection ladder ──────────────────────────────────────────────────────────

test('NO_COLOR disables color regardless of everything else', () => {
  assert.equal(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' }), 'none');
  // no-color.org: ANY non-empty value counts.
  assert.equal(detectColorLevel({ NO_COLOR: 'yes' }), 'none');
  // An empty NO_COLOR does NOT disable color.
  assert.notEqual(detectColorLevel({ NO_COLOR: '', COLORTERM: 'truecolor' }), 'none');
});

test('FORCE_COLOR pins the rung, and 0 turns color off', () => {
  assert.equal(detectColorLevel({ FORCE_COLOR: '0' }), 'none');
  assert.equal(detectColorLevel({ FORCE_COLOR: '1' }), 'basic');
  assert.equal(detectColorLevel({ FORCE_COLOR: '2' }), 'ansi256');
  assert.equal(detectColorLevel({ FORCE_COLOR: '3' }), 'truecolor');
  // NO_COLOR still wins over FORCE_COLOR.
  assert.equal(detectColorLevel({ NO_COLOR: '1', FORCE_COLOR: '3' }), 'none');
});

test('terminal capability hints map to the right rung', () => {
  assert.equal(detectColorLevel({ TERM: 'dumb' }), 'none');
  assert.equal(detectColorLevel({ COLORTERM: 'truecolor' }), 'truecolor');
  assert.equal(detectColorLevel({ COLORTERM: '24bit' }), 'truecolor');
  assert.equal(detectColorLevel({ WT_SESSION: 'abc' }), 'truecolor');       // Windows Terminal
  assert.equal(detectColorLevel({ TERM_PROGRAM: 'vscode' }), 'truecolor');
  assert.equal(detectColorLevel({ TERM: 'xterm-256color' }), 'ansi256');
  // A plain SSH-ish xterm — the "verification matrix" low rung.
  assert.equal(detectColorLevel({ TERM: 'xterm' }), 'basic');
  // conhost: no COLORTERM, no WT_SESSION, no TERM.
  assert.equal(detectColorLevel({}), 'basic');
});

// ── the rungs ─────────────────────────────────────────────────────────────────

test('truecolor: every role is a distinct in-gamut hex', () => {
  const t = makeTheme('truecolor');
  for (const role of ALL_ROLES) {
    const c = t.color(role);
    assert.match(c, /^#[0-9a-f]{6}$/, `role ${role} is not a hex color: ${c}`);
  }
  // The four DESIGN.md status hues must not collapse into each other.
  const distinct = new Set(['serving', 'starting', 'error', 'stopped'].map(r => t.color(r)));
  assert.equal(distinct.size, 4, 'status hues must stay visually distinct');
});

test('truecolor values match DESIGN.md’s own dark chart hex', () => {
  // DESIGN.md §2 publishes --dm-chart-* as theme-split sRGB hex. The terminal
  // roles are converted from the same OKLCH sources, so they must land on the
  // same values — this is the cross-check that the conversion is right.
  const t = makeTheme('truecolor');
  assert.equal(t.color('primary'), '#a3b2fd');   // --dm-chart-1 dark (iris)
  assert.equal(t.color('compiling'), '#6cc9f7'); // --dm-chart-2 dark (cyan)
  assert.equal(t.color('starting'), '#f6b669');  // --dm-chart-3 dark (amber)
  assert.equal(t.color('error'), '#fb7c70');     // --dm-chart-4 dark (red)
});

test('16-color: every role is a hand-picked ANSI name, never a hex', () => {
  const t = makeTheme('basic');
  const ANSI = new Set([
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray',
    'redBright', 'greenBright', 'yellowBright', 'blueBright',
    'magentaBright', 'cyanBright', 'whiteBright', 'blackBright',
  ]);
  for (const role of ALL_ROLES) {
    const c = t.color(role);
    assert.ok(ANSI.has(c), `role ${role} falls back to "${c}", which is not a 16-color ANSI name`);
  }
  // The colors daimon painted through v1.12 are preserved on this rung, so a
  // 16-color terminal looks exactly as familiar as it always did.
  assert.equal(t.color('serving'), 'green');
  assert.equal(t.color('error'), 'red');
  assert.equal(t.color('stopped'), 'gray');
  assert.equal(t.color('orphaned'), 'magenta');
});

test('NO_COLOR: zero color, full semantics', () => {
  const t = makeTheme('none');
  for (const role of ALL_ROLES) {
    assert.equal(t.color(role), undefined, `role ${role} still emits a color at the none rung`);
  }
  // The semantics move onto attributes instead of disappearing.
  assert.equal(t.style('error').bold, true, 'errors must stay loud without color');
  assert.equal(t.style('unhealthy').bold, true);
  assert.equal(t.style('levelError').bold, true);
  assert.equal(t.style('muted').dimColor, true, 'muted text must stay quiet without color');
  assert.equal(t.style('stopped').dimColor, true);
  assert.equal(t.style('selection').inverse, true, 'the selection must remain visible without color');
});

test('every rung answers for every role — no undefined lookups', () => {
  for (const level of ['none', 'basic', 'ansi256', 'truecolor']) {
    const t = makeTheme(level);
    assert.equal(t.level, level);
    for (const role of ALL_ROLES) {
      const s = t.style(role);
      assert.equal(typeof s, 'object', `${level}/${role} produced no style`);
    }
  }
});

test('ansi256 shares the truecolor table (chalk downsamples, we do not guess)', () => {
  assert.deepEqual(makeTheme('ansi256').color('serving'), makeTheme('truecolor').color('serving'));
});

// ── role lookups ──────────────────────────────────────────────────────────────

test('status and health roles cover every union member', () => {
  for (const s of ['stopped', 'starting', 'compiling', 'serving', 'error', 'orphaned']) {
    assert.equal(statusRole(s), s, `status ${s} has no role`);
  }
  for (const h of ['healthy', 'unhealthy', 'unknown']) {
    assert.equal(healthRole(h), h, `health ${h} has no role`);
  }
  // An unknown value degrades rather than throwing or painting nonsense.
  assert.equal(statusRole('who-knows'), 'unknown');
  assert.equal(healthRole('who-knows'), 'unknown');
});

test('an unclassified log line gets NO level role — the TUI never guesses', () => {
  // The v1.2 fail-soft rule: a line whose level is null is DATA, not a default.
  assert.equal(levelRole(null), null);
  assert.equal(levelRole(undefined), null);
  assert.equal(levelRole('debug'), null, 'an unmapped level must not fall back to info');
  assert.equal(levelRole('error'), 'levelError');
  assert.equal(levelRole('warn'), 'levelWarn');
  assert.equal(levelRole('info'), 'levelInfo');
});

// ── the single-source rule ────────────────────────────────────────────────────

test('no TUI component hard-codes a color — the palette lives in theme.ts only', () => {
  // DESIGN.md §9 rule 2, carried from the dashboard's token layer to the
  // terminal: a hard-coded color in a component is a defect, not a style
  // choice. Before v1.13, STATUS_COLORS/HEALTH_COLORS were duplicated verbatim
  // in App.tsx AND AttachApp.tsx.
  const srcDir = path.join(repoRoot, 'src', 'tui');
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.tsx') || f.endsWith('.ts'));
  const NAMED = /color=("|\{')(black|red|green|yellow|blue|magenta|cyan|white|gray)/;
  for (const f of files) {
    if (f === 'theme.ts') continue;
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    const hit = src.match(NAMED);
    assert.equal(hit, null, `${f} hard-codes a color (${hit && hit[0]}) — use theme.style()/theme.color()`);
    assert.doesNotMatch(src, /const\s+STATUS_COLORS/, `${f} re-introduces a duplicated STATUS_COLORS map`);
    assert.doesNotMatch(src, /const\s+HEALTH_COLORS/, `${f} re-introduces a duplicated HEALTH_COLORS map`);
  }
});
