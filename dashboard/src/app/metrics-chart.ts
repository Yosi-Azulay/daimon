import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input, OnDestroy, ViewChild, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';

Chart.register(...registerables);

interface Sample { ts: number; cpu: number; memMB: number; }

@Component({
  selector: 'dm-metrics-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="position:relative;height:220px;">
      <canvas #canvas></canvas>
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

  ngAfterViewInit(): void {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'CPU %', data: [], yAxisID: 'y1', borderColor: 'rgb(96, 165, 250)', backgroundColor: 'rgba(96, 165, 250, 0.12)', tension: 0.25, pointRadius: 0, fill: true },
          { label: 'Mem MB', data: [], yAxisID: 'y2', borderColor: 'rgb(168, 85, 247)', backgroundColor: 'rgba(168, 85, 247, 0.10)', tension: 0.25, pointRadius: 0, fill: true },
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
    } catch {}
  }
}
