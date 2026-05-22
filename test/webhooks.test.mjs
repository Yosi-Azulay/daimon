import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { WebhookDispatcher, shapePayload } = await import('../dist/webhooks.js');

function fakeRegistry() {
  const ev = new EventEmitter();
  return ev;
}

function fakeSendCollecting(seen, status = 200) {
  return async (url, payload, headers) => {
    seen.push({ url, payload, headers });
    return { status };
  };
}

test('shapePayload generates Slack-shaped payload for slack.com hosts', () => {
  const p = shapePayload('https://hooks.slack.com/services/x/y/z', {
    ts: 1, app: 'web', type: 'error-new', message: 'boom',
  });
  assert.ok(p.text.includes('web'));
  assert.ok(Array.isArray(p.attachments));
});

test('shapePayload generates Discord-shaped payload for discord.com hosts', () => {
  const p = shapePayload('https://discord.com/api/webhooks/1/abc', {
    ts: 1, app: 'web', type: 'status', to: 'serving', from: 'starting',
  });
  assert.ok(Array.isArray(p.embeds));
  assert.ok(p.content.includes('serving'));
});

test('shapePayload falls back to generic envelope for unknown hosts', () => {
  const p = shapePayload('https://example.test/hook', { ts: 1, app: 'web', type: 'health', to: 'unhealthy' });
  assert.equal(p.event, 'health');
  assert.equal(p.app, 'web');
  assert.equal(p.to, 'unhealthy');
});

test('WebhookDispatcher delivers a matching event to the configured URL', async () => {
  const reg = fakeRegistry();
  const seen = [];
  const d = new WebhookDispatcher(reg, [{ url: 'http://test.test/hook', events: ['error-new'] }], { sendFn: fakeSendCollecting(seen) });
  reg.emit('event', { ts: 1, app: 'web', type: 'error-new', message: 'x' });
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(seen.length, 1);
  d.stop();
});

test('WebhookDispatcher filters by event type alias (error)', async () => {
  const reg = fakeRegistry();
  const seen = [];
  const d = new WebhookDispatcher(reg, [{ url: 'http://test.test/h', events: ['error'] }], { sendFn: fakeSendCollecting(seen) });
  reg.emit('event', { ts: 1, app: 'a', type: 'error-recur' });
  reg.emit('event', { ts: 2, app: 'a', type: 'status', to: 'serving' });
  await new Promise(r => setTimeout(r, 2200));
  // Only the error-recur should arrive (1 req/sec budget means both can deliver, but status doesn't match the filter)
  assert.equal(seen.length, 1);
  d.stop();
});

test('WebhookDispatcher drops oldest when queue overflows', async () => {
  const reg = fakeRegistry();
  const seen = [];
  let blocking = true;
  const slowSend = async () => { while (blocking) await new Promise(r => setTimeout(r, 50)); return { status: 200 }; };
  const d = new WebhookDispatcher(reg, [{ url: 'http://t/h' }], { sendFn: slowSend });
  for (let i = 0; i < 100; i++) reg.emit('event', { ts: i, app: 'a', type: 'status', to: 'serving' });
  await new Promise(r => setTimeout(r, 100));
  const s = d.stats();
  assert.ok(s.dropped > 0, `expected dropped count > 0, got ${s.dropped}`);
  blocking = false;
  d.stop();
});

test('WebhookDispatcher honors the filter.app allow-list', async () => {
  const reg = fakeRegistry();
  const seen = [];
  const d = new WebhookDispatcher(reg, [{ url: 'http://t/h', filter: { app: ['web'] } }], { sendFn: fakeSendCollecting(seen) });
  reg.emit('event', { ts: 1, app: 'api', type: 'status', to: 'serving' });
  reg.emit('event', { ts: 2, app: 'web', type: 'status', to: 'serving' });
  await new Promise(r => setTimeout(r, 2200));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.app, 'web');
  d.stop();
});

test('WebhookDispatcher.setWebhooks updates the routing table', async () => {
  const reg = fakeRegistry();
  const seenA = [];
  const seenB = [];
  const dispatch = new WebhookDispatcher(reg, [{ url: 'http://a' }], {
    sendFn: async (u, p, h) => { (u === 'http://a' ? seenA : seenB).push(p); return { status: 200 }; },
  });
  dispatch.setWebhooks([{ url: 'http://b' }]);
  reg.emit('event', { ts: 1, app: 'web', type: 'health', to: 'healthy' });
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(seenA.length, 0);
  assert.equal(seenB.length, 1);
  dispatch.stop();
});
