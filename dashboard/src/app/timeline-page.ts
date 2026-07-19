import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Input, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { DaimonApi } from './daimon-api';
import { EmptyStateComponent } from './ui-primitives';
import {
  announceRow,
  bucketizeTimeline,
  brushToRange,
  parseKindsParam,
  moveFocusIndex,
  rangeToPct,
  sessionWindow,
  type NavKey,
} from './timeline-page-helpers';

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

// Density strip resolution (M137). Fixed rather than measured off the
// container's live width — a static bucket count keeps the SVG cheap to
// re-render on every rows() change and the strip already scales visually via
// `viewBox` + `preserveAspectRatio="none"`.
const DENSITY_BUCKETS = 48;

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
            window {{ since() }} · app {{ appFilter() || 'all' }}
            @if (sessionLabel(); as sl) { · session <code>{{ sl }}</code> }
          </div>
        </div>
        <div class="dm-header-actions">
          <button type="button" class="ib" (click)="refresh()" [disabled]="loading()" aria-label="Refresh" title="Refresh">
            <span class="material-symbols-outlined" [class.spin]="loading()">refresh</span>
          </button>
        </div>
      </header>

      <!-- Event-density strip + drag-to-brush (M137). Bucketed over the
           loaded rows() (not the kind/range-filtered view) so the strip
           always shows the full shape of the fetched window. Classes are
           prefixed dm-tl-density (not dm-density) — the topbar's layout-
           density toggle already owns that class name. -->
      <div class="dm-tl-density-wrap">
        <div class="dm-tl-density" #densityEl
             role="img"
             [attr.aria-label]="rows().length + ' events over the ' + since() + ' window. Drag to narrow the visible range.'"
             (pointerdown)="onDensityPointerDown($event)"
             (pointermove)="onDensityPointerMove($event)"
             (pointerup)="onDensityPointerUp($event)"
             (pointercancel)="onDensityPointerUp($event)">
          <svg class="dm-tl-density-svg" viewBox="0 0 480 28" preserveAspectRatio="none" aria-hidden="true">
            @for (b of densityModel().buckets; track $index) {
              <rect
                [attr.x]="$index * barStep"
                [attr.width]="barStep * 0.82"
                [attr.y]="28 - barHeight(b.count)"
                [attr.height]="barHeight(b.count)"
                rx="0.5"></rect>
            }
          </svg>
          @if (dragPct(); as d) {
            <div class="dm-tl-density-drag" [style.left.%]="d.leftPct" [style.width.%]="d.widthPct"></div>
          }
          @if (brushPct(); as b) {
            <div class="dm-tl-density-active" [style.left.%]="b.leftPct" [style.width.%]="b.widthPct"></div>
          }
        </div>
        @if (brushRange(); as br) {
          <div class="dm-range-bar">
            <span class="material-symbols-outlined" aria-hidden="true">filter_alt</span>
            <span>{{ fullTs(br.from) }} — {{ fullTs(br.to) }}</span>
            <button type="button" class="dm-chip" (click)="resetRange()">Reset range</button>
          </div>
        }
      </div>

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
          <select [ngModel]="appFilter()" (ngModelChange)="setApp($event)">
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

      <!-- Roving-focus keyboard navigation (M137): arrows move a focused-row
           index, Home/End jump to the newest/oldest row, Enter opens the
           drawer. The announcement below is required for the axe/keyboard
           gate — a sighted-only highlight is not enough. -->
      <div class="dm-sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announceText() }}</div>

      @if (filtered().length === 0 && !loading()) {
        <dm-empty title="No events in window"
                  hint="Widen the window or pick different kinds. Status / error / lint / bundle / task all live here."></dm-empty>
      } @else {
        <cdk-virtual-scroll-viewport #viewport itemSize="44" class="dm-tl-viewport" tabindex="0"
                                     aria-label="Timeline events. Use arrow keys to move, Home and End to jump to the newest and oldest events, Enter to open details."
                                     (keydown)="onListKeydown($event)">
          <div *cdkVirtualFor="let r of filtered(); trackBy: trackTs; let i = index"
               class="dm-tl-row" [attr.data-kind]="r.kind"
               [class.dm-tl-anchored]="anchoredTs() === r.ts"
               [class.dm-tl-kbfocus]="focusedIndex() === i"
               role="button" tabindex="0"
               [attr.aria-label]="r.app + ' · ' + (kindLabel[r.kind] || r.kind) + ' · ' + r.summary"
               (click)="select(r, $event, i)"
               (keydown.enter)="select(r, $event, i)"
               (keydown.space)="$event.preventDefault(); select(r, $event, i)">
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
    .dm-page-sub code { font-family: 'Roboto Mono', ui-monospace, monospace; }
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

    .dm-tl-density-wrap { margin-bottom: 1rem; }
    .dm-tl-density {
      position: relative; height: 40px; padding: 6px 0;
      border: 1px solid var(--mat-sys-outline-variant); border-radius: 10px;
      background: var(--mat-sys-surface-container-lowest);
      touch-action: none; cursor: crosshair; overflow: hidden;
    }
    .dm-tl-density-svg { width: 100%; height: 28px; display: block; }
    .dm-tl-density-svg rect { fill: color-mix(in oklch, var(--mat-sys-primary) 55%, transparent); }
    .dm-tl-density-drag, .dm-tl-density-active {
      position: absolute; top: 0; bottom: 0; pointer-events: none;
      background: color-mix(in oklch, var(--mat-sys-primary) 18%, transparent);
      border-left: 1px solid var(--mat-sys-primary); border-right: 1px solid var(--mat-sys-primary);
    }
    .dm-range-bar {
      display: flex; align-items: center; gap: .5rem; margin-top: .5rem;
      font: 500 .75rem/1rem 'Roboto Mono', ui-monospace, monospace; color: var(--mat-sys-on-surface-variant);
    }
    .dm-range-bar .material-symbols-outlined { font-size: 16px; color: var(--mat-sys-primary); }

    .dm-tl-viewport { height: calc(100vh - 300px); border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; background: var(--mat-sys-surface-container-lowest); }
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
    /* Roving keyboard focus (M137) — distinct from the anchor highlight so
       "where the search landed" and "where the keyboard is" never look the
       same when they coincide. */
    .dm-tl-row.dm-tl-kbfocus { box-shadow: inset 0 0 0 2px var(--mat-sys-secondary); }
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
  // Deep-link inputs (M85 + M137), bound automatically by
  // withComponentInputBinding() — no ActivatedRoute wiring needed.
  //  - `at` (legacy) / `ts` (M137 alias): anchor at a timestamp.
  //  - `app`: preset the app filter.
  //  - `kind`: preset the kind filter (comma-separated).
  //  - `session`: fetch GET /api/sessions/<id>, window the view to
  //    [start, end], anchor at start.
  @Input() at?: string;
  @Input() ts?: string;
  @Input() app?: string;
  @Input() kind?: string;
  @Input() session?: string;

  readonly api = inject(DaimonApi);
  readonly allKinds = ALL_KINDS;
  readonly kindLabel = KIND_LABEL;
  readonly sinceOpts = SINCE_OPTS;
  readonly barStep = 480 / DENSITY_BUCKETS;
  readonly rows = signal<TimelineRow[]>([]);
  readonly loading = signal(false);
  readonly since = signal('24h');
  // Renamed from the old `app` signal (M137) — `app` is now the @Input()
  // deep-link property above, so the internal filter state needs a distinct
  // name to avoid colliding with it.
  readonly appFilter = signal('');
  readonly kinds = signal<Set<string>>(new Set(ALL_KINDS));
  readonly selected = signal<TimelineRow | null>(null);
  readonly anchoredTs = signal<number | null>(null);
  readonly sessionLabel = signal<string | null>(null);

  // Client-side brush window (M137) — narrows `filtered()` without
  // re-fetching. Set either by dragging the density strip or by a
  // `?session=` deep link (covering [start, end]).
  readonly brushRange = signal<{ from: number; to: number } | null>(null);
  // A `since` override used instead of the chip value — set by a `?session=`
  // deep link whose start may predate every chip window (1h/24h/7d).
  private sinceOverride: string | null = null;

  // In-progress drag (pixel space, relative to the density strip's own
  // width) — cleared on pointerup once committed to `brushRange`.
  private readonly dragPx = signal<{ x1: number; x2: number } | null>(null);
  private densityWidthPx = 0;

  // Roving keyboard focus (M137).
  readonly focusedIndex = signal<number>(-1);
  readonly announceText = signal<string>('');

  @ViewChild('viewport') viewport?: CdkVirtualScrollViewport;
  @ViewChild('drawer') private drawerRef?: ElementRef<HTMLElement>;
  @ViewChild('densityEl') private densityRef?: ElementRef<HTMLElement>;
  // The row element that opened the drawer (M89) — refocused when the
  // drawer closes so keyboard users land back where they were instead of at
  // the top of the document. cdkVirtualFor recycles row DOM nodes, so this
  // can go stale on a fast scroll; select() falls back to the viewport.
  private lastTrigger: HTMLElement | null = null;

  readonly filtered = computed(() => {
    const ks = this.kinds();
    const br = this.brushRange();
    return this.rows().filter(r => ks.has(r.kind) && (!br || (r.ts >= br.from && r.ts <= br.to)));
  });

  readonly densityModel = computed(() => bucketizeTimeline(this.rows(), DENSITY_BUCKETS));

  readonly dragPct = computed(() => {
    const drag = this.dragPx();
    const width = this.densityWidthPx;
    if (!drag || width <= 0) return null;
    const lo = Math.min(drag.x1, drag.x2);
    const hi = Math.max(drag.x1, drag.x2);
    return { leftPct: (lo / width) * 100, widthPct: ((hi - lo) / width) * 100 };
  });

  readonly brushPct = computed(() => {
    const br = this.brushRange();
    const dm = this.densityModel();
    if (!br || dm.domainMax <= dm.domainMin) return null;
    return rangeToPct(br, dm.domainMin, dm.domainMax);
  });

  ngOnInit(): void {
    const anchorRaw = this.ts ?? this.at;
    const anchorTs = Number(anchorRaw);
    if (anchorRaw && Number.isFinite(anchorTs)) {
      this.anchoredTs.set(anchorTs);
      // Widen the window enough to include the anchor if it predates 24h —
      // "7d" covers everything the search index itself can return a hit for.
      const ageMs = Date.now() - anchorTs;
      if (ageMs > 24 * 3600_000) this.since.set('7d');
    }
    if (this.app) this.appFilter.set(this.app);
    const kindPreset = parseKindsParam(this.kind, ALL_KINDS);
    if (kindPreset) this.kinds.set(kindPreset);

    if (this.session) {
      void this.loadSession(this.session);
      return;
    }
    void this.refresh();
  }

  // `?session=<id>` (M137): fetches the session's bounds, widens the fetch
  // `since` to cover its start (which may predate every chip window), sets
  // the client-side window to [start, end], and anchors at start — reusing
  // the same brush + anchor plumbing a drag or a `?at=` link uses.
  private async loadSession(id: string): Promise<void> {
    this.loading.set(true);
    try {
      const detail = await this.api.getSession(id);
      if (!detail) {
        // Unknown/gone session id — fall back to the default window rather
        // than showing an empty page with no explanation.
        await this.refresh();
        return;
      }
      this.sessionLabel.set(detail.id);
      const win = sessionWindow(detail);
      this.sinceOverride = String(win.from);
      await this.fetchRows();
      this.brushRange.set(win);
      this.anchoredTs.set(win.from);
      // Reuses the same "scroll to + open drawer for the nearest row" path a
      // `?ts=`/`?at=` anchor uses — `filtered()` already reflects the brush
      // set just above, so this lands inside the session window, not outside it.
      this.jumpToAnchor();
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      await this.fetchRows();
      this.jumpToAnchor();
    } finally {
      this.loading.set(false);
    }
  }

  private async fetchRows(): Promise<void> {
    const rows = await this.api.getTimeline({
      since: this.sinceOverride ?? this.since(),
      app: this.appFilter() || undefined,
      // Don't pass kinds — keep server payload fat and filter client-side
      // so toggling chips is instant. The 5000-row cap keeps 7d×5k under 300ms.
    });
    this.rows.set(rows as TimelineRow[]);
  }

  // Scrolls the virtual viewport to the row nearest the `?at=`/`?ts=` anchor
  // and opens its detail drawer. Runs after each load since `rows` is
  // replaced wholesale (not appended), so the anchor row's index can move.
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
    this.focusedIndex.set(nearestIdx);
    requestAnimationFrame(() => this.viewport?.scrollToIndex(Math.max(0, nearestIdx - 3), 'auto'));
  }

  setSince(k: string): void {
    this.since.set(k);
    this.sinceOverride = null;
    this.sessionLabel.set(null);
    void this.refresh();
  }
  setApp(a: string): void { this.appFilter.set(a); void this.refresh(); }
  toggleKind(k: string): void {
    const next = new Set(this.kinds());
    if (next.has(k)) next.delete(k); else next.add(k);
    this.kinds.set(next);
  }

  // Clears the client-side brush window without touching the fetched rows —
  // a session-driven fetch (which may have widened `since` well past the
  // active chip) keeps its data; only the visual narrowing resets.
  resetRange(): void {
    this.brushRange.set(null);
    this.sessionLabel.set(null);
  }

  // --- density strip drag-to-brush (M137) ---------------------------------

  onDensityPointerDown(ev: PointerEvent): void {
    const el = this.densityRef?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    this.densityWidthPx = rect.width;
    const x = ev.clientX - rect.left;
    this.dragPx.set({ x1: x, x2: x });
    try { el.setPointerCapture(ev.pointerId); } catch { /* not all environments support it */ }
  }

  onDensityPointerMove(ev: PointerEvent): void {
    const drag = this.dragPx();
    if (!drag) return;
    const el = this.densityRef?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, ev.clientX - rect.left), rect.width);
    this.dragPx.set({ x1: drag.x1, x2: x });
  }

  onDensityPointerUp(_ev: PointerEvent): void {
    const drag = this.dragPx();
    this.dragPx.set(null);
    if (!drag) return;
    const dm = this.densityModel();
    if (dm.domainMax <= dm.domainMin) return;
    const range = brushToRange(drag.x1, drag.x2, this.densityWidthPx, dm.domainMin, dm.domainMax);
    if (range) this.brushRange.set(range);
  }

  barHeight(count: number): number {
    if (count <= 0) return 1;
    // Gentle log scale so one noisy bucket doesn't flatten the rest.
    return Math.min(28, 4 + Math.log2(count + 1) * 7);
  }

  // --- roving keyboard navigation (M137) ----------------------------------

  onListKeydown(ev: KeyboardEvent): void {
    const rows = this.filtered();
    if (!rows.length) return;
    let navKey: NavKey | null = null;
    if (ev.key === 'ArrowDown') navKey = 'down';
    else if (ev.key === 'ArrowUp') navKey = 'up';
    else if (ev.key === 'Home') navKey = 'home';
    else if (ev.key === 'End') navKey = 'end';
    else if (ev.key === 'Enter') {
      const idx = this.focusedIndex();
      if (idx >= 0 && idx < rows.length) { ev.preventDefault(); this.select(rows[idx], ev, idx); }
      return;
    }
    if (!navKey) return;
    ev.preventDefault();
    const next = moveFocusIndex(this.focusedIndex(), navKey, rows.length);
    this.focusedIndex.set(next);
    const row = rows[next];
    if (row) {
      this.announceText.set(announceRow(row, this.kindLabel));
      this.viewport?.scrollToIndex(Math.max(0, next - 2), 'auto');
    }
  }

  select(r: TimelineRow | null, ev?: Event, index?: number): void {
    if (r) {
      this.lastTrigger = (ev?.currentTarget as HTMLElement | null) ?? null;
      this.selected.set(r);
      if (index != null) this.focusedIndex.set(index);
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
