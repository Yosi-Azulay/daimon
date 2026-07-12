import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// npm package audit (M91): what ships in the tarball is a public artifact —
// no test fixtures, no plan files, no personal email; LICENSE/README/docs and
// the annotated example config must be present.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packed = (() => {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed: ${r.stderr}`);
  const arr = JSON.parse(r.stdout);
  return arr[0].files.map(f => f.path);
})();

test('tarball excludes tests, fixtures, plans, goals, and toolkit internals', () => {
  const forbidden = packed.filter(p =>
    /^test\//.test(p) || /fixture/i.test(p) || /\.test\.|\.spec\./.test(p) ||
    /^(GOAL|PLAN|RELEASE)-/i.test(p) || /^\.claude\//.test(p) || /^dashboard\/(src|e2e)\//.test(p) ||
    /SOAK/.test(p),
  );
  assert.deepEqual(forbidden, [], `tarball must not ship internals: ${forbidden.join(', ')}`);
});

test('tarball includes the public artifacts', () => {
  for (const required of ['README.md', 'LICENSE', 'CHANGELOG.md', 'docs/index.html', 'daimon.config.example.json', 'dist/cli.js', 'dist/main.js', 'dist/mcp.js']) {
    assert.ok(packed.includes(required), `${required} must ship in the package`);
  }
});

test('no personal email in any packed text artifact', () => {
  const needle = ['yosi', '@', 'flycotech.com'].join(''); // avoid embedding the literal here
  const offenders = [];
  for (const rel of packed) {
    if (/\.(png|ico|woff2?|ttf)$/i.test(rel)) continue;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (text.toLowerCase().includes(needle)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `personal email leaked into: ${offenders.join(', ')} — public author is "Yosi Azulay (https://flycotech.com)"`);
});

test('package.json author carries no email', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.author, 'Yosi Azulay (https://flycotech.com)');
});
