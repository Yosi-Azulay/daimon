// Queryable view over the audit trail (M122, v1.6 — "Agent Ledger"). PURE over
// the two audit files: it reads `audit.log` + `audit.log.1`, parses every row
// with the shared `parseAuditLine` (5- and 6-col rows both parse), and derives
// a stable query row `{ ts, agent, action, app, changedKeys, remote }` from the
// existing `verb:<app>` changedKeys convention that `test:<app>` established —
// NO new audit column, NO format change. Malformed/truncated lines are skipped
// and counted, never fabricated into rows and never an error (fail-soft).
//
// The roster (`daimon agents`, M123) and lock analytics (M124) DERIVE from these
// rows at query time — no new state, no new table, no new timer.

import fs from 'node:fs';
import path from 'node:path';
import { daimonDir } from './daemon.js';
import { parseAuditLine, type AuditEntry } from './audit.js';

// The mutating verbs the daemon audits with a single `verb:<app>` changedKey.
// A row whose first changedKey is `<verb>:<target>` for one of these is an
// action row; the target is the app. `group-*` verbs target a GROUP, not an
// app, so their derived `app` stays null.
export const AUDIT_APP_VERBS = new Set([
  'start', 'stop', 'restart', 'steal', 'handoff', 'mute', 'unmute', 'test',
]);
const GROUP_VERB_RE = /^group-[a-z]+$/;

export interface AuditRow {
  ts: string;
  agent: string | null;
  action: string;
  app: string | null;
  changedKeys: string[];
  remote: string;
}

// Derive the query row from a parsed audit entry. Action rows carry exactly one
// `verb:<target>` changedKey (the widened lifecycle rows and the legacy
// `test:<app>` / `group-<verb>:<group>` rows all follow it). Everything else is
// a config write: action 'config', app lifted from an `overrides.<app>.*` key
// when present, else null.
export function deriveAuditRow(e: AuditEntry): AuditRow {
  const first = e.changedKeys[0] ?? '';
  const colon = first.indexOf(':');
  if (colon > 0) {
    const verb = first.slice(0, colon);
    const target = first.slice(colon + 1);
    if (AUDIT_APP_VERBS.has(verb)) {
      return { ts: e.ts, agent: e.agent, action: verb, app: target || null, changedKeys: e.changedKeys, remote: e.remote };
    }
    if (GROUP_VERB_RE.test(verb)) {
      // Group action — not app-scoped; app stays null so `--app` never matches it.
      return { ts: e.ts, agent: e.agent, action: verb, app: null, changedKeys: e.changedKeys, remote: e.remote };
    }
  }
  // Config write. Lift an app from the first overrides.<app>.* key if any.
  let app: string | null = null;
  for (const k of e.changedKeys) {
    const m = /^overrides\.([^.]+)\./.exec(k);
    if (m) { app = m[1]; break; }
  }
  return { ts: e.ts, agent: e.agent, action: 'config', app, changedKeys: e.changedKeys, remote: e.remote };
}

// Read both audit files newest-first. `audit.log.1` is the older rotated half,
// so the order is: current file reversed, then rotated file reversed. Returns
// the parsed entries plus the count of non-empty lines that failed to parse.
export function readAuditEntries(dir: string = daimonDir()): { entries: AuditEntry[]; skipped: number } {
  const entries: AuditEntry[] = [];
  let skipped = 0;
  // Newest file first; within a file the newest line is last, so reverse each.
  for (const name of ['audit.log', 'audit.log.1']) {
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); }
    catch { continue; }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const parsed = parseAuditLine(line);
      if (parsed) entries.push(parsed);
      else skipped++;
    }
  }
  return { entries, skipped };
}

export interface AuditQuery {
  agent?: string;
  app?: string;
  sinceTs?: number;
  limit?: number;
}

// The `daimon audit` / `GET /api/audit` query: derive rows, apply AND filters,
// newest-first, default limit 100. `skipped` is the fail-soft parse count.
export function queryAudit(q: AuditQuery = {}, dir?: string): { rows: AuditRow[]; skipped: number; total: number } {
  const { entries, skipped } = readAuditEntries(dir);
  let rows = entries.map(deriveAuditRow);
  if (q.agent) rows = rows.filter(r => r.agent === q.agent);
  if (q.app) rows = rows.filter(r => r.app === q.app);
  if (q.sinceTs != null) {
    rows = rows.filter(r => { const t = Date.parse(r.ts); return Number.isFinite(t) && t >= q.sinceTs!; });
  }
  const total = rows.length;
  const limit = q.limit != null && q.limit > 0 ? q.limit : 100;
  return { rows: rows.slice(0, limit), skipped, total };
}

export interface AgentAuditStats {
  firstSeen: string | null;
  lastSeen: string | null;
  actions: Record<string, number>;
  total: number;
}

// Per-agent aggregation over ALL derived rows (no limit) — feeds the roster
// (M123) and report "agents" deepening (M124). Rows with no declared agent
// aggregate under the '(unknown)' key. `rows` is newest-first.
export function aggregateAgents(rows: AuditRow[]): Map<string, AgentAuditStats> {
  const out = new Map<string, AgentAuditStats>();
  for (const r of rows) {
    const key = r.agent ?? '(unknown)';
    let s = out.get(key);
    if (!s) { s = { firstSeen: r.ts, lastSeen: r.ts, actions: {}, total: 0 }; out.set(key, s); }
    s.actions[r.action] = (s.actions[r.action] ?? 0) + 1;
    s.total++;
    // rows are newest-first: the first time we see an agent is its lastSeen;
    // keep overwriting firstSeen so it ends on the oldest row for that agent.
    s.firstSeen = r.ts;
  }
  return out;
}

// Per-app contention from durable audit rows (M124): `steal:<app>` rows survive
// a daemon restart, so live-steal counts derived here outlast the in-memory
// LockManager ring. Returns app -> { steals } over the given (already-filtered)
// rows.
export function aggregateAppSteals(rows: AuditRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.action === 'steal' && r.app) out.set(r.app, (out.get(r.app) ?? 0) + 1);
  }
  return out;
}
