import { describe, it, expect } from 'vitest';
import {
  FIRST_RUN_DISMISS_KEY,
  readFirstRunDismissed,
  writeFirstRunDismissed,
  newlyAppearedApps,
  type StorageLike,
} from './first-run-helpers';

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
  };
}

describe('readFirstRunDismissed / writeFirstRunDismissed', () => {
  it('defaults to not dismissed', () => {
    expect(readFirstRunDismissed(fakeStorage())).toBe(false);
  });

  it('reflects a prior dismissal', () => {
    expect(readFirstRunDismissed(fakeStorage({ [FIRST_RUN_DISMISS_KEY]: '1' }))).toBe(true);
  });

  it('write then read round-trips', () => {
    const s = fakeStorage();
    writeFirstRunDismissed(s);
    expect(readFirstRunDismissed(s)).toBe(true);
  });

  it('never persists to any key but its own', () => {
    const s = fakeStorage();
    writeFirstRunDismissed(s);
    expect(Object.keys(s.data)).toEqual([FIRST_RUN_DISMISS_KEY]);
  });

  it('degrades to false (never throws) when storage.getItem throws', () => {
    const s: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => {} };
    expect(readFirstRunDismissed(s)).toBe(false);
  });

  it('is best-effort (never throws) when storage.setItem throws', () => {
    const s: StorageLike = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
    expect(() => writeFirstRunDismissed(s)).not.toThrow();
  });
});

describe('newlyAppearedApps', () => {
  it('returns names present now but not before', () => {
    expect(newlyAppearedApps([], ['web', 'api'])).toEqual(['web', 'api']);
  });

  it('excludes names that already existed', () => {
    expect(newlyAppearedApps(['web'], ['web', 'api'])).toEqual(['api']);
  });

  it('returns [] when nothing changed', () => {
    expect(newlyAppearedApps(['web', 'api'], ['web', 'api'])).toEqual([]);
  });

  it('does not report a disappearance as an appearance', () => {
    expect(newlyAppearedApps(['web', 'api'], ['web'])).toEqual([]);
  });
});
