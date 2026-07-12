import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { DaimonApi } from './daimon-api';
import {
  StatusPillComponent,
  EmptyStateComponent,
  SkeletonComponent,
  MonoComponent,
} from './ui-primitives';

interface RequestRow {
  ts: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

type Since = '5m' | '15m' | '1h' | 'all';
type MethodKey = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
type StatusBucket = '2xx' | '3xx' | '4xx' | '5xx';

const METHODS: MethodKey[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const STATUS_BUCKETS: StatusBucket[] = ['2xx', '3xx', '4xx', '5xx'];
const SINCE_OPTIONS: { value: Since; label: string }[] = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: 'all', label: 'All' },
];
const REFRESH_MS = 5000;

function relTime(ts: number, now: number): string {
  const d = Math.max(0, Math.floor((now - ts) / 1000));
  if (d < 1) return 'just now';
  if (d < 60) return `${d}s ago`;
  const m = Math.floor(d / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusBucketOf(s: number): StatusBucket | null {
  if (s >= 200 && s < 300) return '2xx';
  if (s >= 300 && s < 400) return '3xx';
  if (s >= 400 && s < 500) return '4xx';
  if (s >= 500 && s < 600) return '5xx';
  return null;
}

@Component({
  selector: 'dm-requests-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatFormFieldModule, MatSelectModule, MatInputModule,
    MatButtonModule, MatIconModule, MatTooltipModule,
    StatusPillComponent, EmptyStateComponent, SkeletonComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>
          <a [routerLink]="['/apps', name]" class="dm-back" aria-label="Back to app" matTooltip="Back to app">
            <mat-icon>arrow_back</mat-icon>
          </a>
          <span>Requests</span>
          <span class="dm-sep">·</span>
          <dm-mono><span class="dm-app">{{ name }}</span></dm-mono>
          @if (currentApp(); as a) {
            <dm-status-pill [status]="a.status" [health]="a.health"></dm-status-pill>
          }
        </h1>
        <div class="dm-page-sub">
          @if (lastRefreshed()) {
            <span>Last refreshed <dm-mono>{{ lastRefreshedLabel() }}</dm-mono></span>
          } @else {
            <span>Loading…</span>
          }
          @if (paused()) {
            <span class="dm-sep">·</span>
            <span class="dm-paused">paused</span>
          }
        </div>
      </div>
      <div class="dm-header-actions">
        <button mat-stroked-button (click)="togglePause()" [matTooltip]="paused() ? 'Resume auto-refresh' : 'Pause auto-refresh'">
          <mat-icon>{{ paused() ? 'play_arrow' : 'pause' }}</mat-icon>
          {{ paused() ? 'Resume' : 'Pause' }}
        </button>
        <button mat-stroked-button (click)="refresh()" matTooltip="Refresh now">
          <mat-icon>refresh</mat-icon>
          Refresh
        </button>
      </div>
    </div>

    @if (unknownApp()) {
      <dm-empty icon="search_off" title="Unknown app"
                hint="No app with that name. Head back to the apps list.">
        <a routerLink="/" class="dm-empty-link">Go to apps</a>
      </dm-empty>
    } @else {
      <div class="dm-toolbar">
        <mat-form-field appearance="outline" class="dm-since">
          <mat-label>Since</mat-label>
          <mat-select [ngModel]="since()" (ngModelChange)="since.set($event)">
            @for (opt of sinceOptions; track opt.value) {
              <mat-option [value]="opt.value">{{ opt.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <div class="dm-chip-group">
          <span class="dm-chip-label">Methods</span>
          @for (m of methods; track m) {
            <button
              class="dm-chip"
              [attr.data-method]="m"
              [class.dm-chip-active]="methodFilter().has(m)"
              (click)="toggleMethod(m)">
              {{ m }}
            </button>
          }
        </div>

        <div class="dm-chip-group">
          <span class="dm-chip-label">Status</span>
          @for (b of statusBuckets; track b) {
            <button
              class="dm-chip"
              [attr.data-bucket]="b"
              [class.dm-chip-active]="statusFilter().has(b)"
              (click)="toggleStatus(b)">
              {{ b }}
            </button>
          }
        </div>

        <mat-form-field appearance="outline" class="dm-path-filter">
          <mat-label>Path contains</mat-label>
          <input matInput [ngModel]="pathQuery()" (ngModelChange)="pathQuery.set($event)" placeholder="/api/..." />
          @if (pathQuery()) {
            <button matSuffix mat-icon-button (click)="pathQuery.set('')" aria-label="Clear filter"><mat-icon>close</mat-icon></button>
          }
        </mat-form-field>
      </div>

      @if (loading() && rows().length === 0) {
        <div class="dm-skel-rows">
          <dm-skeleton height="2rem"></dm-skeleton>
          <dm-skeleton height="2rem"></dm-skeleton>
          <dm-skeleton height="2rem"></dm-skeleton>
          <dm-skeleton height="2rem"></dm-skeleton>
        </div>
      } @else if (filtered().length === 0 && rows().length === 0) {
        <dm-empty icon="hourglass_empty" title="No requests yet"
                  hint="Either no traffic has hit the dev server, or requestLog.enabled is false in your config."></dm-empty>
      } @else if (filtered().length === 0) {
        <dm-empty icon="filter_alt_off" title="No matching requests"
                  hint="Adjust filters to see more rows."></dm-empty>
      } @else {
        <div class="dm-table-wrap">
          <table class="dm-req-table">
            <thead>
              <tr>
                <th class="dm-col-time" scope="col">Time</th>
                <th class="dm-col-method" scope="col">Method</th>
                <th class="dm-col-status" scope="col">Status</th>
                <th class="dm-col-path" scope="col">Path</th>
                <th class="dm-col-dur" scope="col">ms</th>
              </tr>
            </thead>
            <tbody>
              @for (r of filtered(); track $index) {
                <tr>
                  <td class="dm-col-time">
                    <dm-mono><span [matTooltip]="absTs(r.ts)">{{ relTs(r.ts) }}</span></dm-mono>
                  </td>
                  <td class="dm-col-method">
                    <dm-mono>
                      <span class="dm-method" [attr.data-method]="r.method">{{ r.method }}</span>
                    </dm-mono>
                  </td>
                  <td class="dm-col-status">
                    <dm-mono>
                      <span class="dm-status" [attr.data-bucket]="bucketOf(r.status)">{{ r.status }}</span>
                    </dm-mono>
                  </td>
                  <td class="dm-col-path">
                    <dm-mono><span class="dm-path" [title]="r.path">{{ r.path }}</span></dm-mono>
                  </td>
                  <td class="dm-col-dur">
                    <dm-mono>{{ r.durationMs }}</dm-mono>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    .dm-page-header h1 { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: 0; }
    .dm-sep { color: var(--mat-sys-outline); }
    .dm-app { color: var(--mat-sys-primary); font-weight: 500; }
    .dm-back {
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--mat-sys-on-surface-variant);
      text-decoration: none;
      padding: 4px; border-radius: 8px;
    }
    .dm-back:hover { background: var(--mat-sys-surface-container); color: var(--mat-sys-on-surface); }
    .dm-page-sub { color: var(--mat-sys-on-surface-variant); margin-top: .25rem; font-size: .875rem; }
    .dm-paused { color: var(--mat-sys-tertiary); }
    .dm-header-actions { display: flex; gap: .5rem; }

    .dm-toolbar {
      display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
      margin: 1rem 0;
    }
    .dm-since { width: 8rem; }
    .dm-path-filter { flex: 1; min-width: 14rem; }

    .dm-chip-group { display: inline-flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
    .dm-chip-label {
      font: 500 .6875rem/1rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem;
      color: var(--mat-sys-on-surface-variant);
      margin-right: .25rem;
    }
    .dm-chip {
      font-family: 'Roboto Mono', ui-monospace, monospace;
      font-size: .75rem;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
      cursor: pointer;
      letter-spacing: .04rem;
    }
    .dm-chip:hover { color: var(--mat-sys-on-surface); }
    .dm-chip-active {
      background: color-mix(in oklch, var(--mat-sys-primary) var(--dm-badge-tint), transparent);
      border-color: color-mix(in oklch, var(--mat-sys-primary) 35%, transparent);
      color: var(--mat-sys-primary);
    }

    .dm-skel-rows { display: flex; flex-direction: column; gap: .35rem; }

    .dm-table-wrap {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      overflow: hidden;
      background: var(--mat-sys-surface-container-lowest);
    }
    .dm-req-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .dm-req-table th {
      text-align: left;
      padding: 8px 12px;
      font: 500 .6875rem/1rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem;
      color: var(--mat-sys-on-surface-variant);
      background: var(--mat-sys-surface-container);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-req-table td {
      padding: 6px 12px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      font-size: .8125rem;
      height: 32px;
      line-height: 20px;
      vertical-align: middle;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dm-req-table tbody tr:last-child td { border-bottom: none; }
    .dm-req-table tbody tr:hover {
      background: color-mix(in oklch, var(--mat-sys-primary) 6%, transparent);
    }
    .dm-col-time { width: 7rem; }
    .dm-col-method { width: 5rem; }
    .dm-col-status { width: 5rem; }
    .dm-col-path { width: auto; }
    .dm-col-dur { width: 5rem; text-align: right; }

    .dm-method[data-method="GET"]    { color: var(--mat-sys-primary); }
    .dm-method[data-method="POST"]   { color: var(--mat-sys-tertiary); }
    .dm-method[data-method="DELETE"] { color: var(--mat-sys-error); }
    .dm-method[data-method="PUT"],
    .dm-method[data-method="PATCH"]  { color: var(--mat-sys-secondary); }
    .dm-method                       { color: var(--mat-sys-on-surface-variant); }

    .dm-status[data-bucket="2xx"] { color: var(--mat-sys-primary); }
    .dm-status[data-bucket="3xx"] { color: var(--mat-sys-secondary); }
    .dm-status[data-bucket="4xx"] { color: var(--mat-sys-tertiary); }
    .dm-status[data-bucket="5xx"] { color: var(--mat-sys-error); }
    .dm-status                    { color: var(--mat-sys-on-surface-variant); }

    .dm-path {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
      color: var(--mat-sys-on-surface);
    }

    .dm-empty-link {
      color: var(--mat-sys-primary);
      text-decoration: none;
      margin-top: .5rem;
    }
    .dm-empty-link:hover { text-decoration: underline; }
  `],
})
export class RequestsPageComponent implements OnInit, OnChanges, OnDestroy {
  @Input() name = '';
  readonly api = inject(DaimonApi);
  private readonly http = inject(HttpClient);

  readonly methods = METHODS;
  readonly statusBuckets = STATUS_BUCKETS;
  readonly sinceOptions = SINCE_OPTIONS;

  readonly loading = signal(true);
  readonly rows = signal<RequestRow[]>([]);
  readonly since = signal<Since>('5m');
  readonly methodFilter = signal<Set<MethodKey>>(new Set());
  readonly statusFilter = signal<Set<StatusBucket>>(new Set());
  readonly pathQuery = signal<string>('');
  readonly paused = signal(false);
  readonly lastRefreshed = signal<number | null>(null);
  private readonly tick = signal(0);

  readonly currentApp = computed(() => this.name ? this.api.byName(this.name) : undefined);
  readonly unknownApp = computed(() => {
    if (!this.name) return true;
    if (!this.api.ready()) return false;
    return !this.api.byName(this.name);
  });

  readonly filtered = computed<RequestRow[]>(() => {
    const all = this.rows();
    const mf = this.methodFilter();
    const sf = this.statusFilter();
    const pq = this.pathQuery().trim().toLowerCase();
    return all.filter(r => {
      if (mf.size > 0 && !mf.has(r.method.toUpperCase() as MethodKey)) return false;
      if (sf.size > 0) {
        const b = statusBucketOf(r.status);
        if (!b || !sf.has(b)) return false;
      }
      if (pq && !r.path.toLowerCase().includes(pq)) return false;
      return true;
    }).sort((a, b) => b.ts - a.ts);
  });

  readonly lastRefreshedLabel = computed(() => {
    this.tick();
    const t = this.lastRefreshed();
    if (!t) return '—';
    return relTime(t, Date.now());
  });

  private refreshTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private sinceFirst = true;

  constructor() {
    effect(() => {
      const _ = this.since();
      if (this.sinceFirst) { this.sinceFirst = false; return; }
      void this.refresh();
    });
  }

  ngOnInit(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => {
      if (!this.paused()) void this.refresh(true);
    }, REFRESH_MS);
    this.tickTimer = setInterval(() => this.tick.update(v => v + 1), 1000);
  }

  ngOnChanges(ch: SimpleChanges): void {
    if ('name' in ch && !ch['name'].firstChange) {
      this.rows.set([]);
      void this.refresh();
    }
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  togglePause(): void { this.paused.update(v => !v); }

  toggleMethod(m: MethodKey): void {
    this.methodFilter.update(s => {
      const next = new Set(s);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  }

  toggleStatus(b: StatusBucket): void {
    this.statusFilter.update(s => {
      const next = new Set(s);
      if (next.has(b)) next.delete(b); else next.add(b);
      return next;
    });
  }

  async refresh(silent = false): Promise<void> {
    if (!this.name) return;
    if (!silent) this.loading.set(true);
    try {
      const since = this.since();
      const qs = since === 'all' ? '' : `?since=${encodeURIComponent(since)}`;
      const url = `/api/apps/${encodeURIComponent(this.name)}/requests${qs}`;
      const res = await firstValueFrom(this.http.get<RequestRow[]>(url));
      this.rows.set(Array.isArray(res) ? res : []);
      this.lastRefreshed.set(Date.now());
    } catch {
      // Leave existing rows; auto-refresh will retry.
    } finally {
      if (!silent) this.loading.set(false);
    }
  }

  relTs(ts: number): string {
    this.tick();
    return relTime(ts, Date.now());
  }

  absTs(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  bucketOf(s: number): StatusBucket | null {
    return statusBucketOf(s);
  }
}
