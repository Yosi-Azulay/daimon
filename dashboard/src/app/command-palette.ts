import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { DaimonApi } from './daimon-api';
import { NAV_ENTRIES } from './nav-model';
import {
  flattenGroups,
  fmtHitAgo,
  formatFacetSummary,
  groupHitsByKind,
  isSearchQuery,
  isSearchSyntaxError,
  parseRecents,
  rankItems,
  rememberRecent,
  routeForHit,
  savedSearchQueryText,
  searchQueryText,
  sortSavedSearches,
  type RecentEntry,
  type SavedSearch,
  type SearchHit,
  type SearchHitGroup,
} from './command-palette-helpers';

// One unified item model (M157; 'saved-search' added M181, v1.16). `route`
// present ⇒ it's a navigation and is remembered in recents; actions have
// only `run` and are never replayed blind. A saved-search item has neither —
// selecting one switches the palette into search mode instead of navigating
// or firing an action (see runIdx's special case below).
interface PaletteItem {
  kind: 'nav' | 'app' | 'action' | 'saved-search';
  label: string;
  keywords?: string;
  hint?: string;
  icon: string;
  route?: string;
  run: () => void;
}

// A rendered row: either a non-selectable group header or a selectable item /
// search hit carrying its keyboard index in the unified list.
type PaletteRow =
  | { type: 'header'; label: string }
  | { type: 'item'; item: PaletteItem; index: number }
  | { type: 'hit'; hit: SearchHit; index: number };

// The indexed (keyboard-selectable) subset — items and hits, never headers.
type SelectableRow = Extract<PaletteRow, { index: number }>;

const SEARCH_DEBOUNCE_MS = 250;
// Plain (non-`>`) typing also searches history, but only once there's enough
// to be meaningful — a single character would fire a noisy query on every app.
const PLAIN_SEARCH_MIN = 2;
const RECENTS_KEY = 'daimon.palette.recents';

