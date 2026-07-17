import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_CHORD_KEY,
  LEVEL_CHORD_HELP,
  GREP_CHORD_KEY,
  GREP_CHORD_HELP,
  nextLevelFilter,
  formatLevelIndicator,
  matchesLevel,
  compileGrep,
  filterLogLines,
} from '../dist/tui/logFilterChord.js';

test('chord keys are single free letters and advertised in the help ribbon', () => {
  assert.equal(LEVEL_CHORD_KEY.length, 1);
  assert.match(LEVEL_CHORD_HELP, new RegExp(`\\[${LEVEL_CHORD_KEY}\\]`));
  assert.match(LEVEL_CHORD_HELP.toLowerCase(), /level/);
  assert.equal(GREP_CHORD_KEY, '/');
  assert.match(GREP_CHORD_HELP, /\[\/\]/);
  assert.match(GREP_CHORD_HELP.toLowerCase(), /grep/);
});

test('nextLevelFilter: all -> error -> warn -> info -> all, wraps forever', () => {
  let f = 'all';
  f = nextLevelFilter(f); assert.equal(f, 'error');
  f = nextLevelFilter(f); assert.equal(f, 'warn');
  f = nextLevelFilter(f); assert.equal(f, 'info');
  f = nextLevelFilter(f); assert.equal(f, 'all');
  f = nextLevelFilter(f); assert.equal(f, 'error');
});

test('formatLevelIndicator: nothing when unfiltered, [level: x] otherwise', () => {
  assert.equal(formatLevelIndicator('all'), '');
  assert.equal(formatLevelIndicator('error'), '[level: error]');
  assert.equal(formatLevelIndicator('warn'), '[level: warn]');
  assert.equal(formatLevelIndicator('info'), '[level: info]');
});

test('matchesLevel: all passes everything, unclassified lines excluded when a filter is active', () => {
  assert.equal(matchesLevel({ line: 'x', level: null }, 'all'), true);
  assert.equal(matchesLevel({ line: 'x' }, 'all'), true);
  assert.equal(matchesLevel({ line: 'x', level: null }, 'error'), false);
  assert.equal(matchesLevel({ line: 'x' }, 'error'), false);
  assert.equal(matchesLevel({ line: 'x', level: 'error' }, 'error'), true);
  assert.equal(matchesLevel({ line: 'x', level: 'warn' }, 'error'), false);
});

test('compileGrep: empty pattern matches everything', () => {
  const m = compileGrep('');
  assert.equal(m('anything'), true);
  assert.equal(m(''), true);
});

test('compileGrep: case-insensitive substring/regex matching', () => {
  const m = compileGrep('EAdd.*use');
  assert.equal(m('Error: eaddrinuse on port 4200'), true);
  assert.equal(m('nothing to see here'), false);
});

test('compileGrep: invalid regex falls back to plain substring matching, never throws', () => {
  assert.doesNotThrow(() => compileGrep('[abc'));
  const m = compileGrep('[abc');
  assert.equal(m('has [abc in it'), true);
  assert.equal(m('nothing here'), false);
});

test('filterLogLines: level and grep combine with AND', () => {
  const entries = [
    { line: 'boot ok', level: 'info' },
    { line: 'EADDRINUSE port 4200', level: 'error' },
    { line: 'deprecation warning: foo', level: 'warn' },
    { line: 'unclassified startup line' },
    { line: 'another error line', level: 'error' },
  ];
  // level-only
  assert.deepEqual(
    filterLogLines(entries, 'error', '').map(e => e.line),
    ['EADDRINUSE port 4200', 'another error line'],
  );
  // grep-only — 'EADDRINUSE' does not literally contain "error"
  assert.deepEqual(
    filterLogLines(entries, 'all', 'error').map(e => e.line),
    ['another error line'],
  );
  // combined: error level AND a grep pattern that only one error line has
  assert.deepEqual(
    filterLogLines(entries, 'error', 'ADDR').map(e => e.line),
    ['EADDRINUSE port 4200'],
  );
  // combined finding nothing
  assert.deepEqual(filterLogLines(entries, 'warn', 'ADDR'), []);
});

test('filterLogLines: no filters returns every entry unchanged', () => {
  const entries = [{ line: 'a', level: 'info' }, { line: 'b' }];
  assert.deepEqual(filterLogLines(entries, 'all', ''), entries);
});
