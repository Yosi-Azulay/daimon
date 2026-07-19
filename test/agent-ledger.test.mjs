import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v1.6 "Agent Ledger" (M122–M124): the queryable audit trail, the derived
// roster, and the lock-contention analytics. State is isolated via DAIMON_HOME
// (the first-class harness relocation) so appendAuditEntry / readAuditEntries
// hit a throwaway dir, never the real ~/.daimon.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-ledger-'));
process.env.DAIMON_HOME = fakeHome;

const { daimonDir } = await import('../dist/daemon.js');
const { appendAuditEntry } = await import('../dist/audit.js');
const { readAuditEntries, deriveAuditRow, queryAudit, aggregateAgents, aggregateAppSteals } =
  await import('../dist/auditQuery.js');

function auditFile() { return path.join(daimonDir(), 'audit.log'); }
function writeRaw(lines) {
  fs.mkdirSync(daimonDir(), { recursive: true });
  fs.writeFileSync(auditFile(), lines.map(l => l).join('\n') + '\n');
}
function reset() { try { fs.unlinkSync(auditFile()); } catch {} try { fs.unlinkSync(auditFile() + '.1'); } catch {} }

// --- M122: parse + derive + query -----------------------------------------

test('readAuditEntries skips malformed rows and counts them', () => {
  reset();
  writeRaw([
    '2026-07-19T00:00:01.000Z\t127.0.0.1\tsha1\tstart:web\t/repo\thost-1-aaaa', // 6-col action
    '2026-07-19T00:00:02.000Z\t127.0.0.1\tsha2\tapiPort,profiles\t/repo',       // 5-col config (legacy)
    'garbage-with-no-tabs',                                                       // malformed
    'a\tb\tc',                                                                     // too short → malformed
    '',                                                                            // blank → ignored, not counted
  ]);
  const { entries, skipped } = readAuditEntries();
  assert.equal(entries.length, 2, 'two parseable rows');
  assert.equal(skipped, 2, 'two malformed rows counted (blank line not counted)');
});

test('deriveAuditRow lifts action/app from a verb:<app> row', () => {
  const row = deriveAuditRow({ ts: 't', remote: '127.0.0.1', sha1: 'x', changedKeys: ['restart:web-admin'], cwd: null, agent: 'host-1-aaaa' });
  assert.equal(row.action, 'restart');
  assert.equal(row.app, 'web-admin');
  assert.equal(row.agent, 'host-1-aaaa');
});

test('deriveAuditRow marks a config write and lifts app from overrides.<app>.*', () => {
  const cfg = deriveAuditRow({ ts: 't', remote: '127.0.0.1', sha1: 'x', changedKeys: ['overrides.api.healthProbePath'], cwd: null, agent: null });
  assert.equal(cfg.action, 'config');
  assert.equal(cfg.app, 'api');
  const bare = deriveAuditRow({ ts: 't', remote: '127.0.0.1', sha1: 'x', changedKeys: ['apiPort'], cwd: null, agent: null });
  assert.equal(bare.action, 'config');
  assert.equal(bare.app, null);
});

test('deriveAuditRow keeps group actions non-app-scoped', () => {
  const g = deriveAuditRow({ ts: 't', remote: '127.0.0.1', sha1: 'x', changedKeys: ['group-up:day'], cwd: null, agent: 'a' });
  assert.equal(g.action, 'group-up');
  assert.equal(g.app, null);
});

test('legacy 5-col row surfaces with a null agent', () => {
  reset();
  writeRaw(['2026-07-19T00:00:00.000Z\t127.0.0.1\tsha\tstart:web\t/repo']); // no 6th col
  const { rows } = queryAudit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, null);
  assert.equal(rows[0].action, 'start');
  assert.equal(rows[0].app, 'web');
});

test('queryAudit filters compose (agent AND app AND since), newest first', () => {
  reset();
  writeRaw([
    '2026-07-19T00:00:01.000Z\t127.0.0.1\ts1\tstart:web\t/r\thost-A',
    '2026-07-19T00:00:02.000Z\t127.0.0.1\ts2\tstop:web\t/r\thost-B',
    '2026-07-19T00:00:03.000Z\t127.0.0.1\ts3\trestart:api\t/r\thost-A',
    '2026-07-19T00:00:04.000Z\t127.0.0.1\ts4\tstart:web\t/r\thost-A',
  ]);
  const all = queryAudit();
  assert.equal(all.rows[0].ts, '2026-07-19T00:00:04.000Z', 'newest first');
  const byAgent = queryAudit({ agent: 'host-A' });
  assert.equal(byAgent.rows.length, 3);
  const byBoth = queryAudit({ agent: 'host-A', app: 'web' });
  assert.equal(byBoth.rows.length, 2, 'host-A on web');
  const sinceTs = Date.parse('2026-07-19T00:00:03.000Z');
  const bySince = queryAudit({ sinceTs });
  assert.equal(bySince.rows.length, 2, 'rows at/after 00:00:03');
});

