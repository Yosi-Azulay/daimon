import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M140 — the platform-branch inventory is complete and cannot rot.
//
// This test greps compiled dist/ for every `process.platform` / `os.platform()`
// occurrence and proves each one is accounted for by a row in
// src/platformInventory.ts. Add a new platform branch without a table row (a
// scratch build) and the per-file token totals diverge → this fails. It is the
// completeness gate the release rests on.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');

const { PLATFORM_BRANCHES, tokensByFile } = await import('../dist/platformInventory.js');

const TOKEN_RX = /process\.platform|os\.platform\(\)/g;

// Strip // line comments and /* */ block comments before counting, so prose
// that mentions the token (this very file, the inventory's own doc comments)
// never registers as a branch. Real branches are code, never inside a comment.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function walkJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'dashboard') continue; // bundled Angular app, not daemon code
      out.push(...walkJs(full));
    } else if (ent.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// dist-relative key (posix separators) → token count, comments stripped.
function distTokenCounts() {
  const counts = new Map();
  for (const file of walkJs(distRoot)) {
    const rel = path.relative(distRoot, file).split(path.sep).join('/');
    // The inventory module itself is the table, not a branch site; its doc
    // comments legitimately name the tokens. Comment-stripping already zeroes
    // it, but skip explicitly so intent is clear.
    if (rel === 'platformInventory.js') continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const n = (src.match(TOKEN_RX) || []).length;
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

test('every dist platform token is accounted for by an inventory row', () => {
  const actual = distTokenCounts();
  const claimed = tokensByFile();

  // Files with tokens in dist but no inventory coverage → an untabled branch.
  const missing = [];
  for (const [file, n] of actual) {
    const c = claimed.get(file) ?? 0;
    if (c !== n) missing.push(`${file}: dist has ${n} platform token(s), inventory claims ${c}`);
  }
  // Inventory rows pointing at a file with fewer tokens than claimed → stale row.
  for (const [file, n] of claimed) {
    if (!actual.has(file)) missing.push(`${file}: inventory claims ${n} token(s) but dist has none`);
  }
  assert.deepEqual(missing, [], `platform-branch inventory drift:\n${missing.join('\n')}`);
});

test('every inventory row is well-formed (named gap, valid verdict, unique id)', () => {
  const verdicts = new Set(['verified', 'fixture', 'untestable-locally', 'bug']);
  const ids = new Set();
  for (const b of PLATFORM_BRANCHES) {
    assert.ok(b.id && !ids.has(b.id), `duplicate/empty inventory id: ${b.id}`);
    ids.add(b.id);
    for (const field of ['file', 'symbol', 'concern', 'windows', 'posix', 'tested', 'gap']) {
      assert.ok(typeof b[field] === 'string' && b[field].trim().length > 0, `${b.id}.${field} is empty`);
    }
    assert.ok(verdicts.has(b.verdict), `${b.id} has invalid verdict ${b.verdict}`);
    assert.ok(Number.isInteger(b.platformTokens) && b.platformTokens >= 0, `${b.id}.platformTokens invalid`);
  }
});

test('no inventory row has an empty gap column (gaps are named, "none" is a value)', () => {
  // The plan forbids a blank gap: a row must state its remaining exposure, and
  // "none" is a legitimate, explicit answer.
  for (const b of PLATFORM_BRANCHES) {
    assert.notEqual(b.gap.trim(), '', `${b.id} has a blank gap`);
  }
});

test('every "bug" verdict row documents that it was FIXED this release', () => {
  // Acceptance: every `bug` row has a fix + test in this milestone's diff. The
  // convention: the gap opens with "FIXED" and a test file proves it (the ss
  // parser fix is verified in port-forensics.test.mjs).
  const bugs = PLATFORM_BRANCHES.filter(b => b.verdict === 'bug');
  assert.ok(bugs.length >= 1, 'expected at least one bug found+fixed during the audit');
  for (const b of bugs) {
    assert.match(b.gap, /^FIXED\b/, `${b.id} is a bug row but its gap does not open with "FIXED"`);
  }
});
