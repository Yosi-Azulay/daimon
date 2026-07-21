// The TUI's re-render policy (v1.13 "Terminal Native", M166) as pure data, so
// the budget is asserted by a test instead of being an aspiration in a comment.
//
// THE PROBLEM v1.13 FIXED: every TUI through v1.12 ran an unconditional 1-second
// interval that called setApps + setEvents + setTick — a full re-render of the
// whole component tree once a second, forever, whether or not one byte of state
// had changed. On an idle registry that is 60 wasted full-tree renders a minute,
// and it is what made the pane flicker on slower terminals and over SSH.
//
// THE FIX: the registry ALREADY emits 'change' and 'event'. Those drive the
// updates now, so a render happens when something actually happened. The only
// remaining timer is a slow tick whose sole job is re-rendering DERIVED CLOCK
// values (uptime, "3m ago") that no event announces — nothing else depends on
// it, so it can be slow.
//
// The trade the slow tick makes: an app's uptime advances in IDLE_TICK_MS steps
// instead of per-second. That is invisible for the minutes-to-hours uptimes the
// pane actually shows, and it costs 5× fewer idle renders.

/** What v1.12 and every release before it shipped — the number to beat. */
export const LEGACY_TICK_MS = 1000;

/** The slow clock-refresh tick. The ONLY interval left in the TUI. */
export const IDLE_TICK_MS = 5000;

/** Full-tree re-renders per minute from the timer alone, on a fully idle registry. */
export function idleRendersPerMinute(tickMs: number = IDLE_TICK_MS): number {
  if (tickMs <= 0) return Infinity;
  return 60_000 / tickMs;
}

/**
 * The budget: idle timer-driven re-renders per minute. Asserted by
 * test/tui-render-budget.test.mjs against the constant the TUI actually uses,
 * so lowering the tick back toward 1s fails the suite rather than silently
 * regressing the flicker fix.
 */
export const IDLE_RENDER_BUDGET_PER_MIN = 12;

export function withinIdleBudget(tickMs: number = IDLE_TICK_MS): boolean {
  return idleRendersPerMinute(tickMs) <= IDLE_RENDER_BUDGET_PER_MIN;
}
