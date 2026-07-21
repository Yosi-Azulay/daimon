// The chord-map contract (v1.13 "Terminal Native", M163).
//
// Three things are proven here:
//   1. MUSCLE MEMORY — every chord daimon shipped through v1.12 still resolves,
//      to the same meaning, in the same pane. The v1.12 inventory below is a
//      frozen expectation, not a re-derivation: a chord silently lost or
//      remapped fails here.
//   2. STRUCTURE — no duplicate ids, no two chords fighting over the same key
//      in the same pane, every chord reachable through the real resolver.
//   3. NO DRIFT — the `?` overlay, the per-pane footers, the generated docs
//      cheat sheet, and the README table all render FROM the map. A hand-listed
//      chord ribbon anywhere in the compiled TUI fails this file, which is the
//      bug that motivated the milestone (LogPane's footer said `[g/G]
//      bottom/top` while its code did the exact opposite).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHORDS, MAIN_CHORD_IDS, MAIN_PANES,
  resolveChord, chordsForPane, footerChords, overlayGroups,
} from '../dist/tui/chords.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_KEY = {};

// ── 1. muscle memory ──────────────────────────────────────────────────────────

// Every chord v1.12 dispatched, with the pane it must still work in and the id
// it must still resolve to. Sourced from v1.12's App.tsx / LogPane.tsx /
// TimelinePane.tsx / AttachApp.tsx useInput bodies.
const V112_CHORDS = [
  // App.tsx main view (now the list/detail panes)
  ['list', 'j', {}, 'move'],
  ['list', 'k', {}, 'move'],
  ['list', '', { upArrow: true }, 'move'],
  ['list', '', { downArrow: true }, 'move'],
  ['list', 's', {}, 'start'],
  ['list', 'S', {}, 'stop'],
  ['list', 'r', {}, 'restart'],
  ['list', 'f', {}, 'focus'],
  ['list', 'x', {}, 'tryFix'],
  ['list', 'T', {}, 'test'],
  ['list', 'O', {}, 'orchestrate'],
  ['list', 'o', {}, 'openUrl'],
  ['list', '/', {}, 'filter'],
  ['list', 't', {}, 'tagFilter'],
  ['list', 'G', {}, 'groupFilter'],
  ['list', 'g', {}, 'viewHint'],
  ['list', 'e', {}, 'edit'],
  ['list', 'E', {}, 'envFile'],
  ['list', 'V', {}, 'editor'],
  ['list', 'l', {}, 'logFocus'],
  ['list', 'L', {}, 'maximizeLog'],
  ['list', 'i', {}, 'timeline'],
  ['list', 'q', {}, 'quit'],
  ['list', '', { pageUp: true }, 'logPage'],
  ['list', '', { pageDown: true }, 'logPage'],
  // LogPane (now the log pane, reached by `l`/Tab or maximized by Shift+L)
  ['log', 'l', {}, 'levelCycle'],
  ['log', '/', {}, 'grep'],
  ['log', 'g', {}, 'logTop'],
  ['log', 'G', {}, 'logBottom'],
  ['log', '', { upArrow: true }, 'logScroll'],
  ['log', '', { downArrow: true }, 'logScroll'],
  ['log', '', { pageUp: true }, 'logPage'],
  ['log', '', { pageDown: true }, 'logPage'],
  // TimelinePane
  ['timeline', '', { leftArrow: true }, 'tlMove'],
  ['timeline', '', { rightArrow: true }, 'tlMove'],
  ['timeline', 'h', {}, 'tlMove'],
  ['timeline', 'j', {}, 'tlMove'],
  ['timeline', 'k', {}, 'tlMove'],
  ['timeline', 'g', {}, 'tlEdges'],
  ['timeline', 'G', {}, 'tlEdges'],
  ['timeline', '', { return: true }, 'tlDrill'],
  ['timeline', 'n', {}, 'tlJump'],
  ['timeline', 'p', {}, 'tlJump'],
  ['timeline', 'q', {}, 'tlBack'],
  // AttachApp
  ['attach', '', { upArrow: true }, 'atMove'],
  ['attach', '', { downArrow: true }, 'atMove'],
  ['attach', '', { return: true }, 'atToggle'],
  ['attach', ' ', {}, 'atToggle'],
  ['attach', 's', {}, 'atStart'],
  ['attach', 'x', {}, 'atStop'],
  ['attach', 'r', {}, 'atRestart'],
  ['attach', 'q', {}, 'atDetach'],
];

