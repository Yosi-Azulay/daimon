import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCycle, topoLevels, transitiveClosure, dependants } from '../dist/depends.js';

test('findCycle returns null on a DAG', () => {
  assert.equal(findCycle({ a: ['b'], b: ['c'], c: [] }), null);
});

test('findCycle returns the cycle path on a cycle', () => {
  const c = findCycle({ a: ['b'], b: ['c'], c: ['a'] });
  assert.ok(c && c.length >= 3);
  assert.equal(c[0], c[c.length - 1]);
});

test('findCycle detects self-loop', () => {
  const c = findCycle({ a: ['a'] });
  assert.ok(c);
});

test('topoLevels orders deps before dependants', () => {
  const lv = topoLevels({ web: ['api'], api: ['db'], db: [] }, ['web', 'api', 'db']);
  const flat = lv.flat();
  assert.ok(flat.indexOf('db') < flat.indexOf('api'));
  assert.ok(flat.indexOf('api') < flat.indexOf('web'));
});

test('topoLevels groups parallel deps at same level', () => {
  const lv = topoLevels({ web: ['api', 'cache'], api: [], cache: [] }, ['web', 'api', 'cache']);
  assert.deepEqual(lv[0].sort(), ['api', 'cache']);
  assert.deepEqual(lv[1], ['web']);
});

test('transitiveClosure includes root and all deps', () => {
  const c = transitiveClosure({ web: ['api'], api: ['db'], db: [] }, 'web').sort();
  assert.deepEqual(c, ['api', 'db', 'web']);
});

test('dependants returns reverse edges', () => {
  const d = dependants({ web: ['api'], admin: ['api'], api: [] }, 'api').sort();
  assert.deepEqual(d, ['admin', 'web']);
});
