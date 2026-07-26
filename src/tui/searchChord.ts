// Pure logic for the TUI search pane (M182, v1.16 "Recall").
//
// Same discipline as timelineChord.ts / logFilterChord.ts: everything the pane
// decides lives here as side-effect-free functions, so it unit-tests without
// ink or a terminal. The pane is a thin renderer over these.
//
// PARITY IS THE POINT: the TUI parses with the SAME `parseSearchQuery` the
// daemon uses and renders the SAME error text — there is no second grammar, no
// second error vocabulary, and no TUI-only query behaviour.

import type { SearchHit } from '../history.js';
import type { SavedSearch } from '../stateFile.js';

export type SearchMode = 'input' | 'results';

/** Where a hit's ref points. The v1.8 deep-link vocabulary, read back. */
export interface JumpTarget {
  kind: 'event' | 'log' | 'test' | 'errgroup' | 'unknown';
  id: string;
  app: string;
  ts: number;
  /** Which TUI surface answers this ref. */
  surface: 'timeline' | 'log' | 'detail';
}

/**
 * Decode a hit's stable ref into the surface that can show it.
 *
 * The mapping mirrors the dashboard's deep links: an event lands on its
 * timeline position, a log line lands in that app's log pane, and the v1.16
 * kinds (test runs, folded error groups) land on the app's detail pane, which
 * is where the TUI shows tests and errors. Unknown ref prefixes degrade to the
 * detail pane rather than throwing — a ref shape added by a newer daemon must
 * never crash an older TUI.
 */
export function jumpTargetFor(hit: SearchHit): JumpTarget {
  const idx = hit.ref.indexOf(':');
  const prefix = idx > 0 ? hit.ref.slice(0, idx) : hit.ref;
  const id = idx > 0 ? hit.ref.slice(idx + 1) : '';
  const base = { id, app: hit.app, ts: hit.ts };
  switch (prefix) {
    case 'event': return { ...base, kind: 'event', surface: 'timeline' };
    case 'log': return { ...base, kind: 'log', surface: 'log' };
    case 'test': return { ...base, kind: 'test', surface: 'detail' };
    case 'errgroup': return { ...base, kind: 'errgroup', surface: 'detail' };
    default: return { ...base, kind: 'unknown', surface: 'detail' };
  }
}

/** Clamp a selection into [0, len-1], or -1 when the list is empty. */
export function clampSel(i: number, len: number): number {
  if (len <= 0) return -1;
  return Math.max(0, Math.min(len - 1, i));
}

const KIND_LABEL: Record<string, string> = {
  logs: 'log', errors: 'err', events: 'evt', tests: 'test', 'error-groups': 'group',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.slice(0, 5);
}

/** hh:mm:ss of a timestamp, UTC — the timeline pane's convention. */
export function timeLabel(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/**
 * One result row, width-bounded so it can never overflow the terminal (the
 * v1.13 "a row overflowing 80 columns is a defect" rule). Newlines and control
 * characters in a captured log line are collapsed — a raw ANSI escape from a
 * dev server must not repaint the pane.
 */
export function formatHitRow(hit: SearchHit, cols: number): string {
  const width = Math.max(30, cols);
  const head = `${timeLabel(hit.ts)} ${kindLabel(hit.kind).padEnd(5)} ${(hit.app || '-').padEnd(12).slice(0, 12)} `;
  const room = Math.max(10, width - head.length);
  // Control characters as ESCAPES in source (M91), never literal bytes.
  const snip = (hit.snippet || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return head + (snip.length > room ? snip.slice(0, room - 1) + '…' : snip);
}

/** The saved-search rows shown under an EMPTY query input. */
export function savedRows(saved: SavedSearch[], cols: number): string[] {
  const width = Math.max(30, cols);
  // Stripped for the SAME reason formatHitRow strips: a saved query is
  // arbitrary user text, and an ESC sequence inside one repaints the pane when
  // the list is drawn.
  const clean = (t: string) => t.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return saved.map(s => {
    const head = `${clean(s.name).padEnd(18).slice(0, 18)}  `;
    const room = Math.max(10, width - head.length);
    const q = clean(s.query);
    return head + (q.length > room ? q.slice(0, room - 1) + '…' : q);
  });
}

/** Header summary: what came back, from which engine. */
export function resultSummary(hits: SearchHit[], fallback: boolean, facets?: Record<string, number>): string {
  if (!hits.length) return fallback ? 'no hits (index unavailable — searched the tables directly)' : 'no hits';
  const parts = facets
    ? Object.entries(facets).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${kindLabel(k)} ${n}`)
    : [];
  const counts = parts.length ? `  ${parts.join(' · ')}` : '';
  // Fallback is stated, never hidden: the same honesty the API's `fallback`
  // flag carries.
  return `${hits.length} hit${hits.length === 1 ? '' : 's'}${counts}${fallback ? '  (index unavailable — direct table scan)' : ''}`;
}