test('muscle memory: every v1.12 chord still resolves to the same meaning', () => {
  for (const [pane, input, key, expectedId] of V112_CHORDS) {
    const hit = resolveChord(pane, input, key);
    assert.ok(hit, `v1.12 chord lost: ${JSON.stringify({ pane, input, key })} resolves to nothing`);
    assert.equal(
      hit.id, expectedId,
      `v1.12 chord remapped: ${pane} + ${input || JSON.stringify(key)} was "${expectedId}", now "${hit.id}"`,
    );
  }
});

test('muscle memory: v1.13 adds no legacy alias, because it remaps nothing', () => {
  // A remap is allowed ONLY with a permanent legacy alias documented in the
  // release notes. v1.13 remaps nothing, so nothing should declare one — if a
  // future release does, this assertion is the reminder to document it.
  const withLegacy = CHORDS.filter(c => c.legacy);
  assert.deepEqual(withLegacy.map(c => c.id), [], 'a chord declares a legacy alias — document it in the release notes');
});

test('the pane-scoped pairs that make the map necessary all coexist', () => {
  // These are the collisions that would be bugs in a flat chord table.
  assert.equal(resolveChord('list', 'l', NO_KEY).id, 'logFocus');
  assert.equal(resolveChord('log', 'l', NO_KEY).id, 'levelCycle');
  assert.equal(resolveChord('list', '/', NO_KEY).id, 'filter');
  assert.equal(resolveChord('log', '/', NO_KEY).id, 'grep');
  assert.equal(resolveChord('list', 'g', NO_KEY).id, 'viewHint');
  assert.equal(resolveChord('log', 'g', NO_KEY).id, 'logTop');
  assert.equal(resolveChord('list', 'G', NO_KEY).id, 'groupFilter');
  assert.equal(resolveChord('log', 'G', NO_KEY).id, 'logBottom');
});

test('LogPane g/G: the v1.12 footer-vs-code drift is resolved in favour of the code', () => {
  // v1.12's LogPane footer read "[g/G] bottom/top" while the code did the
  // opposite: `g` scrolled to the OLDEST lines, `G` to the newest. Code wins
  // (the locked rule), so the labels now say top/bottom in that order — which
  // also matches vim and the timeline pane's own g/G.
  const top = CHORDS.find(c => c.id === 'logTop');
  const bottom = CHORDS.find(c => c.id === 'logBottom');
  assert.equal(top.key, 'g');
  assert.equal(bottom.key, 'G');
  assert.match(top.desc, /top|oldest/i);
  assert.match(bottom.desc, /bottom|newest/i);
  assert.doesNotMatch(top.desc, /bottom|newest/i, '`g` must not be labelled bottom — that was the v1.12 bug');
  assert.doesNotMatch(bottom.desc, /\btop\b|oldest/i, '`G` must not be labelled top — that was the v1.12 bug');
  // And `G` is what resumes follow (M164).
  assert.match(bottom.desc, /follow/i);
});

// ── 2. structure ──────────────────────────────────────────────────────────────

