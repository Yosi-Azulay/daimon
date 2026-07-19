import { describe, expect, it } from 'vitest';
import {
  AWAY_GAP_MS,
  findAwayBaseline,
  shouldShowAway,
  awayDismissKey,
  buildAwaySummary,
} from './away-panel-helpers';
import type { SessionSummary } from './daimon-api';

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1', start: 0, end: 1000, durationMs: 1000, endedCleanly: true, current: false,
    apps: [], errorCount: 0, testRunCount: 0, compileCount: 0, ...over,
  };
}

describe('away-panel helpers', () => {
  describe('findAwayBaseline', () => {
    it('skips the current (open) session and picks the most recent closed end', () => {
      const sessions = [
        session({ id: 's-3', current: true, end: null }),
        session({ id: 's-2', end: 5000 }),
        session({ id: 's-1', end: 1000 }),
      ];
      expect(findAwayBaseline(sessions)).toBe(5000);
    });

    it('returns null when there is no prior closed session', () => {
      expect(findAwayBaseline([session({ current: true, end: null })])).toBeNull();
      expect(findAwayBaseline([])).toBeNull();
    });

    it('is order-independent (scans all sessions, not just the first)', () => {
      const sessions = [session({ end: 1000 }), session({ end: 9000 }), session({ end: 3000 })];
      expect(findAwayBaseline(sessions)).toBe(9000);
    });
  });

  describe('shouldShowAway', () => {
    it('is false for a null baseline or a gap under the 4h threshold', () => {
      expect(shouldShowAway(null)).toBe(false);
      const now = 10_000_000;
      expect(shouldShowAway(now - (AWAY_GAP_MS - 1), now)).toBe(false);
    });

    it('is true once the gap exceeds 4h', () => {
      const now = 10_000_000;
      expect(shouldShowAway(now - (AWAY_GAP_MS + 1), now)).toBe(true);
    });
  });

  describe('awayDismissKey', () => {
    it('scopes the dismissal to the specific gap baseline', () => {
      expect(awayDismissKey(12345)).toBe('daimon.awayDismissed.12345');
      expect(awayDismissKey(1)).not.toBe(awayDismissKey(2));
    });
  });

  describe('buildAwaySummary', () => {
    it('extracts counts from a live report', () => {
      const report: any = {
        sections: {
          errors: { newCount: 3, resolvedCount: 1 },
          crashes: { total: 2 },
          env: { changes: [{ app: 'web', key: 'FOO' }] },
        },
      };
      expect(buildAwaySummary(report)).toEqual({ newErrors: 3, resolvedErrors: 1, crashes: 2, envChanges: 1 });
    });

    it('treats degraded ({ note }) sections and a null report as zero, never fabricated', () => {
      expect(buildAwaySummary(null)).toBeNull();
      const report: any = { sections: { errors: { note: 'x' }, crashes: { note: 'x' }, env: { note: 'x' } } };
      expect(buildAwaySummary(report)).toBeNull();
    });

    it('returns null when every count is zero (no "0 events" noise)', () => {
      const report: any = { sections: { errors: { newCount: 0, resolvedCount: 0 }, crashes: { total: 0 }, env: { changes: [] } } };
      expect(buildAwaySummary(report)).toBeNull();
    });

    it('returns a summary when only one field is non-zero', () => {
      const report: any = { sections: { crashes: { total: 1 } } };
      expect(buildAwaySummary(report)).toEqual({ newErrors: 0, resolvedErrors: 0, crashes: 1, envChanges: 0 });
    });
  });
});
