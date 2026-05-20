import type { AppEvent } from '../types.js';

export const RIBBON_BUCKETS = 20;
export const RIBBON_WINDOW_MS = 60 * 60 * 1000;

const RANKS: Record<string, number> = { stopped: 1, serving: 2, compiling: 3, starting: 3, error: 4 };
const GLYPHS: Record<string, string> = { '': '·', stopped: '░', serving: '▓', compiling: '▒', starting: '▒', error: '█' };

export function computeRibbon(events: AppEvent[], appName: string, now = Date.now()): string[] {
  const cutoff = now - RIBBON_WINDOW_MS;
  const bucketMs = RIBBON_WINDOW_MS / RIBBON_BUCKETS;
  const arr = new Array<string>(RIBBON_BUCKETS).fill('');
  for (const ev of events) {
    if (ev.type !== 'status' || ev.app !== appName || !ev.to) continue;
    if (ev.ts < cutoff || ev.ts > now) continue;
    const idx = Math.min(RIBBON_BUCKETS - 1, Math.floor((ev.ts - cutoff) / bucketMs));
    const prev = arr[idx];
    if (!prev || (RANKS[ev.to] ?? 0) > (RANKS[prev] ?? 0)) arr[idx] = ev.to;
  }
  return arr;
}

export function renderRibbon(ticks: string[]): string {
  return ticks.map(t => GLYPHS[t] ?? '·').join('');
}

export function ribbonLegend(): string {
  return 'srv·err·cmp·stp';
}

export function ribbonCounts(ticks: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ticks) if (t) out[t] = (out[t] ?? 0) + 1;
  return out;
}
