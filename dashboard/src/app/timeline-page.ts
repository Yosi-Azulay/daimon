import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Input, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { DaimonApi } from './daimon-api';
import { EmptyStateComponent } from './ui-primitives';

interface TimelineRow {
  ts: number;
  app: string;
  kind: string;
  summary: string;
  payload: any;
}

const KIND_LABEL: Record<string, string> = {
  status: 'status',
  error: 'error',
  warning: 'warning',
  lint: 'lint',
  health: 'health',
  bundle: 'bundle',
  compile: 'compile',
  task: 'task',
  restart: 'restart',
};

const ALL_KINDS = Object.keys(KIND_LABEL);
const SINCE_OPTS: { key: string; label: string }[] = [
  { key: '1h', label: '1h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
];

@Component({
  selector: 'dm-timeline-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ScrollingModule, EmptyStateComponent],
  template: `
    <div class="dm-page">
      <header class="dm-page-header">
        <div>
          <h1>Timeline</h1>
          <div class="dm-page-sub">
            {{ filtered().length }} of {{ rows().length }} events ·
            window {{ since() }} · app {{ app() || 'all' }}
          </div>
        </div>
        <div class="dm-header-actions">
          <button type="button" class="ib" (click)="refresh()" [disabled]="loading()" aria-label="Refresh" title="Refresh">
            <span class="material-symbols-outlined" [class.spin]="loading()">refresh</span>
          </button>
        </div>
      </header>

      <div class="dm-toolbar">
        <div class="dm-chips" role="group" aria-label="Time window">
          @for (s of sinceOpts; track s.key) {
            <button type="button" class="dm-chip" [class.active]="since() === s.key"
                    [attr.aria-pressed]="since() === s.key"
                    (click)="setSince(s.key)">{{ s.label }}</button>
          }
        </div>
        <label class="dm-app-pick">
          App
          <select [ngModel]="app()" (ngModelChange)="setApp($event)">
            <option [ngValue]="''">All</option>
            @for (a of api.apps(); track a.name) {
              <option [ngValue]="a.name">{{ a.name }}</option>
            }
          </select>
        </label>
        <div class="dm-chips" role="group" aria-label="Kinds">
          @for (k of allKinds; track k) {
            <button type="button" class="dm-chip dm-kind-chip" [class.active]="kinds().has(k)"
                    [attr.data-kind]="k"
                    (click)="toggleKind(k)">{{ kindLabel[k] }}</button>
          }
        </div>
      </div>

      @if (filtered().length === 0 && !loading()) {
        <dm-empty title="No events in window"
                  hint="Widen the window or pick different kinds. Status / error / lint / bundle / task all live here."></dm-empty>
      } @else {
        <cdk-virtual-scroll-viewport #viewport itemSize="44" class="dm-tl-viewport" tabindex="-1">
          <div *cdkVirtualFor="let r of filtered(); trackBy: trackTs"
               class="dm-tl-row" [attr.data-kind]="r.kind"
               [class.dm-tl-anchored]="anchoredTs() === r.ts"
               role="button" tabindex="0"
               [attr.aria-label]="r.app + ' · ' + (kindLabel[r.kind] || r.kind) + ' · ' + r.summary"
               (click)="select(r, $event)"
               (keydown.enter)="select(r, $event)"
               (keydown.space)="$event.preventDefault(); select(r, $event)">
            <span class="dm-tl-ts" [title]="fullTs(r.ts)">{{ rel(r.ts) }}</span>
            <span class="dm-tl-kind dm-kind-chip" [attr.data-kind]="r.kind">{{ kindLabel[r.kind] || r.kind }}</span>
            <span class="dm-tl-app">{{ r.app }}</span>
            <span class="dm-tl-summary">{{ r.summary }}</span>
          </div>
        </cdk-virtual-scroll-viewport>
      }

      @if (selected(); as sel) {
        <aside class="dm-tl-drawer" role="dialog" aria-modal="true" tabindex="-1" #drawer
               [attr.aria-label]="sel.app + ' event detail'">
          <header>
            <div>
              <h2>{{ sel.app }} · {{ kindLabel[sel.kind] || sel.kind }}</h2>
              <div class="dm-tl-drawer-ts">{{ fullTs(sel.ts) }}</div>
            </div>
            <button type="button" class="ib" (click)="select(null)" aria-label="Close" title="Close">
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>
          <pre>{{ payloadJson(sel.payload) }}</pre>
        </aside>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1rem; }
    .dm-page-sub { color: var(--mat-sys-on-surface-variant); font: 500 .8125rem/1.25rem Roboto; }
    .dm-toolbar { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
    .dm-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
    .dm-chip {
      padding: 4px 12px; border-radius: 999px;
      background: var(--mat-sys-surface-container); color: var(--mat-sys-on-surface-variant);
      border: 1px solid var(--mat-sys-outline-variant); cursor: pointer;
      font: 500 .75rem/1rem Roboto;
    }
    .dm-chip.active { background: color-mix(in oklch, var(--mat-sys-primary) var(--dm-badge-tint), var(--mat-sys-surface)); color: var(--mat-sys-primary); border-color: color-mix(in oklch, var(--mat-sys-primary) 40%, transparent); }
    .dm-app-pick { display: inline-flex; align-items: center; gap: .5rem; font: 500 .8125rem/1.25rem Roboto; color: var(--mat-sys-on-surface-variant); }
    .dm-app-pick select { padding: 4px 8px; border-radius: 8px; background: var(--mat-sys-surface-container); color: var(--mat-sys-on-surface); border: 1px solid var(--mat-sys-outline-variant); font: 500 .8125rem/1.25rem Roboto; }
    .dm-tl-viewport { height: calc(100vh - 240px); border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; background: var(--mat-sys-surface-container-lowest); }
    .dm-tl-row { display: grid; grid-template-columns: 80px 90px 160px 1fr; align-items: center; gap: .75rem; padding: 10px 14px; border-bottom: 1px solid color-mix(in oklch, var(--mat-sys-outline-variant) 50%, transparent); cursor: pointer; font: 500 .8125rem/1.25rem 'Roboto Mono', ui-monospace, monospace; }
    @media (max-width: 640px) { .dm-tl-row { grid-template-columns: 64px 1fr; gap: .25rem .5rem; } .dm-tl-row .dm-tl-app { display: none; } .dm-tl-row .dm-tl-summary { grid-column: 1 / -1; white-space: normal; } }
    .dm-tl-row:hover { background: var(--mat-sys-surface-container); }
    .dm-tl-ts { color: var(--mat-sys-on-surface-variant); }
    .dm-tl-kind { width: max-content; padding: 2px 8px; border-radius: 999px; font: 500 .6875rem/1rem Roboto; }
    .dm-tl-app { color: var(--mat-sys-primary); }
    .dm-tl-summary { color: var(--mat-sys-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* M85 search deep-link (?at=<ts>): highlights the row nearest the linked
       timestamp so a palette hit lands somewhere findable, not just "in view". */
    .dm-tl-row.dm-tl-anchored { background: color-mix(in oklch, var(--mat-sys-primary) var(--dm-badge-tint), transparent); outline: 2px solid var(--mat-sys-primary); outline-offset: -2px; }
    .dm-kind-chip[data-kind="status"]   { background: color-mix(in oklch, var(--mat-sys-primary) var(--dm-badge-tint), transparent);   color: var(--mat-sys-primary); }
    .dm-kind-chip[data-kind="error"]    { background: color-mix(in oklch, var(--mat-sys-error) var(--dm-badge-tint), transparent);     color: var(--mat-sys-error); }
    .dm-kind-chip[data-kind="warning"]  { background: color-mix(in oklch, var(--mat-sys-tertiary) var(--dm-badge-tint), transparent);  color: var(--mat-sys-tertiary); }
    .dm-kind-chip[data-kind="lint"]     { background: color-mix(in oklch, var(--mat-sys-secondary) var(--dm-badge-tint), transparent); color: var(--mat-sys-secondary); }
    .dm-kind-chip[data-kind="health"]   { background: color-mix(in oklch, var(--mat-sys-primary) var(--dm-badge-tint), transparent);   color: var(--mat-sys-primary); }
    .dm-kind-chip[data-kind="bundle"]   { background: color-mix(in oklch, var(--mat-sys-tertiary) var(--dm-badge-tint), transparent);  color: var(--mat-sys-tertiary); }
    .dm-kind-chip[data-kind="compile"]  { background: color-mix(in oklch, var(--mat-sys-secondary) var(--dm-badge-tint), transparent); color: var(--mat-sys-secondary); }
    .dm-kind-chip[data-kind="task"]     { background: color-mix(in oklch, var(--mat-sys-outline) 12%, transparent);   color: var(--mat-sys-on-surface-variant); }
    .dm-kind-chip[data-kind="restart"]  { background: color-mix(in oklch, var(--mat-sys-error) var(--dm-badge-tint), transparent);     color: var(--mat-sys-error); }
    .dm-tl-drawer { position: fixed; right: 1rem; top: 80px; bottom: 1rem; width: 420px; background: var(--mat-sys-surface-container-high); border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: 1rem; overflow: auto; box-shadow: var(--mat-sys-level3); z-index: 20; }
    .dm-tl-drawer header { display: flex; justify-content: space-between; gap: 1rem; margin-bottom: .75rem; }
    .dm-tl-drawer h2 { font: 500 1rem/1.5rem Roboto; margin: 0; }
    .dm-tl-drawer-ts { color: var(--mat-sys-on-surface-variant); font: 500 .75rem/1rem Roboto; }
    .dm-tl-drawer pre { white-space: pre-wrap; word-break: break-word; font: 500 .75rem/1.1rem 'Roboto Mono', ui-monospace, monospace; color: var(--mat-sys-on-surface); margin: 0; }
    .ib { width: 32px; height: 32px; background: transparent; border: 0; border-radius: 999px; color: var(--mat-sys-on-surface-variant); cursor: pointer; }
    .ib:hover { background: var(--mat-sys-surface-container-highest); }
    .spin { animation: dm-spin 1s linear infinite; }
    @keyframes dm-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  `],
})
export class TimelinePageComponent implements OnInit {
  // Search deep-link (M85): `/timeline?at=<ts>` from a palette "events" hit.
  // Bound automatically by withComponentInputBinding() — no ActivatedRoute
  // wiring needed. A window wide enough to contain the anchor is forced so
  // the hit isn't filtered out of view by the default 24h window.
  @Input() at?: string;

