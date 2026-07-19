// Pure helpers for the "While you were away" panel (M135, v1.8 "Rewind" —
// experimental). Reuses the M134 sessions list + the existing M83 report
// composition — no new endpoint, no new engine, no new timer (per the v1.8
// plan's standing decision). Extracted so the gap-detection and summary
// math are unit-testable without the Angular runtime.

import type { SessionSummary, Report } from './daimon-api';

// Fixed 4h threshold (v1.8 plan: "Zero new config keys... a constant,
// documented, revisited only on real demand").
export const AWAY_GAP_MS = 4 * 3600_000;

// The gap's start: the `end` of the most recent CLOSED session (skips the
// current, still-open one and any still-open end === null slice). `sessions`
// is expected newest-first (the API's own convention) but this scans
// defensively rather than assuming order.
export function findAwayBaseline(sessions: SessionSummary[]): number | null {
  let best: number | null = null;
  for (const s of sessions) {
    if (s.current || s.end == null) continue;
    if (best == null || s.end > best) best = s.end;
  }
  return best;
}

export function shouldShowAway(baseline: number | null, now = Date.now()): boolean {
  return baseline != null && now - baseline > AWAY_GAP_MS;
}

// localStorage key: scoped to the specific gap's baseline ts, so dismissing
// today's gap never suppresses a *different* future gap's summary.
export function awayDismissKey(baseline: number): string {
  return `daimon.awayDismissed.${baseline}`;
}

export interface AwaySummary {
  newErrors: number;
  resolvedErrors: number;
  crashes: number;
  envChanges: number;
}

// Pulls the away-relevant counts out of a `GET /api/report` response.
// Degraded sections (`{ note }`) and a null report both read as "nothing to
// report" for that field — never fabricated, matching every other report
// consumer's fail-soft convention. Returns null when every count is zero so
// the panel can render nothing rather than "0 events while you were away".
export function buildAwaySummary(report: Report | null): AwaySummary | null {
  const errors: any = report?.sections?.errors;
  const crashes: any = report?.sections?.crashes;
  const env: any = report?.sections?.env;
  const newErrors = typeof errors?.newCount === 'number' ? errors.newCount : 0;
  const resolvedErrors = typeof errors?.resolvedCount === 'number' ? errors.resolvedCount : 0;
  const crashCount = typeof crashes?.total === 'number' ? crashes.total : 0;
  const envChanges = Array.isArray(env?.changes) ? env.changes.length : 0;
  if (newErrors === 0 && resolvedErrors === 0 && crashCount === 0 && envChanges === 0) return null;
  return { newErrors, resolvedErrors, crashes: crashCount, envChanges };
}
