import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { DaimonApi } from './daimon-api';
import {
  flattenGroups,
  fmtHitAgo,
  groupHitsByKind,
  isSearchQuery,
  routeForHit,
  searchQueryText,
  type SearchHit,
  type SearchHitGroup,
} from './command-palette-helpers';

interface PaletteItem { kind: 'app' | 'nav' | 'action'; label: string; hint?: string; icon: string; run: () => void; }

const SEARCH_DEBOUNCE_MS = 250;

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
                 placeholder="Jump to app, run action, navigate… (type &gt; to search logs/errors/events)"
                 autocomplete="off"
                 spellcheck="false" />
          <kbd>esc</kbd>
        </div>
        @if (isSearchMode()) {
          @if (searchFallback()) {
            <div class="dm-palette-note">
              <mat-icon fontSet="material-symbols-outlined">info</mat-icon>
              LIKE fallback — full-text index unavailable, results may be less precise.
            </div>
          }
          <ul class="dm-palette-list" #list>
            @if (searchLoading() && flatSearchHits().length === 0) {
              <li class="dm-palette-empty">Searching…</li>
            } @else if (currentSearchText().length === 0) {
              <li class="dm-palette-empty">Type to search logs, errors and events.</li>
            } @else if (flatSearchHits().length === 0) {
              <li class="dm-palette-empty">No matches.</li>
            } @else {
              @for (group of searchGroups(); track group.kind) {
                <li class="dm-palette-group-label">{{ group.label }}</li>
                @for (h of group.hits; track h.ref) {
                  <li class="dm-palette-item dm-palette-hit"
                      [class.active]="hitIndex(h) === active()"
                      (mouseenter)="active.set(hitIndex(h))"
                      (click)="selectHit(h)">
                    <mat-icon fontSet="material-symbols-outlined">{{ hitIcon(h) }}</mat-icon>
                    <span class="dm-palette-hit-app">{{ h.app }}</span>
                    <span class="dm-palette-hit-snippet">{{ h.snippet }}</span>
                    <span class="dm-palette-hit-ago">{{ fmtAgo(h.ts) }}</span>
                  </li>
                }
              }
            }
          </ul>
        } @else {
          <ul class="dm-palette-list" #list>
            @for (item of visible(); track $index; let i = $index) {
              <li class="dm-palette-item"
                  [class.active]="i === active()"
                  (mouseenter)="active.set(i)"
                  (click)="runIdx(i)">
                <mat-icon fontSet="material-symbols-outlined">{{ item.icon }}</mat-icon>
                <span class="dm-palette-label">{{ item.label }}</span>
                @if (item.hint) { <span class="dm-palette-hint">{{ item.hint }}</span> }
                <span class="dm-palette-kind">{{ item.kind }}</span>
              </li>
            } @empty {
              <li class="dm-palette-empty">No matches.</li>
            }
          </ul>
        }
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
    :host:has(.dm-palette) { pointer-events: auto; }
    .dm-palette-backdrop { position: absolute; inset: 0; background: color-mix(in oklch, var(--mat-sys-scrim) 50%, transparent); }
    .dm-palette {
      position: absolute; top: 12vh; left: 50%; transform: translateX(-50%);
      width: min(640px, 92vw);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      border-radius: 16px;
      box-shadow: var(--mat-sys-level4);
      overflow: hidden;
      border: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-palette-search {
      display: flex; align-items: center; gap: .75rem;
      padding: .875rem 1rem;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-palette-search input {
      flex: 1; background: transparent; border: 0; outline: 0;
      color: inherit; font: 400 1rem/1.5rem Roboto;
    }
    .dm-palette-search kbd {
      font-family: 'Roboto Mono', ui-monospace, monospace;
      font-size: .6875rem; padding: 2px 6px; border-radius: 4px;
      background: var(--mat-sys-surface-container-low);
      border: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-palette-list { list-style: none; margin: 0; padding: 6px; max-height: 60vh; overflow-y: auto; }
    .dm-palette-item {
      display: flex; align-items: center; gap: .75rem;
      padding: 10px 12px; border-radius: 10px; cursor: pointer;
      font: 500 .875rem/1.25rem Roboto;
    }
    .dm-palette-item.active { background: color-mix(in oklch, var(--mat-sys-primary) 14%, transparent); }
    .dm-palette-label { flex: 1; }
    .dm-palette-hint { color: var(--mat-sys-on-surface-variant); font-family: 'Roboto Mono', monospace; font-size: .75rem; }
    .dm-palette-kind {
      font-size: .6875rem; padding: 2px 8px; border-radius: 999px;
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase; letter-spacing: .05em;
    }
    .dm-palette-empty { padding: 1.5rem; color: var(--mat-sys-on-surface-variant); text-align: center; }
    .dm-palette-note {
      display: flex; align-items: center; gap: .5rem;
      padding: 6px 16px; font: 500 .75rem/1.25rem Roboto;
      color: var(--mat-sys-on-surface-variant);
      background: color-mix(in oklch, var(--mat-sys-tertiary) 10%, transparent);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-palette-note mat-icon { font-size: 16px; width: 16px; height: 16px; color: var(--mat-sys-tertiary); }
    .dm-palette-group-label {
      padding: 8px 12px 4px; font: 600 .6875rem/1rem Roboto;
      text-transform: uppercase; letter-spacing: .05em;
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-palette-hit-app {
      flex-shrink: 0; padding: 1px 8px; border-radius: 999px;
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface-variant);
      font: 600 .75rem/1.125rem 'Roboto Mono', ui-monospace, monospace;
    }
    .dm-palette-hit-snippet {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--mat-sys-on-surface); font-weight: 400;
    }
    .dm-palette-hit-ago { flex-shrink: 0; color: var(--mat-sys-on-surface-variant); font-size: .75rem; }
    @media (max-width: 480px) {
      .dm-palette-hit-app { display: none; }
    }
  `],
})
export class CommandPaletteComponent implements OnInit, OnDestroy {
  private readonly api = inject(DaimonApi);
  private readonly router = inject(Router);
  @ViewChild('input') input?: ElementRef<HTMLInputElement>;

  open = signal(false);
  query = '';
  active = signal(0);

  readonly searchHits = signal<SearchHit[]>([]);
  readonly searchFallback = signal(false);
  readonly searchLoading = signal(false);
  // Depend only on the searchHits signal (not the plain `query` field) so
  // these stay properly reactive — `query` is a plain field driven by
  // ngModel, and a computed() that read it directly would never re-run
  // (Angular computed() only invalidates on signal reads).
  readonly searchGroups = computed<SearchHitGroup[]>(() => groupHitsByKind(this.searchHits()));
  readonly flatSearchHits = computed<SearchHit[]>(() => flattenGroups(this.searchGroups()));

  private searchTimer?: ReturnType<typeof setTimeout>;
  private searchToken = 0;

  private allItems = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    items.push({ kind: 'nav', icon: 'apps', label: 'Go to Apps', hint: 'g a', run: () => this.go('/') });
    items.push({ kind: 'nav', icon: 'timeline', label: 'Go to Events', hint: 'g v', run: () => this.go('/events') });
    items.push({ kind: 'nav', icon: 'terminal', label: 'Go to Logs', hint: 'g l', run: () => this.go('/logs') });
    items.push({ kind: 'nav', icon: 'error', label: 'Go to Errors', hint: 'g e', run: () => this.go('/errors') });
    items.push({ kind: 'nav', icon: 'trending_down', label: 'Go to Regressions', hint: 'g r', run: () => this.go('/regressions') });
    items.push({ kind: 'nav', icon: 'medical_services', label: 'Go to Doctor', hint: 'g d', run: () => this.go('/doctor') });
    items.push({ kind: 'nav', icon: 'tune', label: 'Go to Config', hint: 'g c', run: () => this.go('/config') });
    items.push({ kind: 'nav', icon: 'query_stats', label: 'Go to History', hint: 'g h', run: () => this.go('/history') });
    items.push({ kind: 'nav', icon: 'summarize', label: 'Go to Report', hint: 'g p', run: () => this.go('/report') });
    for (const a of this.api.apps()) {
      items.push({ kind: 'app', icon: 'app_registration', label: a.name, hint: a.status, run: () => this.go(`/apps/${a.name}`) });
      items.push({ kind: 'action', icon: 'play_arrow', label: `Start ${a.name}`, run: () => void this.api.startApp(a.name) });
      items.push({ kind: 'action', icon: 'restart_alt', label: `Restart ${a.name}`, run: () => void this.api.restartApp(a.name) });
      items.push({ kind: 'action', icon: 'stop', label: `Stop ${a.name}`, run: () => void this.api.stopApp(a.name) });
      items.push({ kind: 'action', icon: 'terminal', label: `Logs for ${a.name}`, run: () => this.go(`/logs/${a.name}`) });
    }
    return items;
  });

  visible = computed<PaletteItem[]>(() => {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.allItems().slice(0, 12);
    return this.allItems().filter(i => i.label.toLowerCase().includes(q) || (i.hint ?? '').toLowerCase().includes(q)).slice(0, 30);
  });

  private listener = () => this.openPalette();

  ngOnInit(): void {
    window.addEventListener('daimon:cmdk', this.listener);
  }
  ngOnDestroy(): void {
    window.removeEventListener('daimon:cmdk', this.listener);
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  openPalette(): void {
    this.open.set(true);
    this.query = '';
    this.active.set(0);
    this.resetSearch();
    setTimeout(() => this.input?.nativeElement.focus(), 0);
  }

  close(): void {
    this.open.set(false);
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = undefined; }
  }

  // Plain methods (not computed()) since `query` is a plain ngModel-bound
  // field, not a signal — the template re-evaluates these every change
  // detection cycle, which is exactly what we want on every keystroke.
  isSearchMode(): boolean {
    return isSearchQuery(this.query);
  }

  currentSearchText(): string {
    return searchQueryText(this.query);
  }

  hitIcon(h: SearchHit): string {
    return h.kind === 'logs' ? 'terminal' : (h.kind === 'errors' ? 'error' : 'timeline');
  }

  fmtAgo(ts: number): string {
    return fmtHitAgo(ts);
  }

  hitIndex(h: SearchHit): number {
    return this.flatSearchHits().indexOf(h);
  }

  onQuery(_q: string): void {
    this.active.set(0);
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = undefined; }
    if (!this.isSearchMode() || !this.currentSearchText().trim()) {
      this.resetSearch();
      return;
    }
    this.searchLoading.set(true);
    const text = this.currentSearchText();
    this.searchTimer = setTimeout(() => void this.runSearch(text), SEARCH_DEBOUNCE_MS);
  }

  private resetSearch(): void {
    this.searchHits.set([]);
    this.searchFallback.set(false);
    this.searchLoading.set(false);
  }

  private async runSearch(text: string): Promise<void> {
    const token = ++this.searchToken;
    try {
      const r = await this.api.search({ q: text, limit: 30 });
      if (token !== this.searchToken) return; // a newer query superseded this one — drop the stale response
      this.searchHits.set(r.hits);
      this.searchFallback.set(r.fallback);
    } finally {
      if (token === this.searchToken) this.searchLoading.set(false);
    }
  }

  runIdx(i: number): void {
    if (this.isSearchMode()) {
      const hit = this.flatSearchHits()[i];
      if (hit) this.selectHit(hit);
      return;
    }
    const item = this.visible()[i];
    if (!item) return;
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
    const count = this.isSearchMode() ? this.flatSearchHits().length : this.visible().length;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this.active.update(i => Math.min(count - 1, i + 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this.active.update(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.runIdx(this.active());
    }
  }
}
