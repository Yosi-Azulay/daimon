import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AppRow, DaimonApi, LockSnapshot } from './daimon-api';
import { SkeletonComponent, EmptyStateComponent, MonoComponent, StatusPillComponent } from './ui-primitives';
import { workspaceTone } from './workspace-tone';

type ViewMode = 'cards' | 'list';
type StatusFilter = 'all' | 'serving' | 'errors' | 'stopped';
type ActionKind = 'start' | 'stop' | 'restart';

const VIEW_KEY = 'daimon.apps.view';
const WS_KEY = 'daimon.workspace';
const TAGS_KEY = 'daimon.apps.tags';

@Component({
  selector: 'dm-apps-cards',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTooltipModule, MatProgressSpinnerModule, StatusPillComponent, MonoComponent],
  template: `
    <div class="g">
      @for (a of items; track a.name; let i = $index) {
        <article
          class="c"
          [class.f]="i === focusedIndex"
          [style.--dm-tone]="tone(a.workspaceLabel)"
          (click)="open.emit(a.name)"
          (mouseenter)="focus.emit(i)"
          role="button" tabindex="0"
          (keydown.enter)="open.emit(a.name)">
          <div class="ac"></div>
          <div class="rb" [matTooltip]="ribbonTooltip(a.name)" aria-hidden="true">
            @for (t of ribbonTicks(a.name); track $index) {
              <span class="tk" [attr.data-k]="t"></span>
            }
          </div>
          <div class="h">
            <dm-status-pill [status]="a.status" [health]="a.health" [eta]="eta(a)"></dm-status-pill>
            @if (a.errorCount > 0) {
              <span class="eb" [matTooltip]="a.errorCount + ' errors'">
                <span class="material-symbols-outlined">error</span>{{ a.errorCount }}
              </span>
            }
          </div>
          <div class="n"><dm-mono>{{ a.name }}</dm-mono></div>
          <div class="m">
            @if (a.port != null) {
              <span class="mi" matTooltip="Port">
                <span class="material-symbols-outlined">lan</span><dm-mono>{{ a.port }}</dm-mono>
              </span>
            }
            @if (a.url) {
              <a class="mi ml" [href]="a.url" target="_blank" rel="noopener" (click)="$event.stopPropagation()">
                <span class="material-symbols-outlined">open_in_new</span><dm-mono>{{ a.url }}</dm-mono>
              </a>
            }
          </div>
          @if (lockFor(a.name) || agentChips(a.name).length) {
            <div class="agr">
              @if (lockFor(a.name); as lk) {
                <span class="lkc" [matTooltip]="'locked by ' + lk.agent + ' · expires in ' + lockTtl(lk)">
                  🔒 <dm-mono>{{ lk.agent }}</dm-mono><span class="ttl">{{ lockTtl(lk) }}</span>
                </span>
              }
              @for (g of agentChips(a.name); track g) {
                <span class="agc" matTooltip="recently interacted"><dm-mono>{{ g }}</dm-mono></span>
              }
            </div>
          }
          <div class="ft">
            <div class="tg">
              @if (a.workspaceLabel) {
                <span class="ws"><span class="material-symbols-outlined">folder_open</span>{{ a.workspaceLabel }}</span>
              }
              @if (a.lastChangeMs) { <span class="sn">{{ fmtSince(a.lastChangeMs) }}</span> }
            </div>
            <div class="ax" (click)="$event.stopPropagation()">
              @if (a.status === 'stopped' || a.status === 'error') {
                <button class="ib" [disabled]="isBusy(a.name,'start')" (click)="act.emit({ name: a.name, kind: 'start' })" matTooltip="Start (s)" aria-label="Start">
                  @if (isBusy(a.name,'start')) { <mat-spinner diameter="16"></mat-spinner> }
                  @else { <span class="material-symbols-outlined">play_arrow</span> }
                </button>
              } @else {
                <button class="ib" [disabled]="isBusy(a.name,'stop')" (click)="act.emit({ name: a.name, kind: 'stop' })" matTooltip="Stop (x)" aria-label="Stop">
                  @if (isBusy(a.name,'stop')) { <mat-spinner diameter="16"></mat-spinner> }
                  @else { <span class="material-symbols-outlined">stop</span> }
                </button>
              }
              <button class="ib" [disabled]="isBusy(a.name,'restart')" (click)="act.emit({ name: a.name, kind: 'restart' })" matTooltip="Restart (r)" aria-label="Restart">
                @if (isBusy(a.name,'restart')) { <mat-spinner diameter="16"></mat-spinner> }
                @else { <span class="material-symbols-outlined">restart_alt</span> }
              </button>
            </div>
          </div>
        </article>
      }
    </div>
  `,
  styles: [`
    :host{display:block}
    .g{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem}
    .c{position:relative;display:flex;flex-direction:column;background:var(--mat-sys-surface-container-low);border:1px solid var(--mat-sys-outline-variant);border-radius:14px;overflow:hidden;cursor:pointer;transition:box-shadow var(--dm-motion-short) var(--dm-motion-easing),transform var(--dm-motion-short) var(--dm-motion-easing),border-color var(--dm-motion-short) var(--dm-motion-easing)}
    .c:hover{box-shadow:var(--mat-sys-level2);transform:translateY(-1px)}
    .c.f{border-color:var(--mat-sys-primary);box-shadow:0 0 0 2px color-mix(in oklch,var(--mat-sys-primary) 25%,transparent)}
    .ac{height:4px;background:var(--dm-tone,var(--mat-sys-surface-container))}
    .rb{display:flex;gap:1px;height:6px;padding:0 .75rem;align-items:center;background:var(--mat-sys-surface-container-lowest)}
    .rb .tk{flex:1;height:6px;border-radius:1px;background:var(--mat-sys-surface-container)}
    .rb .tk[data-k="serving"]{background:color-mix(in oklch,var(--mat-sys-primary) 60%,transparent)}
    .rb .tk[data-k="error"]{background:var(--mat-sys-error)}
    .rb .tk[data-k="starting"],.rb .tk[data-k="compiling"]{background:color-mix(in oklch,var(--mat-sys-tertiary) 70%,transparent)}
    .rb .tk[data-k="stopped"]{background:var(--mat-sys-outline-variant)}
    .h{display:flex;align-items:center;justify-content:space-between;padding:.75rem .875rem 0}
    .n{padding:.375rem .875rem 0;font:500 1.05rem/1.5rem Roboto}
    .n .dm-mono{font-size:1.05rem;font-weight:500}
    .m{padding:.25rem .875rem .5rem;display:flex;flex-wrap:wrap;gap:.75rem;color:var(--mat-sys-on-surface-variant)}
    .mi{display:inline-flex;align-items:center;gap:.25rem;font-size:.8125rem}
    .mi .material-symbols-outlined{font-size:14px}
    .ml{color:var(--mat-sys-primary);text-decoration:none}
    .ml:hover{text-decoration:underline}
    .agr{padding:0 .875rem .5rem;display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}
    .agc,.lkc{display:inline-flex;align-items:center;gap:.25rem;padding:1px 8px;border-radius:999px;font:500 .6875rem/1rem Roboto;background:var(--mat-sys-surface-container);color:var(--mat-sys-on-surface-variant);border:1px solid var(--mat-sys-outline-variant)}
    .agc .dm-mono,.lkc .dm-mono{font-size:.6875rem}
    .lkc{background:color-mix(in oklch,var(--mat-sys-tertiary) 12%,transparent);border-color:color-mix(in oklch,var(--mat-sys-tertiary) 28%,transparent);color:var(--mat-sys-on-surface)}
    .lkc .ttl{font:600 .625rem/1rem var(--dm-mono);color:var(--mat-sys-on-surface-variant)}
    .ft{margin-top:auto;padding:.5rem .75rem .5rem .875rem;display:flex;align-items:center;justify-content:space-between;gap:.5rem;border-top:1px solid var(--mat-sys-outline-variant)}
    .tg{display:inline-flex;align-items:center;gap:.5rem;flex-wrap:wrap;min-width:0}
    .ws{display:inline-flex;align-items:center;gap:.25rem;padding:2px 8px;border-radius:999px;font:500 .6875rem/1rem Roboto;background:var(--mat-sys-surface-container);color:var(--mat-sys-on-surface-variant);border:1px solid var(--mat-sys-outline-variant)}
    .ws .material-symbols-outlined{font-size:12px}
    .sn{font:400 .6875rem/1rem Roboto;color:var(--mat-sys-on-surface-variant)}
    .ax{display:inline-flex;gap:.25rem}
    .ib{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:transparent;border:0;border-radius:8px;color:var(--mat-sys-on-surface-variant);cursor:pointer;transition:background var(--dm-motion-short) var(--dm-motion-easing),color var(--dm-motion-short) var(--dm-motion-easing)}
    .ib:hover:not(:disabled){background:var(--mat-sys-surface-container-high);color:var(--mat-sys-on-surface)}
    .ib:disabled{opacity:.55;cursor:not-allowed}
    .ib .material-symbols-outlined{font-size:18px}
    .eb{display:inline-flex;align-items:center;gap:.25rem;padding:1px 8px;border-radius:999px;font:600 .75rem/1rem var(--dm-mono);background:color-mix(in oklch,var(--mat-sys-error) 14%,transparent);color:var(--mat-sys-error);border:1px solid color-mix(in oklch,var(--mat-sys-error) 30%,transparent)}
    .eb .material-symbols-outlined{font-size:14px}
  `],
})
export class AppsCardsViewComponent {
  @Input() items: AppRow[] = [];
  @Input() focusedIndex = 0;
  @Input() busy: Record<string, Record<string, boolean>> = {};
  @Output() open = new EventEmitter<string>();
  @Output() focus = new EventEmitter<number>();
  @Output() act = new EventEmitter<{ name: string; kind: ActionKind }>();
  readonly tone = workspaceTone;
  private readonly api = inject(DaimonApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly now = signal<number>(Date.now());

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => clearInterval(t));
  }

  // 20 ticks across a 60-min rolling window. Empty buckets render as the
  // surface-container tone; status-bearing buckets win over earlier ones in
  // the order error > compiling > serving > stopped.
  private readonly RIBBON_BUCKETS = 20;
  private readonly RIBBON_WINDOW_MS = 60 * 60 * 1000;

  private readonly perAppTicks = computed<Map<string, string[]>>(() => {
    const evs = this.api.events();
    const now = Date.now();
    const cutoff = now - this.RIBBON_WINDOW_MS;
    const bucketMs = this.RIBBON_WINDOW_MS / this.RIBBON_BUCKETS;
    const out = new Map<string, string[]>();
    const ranks: Record<string, number> = { stopped: 1, serving: 2, compiling: 3, starting: 3, error: 4 };
    for (const ev of evs) {
      if (ev.type !== 'status' || !ev.app || !ev.to) continue;
      if (ev.ts < cutoff) continue;
      const idx = Math.min(this.RIBBON_BUCKETS - 1, Math.floor((ev.ts - cutoff) / bucketMs));
      let arr = out.get(ev.app);
      if (!arr) { arr = new Array(this.RIBBON_BUCKETS).fill(''); out.set(ev.app, arr); }
      const prev = arr[idx];
      if (!prev || (ranks[ev.to] ?? 0) > (ranks[prev] ?? 0)) arr[idx] = ev.to;
    }
    return out;
  });

  isBusy(name: string, kind: string): boolean { return !!this.busy[name]?.[kind]; }
  lockFor(name: string): LockSnapshot | null {
    const lk = this.api.agentLocks()[name];
    return lk && lk.expiresAt > this.now() ? lk : null;
  }
  lockTtl(lk: LockSnapshot): string {
    const d = Math.max(0, Math.ceil((lk.expiresAt - this.now()) / 1000));
    return d < 60 ? `${d}s` : `${Math.floor(d / 60)}m ${d % 60}s`;
  }
  agentChips(name: string): string[] {
    const lk = this.lockFor(name);
    return (this.api.appAgents()[name] ?? [])
      .filter(e => !lk || e.agent !== lk.agent)
      .map(e => e.agent);
  }
  eta(a: AppRow): string {
    if (a.status !== 'compiling' || a.estimatedReadyAtMs == null) return '';
    return '~' + Math.max(0, Math.ceil((a.estimatedReadyAtMs - this.now()) / 1000)) + 's';
  }
  ribbonTicks(name: string): string[] {
    return this.perAppTicks().get(name) ?? new Array(this.RIBBON_BUCKETS).fill('');
  }
  ribbonTooltip(name: string): string {
    const ticks = this.perAppTicks().get(name);
    if (!ticks) return 'no status events in the last 60 min';
    const counts: Record<string, number> = {};
    for (const t of ticks) if (t) counts[t] = (counts[t] ?? 0) + 1;
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
    return parts ? `last 60 min: ${parts}` : 'no status events in the last 60 min';
  }
  fmtSince(ms: number | null | undefined): string {
    if (!ms || ms <= 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
}

@Component({
  selector: 'dm-apps-list-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTooltipModule, MatProgressSpinnerModule, StatusPillComponent, MonoComponent],
  template: `
    <div class="ls" role="table">
      <div class="rw rh" role="row">
        <div>status</div><div>name</div><div>workspace</div><div>port</div>
        <div>uptime</div><div>cpu</div><div>mem</div><div>err</div><div class="ar">actions</div>
      </div>
      @for (a of items; track a.name; let i = $index) {
        <div class="rw" role="row"
          [class.f]="i === focusedIndex"
          [style.--dm-tone]="tone(a.workspaceLabel)"
          (click)="open.emit(a.name)" (mouseenter)="focus.emit(i)"
          tabindex="0" (keydown.enter)="open.emit(a.name)">
          <div><dm-status-pill [status]="a.status" [health]="a.health"></dm-status-pill></div>
          <div class="nm"><span class="tn"></span><dm-mono>{{ a.name }}</dm-mono></div>
          <div class="ws">{{ a.workspaceLabel || '—' }}</div>
          <div class="sm"><dm-mono>{{ a.port ?? '—' }}</dm-mono></div>
          <div class="sm"><dm-mono>{{ fmtUptime(a.uptimeMs) }}</dm-mono></div>
          <div class="sm"><dm-mono>{{ fmtPct(a.cpu) }}</dm-mono></div>
          <div class="sm"><dm-mono>{{ fmtMem(a.memMB) }}</dm-mono></div>
          <div>
            @if (a.errorCount > 0) { <span class="eb">{{ a.errorCount }}</span> }
            @else { <span class="dm">0</span> }
          </div>
          <div class="ax" (click)="$event.stopPropagation()">
            @if (a.status === 'stopped' || a.status === 'error') {
              <button class="ib" [disabled]="isBusy(a.name,'start')" (click)="act.emit({ name: a.name, kind: 'start' })" matTooltip="Start" aria-label="Start">
                @if (isBusy(a.name,'start')) { <mat-spinner diameter="14"></mat-spinner> }
                @else { <span class="material-symbols-outlined">play_arrow</span> }
              </button>
            } @else {
              <button class="ib" [disabled]="isBusy(a.name,'stop')" (click)="act.emit({ name: a.name, kind: 'stop' })" matTooltip="Stop" aria-label="Stop">
                @if (isBusy(a.name,'stop')) { <mat-spinner diameter="14"></mat-spinner> }
                @else { <span class="material-symbols-outlined">stop</span> }
              </button>
            }
            <button class="ib" [disabled]="isBusy(a.name,'restart')" (click)="act.emit({ name: a.name, kind: 'restart' })" matTooltip="Restart" aria-label="Restart">
              @if (isBusy(a.name,'restart')) { <mat-spinner diameter="14"></mat-spinner> }
              @else { <span class="material-symbols-outlined">restart_alt</span> }
            </button>
            @if (a.url) {
              <a class="ib" [href]="a.url" target="_blank" rel="noopener" matTooltip="Open" aria-label="Open">
                <span class="material-symbols-outlined">open_in_new</span>
              </a>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host{display:block}
    .ls{background:var(--mat-sys-surface-container-low);border:1px solid var(--mat-sys-outline-variant);border-radius:12px;overflow:hidden}
    .rw{display:grid;align-items:center;gap:.75rem;grid-template-columns:110px minmax(160px,1.5fr) minmax(100px,1fr) 70px 80px 70px 80px 60px 140px;padding:0 .875rem;min-height:36px;cursor:pointer;position:relative;border-bottom:1px solid var(--mat-sys-outline-variant);transition:background var(--dm-motion-short) var(--dm-motion-easing)}
    .rw:last-child{border-bottom:0}
    .rw:hover{background:var(--mat-sys-surface-container)}
    .rw.f{background:color-mix(in oklch,var(--mat-sys-primary) 8%,transparent)}
    .rw.f::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--mat-sys-primary)}
    .rh{min-height:30px;background:var(--mat-sys-surface-container);cursor:default;font:500 .6875rem/1rem Roboto;text-transform:uppercase;letter-spacing:.04rem;color:var(--mat-sys-on-surface-variant)}
    .rh:hover{background:var(--mat-sys-surface-container)}
    .nm{display:flex;align-items:center;gap:.5rem;min-width:0;overflow:hidden}
    .nm .dm-mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tn{width:3px;height:18px;border-radius:2px;background:var(--dm-tone,var(--mat-sys-surface-container));flex-shrink:0}
    .ws{font-size:.8125rem;color:var(--mat-sys-on-surface-variant);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sm{font-size:.8125rem}
    .ar,.ax{display:inline-flex;gap:.125rem;justify-content:flex-end}
    .dm{color:var(--mat-sys-on-surface-variant);font-size:.8125rem}
    .ib{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:transparent;border:0;border-radius:6px;color:var(--mat-sys-on-surface-variant);cursor:pointer;transition:background var(--dm-motion-short) var(--dm-motion-easing),color var(--dm-motion-short) var(--dm-motion-easing);text-decoration:none}
    .ib:hover:not(:disabled){background:var(--mat-sys-surface-container-high);color:var(--mat-sys-on-surface)}
    .ib:disabled{opacity:.55;cursor:not-allowed}
    .ib .material-symbols-outlined{font-size:16px}
    .eb{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;font:600 .75rem/1rem var(--dm-mono);background:color-mix(in oklch,var(--mat-sys-error) 14%,transparent);color:var(--mat-sys-error);border:1px solid color-mix(in oklch,var(--mat-sys-error) 30%,transparent)}
    @media (max-width:1000px){.rw{grid-template-columns:100px minmax(120px,1fr) 70px 70px 60px 110px}.rw .ws,.rw .sm:nth-of-type(3),.rw .sm:nth-of-type(4){display:none}}
  `],
})
export class AppsListViewComponent {
  @Input() items: AppRow[] = [];
  @Input() focusedIndex = 0;
  @Input() busy: Record<string, Record<string, boolean>> = {};
  @Output() open = new EventEmitter<string>();
  @Output() focus = new EventEmitter<number>();
  @Output() act = new EventEmitter<{ name: string; kind: ActionKind }>();
  readonly tone = workspaceTone;
  isBusy(name: string, kind: string): boolean { return !!this.busy[name]?.[kind]; }
  fmtUptime(ms: number | null | undefined): string {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  fmtPct(v: number | null | undefined): string {
    if (v == null || isNaN(v)) return '—';
    return v.toFixed(0) + '%';
  }
  fmtMem(v: number | null | undefined): string {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1024) return (v / 1024).toFixed(1) + 'G';
    return Math.round(v) + 'M';
  }
}