test('chord ids are unique', () => {
  const ids = CHORDS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate chord id: ${ids.filter((v, i) => ids.indexOf(v) !== i)}`);
});

test('every chord carries a key, a label, a description, and at least one trigger', () => {
  for (const c of CHORDS) {
    assert.ok(c.key && c.key.length, `${c.id} has no display key`);
    assert.ok(c.label && c.label.length, `${c.id} has no footer label`);
    assert.ok(c.desc && c.desc.length > 4, `${c.id} has no usable description`);
    assert.ok(Array.isArray(c.triggers) && c.triggers.length > 0, `${c.id} has no triggers`);
    assert.ok(Array.isArray(c.panes) && c.panes.length > 0, `${c.id} is scoped to no pane`);
    for (const t of c.triggers) {
      assert.ok(t.ch != null || t.special != null, `${c.id} has an empty trigger`);
    }
  }
});

test('no two chords in the SAME pane claim the same trigger', () => {
  // This is the invariant that makes dispatch unambiguous: pane scoping is only
  // safe if within one pane every physical key belongs to exactly one chord.
  const panes = [...new Set(CHORDS.flatMap(c => c.panes))];
  for (const pane of panes) {
    const claimed = new Map();
    for (const c of chordsForPane(pane)) {
      for (const t of c.triggers) {
        const sig = t.ch != null ? `ch:${t.ch}:${t.ctrl ? 'ctrl' : ''}` : `sp:${t.special}:${t.ctrl ? 'ctrl' : ''}`;
        const prev = claimed.get(sig);
        assert.equal(prev, undefined, `pane "${pane}": ${sig} claimed by both "${prev}" and "${c.id}"`);
        claimed.set(sig, c.id);
      }
    }
  }
});

test('every chord is reachable through the real resolver in each of its panes', () => {
  for (const c of CHORDS) {
    for (const pane of c.panes) {
      const t = c.triggers[0];
      const input = t.ch ?? '';
      const key = t.special ? { [t.special]: true } : {};
      if (t.ctrl) key.ctrl = true;
      const hit = resolveChord(pane, input, key);
      assert.ok(hit, `${c.id} unreachable in pane ${pane}`);
      assert.equal(hit.id, c.id, `${c.id} in pane ${pane} is shadowed by ${hit.id}`);
    }
  }
});

test('MAIN_CHORD_IDS matches exactly the chords scoped to a main pane', () => {
  // The compile-time half of the anti-drift guarantee is App.tsx's
  // `Record<MainChordId, Handler>`; this is the runtime half that keeps the
  // list itself honest.
  const derived = CHORDS.filter(c => c.panes.some(p => MAIN_PANES.includes(p))).map(c => c.id);
  assert.deepEqual([...MAIN_CHORD_IDS].sort(), derived.sort());
});

test('unknown keys resolve to nothing rather than a wrong chord', () => {
  assert.equal(resolveChord('list', 'Z', NO_KEY), null);
  assert.equal(resolveChord('log', 'Z', NO_KEY), null);
  // Ctrl must match exactly — Ctrl+C is quit, a bare 'c' is nothing.
  assert.equal(resolveChord('list', 'c', NO_KEY), null);
  assert.equal(resolveChord('list', 'c', { ctrl: true }).id, 'quit');
  // ...and a Ctrl-modified 's' is not "start".
  assert.equal(resolveChord('list', 's', { ctrl: true }), null);
});

test('every pane offers a non-empty footer and the help chord is always reachable', () => {
  for (const pane of ['list', 'detail', 'log']) {
    assert.ok(footerChords(pane).length > 0, `pane ${pane} has no footer hints`);
    assert.ok(resolveChord(pane, '?', NO_KEY), `[?] help unreachable from pane ${pane}`);
    assert.ok(resolveChord(pane, '', { tab: true }), `Tab unreachable from pane ${pane}`);
  }
});

test('overlayGroups lists every chord exactly once, focused pane first', () => {
  for (const pane of ['list', 'detail', 'log']) {
    const groups = overlayGroups(pane);
    const listed = groups.flatMap(g => g.chords.map(c => c.id));
    assert.equal(new Set(listed).size, listed.length, `pane ${pane}: a chord appears twice in the overlay`);
    assert.equal(listed.length, CHORDS.length, `pane ${pane}: the overlay omits chords`);
    // The focused pane's own chords lead.
    const firstGroupChords = groups[0].chords;
    assert.ok(
      firstGroupChords.some(c => c.panes.includes(pane)),
      `pane ${pane}: the first overlay group is not one of its own`,
    );
  }
});

// ── 3. no drift ───────────────────────────────────────────────────────────────

const TUI_DIST = path.join(repoRoot, 'dist', 'tui');

test('no TUI component hand-lists a chord ribbon', () => {
  // A "ribbon" is three or more `[key] label` pairs — exactly the shape of the
  // three hand-written footers v1.12 shipped. They are all generated from the
  // map now, so finding one in a component means someone re-introduced a
  // surface that can drift.
  //
  // Scan the SOURCE, not just the compiled output. The v1.13 review found that
  // scanning dist/ alone is defeated by interpolation: tsc splits
  //   `[Tab] {mode === 'filter' ? 'filter' : 'highlight'} mode  [Enter] keep  [Esc] clear`
  // into separate literals, so no single compiled string held 3 pairs and the
  // gate returned green on a real hand-listed ribbon. In .tsx source the pairs
  // are adjacent, so the interpolation cannot hide them.
  // Detection COUNTS `[key]` tokens per line rather than matching one long
  // regex. Requiring the pairs to be contiguous is what let the real ribbon
  // through: the interpolated segment between `[Tab]` and `[Enter]` was 56
  // characters, so any bounded-gap pattern misses it. The lookbehind excludes
  // array indexing (`RANKS[prev]`, `arr[idx]`), which is the only false
  // positive this shape produces in the TUI tree.
  const TOKEN = /(?<![A-Za-z0-9_$)\]])\[[^\]\n]{1,14}\]/g;
  const RIBBON_MIN = 3;
  const targets = [
    { dir: path.join(repoRoot, 'src', 'tui'), exts: ['.tsx', '.ts'], skip: new Set(['chords.ts']) },
    { dir: TUI_DIST, exts: ['.js'], skip: new Set(['chords.js']) },
  ];
  let scanned = 0;
  for (const { dir, exts, skip } of targets) {
    const files = fs.readdirSync(dir).filter(x => exts.some(e => x.endsWith(e)) && !skip.has(x));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      scanned++;
      src.split('\n').forEach((line, i) => {
        // The map's own rows and plain comments are not ribbons.
        if (line.includes('chords.ts') || line.trimStart().startsWith('//')) return;
        const tokens = line.match(TOKEN) ?? [];
        assert.ok(
          tokens.length < RIBBON_MIN,
          `${f}:${i + 1} hand-lists a chord ribbon (${tokens.join(' ')}) — render it from chords.ts instead:\n  ${line.trim()}`,
        );
      });
    }
  }
  assert.ok(scanned >= 10, `expected to scan both source and compiled TUI components, scanned ${scanned}`);
});

test('the deleted keys.ts KEY_HELP ribbon is gone for good', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'src', 'tui', 'keys.ts')), false,
    'src/tui/keys.ts is back — its KEY_HELP was a hand-written ribbon replaced by the chord map');
  assert.equal(fs.existsSync(path.join(TUI_DIST, 'keys.js')), false, 'stale dist/tui/keys.js — rebuild');
});

test('the generated docs cheat sheet covers every chord, KEY included', () => {
  const docs = path.join(repoRoot, 'docs', 'index.html');
  if (!fs.existsSync(docs)) {
    assert.fail('docs/index.html missing — run `npm run build && npm run build:docs`');
  }
  const html = fs.readFileSync(docs, 'utf8');
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const c of CHORDS) {
    assert.ok(
      html.includes(esc(c.desc)),
      `docs cheat sheet is missing chord "${c.id}" (${c.key} — ${c.desc}); re-run npm run build:docs`,
    );
    // Checking the KEY too: asserting only descriptions let a re-bound key rot
    // the generated table silently (found in the v1.13 review).
    assert.ok(
      html.includes(esc(c.key)),
      `docs cheat sheet does not print the key "${c.key}" for chord "${c.id}"; re-run npm run build:docs`,
    );
  }
});

test('the README chord table matches the map row for row — key, description, panes', () => {
  // Parse the generated block and compare it to the map as structured rows.
  // Asserting description substrings alone (the first cut of this test) let a
  // changed key or pane scope rot README.md while the suite stayed green — the
  // v1.13 review caught it. `build:readme-chords` is run by no build step, so
  // this test is the only thing holding the table honest.
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const start = readme.indexOf('<!-- chords:start');
  const end = readme.indexOf('<!-- chords:end -->');
  assert.ok(start >= 0 && end > start, 'README.md is missing the generated chord-table markers');
  const block = readme.slice(start, end);

  // Rows are compared as whole (key, desc, panes) triples. Two chords may
  // legitimately share a key AND a description across surfaces — `start` in the
  // app list and `atStart` in `daimon attach` are both "s / start the selected
  // app" — so anything less than the full triple collides.
  const rows = [];
  for (const line of block.split('\n')) {
    // | `key` | desc | panes |
    const m = line.match(/^\|\s*`(.+?)`\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!m) continue;
    rows.push(`${m[1]}::${m[2]}::${m[3]}`);
  }

  const esc = s => s.replace(/\|/g, '\\|');
  const expected = CHORDS.map(c => `${esc(c.key)}::${esc(c.desc)}::${c.panes.join(', ')}`);
  for (const want of expected) {
    assert.ok(
      rows.includes(want),
      `README chord table is stale — no row for "${want.split('::').join(' | ')}". Run: npm run build && npm run build:readme-chords`,
    );
  }
  assert.deepEqual(
    rows.slice().sort(), expected.slice().sort(),
    'README chord table and the chord map disagree — run: npm run build && npm run build:readme-chords',
  );
});
