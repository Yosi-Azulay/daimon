import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DaimonApi } from './daimon-api';
import { EmptyStateComponent, SkeletonComponent, MonoComponent } from './ui-primitives';
import {
  diffRuns,
  flakyByFingerprint,
  groupRunsByApp,
  isFlaky,
  pillKindForRun,
  runLabel,
  shortHead,
  sparklineFor,
  vscodeUri,
  type FlakyTest,
  type RunDiff,
  type SparkCell,
  type TestFailure,
  type TestRun,
} from './tests-page-helpers';

interface AppCard {
  app: string;
  runs: TestRun[];
  latest: TestRun | null;
  spark: SparkCell[];
  flaky: Map<string, FlakyTest>;
  flakyList: FlakyTest[];
}

const RUN_FETCH_LIMIT = 500;
const SPARK_MAX = 30;

@Component({
  selector: 'dm-tests-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatExpansionModule, MatIconModule, MatTooltipModule, EmptyStateComponent, SkeletonComponent, MonoComponent],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Tests</h1>
        <div class="dm-page-sub">Run history from <dm-mono>daimon test</dm-mono>. Click a run to see its failures, or select two to diff.</div>
      </div>
      <button type="button" class="ib" (click)="refresh()" [disabled]="loading()" aria-label="Refresh" matTooltip="Refresh">
        <mat-icon fontSet="material-symbols-outlined" [class.spin]="loading()">refresh</mat-icon>
      </button>
    </div>

    @if (loading() && cards().length === 0) {
      <dm-skeleton height="14rem"></dm-skeleton>
    } @else if (cards().length === 0) {
      <dm-empty icon="science" title="No test runs recorded yet" hint="Run daimon test &lt;app&gt; (or let an agent do it) to populate this page."></dm-empty>
    } @else {
      <div class="dm-grid">
        @for (c of cards(); track c.app) {
          <mat-expansion-panel class="dm-card" [expanded]="cards().length === 1">
            <mat-expansion-panel-header>
              <mat-panel-title>
                <span class="dm-pill" [attr.data-kind]="pillKindForRun(c.latest)">
                  <span class="dm-dot"></span>{{ runLabel(c.latest!) }}
                </span>
                <dm-mono class="dm-app">{{ c.app }}</dm-mono>
                @if (c.flaky.size > 0) {
                  <span class="dm-flaky-count" matTooltip="Tests flagged flaky at the current gitHead">
                    <mat-icon fontSet="material-symbols-outlined">shuffle</mat-icon>{{ c.flaky.size }}
                  </span>
                }
              </mat-panel-title>
              <mat-panel-description>
                <span class="dm-sub">{{ subtitleFor(c) }}</span>
              </mat-panel-description>
            </mat-expansion-panel-header>

            <div class="dm-trend-row" aria-label="Recent pass/fail history">
              @for (cell of c.spark; track cell.id) {
                <button type="button" class="dm-tick" [attr.data-kind]="cell.outcome"
                        [attr.title]="tickLabel(cell)" (click)="toggleRun(c.app, cell.id)"></button>
              }
            </div>

            @if (c.flaky.size > 0) {
              <div class="dm-flaky-section">
                <h4 class="dm-h4">Flaky tests <span class="dm-muted">(≥{{ flakyThreshold() }} flips at this gitHead)</span></h4>
                <div class="dm-chip-row">
                  @for (f of c.flakyList; track f.fingerprint) {
                    <span class="dm-chip dm-chip-flaky" [matTooltip]="f.suite + ' · ' + f.gitHead.slice(0, 7)">
                      <mat-icon fontSet="material-symbols-outlined">shuffle</mat-icon>{{ f.test }} <span class="dm-flips">×{{ f.flips }}</span>
                    </span>
                  }
                </div>
              </div>
            }

            <h4 class="dm-h4">Runs</h4>
            <div class="dm-runs" role="list">
              @for (r of c.runs; track r.id) {
                <div class="dm-run-row" [class.expanded]="isExpanded(c.app, r.id)" role="listitem">
                  <label class="dm-cmp" [matTooltip]="'Select for diff'" (click)="$event.stopPropagation()">
                    <input type="checkbox" [checked]="isSelectedForDiff(c.app, r.id)" (change)="toggleDiffSelect(c.app, r.id)" />
                  </label>
                  <button type="button" class="dm-run-main" (click)="toggleRun(c.app, r.id)">
                    <span class="dm-run-kind" [attr.data-kind]="outcomeKind(r)"></span>
                    <span class="dm-run-ago">{{ fmtAgo(r.ts) }}</span>
                    @if (r.runner) { <span class="dm-runner-badge">{{ r.runner }}</span> }
                    <span class="dm-run-label">{{ runLabel(r) }}</span>
                    <span class="dm-run-dur">{{ fmtDuration(r.durationMs) }}</span>
                    <dm-mono class="dm-run-head">{{ shortHead(r.gitHead) }}</dm-mono>
                    <span class="dm-run-exit">exit {{ r.exitCode ?? '?' }}</span>
                    <mat-icon fontSet="material-symbols-outlined" class="dm-run-chevron">{{ isExpanded(c.app, r.id) ? 'expand_less' : 'expand_more' }}</mat-icon>
                  </button>
                </div>
                @if (isExpanded(c.app, r.id)) {
                  <div class="dm-drilldown">
                    @if (r.failures.length === 0) {
                      <div class="dm-muted">No failures in this run.</div>
                    } @else {
                      <ul class="dm-fail-list">
                        @for (f of r.failures; track (f.fingerprint ?? '') + (f.test ?? '')) {
                          <li>
                            @if (isFlaky(f.fingerprint, c.flaky)) {
                              <span class="dm-flaky-tag" matTooltip="Flaky at this gitHead"><mat-icon fontSet="material-symbols-outlined">shuffle</mat-icon>flaky</span>
                            }
                            <span class="dm-fail-name">{{ failureLabel(f) }}</span>
                            @if (f.file) {
                              <a class="dm-fail-jump" [href]="vscodeUri(f.file, f.line ?? undefined)" target="_blank" rel="noopener">
                                <dm-mono>{{ f.file }}{{ f.line ? ':' + f.line : '' }}</dm-mono>
                                <mat-icon fontSet="material-symbols-outlined" class="dm-jump-icon">launch</mat-icon>
                              </a>
                            }
                          </li>
                        }
                      </ul>
                    }
                  </div>
                }
              }
            </div>

            @if (diffFor(c.app); as diff) {
              <div class="dm-diff">
                <div class="dm-diff-head">
                  <h4 class="dm-h4">Diff — {{ diffRunsLabel(c.app) }}</h4>
                  <button type="button" class="dm-diff-clear" (click)="clearDiff(c.app)">Clear</button>
                </div>
                <div class="dm-diff-cols">
                  <div class="dm-diff-col">
                    <div class="dm-diff-col-title dm-diff-fail">Newly failing ({{ diff.newlyFailing.length }})</div>
                    @if (diff.newlyFailing.length === 0) {
                      <div class="dm-muted">None</div>
                    } @else {
                      <ul class="dm-fail-list">
                        @for (f of diff.newlyFailing; track f.fingerprint) {
                          <li>
                            <span class="dm-fail-name">{{ failureLabel(f) }}</span>
                            @if (f.file) {
                              <a class="dm-fail-jump" [href]="vscodeUri(f.file, f.line ?? undefined)" target="_blank" rel="noopener">
                                <dm-mono>{{ f.file }}{{ f.line ? ':' + f.line : '' }}</dm-mono>
                              </a>
                            }
                          </li>
                        }
                      </ul>
                    }
                  </div>
                  <div class="dm-diff-col">
                    <div class="dm-diff-col-title dm-diff-pass">Newly passing ({{ diff.newlyPassing.length }})</div>
                    @if (diff.newlyPassing.length === 0) {
                      <div class="dm-muted">None</div>
                    } @else {
                      <ul class="dm-fail-list">
                        @for (f of diff.newlyPassing; track f.fingerprint) {
                          <li><span class="dm-fail-name">{{ failureLabel(f) }}</span></li>
                        }
                      </ul>
                    }
                  </div>
                </div>
              </div>
            }
          </mat-expansion-panel>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; max-width: 1200px; margin: 0 auto; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .dm-page-header h1 { margin: 0; font: 400 1.5rem/2rem Roboto; }
    .dm-page-sub { color: var(--dm-color-fg-muted); font-size: var(--dm-text-sm); margin-top: .25rem; }
    .ib { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; background: transparent; border: 1px solid var(--dm-color-border); border-radius: var(--dm-radius-lg); color: var(--dm-color-fg-muted); cursor: pointer; }
    .ib:hover:not(:disabled) { background: var(--dm-color-surface-3); color: var(--dm-color-fg); }
    .ib:disabled { opacity: .55; cursor: not-allowed; }
    .spin { animation: dm-spin 1s linear infinite; }
    @keyframes dm-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

    .dm-grid { display: grid; gap: .75rem; }
    .dm-card { background: var(--dm-color-surface) !important; border: 1px solid var(--dm-color-border); border-radius: var(--dm-radius-xl) !important; box-shadow: none !important; overflow: hidden; }
    .dm-app { margin-left: .75rem; }
    .dm-sub { color: var(--dm-color-fg-muted); font-size: var(--dm-text-sm); }
    .dm-muted { color: var(--dm-color-fg-muted); font-size: var(--dm-text-sm); }

    .dm-pill { display: inline-flex; align-items: center; gap: .4rem; padding: 2px 10px; border-radius: var(--dm-radius-full); border: 1px solid var(--dm-color-border); background: var(--dm-color-surface-2); color: var(--dm-color-fg); font: 500 var(--dm-text-xs)/1rem Roboto; }
    .dm-pill .dm-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--dm-color-fg-muted); }
    .dm-pill[data-kind="ok"] { background: color-mix(in oklch, var(--dm-color-serving) 12%, transparent); border-color: color-mix(in oklch, var(--dm-color-serving) 28%, transparent); }
    .dm-pill[data-kind="ok"] .dm-dot { background: var(--dm-color-serving); }
    .dm-pill[data-kind="fail"] { background: color-mix(in oklch, var(--dm-color-error) 14%, transparent); border-color: color-mix(in oklch, var(--dm-color-error) 30%, transparent); color: var(--dm-color-error); }
    .dm-pill[data-kind="fail"] .dm-dot { background: var(--dm-color-error); }

    .dm-flaky-count { display: inline-flex; align-items: center; gap: 2px; margin-left: .5rem; padding: 1px 8px; border-radius: var(--dm-radius-full); background: color-mix(in oklch, var(--dm-color-accent) 14%, transparent); color: var(--dm-color-accent); font: 600 var(--dm-text-xs)/1rem Roboto; }
    .dm-flaky-count mat-icon { font-size: 14px; width: 14px; height: 14px; }

    .dm-trend-row { display: flex; gap: 2px; margin: .5rem 0; flex-wrap: wrap; }
    .dm-tick { width: 8px; height: 18px; border-radius: 2px; background: var(--dm-color-border); border: 0; padding: 0; cursor: pointer; }
    .dm-tick[data-kind="pass"] { background: var(--dm-color-serving); }
    .dm-tick[data-kind="fail"] { background: var(--dm-color-error); }
    .dm-tick[data-kind="unknown"] { background: var(--dm-color-border); opacity: .5; }
    .dm-tick:hover { outline: 2px solid var(--dm-color-primary); outline-offset: 1px; }

    .dm-h4 { margin: .75rem 0 .35rem; font: 500 var(--dm-text-sm)/1rem Roboto; color: var(--dm-color-fg-muted); }

    .dm-chip-row { display: flex; flex-wrap: wrap; gap: .4rem; }
    .dm-chip { display: inline-flex; align-items: center; gap: .3rem; padding: 3px 10px; border-radius: var(--dm-radius-full); border: 1px solid var(--dm-color-border); background: var(--dm-color-surface-2); font: 500 var(--dm-text-xs)/1rem Roboto; color: var(--dm-color-fg); }
    .dm-chip mat-icon { font-size: 13px; width: 13px; height: 13px; }
    .dm-chip-flaky { border-color: color-mix(in oklch, var(--dm-color-accent) 40%, transparent); color: var(--dm-color-accent); }
    .dm-flips { color: var(--dm-color-fg-muted); }

    .dm-runs { display: flex; flex-direction: column; gap: 4px; margin-top: .25rem; }
    .dm-run-row { display: flex; align-items: center; gap: .5rem; border-radius: var(--dm-radius-md); background: var(--dm-color-surface-2); }
    .dm-run-row.expanded { background: var(--dm-color-surface-3); }
    .dm-cmp { display: inline-flex; align-items: center; padding: 0 0 0 .6rem; cursor: pointer; }
    .dm-run-main { flex: 1; display: grid; grid-template-columns: 10px 4.5rem auto 1fr auto auto auto auto; align-items: center; gap: .6rem; padding: .5rem .6rem; background: transparent; border: 0; text-align: left; cursor: pointer; color: var(--dm-color-fg); min-width: 0; }
    .dm-run-kind { width: 8px; height: 8px; border-radius: 999px; background: var(--dm-color-border); justify-self: center; }
    .dm-run-kind[data-kind="pass"] { background: var(--dm-color-serving); }
    .dm-run-kind[data-kind="fail"] { background: var(--dm-color-error); }
    .dm-run-ago { color: var(--dm-color-fg-muted); font-size: var(--dm-text-sm); white-space: nowrap; }
    .dm-runner-badge { padding: 1px 8px; border-radius: var(--dm-radius-sm); background: var(--dm-color-surface-3); color: var(--dm-color-fg-muted); font: 600 var(--dm-text-xs)/1rem var(--dm-mono); text-transform: lowercase; }
    .dm-run-label { font-size: var(--dm-text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .dm-run-dur { color: var(--dm-color-fg-muted); font-size: var(--dm-text-xs); white-space: nowrap; }
    .dm-run-head { color: var(--dm-color-fg-muted); font-size: var(--dm-text-xs); }
    .dm-run-exit { color: var(--dm-color-fg-muted); font-size: var(--dm-text-xs); white-space: nowrap; }
    .dm-run-chevron { font-size: 18px; width: 18px; height: 18px; color: var(--dm-color-fg-muted); }

    .dm-drilldown { padding: .5rem .75rem .75rem 2.5rem; }
    .dm-fail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .dm-fail-list li { padding: .35rem .6rem; border-radius: var(--dm-radius-sm); background: var(--dm-color-surface-2); display: flex; align-items: center; justify-content: space-between; gap: .5rem; flex-wrap: wrap; }
    .dm-fail-name { color: var(--dm-color-fg); font-size: var(--dm-text-sm); overflow-wrap: anywhere; }
    .dm-fail-jump { color: var(--dm-color-primary); text-decoration: none; display: inline-flex; align-items: center; gap: .3rem; font-size: var(--dm-text-xs); }
    .dm-fail-jump:hover { text-decoration: underline; }
    .dm-jump-icon { font-size: 13px; width: 13px; height: 13px; }
    .dm-flaky-tag { display: inline-flex; align-items: center; gap: 2px; padding: 1px 7px; border-radius: var(--dm-radius-full); background: color-mix(in oklch, var(--dm-color-accent) 16%, transparent); color: var(--dm-color-accent); font: 600 var(--dm-text-xs)/1rem Roboto; }
    .dm-flaky-tag mat-icon { font-size: 12px; width: 12px; height: 12px; }

    .dm-diff { margin-top: .75rem; padding: .75rem; border-radius: var(--dm-radius-lg); border: 1px dashed var(--dm-color-border-strong); }
    .dm-diff-head { display: flex; align-items: center; justify-content: space-between; }
    .dm-diff-clear { background: transparent; border: 1px solid var(--dm-color-border); border-radius: var(--dm-radius-md); color: var(--dm-color-fg-muted); font: 500 var(--dm-text-xs)/1rem Roboto; padding: 3px 10px; cursor: pointer; }
    .dm-diff-clear:hover { color: var(--dm-color-fg); background: var(--dm-color-surface-2); }
    .dm-diff-cols { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-top: .5rem; }
    .dm-diff-col-title { font: 600 var(--dm-text-xs)/1.25rem Roboto; margin-bottom: .35rem; }
    .dm-diff-fail { color: var(--dm-color-error); }
    .dm-diff-pass { color: var(--dm-color-serving); }

    @media (max-width: 600px) {
      .dm-diff-cols { grid-template-columns: 1fr; }
      .dm-run-main { grid-template-columns: 10px 3.5rem 1fr; grid-template-areas: "kind ago label" "kind badge dur"; row-gap: .2rem; }
      .dm-run-main .dm-runner-badge, .dm-run-main .dm-run-dur, .dm-run-main .dm-run-head, .dm-run-main .dm-run-exit { display: none; }
      .dm-drilldown { padding-left: 1rem; }
    }
  `],
})
export class TestsPageComponent implements OnInit {
  private readonly api = inject(DaimonApi);

  readonly loading = signal<boolean>(true);
  readonly cards = signal<AppCard[]>([]);
  readonly flakyThreshold = signal<number>(3);

  private readonly expandedRun = signal<Record<string, number | null>>({});
  private readonly diffSel = signal<Record<string, [number | null, number | null]>>({});

  readonly pillKindForRun = pillKindForRun;
  readonly runLabel = runLabel;
  readonly vscodeUri = vscodeUri;
  readonly isFlaky = isFlaky;
  readonly shortHead = shortHead;

  subtitleFor(c: AppCard): string {
    if (!c.latest) return '';
    const runner = c.latest.runner ?? 'unknown runner';
    const dur = this.fmtDuration(c.latest.durationMs);
    return `${runner} · ${dur} · ${this.fmtAgo(c.latest.ts)} · ${c.runs.length} runs`;
  }

  tickLabel(cell: SparkCell): string {
    const d = new Date(cell.ts).toLocaleString();
    return `${d} — ${cell.outcome}`;
  }

  failureLabel(f: TestFailure): string {
    const name = f.test || '(unnamed test)';
    return f.suite ? `${f.suite} › ${name}` : name;
  }

  outcomeKind(r: TestRun): 'pass' | 'fail' | 'unknown' {
    return (r.failed ?? 0) > 0 || (r.exitCode != null && r.exitCode !== 0) ? 'fail' : (r.exitCode === 0 ? 'pass' : 'unknown');
  }

  isExpanded(app: string, runId: number): boolean {
    return this.expandedRun()[app] === runId;
  }

  toggleRun(app: string, runId: number): void {
    this.expandedRun.update(m => ({ ...m, [app]: m[app] === runId ? null : runId }));
  }

  isSelectedForDiff(app: string, runId: number): boolean {
    const sel = this.diffSel()[app];
    return !!sel && (sel[0] === runId || sel[1] === runId);
  }

  toggleDiffSelect(app: string, runId: number): void {
    this.diffSel.update(m => {
      const [a, b] = m[app] ?? [null, null];
      let next: [number | null, number | null];
      if (a === runId) next = [b, null];
      else if (b === runId) next = [a, null];
      else if (a === null) next = [runId, b];
      else if (b === null) next = [a, runId];
      else next = [b, runId]; // both full: drop the oldest selection, keep the newest + the new pick
      return { ...m, [app]: next };
    });
  }

  clearDiff(app: string): void {
    this.diffSel.update(m => ({ ...m, [app]: [null, null] }));
  }

  diffRunsLabel(app: string): string {
    const sel = this.diffSel()[app];
    const card = this.cards().find(c => c.app === app);
    if (!sel || !card) return '';
    const a = card.runs.find(r => r.id === sel[0]);
    const b = card.runs.find(r => r.id === sel[1]);
    if (!a || !b) return '';
    return `${this.fmtAgo(Math.min(a.ts, b.ts))} → ${this.fmtAgo(Math.max(a.ts, b.ts))}`;
  }

  diffFor(app: string): RunDiff | null {
    const sel = this.diffSel()[app];
    if (!sel || sel[0] == null || sel[1] == null || sel[0] === sel[1]) return null;
    const card = this.cards().find(c => c.app === app);
    if (!card) return null;
    const a = card.runs.find(r => r.id === sel[0]);
    const b = card.runs.find(r => r.id === sel[1]);
    if (!a || !b) return null;
    return diffRuns(a, b);
  }

  fmtAgo(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  fmtDuration(ms: number | null): string {
    if (ms == null) return '—';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const runs = await this.api.getTestRuns({ limit: RUN_FETCH_LIMIT });
      const grouped = groupRunsByApp(runs);
      const apps = [...grouped.keys()];
      const flakyResults = await Promise.all(apps.map(app => this.api.getFlakyTests(app)));
      if (flakyResults.length) this.flakyThreshold.set(flakyResults[0].threshold);
      const cards: AppCard[] = apps.map((app, i) => {
        const appRuns = grouped.get(app)!;
        const flakyList = flakyResults[i]?.flaky ?? [];
        return {
          app,
          runs: appRuns,
          latest: appRuns[0] ?? null,
          spark: sparklineFor(appRuns, SPARK_MAX),
          flaky: flakyByFingerprint(flakyList),
          flakyList,
        };
      });
      // Failing apps first, then most-recently-tested.
      cards.sort((a, b) => {
        const af = pillKindForRun(a.latest) === 'fail' ? 0 : 1;
        const bf = pillKindForRun(b.latest) === 'fail' ? 0 : 1;
        if (af !== bf) return af - bf;
        return (b.latest?.ts ?? 0) - (a.latest?.ts ?? 0);
      });
      this.cards.set(cards);
    } finally {
      this.loading.set(false);
    }
  }
}
