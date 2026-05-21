import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathUnder, normalizeForCompare } from '../dist/pathScope.js';

const isWin = process.platform === 'win32';

test('isPathUnder: identical paths match', () => {
  const p = path.resolve('/tmp/workspace');
  assert.equal(isPathUnder(p, p), true);
});

test('isPathUnder: child under parent', () => {
  const parent = path.resolve('/tmp/workspace');
  const child = path.join(parent, 'apps', 'editor');
  assert.equal(isPathUnder(child, parent), true);
});

test('isPathUnder: sibling does not match', () => {
  const a = path.resolve('/tmp/workspace-a');
  const b = path.resolve('/tmp/workspace-b');
  assert.equal(isPathUnder(b, a), false);
  // Prefix that isn't a path-separator boundary must not match.
  assert.equal(isPathUnder(path.resolve('/tmp/workspace-abc'), path.resolve('/tmp/workspace')), false);
});

test('isPathUnder: parent does not match child', () => {
  const parent = path.resolve('/tmp/workspace');
  const child = path.join(parent, 'apps');
  assert.equal(isPathUnder(parent, child), false);
});

test('isPathUnder: relative paths are resolved before comparison', () => {
  const parent = process.cwd();
  assert.equal(isPathUnder('.', parent), true);
  assert.equal(isPathUnder('./does/not/exist', parent), true);
});

if (isWin) {
  test('isPathUnder (Windows): case-insensitive matching', () => {
    const lower = 'd:\\synology\\sourcecode\\daimon';
    const upper = 'D:\\Synology\\SourceCode\\daimon\\src';
    assert.equal(isPathUnder(upper, lower), true);
  });

  test('isPathUnder (Windows): forward/back slash variants normalize the same way', () => {
    const a = 'D:/Synology/SourceCode/daimon';
    const b = 'D:\\Synology\\SourceCode\\daimon\\src';
    assert.equal(isPathUnder(b, a), true);
  });
}

test('normalizeForCompare: trailing-separator stripped via path.resolve', () => {
  const a = normalizeForCompare(path.resolve('/tmp/x/'));
  const b = normalizeForCompare(path.resolve('/tmp/x'));
  assert.equal(a, b);
});
