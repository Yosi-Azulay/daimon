// Pure layout + status-bar geometry for the TUI (v1.13 "Terminal Native",
// M162 + M166). Every decision that depends only on the terminal's size lives
// here — pane widths, which app-list columns survive a narrow terminal, the
// scroll window for a long app list, and the status-bar segments — so all of it
// unit-tests without ink or a real terminal (the ribbon.ts / chords.ts pattern).
//
// Two rules this module encodes:
//   * 80 columns is a FIRST-CLASS width, not a degraded one. Columns drop in a
//     fixed priority order (cpu/mem first — exactly the `cols >= 100` guard the
//     TUI already shipped) so nothing ever wraps into garbage. Below 60 columns
//     the layout collapses to a single pane rather than corrupting two.
//   * The app list is WINDOWED. A 100-app registry renders one viewport, not
//     100 rows, and the selection is always inside it.

export type LayoutMode = 'full' | 'narrow' | 'minimal';

export type PaneName = 'list' | 'detail' | 'log';

export interface ListColumns {
  status: boolean;   // never dropped — the reason the row exists
  health: boolean;
  port: boolean;
  badge: boolean;    // framework badge, e.g. [next]
  cpu: boolean;      // cpu% + memMB pair
  ribbon: boolean;   // the per-app sparkline row
}

export interface Layout {
  mode: LayoutMode;
  cols: number;
  rows: number;
  leftWidth: number;
  /** Which panes render at all. In `minimal` only the focused pane does. */
  showList: boolean;
  showDetail: boolean;
  showLog: boolean;
  /** Rows available to the app list / the log pane's line area. */
  listRows: number;
  logRows: number;
  /** Width the app-name cell is padded to. */
  nameWidth: number;
  columns: ListColumns;
}

// Width thresholds. `NARROW_COLS` is the historical cpu/mem cutoff (the TUI has
// hidden those two columns below 100 columns since v0.x — keeping the exact
// number keeps every existing terminal looking identical).
export const NARROW_COLS = 100;
export const BADGE_MIN_COLS = 80;
export const MINIMAL_COLS = 60;

// Chrome the panes cannot use: header line, status bar, footer hint, and the
// single-line borders above/below the pane row.
const CHROME_ROWS = 6;
const MIN_PANE_ROWS = 3;

export function computeLayout(
  cols: number,
  rows: number,
  focused: PaneName = 'list',
  maximized = false,
): Layout {
  const c = Math.max(20, Math.floor(cols) || 100);
  const r = Math.max(8, Math.floor(rows) || 30);

  const mode: LayoutMode = c < MINIMAL_COLS ? 'minimal' : c < NARROW_COLS ? 'narrow' : 'full';

  const columns: ListColumns = {
    status: true,
    health: true,
    port: true,
    badge: c >= BADGE_MIN_COLS,
    cpu: c >= NARROW_COLS,
    ribbon: mode !== 'minimal',
  };

  // Maximizing the log gives it every row the panes had.
  const bodyRows = Math.max(MIN_PANE_ROWS, r - CHROME_ROWS);

  if (maximized) {
    return {
      mode, cols: c, rows: r,
      leftWidth: 0,
      showList: false, showDetail: false, showLog: true,
      listRows: 0,
      logRows: bodyRows,
      nameWidth: nameWidthFor(c, mode),
      columns,
    };
  }

  // Minimal: one pane at a time — the focused one. Two bordered boxes below 60
  // columns leaves ~26 usable columns each, which is where rows start wrapping.
  if (mode === 'minimal') {
    return {
      mode, cols: c, rows: r,
      leftWidth: c,
      showList: focused === 'list',
      showDetail: focused === 'detail',
      showLog: focused === 'log',
      listRows: bodyRows,
      logRows: bodyRows,
      nameWidth: nameWidthFor(c, mode),
      columns,
    };
  }

  // The list pane takes 40% up to a 36-column ceiling — the historical rule.
  const leftWidth = Math.min(36, Math.floor(c * 0.4));
  // The right column splits between detail and log; the log gets the remainder
  // and never less than MIN_PANE_ROWS.
  const logRows = Math.max(MIN_PANE_ROWS, Math.floor(bodyRows * 0.45));

  return {
    mode, cols: c, rows: r,
    leftWidth,
    showList: true, showDetail: true, showLog: true,
    listRows: bodyRows,
    logRows,
    nameWidth: nameWidthFor(c, mode),
    columns,
  };
}

