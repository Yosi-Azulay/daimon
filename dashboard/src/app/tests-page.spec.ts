import { describe, expect, it } from 'vitest';
import { parseSummary, vscodeUri, summaryLabel, pillKindFor } from './tests-page-helpers';

describe('tests-page helpers', () => {
  it('parseSummary returns null on null/invalid', () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary('not json')).toBeNull();
  });

  it('parseSummary round-trips a structured summary', () => {
    const s = parseSummary('{"passed":12,"failed":1,"total":13,"framework":"jest"}');
    expect(s?.passed).toBe(12);
    expect(s?.failed).toBe(1);
    expect(s?.framework).toBe('jest');
  });

  it('vscodeUri normalizes Windows paths and appends line number', () => {
    expect(vscodeUri('src\\foo\\bar.ts', 42)).toBe('vscode://file/src/foo/bar.ts:42');
    expect(vscodeUri('src/baz.ts')).toBe('vscode://file/src/baz.ts');
  });

  it('summaryLabel formats passed/total and failure tail', () => {
    expect(summaryLabel({ ts: 0, exit_code: 0, duration_ms: 0, summary: null }, { passed: 10, failed: 0, total: 10 })).toBe('10/10');
    expect(summaryLabel({ ts: 0, exit_code: 1, duration_ms: 0, summary: null }, { passed: 8, failed: 2, total: 10 })).toBe('8/10 · 2 failed');
    expect(summaryLabel({ ts: 0, exit_code: 1, duration_ms: 0, summary: null }, null)).toBe('exit 1');
    expect(summaryLabel(null, null)).toBe('no runs');
  });

  it('pillKindFor returns fail when any failures or non-zero exit', () => {
    expect(pillKindFor({ ts: 0, exit_code: 0, duration_ms: 0, summary: null }, { passed: 10, failed: 0, total: 10 })).toBe('ok');
    expect(pillKindFor({ ts: 0, exit_code: 0, duration_ms: 0, summary: null }, { passed: 8, failed: 2, total: 10 })).toBe('fail');
    expect(pillKindFor({ ts: 0, exit_code: 1, duration_ms: 0, summary: null }, null)).toBe('fail');
    expect(pillKindFor(null, null)).toBe('neutral');
  });
});
