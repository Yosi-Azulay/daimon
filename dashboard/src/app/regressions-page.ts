import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { DaimonApi, EventRecord } from './daimon-api';
import { EmptyStateComponent, MonoComponent } from './ui-primitives';

type Kind = 'compile' | 'bundle' | 'error-flap';
type Filter = 'all' | Kind;

interface ParsedRegression {
  ev: EventRecord;
  kind: Kind;
  factor: number;
  baseline: number;
  current: number;
  fingerprint?: string;
  suspectCommit?: string | null;
}

function relTime(ms: number, now: number): string {
  const d = Math.max(0, Math.floor((now - ms) / 1000));
  if (d < 1) return 'just now';
  if (d < 60) return `${d}s ago`;
  const m = Math.floor(d / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function parseRegression(ev: EventRecord): ParsedRegression | null {
  if (ev.type !== 'regression-detected' || !ev.message) return null;
  try {
    const p = JSON.parse(ev.message);
    if (!p || typeof p !== 'object') return null;
    if (p.kind !== 'compile' && p.kind !== 'bundle' && p.kind !== 'error-flap') return null;
    return {
      ev,
      kind: p.kind,
      factor: Number(p.factor) || 0,
      baseline: Number(p.baseline) || 0,
      current: Number(p.current) || 0,
      fingerprint: p.fingerprint,
      suspectCommit: p.suspectCommit ?? null,
    };
  } catch {
    return null;
  }
}

function kindIcon(kind: Kind): string {
  return kind === 'compile' ? 'hourglass_bottom' : kind === 'bundle' ? 'inventory_2' : 'whatshot';
}

function kindLabel(kind: Kind): string {
  return kind === 'compile' ? 'Compile-time spike' : kind === 'bundle' ? 'Bundle size grew' : 'Error flap';
}

function fmtMetric(kind: Kind, v: number): string {
  if (kind === 'compile') {
    if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
    return `${Math.round(v)}ms`;
  }
  if (kind === 'bundle') return `${Math.round(v)} KB`;
  return `${Math.round(v)} ev/h`;
}

@Component({
  selector: 'dm-regressions-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, RouterLink, FormsModule,
    MatCardModule, MatIconModule, MatButtonToggleModule, MatTooltipModule, MatChipsModule,
    EmptyStateComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Regressions <span class="dm-count">· {{ filtered().length }}</span></h1>
        <div class="dm-page-sub">
          @if (api.connected()) {
            <span class="dm-conn-on">live · {{ liveCount() }} new since open</span>
          } @else {
            <span class="dm-conn-off">disconnected</span>
          }
          <span class="dm-sep">·</span>
          <span>compile spikes &gt; 2×, bundle growth &gt; +10%, error flap &gt; 3× baseline</span>
        </div>
      </div>
      <mat-button-toggle-group [ngModel]="filter()" (ngModelChange)="filter.set($event)" hideSingleSelectionIndicator>
        <mat-button-toggle value="all">All</mat-button-toggle>
        <mat-button-toggle value="compile"><mat-icon fontSet="material-symbols-outlined">hourglass_bottom</mat-icon>Compile</mat-button-toggle>
        <mat-button-toggle value="bundle"><mat-icon fontSet="material-symbols-outlined">inventory_2</mat-icon>Bundle</mat-button-toggle>
        <mat-button-toggle value="error-flap"><mat-icon fontSet="material-symbols-outlined">whatshot</mat-icon>Errors</mat-button-toggle>
      </mat-button-toggle-group>
    </div>

    @if (loading()) {
      <p class="dm-loading">Loading regressions…</p>
    } @else if (filtered().length === 0) {
      <dm-empty
        icon="trending_down"
        [title]="filter() === 'all' ? 'No regressions detected' : 'No ' + filter() + ' regressions'"
        [hint]="filter() === 'all'
          ? 'Daimon watches compile times, bundle sizes, and error rates. Spikes will appear here.'
          : 'Try a different filter or wait for new events to arrive.'"></dm-empty>
    } @else {
      <div class="dm-regr-list">
        @for (r of filtered(); track trackKey($index, r)) {
          <mat-card class="dm-regr-card" [attr.data-kind]="r.kind">
            <mat-card-header>
              <mat-icon mat-card-avatar fontSet="material-symbols-outlined" class="dm-regr-icon">{{ icon(r.kind) }}</mat-icon>
              <mat-card-title>
                {{ label(r.kind) }} · ×{{ r.factor }}
              </mat-card-title>
              <mat-card-subtitle>
                @if (r.ev.app) {
                  <a [routerLink]="['/apps', r.ev.app]" class="dm-app-link">{{ r.ev.app }}</a>
                  <span class="dm-sep">·</span>
                }
                <span>{{ rel(r.ev.ts) }}</span>
                @if (r.fingerprint) {
                  <span class="dm-sep">·</span>
                  <dm-mono class="dm-fp">{{ r.fingerprint }}</dm-mono>
                }
              </mat-card-subtitle>
            </mat-card-header>
            <mat-card-content>
              <div class="dm-regr-metrics">
                <div class="dm-metric">
                  <span class="dm-metric-label">Baseline</span>
                  <dm-mono class="dm-metric-value">{{ fmt(r.kind, r.baseline) }}</dm-mono>
                </div>
                <mat-icon fontSet="material-symbols-outlined" class="dm-arrow">arrow_forward</mat-icon>
                <div class="dm-metric dm-metric-bad">
                  <span class="dm-metric-label">Now</span>
                  <dm-mono class="dm-metric-value">{{ fmt(r.kind, r.current) }}</dm-mono>
                </div>
              </div>
              @if (r.suspectCommit) {
                <div class="dm-suspect">
                  <mat-icon fontSet="material-symbols-outlined">commit</mat-icon>
                  <span>Suspect commit</span>
                  <dm-mono>{{ r.suspectCommit }}</dm-mono>
                </div>
              }
            </mat-card-content>
          </mat-card>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .dm-page-header h1 { font: 500 1.5rem/2rem Roboto; margin: 0; color: var(--mat-sys-on-surface); }
    .dm-count { color: var(--mat-sys-on-surface-variant); font-weight: 400; }
    .dm-page-sub { color: var(--mat-sys-on-surface-variant); font-size: .875rem; margin-top: .25rem; }
    .dm-conn-on { color: var(--mat-sys-primary); }
    .dm-conn-off { color: var(--mat-sys-error); }
    .dm-sep { margin: 0 .5rem; opacity: .5; }
    .dm-loading { color: var(--mat-sys-on-surface-variant); padding: 2rem; text-align: center; }
    .dm-regr-list { display: flex; flex-direction: column; gap: .75rem; }
    .dm-regr-card { border-left: 4px solid var(--mat-sys-tertiary); }
    .dm-regr-card[data-kind="compile"] { border-left-color: var(--mat-sys-tertiary); }
    .dm-regr-card[data-kind="bundle"] { border-left-color: var(--mat-sys-secondary); }
    .dm-regr-card[data-kind="error-flap"] { border-left-color: var(--mat-sys-error); }
    .dm-regr-icon { font-size: 28px; width: 28px; height: 28px; color: var(--mat-sys-on-surface-variant); }
    .dm-app-link { color: var(--mat-sys-primary); text-decoration: underline; text-underline-offset: 2px; font-weight: 500; }
    .dm-app-link:hover { text-decoration: underline; }
    .dm-fp { font-size: .75rem; color: var(--mat-sys-on-surface-variant); }
    .dm-regr-metrics { display: flex; align-items: center; gap: 1rem; margin-top: .5rem; }
    .dm-metric { display: flex; flex-direction: column; padding: .5rem .875rem; border-radius: 8px; background: var(--mat-sys-surface-container); }
    .dm-metric-bad { background: color-mix(in oklch, var(--mat-sys-error) var(--dm-badge-tint), var(--mat-sys-surface-container)); }
    .dm-metric-label { font: 500 .6875rem/1rem Roboto; text-transform: uppercase; letter-spacing: .05rem; color: var(--mat-sys-on-surface-variant); }
    .dm-metric-value { font-size: 1rem; font-weight: 500; color: var(--mat-sys-on-surface); }
    .dm-metric-bad .dm-metric-value { color: var(--mat-sys-error); }
    .dm-arrow { color: var(--mat-sys-on-surface-variant); }
    .dm-suspect { display: flex; align-items: center; gap: .5rem; margin-top: .75rem; padding-top: .5rem; border-top: 1px dashed var(--mat-sys-outline-variant); font-size: .8125rem; color: var(--mat-sys-on-surface-variant); }
    .dm-suspect mat-icon { font-size: 16px; width: 16px; height: 16px; }
  `],
})
export class RegressionsPageComponent implements OnInit, OnDestroy {
  protected readonly api = inject(DaimonApi);
  protected readonly events = signal<EventRecord[]>([]);
  protected readonly filter = signal<Filter>('all');
  protected readonly loading = signal<boolean>(true);
  protected readonly liveCount = signal<number>(0);
  protected readonly now = signal<number>(Date.now());

  protected readonly parsed = computed(() => {
    const seen = new Set<string>();
    const out: ParsedRegression[] = [];
    for (const ev of this.events()) {
      const key = `${ev.ts}|${ev.app}|${ev.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = parseRegression(ev);
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.ev.ts - a.ev.ts);
  });

  protected readonly filtered = computed(() => {
    const f = this.filter();
    return f === 'all' ? this.parsed() : this.parsed().filter(p => p.kind === f);
  });

  private tickTimer?: ReturnType<typeof setInterval>;
  private lastStreamLen = 0;
  private streamEffect = effect(() => {
    const live = this.api.events();
    if (live.length > this.lastStreamLen) {
      const fresh = live.slice(this.lastStreamLen);
      this.lastStreamLen = live.length;
      const adds: EventRecord[] = [];
      for (const ev of fresh) {
        if (ev.type === 'regression-detected') adds.push(ev);
      }
      if (adds.length > 0) {
        this.events.update(curr => [...adds, ...curr]);
        this.liveCount.update(n => n + adds.length);
      }
    }
  });

  ngOnInit(): void {
    void this.seed();
    this.tickTimer = setInterval(() => this.now.set(Date.now()), 5_000);
    this.lastStreamLen = this.api.events().length;
  }

  ngOnDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.streamEffect.destroy();
  }

  protected rel(ts: number): string { return relTime(ts, this.now()); }
  protected icon(k: Kind): string { return kindIcon(k); }
  protected label(k: Kind): string { return kindLabel(k); }
  protected fmt(k: Kind, v: number): string { return fmtMetric(k, v); }
  protected trackKey(_i: number, r: ParsedRegression): string { return `${r.ev.ts}|${r.ev.app}|${r.kind}|${r.fingerprint ?? ''}`; }

  private async seed(): Promise<void> {
    this.loading.set(true);
    try {
      const seedEvents = await this.api.getHistoryEvents({ type: 'regression-detected', since: '30d', limit: 500 });
      this.events.set(seedEvents.sort((a, b) => b.ts - a.ts));
    } finally {
      this.loading.set(false);
    }
  }
}
