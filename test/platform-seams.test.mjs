import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M141 — the non-port platform seams, exercised on BOTH sides via the injectable
// `platform` parameter. These run identically on any host: a Windows box proves
// the POSIX branch and vice versa. No process.platform is read; nothing is
// skipped.

const { resolveCommand, RootFs, builtinProfiles } = await import('../dist/frameworks.js');
const { buildServiceArtifact } = await import('../dist/serviceInstaller.js');
const { isSystemDir } = await import('../dist/doctor.js');
const { normalizeForCompare, isPathUnder } = await import('../dist/pathScope.js');

const profileById = (id) => builtinProfiles().find(p => p.id === id);

// --- frameworks: command variant selection ----------------------------------

test('resolveCommand picks win32Command on Windows, base command on POSIX', () => {
  const rails = profileById('rails');
  assert.ok(rails, 'rails profile present');
  const dirFs = new RootFs(path.join(os.tmpdir(), 'daimon-nonexistent-rails'));
  assert.equal(resolveCommand(rails, dirFs, undefined, 'linux'), 'bin/rails server');
  assert.equal(resolveCommand(rails, dirFs, undefined, 'darwin'), 'bin/rails server');
  assert.equal(resolveCommand(rails, dirFs, undefined, 'win32'), 'ruby bin/rails server');
});

test('resolveCommand picks the .cmd wrapper variant on Windows (commandCandidates)', () => {
  const spring = profileById('spring-boot');
  assert.ok(spring, 'spring-boot profile present');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-spring-'));
  fs.writeFileSync(path.join(dir, 'mvnw'), '#!/bin/sh\n');
  const dirFs = new RootFs(dir);
  assert.equal(resolveCommand(spring, dirFs, undefined, 'linux'), './mvnw spring-boot:run');
  assert.equal(resolveCommand(spring, dirFs, undefined, 'win32'), 'mvnw.cmd spring-boot:run');
});

// --- serviceInstaller: all three manifests ----------------------------------

test('buildServiceArtifact generates the right manifest per platform', () => {
  const win = buildServiceArtifact('win32');
  assert.equal(win.platform, 'win32');
  assert.match(win.body, /<service>/);
  assert.match(win.installCmd, /nssm install daimon/);
  assert.match(win.path, /daimon-daemon\.xml$/);

  const mac = buildServiceArtifact('darwin');
  assert.equal(mac.platform, 'darwin');
  assert.match(mac.body, /<plist/);
  assert.match(mac.body, /dev\.daimon/);
  assert.match(mac.installCmd, /launchctl load/);

  const lin = buildServiceArtifact('linux');
  assert.equal(lin.platform, 'linux');
  assert.match(lin.body, /\[Service\]/);
  assert.match(lin.body, /WantedBy=default\.target/);
  assert.match(lin.installCmd, /systemctl --user enable daimon/);
});

// --- doctor: system-directory lists -----------------------------------------

test('isSystemDir matches each platform own system directories', () => {
  // Windows list
  assert.equal(isSystemDir('c:\\windows', 'win32'), true);
  assert.equal(isSystemDir('c:\\windows\\system32', 'win32'), true);
  assert.equal(isSystemDir('c:\\program files', 'win32'), true);
  assert.equal(isSystemDir('d:\\projects\\app', 'win32'), false);
  // POSIX list — testable on Windows precisely because this helper takes a
  // pre-normalized path (no host-bound path.resolve).
  assert.equal(isSystemDir('/usr', 'linux'), true);
  assert.equal(isSystemDir('/usr/local/bin', 'linux'), true);
  assert.equal(isSystemDir('/opt/homebrew', 'darwin'), true);
  assert.equal(isSystemDir('/home/yosi/app', 'linux'), false);
  // A POSIX path is not a Windows system dir and vice versa.
  assert.equal(isSystemDir('/usr', 'win32'), false);
  assert.equal(isSystemDir('c:\\windows', 'linux'), false);
});

// --- pathScope: case-fold decision ------------------------------------------

test('normalizeForCompare folds case on Windows, preserves it on POSIX', () => {
  const raw = path.join(os.tmpdir(), 'MixedCase', 'AppDir');
  const win = normalizeForCompare(raw, 'win32');
  const pos = normalizeForCompare(raw, 'linux');
  assert.equal(win, win.toLowerCase(), 'win32 result is all lowercase');
  assert.match(pos, /MixedCase/, 'posix result preserves case');
  assert.notEqual(win, pos, 'the two platforms fold differently');
});

test('isPathUnder honors the injected platform for case sensitivity', () => {
  const parent = path.join(os.tmpdir(), 'Proj');
  const childDiffCase = path.join(os.tmpdir(), 'proj', 'sub');
  // Windows: case-insensitive → different-case child is under parent.
  assert.equal(isPathUnder(childDiffCase, parent, 'win32'), true);
  // POSIX: case-sensitive → different-case child is NOT under parent.
  assert.equal(isPathUnder(childDiffCase, parent, 'linux'), false);
});
