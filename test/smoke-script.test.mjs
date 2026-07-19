import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// M143 — scripts/platform-smoke.sh is the human's real-hardware probe. This test
// proves it parses as POSIX sh and its --dry-run plumbing runs green on any host
// (including this Windows dev box, via Git Bash / msys sh). It does NOT run the
// real probes — those need a live POSIX box.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const script = path.join(repoRoot, 'scripts', 'platform-smoke.sh');

// Find a POSIX shell: PATH first, then the usual Windows Git/msys locations.
function findSh() {
  const candidates = [
    'sh', 'bash',
    'C:/Program Files/Git/usr/bin/sh.exe',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/msys64/usr/bin/sh.exe',
    '/bin/sh', '/usr/bin/sh',
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'exit 0'], { encoding: 'utf8' });
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

const SH = findSh();

test('scripts/platform-smoke.sh exists and is a POSIX sh script', () => {
  assert.ok(fs.existsSync(script), 'smoke script present');
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /^#!\/bin\/sh/, 'has a /bin/sh shebang');
  // Guard against accidental bashisms that break dash.
  assert.doesNotMatch(src, /\[\[ /, 'no [[ ]] bash test');
  assert.doesNotMatch(src, /\bfunction\s+\w+\s*\(\)/, 'no `function name()` keyword form');
});

test('platform-smoke.sh parses clean under sh -n', (t) => {
  if (!SH) { t.skip('requires a POSIX shell (sh/bash) to syntax-check the smoke script'); return; }
  const r = spawnSync(SH, ['-n', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `sh -n failed:\n${r.stderr}`);
});

test('platform-smoke.sh --dry-run exercises the plumbing and passes', (t) => {
  if (!SH) { t.skip('requires a POSIX shell (sh/bash) to run the smoke script'); return; }
  const r = spawnSync(SH, [script, '--dry-run'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `dry-run exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /status:\s+PASS/, 'dry-run reports PASS');
  assert.match(r.stdout, /throwaway DAIMON_HOME created/, 'exercises temp-home plumbing');
  assert.match(r.stdout, /dry-run/, 'real probes are skipped, not run');
  // The real ~/.daimon must never be referenced by the dry run.
  assert.doesNotMatch(r.stdout, /[^-]\.daimon(?!-)/, 'dry-run output must not touch the real ~/.daimon');
});
