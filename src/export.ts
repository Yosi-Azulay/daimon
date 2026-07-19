// `daimon export` (M111, v1.4) — the carry-out bundle. ONE-WAY by design:
// there is no `daimon import` and never will be (import edges toward sync, a
// standing NO) — bundles are for humans and external tools, not round-tripping.
// Pure COMPOSITION over existing history queries + the M83 report: no new
// analytics state, no new tables. The envelope is a CONSUMED FORMAT the moment
// it ships: `schemaVersion` (integer, starts at 1) evolves additive-only and
// readers must ignore unknown keys. Every section degrades independently to a
// `{ note }`, never an error. Redaction holds here exactly as in the DB: env
// key names + hashes only, never values; no raw log-line section (crash
// entries keep their existing bounded tail excerpt, nothing else carries log
// lines).

import fs from 'node:fs';
import type { Registry } from './registry.js';
import type { History } from './history.js';
import { buildReport, renderReportMd, type Report } from './report.js';
import { groupErrors, type ErrorGroup } from './errorGroups.js';
import { DAIMON_VERSION } from './version.js';

export const EXPORT_SCHEMA_VERSION = 1;

// Per-section row caps — size discipline for an artifact that leaves the
// machine. Internal constants (not config): a consumed format needs
// predictable bounds, not knobs.
const CAPS = { events: 10_000, testRuns: 500, compiles: 10_000, crashes: 200 } as const;

export interface ExportOpts {
  // Window start (ms since epoch). Default at the call sites is 7d back.
  since: number;
  until?: number;
  app?: string;
}

export interface ExportInputs {
  registry: Registry;
  history: History | null;
  agents?: { id: string; lastSeen: number }[];
  // Audit-derived rows (M124, v1.6) forwarded into the embedded report's agents
  // section — same composition-only discipline; export adds no analytics state.
  auditRows?: { ts: string; agent: string | null; action: string; app: string | null }[];
  flakyThreshold?: number;
}

// Section payloads keep the EXISTING query shapes unmodified: rows are exactly
// what history.queryEvents/queryTestRuns/queryCompiles/queryCrashes return,
// `errorGroups.groups` is the GET /api/errors?group=fingerprint shape, and
// `report` is the M83 Report object.
export interface ExportBundle {
  schemaVersion: number;
  generatedAt: number;
  daimonVersion: string;
  since: number;
  until: number;
  app: string | null;
  sections: {
    events: { count: number; rows: any[] } | { note: string };
    errorGroups: { count: number; groups: ErrorGroup[] } | { note: string };
    testRuns: { count: number; rows: any[] } | { note: string };
    compiles: { count: number; rows: any[] } | { note: string };
    crashes: { count: number; rows: any[] } | { note: string };
    report: Report | { note: string };
  };
}

export function buildExport(inputs: ExportInputs, opts: ExportOpts): ExportBundle {
  const { registry, history: h } = inputs;
  const until = opts.until ?? Date.now();
  const since = opts.since;
  const app = opts.app;

  const bundle: ExportBundle = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: until,
    daimonVersion: DAIMON_VERSION,
    since,
    until,
    app: app ?? null,
    sections: {} as ExportBundle['sections'],
  };
  const S = bundle.sections;

  const rowsOr = (rows: any[], what: string): { count: number; rows: any[] } | { note: string } =>
    rows.length ? { count: rows.length, rows } : { note: `no ${what} in the window` };

  // --- events ---------------------------------------------------------------
  try {
    S.events = !h
      ? { note: 'history disabled — events unavailable' }
      : rowsOr(h.queryEvents({ app, since, until, limit: CAPS.events }), 'events');
  } catch (err: any) {
    S.events = { note: `unavailable: ${err?.message || err}` };
  }

  // --- error groups (live registry errors, fingerprint-folded like
  // GET /api/errors?group=fingerprint, windowed by last-seen overlap) --------
  try {
    const scope = registry.list().filter(a => !app || a.name === app || a.baseName === app);
    const perApp = scope.map(s => ({ app: s.name, errors: registry.errors(s.name) ?? [] }));
    const groups = groupErrors(perApp).filter(g => g.lastSeen >= since && g.firstSeen <= until);
    S.errorGroups = groups.length ? { count: groups.length, groups } : { note: 'no error groups in the window' };
  } catch (err: any) {
    S.errorGroups = { note: `unavailable: ${err?.message || err}` };
  }

  // --- test runs ------------------------------------------------------------
  try {
    S.testRuns = !h
      ? { note: 'history disabled — test runs unavailable' }
      : rowsOr(h.queryTestRuns({ app, since, limit: CAPS.testRuns }).filter(r => r.ts <= until), 'test runs');
  } catch (err: any) {
    S.testRuns = { note: `unavailable: ${err?.message || err}` };
  }

  // --- compiles -------------------------------------------------------------
  try {
    S.compiles = !h
      ? { note: 'history disabled — compiles unavailable' }
      : rowsOr(h.queryCompiles({ app, since, until, limit: CAPS.compiles }), 'compiles');
  } catch (err: any) {
    S.compiles = { note: `unavailable: ${err?.message || err}` };
  }

  // --- crashes (rows keep their existing bounded lastLines tail — the only
  // log excerpt an export may carry) ----------------------------------------
  try {
    S.crashes = !h
      ? { note: 'history disabled — crashes unavailable' }
      : rowsOr(h.queryCrashes({ app, since, limit: CAPS.crashes }).filter(c => c.ts <= until), 'crashes');
  } catch (err: any) {
    S.crashes = { note: `unavailable: ${err?.message || err}` };
  }

  // --- report (M83, embedded whole — its sections degrade on their own) -----
  try {
    S.report = buildReport(
      { registry, history: h, agents: inputs.agents, auditRows: inputs.auditRows, flakyThreshold: inputs.flakyThreshold },
      { since, until, app },
    );
  } catch (err: any) {
    S.report = { note: `unavailable: ${err?.message || err}` };
  }

  return bundle;
}

