import { test } from 'node:test';
import assert from 'node:assert/strict';

const { generateAgentId, AgentRegistry, LockManager } = await import('../dist/agents.js');

test('generateAgentId returns a stable id within the same process', () => {
  const a = generateAgentId();
  const b = generateAgentId();
  assert.equal(a, b);
});

test('generateAgentId matches <host>-<pid>-<4hex> shape', () => {
  const id = generateAgentId();
  assert.match(id, /^[a-z0-9-]+-\d+-[0-9a-f]{4}$/);
});

test('AgentRegistry.touch creates and updates rows; list reflects active agents', () => {
  const reg = new AgentRegistry();
  const t0 = 1_700_000_000_000;
  reg.touch('a', '/a/cwd', t0);
  reg.touch('a', '/a/cwd', t0 + 1000);
  reg.touch('b', '/b/cwd', t0 + 2000);
  const list = reg.list(t0 + 3000);
  assert.equal(list.length, 2);
  const a = list.find(x => x.id === 'a');
  assert.equal(a.callCount, 2);
  assert.equal(a.cwd, '/a/cwd');
});

test('AgentRegistry inactivity filters list after 5 minutes', () => {
  const reg = new AgentRegistry();
  const t0 = 1_700_000_000_000;
  reg.touch('a', null, t0);
  // 6 minutes later, no further touches
  const later = reg.list(t0 + 6 * 60_000);
  assert.equal(later.length, 0);
});

test('LockManager.acquire grants the lock to the first agent', () => {
  const lm = new LockManager(30_000);
  const r = lm.acquire('web', 'agentA', 'start', 1000);
  assert.equal(r, null);
  const cur = lm.current('web', 1500);
  assert.ok(cur);
  assert.equal(cur.agent, 'agentA');
});

test('LockManager.acquire refuses a second agent within TTL', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 0);
  const blocked = lm.acquire('web', 'B', 'restart', 100);
  assert.ok(blocked);
  assert.equal(blocked.agent, 'A');
});

test('LockManager.acquire renews the same agent within TTL', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 0);
  const again = lm.acquire('web', 'A', 'restart', 5000);
  assert.equal(again, null);
});

test('LockManager expires after TTL', () => {
  const lm = new LockManager(1000);
  lm.acquire('web', 'A', 'start', 0);
  const second = lm.acquire('web', 'B', 'start', 2000);
  assert.equal(second, null);
});

test('LockManager.steal forces a takeover regardless of holder', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 0);
  const after = lm.steal('web', 'B', 'restart', 100);
  assert.equal(after.agent, 'B');
});

test('LockManager.handoff transfers the lock and records the interaction', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 0);
  const r = lm.handoff('web', 'B', 'A', 500);
  assert.equal(r.agent, 'B');
  const recent = lm.recentInteractions('web', 3);
  assert.ok(recent.some(x => x.action.startsWith('handoff')));
});

test('LockManager.recentInteractions returns newest-first up to limit', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 0);
  lm.acquire('web', 'A', 'stop', 1);
  lm.acquire('web', 'A', 'restart', 2);
  const r = lm.recentInteractions('web', 2);
  assert.equal(r.length, 2);
  assert.equal(r[0].action, 'restart');
});

test('LockManager.list ignores expired locks', () => {
  const lm = new LockManager(1000);
  lm.acquire('a', 'X', 'start', 0);
  const live = lm.list(2000);
  assert.equal(live.length, 0);
});
