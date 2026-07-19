import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M142 — no more vacuous green.
//
// A green suite on Windows must say exactly what it did NOT prove on macOS/Linux
// (and vice versa). Every platform-conditional test routes through the
// platformSkip helper, which calls t.skip() with a note. This file is the
// accounting gate: it statically inventories every platformSkip call, asserts
// the set matches the committed expectation, and fails if any test smuggles in a
// SILENT platform gate (a bare `if (isWin)` or a `process.platform … return`)
// instead of skipping loudly. Static scanning is deterministic under node
// --test's parallel child processes, where a runtime counter cannot be.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = __dirname;
const SELF = 'platform-skips.test.mjs';

// Host-adaptive if-gates that assert on BOTH platforms (no silent skip) and are
// intentionally exempt. Each entry needs a documented reason.
const HOST_ADAPTIVE_ALLOWLIST = new Map([
  ['crash-forensics.test.mjs', 'suspiciousRootReason is host-bound (path.resolve); the if/else asserts the win32 list on Windows and the POSIX list on POSIX — the isSystemDir lists themselves are proven cross-platform in platform-seams.test.mjs'],
]);

// The committed, expected loud-skip inventory. A new platform skip (or a changed
// note) must be reflected here — the friction is intentional, like a contract
// snapshot, so the honest-skip set never drifts unnoticed.
const EXPECTED_SKIPS = [
  { file: 'path-scope.test.mjs', platforms: ['win32'], note: 'real NTFS case-insensitive path.resolve matching' },
  { file: 'path-scope.test.mjs', platforms: ['win32'], note: 'real Windows slash normalization in path.resolve' },
];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function testFiles() {
  return fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.mjs') && f !== SELF)
    .sort();
}

const SKIP_RX = /platformSkip\(\s*[A-Za-z_$][\w$]*\s*,\s*(\[[^\]]*\]|'[^']*'|"[^"]*")\s*,\s*(['"])([\s\S]*?)\2\s*\)/g;

function parsePlatforms(literal) {
  const parts = literal.match(/'[^']*'|"[^"]*"/g) || [];
  return parts.map(p => p.slice(1, -1));
}

function actualSkips() {
  const out = [];
  for (const file of testFiles()) {
    const src = stripComments(fs.readFileSync(path.join(testDir, file), 'utf8'));
    let m;
    SKIP_RX.lastIndex = 0;
    while ((m = SKIP_RX.exec(src)) !== null) {
      out.push({ file, platforms: parsePlatforms(m[1]), note: m[3] });
    }
  }
  return out;
}

function key(e) {
  return `${e.file}::[${[...e.platforms].sort().join(',')}]::${e.note}`;
}

test('platform-skip inventory matches the committed expectation', () => {
  const actual = actualSkips().map(key).sort();
  const expected = EXPECTED_SKIPS.map(key).sort();
  assert.deepEqual(actual, expected,
    `platform-skip drift.\n  actual:\n    ${actual.join('\n    ')}\n  expected:\n    ${expected.join('\n    ')}`);
});

test('no test smuggles in a SILENT platform gate (must use platformSkip)', () => {
  const offenders = [];
  // (a) `if (isWin)` / `if (!isWin)` — the old silent conditional-registration.
  const isWinGate = /\bif\s*\(\s*!?\s*isWin\b/;
  // (b) any `if (` whose condition reads the host platform — must be allowlisted
  //     (host-adaptive both-branch asserts) or converted to platformSkip.
  const platformIfGate = /\bif\s*\([^)]*(?:process\.platform|os\.platform\(\))[^)]*\)/;
  // (c) a platform-conditional early return — vacuous pass off-platform.
  const platformReturn = /(?:process\.platform|os\.platform\(\))[^\n;]*\breturn\b/;

  for (const file of testFiles()) {
    const src = stripComments(fs.readFileSync(path.join(testDir, file), 'utf8'));
    if (isWinGate.test(src)) offenders.push(`${file}: silent \`if (isWin)\` gate — use platformSkip`);
    if (platformReturn.test(src)) offenders.push(`${file}: platform-conditional early return — use platformSkip`);
    if (platformIfGate.test(src) && !HOST_ADAPTIVE_ALLOWLIST.has(file)) {
      offenders.push(`${file}: \`if (process.platform …)\` gate — convert to platformSkip or add to the documented host-adaptive allowlist`);
    }
  }
  assert.deepEqual(offenders, [], `silent platform gate(s) found:\n  ${offenders.join('\n  ')}`);
});

test('every host-adaptive allowlist entry actually still exists and gates on platform', () => {
  // Keeps the allowlist honest: an entry that no longer reads the platform is
  // dead and must be removed.
  for (const [file, reason] of HOST_ADAPTIVE_ALLOWLIST) {
    assert.ok(reason && reason.length > 20, `${file} allowlist entry needs a real reason`);
    const p = path.join(testDir, file);
    assert.ok(fs.existsSync(p), `allowlisted file ${file} does not exist`);
    const src = stripComments(fs.readFileSync(p, 'utf8'));
    assert.match(src, /process\.platform|os\.platform\(\)/, `${file} is allowlisted but no longer reads the platform`);
  }
});

// Print the accounting to the suite tail (the count + the notes), so a Windows
// run visibly states what it did not prove on macOS/Linux.
test('report the platform-skip count', () => {
  const actual = actualSkips();
  const lines = actual.map(e => `    - ${e.file} (requires ${e.platforms.join('|')}): ${e.note}`);
  console.log(`# platform-skips: ${actual.length}`);
  for (const l of lines) console.log(l);
  assert.ok(actual.length >= 0);
});
