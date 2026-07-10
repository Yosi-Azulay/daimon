// Pure helpers for the Report page (M83), extracted so they're unit-testable
// under Vitest without spinning up the Angular runtime.

export type ReportPeriod = '24h' | '7d' | 'custom';

// Mirrors the server's parseDuration (src/server.ts): an integer followed by
// an optional unit (ms|s|m|h|d, default ms). Used to validate the custom
// period input client-side before it's sent as `?since=`.
const DURATION_RE = /^\d+(ms|s|m|h|d)?$/;

export function isValidSince(raw: string): boolean {
  const s = raw.trim();
  return s.length > 0 && DURATION_RE.test(s);
}

// Resolves the period selection to the `since` query value sent to
// GET /api/report. Falls back to '24h' for an empty/invalid custom value so
// a bad input never sends a malformed request.
export function periodToSince(period: ReportPeriod, custom: string): string {
  if (period === '24h') return '24h';
  if (period === '7d') return '7d';
  return isValidSince(custom) ? custom.trim() : '24h';
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`;
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

// A section is "degraded" when the server composed a note instead of data
// (missing history, unknown app, empty window, or a caught error). Every
// report section follows this either/or shape — never a thrown error.
export function sectionNote(section: any): string | null {
  return section && typeof section.note === 'string' ? section.note : null;
}

export function shortCommit(msg: string | null | undefined): string {
  if (!msg) return '—';
  return msg.length > 72 ? msg.slice(0, 72) + '…' : msg;
}
