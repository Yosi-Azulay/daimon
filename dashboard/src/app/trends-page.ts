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
import type { TestRun } from './tests-page-helpers';
import {
  fmtBucketLabel, unionLabels, alignSeries, TREND_METRICS,
  type Window, type Series, type SeriesPoint, type TrendMetric,
} from './trends-page-helpers';

Chart.register(...registerables);

type Metric = TrendMetric;

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
      // Angular re-projected the `@else { <canvas> }` branch â€” so canvasRef is
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
        <div class="dm-page-sub">Historical compile · bundle · error · restart · test pass-rate · flaky · resource trends</div>
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
      <dm-trend-chart #testPassRateChart></dm-trend-chart>
      <dm-trend-chart #flakyChart></dm-trend-chart>
      <dm-trend-chart #rssChart></dm-trend-chart>
      <dm-trend-chart #cpuChart></dm-trend-chart>
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
      grid-template-columns: repeat(auto-fit, minmax(min(28rem, 100%), 1fr));
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
  @ViewChild('testPassRateChart') testPassRateChart?: TrendChartComponent;
  @ViewChild('flakyChart') flakyChart?: TrendChartComponent;
  @ViewChild('rssChart') rssChart?: TrendChartComponent;
  @ViewChild('cpuChart') cpuChart?: TrendChartComponent;
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
      this.testPassRateChart?.setLoading();
      this.flakyChart?.setLoading();
      this.rssChart?.setLoading();
      this.cpuChart?.setLoading();
    }

    const primary = readToken('--mat-sys-primary') || '#6750a4';
    const tertiary = readToken('--mat-sys-tertiary') || '#7d5260';
    const error = readToken('--mat-sys-error') || '#b3261e';
    const secondary = readToken('--mat-sys-secondary') || '#625b71';
    const palette = [primary, tertiary, secondary, error,
                     'color-mix(in oklch, ' + primary + ' 60%, transparent)',
                     'color-mix(in oklch, ' + tertiary + ' 60%, transparent)'];

    // One batched round-trip per app returns all four metrics â€” cuts the Trends
    // page from 4N parallel calls down to N. With three apps that's 3 round-
    // trips instead of 12.
    const perApp = await Promise.all(apps.map(app =>
      this.api.getTrendsMulti({ app, metrics: [...TREND_METRICS], since: win })
        .then(r => ({ app, r })),
    ));
    const collect = (m: TrendMetric): Series[] =>
      perApp
        .map(({ app, r }) => ({ app, points: (r?.metrics?.[m]?.points ?? []) as SeriesPoint[] }))
        .filter(s => s.points.length > 0);
    const compileSeries = collect('compile');
    const bundleSeries = collect('bundle');
    const errorSeries = collect('errors');
    const restartSeries = collect('restarts');

    const labelMap = unionLabels([compileSeries, bundleSeries, errorSeries, restartSeries], win);

    this.compileChart?.setData({
      title: 'Compile time',
      subtitle: 'avg ms per ' + (win === '24h' ? 'hour' : 'day'),
      chartType: 'line',
      labels: labelMap.labels,
      datasets: compileSeries.map((s, i) => ({
        label: s.app,
        data: alignSeries(s.points, labelMap.buckets, 'v'),
        borderColor: palette[i % palette.length],
        backgroundColor: 'transparent',
        borderWidth: 1.4, tension: 0.3, pointRadius: 0,
      })),
      yLabel: 'ms',
    });

    const bundleDatasets: any[] = [];
    bundleSeries.forEach((s, i) => {
      bundleDatasets.push({
        label: s.app + ' Â· initialKB',
        data: alignSeries(s.points, labelMap.buckets, 'v'),
        backgroundColor: palette[(i * 2) % palette.length],
        stack: s.app,
      });
      bundleDatasets.push({
        label: s.app + ' Â· lazyKB',
        data: alignSeries(s.points, labelMap.buckets, 'v2'),
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
        data: alignSeries(s.points, labelMap.buckets, 'v'),
        backgroundColor: palette[i % palette.length],
      })),
      yLabel: 'count',
    });

    this.restartChart?.setData({
      title: 'Restart rate',
      subtitle: 'errorâ†’starting transitions per ' + (win === '24h' ? 'hour' : 'day'),
      chartType: 'bar',
      labels: labelMap.labels,
      datasets: restartSeries.map((s, i) => ({
        label: s.app,
        data: alignSeries(s.points, labelMap.buckets, 'v'),
        backgroundColor: palette[i % palette.length],
      })),
      yLabel: 'count',
    });

    // Test pass-rate over time (M85): buckets the run history client-side
    // (the server has no bucketed test-trend endpoint, unlike compile/bundle/
    // error/restart which pull already-aggregated points from
    // /api/history/trends). Pass rate per bucket = sum(passed)/sum(total)
    // across that bucket's runs, per app; buckets with no totals are skipped
    // rather than shown as 0% (a run with no parsed totals isn't a 0% run).
    const testRuns = await this.api.getTestRuns({ since: win, limit: 500 });
    const passRateByApp = new Map<string, SeriesPoint[]>();
    for (const app of apps) {
      const appRuns = testRuns.filter(r => r.app === app);
      const buckets = new Map<number, { passed: number; total: number }>();
      for (const r of appRuns) {
        if (typeof r.total !== 'number' || r.total <= 0) continue;
        const key = this.bucketKey(r.ts, win);
        const b = buckets.get(key) ?? { passed: 0, total: 0 };
        b.passed += r.passed ?? 0;
        b.total += r.total;
        buckets.set(key, b);
      }
      const points = [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([t, b]) => ({ t, v: Math.round((b.passed / b.total) * 1000) / 10 }));
      if (points.length) passRateByApp.set(app, points);
    }
    const passRateSeries: Series[] = [...passRateByApp.entries()].map(([app, points]) => ({ app, points }));
    const passRateLabels = unionLabels([passRateSeries], win);
    this.testPassRateChart?.setData({
      title: 'Test pass rate',
      subtitle: 'passed/total per ' + (win === '24h' ? 'hour' : 'day') + ', from daimon test runs',
      chartType: 'line',
      labels: passRateLabels.labels,
      datasets: passRateSeries.map((s, i) => ({
        label: s.app,
        data: alignSeries(s.points, passRateLabels.buckets, 'v'),
        borderColor: palette[i % palette.length],
        backgroundColor: 'transparent',
        borderWidth: 1.4, tension: 0.3, pointRadius: 0,
      })),
      yLabel: '%',
    });

    // Flaky test count (M85): daimon only ever tracks the CURRENT flaky set
    // (flips at the latest gitHead, per M75) — there's no historical flaky
    // count to bucket over time without fabricating data. Rendered honestly
    // as a per-app snapshot bar, not a time series.
    const flakyResults = await Promise.all(apps.map(app => this.api.getFlakyTests(app)));
    const flakyLabels = apps;
    this.flakyChart?.setData({
      title: 'Flaky tests',
      subtitle: 'current count per app (not a time series — daimon tracks flakiness at the latest gitHead only)',
      chartType: 'bar',
      labels: flakyLabels,
      datasets: [{
        label: 'flaky tests',
        data: flakyResults.map(r => r.flaky.length),
        backgroundColor: tertiary,
      }],
      yLabel: 'count',
    });

    // Resource series (M109, v1.3 — experimental): rss/cpu ride the same
    // batched perApp fetch above (see TREND_METRICS), so this is purely
    // shaping — no extra round-trip.
    const rssSeries = collect('rss');
    const cpuSeries = collect('cpu');
    const resourceLabels = unionLabels([rssSeries, cpuSeries], win);
    this.rssChart?.setData({
      title: 'RSS (MB)',
      subtitle: 'avg MB per ' + (win === '24h' ? 'hour' : 'day'),
      chartType: 'line',
      labels: resourceLabels.labels,
      datasets: rssSeries.map((s, i) => ({
        label: s.app,
        data: alignSeries(s.points, resourceLabels.buckets, 'v'),
        borderColor: palette[i % palette.length],
        backgroundColor: 'transparent',
        borderWidth: 1.4, tension: 0.3, pointRadius: 0,
      })),
      yLabel: 'MB',
    });
    this.cpuChart?.setData({
      title: 'CPU (%)',
      subtitle: 'avg % per ' + (win === '24h' ? 'hour' : 'day'),
      chartType: 'line',
      labels: resourceLabels.labels,
      datasets: cpuSeries.map((s, i) => ({
        label: s.app,
        data: alignSeries(s.points, resourceLabels.buckets, 'v'),
        borderColor: palette[i % palette.length],
        backgroundColor: 'transparent',
        borderWidth: 1.4, tension: 0.3, pointRadius: 0,
      })),
      yLabel: '%',
    });

    if (this.showSelf()) {
      const rows = await this.api.getSelfHistory(win === '24h' ? '24h' : '7d');
      const sorted = [...rows].sort((a, b) => a.ts - b.ts);
      const labels = sorted.map(r => fmtBucketLabel(r.ts, win));
      this.selfChart?.setData({
        title: 'Daimon self',
        subtitle: 'rss Â· heap Â· event-loop lag',
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

  // Bucket boundary for client-side test-run aggregation (M85): hourly under
  // a 24h window, daily otherwise — matches the granularity implied by
  // fmtBucketLabel so axis labels and bucket width agree.
  private bucketKey(ts: number, win: Window): number {
    const d = new Date(ts);
    if (win === '24h') { d.setMinutes(0, 0, 0); return d.getTime(); }
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

}
