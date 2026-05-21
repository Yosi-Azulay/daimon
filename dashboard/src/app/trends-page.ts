import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';
import { Chart, registerables, type ChartConfiguration, type ChartType } from 'chart.js';
import { DaimonApi } from './daimon-api';
import { EmptyStateComponent, SkeletonComponent, MonoComponent } from './ui-primitives';

Chart.register(...registerables);

type Window = '24h' | '7d' | '30d';
type Metric = 'compile' | 'bundle' | 'errors' | 'restarts';

interface SeriesPoint { t: number; v: number; v2?: number; }
interface Series { app: string; points: SeriesPoint[]; }

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtBucketLabel(t: number, window: Window): string {
  const d = new Date(t);
  if (window === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

@Component({
  selector: 'dm-trend-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatCardModule, EmptyStateComponent, SkeletonComponent],
  template: `
    <mat-card class="dm-trend-card">
      <mat-card-header>
        <mat-card-title>{{ title() }}</mat-card-title>
        @if (subtitle()) { <mat-card-subtitle>{{ subtitle() }}</mat-card-subtitle> }
      </mat-card-header>
      <mat-card-content>
        @if (loading()) {
          <dm-skeleton height="220px"></dm-skeleton>
        } @else if (empty()) {
          <dm-empty icon="query_stats" title="No data" hint="Run the app to populate this metric"></dm-empty>
        } @else {
          <div class="dm-chart-box"><canvas #canvas></canvas></div>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: [`
    :host { display: block; }
    .dm-trend-card { height: 100%; }
    .dm-chart-box { position: relative; height: 220px; }
  `],
})
export class TrendChartComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef?: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;
  // Signals so OnPush + zoneless picks up flips from setData/setLoading.
  readonly loading = signal(true);
  readonly empty = signal(false);
  readonly title = signal('');
  readonly subtitle = signal('');
  pendingCfg: ChartConfiguration | null = null;

  ngAfterViewInit(): void {
    if (this.pendingCfg) this.applyCfg(this.pendingCfg);
  }

  setData(opts: { title: string; subtitle?: string; chartType: ChartType; labels: string[]; datasets: any[]; stacked?: boolean; yLabel?: string; }): void {
    this.title.set(opts.title);
    this.subtitle.set(opts.subtitle ?? '');
    this.loading.set(false);
    const isEmpty = opts.datasets.every(d => !d.data?.length);
    this.empty.set(isEmpty);
    if (isEmpty) { this.destroy(); return; }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const outline = readToken('--mat-sys-outline-variant') || 'rgba(120,120,120,0.3)';
    const cfg: ChartConfiguration = {
      type: opts.chartType,
      data: { labels: opts.labels, datasets: opts.datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduced ? false : { duration: 200 },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
        scales: {
          x: { stacked: !!opts.stacked, ticks: { maxTicksLimit: 8, autoSkip: true }, grid: { color: outline } },
          y: { stacked: !!opts.stacked, beginAtZero: true, title: opts.yLabel ? { display: true, text: opts.yLabel } : undefined, grid: { color: outline } },
        },
      },
    };
    if (!this.canvasRef) {
      // Race: setLoading() destroyed the canvas, then setData() ran before
      // Angular re-projected the `@else { <canvas> }` branch — so canvasRef is
      // still null at this microtask. queueMicrotask + a couple of fallback
      // animation frames let the view query update before we try again. Without
      // this, the chart silently stays empty after every window/app switch.
      this.pendingCfg = cfg;
      this.flushPendingWhenCanvasReady();
      return;
    }
    this.applyCfg(cfg);
  }

  private flushPendingWhenCanvasReady(attempt = 0): void {
    if (!this.pendingCfg) return;
    if (this.canvasRef?.nativeElement) { this.applyCfg(this.pendingCfg); return; }
    if (attempt >= 10) return; // give up after ~10 frames; something else is wrong
    requestAnimationFrame(() => this.flushPendingWhenCanvasReady(attempt + 1));
  }

  private applyCfg(cfg: ChartConfiguration): void {
    const el = this.canvasRef?.nativeElement;
    if (!el) { this.pendingCfg = cfg; this.flushPendingWhenCanvasReady(); return; }
    if (this.chart) { this.chart.destroy(); }
    this.chart = new Chart(el, cfg);
    this.pendingCfg = null;
  }

  setLoading(): void { this.loading.set(true); this.empty.set(false); this.destroy(); }

  private destroy(): void { this.chart?.destroy(); this.chart = undefined; }

  ngOnDestroy(): void { this.destroy(); }
}

@Component({
  selector: 'dm-trends-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatButtonToggleModule, MatIconModule,
    MonoComponent,
    TrendChartComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Trends</h1>
        <div class="dm-page-sub">Historical compile · bundle · error · restart trends</div>
      </div>
      <div class="dm-controls">
        <mat-button-toggle-group [value]="window()" (change)="onWindowChange($event.value)" hideSingleSelectionIndicator aria-label="Time window">
          <mat-button-toggle value="24h">24h</mat-button-toggle>
          <mat-button-toggle value="7d">7d</mat-button-toggle>
          <mat-button-toggle value="30d">30d</mat-button-toggle>
        </mat-button-toggle-group>
        <mat-button-toggle-group [value]="appFilter()" (change)="onAppChange($event.value)" hideSingleSelectionIndicator aria-label="App scope">
          <mat-button-toggle value="__all__">All apps</mat-button-toggle>
          @for (a of api.apps(); track a.name) {
            <mat-button-toggle [value]="a.name"><dm-mono>{{ a.name }}</dm-mono></mat-button-toggle>
          }
        </mat-button-toggle-group>
        <mat-button-toggle-group [value]="showSelf() ? 'on' : 'off'" (change)="onSelfToggle($event.value)" hideSingleSelectionIndicator aria-label="Self chart">
          <mat-button-toggle value="off">Apps</mat-button-toggle>
          <mat-button-toggle value="on">Self</mat-button-toggle>
        </mat-button-toggle-group>
      </div>
    </div>

    <div class="dm-grid">
      <dm-trend-chart #compileChart></dm-trend-chart>
      <dm-trend-chart #bundleChart></dm-trend-chart>
      <dm-trend-chart #errorChart></dm-trend-chart>
      <dm-trend-chart #restartChart></dm-trend-chart>
      @if (showSelf()) {
        <dm-trend-chart #selfChart></dm-trend-chart>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .dm-page-sub { color: var(--mat-sys-on-surface-variant); font-size: .875rem; }
    .dm-controls { display: flex; gap: .75rem; flex-wrap: wrap; }
    .dm-grid {
      display: grid; gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(28rem, 1fr));
    }
  `],
})
export class TrendsPageComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);

  readonly window = signal<Window>('7d');
  readonly appFilter = signal<string>('__all__');
  readonly showSelf = signal<boolean>(false);

  @ViewChild('compileChart') compileChart?: TrendChartComponent;
  @ViewChild('bundleChart') bundleChart?: TrendChartComponent;
  @ViewChild('errorChart') errorChart?: TrendChartComponent;
  @ViewChild('restartChart') restartChart?: TrendChartComponent;
  @ViewChild('selfChart') selfChart?: TrendChartComponent;

  private timer?: ReturnType<typeof setInterval>;

  async ngOnInit(): Promise<void> {
    await this.api.refresh();
    await this.loadAll();
    this.timer = setInterval(() => void this.loadAll(true), 60_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onWindowChange(w: Window): void { this.window.set(w); void this.loadAll(); }
  onAppChange(a: string): void { this.appFilter.set(a); void this.loadAll(); }
  onSelfToggle(v: 'on' | 'off'): void { this.showSelf.set(v === 'on'); void this.loadAll(); }

  private async loadAll(silent = false): Promise<void> {
    const win = this.window();
    const appScope = this.appFilter();
    const apps = appScope === '__all__' ? this.api.apps().map(a => a.name) : [appScope];
    if (!silent) {
      this.compileChart?.setLoading();
      this.bundleChart?.setLoading();
      this.errorChart?.setLoading();
      this.restartChart?.setLoading();
    }

    const primary = readToken('--mat-sys-primary') || '#6750a4';
    const tertiary = readToken('--mat-sys-tertiary') || '#7d5260';
    const error = readToken('--mat-sys-error') || '#b3261e';
    const secondary = readToken('--mat-sys-secondary') || '#625b71';
    const palette = [primary, tertiary, secondary, error,
                     'color-mix(in oklch, ' + primary + ' 60%, transparent)',
                     'color-mix(in oklch, ' + tertiary + ' 60%, transparent)'];

    // One batched round-trip per app returns all four metrics — cuts the Trends
    // page from 4N parallel calls down to N. With three apps that's 3 round-
    // trips instead of 12.
    const perApp = await Promise.all(apps.map(app =>
      this.api.getTrendsMulti({ app, metrics: ['compile', 'bundle', 'errors', 'restarts'], since: win })
        .then(r => ({ app, r })),
    ));
    const collect = (m: 'compile' | 'bundle' | 'errors' | 'restarts'): Series[] =>
      perApp
        .map(({ app, r }) => ({ app, points: (r?.metrics?.[m]?.points ?? []) as SeriesPoint[] }))
        .filter(s => s.points.length > 0);
    const compileSeries = collect('compile');
    const bundleSeries = collect('bundle');
    const errorSeries = collect('errors');
    const restartSeries = collect('restarts');

    const labelMap = this.unionLabels([compileSeries, bundleSeries, errorSeries, restartSeries], win);

    this.compileChart?.setData({
      title: 'Compile time',
      subtitle: 'avg ms per ' + (win === '24h' ? 'hour' : 'day'),
      chartType: 'line',
      labels: labelMap.labels,
      datasets: compileSeries.map((s, i) => ({
        label: s.app,
        data: this.align(s.points, labelMap.buckets, 'v'),
        borderColor: palette[i % palette.length],
        backgroundColor: 'transparent',
        borderWidth: 1.4, tension: 0.3, pointRadius: 0,
      })),
      yLabel: 'ms',
    });

    const bundleDatasets: any[] = [];
    bundleSeries.forEach((s, i) => {
      bundleDatasets.push({
        label: s.app + ' · initialKB',
        data: this.align(s.points, labelMap.buckets, 'v'),
        backgroundColor: palette[(i * 2) % palette.length],
        stack: s.app,
      });
      bundleDatasets.push({
        label: s.app + ' · lazyKB',
        data: this.align(s.points, labelMap.buckets, 'v2'),
        backgroundColor: palette[(i * 2 + 1) % palette.length],
        stack: s.app,
      });
    });
    this.bundleChart?.setData({
      title: 'Bundle size',
      subtitle: 'initial + lazy KB, stacked',
      chartType: 'bar',
      labels: labelMap.labels,
      datasets: bundleDatasets,
      stacked: true,
      yLabel: 'KB',
    });

    this.errorChart?.setData({
      title: 'Error frequency',
      subtitle: 'errors per ' + (win === '24h' ? 'hour' : 'day'),
      chartType: 'bar',
      labels: labelMap.labels,
      datasets: errorSeries.map((s, i) => ({
        label: s.app,
        data: this.align(s.points, labelMap.buckets, 'v'),
        backgroundColor: palette[i % palette.length],
      })),
      yLabel: 'count',
    });

    this.restartChart?.setData({
      title: 'Restart rate',
      subtitle: 'error→starting transitions per ' + (win === '24h' ? 'hour' : 'day'),
      chartType: 'bar',
      labels: labelMap.labels,
      datasets: restartSeries.map((s, i) => ({
        label: s.app,
        data: this.align(s.points, labelMap.buckets, 'v'),
        backgroundColor: palette[i % palette.length],
      })),
      yLabel: 'count',
    });

    if (this.showSelf()) {
      const rows = await this.api.getSelfHistory(win === '24h' ? '24h' : '7d');
      const sorted = [...rows].sort((a, b) => a.ts - b.ts);
      const labels = sorted.map(r => fmtBucketLabel(r.ts, win));
      this.selfChart?.setData({
        title: 'Daimon self',
        subtitle: 'rss · heap · event-loop lag',
        chartType: 'line',
        labels,
        datasets: [
          { label: 'rssMB', data: sorted.map(r => r.rssMB), borderColor: primary, backgroundColor: 'transparent', borderWidth: 1.4, tension: 0.3, pointRadius: 0 },
          { label: 'heapUsedMB', data: sorted.map(r => r.heapUsedMB), borderColor: tertiary, backgroundColor: 'transparent', borderWidth: 1.4, tension: 0.3, pointRadius: 0 },
          { label: 'eventLoopLagMs', data: sorted.map(r => r.eventLoopLagMs), borderColor: error, backgroundColor: 'transparent', borderWidth: 1.4, tension: 0.3, pointRadius: 0, yAxisID: 'y1' },
        ],
        yLabel: 'MB / ms',
      });
    }
  }

  private async fetchSeries(apps: string[], metric: Metric, win: Window): Promise<Series[]> {
    if (apps.length === 0) return [];
    const results = await Promise.all(apps.map(async app => {
      const r = await this.api.getTrends({ app, metric, since: win });
      return { app, points: (r?.points ?? []) as SeriesPoint[] };
    }));
    return results.filter(r => r.points.length > 0);
  }

  private unionLabels(seriesGroups: Series[][], win: Window): { buckets: number[]; labels: string[] } {
    const set = new Set<number>();
    for (const group of seriesGroups) for (const s of group) for (const p of s.points) set.add(p.t);
    const buckets = [...set].sort((a, b) => a - b);
    return { buckets, labels: buckets.map(t => fmtBucketLabel(t, win)) };
  }

  private align(points: SeriesPoint[], buckets: number[], key: 'v' | 'v2'): number[] {
    const m = new Map<number, SeriesPoint>();
    for (const p of points) m.set(p.t, p);
    return buckets.map(t => {
      const p = m.get(t);
      if (!p) return 0;
      const v = key === 'v' ? p.v : p.v2;
      return typeof v === 'number' ? v : 0;
    });
  }
}