@Component({
  selector: 'dm-apps-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatIconModule,
    MatTooltipModule,
    SkeletonComponent,
    EmptyStateComponent,
    MonoComponent,
    AppsCardsViewComponent,
    AppsListViewComponent,
  ],
  template: `
    <div class="dm-page">
      @if (api.overview(); as ov) {
        <section class="dm-overview">
          <div class="dm-totals-row">
            <div class="dm-total"><span class="dm-total-num">{{ ov.totals.apps }}</span><span class="dm-total-label">apps</span></div>
            <div class="dm-total dm-total-serving"><span class="dm-total-num">{{ ov.totals.serving }}</span><span class="dm-total-label">serving</span></div>
            <div class="dm-total dm-total-error" [class.dm-zero]="!ov.totals.errors"><span class="dm-total-num">{{ ov.totals.errors }}</span><span class="dm-total-label">errored</span></div>
            <div class="dm-total"><span class="dm-total-num">{{ ov.totals.stopped }}</span><span class="dm-total-label">stopped</span></div>
            @if (ov.totals.totalErrCount > 0) {
              <div class="dm-total dm-total-error"><span class="dm-total-num">{{ ov.totals.totalErrCount }}</span><span class="dm-total-label">errors</span></div>
            }
          </div>
          @if (ov.needsAttention.length) {
            <div class="dm-attention">
              <div class="dm-att-title">
                <span class="material-symbols-outlined">priority_high</span>Needs attention
              </div>
              <div class="dm-att-list">
                @for (n of ov.needsAttention; track n.name) {
                  <a class="dm-att-row" [routerLink]="['/apps', n.name]">
                    <strong>{{ n.name }}</strong>
                    <span class="dm-att-meta">{{ n.errCount }} {{ n.errCount === 1 ? 'error' : 'errors' }}</span>
                    @if (n.firstError) {
                      <dm-mono>
                        <span class="dm-att-where">{{ n.firstError.file }}:{{ n.firstError.line }}</span>
                        @if (n.firstError.code) { <span class="dm-att-code"> {{ n.firstError.code }}</span> }
                      </dm-mono>
                    }
                  </a>
                }
              </div>
            </div>
          }
        </section>
      }

      <header class="dm-page-header">
        <div>
          <h1>Apps</h1>
          <div class="dm-page-sub">
            {{ filtered().length }} of {{ api.apps().length }} visible
            @if (workspace()) { · workspace <dm-mono>{{ workspace() }}</dm-mono> }
          </div>
        </div>
        <div class="dm-header-actions">
          <div class="dm-toggle" role="group" aria-label="View mode">
            <button type="button" [class.active]="view() === 'cards'" (click)="setView('cards')" matTooltip="Cards (.)" aria-label="Cards view">
              <span class="material-symbols-outlined">grid_view</span>
            </button>
            <button type="button" [class.active]="view() === 'list'" (click)="setView('list')" matTooltip="Dense list (.)" aria-label="List view">
              <span class="material-symbols-outlined">view_list</span>
            </button>
          </div>
        </div>
      </header>

      <div class="dm-filterbar">
        <div class="dm-search">
          <span class="material-symbols-outlined dm-search-icon">search</span>
          <input #searchInput type="search" placeholder="Filter apps by name, tag, workspace…"
                 [value]="query()" (input)="onQuery($any($event.target).value)" aria-label="Filter apps" />
          @if (query()) {
            <button type="button" class="dm-search-clear" (click)="onQuery('')" aria-label="Clear">
              <span class="material-symbols-outlined">close</span>
            </button>
          }
        </div>
        <div class="dm-chips" role="tablist" aria-label="Status filter">
          @for (f of statusFilters; track f.key) {
            <button type="button" role="tab" [attr.aria-selected]="status() === f.key"
                    class="dm-chip" [class.active]="status() === f.key" (click)="setStatus(f.key)">
              {{ f.label }}<span class="dm-chip-count">{{ countFor(f.key) }}</span>
            </button>
          }
        </div>
        @if (allTags().length) {
          <div class="dm-chips dm-tag-row" role="group" aria-label="Tag filter">
            @for (t of allTags(); track t) {
              <button type="button" class="dm-chip" [class.active]="isTagSelected(t)"
                      [attr.aria-pressed]="isTagSelected(t)" (click)="toggleTag(t)">{{ t }}</button>
            }
            @if (selectedTags().size) {
              <button type="button" class="dm-chip dm-chip-clear" (click)="clearTags()"
                      aria-label="Clear tag filter">
                <span class="material-symbols-outlined">close</span>
              </button>
            }
          </div>
        }
      </div>

      @if (!api.ready()) {
        <div class="dm-grid-sk">
          @for (i of skeletonItems; track i) {
            <article class="dm-card-sk">
              <div class="dm-sk-accent"></div>
              <div class="dm-sk-body">
                <dm-skeleton width="60%" height="1.25rem"></dm-skeleton>
                <dm-skeleton width="40%" height=".875rem"></dm-skeleton>
                <dm-skeleton width="80%" height=".875rem"></dm-skeleton>
              </div>
            </article>
          }
        </div>
      } @else if (api.apps().length === 0) {
        <dm-empty icon="rocket_launch" title="No apps discovered yet"
                  hint="Run daimon init --auto in your workspace to discover apps, or run /discover. The doctor page can help diagnose missing apps.">
          <div class="dm-empty-actions">
            <a routerLink="/doctor" class="dm-link-btn">
              <span class="material-symbols-outlined">stethoscope</span>Open Doctor
            </a>
          </div>
        </dm-empty>
      } @else if (filtered().length === 0) {
        <dm-empty icon="search_off" title="No matches"
                  hint="No apps match the current filters. Clear them or try a different query."></dm-empty>
      } @else if (view() === 'cards') {
        <dm-apps-cards
          [items]="filtered()" [focusedIndex]="focusedIndex()" [busy]="busyMap()"
          (open)="open($event)" (focus)="focusedIndex.set($event)" (act)="act($event.name, $event.kind)">
        </dm-apps-cards>
      } @else {
        <dm-apps-list-view
          [items]="filtered()" [focusedIndex]="focusedIndex()" [busy]="busyMap()"
          (open)="open($event)" (focus)="focusedIndex.set($event)" (act)="act($event.name, $event.kind)">
        </dm-apps-list-view>
      }
    </div>
  `,
  styles: [`
    :host{display:block}
    .dm-page{display:flex;flex-direction:column;gap:1rem}
    .dm-overview{display:grid;grid-template-columns:minmax(280px,1fr) minmax(0,2fr);gap:1rem;padding:1rem 1.25rem;border-radius:14px;background:var(--mat-sys-surface-container-low);border:1px solid var(--mat-sys-outline-variant)}
    @media (max-width:760px){.dm-overview{grid-template-columns:1fr}}
    .dm-totals-row{display:flex;flex-wrap:wrap;gap:.75rem}
    .dm-total{display:flex;flex-direction:column;padding:.5rem .875rem;border-radius:10px;background:var(--mat-sys-surface-container);min-width:70px}
    .dm-total-num{font:600 1.5rem/1.75rem Roboto;color:var(--mat-sys-on-surface)}
    .dm-total-label{font:500 .6875rem/1rem Roboto;text-transform:uppercase;letter-spacing:.04rem;color:var(--mat-sys-on-surface-variant)}
    .dm-total-serving .dm-total-num{color:var(--mat-sys-primary)}
    .dm-total-error .dm-total-num{color:var(--mat-sys-error)}
    .dm-total-error.dm-zero .dm-total-num{color:var(--mat-sys-on-surface-variant)}
    .dm-attention{display:flex;flex-direction:column;gap:.5rem;min-width:0}
    .dm-att-title{display:inline-flex;align-items:center;gap:.25rem;font:500 .8125rem/1.25rem Roboto;color:var(--mat-sys-error)}
    .dm-att-title .material-symbols-outlined{font-size:18px}
    .dm-att-list{display:flex;flex-direction:column;gap:.25rem}
    .dm-att-row{display:flex;align-items:center;gap:.75rem;min-width:0;padding:.375rem .625rem;border-radius:8px;text-decoration:none;color:var(--mat-sys-on-surface);background:var(--mat-sys-surface-container);border-left:3px solid var(--mat-sys-error)}
    .dm-att-row:hover{background:var(--mat-sys-surface-container-high)}
    .dm-att-row strong{font-weight:500;font-size:.875rem}
    .dm-att-meta{font-size:.75rem;color:var(--mat-sys-on-surface-variant);white-space:nowrap}
    .dm-att-where{color:var(--mat-sys-error)}
    .dm-att-code{color:var(--mat-sys-on-surface-variant);margin-left:.25rem}
    .dm-page-header{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem}
    .dm-page-header h1{margin:0;font:400 1.5rem/2rem Roboto}
    .dm-page-sub{font:400 .8125rem/1.25rem Roboto;color:var(--mat-sys-on-surface-variant);margin-top:.25rem;display:flex;gap:.25rem;flex-wrap:wrap}
    .dm-header-actions{display:flex;gap:.5rem}
    .dm-toggle,.dm-chips{display:inline-flex;padding:2px;border-radius:10px;background:var(--mat-sys-surface-container);border:1px solid var(--mat-sys-outline-variant)}
    .dm-toggle button,.dm-chip{display:inline-flex;align-items:center;gap:.375rem;padding:5px 10px;border-radius:8px;background:transparent;border:0;color:var(--mat-sys-on-surface-variant);cursor:pointer;font:500 .8125rem/1rem Roboto}
    .dm-toggle button .material-symbols-outlined{font-size:18px}
    .dm-toggle button:hover,.dm-chip:hover{color:var(--mat-sys-on-surface)}
    .dm-toggle button.active,.dm-chip.active{background:var(--mat-sys-surface);color:var(--mat-sys-primary)}
    .dm-toggle button.active{box-shadow:var(--mat-sys-level1)}
    .dm-chip-count{font:500 .6875rem/1rem var(--dm-mono);padding:0 5px;border-radius:999px;background:var(--mat-sys-surface-container-high);color:var(--mat-sys-on-surface-variant)}
    .dm-chip.active .dm-chip-count{background:color-mix(in oklch,var(--mat-sys-primary) 16%,transparent);color:var(--mat-sys-primary)}
    .dm-filterbar{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
    .dm-search{position:relative;flex:1;min-width:220px;display:inline-flex;align-items:center;background:var(--mat-sys-surface-container);border:1px solid var(--mat-sys-outline-variant);border-radius:10px}
    .dm-search:focus-within{border-color:var(--mat-sys-primary)}
    .dm-search input{flex:1;border:0;outline:0;background:transparent;padding:8px 36px;font:400 .875rem/1.25rem Roboto;color:var(--mat-sys-on-surface)}
    .dm-search input::placeholder{color:var(--mat-sys-on-surface-variant)}
    .dm-search-icon{position:absolute;left:10px;pointer-events:none;font-size:18px;color:var(--mat-sys-on-surface-variant)}
    .dm-search-clear{position:absolute;right:6px;background:transparent;border:0;cursor:pointer;color:var(--mat-sys-on-surface-variant);width:24px;height:24px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center}
    .dm-search-clear:hover{background:var(--mat-sys-surface-container-high)}
    .dm-search-clear .material-symbols-outlined{font-size:16px}
    .dm-grid-sk{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem}
    .dm-card-sk{background:var(--mat-sys-surface-container-low);border:1px solid var(--mat-sys-outline-variant);border-radius:14px;overflow:hidden}
    .dm-sk-accent{height:4px;background:var(--mat-sys-surface-container)}
    .dm-sk-body{padding:1rem;display:flex;flex-direction:column;gap:.5rem}
    .dm-empty-actions{margin-top:.75rem}
    .dm-link-btn{display:inline-flex;align-items:center;gap:.375rem;padding:6px 14px;border-radius:10px;background:var(--mat-sys-primary);color:var(--mat-sys-on-primary);text-decoration:none;font:500 .875rem/1.25rem Roboto}
    .dm-link-btn .material-symbols-outlined{font-size:18px}
    .dm-tag-row{flex-wrap:wrap;gap:4px;max-width:100%}
    .dm-chip-clear{padding:5px 6px;color:var(--mat-sys-on-surface-variant)}
    .dm-chip-clear .material-symbols-outlined{font-size:16px}
  `],
})
export class AppsListComponent implements AfterViewInit {
  readonly api = inject(DaimonApi);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  readonly view = signal<ViewMode>('cards');
  readonly query = signal<string>('');
  readonly status = signal<StatusFilter>('all');
  readonly workspace = signal<string | null>(null);
  readonly focusedIndex = signal<number>(0);
  readonly busyMap = signal<Record<string, Record<string, boolean>>>({});
  readonly selectedTags = signal<Set<string>>(new Set<string>());

