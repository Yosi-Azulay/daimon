import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';

Chart.register(...registerables);

interface Sample { ts: number; cpu: number; memMB: number; }

// Canvas can't consume CSS custom properties directly — read the resolved
// (theme-aware, light-dark()-computed) token value at chart-build time.
// Same pattern trends-page.ts already uses for its palette.
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

@Component({
  selector: 'dm-metrics-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="position:relative;height:220px;" role="img" [attr.aria-label]="chartSummary()">
      <canvas #canvas aria-hidden="true"></canvas>
    </div>
  `,
})
export class MetricsChartComponent implements AfterViewInit, OnDestroy {
  @Input() name = '';
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;
  private samples: Sample[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly http = inject(HttpClient);
  readonly chartSummary = signal('CPU and memory usage over time: no samples yet');

  ngAfterViewInit(): void {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cpuColor = readToken('--dm-chart-1');
    const memColor = readToken('--dm-chart-2');
    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'CPU %', data: [], yAxisID: 'y1', borderColor: cpuColor, backgroundColor: `color-mix(in oklch, ${cpuColor} 12%, transparent)`, tension: 0.25, pointRadius: 0, fill: true },
          { label: 'Mem MB', data: [], yAxisID: 'y2', borderColor: memColor, backgroundColor: `color-mix(in oklch, ${memColor} 10%, transparent)`, tension: 0.25, pointRadius: 0, fill: true },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduced ? false : { duration: 200 },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
        scales: {
          x: { ticks: { maxTicksLimit: 6, autoSkip: true } },
          y1: { position: 'left', beginAtZero: true, title: { display: true, text: 'CPU %' } },
          y2: { position: 'right', beginAtZero: true, title: { display: true, text: 'Mem MB' }, grid: { display: false } },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, config);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.chart?.destroy();
  }

  private async tick(): Promise<void> {
    if (!this.name || !this.chart) return;
    try {
      const s = await firstValueFrom(this.http.get<any>(`/api/apps/${encodeURIComponent(this.name)}?format=full`));
      this.samples.push({ ts: Date.now(), cpu: Number(s?.cpu ?? 0), memMB: Number(s?.memMB ?? 0) });
      if (this.samples.length > 60) this.samples.shift();
      this.chart.data.labels = this.samples.map(x => new Date(x.ts).toLocaleTimeString());
      this.chart.data.datasets[0].data = this.samples.map(x => x.cpu);
      this.chart.data.datasets[1].data = this.samples.map(x => x.memMB);
      this.chart.update('none');
      const last = this.samples[this.samples.length - 1];
      this.chartSummary.set(`CPU and memory usage over time: latest ${last.cpu.toFixed(1)}% CPU, ${last.memMB.toFixed(0)} MB memory, over ${this.samples.length} samples`);
    } catch {}
  }
}