function nameWidthFor(cols: number, mode: LayoutMode): number {
  if (mode === 'minimal') return Math.max(8, Math.min(20, cols - 18));
  return 20;
}

// ── windowed list scrolling (M166) ────────────────────────────────────────────

export interface Window { start: number; end: number }

// The slice of a `total`-long list to render so that `selected` is visible in a
// `viewport`-row window. Keeps the selection off the very edge where possible
// so there is always context to scroll into.
export function windowSlice(total: number, selected: number, viewport: number): Window {
  const vp = Math.max(1, Math.floor(viewport));
  if (total <= vp) return { start: 0, end: total };
  const sel = Math.max(0, Math.min(total - 1, selected));
  // Center-ish: keep one row of lead-in above the selection when scrolled.
  let start = sel - Math.floor(vp / 2);
  start = Math.max(0, Math.min(total - vp, start));
  return { start, end: start + vp };
}

// `3/40` style position indicator for the pane title. Empty list renders 0/0.
export function positionLabel(selected: number, total: number): string {
  if (total <= 0) return '0/0';
  return `${Math.max(0, Math.min(total - 1, selected)) + 1}/${total}`;
}

// ── status bar (M162) ─────────────────────────────────────────────────────────

// A tone, not a color — App maps these onto theme roles so this module stays
// free of any palette knowledge.
export type Tone = 'normal' | 'muted' | 'accent' | 'warn' | 'danger' | 'good';

export interface Segment { text: string; tone: Tone }

export interface StatusBarInput {
  apiPort: number;
  /** false when the registry reports no healthy apps but some are erroring. */
  degraded?: boolean;
  workspace: string | null;
  nameFilter: string;
  tagFilter: string[];
  groupFilter: string | null;
  /**
   * Active workspace FILTER (M173, v1.15) — this TUI's own, client-side by
   * design; never daemon state. Distinct from `workspace` (the selected app's
   * label). Optional so pre-v1.15 callers/tests stay valid.
   */
  wsFilter?: string | null;
  mutedCount: number;
  stormCount: number;
  appCount: number;
  visibleCount: number;
  flash?: string | null;
}

// The persistent one-line status bar: daemon state, workspace, active filters,
// muted count, storms, and the transient flash message folded in as the last
// segment (so a flash never displaces the permanent state).
export function statusSegments(i: StatusBarInput): Segment[] {
  const segs: Segment[] = [];
  segs.push({ text: `daimon :${i.apiPort}`, tone: i.degraded ? 'warn' : 'good' });
  if (i.degraded) segs.push({ text: 'degraded', tone: 'warn' });

  if (i.workspace) segs.push({ text: i.workspace, tone: 'muted' });

  const filters: string[] = [];
  if (i.nameFilter.trim()) filters.push(`/${i.nameFilter.trim()}`);
  if (i.tagFilter.length) filters.push(`tags:${i.tagFilter.join(',')}`);
  if (i.groupFilter) filters.push(`group:${i.groupFilter}`);
  if (i.wsFilter) filters.push(`ws:${i.wsFilter}`);
  if (filters.length) {
    segs.push({ text: filters.join(' '), tone: 'accent' });
    segs.push({ text: `${i.visibleCount}/${i.appCount}`, tone: 'muted' });
  } else {
    segs.push({ text: `${i.appCount} app${i.appCount === 1 ? '' : 's'}`, tone: 'muted' });
  }

  if (i.mutedCount > 0) segs.push({ text: `muted:${i.mutedCount}`, tone: 'muted' });
  if (i.stormCount > 0) segs.push({ text: `⚡storm:${i.stormCount}`, tone: 'warn' });
  if (i.flash) segs.push({ text: i.flash, tone: 'accent' });
  return segs;
}

// Render segments to a single line, truncated to `cols` so the bar can never
// wrap and push the layout down a row.
export function renderStatusLine(segs: Segment[], cols: number, sep = ' · '): string {
  const line = segs.map(s => s.text).join(sep);
  if (cols > 0 && line.length > cols) return line.slice(0, Math.max(0, cols - 1)) + '…';
  return line;
}
