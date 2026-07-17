import { describe, expect, it } from 'vitest';
import { hasResourceNote } from './app-detail-helpers';

describe('app-detail helpers', () => {
  it('hasResourceNote hides the Why panel resource note when null/undefined/blank (M109)', () => {
    expect(hasResourceNote(null)).toBe(false);
    expect(hasResourceNote(undefined)).toBe(false);
    expect(hasResourceNote('')).toBe(false);
    expect(hasResourceNote('   ')).toBe(false);
  });

  it('hasResourceNote shows the note when the server supplies a sentence', () => {
    expect(hasResourceNote('RSS grew from 200MB to 620MB (3.1x baseline) over the ~40 min before this crash.')).toBe(true);
  });
});
