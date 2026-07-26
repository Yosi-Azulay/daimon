// The ONE source of truth for every TUI chord (v1.13 "Terminal Native", M163).
// Dispatch, the `?` help overlay, per-pane footer hints, the generated docs
// cheat sheet, and the README table all render from this data — a chord
// hand-listed on any of those surfaces fails test/tui-chords.test.mjs. Pure
// data + pure resolvers: no ink, no React, so it unit-tests without a terminal
// (the ribbon.ts / testChord.ts / logFilterChord.ts pattern).
//
// MUSCLE MEMORY IS SACRED (v1.13 locked rule): every key here worked in v1.12
// and still does — same key, same meaning. Chords are PANE-SCOPED: the same
// physical key can mean two things in two panes, and that coexistence predates
// this release —
//   `l` focuses the log pane from the list, cycles the log LEVEL inside it;
//   `/` filters the app list, greps inside the log pane;
//   `g`/`G` are the view-hint / group-filter chords in the list, but scroll to
//        top / bottom (and resume follow) inside the log pane.
// The pane scope is how they never collide. A remap is allowed ONLY with a
// permanent legacy alias (old key kept forever) listed in the release notes;
// v1.13 introduces none.

// `grep` is a MODAL scope: it is live only while the log pane's search input is
// open, which is why its Tab/Enter/Esc do not collide with the Tab that cycles
// panes. Modal scopes are dispatched from their own branch, not the pane table.
export type Pane = 'list' | 'detail' | 'log' | 'timeline' | 'attach' | 'grep' | 'search';

// Overlay/docs grouping. `global` chords work in every main-app pane.
export type ChordGroup =
  | 'global' | 'nav' | 'lifecycle' | 'inspect' | 'filter' | 'log' | 'timeline' | 'attach' | 'grep' | 'search';

// A physical trigger. `ch` matches ink's `input` (CASE-SENSITIVE, so 'L' ≠ 'l');
// `special` matches one of ink's `key.<name>` booleans; `ctrl` requires Ctrl.
export type Special =
  | 'upArrow' | 'downArrow' | 'leftArrow' | 'rightArrow'
  | 'pageUp' | 'pageDown' | 'tab' | 'return' | 'escape';

export interface Trigger { ch?: string; special?: Special; ctrl?: boolean; }

// The subset of ink's `key` object the resolver reads. ink's real key object is
// a superset with exactly these names, so it can be passed straight through.
export interface KeyState {
  upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean;
  pageUp?: boolean; pageDown?: boolean; tab?: boolean; return?: boolean;
  escape?: boolean; ctrl?: boolean;
}

// Every chord id — an explicit union so `Record<ChordId, Handler>` at the
// dispatch site is exhaustiveness-checked by tsc (a missing or unknown handler
// fails the build), and test/tui-chords.test.mjs asserts each id appears once.
export type ChordId =
  // global (all main-app panes)
  | 'help' | 'nextPane' | 'maximizeLog' | 'timeline' | 'quit'
  // navigation
  | 'move'
  // lifecycle (list + detail)
  | 'start' | 'stop' | 'restart' | 'focus' | 'tryFix' | 'test' | 'orchestrate'
  // inspect (list + detail)
  | 'openUrl' | 'edit' | 'envFile' | 'editor' | 'logFocus' | 'searchOpen'
  // filter (list + detail)
  | 'filter' | 'tagFilter' | 'groupFilter' | 'wsFilter' | 'viewHint'
  // log pane
  | 'levelCycle' | 'grep' | 'grepNext' | 'grepPrev'
  | 'logTop' | 'logBottom' | 'logScroll' | 'logPage'
  // timeline modal
  | 'tlMove' | 'tlEdges' | 'tlDrill' | 'tlJump' | 'tlBack'
  // grep input (modal, only while the log search box is open)
  | 'grepMode' | 'grepKeep' | 'grepClear'
  // search modal (M182, v1.16) — live only while the search pane is open
  | 'seRun' | 'seMove' | 'seEdit' | 'seClose'
  // attach surface
  | 'atMove' | 'atToggle' | 'atStart' | 'atStop' | 'atRestart' | 'atDetach';

