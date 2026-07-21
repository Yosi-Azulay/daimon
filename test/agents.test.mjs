import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Identity derivation persists a session->id map under daimonDir() (v1.14), so
// this file MUST isolate its state dir before importing the module — otherwise
// it reads and writes the developer's real ~/.daimon/cli-sessions.json, which
// both pollutes their machine and makes these assertions depend on whatever a
// previous run left behind.
process.env.DAIMON_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-agents-suite-'));
delete process.env.DAIMON_AGENT_ID;

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

// --- M124 (v1.6) contention analytics -------------------------------------

test('analytics tags a denial when a second agent is refused within TTL', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 0);
  lm.acquire('web', 'B', 'restart', 100); // denied — A holds
  const a = lm.analytics(200).perApp.get('web');
  assert.equal(a.waits, 1);
  assert.equal(a.stealsLive, 0);
  const bAgent = lm.analytics(200).perAgent.get('B');
  assert.equal(bAgent.waits, 1);
});

test('analytics distinguishes a live steal from a steal-after-expiry', () => {
  const lm = new LockManager(1000);
  lm.acquire('web', 'A', 'start', 0);
  lm.steal('web', 'B', 'restart', 100);   // live — A still holds
  lm.acquire('web', 'B', 'start', 200);   // B refreshes (own lock)
  // let B's lock expire, then C steals nothing live
  lm.steal('web', 'C', 'restart', 5000);  // after-expiry — B's lock lapsed
  const a = lm.analytics(5000).perApp.get('web');
  assert.equal(a.stealsLive, 1, 'one live steal');
  assert.equal(a.stealsAfterExpiry, 1, 'one steal after expiry');
});

test('analytics measures the longest hold from first acquire to last refresh', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 1000);
  lm.acquire('web', 'A', 'restart', 6000); // same agent refresh — hold spans 5s
  const a = lm.analytics(6000).perApp.get('web');
  assert.ok(a.longestHoldMs >= 5000, `longest hold ${a.longestHoldMs} >= 5000`);
});

test('analytics: a non-contended acquire produces no waits or steals', () => {
  const lm = new LockManager(30_000);
  lm.acquire('web', 'A', 'start', 0);
  const a = lm.analytics(10).perApp.get('web');
  assert.equal(a.waits, 0);
  assert.equal(a.stealsLive, 0);
  assert.equal(a.stealsAfterExpiry, 0);
});


// ── v1.14: one terminal is ONE agent ─────────────────────────────────────────
//
// The papercut this fixes: a fresh identity per CLI process made `daimon start
// web` and the `daimon stop web` typed a second later look like two competing
// agents, so the 30s soft lock denied the second command.
//
// These tests spawn children with EXPLICITLY DIFFERENT session environments —
// an earlier version of this suite spawned two children from one test process,
// which share a parent by construction, so it asserted only that the function
// is deterministic and would have passed even if it returned a constant.
const mintScript = "import('./dist/agents.js').then(m=>process.stdout.write(m.generateAgentId()))";

function mint(env) {
  const { execFileSync } = require_child();
  const clean = { ...process.env, ...env };
  delete clean.DAIMON_AGENT_ID;
  for (const k of ['WT_SESSION', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'TMUX_PANE', 'SSH_TTY']) {
    if (!(k in env)) delete clean[k];
  }
  return execFileSync(process.execPath, ['-e', mintScript], { env: clean, encoding: 'utf8' }).trim();
}
function require_child() {
  return { execFileSync: childProcess.execFileSync };
}
const childProcess = await import('node:child_process');
const fsMod = await import('node:fs');
const osMod = await import('node:os');
const pathMod = await import('node:path');

function withHome(fn) {
  const home = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'daimon-agentid-'));
  try { return fn(home); } finally { fsMod.rmSync(home, { recursive: true, force: true }); }
}

test('the same terminal keeps ONE identity across separate processes', () => {
  withHome(home => {
    const env = { DAIMON_HOME: home, WT_SESSION: 'tab-alpha' };
    const a = mint(env);
    const b = mint(env);
    const c = mint(env);
    assert.equal(a, b, 'consecutive commands in one terminal must share an identity');
    assert.equal(b, c);
    assert.match(a, /^[a-z0-9-]+-\d+-[0-9a-f]{4}$/, `shape preserved: ${a}`);
  });
});

test('different terminals get different identities', () => {
  withHome(home => {
    const a = mint({ DAIMON_HOME: home, WT_SESSION: 'tab-alpha' });
    const b = mint({ DAIMON_HOME: home, WT_SESSION: 'tab-beta' });
    assert.notEqual(a, b, 'two terminals must not collapse into one agent — that is the M124 protection');
  });
});

test('the suffix is REAL entropy, not a hash of the session key', () => {
  // The regression this pins: deriving the suffix from the same inputs already
  // in the id made two shells that reuse an OS pid byte-identical, so one
  // silently refreshed the other's live lock instead of being denied.
  const ids = new Set();
  for (let i = 0; i < 6; i++) {
    withHome(home => { ids.add(mint({ DAIMON_HOME: home, WT_SESSION: 'same-key-every-time' })); });
  }
  assert.ok(ids.size > 1, `identical session keys must still mint distinct random ids, got ${[...ids]}`);
});

test('a recycled ppid does not inherit the previous shell identity', () => {
  withHome(home => {
    // No terminal session var → the ppid fallback. Two runs with the SAME
    // simulated ppid key but a cleared store must not produce the same id.
    const a = mint({ DAIMON_HOME: home, WT_SESSION: 'ppid-sim-1' });
    fsMod.rmSync(pathMod.join(home, 'cli-sessions.json'), { force: true });
    const b = mint({ DAIMON_HOME: home, WT_SESSION: 'ppid-sim-1' });
    assert.notEqual(a, b, 'an expired/cleared session must mint a fresh identity, not resurrect the old one');
  });
});

test('an explicit DAIMON_AGENT_ID still wins over any session derivation', () => {
  withHome(home => {
    const out = childProcess.execFileSync(process.execPath, ['-e', mintScript], {
      env: { ...process.env, DAIMON_HOME: home, WT_SESSION: 'tab-alpha', DAIMON_AGENT_ID: 'pinned-agent-1' },
      encoding: 'utf8',
    }).trim();
    assert.equal(out, 'pinned-agent-1');
  });
});

test('identity derivation never throws when the state dir is unwritable', () => {
  // Advisory identity must never fail a command.
  const id = mint({ DAIMON_HOME: pathMod.join(osMod.tmpdir(), 'daimon-nonexistent', 'deep', 'path'), WT_SESSION: 'x' });
  assert.ok(id.length > 0, 'still produced an id');
});
