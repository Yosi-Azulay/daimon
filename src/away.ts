// "While you were away" (M135, v1.8 "Rewind"). The first attach after a gap
// answers "what did I miss" unprompted. This module is pure composition: it
// REUSES the M83 report composition (NOT a new engine) and derives the gap
// baseline from the session list (M134) — no new endpoint, no new timer. The
// away-gap threshold is a fixed constant (the plan's zero-new-config-keys rule).

import type { Report } from './report.js';
import type { SessionSummary } from './sessions.js';

// Fixed, documented, revisited only on real demand — never a config key.
export const AWAY_GAP_MS = 4 * 3600_000;

// The gap baseline: the later of the last acknowledgement and the previous
// session's last-event timestamp (the plan's "whichever is later"). Null when
// there is no reference point yet (a first-ever session) — then nothing is
// shown, and the first dismissal seeds the ack for next time.
export function awayBaseline(sessions: SessionSummary[], awayAck?: number | null): number | null {
  // sessions are newest-first; the previous session is the most recent one that
  // is not the current open slice. Its `end` is its last observed event.
  const previous = sessions.find(s => !s.current);
  const prevLast = previous?.end ?? null;
  const cand = Math.max(awayAck ?? 0, prevLast ?? 0);
  return cand > 0 ? cand : null;
}

export interface AwaySummary {
  gapStart: number;
  gapMs: number;
  // A strict SUBSET of the report: new/resolved errors, crashes, env changes.
  // Each key is present only when it has something to say — no "0 events" noise.
  errors?: { newCount: number; resolvedCount: number; groups: any[] };
  crashes?: { total: number; byApp: any[] };
  env?: { changes: any[] };
}

// Pull the away subset out of a full report built with since = gapStart.
// Returns null when there is nothing to say (empty-report gap shows nothing).
export function extractAwaySummary(report: Report, gapStart: number, now: number): AwaySummary | null {
  const S = report.sections ?? {};
  const out: AwaySummary = { gapStart, gapMs: now - gapStart };
  let has = false;

  const e = S.errors;
  if (e && !e.note && ((e.newCount ?? 0) > 0 || (e.resolvedCount ?? 0) > 0)) {
    out.errors = { newCount: e.newCount ?? 0, resolvedCount: e.resolvedCount ?? 0, groups: (e.groups ?? []).slice(0, 5) };
    has = true;
  }
  const c = S.crashes;
  if (c && !c.note && (c.total ?? 0) > 0) {
    out.crashes = { total: c.total, byApp: c.byApp ?? [] };
    has = true;
  }
  const env = S.env;
  if (env && !env.note && (env.changes?.length ?? 0) > 0) {
    out.env = { changes: env.changes };
    has = true;
  }
  return has ? out : null;
}

// Should an away summary be shown at all? Baseline exists AND the gap exceeds
// the threshold. The caller then builds the report with since = baseline and
// calls extractAwaySummary (which may still return null when nothing happened).
export function awayGap(sessions: SessionSummary[], now: number, awayAck?: number | null): number | null {
  const baseline = awayBaseline(sessions, awayAck);
  if (baseline == null) return null;
  if (now - baseline <= AWAY_GAP_MS) return null;
  return baseline;
}

// One-line human summary for the TUI header. Compact, dismissible upstream.
export function renderAwayLine(s: AwaySummary): string {
  const hrs = Math.round(s.gapMs / 3600_000);
  const bits: string[] = [];
  if (s.errors) {
    if (s.errors.newCount) bits.push(`${s.errors.newCount} new error${s.errors.newCount === 1 ? '' : 's'}`);
    if (s.errors.resolvedCount) bits.push(`${s.errors.resolvedCount} resolved`);
  }
  if (s.crashes) bits.push(`${s.crashes.total} crash${s.crashes.total === 1 ? '' : 'es'}`);
  if (s.env) bits.push(`${s.env.changes.length} env change${s.env.changes.length === 1 ? '' : 's'}`);
  return `while you were away (~${hrs}h): ${bits.join(' · ') || 'nothing notable'}`;
}