export interface ChordDef {
  id: ChordId;
  key: string;              // display form, e.g. 'j/k · ↑/↓', 'Shift+L', 'PgUp/PgDn'
  triggers: Trigger[];      // any match fires the chord
  panes: Pane[];            // panes/surfaces this chord is live in
  group: ChordGroup;
  label: string;            // short footer label
  desc: string;             // full overlay / docs description
  footer?: boolean;         // include in the focused-pane footer hint
  legacy?: string;          // permanent legacy-alias note for the release log (v1.13: none)
}

// Convenience trigger builders keep the table readable.
const ch = (c: string): Trigger => ({ ch: c });
const sp = (s: Special): Trigger => ({ special: s });

export const CHORDS: readonly ChordDef[] = [
  // ── global ────────────────────────────────────────────────────────────────
  { id: 'help', key: '?', triggers: [ch('?')], panes: ['list', 'detail', 'log'],
    group: 'global', label: 'help', desc: 'open this help overlay', footer: true },
  { id: 'nextPane', key: 'Tab', triggers: [sp('tab')], panes: ['list', 'detail', 'log'],
    group: 'global', label: 'pane', desc: 'cycle focus: list → detail → log', footer: true },
  { id: 'maximizeLog', key: 'Shift+L', triggers: [ch('L')], panes: ['list', 'detail', 'log'],
    group: 'global', label: 'max log', desc: 'maximize / restore the log pane full-screen' },
  { id: 'timeline', key: 'i', triggers: [ch('i')], panes: ['list', 'detail'],
    group: 'global', label: 'timeline', desc: 'open the history timeline' },
  { id: 'quit', key: 'q', triggers: [ch('q'), { ch: 'c', ctrl: true }], panes: ['list', 'detail', 'log'],
    group: 'global', label: 'quit', desc: 'quit the TUI (the daemon keeps running)', footer: true },

  // ── navigation ────────────────────────────────────────────────────────────
  { id: 'move', key: 'j/k · ↑/↓', triggers: [ch('j'), ch('k'), sp('upArrow'), sp('downArrow')],
    panes: ['list', 'detail'], group: 'nav', label: 'move', desc: 'move the selection', footer: true },

  // ── lifecycle (act on the selected app) ─────────────────────────────────────
  { id: 'start', key: 's', triggers: [ch('s')], panes: ['list', 'detail'],
    group: 'lifecycle', label: 'start', desc: 'start the selected app', footer: true },
  { id: 'stop', key: 'S', triggers: [ch('S')], panes: ['list', 'detail'],
    group: 'lifecycle', label: 'stop', desc: 'stop the selected app', footer: true },
  { id: 'restart', key: 'r', triggers: [ch('r')], panes: ['list', 'detail'],
    group: 'lifecycle', label: 'restart', desc: 'restart the selected app (confirm y/n)', footer: true },
  { id: 'focus', key: 'f', triggers: [ch('f')], panes: ['list', 'detail'],
    group: 'lifecycle', label: 'focus', desc: 'watch the app until it is stable' },
  { id: 'tryFix', key: 'x', triggers: [ch('x')], panes: ['list', 'detail'],
    group: 'lifecycle', label: 'try-fix', desc: 'run permitted auto-fixes, restart, wait' },
  { id: 'test', key: 'T', triggers: [ch('T')], panes: ['list', 'detail'],
    group: 'lifecycle', label: 'test', desc: "run the app's own test suite once" },
  { id: 'orchestrate', key: 'O', triggers: [ch('O')], panes: ['list', 'detail'],
    group: 'lifecycle', label: 'orchestrate', desc: 'bring up a whole profile / group' },

  // ── inspect ─────────────────────────────────────────────────────────────────
  { id: 'openUrl', key: 'o', triggers: [ch('o')], panes: ['list', 'detail'],
    group: 'inspect', label: 'open URL', desc: "open the app's URL in a browser" },
  { id: 'edit', key: 'e', triggers: [ch('e')], panes: ['list', 'detail'],
    group: 'inspect', label: 'edit', desc: 'edit command / port / env (session-only)' },
  { id: 'envFile', key: 'E', triggers: [ch('E')], panes: ['list', 'detail'],
    group: 'inspect', label: 'env file', desc: 'cycle the active env file' },
  { id: 'editor', key: 'V', triggers: [ch('V')], panes: ['list', 'detail'],
    group: 'inspect', label: '$EDITOR', desc: 'edit the session override in $EDITOR' },
  { id: 'logFocus', key: 'l', triggers: [ch('l')], panes: ['list', 'detail'],
    group: 'inspect', label: 'log', desc: 'focus the log pane', footer: true },
  { id: 'searchOpen', key: 'F', triggers: [ch('F')], panes: ['list', 'detail'],
    group: 'search', label: 'find', desc: 'search everything daimon has recorded (v1.16 query syntax: app: kind: level: before: after: "phrases")' },

  // ── filter ──────────────────────────────────────────────────────────────────
  { id: 'filter', key: '/', triggers: [ch('/')], panes: ['list', 'detail'],
    group: 'filter', label: 'filter', desc: 'filter the app list by name', footer: true },
  { id: 'tagFilter', key: 't', triggers: [ch('t')], panes: ['list', 'detail'],
    group: 'filter', label: 'tags', desc: 'filter the app list by tags' },
  { id: 'groupFilter', key: 'G', triggers: [ch('G')], panes: ['list', 'detail'],
    group: 'filter', label: 'group', desc: 'cycle the group filter (v1.1)' },
  { id: 'wsFilter', key: 'w', triggers: [ch('w')], panes: ['list', 'detail'],
    group: 'filter', label: 'workspace', desc: 'cycle the workspace filter: none → each workspace → none (v1.15; this TUI only — another attached TUI keeps its own)' },
  { id: 'viewHint', key: 'g', triggers: [ch('g')], panes: ['list', 'detail'],
    group: 'filter', label: 'view', desc: 'view hints: g then a/e/v/s/n' },

  // ── log pane ────────────────────────────────────────────────────────────────
  { id: 'levelCycle', key: 'l', triggers: [ch('l')], panes: ['log'],
    group: 'log', label: 'level', desc: 'cycle level filter: all → error → warn → info', footer: true },
  { id: 'grep', key: '/', triggers: [ch('/')], panes: ['log'],
    group: 'log', label: 'grep', desc: 'grep / live-filter the log (Esc restores)', footer: true },
  { id: 'grepNext', key: 'n', triggers: [ch('n')], panes: ['log'],
    group: 'log', label: 'next', desc: 'jump to the next grep match' },
  { id: 'grepPrev', key: 'N', triggers: [ch('N')], panes: ['log'],
    group: 'log', label: 'prev', desc: 'jump to the previous grep match' },
  { id: 'logTop', key: 'g', triggers: [ch('g')], panes: ['log'],
    group: 'log', label: 'top', desc: 'scroll to the top (oldest lines)', footer: true },
  { id: 'logBottom', key: 'G', triggers: [ch('G')], panes: ['log'],
    group: 'log', label: 'bottom', desc: 'scroll to the bottom (newest) and resume follow', footer: true },
  { id: 'logScroll', key: '↑/↓', triggers: [sp('upArrow'), sp('downArrow')], panes: ['log'],
    group: 'log', label: 'scroll', desc: 'scroll one line (scrolling up pauses follow)' },
  { id: 'logPage', key: 'PgUp/PgDn', triggers: [sp('pageUp'), sp('pageDown')], panes: ['list', 'detail', 'log'],
    group: 'log', label: 'page', desc: 'page the log up / down' },

  // ── timeline modal (M136) ────────────────────────────────────────────────────
  { id: 'tlMove', key: '←/→ · h/l', triggers: [sp('leftArrow'), sp('rightArrow'), ch('h'), ch('l'), sp('upArrow'), sp('downArrow'), ch('j'), ch('k')],
    panes: ['timeline'], group: 'timeline', label: 'bucket', desc: 'move between time buckets', footer: true },
  { id: 'tlEdges', key: 'g/G', triggers: [ch('g'), ch('G')], panes: ['timeline'],
    group: 'timeline', label: 'edges', desc: 'jump to oldest / newest bucket', footer: true },
  { id: 'tlDrill', key: 'Enter', triggers: [sp('return')], panes: ['timeline'],
    group: 'timeline', label: 'drill', desc: 'drill a day into hours (Esc back to days)', footer: true },
  { id: 'tlJump', key: 'n/p', triggers: [ch('n'), ch('p')], panes: ['timeline'],
    group: 'timeline', label: 'state', desc: 'jump to the app’s next / prev state change', footer: true },
  { id: 'tlBack', key: 'q/Esc', triggers: [ch('q'), sp('escape')], panes: ['timeline'],
    group: 'timeline', label: 'back', desc: 'exit the timeline (Esc steps hours → days first)', footer: true },

  // ── grep input (modal: live only while the log search box is open) ───────────
  // These used to be a hand-written `[Tab] … [Enter] keep [Esc] clear` string in
  // LogPane.tsx. The drift gate could not see it, because tsc splits a JSX
  // literal at its interpolation — so it is data now, like every other chord.
  { id: 'grepMode', key: 'Tab', triggers: [sp('tab')], panes: ['grep'],
    group: 'grep', label: 'filter/highlight', desc: 'toggle grep between narrowing and highlighting', footer: true },
  { id: 'grepKeep', key: 'Enter', triggers: [sp('return')], panes: ['grep'],
    group: 'grep', label: 'keep', desc: 'keep the grep pattern and close the input', footer: true },
  { id: 'grepClear', key: 'Esc', triggers: [sp('escape')], panes: ['grep'],
    group: 'grep', label: 'clear', desc: 'clear the grep pattern and restore the full stream', footer: true },

  // ── search modal (M182, v1.16: live only while the search pane is open) ──────
  // The query input owns every printable key, so these are the chords the
  // RESULTS list answers to — which is why `q` can mean "close" here without
  // colliding with typing a query.
  { id: 'seMove', key: '↑/↓', triggers: [sp('upArrow'), sp('downArrow')], panes: ['search'],
    group: 'search', label: 'move', desc: 'move through results (or the saved-search list)', footer: true },
  { id: 'seRun', key: 'Enter', triggers: [sp('return')], panes: ['search'],
    group: 'search', label: 'run/open', desc: 'run the query, or open the selected hit where it happened', footer: true },
  { id: 'seEdit', key: 'Tab', triggers: [sp('tab')], panes: ['search'],
    group: 'search', label: 'edit', desc: 'go back to the query input', footer: true },
  { id: 'seClose', key: 'Esc', triggers: [sp('escape'), ch('q')], panes: ['search'],
    group: 'search', label: 'close', desc: 'close the search pane (q closes it too, from the results list — the query input owns every printable key)', footer: true },

  // ── attach surface (`daimon attach`, HTTP client) ────────────────────────────
  { id: 'atMove', key: '↑/↓', triggers: [sp('upArrow'), sp('downArrow')], panes: ['attach'],
    group: 'attach', label: 'move', desc: 'move the selection', footer: true },
  { id: 'atToggle', key: 'Enter', triggers: [sp('return'), ch(' ')], panes: ['attach'],
    group: 'attach', label: 'log', desc: 'toggle the log for the selected app', footer: true },
  { id: 'atStart', key: 's', triggers: [ch('s')], panes: ['attach'],
    group: 'attach', label: 'start', desc: 'start the selected app', footer: true },
  { id: 'atStop', key: 'x', triggers: [ch('x')], panes: ['attach'],
    group: 'attach', label: 'stop', desc: 'stop the selected app', footer: true },
  { id: 'atRestart', key: 'r', triggers: [ch('r')], panes: ['attach'],
    group: 'attach', label: 'restart', desc: 'restart the selected app', footer: true },
  { id: 'atDetach', key: 'q', triggers: [ch('q'), { ch: 'c', ctrl: true }], panes: ['attach'],
    group: 'attach', label: 'detach', desc: 'detach (the daemon keeps running)', footer: true },
];

