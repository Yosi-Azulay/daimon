import { describe, expect, it } from 'vitest';
import {
  bucketizeTimeline,
  brushToRange,
  rangeToPct,
  moveFocusIndex,
  announceRow,
  filterTimelineRows,
  parseKindsParam,
  sessionWindow,
} from './timeline-page-helpers';

const KIND_LABEL: Record<string, string> = { status: 'status', error: 'error' };

describe('timeline-page helpers', () => {
  describe('bucketizeTimeline', () => {
    it('returns an empty model for no rows or a zero bucket count', () => {
      expect(bucketizeTimeline([], 10)).toEqual({ buckets: [], domainMin: 0, domainMax: 0 });
      expect(bucketizeTimeline([{ ts: 1, app: 'a', kind: 'status', summary: '' }], 0)).toEqual({ buckets: [], domainMin: 0, domainMax: 0 });
    });

    it('buckets rows evenly across their own [min,max] domain', () => {
      const rows = [
        { ts: 0, app: 'a', kind: 'status', summary: '' },
        { ts: 40, app: 'a', kind: 'status', summary: '' },
        { ts: 99, app: 'a', kind: 'status', summary: '' },
      ];
      const m = bucketizeTimeline(rows, 10);
      expect(m.domainMin).toBe(0);
      expect(m.domainMax).toBe(99);
      expect(m.buckets).toHaveLength(10);
      expect(m.buckets.reduce((s, b) => s + b.count, 0)).toBe(3);
      // ts=0 -> bucket 0; ts=99 -> last bucket (never overflows past length-1)
      expect(m.buckets[0].count).toBeGreaterThan(0);
      expect(m.buckets[9].count).toBeGreaterThan(0);
    });

    it('never divides by zero when every row shares one timestamp', () => {
      const rows = [{ ts: 500, app: 'a', kind: 'status', summary: '' }, { ts: 500, app: 'b', kind: 'error', summary: '' }];
      const m = bucketizeTimeline(rows, 4);
      expect(m.buckets.reduce((s, b) => s + b.count, 0)).toBe(2);
      expect(Number.isFinite(m.domainMax)).toBe(true);
    });
  });

  describe('brushToRange', () => {
    it('maps a pixel drag onto the time domain proportionally', () => {
      const r = brushToRange(0, 100, 100, 1000, 2000);
      expect(r).toEqual({ from: 1000, to: 2000 });
      const half = brushToRange(0, 50, 100, 1000, 2000);
      expect(half).toEqual({ from: 1000, to: 1500 });
    });

    it('normalizes a reversed drag (endX < startX)', () => {
      expect(brushToRange(80, 20, 100, 0, 1000)).toEqual({ from: 200, to: 800 });
    });

    it('treats a sub-3px drag as a click, not a brush', () => {
      expect(brushToRange(10, 11, 100, 0, 1000)).toBeNull();
    });

    it('returns null for a degenerate strip (no width or no domain span)', () => {
      expect(brushToRange(0, 50, 0, 0, 1000)).toBeNull();
      expect(brushToRange(0, 50, 100, 500, 500)).toBeNull();
    });
  });

  describe('rangeToPct', () => {
    it('expresses a range as clamped left%/width%', () => {
      expect(rangeToPct({ from: 250, to: 750 }, 0, 1000)).toEqual({ leftPct: 25, widthPct: 50 });
    });

    it('clamps a range that overhangs the domain', () => {
      const p = rangeToPct({ from: -100, to: 1500 }, 0, 1000);
      expect(p.leftPct).toBe(0);
      expect(p.widthPct).toBe(100);
    });
  });

  describe('moveFocusIndex', () => {
    it('home/end jump to the newest (0) and oldest (length-1) row', () => {
      expect(moveFocusIndex(3, 'home', 10)).toBe(0);
      expect(moveFocusIndex(3, 'end', 10)).toBe(9);
    });

    it('down moves toward older rows, up toward newer, both clamped', () => {
      expect(moveFocusIndex(0, 'down', 5)).toBe(1);
      expect(moveFocusIndex(4, 'down', 5)).toBe(4);
      expect(moveFocusIndex(4, 'up', 5)).toBe(3);
      expect(moveFocusIndex(0, 'up', 5)).toBe(0);
    });

    it('starts at index 0 from an unfocused (-1) state on any directional key', () => {
      expect(moveFocusIndex(-1, 'down', 5)).toBe(0);
      expect(moveFocusIndex(-1, 'up', 5)).toBe(0);
    });

    it('returns -1 for an empty list', () => {
      expect(moveFocusIndex(-1, 'down', 0)).toBe(-1);
    });
  });

  describe('announceRow', () => {
    it('formats "app · kind label · summary", falling back to the raw kind when unlabeled', () => {
      expect(announceRow({ ts: 1, app: 'web', kind: 'status', summary: 'now serving' }, KIND_LABEL))
        .toBe('web · status · now serving');
      expect(announceRow({ ts: 1, app: 'web', kind: 'mystery', summary: 'x' }, KIND_LABEL))
        .toBe('web · mystery · x');
    });
  });

  describe('parseKindsParam', () => {
    const all = ['status', 'error', 'warning'];
    it('parses a comma-separated preset filtered to known kinds', () => {
      expect(parseKindsParam('error,warning', all)).toEqual(new Set(['error', 'warning']));
    });
    it('drops unknown kinds but keeps the valid ones', () => {
      expect(parseKindsParam('error,bogus', all)).toEqual(new Set(['error']));
    });
    it('returns null (no override) when absent or entirely unknown', () => {
      expect(parseKindsParam(undefined, all)).toBeNull();
      expect(parseKindsParam(null, all)).toBeNull();
      expect(parseKindsParam('bogus', all)).toBeNull();
    });
  });

  describe('sessionWindow', () => {
    it('uses the session end as-is when closed', () => {
      expect(sessionWindow({ start: 100, end: 200 }, 999)).toEqual({ from: 100, to: 200 });
    });
    it('resolves a null (current/open) end to now', () => {
      expect(sessionWindow({ start: 100, end: null }, 999)).toEqual({ from: 100, to: 999 });
    });
  });

  // Workspace filtering (M177, v1.15): folded into the same filter pass as
  // kind/brush narrowing.
  describe('filterTimelineRows', () => {
    const rows = [
      { ts: 1, app: 'web', kind: 'status', summary: 'a' },
      { ts: 2, app: 'api', kind: 'status', summary: 'b' },
      { ts: 3, app: '__daemon__', kind: 'status', summary: 'daemon-start' },
      { ts: 4, app: '', kind: 'status', summary: 'no app' },
    ];
    const allKinds = new Set(['status', 'error']);

    it('null members -> no workspace filtering, only kind/brush apply', () => {
      const out = filterTimelineRows(rows, { kinds: allKinds, brush: null, members: null });
      expect(out).toHaveLength(4);
    });

    it('a member set drops rows for apps outside it, but keeps __daemon__ and app-less rows', () => {
      const out = filterTimelineRows(rows, { kinds: allKinds, brush: null, members: new Set(['web']) });
      expect(out.map(r => r.app)).toEqual(['web', '__daemon__', '']);
    });

    it('still applies the kind filter alongside workspace membership', () => {
      const out = filterTimelineRows(rows, { kinds: new Set(['error']), brush: null, members: new Set(['web']) });
      expect(out).toHaveLength(0);
    });

    it('still applies the brush range alongside workspace membership', () => {
      const out = filterTimelineRows(rows, { kinds: allKinds, brush: { from: 3, to: 4 }, members: new Set(['web']) });
      expect(out.map(r => r.app)).toEqual(['__daemon__', '']);
    });
  });
});
