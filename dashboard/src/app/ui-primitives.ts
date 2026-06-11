import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { statusBadge, StatusKind, HealthKind } from './daimon-api';

@Component({
  selector: 'dm-status-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="dm-pill" [attr.data-kind]="kind()">
      <span class="dm-dot" [style.background]="badge().color"></span>
      <span>{{ badge().label }}</span>
      @if (eta) { <span class="dm-eta">{{ eta }}</span> }
    </span>
  `,
  styles: [`
    :host { display: inline-flex; }
    .dm-pill {
      display: inline-flex; align-items: center; gap: .4rem;
      padding: 2px 10px; border-radius: 999px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface);
      font: 500 .75rem/1rem Roboto;
      letter-spacing: .025rem;
    }
    .dm-pill[data-kind="serving"] { background: color-mix(in oklch, var(--mat-sys-primary) 12%, transparent); border-color: color-mix(in oklch, var(--mat-sys-primary) 28%, transparent); }
    .dm-pill[data-kind="compiling"] { background: color-mix(in oklch, var(--mat-sys-tertiary) 14%, transparent); border-color: color-mix(in oklch, var(--mat-sys-tertiary) 28%, transparent); }
    .dm-pill[data-kind="starting"] { background: color-mix(in oklch, var(--mat-sys-secondary) 14%, transparent); border-color: color-mix(in oklch, var(--mat-sys-secondary) 28%, transparent); }
    .dm-pill[data-kind="error"] { background: color-mix(in oklch, var(--mat-sys-error) 14%, transparent); border-color: color-mix(in oklch, var(--mat-sys-error) 30%, transparent); color: var(--mat-sys-error); }
    .dm-dot { width: 8px; height: 8px; border-radius: 999px; box-shadow: 0 0 0 2px color-mix(in oklch, currentColor 18%, transparent); }
    .dm-eta { font: 600 .6875rem/1rem 'Roboto Mono', ui-monospace, monospace; color: var(--mat-sys-on-surface-variant); }
  `],
})
export class StatusPillComponent {
  @Input() status: StatusKind = 'stopped';
  @Input() health: HealthKind = 'unknown';
  @Input() eta = '';
  badge = () => statusBadge({ status: this.status, health: this.health });
  kind = () => this.badge().kind;
}

@Component({
  selector: 'dm-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="dm-sk" [style.width]="width" [style.height]="height"></span>`,
  styles: [`
    .dm-sk {
      display: inline-block; border-radius: 6px;
      background: linear-gradient(90deg,
        var(--mat-sys-surface-container) 0%,
        var(--mat-sys-surface-container-high) 50%,
        var(--mat-sys-surface-container) 100%);
      background-size: 200% 100%;
      animation: dm-shimmer 1.4s linear infinite;
    }
    @keyframes dm-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
    @media (prefers-reduced-motion: reduce) { .dm-sk { animation: none; } }
  `],
})
export class SkeletonComponent {
  @Input() width = '100%';
  @Input() height = '1em';
}

@Component({
  selector: 'dm-empty',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dm-empty">
      @if (icon) { <span class="material-symbols-outlined dm-empty-icon">{{ icon }}</span> }
      <h3 class="dm-empty-title">{{ title }}</h3>
      @if (hint) { <p class="dm-empty-hint">{{ hint }}</p> }
      <ng-content></ng-content>
    </div>
  `,
  styles: [`
    .dm-empty { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 3rem 1rem; text-align: center; color: var(--mat-sys-on-surface-variant); }
    .dm-empty-icon { font-size: 48px; opacity: .55; }
    .dm-empty-title { font: 500 1.125rem/1.5rem Roboto; color: var(--mat-sys-on-surface); margin: 0; }
    .dm-empty-hint { font: 400 .875rem/1.25rem Roboto; max-width: 36rem; margin: 0; }
  `],
})
export class EmptyStateComponent {
  @Input() icon = '';
  @Input() title = '';
  @Input() hint = '';
}

@Component({
  selector: 'dm-mono',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="dm-mono"><ng-content></ng-content></span>`,
  styles: [`
    .dm-mono {
      font-family: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: .875rem;
      letter-spacing: 0;
    }
  `],
})
export class MonoComponent {}