// The main-app panes (everything App.tsx dispatches). `timeline` and `attach`
// are their own surfaces with their own components.
export const MAIN_PANES: readonly Pane[] = ['list', 'detail', 'log'];

// Every chord App.tsx is responsible for dispatching. Declared as a value so
// App can type its handler table `Record<MainChordId, Handler>` — tsc then
// fails the build on a missing OR unknown handler, which is the compile-time
// half of the anti-drift guarantee. test/tui-chords.test.mjs asserts this list
// equals the chords actually scoped to a main pane (the runtime half).
export const MAIN_CHORD_IDS = [
  'help', 'nextPane', 'maximizeLog', 'timeline', 'quit',
  'move',
  'start', 'stop', 'restart', 'focus', 'tryFix', 'test', 'orchestrate',
  'openUrl', 'edit', 'envFile', 'editor', 'logFocus', 'searchOpen',
  'filter', 'tagFilter', 'groupFilter', 'wsFilter', 'viewHint',
  'levelCycle', 'grep', 'grepNext', 'grepPrev',
  'logTop', 'logBottom', 'logScroll', 'logPage',
] as const;

export type MainChordId = typeof MAIN_CHORD_IDS[number];

// ── resolvers (pure) ──────────────────────────────────────────────────────────

function triggerMatches(t: Trigger, input: string, key: KeyState): boolean {
  // Ctrl must match exactly, so Ctrl+C (quit) never fires on a bare 'c' and a
  // bare 's' (start) never fires on Ctrl+S.
  if (!!t.ctrl !== !!key.ctrl) return false;
  if (t.ch != null) return input === t.ch;
  if (t.special != null) return !!key[t.special];
  return false;
}

