import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  QueryList,
  SimpleChanges,
  ViewChild,
  ViewChildren,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';
import { DaimonApi } from './daimon-api';
import {
  StatusPillComponent,
  EmptyStateComponent,
  SkeletonComponent,
  MonoComponent,
} from './ui-primitives';

Chart.register(...registerables);

interface Sample { ts: number; ms: number; }
interface Stats { count: number; p50: number; p95: number; slowest: number; fastest: number; }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function computeStats(samples: Sample[]): Stats {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, slowest: 0, fastest: 0 };
  const sorted = samples.map(s => s.ms).slice().sort((a, b) => a - b);
  return {
    count: samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    slowest: sorted[sorted.length - 1],
    fastest: sorted[0],
  };
}

function fmtRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

function fmtTransitionTs(ts: number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString();
}

function readToken(name: string): string {
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue(name).trim();
}

@Component({
  selector: 'dm-history-spark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="dm-spark-box"><canvas #canvas></canvas></div>`,
  styles: [`
    :host { display: block; }
    .dm-spark-box { position: relative; height: 56px; }
  `],
})
export class HistorySparkComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() samples: Sample[] = [];
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;

  ngAfterViewInit(): void {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const primary = readToken('--mat-sys-primary') || 'var(--mat-sys-primary)';
    const cfg: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: this.samples.map((_, i) => i),
        datasets: [{
          data: this.samples.map(s => s.ms),
          borderColor: primary,
          backgroundColor: 'transparent',
          borderWidth: 1.4,
          tension: 0.3,
          pointRadius: 0,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduced ? false : { duration: 200 },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['samples'] && this.chart) {
      this.chart.data.labels = this.samples.map((_, i) => i);
      this.chart.data.datasets[0].data = this.samples.map(s => s.ms);
      this.chart.update('none');
    }
  }

  ngOnDestroy(): void { this.chart?.destroy(); }
}

