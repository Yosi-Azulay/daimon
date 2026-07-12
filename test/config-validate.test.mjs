import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `daimon config validate` (M91) + load-time unknown-key warnings: unknown
// keys warn with the nearest valid name and NEVER fail — a v0.1 config keeps
// loading forever (STABILITY.md's config back-compat rule).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-cfgval-'));

const { validateConfig, configValidationWarnings, nearestConfigKey, CONFIG_KEY_STABILITY } = await import('../dist/config.js');

function cli(args, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd,
      env: { ...process.env, DAIMON_HOME: tmp, DAIMON_NO_SPAWN: '1', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 15_000);
    child.on('close', code => {
      clearTimeout(killer);
      let body = null;
      try { body = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch {}
      resolve({ status: code, body, stdout, stderr });
    });
  });
}

test('nearestConfigKey suggests within 2 edits, null beyond', () => {
  assert.equal(nearestConfigKey('serchRoots'), 'searchRoots');
  assert.equal(nearestConfigKey('webhoks'), 'webhooks');
  assert.equal(nearestConfigKey('portrange'), 'portRange');
  assert.equal(nearestConfigKey('somethingWildlyUnrelated'), null);
});

test('load-time: unknown key warns with suggestion, config still loads', () => {
  const cfg = validateConfig({ serchRoots: ['D:/x'], apiPort: 5000 }, 'test');
  assert.equal(cfg.apiPort, 5000, 'valid keys applied');
  const warnings = configValidationWarnings();
  const hit = warnings.find(w => w.includes('unknown config key "serchRoots"'));
  assert.ok(hit, `unknown-key warning surfaced (got: ${warnings.join(' | ')})`);
  assert.ok(hit.includes('did you mean "searchRoots"?'), `nearest name suggested (got: ${hit})`);
});

test('load-time: $schema tolerated silently; known keys never trip the unknown-key warning', () => {
  validateConfig({ $schema: 'https://example.invalid/schema.json', searchRoots: [] }, 'test');
  assert.ok(!configValidationWarnings().some(w => w.includes('$schema')), '$schema never warns');
  const everyKnown = Object.fromEntries(Object.keys(CONFIG_KEY_STABILITY).map(k => [k, undefined]));
  validateConfig(everyKnown, 'test');
  assert.ok(!configValidationWarnings().some(w => w.includes('unknown config key')), 'no known key flagged unknown');
});

test('config validate: typo key -> ok:true, warning with suggestion, exit 0', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'typo-'));
  fs.writeFileSync(path.join(dir, 'daimon.config.json'), JSON.stringify({ serchRoots: ['./x'], apiPort: 5001 }));
  const r = await cli(['config', 'validate'], dir);
  assert.equal(r.status, 0, `warnings alone exit 0 (stderr: ${r.stderr})`);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.warnings.some(w => w.includes('did you mean "searchRoots"?')), JSON.stringify(r.body.warnings));
});

test('config validate: invalid JSON -> exit 1 with error', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'badjson-'));
  fs.writeFileSync(path.join(dir, 'daimon.config.json'), '{ "searchRoots": [ ');
  const r = await cli(['config', 'validate'], dir);
  assert.equal(r.status, 1, 'invalid JSON exits 1');
  assert.equal(r.body.ok, false);
  assert.ok(r.body.errors.some(e => e.includes('invalid JSON')), JSON.stringify(r.body.errors));
});

test('config validate: missing file -> exit 1 with init hint', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'missing-'));
  const r = await cli(['config', 'validate', path.join(dir, 'nope.json')], dir);
  assert.equal(r.status, 1);
  assert.equal(r.body.ok, false);
  assert.match(r.body.hint ?? '', /daimon init/, 'points at the fix');
});

test('config validate: clean config -> ok with zero warnings', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'clean-'));
  fs.writeFileSync(path.join(dir, 'daimon.config.json'), JSON.stringify({ searchRoots: [], apiPort: 5002, tags: {} }));
  const r = await cli(['config', 'validate'], dir);
  assert.equal(r.status, 0);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.warnings, []);
});

test('multi-word alias dispatch: profiles suggest reaches the daemon path (M91 regression)', async () => {
  // Shipped broken in v0.12–v0.13: the alias rewrote `profiles` to
  // `profiles suggest` but the dispatch switch only knew `profiles`. With no
  // daemon reachable the fixed verb must fail with "daimon is not running" —
  // NOT "unknown command".
  const dir = fs.mkdtempSync(path.join(tmp, 'profiles-'));
  const r = await new Promise(resolve => {
    const child = spawn(process.execPath, [cliJs, 'profiles', 'suggest'], {
      cwd: dir,
      env: { ...process.env, DAIMON_HOME: tmp, DAIMON_NO_SPAWN: '1', DAIMON_PORT: '59998', NO_COLOR: '1' },
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 15_000);
    child.on('close', code => { clearTimeout(killer); resolve({ code, stderr }); });
  });
  assert.ok(!r.stderr.includes('unknown command'), `verb must dispatch (got: ${r.stderr})`);
  assert.match(r.stderr, /daimon is not running/, 'fails on the daemon connection, not the dispatch');
});