// Resolve a keypress to the chord live in `pane`. The first matching chord (in
// table order) wins — pane scoping guarantees at most one match per pane for a
// given physical key, so order only matters across panes, never within one.
export function resolveChord(pane: Pane, input: string, key: KeyState): ChordDef | null {
  for (const c of CHORDS) {
    if (!c.panes.includes(pane)) continue;
    for (const t of c.triggers) if (triggerMatches(t, input, key)) return c;
  }
  return null;
}

// Every chord live in a pane, in table order — the overlay and docs iterate this.
export function chordsForPane(pane: Pane): ChordDef[] {
  return CHORDS.filter(c => c.panes.includes(pane));
}

// The curated footer subset for a focused pane (chords flagged `footer`).
export function footerChords(pane: Pane): ChordDef[] {
  return CHORDS.filter(c => c.footer && c.panes.includes(pane));
}

// Overlay layout: chords grouped, with the focused pane's own groups first.
export interface ChordGroupView { group: ChordGroup; title: string; chords: ChordDef[]; }

const GROUP_TITLES: Record<ChordGroup, string> = {
  global: 'Global', nav: 'Navigation', lifecycle: 'Lifecycle', inspect: 'Inspect',
  filter: 'Filter', log: 'Log pane', timeline: 'Timeline', attach: 'Attach',
  grep: 'Grep input', search: 'Search',
};

