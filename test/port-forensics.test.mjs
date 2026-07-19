import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M141 — port forensics in parity across platforms.
//
// Every recorded OS-tool sample in test/fixtures/platform/<tool>/ is fed through
// the PRODUCTION parse path (scanListeningPorts / findPortHolder) via portDiag's
// injectable command-runner seam — no test-only fork of the parsing logic. The
// same assertions run for win32 (netstat / PowerShell) and linux/darwin (ss /
// lsof / ps), so a green Windows run actually proves the POSIX side.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixRoot = path.join(__dirname, 'fixtures', 'platform');

const { scanListeningPorts, findPortHolder } = await import('../dist/portDiag.js');

function readFix(tool, file) {
  return fs.readFileSync(path.join(fixRoot, tool, file), 'utf8');
}
function readCases(tool) {
  return JSON.parse(fs.readFileSync(path.join(fixRoot, tool, 'cases.json'), 'utf8'));
}

// A runner that answers `tool` with the given stdout (status 0) and every other
// command with a failure — the way a POSIX box without `ss` would behave.
function runnerFor(tool, stdout, extra = {}) {
  return (cmd) => {
    if (cmd === tool) return { status: 0, stdout };
    if (extra[cmd] !== undefined) return { status: 0, stdout: extra[cmd] };
    return { status: 1, stdout: '' };
  };
}

function expectMap(obj) {
  return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
}

// --- scanListeningPorts: netstat (win32) + ss (linux) + lsof (darwin) --------

test('netstat fixtures resolve port→pid via the win32 scan path', () => {
  const { cases } = readCases('netstat');
  assert.ok(cases.length >= 1, 'netstat fixture must have cases (fixture-gating)');
  for (const c of cases) {
    const map = scanListeningPorts(c.want, { platform: 'win32', run: runnerFor('netstat', readFix('netstat', c.file)) });
    assert.deepEqual(map, expectMap(c.expect), `netstat: ${c.name}`);
  }
});

test('ss fixtures resolve port→pid via the linux scan path (M140 regression guard)', () => {
  const { cases } = readCases('ss');
  assert.ok(cases.length >= 1, 'ss fixture must have cases (fixture-gating)');
  for (const c of cases) {
    const map = scanListeningPorts(c.want, { platform: 'linux', run: runnerFor('ss', readFix('ss', c.file)) });
    assert.deepEqual(map, expectMap(c.expect), `ss: ${c.name}`);
  }
});

test('lsof fixtures resolve port→pid via the darwin fallback scan path', () => {
  const cj = readCases('lsof');
  assert.ok(cj.scan.length >= 1, 'lsof fixture must have scan cases (fixture-gating)');
  for (const c of cj.scan) {
    // darwin with no ss → falls back to lsof, exactly like production.
    const map = scanListeningPorts(c.want, { platform: 'darwin', run: runnerFor('lsof', readFix('lsof', c.file)) });
    assert.deepEqual(map, expectMap(c.expect), `lsof: ${c.name}`);
  }
});

// --- findPortHolder: lsof+ps (posix) + PowerShell (win32) --------------------

test('lsof+ps fixtures resolve a single-port holder on POSIX', () => {
  const cj = readCases('lsof');
  const lstart = readFix('ps', 'macos-lstart.txt');
  for (const c of cj.holder) {
    const holder = findPortHolder(c.port, {
      platform: 'darwin',
      run: runnerFor('lsof', readFix('lsof', c.file), { ps: lstart }),
    });
    assert.ok(holder, `holder expected for ${c.name}`);
    assert.equal(holder.pid, c.expect.pid, `pid: ${c.name}`);
    assert.equal(holder.name, c.expect.name, `name: ${c.name}`);
    assert.equal(holder.startedAt, lstart.trim(), `startedAt: ${c.name}`);
  }
});

test('PowerShell JSON fixture resolves a single-port holder on win32', () => {
  const json = readFix('powershell', 'win-holder.json');
  const holder = findPortHolder(4999, { platform: 'win32', run: runnerFor('powershell', json) });
  assert.ok(holder, 'win32 holder expected');
  assert.equal(holder.pid, 48211);
  assert.equal(holder.name, 'node.exe');
  assert.match(holder.cmd, /server\.js/);
  assert.equal(holder.startedAt, '2026-07-14T09:32:11Z');
});

// --- degradation: a missing/failed tool is best-effort, never a throw --------

test('a failing platform tool degrades to empty/null, never throws', () => {
  const fail = () => ({ status: 1, stdout: '' });
  assert.equal(scanListeningPorts([4999], { platform: 'linux', run: fail }).size, 0);
  assert.equal(scanListeningPorts([4999], { platform: 'darwin', run: fail }).size, 0);
  assert.equal(scanListeningPorts([4999], { platform: 'win32', run: fail }).size, 0);
  assert.equal(findPortHolder(4999, { platform: 'linux', run: fail }), null);
  assert.equal(findPortHolder(4999, { platform: 'win32', run: fail }), null);
});

// --- fixture-gating law: every POSIX scan tool has a fixture dir -------------

test('fixture-gating: every port-forensics platform tool ships a fixture', () => {
  for (const tool of ['ss', 'lsof', 'netstat', 'ps', 'powershell']) {
    assert.ok(fs.existsSync(path.join(fixRoot, tool)), `missing platform fixture dir: ${tool}`);
  }
  // Every scan tool declares provenance — in a PROVENANCE.md or its cases.json.
  for (const tool of ['ss', 'lsof', 'netstat']) {
    const hasMd = fs.existsSync(path.join(fixRoot, tool, 'PROVENANCE.md'));
    let hasJsonProv = false;
    try { hasJsonProv = !!JSON.parse(fs.readFileSync(path.join(fixRoot, tool, 'cases.json'), 'utf8')).provenance; } catch {}
    assert.ok(hasMd || hasJsonProv, `${tool} fixture must carry provenance (PROVENANCE.md or cases.json)`);
  }
  // Deleting a referenced sample makes readFix throw above — proving the suite
  // is gated on the fixtures actually existing.
});