@Component({
  selector: 'dm-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule],
  template: `
    @if (open()) {
      <div class="dm-palette-backdrop" (click)="close()"></div>
      <div class="dm-palette" role="dialog" aria-label="Command palette">
        <div class="dm-palette-search">
          <mat-icon fontSet="material-symbols-outlined">{{ isSearchMode() ? 'travel_explore' : 'search' }}</mat-icon>
          <input #input
                 [(ngModel)]="query"
                 (ngModelChange)="onQuery($event)"
                 placeholder="Jump to app, run action, navigate… (type &gt; to search — app:/kind:/level:/before:/after:)"
                 autocomplete="off"
                 spellcheck="false"
                 role="combobox"
                 aria-controls="dm-palette-list"
                 aria-expanded="true"
                 [attr.aria-activedescendant]="activeId()" />
          <kbd>esc</kbd>
        </div>
        @if (searchErrorVisible(); as err) {
          <div class="dm-palette-note dm-palette-error" role="alert">
            <mat-icon fontSet="material-symbols-outlined">error</mat-icon>
            <span>{{ err.error }}{{ err.hint ? ' — ' + err.hint : '' }}</span>
          </div>
        } @else if (fallbackVisible()) {
          <div class="dm-palette-note">
            <mat-icon fontSet="material-symbols-outlined">info</mat-icon>
            LIKE fallback — full-text index unavailable, results may be less precise.
          </div>
        }
        @if (facetSummaryVisible(); as summary) {
          <div class="dm-palette-facets">{{ summary }}</div>
        }
        <ul class="dm-palette-list" id="dm-palette-list" [attr.role]="listRole()" #list>
          @if (searchLoading() && flatSearchHits().length === 0 && rankedCommands().length === 0 && !isSearchMode()) {
            <li class="dm-palette-empty">Searching…</li>
          }
          @for (row of rows(); track $index) {
            @if (row.type === 'header') {
              <li class="dm-palette-group-label" role="presentation">{{ row.label }}</li>
            } @else if (row.type === 'item') {
              <li class="dm-palette-item"
                  role="option"
                  [id]="'dm-pi-' + row.index"
                  [attr.aria-selected]="row.index === active()"
                  [class.active]="row.index === active()"
                  (mouseenter)="active.set(row.index)"
                  (click)="runIdx(row.index)">
                <mat-icon fontSet="material-symbols-outlined">{{ row.item.icon }}</mat-icon>
                <span class="dm-palette-label">{{ row.item.label }}</span>
                @if (row.item.hint) { <span class="dm-palette-hint">{{ row.item.hint }}</span> }
                <span class="dm-palette-kind">{{ row.item.kind }}</span>
              </li>
            } @else {
              <li class="dm-palette-item dm-palette-hit"
                  role="option"
                  [id]="'dm-pi-' + row.index"
                  [attr.aria-selected]="row.index === active()"
                  [class.active]="row.index === active()"
                  (mouseenter)="active.set(row.index)"
                  (click)="runIdx(row.index)">
                <mat-icon fontSet="material-symbols-outlined">{{ hitIcon(row.hit) }}</mat-icon>
                <span class="dm-palette-hit-app">{{ row.hit.app }}</span>
                <span class="dm-palette-hit-snippet">{{ row.hit.snippet }}</span>
                <span class="dm-palette-hit-ago">{{ fmtAgo(row.hit.ts) }}</span>
              </li>
            }
          } @empty {
            <li class="dm-palette-empty">{{ emptyMessage() }}</li>
          }
        </ul>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
    :host:has(.dm-palette) { pointer-events: auto; }
    .dm-palette-backdrop { position: absolute; inset: 0; background: color-mix(in oklch, var(--dm-color-scrim) 50%, transparent); }
    .dm-palette {
      position: absolute; top: 12vh; left: 50%; transform: translateX(-50%);
      width: min(640px, 92vw);
      background: var(--dm-color-surface-3);
      color: var(--dm-color-fg);
      border-radius: 16px;
      box-shadow: var(--dm-elev-3);
      overflow: hidden;
      border: 1px solid var(--dm-color-border);
    }
    .dm-palette-search {
      display: flex; align-items: center; gap: .75rem;
      padding: .875rem 1rem;
      border-bottom: 1px solid var(--dm-color-border);
    }
    .dm-palette-search input {
      flex: 1; background: transparent; border: 0; outline: 0;
      color: inherit; font: 400 1rem/1.5rem Roboto;
    }
    .dm-palette-search kbd {
      font-family: 'Roboto Mono', ui-monospace, monospace;
      font-size: .6875rem; padding: 2px 6px; border-radius: 4px;
      background: var(--dm-color-surface);
      border: 1px solid var(--dm-color-border);
      color: var(--dm-color-fg-muted);
    }
    .dm-palette-list { list-style: none; margin: 0; padding: 6px; max-height: 60vh; overflow-y: auto; }
    .dm-palette-item {
      display: flex; align-items: center; gap: .75rem;
      padding: 10px 12px; border-radius: 10px; cursor: pointer;
      font: 500 .875rem/1.25rem Roboto;
    }
    .dm-palette-item.active { background: color-mix(in oklch, var(--dm-color-primary) 14%, transparent); }
    .dm-palette-label { flex: 1; }
    .dm-palette-hint {
      color: var(--dm-color-fg-muted); font-family: 'Roboto Mono', monospace; font-size: .75rem;
      max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dm-palette-kind {
      font-size: .6875rem; padding: 2px 8px; border-radius: 999px;
      background: var(--dm-color-surface);
      color: var(--dm-color-fg-muted);
      text-transform: uppercase; letter-spacing: .05em;
    }
    .dm-palette-empty { padding: 1.5rem; color: var(--dm-color-fg-muted); text-align: center; }
    .dm-palette-note {
      display: flex; align-items: center; gap: .5rem;
      padding: 6px 16px; font: 500 .75rem/1.25rem Roboto;
      color: var(--dm-color-fg-muted);
      background: color-mix(in oklch, var(--dm-color-accent) 10%, transparent);
      border-bottom: 1px solid var(--dm-color-border);
    }
    .dm-palette-note mat-icon { font-size: 16px; width: 16px; height: 16px; color: var(--dm-color-accent); }
    .dm-palette-error {
      color: var(--dm-color-error);
      background: color-mix(in oklch, var(--dm-color-error) 10%, transparent);
    }
    .dm-palette-error mat-icon { color: var(--dm-color-error); }
    .dm-palette-facets {
      padding: 4px 16px; font: 500 .75rem/1.25rem Roboto;
      color: var(--dm-color-fg-muted);
      border-bottom: 1px solid var(--dm-color-border);
    }
    .dm-palette-group-label {
      padding: 8px 12px 4px; font: 600 .6875rem/1rem Roboto;
      text-transform: uppercase; letter-spacing: .05em;
      color: var(--dm-color-fg-muted);
    }
    .dm-palette-hit-app {
      flex-shrink: 0; padding: 1px 8px; border-radius: 999px;
      background: var(--dm-color-surface);
      color: var(--dm-color-fg-muted);
      font: 600 .75rem/1.125rem 'Roboto Mono', ui-monospace, monospace;
    }
    .dm-palette-hit-snippet {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--dm-color-fg); font-weight: 400;
    }
    .dm-palette-hit-ago { flex-shrink: 0; color: var(--dm-color-fg-muted); font-size: .75rem; }
    @media (max-width: 480px) {
      .dm-palette-hit-app { display: none; }
    }
  `],
})
export class CommandPaletteComponent implements OnInit, OnDestroy {
  private readonly api = inject(DaimonApi);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef);
  @ViewChild('input') input?: ElementRef<HTMLInputElement>;

  open = signal(false);
  query = '';
  active = signal(0);
  readonly recents = signal<RecentEntry[]>([]);

  readonly searchHits = signal<SearchHit[]>([]);
  readonly searchFallback = signal(false);
  readonly searchLoading = signal(false);
  readonly searchGroups = computed<SearchHitGroup[]>(() => groupHitsByKind(this.searchHits()));
  readonly flatSearchHits = computed<SearchHit[]>(() => flattenGroups(this.searchGroups()));

  // Unified search (M180, v1.16): per-kind hit counts, present only when the
  // API was asked for `scope=all` (search mode always asks). Query-syntax
  // errors (M179's 400, e.g. an unknown `lvl:` field) — present INSTEAD of
  // hits, never alongside a stale result set.
  readonly searchFacets = signal<Record<string, number> | null>(null);
  readonly searchError = signal<{ error: string; hint?: string } | null>(null);
  readonly facetSummary = computed(() => formatFacetSummary(this.searchFacets()));

  // Saved searches (M181, v1.16) — loaded fresh each time the palette opens
  // (they change rarely; no live-polling signal needed). Sorted the same
  // way the server sorts /api/searches so ordering never surprises.
  readonly savedSearches = signal<SavedSearch[]>([]);
  private readonly savedSearchItems = computed<PaletteItem[]>(() =>
    sortSavedSearches(this.savedSearches()).map(s => ({
      kind: 'saved-search' as const,
      icon: 'bookmark',
      label: s.name,
      hint: s.query,
      keywords: s.query,
      run: () => this.selectSavedSearch(s),
    })),
  );

  private searchTimer?: ReturnType<typeof setTimeout>;
  private searchToken = 0;

  // Every reachable command (nav destinations from the shared nav model, plus
  // per-app jumps + actions). Recomputed when the app list changes.
  private readonly allItems = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const e of NAV_ENTRIES) {
      items.push({ kind: 'nav', icon: e.icon, label: `Go to ${e.label}`, keywords: e.label, hint: e.shortcut, route: e.path, run: () => this.go(e.path) });
    }
    for (const a of this.api.apps()) {
      items.push({ kind: 'app', icon: 'app_registration', label: a.name, keywords: 'open app ' + (a.status ?? ''), hint: a.status, route: `/apps/${a.name}`, run: () => this.go(`/apps/${a.name}`) });
      items.push({ kind: 'action', icon: 'play_arrow', label: `Start ${a.name}`, keywords: a.name, run: () => void this.api.startApp(a.name) });
      items.push({ kind: 'action', icon: 'restart_alt', label: `Restart ${a.name}`, keywords: a.name, run: () => void this.api.restartApp(a.name) });
      items.push({ kind: 'action', icon: 'stop', label: `Stop ${a.name}`, keywords: a.name, run: () => void this.api.stopApp(a.name) });
      // Mute reads live state: offer the opposite of what's set.
      if (a.muted) {
        items.push({ kind: 'action', icon: 'notifications_active', label: `Unmute ${a.name}`, keywords: a.name + ' notifications', run: () => void this.api.unmuteApp(a.name) });
      } else {
        items.push({ kind: 'action', icon: 'notifications_off', label: `Mute ${a.name}`, keywords: a.name + ' notifications', run: () => void this.api.muteApp(a.name) });
      }
      items.push({ kind: 'action', icon: 'science', label: `Test ${a.name}`, keywords: a.name + ' run tests', run: () => void this.api.runAppTest(a.name) });
      items.push({ kind: 'action', icon: 'terminal', label: `Logs for ${a.name}`, keywords: a.name, run: () => this.go(`/logs/${a.name}`) });
    }
    return items;
  });

  // Ranked command items for the current query. Empty query → recents are
  // shown separately, so here we show a lean default slice (nav + apps only,
  // no actions) to teach what's reachable without a wall of Start/Stop rows.
  readonly rankedCommands = computed<PaletteItem[]>(() => {
    if (this.isSearchMode()) return [];
    const q = this.query.trim();
    if (!q) {
      return this.allItems().filter(i => i.kind !== 'action').slice(0, 8);
    }
    return rankItems(q, this.allItems()).slice(0, 20);
  });

  // Convert a stored recent to a runnable item.
  private recentToItem(r: RecentEntry): PaletteItem {
    return { kind: 'nav', icon: r.icon, label: r.label, route: r.route, run: () => this.go(r.route) };
  }

  // The fully assembled, index-annotated row list the template renders and the
  // keyboard navigates. Group headers are interleaved but never indexed.
  // ARIA (fixed in v1.16): `role="listbox"` REQUIRES option children, so a
  // palette showing only an empty state or a query-syntax error must not claim
  // to be one — axe flags it critical (aria-required-children), and a screen
  // reader announces a listbox with nothing in it. With no options the list is
  // a plain <ul> of plain <li>, which is exactly what it is. Caught by the
  // M184 axe pass over the new error state; the empty state could reach it
  // before v1.16 too, but no axe check had ever rendered one.
  listRole(): string | null {
    return this.rows().some(r => r.type === 'item') ? 'listbox' : null;
  }

  rows(): PaletteRow[] {
    const out: PaletteRow[] = [];
    let idx = 0;

    if (this.isSearchMode()) {
      for (const g of this.searchGroups()) {
        out.push({ type: 'header', label: g.label });
        for (const h of g.hits) out.push({ type: 'hit', hit: h, index: idx++ });
      }
      return out;
    }

    const q = this.query.trim();
    if (!q) {
      const rec = this.recents();
      if (rec.length) {
        out.push({ type: 'header', label: 'Recent' });
        for (const r of rec) out.push({ type: 'item', item: this.recentToItem(r), index: idx++ });
      }
      const cmds = this.rankedCommands();
      if (cmds.length) {
        out.push({ type: 'header', label: 'Jump to' });
        for (const it of cmds) out.push({ type: 'item', item: it, index: idx++ });
      }
      const saved = this.savedSearchItems();
      if (saved.length) {
        out.push({ type: 'header', label: 'Saved searches' });
        for (const it of saved) out.push({ type: 'item', item: it, index: idx++ });
      }
      return out;
    }

    const cmds = this.rankedCommands();
    if (cmds.length) {
      out.push({ type: 'header', label: 'Commands' });
      for (const it of cmds) out.push({ type: 'item', item: it, index: idx++ });
    }
    for (const g of this.searchGroups()) {
      out.push({ type: 'header', label: g.label });
      for (const h of g.hits) out.push({ type: 'hit', hit: h, index: idx++ });
    }
    return out;
  }

  private selectableRows(): SelectableRow[] {
    return this.rows().filter((r): r is SelectableRow => r.type !== 'header');
  }

  selectableCount(): number {
    return this.selectableRows().length;
  }

  activeId(): string | null {
    return this.open() && this.selectableCount() ? 'dm-pi-' + this.active() : null;
  }

  emptyMessage(): string {
    if (this.isSearchMode()) {
      if (this.searchError()) return 'Fix the query above and try again.';
      if (this.currentSearchText().length === 0) return 'Type to search logs, errors, tests and error groups.';
      if (this.searchLoading()) return 'Searching…';
      return 'No matches.';
    }
    return 'No matches.';
  }

  fallbackVisible(): boolean {
    return !this.searchError() && this.searchFallback() && (this.isSearchMode() || this.query.trim().length >= PLAIN_SEARCH_MIN);
  }

  // A query-syntax error (M179's 400) only ever applies to search mode — the
  // plain-typing path never sends `scope=all` and its bare-term queries
  // can't fail to parse.
  searchErrorVisible(): { error: string; hint?: string } | null {
    return this.isSearchMode() ? this.searchError() : null;
  }

  // The facet summary only makes sense once results (or an error) came back
  // from a `scope=all` call, and never alongside the error banner.
  facetSummaryVisible(): string | null {
    return this.isSearchMode() && !this.searchError() ? this.facetSummary() : null;
  }

  private listener = (e: Event) => this.openPalette((e as CustomEvent<{ query?: string }>).detail?.query);

  ngOnInit(): void {
    window.addEventListener('daimon:cmdk', this.listener);
    window.dispatchEvent(new CustomEvent('daimon:cmdk-ready'));
  }
  ngOnDestroy(): void {
    window.removeEventListener('daimon:cmdk', this.listener);
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  private lastFocused: HTMLElement | null = null;

  openPalette(presetQuery?: string): void {
    this.lastFocused = document.activeElement as HTMLElement | null;
    this.open.set(true);
    this.query = presetQuery ?? '';
    this.active.set(0);
    this.recents.set(parseRecents(localStorage.getItem(RECENTS_KEY)));
    this.resetSearch();
    void this.loadSavedSearches();
    setTimeout(() => {
      this.input?.nativeElement.focus();
      if (this.query) this.onQuery(this.query);
    }, 0);
  }

  close(): void {
    this.open.set(false);
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = undefined; }
    this.lastFocused?.focus();
    this.lastFocused = null;
  }

  private onTab(e: KeyboardEvent, host: HTMLElement): void {
    const focusable = Array.from(
      host.querySelectorAll<HTMLElement>('input, button, [href], [tabindex]:not([tabindex="-1"])'),
    ).filter(el => !el.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement as HTMLElement | null;
    if (e.shiftKey && current === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  }

  isSearchMode(): boolean {
    return isSearchQuery(this.query);
  }

  currentSearchText(): string {
    return searchQueryText(this.query);
  }

  // The text sent to GET /api/search — the stripped `>` text in search mode,
  // or the plain query (when long enough) so typing also surfaces history.
  private effectiveSearchText(): string {
    if (this.isSearchMode()) return this.currentSearchText();
    const q = this.query.trim();
    return q.length >= PLAIN_SEARCH_MIN ? q : '';
  }

  hitIcon(h: SearchHit): string {
    switch (h.kind) {
      case 'logs': return 'terminal';
      case 'errors': return 'error';
      case 'error-groups': return 'bug_report';
      case 'tests': return 'science';
      default: return 'timeline'; // events
    }
  }

  fmtAgo(ts: number): string {
    return fmtHitAgo(ts);
  }

  async loadSavedSearches(): Promise<void> {
    this.savedSearches.set(await this.api.getSavedSearches());
  }

  // Selecting a saved search (M181) never runs it directly — it puts the
  // palette into search mode with the saved query preset and lets the normal
  // onQuery → runSearch path do the actual GET /api/search. The palette
  // stays open (unlike runIdx's nav/action items) so the results land right
  // where the user was looking.
  private selectSavedSearch(s: SavedSearch): void {
    this.query = savedSearchQueryText(s);
    this.active.set(0);
    this.onQuery(this.query);
    this.input?.nativeElement.focus();
  }

  onQuery(_q: string): void {
    this.active.set(0);
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = undefined; }
    const text = this.effectiveSearchText();
    if (!text.trim()) {
      this.resetSearch();
      return;
    }
    // Search mode always asks for the M180 unified scope (tests + live error
    // groups + facets); plain in-place typing stays the pre-v1.16 logs/
    // errors/events-only shape.
    const scope: 'all' | undefined = this.isSearchMode() ? 'all' : undefined;
    this.searchLoading.set(true);
    this.searchTimer = setTimeout(() => void this.runSearch(text, scope), SEARCH_DEBOUNCE_MS);
  }

  private resetSearch(): void {
    this.searchHits.set([]);
    this.searchFallback.set(false);
    this.searchLoading.set(false);
    this.searchFacets.set(null);
    this.searchError.set(null);
  }

  private async runSearch(text: string, scope?: 'all'): Promise<void> {
    const token = ++this.searchToken;
    try {
      const r = await this.api.search({ q: text, limit: 30, scope });
      if (token !== this.searchToken) return; // superseded
      this.searchHits.set(isSearchSyntaxError(r) ? [] : r.hits);
      this.searchFallback.set(r.fallback);
      this.searchFacets.set(r.facets ?? null);
      this.searchError.set(isSearchSyntaxError(r) ? { error: r.error!, hint: r.hint } : null);
    } finally {
      if (token === this.searchToken) this.searchLoading.set(false);
    }
  }

  runIdx(i: number): void {
    const row = this.selectableRows().find(r => r.index === i);
    if (!row) return;
    if (row.type === 'hit') {
      this.selectHit(row.hit);
      return;
    }
    const item = row.item;
    // A saved search (M181) switches the palette into search mode instead
    // of navigating away or firing an action — it must NOT close the
    // palette, and it's never added to recents (recents are navigation
    // targets; a saved search is a query, run explicitly every time).
    if (item.kind === 'saved-search') {
      item.run();
      return;
    }
    // Remember navigation selections (nav + app jumps) before closing —
    // actions are never remembered (replaying "Stop web" blind is unsafe).
    if (item.route) {
      const next = rememberRecent(this.recents(), { label: item.label, route: item.route, icon: item.icon });
      this.recents.set(next);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch {}
    }
    this.close();
    item.run();
  }

  selectHit(h: SearchHit): void {
    this.close();
    this.go(routeForHit(h));
  }

  go(path: string): void { void this.router.navigateByUrl(path); }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (!this.open()) return;
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Tab') {
      const dialog = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('.dm-palette');
      if (dialog) this.onTab(e, dialog);
      return;
    }
    const count = this.selectableCount();
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this.active.update(i => Math.min(count - 1, i + 1));
      this.scrollActiveIntoView();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this.active.update(i => Math.max(0, i - 1));
      this.scrollActiveIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.runIdx(this.active());
    }
  }

  private scrollActiveIntoView(): void {
    queueMicrotask(() => {
      const el = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('#dm-pi-' + this.active());
      el?.scrollIntoView({ block: 'nearest' });
    });
  }
}
