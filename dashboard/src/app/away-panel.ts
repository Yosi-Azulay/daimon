// "While you were away" (M135, v1.8 "Rewind" — experimental). Shown once per
// gap on dashboard load: reuses the M134 sessions list to find the previous
// session's end, then the existing GET /api/report composition — no new
// endpoint, no new engine, no new timer. Mounted eagerly (small, always on)
// in app.ts, same tier as the cwd banner it sits beside.

import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DaimonApi } from './daimon-api';
import { AwaySummary, awayDismissKey, buildAwaySummary, findAwayBaseline, shouldShowAway } from './away-panel-helpers';

@Component({
  selector: 'dm-away-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (summary(); as s) {
      <div class="dm-away" role="status" data-testid="away-panel">
        <div class="dm-away-head">
          <span class="material-symbols-outlined" aria-hidden="true">history_toggle_off</span>
          <h2>While you were away</h2>
          <button type="button" class="dm-away-dismiss" (click)="dismiss()" aria-label="Dismiss" title="Dismiss">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <ul class="dm-away-list">
          @if (s.newErrors) { <li><strong>{{ s.newErrors }}</strong> new error{{ s.newErrors === 1 ? '' : 's' }}</li> }
          @if (s.resolvedErrors) { <li><strong>{{ s.resolvedErrors }}</strong> resolved error{{ s.resolvedErrors === 1 ? '' : 's' }}</li> }
          @if (s.crashes) { <li><strong>{{ s.crashes }}</strong> crash{{ s.crashes === 1 ? '' : 'es' }}</li> }
          @if (s.envChanges) { <li><strong>{{ s.envChanges }}</strong> env change{{ s.envChanges === 1 ? '' : 's' }}</li> }
        </ul>
        <a class="dm-away-link" [routerLink]="['/timeline']" [queryParams]="{ ts: baseline() }">
          View in timeline
          <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
        </a>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-away {
      display: flex; flex-direction: column; gap: .5rem;
      padding: 12px 16px; margin-bottom: 1rem;
      background: color-mix(in oklch, var(--dm-color-primary) 8%, var(--dm-color-surface-2));
      border: 1px solid color-mix(in oklch, var(--dm-color-primary) 28%, transparent);
      border-radius: 12px;
    }
    .dm-away-head { display: flex; align-items: center; gap: .5rem; }
    .dm-away-head .material-symbols-outlined:first-child { color: var(--dm-color-primary); }
    .dm-away-head h2 { flex: 1; margin: 0; font: 500 .9375rem/1.25rem Roboto; color: var(--dm-color-fg); }
    .dm-away-dismiss {
      width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 0; border-radius: 999px; color: var(--dm-color-fg-muted); cursor: pointer;
    }
    .dm-away-dismiss:hover { background: var(--dm-color-surface-4); }
    .dm-away-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.25rem; font: 500 .8125rem/1.25rem Roboto; color: var(--dm-color-fg); }
    .dm-away-link { align-self: flex-start; display: inline-flex; align-items: center; gap: .25rem; color: var(--dm-color-primary); font: 500 .8125rem/1.25rem Roboto; text-decoration: none; }
    .dm-away-link:hover { text-decoration: underline; }
    .dm-away-link .material-symbols-outlined { font-size: 16px; }
  `],
})
export class AwayPanelComponent implements OnInit {
  private readonly api = inject(DaimonApi);
  readonly baseline = signal<number | null>(null);
  readonly summary = signal<AwaySummary | null>(null);

  async ngOnInit(): Promise<void> {
    const { sessions } = await this.api.getSessions();
    const baseline = findAwayBaseline(sessions);
    if (!shouldShowAway(baseline)) return;
    // baseline is non-null here (shouldShowAway requires it).
    if (this.alreadyDismissed(baseline!)) return;
    const report = await this.api.getReport({ since: String(baseline) });
    const summary = buildAwaySummary(report);
    if (!summary) return;
    this.baseline.set(baseline);
    this.summary.set(summary);
  }

  dismiss(): void {
    const b = this.baseline();
    if (b != null) {
      try { localStorage.setItem(awayDismissKey(b), '1'); } catch { /* best-effort */ }
    }
    this.summary.set(null);
  }

  private alreadyDismissed(baseline: number): boolean {
    try { return localStorage.getItem(awayDismissKey(baseline)) === '1'; } catch { return false; }
  }
}