@Component({
  selector: 'dm-history-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, RouterLink,
    MatCardModule, MatButtonModule, MatIconModule, MatTooltipModule,
    StatusPillComponent, EmptyStateComponent, SkeletonComponent, MonoComponent,
    HistorySparkComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>
          History
          @if (name) {
            <span class="dm-sep">·</span>
            <dm-mono><span class="dm-app">{{ name }}</span></dm-mono>
            @if (currentApp(); as a) {
              <dm-status-pill [status]="a.status" [health]="a.health"></dm-status-pill>
            }
          }
        </h1>
        <div class="dm-page-sub">
          @if (name) {
            <a routerLink="/history" class="dm-back">
              <mat-icon>arrow_back</mat-icon> All apps
            </a>
          } @else {
            <span>Compile-time history across all apps</span>
          }
        </div>
      </div>
    </div>

    @if (loading()) {
      <div class="dm-skel-grid">
        <dm-skeleton height="8rem"></dm-skeleton>
        <dm-skeleton height="8rem"></dm-skeleton>
        <dm-skeleton height="8rem"></dm-skeleton>
      </div>
    } @else if (!name) {
      @if (overview().length === 0) {
        <dm-empty icon="query_stats" title="No compile data yet"
                  hint="Compile times appear here as the app builds"></dm-empty>
      } @else {
        <div class="dm-grid">
          @for (card of overview(); track card.name) {
            <a class="dm-card" [routerLink]="['/history', card.name]">
              <div class="dm-card-head">
                <dm-mono><span class="dm-card-name">{{ card.name }}</span></dm-mono>
                @if (byName(card.name); as a) {
                  <dm-status-pill [status]="a.status" [health]="a.health"></dm-status-pill>
                }
              </div>
              @if (card.samples.length) {
                <dm-history-spark [samples]="card.samples"></dm-history-spark>
                <div class="dm-card-foot">
                  <span class="dm-foot-cell">
                    <span class="dm-foot-label">count</span>
                    <span class="dm-foot-value"><dm-mono>{{ card.stats.count }}</dm-mono></span>
                  </span>
                  <span class="dm-foot-cell">
                    <span class="dm-foot-label">p50</span>
                    <span class="dm-foot-value"><dm-mono>{{ card.stats.p50 }} ms</dm-mono></span>
                  </span>
                  <span class="dm-foot-cell">
                    <span class="dm-foot-label">p95</span>
                    <span class="dm-foot-value"><dm-mono>{{ card.stats.p95 }} ms</dm-mono></span>
                  </span>
                </div>
              } @else {
                <div class="dm-card-empty">no data</div>
              }
            </a>
          }
        </div>
      }
    } @else {
      @if (samples().length === 0) {
        <dm-empty icon="query_stats" title="No compile data yet"
                  hint="Compile times appear here as the app builds"></dm-empty>
      } @else {
        <div class="dm-stats">
          <div class="dm-tile">
            <div class="dm-tile-label">count</div>
            <div class="dm-tile-value"><dm-mono>{{ stats().count }}</dm-mono></div>
          </div>
          <div class="dm-tile">
            <div class="dm-tile-label">p50</div>
            <div class="dm-tile-value"><dm-mono>{{ stats().p50 }} ms</dm-mono></div>
          </div>
          <div class="dm-tile">
            <div class="dm-tile-label">p95</div>
            <div class="dm-tile-value"><dm-mono>{{ stats().p95 }} ms</dm-mono></div>
          </div>
          <div class="dm-tile">
            <div class="dm-tile-label">slowest</div>
            <div class="dm-tile-value"><dm-mono>{{ stats().slowest }} ms</dm-mono></div>
          </div>
          <div class="dm-tile">
            <div class="dm-tile-label">fastest</div>
            <div class="dm-tile-value"><dm-mono>{{ stats().fastest }} ms</dm-mono></div>
          </div>
        </div>

        <mat-card class="dm-chart-card">
          <mat-card-header><mat-card-title>Compile time (ms)</mat-card-title></mat-card-header>
          <mat-card-content>
            <div class="dm-chart-box"><canvas #chart></canvas></div>
          </mat-card-content>
        </mat-card>

        <mat-card class="dm-table-card">
          <mat-card-header><mat-card-title>Recent compiles</mat-card-title></mat-card-header>
          <mat-card-content>
            <table class="dm-table">
              <thead>
                <tr><th>time</th><th class="dm-num">duration</th></tr>
              </thead>
              <tbody>
                @for (row of recent(); track row.ts) {
                  <tr>
                    <td>
                      <span [matTooltip]="absTime(row.ts)">{{ relTime(row.ts) }}</span>
                    </td>
                    <td class="dm-num"><dm-mono>{{ row.ms }} ms</dm-mono></td>
                  </tr>
                }
              </tbody>
            </table>
          </mat-card-content>
        </mat-card>
      }

      <mat-card class="dm-why-card">
        <mat-card-header><mat-card-title>Why</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (whyLoading()) {
            <dm-skeleton height="3rem"></dm-skeleton>
          } @else if (!why()) {
            <div class="dm-why-empty">No state transitions recorded.</div>
          } @else {
            @if (why()?.lastTransition; as lt) {
              <div class="dm-transition">
                <div class="dm-transition-arrow">
                  <span class="dm-transition-from">{{ lt.from || '—' }}</span>
                  <mat-icon class="dm-transition-icon">arrow_forward</mat-icon>
                  <span class="dm-transition-to" [attr.data-to]="lt.to">{{ lt.to || '—' }}</span>
                </div>
                <div class="dm-transition-meta">
                  <dm-mono>{{ fmtTs(lt.ts) }}</dm-mono>
                  @if (lt.message) {
                    <span class="dm-sep">·</span>
                    <span class="dm-transition-msg">{{ lt.message }}</span>
                  }
                </div>
              </div>
            }
            @if (priorEvents().length) {
              <ol class="dm-timeline">
                @for (ev of priorEvents(); track $index) {
                  <li>
                    <span class="dm-timeline-dot" [attr.data-kind]="ev.type"></span>
                    <div class="dm-timeline-body">
                      <div class="dm-timeline-head">
                        <strong>{{ ev.type }}</strong>
                        @if (ev.from || ev.to) {
                          <span class="dm-sep">·</span>
                          <span><dm-mono>{{ ev.from || '—' }} → {{ ev.to || '—' }}</dm-mono></span>
                        }
                      </div>
                      <div class="dm-timeline-meta">
                        <dm-mono>{{ fmtTs(ev.ts) }}</dm-mono>
                        @if (ev.message) {
                          <span class="dm-sep">·</span>
                          <span>{{ ev.message }}</span>
                        }
                      </div>
                    </div>
                  </li>
                }
              </ol>
            }
          }
        </mat-card-content>
      </mat-card>
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-page-header h1 { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .dm-sep { color: var(--mat-sys-outline); margin: 0 .15rem; }
    .dm-app { color: var(--mat-sys-primary); font-weight: 500; }
    .dm-back {
      display: inline-flex; align-items: center; gap: .25rem;
      color: var(--mat-sys-primary); text-decoration: none;
    }
    .dm-back:hover { text-decoration: underline; }

    .dm-skel-grid, .dm-grid { display: grid; gap: 1rem; }
    .dm-skel-grid { grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); }
    .dm-grid { grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); }
    .dm-card {
      display: flex; flex-direction: column; gap: .75rem;
      padding: 1rem;
      border-radius: 14px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-lowest);
      color: inherit; text-decoration: none;
      transition: box-shadow .15s ease, border-color .15s ease, transform .15s ease;
    }
    .dm-card:hover {
      border-color: color-mix(in oklch, var(--mat-sys-primary) 40%, var(--mat-sys-outline-variant));
      box-shadow: var(--mat-sys-level1);
    }
    .dm-card-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .dm-card-name { color: var(--mat-sys-on-surface); font-weight: 500; }
    .dm-card-foot { display: flex; gap: 1rem; }
    .dm-foot-cell { display: flex; flex-direction: column; }
    .dm-foot-label, .dm-tile-label, .dm-table th {
      font: 500 .6875rem/1rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-foot-value { color: var(--mat-sys-on-surface); }
    .dm-card-empty { color: var(--mat-sys-on-surface-variant); font-size: .875rem; padding: 1rem 0; }

    .dm-stats {
      display: grid; gap: .75rem;
      grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
      margin-bottom: 1rem;
    }
    .dm-tile {
      padding: .85rem 1rem; border-radius: 12px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-lowest);
    }
    .dm-tile-value {
      font: 400 1.5rem/2rem Roboto;
      color: var(--mat-sys-on-surface);
      margin-top: .25rem;
    }

    .dm-chart-card { margin-bottom: 1rem; }
    .dm-chart-box { position: relative; height: 320px; }

    .dm-table-card { margin-bottom: 1rem; }
    .dm-table { width: 100%; border-collapse: collapse; }
    .dm-table th, .dm-table td {
      text-align: left; padding: .55rem .75rem;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      font-size: .875rem;
    }
    .dm-table tbody tr:hover {
      background: color-mix(in oklch, var(--mat-sys-primary) 6%, transparent);
    }
    .dm-num { text-align: right; }

    .dm-why-empty { color: var(--mat-sys-on-surface-variant); font-size: .875rem; }
    .dm-transition {
      display: flex; flex-direction: column; gap: .35rem;
      padding: .75rem 1rem;
      border-radius: 10px;
      background: var(--mat-sys-surface-container);
      margin-bottom: 1rem;
    }
    .dm-transition-arrow {
      display: flex; align-items: center; gap: .5rem;
      font: 500 1rem/1.5rem Roboto;
    }
    .dm-transition-from { color: var(--mat-sys-on-surface-variant); }
    .dm-transition-icon { font-size: 18px; height: 18px; width: 18px; color: var(--mat-sys-outline); }
    .dm-transition-to { color: var(--mat-sys-primary); }
    .dm-transition-to[data-to=error] { color: var(--mat-sys-error); }
    .dm-transition-to[data-to=stopped] { color: var(--mat-sys-on-surface-variant); }
    .dm-transition-meta { color: var(--mat-sys-on-surface-variant); font-size: .8125rem; }
    .dm-transition-msg { color: var(--mat-sys-on-surface); }

    .dm-timeline {
      list-style: none; margin: 0; padding: 0 0 0 1rem;
      border-left: 2px solid var(--mat-sys-outline-variant);
    }
    .dm-timeline li {
      position: relative;
      padding: .5rem 0 .5rem .75rem;
    }
    .dm-timeline-dot {
      position: absolute;
      left: -1.42rem; top: .9rem;
      width: 10px; height: 10px; border-radius: 999px;
      background: var(--mat-sys-outline);
      box-shadow: 0 0 0 3px var(--mat-sys-surface);
    }
    .dm-timeline-dot[data-kind=status] { background: var(--mat-sys-primary); }
    .dm-timeline-dot[data-kind=error] { background: var(--mat-sys-error); }
    .dm-timeline-dot[data-kind=health] { background: var(--mat-sys-tertiary); }
    .dm-timeline-head { font-size: .875rem; color: var(--mat-sys-on-surface); }
    .dm-timeline-meta { font-size: .75rem; color: var(--mat-sys-on-surface-variant); margin-top: .15rem; }
  `],
})
export class HistoryPageComponent implements OnInit, OnChanges, OnDestroy {
  @Input() name = '';
  readonly api = inject(DaimonApi);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  @ViewChild('chart') chartCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChildren('chart') chartCanvases?: QueryList<ElementRef<HTMLCanvasElement>>;

  readonly loading = signal(true);
  readonly samples = signal<Sample[]>([]);
  readonly overview = signal<{ name: string; samples: Sample[]; stats: Stats }[]>([]);
  readonly why = signal<any | null>(null);
  readonly whyLoading = signal(false);

  readonly stats = computed<Stats>(() => computeStats(this.samples()));
  readonly recent = computed<Sample[]>(() => this.samples().slice().sort((a, b) => b.ts - a.ts).slice(0, 20));
  readonly priorEvents = computed<any[]>(() => {
    const w = this.why();
    return Array.isArray(w?.priorEvents) ? w.priorEvents : [];
  });
  readonly currentApp = computed(() => this.name ? this.api.byName(this.name) : undefined);

  private chart?: Chart;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private nowTick?: ReturnType<typeof setInterval>;
  // Force re-render of relative times.
  private readonly tick = signal(0);

  byName(n: string) { return this.api.byName(n); }

  ngOnInit(): void {
    void this.load();
    this.refreshTimer = setInterval(() => void this.load(true), 10_000);
    this.nowTick = setInterval(() => this.tick.update(v => v + 1), 30_000);
  }

  ngOnChanges(ch: SimpleChanges): void {
    if ('name' in ch && !ch['name'].firstChange) {
      this.destroyChart();
      void this.load();
    }
  }

  ngOnDestroy(): void {
    this.destroyChart();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.nowTick) clearInterval(this.nowTick);
  }

  private destroyChart(): void {
    this.chart?.destroy();
    this.chart = undefined;
  }

  private async load(silent = false): Promise<void> {
    if (!silent) this.loading.set(true);
    try {
      if (this.name) {
        const [samples, why] = await Promise.all([
          this.api.getCompileTimes(this.name, 200),
          this.fetchWhy(this.name),
        ]);
        this.samples.set(Array.isArray(samples) ? samples : []);
        this.why.set(why);
        afterNextRender(() => this.renderChart(), { injector: this.injector });
      } else {
        const apps = this.api.apps();
        if (apps.length === 0) {
          // Wait for initial app list; retry once after the api warms up.
          await this.api.refresh();
        }
        const list = this.api.apps();
        const results = await Promise.all(
          list.map(async a => {
            const s = await this.api.getCompileTimes(a.name, 100);
            return { name: a.name, samples: s, stats: computeStats(s) };
          }),
        );
        this.overview.set(results);
      }
    } finally {
      if (!silent) this.loading.set(false);
    }
  }

  private async fetchWhy(name: string): Promise<any | null> {
    this.whyLoading.set(true);
    try {
      return await this.api.getHistoryWhy(name);
    } finally {
      this.whyLoading.set(false);
    }
  }

  private renderChart(): void {
    const el = this.chartCanvas?.nativeElement ?? this.chartCanvases?.first?.nativeElement;
    if (!el) return;
    const samples = this.samples();
    if (samples.length === 0) { this.destroyChart(); return; }

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const primary = readToken('--mat-sys-primary') || 'var(--mat-sys-primary)';
    const tertiary = readToken('--mat-sys-tertiary') || 'var(--mat-sys-tertiary)';
    const error = readToken('--mat-sys-error') || 'var(--mat-sys-error)';
    const outline = readToken('--mat-sys-outline-variant') || 'rgba(120,120,120,0.3)';

    const labels = samples.map(s => new Date(s.ts).toLocaleTimeString());
    const data = samples.map(s => s.ms);
    const st = computeStats(samples);
    const p50Line = new Array(samples.length).fill(st.p50);
    const p95Line = new Array(samples.length).fill(st.p95);

    if (this.chart) {
      this.chart.data.labels = labels;
      this.chart.data.datasets[0].data = data;
      this.chart.data.datasets[1].data = p50Line;
      this.chart.data.datasets[2].data = p95Line;
      this.chart.update('none');
      return;
    }

    const cfg: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'ms',
            data,
            borderColor: primary,
            backgroundColor: 'transparent',
            borderWidth: 1.6,
            tension: 0.25,
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'p50',
            data: p50Line,
            borderColor: tertiary,
            borderDash: [4, 4],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'p95',
            data: p95Line,
            borderColor: error,
            borderDash: [4, 4],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduced ? false : { duration: 200 },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12 } },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 6, autoSkip: true }, grid: { color: outline } },
          y: { beginAtZero: true, title: { display: true, text: 'ms' }, grid: { color: outline } },
        },
      },
    };
    this.chart = new Chart(el, cfg);
  }

  relTime(ts: number): string {
    this.tick();
    return fmtRelative(ts);
  }

  absTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  fmtTs(ts: number | undefined): string {
    return fmtTransitionTs(ts);
  }
}
