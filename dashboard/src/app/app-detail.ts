import { ChangeDetectionStrategy, Component, Input, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatChipsModule } from '@angular/material/chips';
import { DaimonApi, statusBadge } from './daimon-api';
import { MetricsChartComponent } from './metrics-chart';

interface DetailError { message: string; count: number; parsed?: { file?: string; line?: number; col?: number; code?: string; message?: string } }

@Component({
  selector: 'dm-app-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonModule, MatTabsModule, MatChipsModule, MetricsChartComponent],
  template: `
    @if (summary(); as s) {
      @let badge = makeBadge(s);
      <div style="display:flex;align-items:baseline;gap:1rem;margin-bottom:1rem;">
        <h2 style="margin:0;">{{ s.name }}</h2>
        <mat-chip><span [style.color]="badge.color">●</span>&nbsp;{{ badge.label }}</mat-chip>
        @if (s.workspaceLabel) { <span style="color:var(--mat-sys-on-surface-variant);">{{ s.workspaceLabel }}</span> }
      </div>
      <mat-card style="margin-bottom:1rem;">
        <mat-card-content>
          <div>port: {{ s.port ?? '—' }}</div>
          <div>url: @if (s.url) { <a [href]="s.url" target="_blank">{{ s.url }}</a> } @else { — }</div>
          <div>uptime: {{ fmtUptime(s.uptimeMs) }}</div>
          <div>last compile: {{ s.lastCompileMs ?? 0 }} ms</div>
          <div>cpu: {{ s.cpu ?? 0 }}% · mem: {{ s.memMB ?? 0 }} MB</div>
          @if (s.lastHealthError) { <div style="color:var(--mat-sys-error);">health: {{ s.lastHealthError }}</div> }
        </mat-card-content>
        <mat-card-actions>
          <button mat-flat-button color="primary" (click)="api.start(s.name)">start</button>
          <button mat-button (click)="api.stop(s.name)">stop</button>
          <button mat-button (click)="api.restart(s.name)">restart</button>
        </mat-card-actions>
      </mat-card>
      <mat-card style="margin-bottom:1rem;">
        <mat-card-header><mat-card-title>Resources</mat-card-title></mat-card-header>
        <mat-card-content>
          <dm-metrics-chart [name]="s.name"></dm-metrics-chart>
        </mat-card-content>
      </mat-card>
      <mat-card>
        <mat-card-header><mat-card-title>Errors ({{ errors().length }})</mat-card-title></mat-card-header>
        <mat-card-content>
          @for (e of errors(); track $index) {
            <div style="padding:.5rem 0;border-bottom:1px solid var(--mat-sys-outline-variant);">
              @if (e.parsed?.file) { <div><strong>{{ e.parsed?.file }}:{{ e.parsed?.line }}:{{ e.parsed?.col }}</strong> {{ e.parsed?.code }}</div> }
              <div style="font-family:monospace;font-size:.875rem;">{{ e.parsed?.message ?? e.message }}</div>
              <div style="color:var(--mat-sys-on-surface-variant);font-size:.75rem;">×{{ e.count }}</div>
            </div>
          } @empty {
            <div style="color:var(--mat-sys-on-surface-variant);">No errors recorded.</div>
          }
        </mat-card-content>
      </mat-card>
    } @else {
      <div>Loading…</div>
    }
  `,
})
export class AppDetailComponent implements OnInit, OnDestroy {
  @Input() name = '';
  readonly api = inject(DaimonApi);
  private readonly http = inject(HttpClient);
  private timer?: ReturnType<typeof setInterval>;

  private readonly state = signal<any>(null);
  private readonly errs = signal<DetailError[]>([]);

  summary = computed(() => this.state());
  errors = computed(() => this.errs());

  makeBadge = statusBadge;

  fmtUptime(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }

  async ngOnInit(): Promise<void> {
    const refresh = async () => {
      try {
        const [s, e] = await Promise.all([
          firstValueFrom(this.http.get<any>(`/api/apps/${encodeURIComponent(this.name)}?format=full`)),
          firstValueFrom(this.http.get<any[]>(`/api/apps/${encodeURIComponent(this.name)}/errors?format=full`)),
        ]);
        this.state.set(s);
        this.errs.set(Array.isArray(e) ? e : []);
      } catch {}
    };
    await refresh();
    this.timer = setInterval(refresh, 2000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }
}