test('queryAudit default limit is 100 and total reflects the pre-limit count', () => {
  reset();
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`2026-07-19T00:00:00.${String(i).padStart(3, '0')}Z\t127.0.0.1\ts\tstart:web\t/r\thost-A`);
  writeRaw(lines);
  const r = queryAudit();
  assert.equal(r.rows.length, 100);
  assert.equal(r.total, 150);
  assert.equal(queryAudit({ limit: 10 }).rows.length, 10);
});

test('aggregateAgents rolls up per-action counts and firstSeen (unknown bucketed)', () => {
  reset();
  writeRaw([
    '2026-07-19T00:00:01.000Z\t127.0.0.1\ts\tstart:web\t/r\thost-A',
    '2026-07-19T00:00:02.000Z\t127.0.0.1\ts\tstop:web\t/r\thost-A',
    '2026-07-19T00:00:03.000Z\t127.0.0.1\ts\trestart:web\t/r', // no agent → (unknown)
  ]);
  const { entries } = readAuditEntries();
  const stats = aggregateAgents(entries.map(deriveAuditRow));
  assert.equal(stats.get('host-A').actions.start, 1);
  assert.equal(stats.get('host-A').actions.stop, 1);
  assert.equal(stats.get('host-A').firstSeen, '2026-07-19T00:00:01.000Z');
  assert.ok(stats.has('(unknown)'));
  assert.equal(stats.get('(unknown)').actions.restart, 1);
});

test('aggregateAppSteals counts durable steal:<app> rows only', () => {
  reset();
  writeRaw([
    '2026-07-19T00:00:01.000Z\t127.0.0.1\ts\tsteal:web\t/r\thost-B',
    '2026-07-19T00:00:02.000Z\t127.0.0.1\ts\tsteal:web\t/r\thost-C',
    '2026-07-19T00:00:03.000Z\t127.0.0.1\ts\tstart:web\t/r\thost-A',
  ]);
  const { entries } = readAuditEntries();
  const steals = aggregateAppSteals(entries.map(deriveAuditRow));
  assert.equal(steals.get('web'), 2);
});

// --- M122/M123/M124: live HTTP surface -------------------------------------

function baseConfig() {
  return {
    searchRoots: [], portRange: [4000, 4099], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: '', retentionDays: 0 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null },
  };
}