// Which groups belong to which pane's "own" section (shown first in the overlay).
const PANE_GROUPS: Record<Pane, ChordGroup[]> = {
  list: ['global', 'nav', 'lifecycle', 'inspect', 'filter', 'search'],
  detail: ['global', 'nav', 'lifecycle', 'inspect', 'filter', 'search'],
  log: ['global', 'log', 'grep'],
  timeline: ['timeline'],
  attach: ['attach'],
  grep: ['grep', 'log'],
  search: ['search', 'global'],
};

// Group the main-app chords for the overlay, `pane`'s own groups first, the rest
// after — every group that has at least one chord appears exactly once.
export function overlayGroups(pane: Pane): ChordGroupView[] {
  const order: ChordGroup[] = [];
  const seen = new Set<ChordGroup>();
  const push = (g: ChordGroup) => { if (!seen.has(g)) { seen.add(g); order.push(g); } };
  for (const g of PANE_GROUPS[pane]) push(g);
  for (const c of CHORDS) push(c.group);
  const views: ChordGroupView[] = [];
  for (const g of order) {
    const chords = CHORDS.filter(c => c.group === g);
    if (chords.length) views.push({ group: g, title: GROUP_TITLES[g], chords });
  }
  return views;
}

// First-attach hint (M170, v1.14). Shown once, on a stranger's first TUI
// attach, and never again — the dismissal is persisted in ~/.daimon/state.json
// (`tuiHintSeen`, merge-written like every other key there). The key it names
// is READ FROM THE MAP: if the help chord is ever remapped, this line follows,
// because a hint that points at the wrong key is worse than no hint.
export function firstRunHintText(): string {
  const help = CHORDS.find(c => c.id === 'help');
  const key = help ? help.key : '?';
  return `New here? Press [${key}] for every key this TUI understands.`;
}
