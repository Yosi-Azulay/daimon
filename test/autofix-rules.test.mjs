import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_AUTO_FIX } from '../dist/autoFix.js';

test('M36: new rules are present in ALL_AUTO_FIX', () => {
  for (const name of ['port-conflict-pred', 'node-version-mismatch', 'orphan-node-modules', 'dead-search-root']) {
    assert.ok(ALL_AUTO_FIX.includes(name), `${name} missing from ALL_AUTO_FIX`);
  }
});

test('M36: original M28 rules still present (backwards compat)', () => {
  for (const name of ['orphan-daemon', 'stale-lock', 'missing-search-root', 'corrupt-history-db']) {
    assert.ok(ALL_AUTO_FIX.includes(name), `${name} dropped from ALL_AUTO_FIX`);
  }
});

test('M39: polyglot orphan rules present', () => {
  for (const name of ['orphan-venv', 'orphan-bundler-cache', 'orphan-cargo-target']) {
    assert.ok(ALL_AUTO_FIX.includes(name), `${name} missing from ALL_AUTO_FIX`);
  }
});
