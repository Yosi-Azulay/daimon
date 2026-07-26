import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M181 (v1.16 "Recall") — saved searches.
//
// Two things this file exists to prove, in order of importance:
//   1. INERTNESS. A saved search is data. Nothing schedules it, nothing runs
//      it, no timer reads the list. daimon has exactly one scheduler (the
//      digest's 1-minute tick) and this feature does not touch it.
//   2. The state.json contract: merge-write (never clobbering ports/mutes/
//      digests), survives a restart, and survives a corrupt main file via .bak.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-saved-'));
process.env.DAIMON_HOME = fakeHome;
process.env.DAIMON_NO_SPAWN = '1';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');

const {
  saveSearch, renameSearch, deleteSearch, sortSaved, findSaved,
  validateSavedSearchName, SAVED_SEARCH_MAX, SAVED_SEARCH_NAME_MAX,
} = await import('../dist/savedSearches.js');
const {
  loadPersistedState, savePersistedState, flushPersistedState, currentPersistedState, stateLoadDiagnostics,
} = await import('../dist/stateFile.js');

const T0 = 1_700_000_000_000;
const statePath = path.join(fakeHome, 'state.json');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

// ---------------------------------------------------------------------------
// The pure module

test('save validates the query with the REAL parser — a bad query is never stored', () => {
  const bad = saveSearch([], 'broken', 'lvl:error', { now: T0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.match(bad.error, /unknown field 'lvl:'/);

  const good = saveSearch([], 'today', 'level:error after:24h', { now: T0 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.entry, { name: 'today', query: 'level:error after:24h', createdMs: T0, updatedMs: T0 });
  assert.equal(good.searches.length, 1);
});

test('names and duplicates are guarded, and every refusal carries a remedy', () => {
  assert.match(validateSavedSearchName('').error, /needs a name/);
  assert.match(validateSavedSearchName('x'.repeat(SAVED_SEARCH_NAME_MAX + 1)).error, /longer than/);
  assert.match(validateSavedSearchName('a\u0007b').error, /control characters/);
  assert.equal(validateSavedSearchName('  ok-name  '), null);

  const one = saveSearch([], 'dupe', 'boom', { now: T0 }).searches;
  const clash = saveSearch(one, 'dupe', 'other', { now: T0 });
  assert.equal(clash.ok, false);
  assert.equal(clash.status, 409);
  assert.match(clash.hint, /--force/);

  const forced = saveSearch(one, 'dupe', 'other', { force: true, now: T0 + 5 });
  assert.equal(forced.ok, true);
  assert.equal(forced.searches.length, 1, 'a forced save replaces, never appends');
  assert.equal(forced.entry.createdMs, T0, 'createdMs is preserved across a replace');
  assert.equal(forced.entry.updatedMs, T0 + 5);

  // The cap is a bound, not a silent drop.
  const many = Array.from({ length: SAVED_SEARCH_MAX }, (_, i) => ({ name: 's' + i, query: 'q', createdMs: T0, updatedMs: T0 }));
  const over = saveSearch(many, 'one-more', 'q', { now: T0 });
  assert.equal(over.ok, false);
  assert.match(over.error, /too many saved searches/);
  assert.equal(saveSearch(many, 's3', 'q2', { force: true, now: T0 }).ok, true, 'replacing at the cap still works');
});

test('rename and delete: 404s name what IS saved, and rename keeps the query intact', () => {
  const list = saveSearch([], 'a', 'app:web', { now: T0 }).searches;
  const missing = renameSearch(list, 'nope', 'b');
  assert.equal(missing.status, 404);
  assert.match(missing.hint, /saved: a/);

  const renamed = renameSearch(list, 'a', 'b', { now: T0 + 1 });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.entry.query, 'app:web');
  assert.equal(renamed.entry.createdMs, T0);
  assert.equal(findSaved(renamed.searches, 'a'), undefined);

  const collide = renameSearch(saveSearch(list, 'b', 'q', { now: T0 }).searches, 'a', 'b');
  assert.equal(collide.status, 409);

  const del = deleteSearch(renamed.searches, 'b');
  assert.equal(del.ok, true);
  assert.equal(del.searches.length, 0);
  assert.equal(deleteSearch([], 'ghost').status, 404);
  assert.match(deleteSearch([], 'ghost').hint, /nothing saved yet/);

  // Presentation order: newest update first, name as the tiebreak.
  const sorted = sortSaved([
    { name: 'b', query: 'q', createdMs: T0, updatedMs: T0 },
    { name: 'a', query: 'q', createdMs: T0, updatedMs: T0 + 9 },
  ]);
  assert.deepEqual(sorted.map(s => s.name), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// The state.json contract

test('merge-write: saving a search leaves ports, mutes and digests untouched', () => {
  loadPersistedState();
  savePersistedState({ ports: { web: 4200 }, mutes: { api: null }, digests: { 'https://x': T0 } });
  flushPersistedState();

  const list = saveSearch(currentPersistedState().savedSearches ?? [], 'today', 'level:error after:24h', { now: T0 }).searches;
  savePersistedState({ savedSearches: list });
  flushPersistedState();

  const onDisk = readState();
  assert.deepEqual(onDisk.ports, { web: 4200 }, 'ports survived the search write');
  assert.deepEqual(onDisk.mutes, { api: null });
  assert.deepEqual(onDisk.digests, { 'https://x': T0 });
  assert.equal(onDisk.savedSearches.length, 1);

  // …and the reverse: a ports write does not drop the searches.
  savePersistedState({ ports: { web: 4201 } });
  flushPersistedState();
  assert.equal(readState().savedSearches.length, 1, 'a later ports write kept the searches');
  assert.equal(readState().ports.web, 4201);
});

test('a restart reloads saved searches; a malformed row is dropped, never fabricated', () => {
  // A "restart" is a fresh load from the same file.
  const reloaded = loadPersistedState();
  assert.equal(reloaded.savedSearches.length, 1);
  assert.equal(reloaded.savedSearches[0].name, 'today');

  // Hand-edit the file the way another version (or a human) might.
  const raw = readState();
  raw.savedSearches.push({ name: 'no-query' });          // dropped: no query
  raw.savedSearches.push({ query: 'no-name' });          // dropped: no name
  raw.savedSearches.push('nonsense');                    // dropped: not an object
  raw.savedSearches.push({ name: 'partial', query: 'app:web' }); // kept, timestamps defaulted
  fs.writeFileSync(statePath, JSON.stringify(raw));
  const healed = loadPersistedState();
  assert.deepEqual(healed.savedSearches.map(s => s.name), ['today', 'partial']);
  assert.equal(healed.savedSearches[1].createdMs, 0);
});

test('a corrupt state.json recovers the saved searches from .bak', () => {
  // One more write so .bak holds a state that already contains the searches.
  savePersistedState({ ports: { web: 4202 } });
  flushPersistedState();
  assert.ok(fs.existsSync(statePath + '.bak'));
  assert.ok(JSON.parse(fs.readFileSync(statePath + '.bak', 'utf8')).savedSearches.length >= 1);

  fs.writeFileSync(statePath, '{ this is not json');
  const recovered = loadPersistedState();
  assert.equal(stateLoadDiagnostics().recoveredFromBak, true);
  assert.ok(recovered.savedSearches.length >= 1, 'searches came back from the .bak');
  assert.equal(recovered.savedSearches[0].name, 'today');
});

// ---------------------------------------------------------------------------
// Inertness — the load-bearing promise

test('nothing runs a saved search on its own: no timer, no scheduler, no notifier', () => {
  const src = fs.readFileSync(path.join(distDir, 'savedSearches.js'), 'utf8');
  for (const forbidden of ['setInterval', 'setTimeout', 'setImmediate', 'fetch(', 'http', 'require(']) {
    assert.ok(!src.includes(forbidden), `savedSearches.js must not reference ${forbidden} — it is pure data manipulation`);
  }

  // The scheduler / notification surfaces must not know saved searches exist.
  for (const f of ['webhooks.js', 'notifier.js', 'regressions.js', 'usage.js', 'logStorm.js']) {
    const p = path.join(distDir, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    assert.ok(!/savedSearch/i.test(s), `${f} references saved searches — a saved search must never fire anything`);
    assert.ok(!/api\/searches/.test(s), `${f} calls the saved-search API`);
  }

  // main.js is the file that owns every timer daimon has, so its ONE mention
  // gets a stronger check than the allowlist: the getter it hands the TUI must
  // not sit anywhere near a scheduler.
  const mainSrc = fs.readFileSync(path.join(distDir, 'main.js'), 'utf8');
  const mentions = [...mainSrc.matchAll(/savedSearches/g)].map(m => m.index);
  assert.ok(mentions.length <= 2, `main.js mentions savedSearches ${mentions.length} times — it should only build the TUI's read-only getter`);
  assert.match(mainSrc, /getSavedSearches\s*=\s*\(\)\s*=>/, 'the only main.js use must be the TUI getter');
  for (const at of mentions) {
    const around = mainSrc.slice(Math.max(0, at - 400), at + 400);
    for (const scheduler of ['setInterval', 'setTimeout', 'Digest', 'Notifier', 'Webhook']) {
      assert.ok(!around.includes(scheduler),
        `main.js has savedSearches within 400 chars of ${scheduler} — a saved search must never be wired to anything that fires on its own`);
    }
  }

  // Nothing in the daemon may pair a saved search with a timer: the only files
  // allowed to mention them at all are the ones a human drives.
  const allowed = new Set(['savedSearches.js', 'stateFile.js', 'server.js', 'cli.js', 'searchQuery.js', 'main.js']);
  for (const f of fs.readdirSync(distDir)) {
    if (!f.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(distDir, f), 'utf8');
    if (!/savedSearches/.test(s)) continue;
    assert.ok(allowed.has(f), `${f} touches savedSearches — add it to the reviewed allowlist only if a HUMAN drives it`);
  }
  // The TUI is human-driven by definition, and lives in its own dist subtree.
  const tuiDir = path.join(distDir, 'tui');
  for (const f of fs.existsSync(tuiDir) ? fs.readdirSync(tuiDir) : []) {
    if (!f.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(tuiDir, f), 'utf8');
    if (!/savedSearches|api\/searches/.test(s)) continue;
    assert.ok(!/setInterval/.test(s), `tui/${f} pairs saved searches with an interval`);
  }
});

test('cleanup', () => {
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});