  readonly allTags = computed<string[]>(() => {
    const seen = new Set<string>();
    for (const a of this.api.apps()) for (const t of a.tags ?? []) seen.add(t);
    return Array.from(seen).sort();
  });

  readonly skeletonItems = Array.from({ length: 6 }, (_, i) => i);
  readonly statusFilters: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'serving', label: 'Serving' },
    { key: 'errors', label: 'Errors' },
    { key: 'stopped', label: 'Stopped' },
  ];

  readonly filtered = computed<AppRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    const s = this.status();
    const ws = this.workspace();
    const tags = this.selectedTags();
    return this.api.apps().filter(a => {
      if (ws && a.workspaceLabel !== ws) return false;
      if (s === 'serving' && a.status !== 'serving') return false;
      if (s === 'errors' && a.status !== 'error' && a.errorCount === 0) return false;
      if (s === 'stopped' && a.status !== 'stopped') return false;
      if (tags.size) {
        const at = a.tags ?? [];
        for (const t of tags) if (!at.includes(t)) return false;
      }
      if (q) {
        const hay = [a.name, a.workspaceLabel ?? '', ...(a.tags ?? [])].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  constructor() {
    this.view.set((localStorage.getItem(VIEW_KEY) as ViewMode) === 'list' ? 'list' : 'cards');
    this.workspace.set(localStorage.getItem(WS_KEY));
    const storedTags = (localStorage.getItem(TAGS_KEY) ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (storedTags.length) this.selectedTags.set(new Set(storedTags));

    effect(() => {
      const max = this.filtered().length;
      if (this.focusedIndex() >= max) this.focusedIndex.set(Math.max(0, max - 1));
    });

    this.bindWindow('daimon:toggle-density', () => this.setView(this.view() === 'cards' ? 'list' : 'cards'));
    this.bindWindow('daimon:focus-filter', () => queueMicrotask(() => this.searchInput?.nativeElement.focus()));
    this.bindWindow('daimon:workspace', (e: Event) => {
      const detail = (e as CustomEvent).detail as string | null | undefined;
      this.workspace.set(detail ?? null);
    });
    this.bindWindow('daimon:key', (e: Event) => this.onKey((e as CustomEvent).detail as string));
  }

  async ngAfterViewInit(): Promise<void> {
    if (!this.api.ready()) await this.api.refresh();
  }

  @HostListener('window:storage', ['$event'])
  onStorage(ev: StorageEvent): void {
    if (ev.key === WS_KEY) this.workspace.set(ev.newValue);
  }

  private bindWindow(name: string, fn: (e: Event) => void): void {
    window.addEventListener(name, fn);
    this.destroyRef.onDestroy(() => window.removeEventListener(name, fn));
  }

  setView(v: ViewMode): void {
    this.view.set(v);
    localStorage.setItem(VIEW_KEY, v);
  }

  setStatus(s: StatusFilter): void {
    this.status.set(s);
    this.focusedIndex.set(0);
  }

  isTagSelected(t: string): boolean { return this.selectedTags().has(t); }

  toggleTag(t: string): void {
    const next = new Set(this.selectedTags());
    if (next.has(t)) next.delete(t); else next.add(t);
    this.selectedTags.set(next);
    this.persistTags(next);
    this.focusedIndex.set(0);
  }

  clearTags(): void {
    this.selectedTags.set(new Set());
    this.persistTags(new Set());
    this.focusedIndex.set(0);
  }

  private persistTags(s: Set<string>): void {
    if (s.size) localStorage.setItem(TAGS_KEY, Array.from(s).join(','));
    else localStorage.removeItem(TAGS_KEY);
  }

  onQuery(q: string): void {
    this.query.set(q);
    this.focusedIndex.set(0);
  }

  open(name: string): void {
    void this.router.navigate(['/apps', name]);
  }

  countFor(s: StatusFilter): number {
    return this.api.apps().filter(a => {
      if (s === 'all') return true;
      if (s === 'serving') return a.status === 'serving';
      if (s === 'errors') return a.status === 'error' || a.errorCount > 0;
      if (s === 'stopped') return a.status === 'stopped';
      return false;
    }).length;
  }

  async act(name: string, kind: ActionKind): Promise<void> {
    if (this.busyMap()[name]?.[kind]) return;
    this.setBusy(name, kind, true);
    try {
      if (kind === 'start') await this.api.startApp(name);
      else if (kind === 'stop') await this.api.stopApp(name);
      else await this.api.restartApp(name);
    } catch (e: any) {
      this.snack.open(`${kind} ${name} failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(name, kind, false);
    }
  }

  private setBusy(name: string, kind: string, v: boolean): void {
    this.busyMap.update(m => ({ ...m, [name]: { ...(m[name] ?? {}), [kind]: v } }));
  }

  private onKey(key: string): void {
    const list = this.filtered();
    if (!list.length) return;
    const cur = Math.max(0, Math.min(this.focusedIndex(), list.length - 1));
    if (key === 'j') this.focusedIndex.set((cur + 1) % list.length);
    else if (key === 'k') this.focusedIndex.set((cur - 1 + list.length) % list.length);
    else if (key === 's') void this.act(list[cur].name, 'start');
    else if (key === 'x') void this.act(list[cur].name, 'stop');
    else if (key === 'r') {
      const target = list[cur].name;
      const ref = this.snack.open(`Restart ${target}? Press R again or click confirm.`, 'Confirm', { duration: 4000 });
      ref.onAction().subscribe(() => void this.act(target, 'restart'));
    }
  }
}
