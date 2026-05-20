import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatDividerModule } from '@angular/material/divider';
import { DaimonApi } from './daimon-api';
import { EmptyStateComponent, SkeletonComponent, MonoComponent } from './ui-primitives';
import { parseSummary, vscodeUri, summaryLabel, pillKindFor, type ParsedSummary as _ParsedSummary } from './tests-page-helpers';

interface TaskRun {
  id: number;
  ts: number;
  app: string;
  task: string;
  exit_code: number | null;
  duration_ms: number | null;
  summary: string | null;
}

type ParsedSummary = _ParsedSummary;

interface AppCard {
  app: string;
  runs: TaskRun[];
  latest: TaskRun | null;
  latestSummary: ParsedSummary | null;
  trend: { ts: number; passed: number; failed: number }[];
}

@Component({
  selector: 'dm-tests-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatCardModule, MatButtonModule, MatIconModule, MatExpansionModule, MatDividerModule, EmptyStateComponent, SkeletonComponent, MonoComponent],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Tests</h1>
        <div class="dm-page-sub">Pass/fail trends per app from <dm-mono>task_runs</dm-mono> (last 30d). Click a card to inspect the most recent run.</div>
      </div>
      <button mat-icon-button aria-label="Refresh" (click)="refresh()"><mat-icon>refresh</mat-icon></button>
    </div>

    @if (loading()) {
      <dm-skeleton height="14rem"></dm-skeleton>
    } @else if (cards().length === 0) {
      <dm-empty icon="science" title="No test runs recorded yet" hint="Run daimon run NAME test (or any task whose name contains 'test') to populate this page."></dm-empty>
    } @else {
      <div class="dm-grid">
        @for (c of cards(); track c.app) {
          <mat-expansion-panel class="dm-card" [expanded]="false">
            <mat-expansion-panel-header>
              <mat-panel-title>
                <span class="dm-pill" [attr.data-kind]="pillKindFor(c)">
                  <span class="dm-dot"></span>{{ summaryFor(c) }}
                </span>
                <dm-mono class="dm-app">{{ c.app }}</dm-mono>
              </mat-panel-title>
              <mat-panel-description>
                <span class="dm-sub">{{ subtitleFor(c) }}</span>
              </mat-panel-description>
            </mat-expansion-panel-header>

            <div class="dm-trend-row" aria-label="Recent pass/fail history">
              @for (t of c.trend; track t.ts) {
                <span class="dm-tick" [attr.data-kind]="t.failed > 0 ? 'fail' : 'pass'" [attr.title]="trendLabel(t)"></span>
              }
            </div>

            @if (c.latest && c.latestSummary?.failedTests?.length) {
              <h4 class="dm-h4">Failed tests</h4>
              <ul class="dm-fail-list">
                @for (f of c.latestSummary!.failedTests!; track f.name + (f.file ?? '')) {
                  <li>
                    <span class="dm-fail-name">{{ f.name }}</span>
                    @if (f.file) {
                      <a class="dm-fail-jump" [href]="vscodeJump(f.file, f.line)" target="_blank" rel="noopener">
                        <dm-mono>{{ f.file }}{{ f.line ? ':' + f.line : '' }}</dm-mono>
                        <mat-icon class="dm-jump-icon">launch</mat-icon>
                      </a>
                    }
                  </li>
                }
              </ul>
            }
            @if (c.latest && !c.latestSummary?.failedTests?.length && c.latest.exit_code === 0) {
              <div class="dm-muted">No failed tests in the most recent run.</div>
            }
            @if (c.latest && c.latest.exit_code !== null && c.latest.exit_code !== 0 && !c.latestSummary?.failedTests?.length) {
              <div class="dm-muted">The task exited with code {{ c.latest.exit_code }} but no structured failures were parsed — check raw logs.</div>
            }
          </mat-expansion-panel>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; max-width: 1200px; margin: 0 auto; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .dm-page-sub { color: var(--mat-sys-on-surface-variant); font-size: .875rem; }
    .dm-grid { display: grid; gap: .75rem; }
    .dm-card { background: var(--mat-sys-surface-container-low); }
    .dm-app { margin-left: .75rem; }
    .dm-sub { color: var(--mat-sys-on-surface-variant); font-size: .8125rem; }
    .dm-pill {
      display: inline-flex; align-items: center; gap: .4rem;
      padding: 2px 10px; border-radius: 999px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface);
      font: 500 .75rem/1rem Roboto;
    }
    .dm-pill .dm-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--mat-sys-outline); }
    .dm-pill[data-kind="ok"] {
      background: color-mix(in oklch, var(--mat-sys-primary) 12%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-primary) 28%, transparent);
    }
    .dm-pill[data-kind="ok"] .dm-dot { background: var(--mat-sys-primary); }
    .dm-pill[data-kind="fail"] {
      background: color-mix(in oklch, var(--mat-sys-error) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-error) 30%, transparent);
      color: var(--mat-sys-error);
    }
    .dm-pill[data-kind="fail"] .dm-dot { background: var(--mat-sys-error); }
    .dm-trend-row { display: flex; gap: 2px; margin: .5rem 0; }
    .dm-tick {
      width: 6px; height: 16px; border-radius: 2px;
      background: var(--mat-sys-outline-variant);
    }
    .dm-tick[data-kind="pass"] { background: var(--mat-sys-primary); }
    .dm-tick[data-kind="fail"] { background: var(--mat-sys-error); }
    .dm-h4 { margin: .75rem 0 .35rem; font: 500 .8125rem/1rem Roboto; color: var(--mat-sys-on-surface-variant); }
    .dm-fail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .dm-fail-list li {
      padding: .35rem .6rem; border-radius: 6px;
      background: var(--mat-sys-surface-container);
      display: flex; align-items: center; justify-content: space-between; gap: .75rem;
      flex-wrap: wrap;
    }
    .dm-fail-name { color: var(--mat-sys-on-surface); font-size: .875rem; overflow-wrap: anywhere; }
    .dm-fail-jump { color: var(--mat-sys-primary); text-decoration: none; display: inline-flex; align-items: center; gap: .35rem; font-size: .8125rem; }
    .dm-fail-jump:hover { text-decoration: underline; }
    .dm-jump-icon { font-size: 14px; width: 14px; height: 14px; }
    .dm-muted { color: var(--mat-sys-on-surface-variant); font-size: .875rem; }
  `],
})
export class TestsPageComponent implements OnInit {
  readonly api = inject(DaimonApi);
  private readonly http = inject(HttpClient);

  readonly loading = signal<boolean>(true);
  readonly cards = signal<AppCard[]>([]);

  pillKindFor(c: AppCard): 'ok' | 'fail' | 'neutral' {
    return pillKindFor(c.latest, c.latestSummary);
  }

  summaryFor(c: AppCard): string {
    return summaryLabel(c.latest, c.latestSummary);
  }

  subtitleFor(c: AppCard): string {
    if (!c.latest) return '';
    const fw = c.latestSummary?.framework ?? 'unknown';
    const dur = c.latest.duration_ms != null ? ` · ${(c.latest.duration_ms / 1000).toFixed(1)}s` : '';
    const ago = Math.max(0, Math.round((Date.now() - c.latest.ts) / 60000));
    return `${fw}${dur} · ${ago}m ago · ${c.runs.length} runs in last 30d`;
  }

  trendLabel(t: { ts: number; passed: number; failed: number }): string {
    const d = new Date(t.ts).toLocaleString();
    return `${d} — ${t.passed} passed${t.failed > 0 ? ', ' + t.failed + ' failed' : ''}`;
  }

  vscodeJump(file: string, line?: number): string {
    return vscodeUri(file, line);
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      await this.api.refresh();
      const apps = this.api.apps().map(a => a.name);
      const cards: AppCard[] = [];
      const since = Date.now() - 30 * 24 * 3600 * 1000;
      for (const app of apps) {
        const rows = await this.fetchTaskRuns(app, since);
        if (!rows.length) continue;
        const testRows = rows.filter(r => /test/i.test(r.task));
        if (!testRows.length) continue;
        const sorted = [...testRows].sort((a, b) => b.ts - a.ts);
        const latest = sorted[0] ?? null;
        const trend = sorted
          .slice(0, 30)
          .reverse()
          .map(r => {
            const s = parseSummary(r.summary);
            return { ts: r.ts, passed: s?.passed ?? (r.exit_code === 0 ? 1 : 0), failed: s?.failed ?? (r.exit_code === 0 ? 0 : 1) };
          });
        cards.push({
          app,
          runs: sorted,
          latest,
          latestSummary: latest ? parseSummary(latest.summary) : null,
          trend,
        });
      }
      this.cards.set(cards);
    } finally {
      this.loading.set(false);
    }
  }

  private async fetchTaskRuns(app: string, since: number): Promise<TaskRun[]> {
    try {
      const r = await firstValueFrom(this.http.get<TaskRun[]>(`/api/history/tasks?app=${encodeURIComponent(app)}&since=${Math.round((Date.now() - since) / 1000)}s&limit=200`));
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }
}
