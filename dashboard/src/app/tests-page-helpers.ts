// Pure helpers extracted from tests-page so they're unit-testable under Vitest
// without spinning up the Angular runtime.

export interface ParsedSummary {
  passed?: number;
  failed?: number;
  total?: number;
  suites?: number;
  durationMs?: number;
  framework?: string;
  failedTests?: { name: string; file?: string; line?: number }[];
}

export interface MinimalRun {
  ts: number;
  exit_code: number | null;
  duration_ms: number | null;
  summary: string | null;
}

export function parseSummary(s: string | null): ParsedSummary | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function vscodeUri(file: string, line?: number): string {
  const enc = encodeURI(file.replace(/\\/g, '/'));
  return `vscode://file/${enc}${typeof line === 'number' ? `:${line}` : ''}`;
}

export function summaryLabel(latest: MinimalRun | null, parsed: ParsedSummary | null): string {
  if (!parsed) return latest ? `exit ${latest.exit_code ?? '?'}` : 'no runs';
  const total = parsed.total ?? ((parsed.passed ?? 0) + (parsed.failed ?? 0));
  return `${parsed.passed ?? 0}/${total}${(parsed.failed ?? 0) > 0 ? ` · ${parsed.failed} failed` : ''}`;
}

export function pillKindFor(latest: MinimalRun | null, parsed: ParsedSummary | null): 'ok' | 'fail' | 'neutral' {
  if (!latest) return 'neutral';
  if ((parsed?.failed ?? 0) > 0 || latest.exit_code !== 0) return 'fail';
  return 'ok';
}
