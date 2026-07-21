import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { DaimonApi, Report } from './daimon-api';
import { EmptyStateComponent, SkeletonComponent, MonoComponent, StatusPillComponent } from './ui-primitives';
import {
  type ReportPeriod,
  fmtAgo,
  fmtDuration,
  fmtLogVolumeLine,
  fmtPct,
  fmtTs,
  isValidSince,
  periodToSince,
  sectionNote,
} from './report-page-helpers';

type SectionKey = keyof Report['sections'];
const WS_KEY = 'daimon.workspace';

@Component({
  selector: 'dm-report-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonToggleModule, EmptyStateComponent, SkeletonComponent, MonoComponent, StatusPillComponent],
  template: `
    <div class="dm-page">
      <header class="dm-page-header">
        <div>
          <h1>Report</h1>
          <div class="dm-page-sub">
            What happened — uptime, errors, tests, compiles, crashes, agents and env changes. Composition only, no new state.
          </div>
        </div>
        <div class="dm-header-actions">
          <button type="button" class="ib" (click)="refresh()" [disabled]="loading()" aria-label="Refresh" title="Refresh">
            <span class="material-symbols-outlined" [class.spin]="loading()">refresh</span>
          </button>
        </div>
      </header>

      <div class="dm-controls">
        <mat-button-toggle-group [value]="period()" (change)="setPeriod($event.value)" hideSingleSelectionIndicator aria-label="Period">
          <mat-button-toggle value="24h">24h</mat-button-toggle>
          <mat-button-toggle value="7d">7d</mat-button-toggle>
          <mat-button-toggle value="custom">Custom</mat-button-toggle>
        </mat-button-toggle-group>
        @if (period() === 'custom') {
          <div class="dm-custom">
            <input type="text" class="dm-custom-input" placeholder="e.g. 3d, 12h, 90m"
                   [value]="customSince()" (input)="onCustomInput($any($event.target).value)"
                   aria-label="Custom since duration" />
            @if (!customValid()) {
              <span class="dm-custom-hint">number + unit (ms|s|m|h|d), e.g. 3d</span>
            }
          </div>
        }
        <mat-button-toggle-group [value]="appFilter()" (change)="setApp($event.value)" hideSingleSelectionIndicator aria-label="App scope">
          <mat-button-toggle value="">All apps</mat-button-toggle>
          @for (a of api.apps(); track a.name) {
            <mat-button-toggle [value]="a.name"><dm-mono>{{ a.name }}</dm-mono></mat-button-toggle>
          }
        </mat-button-toggle-group>
      </div>

      @if (api.apps().length === 0 && !loading()) {
        <dm-empty icon="apps" title="No apps yet"
                  hint="The report summarizes uptime, errors, tests, compiles, crashes, agents and env changes across your apps — add one to see it populate.">
          <a routerLink="/apps" class="dm-link-btn">
            <span class="material-symbols-outlined">apps</span>Go to apps
          </a>
        </dm-empty>
      } @else if (loading() && !report()) {
        <dm-skeleton height="20rem"></dm-skeleton>
      } @else if (!report()) {
        <dm-empty icon="summarize" title="Report unavailable" hint="The daemon couldn't be reached. Try refreshing."></dm-empty>
      } @else {
        <div class="dm-meta">
          generated {{ fmtTs(report()!.generatedAt) }} · window {{ fmtTs(report()!.since) }} → {{ fmtTs(report()!.until) }}
          @if (report()!.app) { · app <dm-mono>{{ report()!.app }}</dm-mono> }
        </div>

        <div class="dm-grid">
          <section class="dm-panel">
            <h3 class="dm-panel-title">Uptime</h3>
            @if (note('uptime'); as n) {
              <div class="dm-note">{{ n }}</div>
            } @else {
              <table class="dm-table">
                <thead><tr><th scope="col">app</th><th scope="col">uptime</th><th scope="col">restarts</th><th scope="col">now</th></tr></thead>
                <tbody>
                  @for (r of uptimeRows(); track r.app) {
                    <tr>
                      <td><a [routerLink]="['/apps', r.app]"><dm-mono>{{ r.app }}</dm-mono></a></td>
                      <td>{{ r.uptimePct != null ? r.uptimePct + '%' : '—' }}</td>
                      <td>{{ r.restarts }}</td>
                      <td><dm-status-pill [status]="r.status"></dm-status-pill></td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>

          <section class="dm-panel">
            <h3 class="dm-panel-title">Errors</h3>
            @if (note('errors'); as n) {
              <div class="dm-note">{{ n }}</div>
            } @else if (errorsSection(); as es) {
              <div class="dm-headline">{{ es.total }} events · {{ es.newCount }} new · {{ es.recurringCount }} recurring · {{ es.resolvedCount }} resolved</div>
              @if (es.logVolume) {
                @if (logVolumeNote(es); as n) {
                  <div class="dm-note">{{ n }}</div>
                } @else {
                  <div class="dm-sub2">{{ fmtLogVolumeLine(es.logVolume) }}</div>
                }
              }
              <ul class="dm-list">
                @for (g of es.groups; track g.app + g.message) {
                  <li>
                    <span class="dm-tag" [attr.data-kind]="g.kind">{{ g.kind }}</span>
                    @if (g.resolved) { <span class="dm-tag" data-kind="resolved">resolved</span> }
                    <a [routerLink]="['/apps', g.app]"><dm-mono>{{ g.app }}</dm-mono></a>
                    <span class="dm-count">×{{ g.count }}</span>
                    <span class="dm-msg">{{ g.message }}</span>
                  </li>
                }
              </ul>
            }
          </section>

          <section class="dm-panel">
            <h3 class="dm-panel-title">Tests</h3>
            @if (note('tests'); as n) {
              <div class="dm-note">{{ n }}</div>
            } @else if (testsSection(); as ts) {
              <div class="dm-headline">{{ ts.runs }} runs · {{ ts.failedRuns }} failed · pass rate {{ fmtPct(ts.passRatePct) }}</div>
              @if (ts.flakiest?.length) {
                <ul class="dm-list">
                  @for (f of ts.flakiest; track f.fingerprint) {
                    <li>
                      <span class="material-symbols-outlined dm-flaky-icon">shuffle</span>
                      <span class="dm-msg">{{ f.test ?? f.fingerprint }}</span>
                      <span class="dm-count">×{{ f.flips }} flips</span>
                    </li>
                  }
                </ul>
              }
            }
          </section>

          <section class="dm-panel">
            <h3 class="dm-panel-title">Compiles</h3>
            @if (note('compiles'); as n) {
              <div class="dm-note">{{ n }}</div>
            } @else if (compilesSection(); as cs) {
              <div class="dm-headline">{{ cs.count }} compiles · p50 {{ fmtDuration(cs.p50Ms) }} · p95 {{ fmtDuration(cs.p95Ms) }}</div>
              @if (cs.slowest) {
                <div class="dm-sub2">slowest: <a [routerLink]="['/apps', cs.slowest.app]"><dm-mono>{{ cs.slowest.app }}</dm-mono></a> — {{ fmtDuration(cs.slowest.ms) }}</div>
              }
              @if (cs.regressions?.length) {
                <ul class="dm-list">
                  @for (r of cs.regressions; track $index) {
                    <li>
                      <a [routerLink]="['/apps', r.app]"><dm-mono>{{ r.app }}</dm-mono></a>
                      <span class="dm-msg">{{ r.kind }}@if (r.factor) { ×{{ r.factor }} }</span>
                    </li>
                  }
                </ul>
              }
            }
          </section>

          <section class="dm-panel">
            <h3 class="dm-panel-title">Crashes &amp; storms</h3>
            @if (note('crashes'); as n) {
              <div class="dm-note">{{ n }}</div>
            } @else if (crashesSection(); as crs) {
              <div class="dm-headline">
                {{ crs.total }} crash{{ crs.total === 1 ? '' : 'es' }}
                @if (crs.storms?.length) { · {{ crs.storms.length }} restart-storm{{ crs.storms.length === 1 ? '' : 's' }} }
              </div>
              @if (crs.last) {
                <div class="dm-sub2">last: <a [routerLink]="['/apps', crs.last.app]"><dm-mono>{{ crs.last.app }}</dm-mono></a> · {{ fmtAgo(crs.last.ts) }} · exit {{ crs.last.exitCode ?? '?' }}</div>
              }
              <ul class="dm-list">
                @for (b of crs.byApp; track b.app) {
                  <li><a [routerLink]="['/apps', b.app]"><dm-mono>{{ b.app }}</dm-mono></a><span class="dm-count">×{{ b.count }}</span></li>
                }
              </ul>
            }
          </section>

          <section class="dm-panel">
            <h3 class="dm-panel-title">Agents</h3>
            @if (note('agents'); as n) {
              <div class="dm-note">{{ n }}</div>
            } @else if (agentsSection(); as ags) {
              <div class="dm-headline">{{ ags.active?.length ?? 0 }} active · {{ ags.taskRuns }} task run{{ ags.taskRuns === 1 ? '' : 's' }}</div>
              <ul class="dm-list">
                @for (t of ags.taskRunsByApp; track t.app) {
                  <li><a [routerLink]="['/apps', t.app]"><dm-mono>{{ t.app }}</dm-mono></a><span class="dm-count">×{{ t.count }}</span></li>
                }
              </ul>
            }
          </section>

          <section class="dm-panel dm-panel-wide">
            <h3 class="dm-panel-title">Env changes</h3>
            @if (note('env'); as n) {
              <div class="dm-note">{{ n }}</div>
            } @else if (envSection(); as ev) {
              <ul class="dm-list">
                @for (c of ev.changes; track c.app + c.from) {
                  <li>
                    <a [routerLink]="['/apps', c.app]"><dm-mono>{{ c.app }}</dm-mono></a>
                    <span class="dm-msg">{{ envSummary(c) }}</span>
                  </li>
                }
              </ul>
              <div class="dm-note-inline">values are never included — key names only</div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dm-page { display: flex; flex-direction: column; gap: 1rem; }
    .dm-header-actions { display: flex; gap: .5rem; }
    .ib { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; background: transparent; border: 1px solid var(--dm-color-border); border-radius: var(--dm-radius-lg); color: var(--dm-color-fg-muted); cursor: pointer; }
    .ib:hover:not(:disabled) { background: var(--dm-color-surface-3); color: var(--dm-color-fg); }
    .ib:disabled { opacity: .55; cursor: not-allowed; }
    .spin { animation: dm-spin 1s linear infinite; }
    @keyframes dm-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

    .dm-controls { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .dm-custom { display: flex; flex-direction: column; gap: 2px; }
    .dm-custom-input {
      padding: 6px 10px; border-radius: var(--dm-radius-md);
      background: var(--dm-color-surface-2); border: 1px solid var(--dm-color-border);
      color: var(--dm-color-fg); font: 500 var(--dm-text-sm)/1.25rem var(--dm-mono);
      width: 10rem;
    }
    .dm-custom-hint { color: var(--dm-color-danger); font: 500 var(--dm-text-xs)/1rem Roboto; }

    .dm-link-btn { display: inline-flex; align-items: center; gap: .375rem; margin-top: .75rem; padding: 6px 14px; border-radius: var(--dm-radius-md); background: var(--dm-color-primary); color: var(--dm-color-on-primary); text-decoration: none; font: 500 var(--dm-text-sm)/1.25rem Roboto; }
    .dm-link-btn .material-symbols-outlined { font-size: 18px; }

    .dm-meta { color: var(--dm-color-fg-muted); font-size: var(--dm-text-sm); }

    .dm-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr)); }
    .dm-panel-wide { grid-column: 1 / -1; }
    .dm-panel {
      padding: 1rem 1.125rem; border-radius: var(--dm-radius-xl);
      background: var(--dm-color-surface); border: 1px solid var(--dm-color-border);
      min-width: 0;
    }
    .dm-panel-title {
      margin: 0 0 .5rem; font: 500 var(--dm-text-sm)/1.25rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem; color: var(--dm-color-fg-muted);
    }
    .dm-note { color: var(--dm-color-fg-muted); font-size: var(--dm-text-sm); font-style: italic; }
    .dm-note-inline { margin-top: .5rem; color: var(--dm-color-fg-muted); font-size: var(--dm-text-xs); }
    .dm-headline { color: var(--dm-color-fg); font-size: var(--dm-text-md); margin-bottom: .375rem; }
    .dm-sub2 { color: var(--dm-color-fg-muted); font-size: var(--dm-text-sm); margin-bottom: .375rem; }

    .dm-table { width: 100%; border-collapse: collapse; }
    .dm-table th, .dm-table td { text-align: left; padding: .375rem .5rem; font-size: var(--dm-text-sm); }
    .dm-table th { font-weight: 500; color: var(--dm-color-fg-muted); border-bottom: 1px solid var(--dm-color-border); }
    .dm-table tbody tr { border-bottom: 1px solid color-mix(in oklch, var(--dm-color-border) 60%, transparent); }
    .dm-table tbody tr:last-child { border-bottom: 0; }
    .dm-table a { color: var(--dm-color-primary); text-decoration: none; }
    .dm-table a:hover { text-decoration: underline; }

    .dm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .dm-list li { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; padding: .3rem .5rem; border-radius: var(--dm-radius-sm); background: var(--dm-color-surface-2); }
    .dm-list a { color: var(--dm-color-primary); text-decoration: none; }
    .dm-list a:hover { text-decoration: underline; }
    .dm-msg { color: var(--dm-color-fg); font-size: var(--dm-text-sm); overflow-wrap: anywhere; }
    .dm-count { color: var(--dm-color-fg-muted); font: 600 var(--dm-text-xs)/1rem var(--dm-mono); margin-left: auto; }
    .dm-flaky-icon { font-size: 14px; width: 14px; height: 14px; color: var(--dm-color-accent); }

    .dm-tag {
      display: inline-flex; align-items: center; padding: 1px 8px; border-radius: var(--dm-radius-full);
      font: 600 var(--dm-text-xs)/1rem Roboto; text-transform: uppercase; letter-spacing: .02rem;
      background: var(--dm-color-surface-3); color: var(--dm-color-fg-muted);
    }
    .dm-tag[data-kind="new"] { background: color-mix(in oklch, var(--dm-color-danger) var(--dm-badge-tint), transparent); color: var(--dm-color-danger); }
    .dm-tag[data-kind="recurring"] { background: color-mix(in oklch, var(--dm-color-accent) var(--dm-badge-tint), transparent); color: var(--dm-color-accent); }
    .dm-tag[data-kind="resolved"] { background: color-mix(in oklch, var(--dm-color-serving) var(--dm-badge-tint), transparent); color: var(--dm-color-serving); }
  `],
})
export class ReportPageComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly period = signal<ReportPeriod>('24h');
  readonly customSince = signal<string>('3d');
  readonly appFilter = signal<string>('');
  readonly workspace = signal<string | null>(null);
  readonly report = signal<Report | null>(null);
  readonly loading = signal<boolean>(true);

  constructor() {
    this.workspace.set(localStorage.getItem(WS_KEY));
    const onWs = (e: Event) => {
      this.workspace.set(((e as CustomEvent).detail as string | null) ?? null);
      void this.load();
    };
    window.addEventListener('daimon:workspace', onWs);
    this.destroyRef.onDestroy(() => window.removeEventListener('daimon:workspace', onWs));
  }

  @HostListener('window:storage', ['$event'])
  onStorage(ev: StorageEvent): void {
    if (ev.key === WS_KEY) { this.workspace.set(ev.newValue); void this.load(); }
  }

  readonly customValid = computed(() => isValidSince(this.customSince()));

  readonly fmtTs = fmtTs;
  readonly fmtDuration = fmtDuration;
  readonly fmtPct = fmtPct;
  readonly fmtAgo = fmtAgo;
  readonly fmtLogVolumeLine = fmtLogVolumeLine;

  readonly uptimeRows = computed<any[]>(() => this.report()?.sections?.uptime?.apps ?? []);
  readonly errorsSection = computed<any | null>(() => this.dataOf('errors'));
  readonly testsSection = computed<any | null>(() => this.dataOf('tests'));
  readonly compilesSection = computed<any | null>(() => this.dataOf('compiles'));
  readonly crashesSection = computed<any | null>(() => this.dataOf('crashes'));
  readonly agentsSection = computed<any | null>(() => this.dataOf('agents'));
  readonly envSection = computed<any | null>(() => this.dataOf('env'));

  private timer?: ReturnType<typeof setInterval>;

  async ngOnInit(): Promise<void> {
    if (this.api.apps().length === 0 && !this.api.ready()) await this.api.refresh();
    await this.load();
    this.timer = setInterval(() => void this.load(true), 60_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  refresh(): void { void this.load(); }
  setPeriod(p: ReportPeriod): void { this.period.set(p); void this.load(); }
  setApp(a: string): void { this.appFilter.set(a); void this.load(); }

  onCustomInput(v: string): void {
    this.customSince.set(v);
    if (isValidSince(v)) void this.load();
  }

  note(key: SectionKey): string | null {
    return sectionNote(this.report()?.sections?.[key]);
  }

  // The errors section's additive `logVolume` sub-field (M103) degrades to
  // its own { note } independently of the errors section itself — sectionNote()
  // already handles either shape since it just checks for a `.note` string.
  logVolumeNote(es: any): string | null {
    return sectionNote(es?.logVolume);
  }

  private dataOf(key: SectionKey): any | null {
    const section = this.report()?.sections?.[key];
    return section && !sectionNote(section) ? section : null;
  }

  envSummary(c: any): string {
    const bits: string[] = [];
    if (c.filesAdded?.length) bits.push(`files added: ${c.filesAdded.join(', ')}`);
    if (c.filesRemoved?.length) bits.push(`files removed: ${c.filesRemoved.join(', ')}`);
    if (c.keysAdded?.length) bits.push(`+${c.keysAdded.length} key${c.keysAdded.length === 1 ? '' : 's'}`);
    if (c.keysRemoved?.length) bits.push(`-${c.keysRemoved.length} key${c.keysRemoved.length === 1 ? '' : 's'}`);
    if (c.keysChanged?.length) bits.push(`changed: ${c.keysChanged.map((k: any) => k.key).join(', ')}`);
    return bits.join(' · ') || 'changed';
  }

  private async load(silent = false): Promise<void> {
    if (!silent) this.loading.set(true);
    try {
      const since = periodToSince(this.period(), this.customSince());
      const r = await this.api.getReport({ since, app: this.appFilter() || undefined, workspace: this.workspace() ?? undefined });
      this.report.set(r);
    } finally {
      this.loading.set(false);
    }
  }
}
