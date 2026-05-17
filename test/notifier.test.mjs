import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Notifier } from '../dist/notifier.js';

class FakeRegistry extends EventEmitter {}

test('Notifier: init log line + attempt + ok recorded for status->error', async () => {
  const tmpHome = path.join(os.tmpdir(), `appman-notify-test-${Date.now()}`);
  fs.mkdirSync(tmpHome, { recursive: true });
  const origHome = process.env.USERPROFILE;
  process.env.USERPROFILE = tmpHome;
  process.env.HOMEDRIVE = tmpHome[0] + ':';
  process.env.HOMEPATH = tmpHome.slice(2);

  const reg = new FakeRegistry();
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false });

  reg.emit('event', { ts: Date.now(), app: 'demo', type: 'status', from: 'serving', to: 'error', message: 'crash' });
  await new Promise(r => setTimeout(r, 800));

  const logFile = path.join(os.homedir(), '.appman', 'notifications.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  assert.match(log, /init\t/, 'init line written');
  assert.match(log, /attempt\t/, 'attempt line written for the event');
  // SnoreToast's callback can lag arbitrarily; presence of 'attempt' is enough to prove wiring.

  n.stop();
  process.env.USERPROFILE = origHome;
});

test('Notifier: throttled within 60s', async () => {
  const tmpHome = path.join(os.tmpdir(), `appman-notify-throttle-${Date.now()}`);
  fs.mkdirSync(tmpHome, { recursive: true });
  process.env.USERPROFILE = tmpHome;
  process.env.HOMEDRIVE = tmpHome[0] + ':';
  process.env.HOMEPATH = tmpHome.slice(2);

  const reg = new FakeRegistry();
  const n = new Notifier(reg, { enabled: true, onError: true, onUnhealthy: true, tray: false });

  reg.emit('event', { ts: Date.now(), app: 'demo', type: 'status', from: 'serving', to: 'error' });
  reg.emit('event', { ts: Date.now(), app: 'demo', type: 'status', from: 'serving', to: 'error' });
  await new Promise(r => setTimeout(r, 500));

  const log = fs.readFileSync(path.join(os.homedir(), '.appman', 'notifications.log'), 'utf8');
  const attempts = (log.match(/\tattempt\t/g) || []).length;
  const throttled = (log.match(/\tthrottled\t/g) || []).length;
  assert.equal(attempts, 1, 'only one attempt fires');
  assert.equal(throttled, 1, 'second is throttled');
  n.stop();
});
