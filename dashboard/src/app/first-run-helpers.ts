// Pure helpers for the first-run walkthrough card (M169, v1.14). Extracted so
// the dismiss-state and new-app-detection logic is unit-tested under Vitest
// without the Angular runtime, same convention as home-page-helpers.ts.
//
// PRIVACY: dismissal is LOCAL-ONLY. `FIRST_RUN_DISMISS_KEY` lives in
// localStorage exclusively — it is never sent to the server, never becomes a
// config key, and there is no telemetry anywhere in this file. A blocked or
// unavailable localStorage (private browsing, quota) degrades to "always show
// the card" rather than throwing.
export const FIRST_RUN_DISMISS_KEY = 'daimon.firstRun.dismissed';

// Minimal shape a caller needs from Storage — makes the read/write testable
// without touching real localStorage.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readFirstRunDismissed(storage: StorageLike): boolean {
  try { return storage.getItem(FIRST_RUN_DISMISS_KEY) === '1'; } catch { return false; }
}

export function writeFirstRunDismissed(storage: StorageLike): void {
  try { storage.setItem(FIRST_RUN_DISMISS_KEY, '1'); } catch { /* best-effort — card just reappears next visit */ }
}

// Add-app success state (M169): once the walkthrough has been shown for an
// empty apps list, the first apps to appear afterward get a one-shot
// highlight on their card so `daimon init` + `daimon daemon start` visibly
// "worked" instead of the list just silently populating. Pure set-diff so the
// component only needs to feed it two name lists.
export function newlyAppearedApps(prevNames: readonly string[], curNames: readonly string[]): string[] {
  const prev = new Set(prevNames);
  return curNames.filter(n => !prev.has(n));
}