// ---------------------------------------------------------------------------
// Markdown rendering (--format md): the report rendered in full plus one
// summary line per bundle section — paste-ready for Slack/PRs/bug trackers.
// ---------------------------------------------------------------------------

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

export function renderExportMd(b: ExportBundle): string {
  const L: string[] = [];
  L.push('# daimon export');
  L.push(`_schemaVersion ${b.schemaVersion} · daimon v${b.daimonVersion} · generated ${fmtTs(b.generatedAt)} · window ${fmtTs(b.since)} → ${fmtTs(b.until)}${b.app ? ` · app \`${b.app}\`` : ''}_`);
  L.push('_one-way bundle — daimon has no import; env values are never included_');
  L.push('');

  L.push('## Sections');
  const S = b.sections;
  const line = (name: string, sec: any, unit: string): string =>
    'note' in (sec ?? {}) ? `- **${name}** — ${sec.note}` : `- **${name}** — ${sec.count} ${unit}${sec.count === 1 ? '' : 's'}`;
  L.push(line('events', S.events, 'event'));
  L.push(line('errorGroups', S.errorGroups, 'group'));
  L.push(line('testRuns', S.testRuns, 'run'));
  L.push(line('compiles', S.compiles, 'compile'));
  L.push(line('crashes', S.crashes, 'crash'));
  if (!('note' in S.errorGroups)) {
    for (const g of S.errorGroups.groups.slice(0, 8)) {
      L.push(`  - [${g.apps.join(', ')}] ×${g.count}: ${g.message.slice(0, 120)}`);
    }
  }
  L.push('');

  if ('note' in S.report) {
    L.push('## Report');
    L.push(`> ${S.report.note}`);
  } else {
    L.push(renderReportMd(S.report));
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CSV rendering (--format csv): the flat lowest-common-denominator view — one
// row per record with stable columns `section,ts,app,summary,detail` (detail
// is the record's JSON). NOT a second schema: the canonical bundle is JSON.
// The report section is not flattened (it is not a record list); `#`-prefixed
// preamble lines carry the envelope.
// ---------------------------------------------------------------------------

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderExportCsv(b: ExportBundle): string {
  const L: string[] = [];
  L.push(`# daimon export schemaVersion=${b.schemaVersion} daimonVersion=${b.daimonVersion} generatedAt=${new Date(b.generatedAt).toISOString()} since=${new Date(b.since).toISOString()} until=${new Date(b.until).toISOString()} app=${b.app ?? '-'}`);
  L.push('section,ts,app,summary,detail');
  const push = (section: string, ts: number | null, app: string, summary: string, detail: any): void => {
    L.push([section, ts == null ? '' : String(ts), app, summary, JSON.stringify(detail)].map(csvEscape).join(','));
  };
  const S = b.sections;
  if (!('note' in S.events)) {
    for (const e of S.events.rows) {
      const move = e.from_state || e.to_state ? ` ${e.from_state ?? '?'}→${e.to_state ?? '?'}` : '';
      push('events', e.ts, e.app, `${e.type}${move}${e.message ? `: ${String(e.message).slice(0, 200)}` : ''}`, e);
    }
  }
  if (!('note' in S.errorGroups)) {
    for (const g of S.errorGroups.groups) {
      push('errorGroups', g.lastSeen, g.apps.join(';'), `×${g.count} ${g.message.slice(0, 200)}`, g);
    }
  }
  if (!('note' in S.testRuns)) {
    for (const r of S.testRuns.rows) {
      push('testRuns', r.ts, r.app, `${r.runner ?? 'tests'}: ${r.passed ?? '?'}/${r.total ?? '?'} passed, ${r.failed ?? '?'} failed`, r);
    }
  }
  if (!('note' in S.compiles)) {
    for (const c of S.compiles.rows) push('compiles', c.ts, c.app, `${c.ms}ms`, c);
  }
  if (!('note' in S.crashes)) {
    for (const c of S.crashes.rows) {
      push('crashes', c.ts, c.app, `exit=${c.exitCode ?? '?'}${c.signal ? ` signal=${c.signal}` : ''}`, c);
    }
  }
  return L.join('\n') + '\n';
}

// Atomic --out write (the M88 rule): write-tmp + rename, so a mid-write kill
// can never leave a torn target file. No .bak — the target is a user-chosen
// artifact path, not daemon state.
export function writeExportAtomic(target: string, text: string): { path: string; bytes: number } {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
  return { path: target, bytes: Buffer.byteLength(text) };
}
