import { describe, expect, it } from 'vitest';
import {
  buildTextPredicate,
  countsByLevel,
  formatStormBanner,
  matchesLevel,
  searchPrefillQuery,
  stormBannerVisible,
  toggleLevel,
  type LogLevel,
} from './logs-page-helpers';

function row(level: LogLevel | null) {
  return { level };
}

describe('logs-page-helpers', () => {
  describe('countsByLevel', () => {
    it('counts each classified level and ignores unclassified (null) lines', () => {
      const rows = [row('error'), row('error'), row('warn'), row('info'), row('debug'), row(null), row(null)];
      expect(countsByLevel(rows)).toEqual({ error: 2, warn: 1, info: 1, debug: 1 });
    });

    it('returns all-zero counts for an empty buffer', () => {
      expect(countsByLevel([])).toEqual({ error: 0, warn: 0, info: 0, debug: 0 });
    });
  });

  describe('toggleLevel', () => {
    it('selects a level when none is active', () => {
      expect(toggleLevel(null, 'error')).toBe('error');
    });

    it('clears the filter when the active chip is clicked again', () => {
      expect(toggleLevel('error', 'error')).toBe(null);
    });

    it('switches to a different level without needing to clear first', () => {
      expect(toggleLevel('error', 'warn')).toBe('warn');
    });
  });

  describe('matchesLevel', () => {
    it('matches everything when no filter is active', () => {
      expect(matchesLevel('error', null)).toBe(true);
      expect(matchesLevel(null, null)).toBe(true);
    });

    it('excludes unclassified lines while a level filter is active', () => {
      expect(matchesLevel(null, 'error')).toBe(false);
    });

    it('only matches the exact selected level', () => {
      expect(matchesLevel('error', 'error')).toBe(true);
      expect(matchesLevel('warn', 'error')).toBe(false);
    });
  });

  describe('buildTextPredicate', () => {
    it('returns a no-op predicate for an empty filter', () => {
      const { pred, error } = buildTextPredicate('', false);
      expect(pred).toBe(null);
      expect(error).toBe(null);
    });

    it('substring mode is case-insensitive', () => {
      const { pred } = buildTextPredicate('BOOM', false);
      expect(pred!('a boom happened')).toBe(true);
      expect(pred!('all quiet')).toBe(false);
    });

    it('regex mode compiles and matches case-insensitively', () => {
      const { pred, error } = buildTextPredicate('err(or)?', true);
      expect(error).toBe(null);
      expect(pred!('ERROR: boom')).toBe(true);
      expect(pred!('all fine')).toBe(false);
    });

    it('an invalid regex falls back to no filter and surfaces an error, never throwing', () => {
      const { pred, error } = buildTextPredicate('(unterminated', true);
      expect(pred).toBe(null);
      expect(error).toBeTruthy();
    });
  });

  describe('formatStormBanner', () => {
    it('rounds both rates into the banner copy', () => {
      expect(formatStormBanner({ observedPerMin: 142.7, baselinePerMin: 12.3 })).toBe(
        'Log storm: 143 lines/min vs baseline 12',
      );
    });

    it('renders an em dash when no baseline has accumulated yet', () => {
      expect(formatStormBanner({ observedPerMin: 80, baselinePerMin: null })).toBe(
        'Log storm: 80 lines/min vs baseline —',
      );
    });
  });

  describe('stormBannerVisible', () => {
    it('is hidden when there is no active storm', () => {
      expect(stormBannerVisible(null, null)).toBe(false);
      expect(stormBannerVisible(undefined, 5)).toBe(false);
    });

    it('shows an active storm that has never been dismissed', () => {
      expect(stormBannerVisible({ since: 100 }, null)).toBe(true);
    });

    it('stays hidden once dismissed for that exact episode', () => {
      expect(stormBannerVisible({ since: 100 }, 100)).toBe(false);
    });

    it('re-shows for a NEW episode even if a previous one was dismissed', () => {
      expect(stormBannerVisible({ since: 200 }, 100)).toBe(true);
    });
  });

  describe('searchPrefillQuery', () => {
    it('prefixes trimmed filter text with the search-mode trigger', () => {
      expect(searchPrefillQuery('  ECONNREFUSED  ')).toBe('> ECONNREFUSED');
    });

    it('opens a bare search mode for an empty/whitespace-only filter', () => {
      expect(searchPrefillQuery('')).toBe('>');
      expect(searchPrefillQuery('   ')).toBe('>');
    });
  });
});