  readonly api = inject(DaimonApi);
  readonly allKinds = ALL_KINDS;
  readonly kindLabel = KIND_LABEL;
  readonly sinceOpts = SINCE_OPTS;
  readonly rows = signal<TimelineRow[]>([]);
  readonly loading = signal(false);
  readonly since = signal('24h');
  readonly app = signal('');
  readonly kinds = signal<Set<string>>(new Set(ALL_KINDS));
  readonly selected = signal<TimelineRow | null>(null);
  readonly anchoredTs = signal<number | null>(null);

  @ViewChild('viewport') viewport?: CdkVirtualScrollViewport;
  @ViewChild('drawer') private drawerRef?: ElementRef<HTMLElement>;
  // The row element that opened the drawer (M89) — refocused when the
  // drawer closes so keyboard users land back where they were instead of at
  // the top of the document. cdkVirtualFor recycles row DOM nodes, so this
  // can go stale on a fast scroll; select() falls back to the viewport.
  private lastTrigger: HTMLElement | null = null;

  readonly filtered = computed(() => {
    const ks = this.kinds();
    return this.rows().filter(r => ks.has(r.kind));
  });

  ngOnInit(): void {
    const anchorTs = Number(this.at);
    if (this.at && Number.isFinite(anchorTs)) {
      this.anchoredTs.set(anchorTs);
      // Widen the window enough to include the anchor if it predates 24h —
      // "7d" covers everything the search index itself can return a hit for.
      const ageMs = Date.now() - anchorTs;
      if (ageMs > 24 * 3600_000) this.since.set('7d');
    }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const rows = await this.api.getTimeline({
        since: this.since(),
        app: this.app() || undefined,
        // Don't pass kinds — keep server payload fat and filter client-side
        // so toggling chips is instant. The 5000-row cap keeps 7d×5k under 300ms.
      });
      this.rows.set(rows as TimelineRow[]);
      this.jumpToAnchor();
    } finally {
      this.loading.set(false);
    }
  }

  // Scrolls the virtual viewport to the row nearest the `?at=` anchor and
  // opens its detail drawer. Runs after each load since `rows` is replaced
  // wholesale (not appended), so the anchor row's index can move.
  private jumpToAnchor(): void {
    const anchor = this.anchoredTs();
    if (anchor == null) return;
    const rows = this.filtered();
    if (!rows.length) return;
    let nearestIdx = 0;
    let nearestDiff = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const diff = Math.abs(rows[i].ts - anchor);
      if (diff < nearestDiff) { nearestDiff = diff; nearestIdx = i; }
    }
    const nearest = rows[nearestIdx];
    this.anchoredTs.set(nearest.ts);
    this.selected.set(nearest);
    requestAnimationFrame(() => this.viewport?.scrollToIndex(Math.max(0, nearestIdx - 3), 'auto'));
  }

  setSince(k: string): void { this.since.set(k); void this.refresh(); }
  setApp(a: string): void { this.app.set(a); void this.refresh(); }
  toggleKind(k: string): void {
    const next = new Set(this.kinds());
    if (next.has(k)) next.delete(k); else next.add(k);
    this.kinds.set(next);
  }
  select(r: TimelineRow | null, ev?: Event): void {
    if (r) {
      this.lastTrigger = (ev?.currentTarget as HTMLElement | null) ?? null;
      this.selected.set(r);
      this.focusDrawerWhenReady();
    } else {
      this.selected.set(null);
      (this.lastTrigger && document.contains(this.lastTrigger) ? this.lastTrigger : this.viewport?.elementRef.nativeElement)?.focus();
      this.lastTrigger = null;
    }
  }

  // Drawer detail: Escape closes it and returns focus to the row that opened
  // it (M89) — matches the palette/topbar-popover Escape convention.
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.selected()) this.select(null);
  }

  private focusDrawerWhenReady(attempt = 0): void {
    if (this.drawerRef?.nativeElement) { this.drawerRef.nativeElement.focus(); return; }
    if (attempt >= 10) return;
    requestAnimationFrame(() => this.focusDrawerWhenReady(attempt + 1));
  }

  rel(ts: number): string {
    const d = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (d < 60) return `${d}s ago`;
    const m = Math.floor(d / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
  fullTs(ts: number): string { return new Date(ts).toISOString(); }
  payloadJson(p: any): string { try { return JSON.stringify(p, null, 2); } catch { return String(p); } }
  trackTs = (_: number, r: TimelineRow): number => r.ts;
}
