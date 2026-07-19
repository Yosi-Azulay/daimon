import { test } from 'node:test';
import assert from 'node:assert/strict';

// M143 — platform-aware doctor/remedy phrasing, both branches, on any host.

const { killCmd, inspectPortCmd, killHint } = await import('../dist/platformRemedy.js');
const { renderApiPortConflict } = await import('../dist/portDiag.js');

test('killCmd: taskkill on Windows, kill on POSIX', () => {
  assert.equal(killCmd(1234, 'win32'), 'taskkill /PID 1234 /F');
  assert.equal(killCmd(1234, 'linux'), 'kill 1234');
  assert.equal(killCmd(1234, 'darwin'), 'kill 1234');
});

test('inspectPortCmd: netstat/findstr on Windows, lsof on POSIX', () => {
  assert.equal(inspectPortCmd(4999, 'win32'), 'netstat -ano | findstr :4999');
  assert.equal(inspectPortCmd(4999, 'linux'), 'lsof -iTCP:4999 -sTCP:LISTEN');
  assert.equal(inspectPortCmd(null, 'win32'), 'netstat -ano');
  assert.equal(inspectPortCmd(null, 'darwin'), 'lsof -iTCP -sTCP:LISTEN');
});

test('killHint wraps the platform-correct command in backticks', () => {
  assert.equal(killHint(42, 'win32'), '`taskkill /PID 42 /F`');
  assert.equal(killHint(42, 'linux'), '`kill 42`');
});

// The port-conflict remedy — the model error string — names the right command
// per platform. Both branches asserted here, on any host.
function forensics(overrides = {}) {
  return {
    port: 4999,
    holder: { pid: 777, name: 'node.exe' },
    signature: { daimon: false },
    lockExists: false,
    ...overrides,
  };
}

test('renderApiPortConflict remedy names taskkill on Windows', () => {
  const text = renderApiPortConflict(forensics(), null, 'win32').join('\n');
  assert.match(text, /taskkill \/PID 777 \/F/);
  assert.doesNotMatch(text, /\bkill 777\b/, 'no bare POSIX kill on Windows');
});

test('renderApiPortConflict remedy names kill on POSIX', () => {
  const text = renderApiPortConflict(forensics(), null, 'linux').join('\n');
  assert.match(text, /`kill 777`/);
  assert.doesNotMatch(text, /taskkill/, 'no taskkill on POSIX');
});

test('renderApiPortConflict no-holder remedy uses the platform inspect command', () => {
  const winText = renderApiPortConflict(forensics({ holder: null, signature: null }), null, 'win32').join('\n');
  assert.match(winText, /netstat -ano \| findstr :4999/);
  const posixText = renderApiPortConflict(forensics({ holder: null, signature: null }), null, 'darwin').join('\n');
  assert.match(posixText, /lsof -iTCP:4999 -sTCP:LISTEN/);
});

test('the orphan-daimon remedy still points at doctor --auto-fix on both platforms', () => {
  for (const plat of ['win32', 'linux', 'darwin']) {
    const text = renderApiPortConflict(forensics({ signature: { daimon: true, version: '9.9.9' } }), null, plat).join('\n');
    assert.match(text, /daimon doctor --auto-fix/);
  }
});
