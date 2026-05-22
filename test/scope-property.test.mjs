import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isPathUnder } = await import('../dist/pathScope.js');

// Property-style tests for path-scope. These check the invariants
// `daimon list --cwd=` relies on: cwd-under-root and root-over-cwd should be
// symmetric for matching trees, drive-letter and UNC handling stays sane on
// Windows, and trailing-dot Windows paths do not slip the filter.

test('isPathUnder identity: any non-empty path is under itself', () => {
  for (const p of ['/a', '/a/b', 'C:\\repo', '\\\\srv\\share\\repo']) {
    assert.ok(isPathUnder(p, p), `${p} should be under itself`);
  }
});

test('isPathUnder direct child', () => {
  assert.ok(isPathUnder('/a/b', '/a'));
  assert.ok(isPathUnder('C:\\repo\\apps\\web', 'C:\\repo'));
});

test('isPathUnder rejects sibling paths', () => {
  assert.equal(isPathUnder('/a/b', '/a/c'), false);
  assert.equal(isPathUnder('C:\\repo\\web', 'C:\\repo\\api'), false);
});

test('isPathUnder rejects parent paths (not under)', () => {
  assert.equal(isPathUnder('/a', '/a/b'), false);
});

test('isPathUnder handles trailing slashes', () => {
  assert.ok(isPathUnder('/a/b/', '/a'));
  assert.ok(isPathUnder('/a/b', '/a/'));
});

test('isPathUnder distinct drive letters never match', () => {
  // Windows drive boundary — case insensitive comparison should hold,
  // different drives never share a tree.
  assert.equal(isPathUnder('D:\\repo\\web', 'C:\\repo'), false);
});

test('isPathUnder UNC path basic case', () => {
  assert.ok(isPathUnder('\\\\srv\\share\\repo\\web', '\\\\srv\\share\\repo'));
  assert.equal(isPathUnder('\\\\srv\\share\\other', '\\\\srv\\share\\repo'), false);
});

test('isPathUnder treats mixed slashes equivalently on Windows', () => {
  assert.ok(isPathUnder('C:/repo/web', 'C:\\repo'));
  assert.ok(isPathUnder('C:\\repo\\web', 'C:/repo'));
});

test('isPathUnder is not a prefix-only match (boundary respected)', () => {
  // /a/bar should NOT be under /a/b (no segment boundary)
  assert.equal(isPathUnder('/a/bar', '/a/b'), false);
});

test('isPathUnder empty-string inputs do not throw (returns boolean)', () => {
  // path.resolve('') is process.cwd(), so the comparison resolves rather than
  // crashes. The contract this guards against is "throws on empty string".
  const r = isPathUnder('', '/a');
  assert.equal(typeof r, 'boolean');
});

test('isPathUnder very long random-ish nested path remains true', () => {
  const root = '/'.repeat(0) + Array.from({ length: 12 }, (_, i) => `seg${i}`).join('/');
  const child = root + '/leaf/file';
  assert.ok(isPathUnder(child, root));
});

test('isPathUnder Windows trailing-dot paths still match', () => {
  // Trailing dot is legal on UNC + drive paths; should not break the prefix check.
  assert.ok(isPathUnder('C:\\repo.\\web', 'C:\\repo.'));
});
