import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_CHORD_KEY,
  workspaceCycle,
  cycleWorkspaceFilter,
  filterByWorkspace,
} from '../dist/tui/workspaceChord.js';
import { CHORDS, resolveChord, MAIN_CHORD_IDS } from '../dist/tui/chords.js';

// The TUI `w` workspace-filter chord (M173, v1.15 "Atlas"). The preference is
// CLIENT-SIDE BY DESIGN: pure functions over the config + this process's own
// state — nothing here can write to the daemon or state.json (asserted below).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the chord is a real map row: key w, list+detail panes, dispatched by App', () => {
  const row = CHORDS.find(c => c.id === 'wsFilter');
  assert.ok(row, 'wsFilter row exists in the chord map');
  assert.equal(row.key, WORKSPACE_CHORD_KEY);
  assert.deepEqual([...row.panes].sort(), ['detail', 'list']);
  assert.ok(MAIN_CHORD_IDS.includes('wsFilter'), 'App.tsx handler table covers it');
  assert.equal(resolveChord('list', 'w', {})?.id, 'wsFilter');
  assert.equal(resolveChord('log', 'w', {}), null, 'w stays free inside the log pane');
});

test('workspaceCycle: effective labels in config order — labeled roots keep labels, unlabeled use basename', () => {
  const labels = workspaceCycle({
    searchRoots: [
      { path: 'D:\\ws\\alpha', label: 'fullstack' },
      'D:\\ws\\beta',
    ],
  });
  assert.deepEqual(labels, ['fullstack', 'beta']);
});

test('cycleWorkspaceFilter: none -> each label -> none, and repeats', () => {
  const labels = ['fullstack', 'beta'];
  let cur = null;
  cur = cycleWorkspaceFilter(labels, cur);
  assert.equal(cur, 'fullstack');
  cur = cycleWorkspaceFilter(labels, cur);
  assert.equal(cur, 'beta');
  cur = cycleWorkspaceFilter(labels, cur);
  assert.equal(cur, null);
  cur = cycleWorkspaceFilter(labels, cur);
  assert.equal(cur, 'fullstack');
});

test('cycleWorkspaceFilter: no searchRoots → permanent no-op; vanished label resets to none', () => {
  assert.equal(cycleWorkspaceFilter([], null), null);
  assert.equal(cycleWorkspaceFilter([], 'anything'), null);
  assert.equal(cycleWorkspaceFilter(['a', 'b'], 'gone'), null);
});

test('filterByWorkspace: null passes through; matching uses the effective label', () => {
  const apps = [
    { name: 'web', workspaceLabel: 'fullstack', workspaceRoot: 'D:\\ws\\alpha' },
    { name: 'beta1', workspaceLabel: null, workspaceRoot: 'D:\\ws\\beta' },
  ];
  assert.equal(filterByWorkspace(apps, null), apps);
  assert.deepEqual(filterByWorkspace(apps, 'fullstack').map(a => a.name), ['web']);
  assert.deepEqual(filterByWorkspace(apps, 'beta').map(a => a.name), ['beta1'], 'unlabeled root matches by basename');
  assert.deepEqual(filterByWorkspace(apps, 'nope'), []);
});

test('two independent filter states never interact — the module holds no hidden cursor', () => {
  // Both "TUIs" route every step THROUGH the module, interleaved. A shared
  // module-level cursor (the failure mode this test exists for) would make
  // the second same-argument call return the NEXT label instead of the same
  // one — pure-function determinism is what makes two TUIs independent.
  const labels = ['fullstack', 'beta'];
  let tuiA = cycleWorkspaceFilter(labels, null);
  const tuiB = cycleWorkspaceFilter(labels, null);
  assert.equal(tuiA, 'fullstack');
  assert.equal(tuiB, 'fullstack', 'same input, same output — a shared cursor would have advanced to beta');
  tuiA = cycleWorkspaceFilter(labels, tuiA);
  assert.equal(tuiA, 'beta');
  assert.equal(cycleWorkspaceFilter(labels, tuiB), 'beta', "B's own advance is a function of B's state only");
  assert.equal(cycleWorkspaceFilter(labels, null), 'fullstack', "A's walk left no residue in the module");
});

test('no daemon-side persistence: workspaceChord.ts is import-pure (no fs, no fetch, no state.json)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'tui', 'workspaceChord.ts'), 'utf8');
  for (const banned of ['node:fs', 'fetch(', 'state.json', 'stateFile', 'daimonDir', 'child_process']) {
    assert.ok(!src.includes(banned), `workspaceChord.ts must not reference ${banned}`);
  }
});

test("App.tsx never persists the workspace filter: no setWsFilter path touches state or the daemon", () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'tui', 'App.tsx'), 'utf8');
  // The filter must live in useState only — grep for any write of wsFilter
  // into a persistence call. The state-file APIs visible to the TUI process
  // are mergeState/writeState (stateFile.ts); neither may appear near it.
  assert.ok(src.includes('const [wsFilter, setWsFilter] = useState'), 'wsFilter is React state');
  assert.ok(!/mergeState|writeStateFile/.test(src), 'App.tsx does not import state-file writers at all');
});
