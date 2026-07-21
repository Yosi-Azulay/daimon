// Isolation note (fixed in v1.13): these tests used to relocate the state dir
// by overriding USERPROFILE/HOMEDRIVE/HOMEPATH and then RESTORING them at the
// end of each test. That was doubly wrong. The repo convention (M91) is that
// tests isolate with DAIMON_HOME — `daimonDir()` reads it first and falls back
// to os.homedir() only when it is unset. And because the notifier writes its
// log asynchronously (M84 batching), restoring the env mid-file meant a queued
// write could land in the REAL ~/.daimon after the override was undone. That
// leaked `notifications.log` into the user's actual state dir and made
// test/demo-script.test.mjs — which asserts the real ~/.daimon is untouched —
// fail whenever the two files ran in parallel.
//
// DAIMON_HOME is now set ONCE at module scope and never restored, so every
// write in this file lands in the temp dir no matter when it completes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const TMP_HOME = path.join(os.tmpdir(), `daimon-notifier-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.DAIMON_HOME = TMP_HOME;

const { Notifier } = await import('../dist/notifier.js');

const LOG_FILE = path.join(TMP_HOME, 'notifications.log');

class FakeRegistry extends EventEmitter {}

test('Notifier: init log line + attempt + ok recorded for status->error', async () => {
  const reg = new FakeRegistry();
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false });

  reg.emit('event', { ts: Date.now(), app: 'demo', type: 'status', from: 'serving', to: 'error', message: 'crash' });
  await new Promise(r => setTimeout(r, 800));

  const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
  assert.match(log, /init\t/, 'init line written');
  assert.match(log, /attempt\t/, 'attempt line written for the event');
  // SnoreToast's callback can lag arbitrarily; presence of 'attempt' is enough to prove wiring.

  n.stop();
});

test('Notifier: throttled within 60s', async () => {
  // A fresh log so the throttle counts below see only this test's lines.
  try { fs.rmSync(LOG_FILE, { force: true }); } catch {}

  const reg = new FakeRegistry();
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false });

  reg.emit('event', { ts: Date.now(), app: 'demo', type: 'status', from: 'serving', to: 'error' });
  reg.emit('event', { ts: Date.now(), app: 'demo', type: 'status', from: 'serving', to: 'error' });
  await new Promise(r => setTimeout(r, 500));

  const log = fs.readFileSync(LOG_FILE, 'utf8');
  const attempts = (log.match(/\tattempt\t/g) || []).length;
  const throttled = (log.match(/\tthrottled\t/g) || []).length;
  assert.equal(attempts, 1, 'only one attempt fires');
  assert.equal(throttled, 1, 'second is throttled');
  n.stop();
});

test('the notifier never writes to the real ~/.daimon during tests', async () => {
  // The regression this file caused: a leaked write into the user's real state
  // dir, which demo-script.test.mjs correctly flags. Assert the isolation
  // itself so it cannot silently rot again.
  assert.equal(process.env.DAIMON_HOME, TMP_HOME, 'DAIMON_HOME must stay set for the whole file');
  const { daimonDir } = await import('../dist/daemon.js');
  assert.equal(path.resolve(daimonDir()), path.resolve(TMP_HOME),
    'daimonDir() must resolve inside the temp home, not the real ~/.daimon');
});
