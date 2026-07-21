// Log pane 2.0 (v1.13 "Terminal Native", M164).
//
// The pane finally uses data daimon has been collecting since v1.2 and never
// showed: per-line levels, and whether the app is in a log storm. It also stops
// lying about follow mode, which used to be the implicit side effect of
// scroll === 0.
//
// The v1.2 behaviours these tests protect: grep DEFAULTS to narrowing (that is
// what `/` has always done), Esc clears it, and an unclassified line is never
// assigned a level.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextGrepMode, visibleLogLines, matchingIndices, nextMatchIndex,
  isFollowing, formatFollowIndicator, formatStormIndicator, formatGrepIndicator,
  filterLogLines,
} from '../dist/tui/logFilterChord.js';
import { levelRole, makeTheme } from '../dist/tui/theme.js';

const LINES = [
  { line: 'boot ok', level: 'info' },
  { line: 'EADDRINUSE port 4200', level: 'error' },
  { line: 'deprecation warning: foo', level: 'warn' },
  { line: 'unclassified startup line' },
  { line: 'another error line', level: 'error' },
];

// ── level colouring ───────────────────────────────────────────────────────────

test('classified lines get a level role, unclassified lines get none', () => {
  const roles = LINES.map(e => levelRole(e.level));
  assert.deepEqual(roles, ['levelInfo', 'levelError', 'levelWarn', null, 'levelError']);
});

test('level tints are visually distinct, and vanish under NO_COLOR', () => {
  const t = makeTheme('truecolor');
  const distinct = new Set([t.color('levelError'), t.color('levelWarn'), t.color('levelInfo')]);
  assert.equal(distinct.size, 3, 'error/warn/info must not render the same');
  const mono = makeTheme('none');
  assert.equal(mono.color('levelError'), undefined);
  assert.equal(mono.style('levelError').bold, true, 'an error line stays loud without color');
});

// ── grep: filter vs highlight ─────────────────────────────────────────────────

test('grep defaults to filtering — exactly what `/` did in v1.2', () => {
  assert.deepEqual(
    visibleLogLines(LINES, 'all', 'error', 'filter').map(e => e.line),
    filterLogLines(LINES, 'all', 'error').map(e => e.line),
    'filter mode must be byte-identical to the v1.2 behaviour',
  );
});

test('highlight mode keeps every line in view so n/N has somewhere to go', () => {
  const shown = visibleLogLines(LINES, 'all', 'error', 'highlight');
  assert.equal(shown.length, LINES.length, 'highlight mode narrows nothing');
  // ...but the level filter still applies in highlight mode.
  assert.deepEqual(
    visibleLogLines(LINES, 'error', '', 'highlight').map(e => e.line),
    ['EADDRINUSE port 4200', 'another error line'],
  );
});

test('the mode toggle round-trips', () => {
  assert.equal(nextGrepMode('filter'), 'highlight');
  assert.equal(nextGrepMode('highlight'), 'filter');
  assert.equal(nextGrepMode(nextGrepMode('filter')), 'filter');
});

test('an empty pattern is a no-op in both modes', () => {
  assert.deepEqual(visibleLogLines(LINES, 'all', '', 'filter'), LINES);
  assert.deepEqual(visibleLogLines(LINES, 'all', '', 'highlight'), LINES);
});

// ── match navigation ──────────────────────────────────────────────────────────

test('matchingIndices finds every hit, and nothing when there is no pattern', () => {
  assert.deepEqual(matchingIndices(LINES, 'error'), [4]);
  assert.deepEqual(matchingIndices(LINES, 'line'), [3, 4]);
  // An empty pattern means "nothing to navigate", NOT "everything matches" —
  // otherwise `n` with no query would jump to line 2.
  assert.deepEqual(matchingIndices(LINES, ''), []);
});

test('n/N walk the matches and wrap around the ends', () => {
  const m = [1, 4, 7];
  assert.equal(nextMatchIndex(m, 0, 1), 1);
  assert.equal(nextMatchIndex(m, 1, 1), 4);
  assert.equal(nextMatchIndex(m, 7, 1), 1, 'forward past the last match wraps to the first');
  assert.equal(nextMatchIndex(m, 7, -1), 4);
  assert.equal(nextMatchIndex(m, 1, -1), 7, 'backward past the first match wraps to the last');
});

test('match navigation with no matches is a no-op, never a crash', () => {
  assert.equal(nextMatchIndex([], 0, 1), null);
  assert.equal(nextMatchIndex([], 0, -1), null);
});

test('an invalid regex still navigates via the substring fallback', () => {
  // Live input means half-typed patterns like `[abc` must never throw.
  assert.doesNotThrow(() => matchingIndices(LINES, '[abc'));
  assert.deepEqual(matchingIndices([{ line: 'has [abc here' }, { line: 'no' }], '[abc'), [0]);
});

// ── follow mode ───────────────────────────────────────────────────────────────

test('follow is on at the bottom and paused anywhere else', () => {
  assert.equal(isFollowing(0, true), true, 'at the bottom with follow armed → following');
  assert.equal(isFollowing(5, true), false, 'scrolled up → paused, even with follow armed');
  assert.equal(isFollowing(0, false), false, 'explicitly paused stays paused at the bottom');
});

test('the follow indicator says which it is, out loud', () => {
  assert.equal(formatFollowIndicator(true), '[following]');
  assert.equal(formatFollowIndicator(false), '[paused]');
  // The whole point of M164: it is never ambiguous.
  assert.notEqual(formatFollowIndicator(true), formatFollowIndicator(false));
});

// ── storm indicator ───────────────────────────────────────────────────────────

test('the storm marker appears only while the app is storming', () => {
  assert.equal(formatStormIndicator(false), '', 'a quiet app shows no storm marker');
  assert.match(formatStormIndicator(true), /storm/i);
});

// ── header indicators ─────────────────────────────────────────────────────────

test('the grep indicator names the pattern, and counts matches in highlight mode', () => {
  assert.equal(formatGrepIndicator('', 'filter', 0), '', 'no pattern, no indicator');
  assert.match(formatGrepIndicator('boot', 'filter', 3), /boot/);
  const hl = formatGrepIndicator('boot', 'highlight', 3);
  assert.match(hl, /boot/);
  assert.match(hl, /3 matches/, 'highlight mode reports how many hits there are');
  assert.match(formatGrepIndicator('boot', 'highlight', 1), /1 match\b/, 'singular reads correctly');
});
