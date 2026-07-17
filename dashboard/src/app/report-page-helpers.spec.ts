import { describe, expect, it } from 'vitest';
import {
  fmtAgo,
  fmtDuration,
  fmtLogVolumeLine,
  fmtPct,
  isValidSince,
  periodToSince,
  sectionNote,
  shortCommit,
} from './report-page-helpers';

describe('report-page-helpers', () => {
  describe('isValidSince / periodToSince', () => {
    it('accepts an integer with an optional unit, rejects garbage', () => {
      expect(isValidSince('3d')).toBe(true);
      expect(isValidSince('90m')).toBe(true);
      expect(isValidSince('12345')).toBe(true);
      expect(isValidSince('')).toBe(false);
      expect(isValidSince('3 days')).toBe(false);
      expect(isValidSince('abc')).toBe(false);
    });

    it('resolves the fixed periods directly and falls back to 24h for an invalid custom value', () => {
      expect(periodToSince('24h', 'whatever')).toBe('24h');
      expect(periodToSince('7d', 'whatever')).toBe('7d');
      expect(periodToSince('custom', '3d')).toBe('3d');
      expect(periodToSince('custom', 'nonsense')).toBe('24h');
    });
  });

  describe('fmtDuration / fmtPct / fmtAgo / shortCommit', () => {
    it('fmtDuration switches from ms to seconds at 1000ms and dashes null', () => {
      expect(fmtDuration(500)).toBe('500ms');
      expect(fmtDuration(1500)).toBe('1.5s');
      expect(fmtDuration(null)).toBe('—');
      expect(fmtDuration(undefined)).toBe('—');
    });

    it('fmtPct dashes null/undefined', () => {
      expect(fmtPct(42)).toBe('42%');
      expect(fmtPct(null)).toBe('—');
    });

    it('fmtAgo buckets relative time', () => {
      const now = 1_000_000;
      expect(fmtAgo(now - 30_000, now)).toBe('30s ago');
      expect(fmtAgo(now - 4 * 3_600_000, now)).toBe('4h ago');
    });

    it('shortCommit truncates long messages and dashes empty input', () => {
      expect(shortCommit(null)).toBe('—');
      expect(shortCommit('short message')).toBe('short message');
      const long = 'x'.repeat(100);
      expect(shortCommit(long)).toBe('x'.repeat(72) + '…');
    });
  });

  describe('sectionNote', () => {
    it('extracts the note string from a degraded section', () => {
      expect(sectionNote({ note: 'no data in the window' })).toBe('no data in the window');
    });

    it('returns null for a data section or a missing/null section', () => {
      expect(sectionNote({ total: 5 })).toBe(null);
      expect(sectionNote(null)).toBe(null);
      expect(sectionNote(undefined)).toBe(null);
    });
  });

  describe('fmtLogVolumeLine (M103)', () => {
    it('formats the counts/share/storms line', () => {
      expect(fmtLogVolumeLine({ totalLines: 1200, errorLines: 36, errorSharePct: 3, storms: 2 })).toBe(
        '1200 lines · 3% error-level · 2 storms',
      );
    });

    it('singularizes "line"/"storm" at exactly 1', () => {
      expect(fmtLogVolumeLine({ totalLines: 1, errorLines: 1, errorSharePct: 100, storms: 1 })).toBe(
        '1 line · 100% error-level · 1 storm',
      );
    });

    it('the degraded case is read via the shared sectionNote(), not a dedicated helper', () => {
      expect(sectionNote({ note: 'no log lines in the window' })).toBe('no log lines in the window');
    });
  });
});