async function withServer(fn) {
  const { Registry } = await import('../dist/registry.js');
  const { startServer } = await import('../dist/server.js');
  const config = baseConfig();
  const app = { name: 'web', workspaceRoot: fakeHome, workspaceType: 'vite', command: 'echo', hidden: false, tags: [] };
  const reg = new Registry(config, [app]);
  const server = startServer(reg, 0, { getConfig: () => config });
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

test('a stop leaves an audit row that /api/audit finds by agent, app, and since', async () => {
  reset();
  await withServer(async (base) => {
    // stop fails (echo app not running) but is still gated + audited before running.
    await fetch(`${base}/api/apps/web/stop`, { method: 'POST', headers: { 'x-daimon-agent': 'host-99-zzzz' } });
    const r = await fetch(`${base}/api/audit`).then(r => r.json());
    const row = r.rows.find(x => x.action === 'stop' && x.app === 'web');
    assert.ok(row, 'a stop:web row exists');
    assert.equal(row.agent, 'host-99-zzzz');
    const byAgent = await fetch(`${base}/api/audit?agent=host-99-zzzz`).then(r => r.json());
    assert.ok(byAgent.rows.some(x => x.action === 'stop'));
    const byApp = await fetch(`${base}/api/audit?app=web`).then(r => r.json());
    assert.ok(byApp.rows.some(x => x.action === 'stop'));
    const bySince = await fetch(`${base}/api/audit?since=1h`).then(r => r.json());
    assert.ok(bySince.rows.some(x => x.action === 'stop'));
  });
});

test('a ?steal=1 lifecycle call leaves a durable steal:<app> row', async () => {
  reset();
  await withServer(async (base) => {
    await fetch(`${base}/api/apps/web/stop?steal=1`, { method: 'POST', headers: { 'x-daimon-agent': 'thief-1-aaaa' } });
    const r = await fetch(`${base}/api/audit?app=web`).then(r => r.json());
    assert.ok(r.rows.some(x => x.action === 'steal'), 'steal row present');
  });
});

test('/api/agents roster merges live registry + audit history + locks; unknown aggregates', async () => {
  reset();
  // Seed audit history for an agent that will NOT be live at query time.
  writeRaw([
    '2026-07-19T00:00:01.000Z\t127.0.0.1\ts\tstart:web\t/r\thistoric-agent',
    '2026-07-19T00:00:02.000Z\t127.0.0.1\ts\tstop:web\t/r', // unknown
  ]);
  await withServer(async (base) => {
    // A live agent acquires a lock on web (start attempt takes the soft lock).
    await fetch(`${base}/api/apps/web/start`, { method: 'POST', headers: { 'x-daimon-agent': 'live-agent-bbbb' } });
    const body = await fetch(`${base}/api/agents`).then(r => r.json());
    // Back-compat keys still present.
    assert.ok(Array.isArray(body.agents));
    assert.ok(body.locks);
    // New roster present.
    const ids = body.roster.map(a => a.id);
    assert.ok(ids.includes('historic-agent'), 'audit-only agent appears');
    assert.ok(ids.includes('live-agent-bbbb'), 'live agent appears');
    assert.ok(ids.includes('(unknown)'), 'unknown bucket appears');
    const historic = body.roster.find(a => a.id === 'historic-agent');
    assert.equal(historic.active, false, 'audit-only agent is inactive');
    assert.equal(historic.actions.start, 1);
    const live = body.roster.find(a => a.id === 'live-agent-bbbb');
    assert.equal(live.active, true);
    assert.ok(live.locks.includes('web'), 'held lock surfaces under the holder');
  });
});

test('/api/agents contention hotspots reflect a real denial', async () => {
  reset();
  await withServer(async (base) => {
    await fetch(`${base}/api/apps/web/start`, { method: 'POST', headers: { 'x-daimon-agent': 'holder-aaaa' } });
    // A different agent is denied (holder still owns the 30s lock).
    const denied = await fetch(`${base}/api/apps/web/restart`, { method: 'POST', headers: { 'x-daimon-agent': 'waiter-bbbb' } });
    assert.equal(denied.status, 409);
    const body = await fetch(`${base}/api/agents`).then(r => r.json());
    const hot = body.contention.hotspots.find(h => h.app === 'web');
    assert.ok(hot, 'web is a contention hotspot');
    assert.ok(hot.waits >= 1, 'the denial is counted as a wait');
    const waiter = body.roster.find(a => a.id === 'waiter-bbbb');
    assert.ok(waiter.waits >= 1, 'per-agent wait recorded');
  });
});

// --- M124: report agents-section deepening --------------------------------

test('buildReport agents section shows top agents + contention hotspots', async () => {
  const { buildReport } = await import('../dist/report.js');
  const { Registry } = await import('../dist/registry.js');
  const reg = new Registry(baseConfig(), [{ name: 'web', workspaceRoot: fakeHome, workspaceType: 'vite', command: 'echo', hidden: false, tags: [] }]);
  const now = Date.parse('2026-07-19T12:00:00.000Z');
  const auditRows = [
    { ts: '2026-07-19T11:00:00.000Z', agent: 'host-A', action: 'start', app: 'web' },
    { ts: '2026-07-19T11:05:00.000Z', agent: 'host-A', action: 'steal', app: 'web' },
    { ts: '2026-07-19T11:10:00.000Z', agent: 'host-B', action: 'stop', app: 'web' },
  ];
  const report = buildReport(
    { registry: reg, history: null, agents: [{ id: 'host-A', lastSeen: now - 60_000 }], auditRows },
    { since: now - 3600_000, until: now },
  );
  const S = report.sections.agents;
  assert.ok(!S.note, 'section populated, not a note');
  assert.equal(S.auditActions, 3);
  assert.equal(S.topAgents[0].id, 'host-A');
  assert.equal(S.topAgents[0].actions, 2);
  assert.equal(S.contentionHotspots[0].app, 'web');
  assert.equal(S.contentionHotspots[0].steals, 1);
});

test('buildReport agents section degrades to a note with no activity', async () => {
  const { buildReport } = await import('../dist/report.js');
  const { Registry } = await import('../dist/registry.js');
  const reg = new Registry(baseConfig(), []);
  const now = Date.parse('2026-07-19T12:00:00.000Z');
  const report = buildReport({ registry: reg, history: null, agents: [], auditRows: [] }, { since: now - 3600_000, until: now });
  assert.ok(report.sections.agents.note, 'empty history yields a note');
});

test('cleanup: restore DAIMON_HOME', () => {
  delete process.env.DAIMON_HOME;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});
