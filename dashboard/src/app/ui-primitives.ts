import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { statusBadge, StatusKind, HealthKind } from './daimon-api';
import { frameworkTone } from './workspace-tone';

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
      padding: 2px 10px; border-radius: var(--dm-radius-full);
      border: 1px solid var(--dm-color-border);
      background: var(--dm-color-surface-2);
      color: var(--dm-color-fg);
      font: 500 var(--dm-text-xs)/var(--dm-line-tight) var(--dm-font);
      font-size: .75rem;
      letter-spacing: .025rem;
    }
    .dm-pill[data-kind="serving"] { background: color-mix(in oklch, var(--dm-color-serving) 12%, transparent); border-color: color-mix(in oklch, var(--dm-color-serving) 28%, transparent); }
    .dm-pill[data-kind="compiling"] { background: color-mix(in oklch, var(--dm-color-compiling) 14%, transparent); border-color: color-mix(in oklch, var(--dm-color-compiling) 28%, transparent); }
    .dm-pill[data-kind="starting"] { background: color-mix(in oklch, var(--dm-color-starting) 14%, transparent); border-color: color-mix(in oklch, var(--dm-color-starting) 28%, transparent); }
    .dm-pill[data-kind="error"] { background: color-mix(in oklch, var(--dm-color-error) 14%, transparent); border-color: color-mix(in oklch, var(--dm-color-error) 30%, transparent); color: var(--dm-color-error); }
    .dm-dot { width: 8px; height: 8px; border-radius: var(--dm-radius-full); box-shadow: 0 0 0 2px color-mix(in oklch, currentColor 18%, transparent); }
    .dm-eta { font: 600 var(--dm-text-xs)/var(--dm-line-tight) var(--dm-mono); color: var(--dm-color-fg-muted); }
  `],
})
export class StatusPillComponent {
  @Input() status: StatusKind = 'stopped';
  @Input() health: HealthKind = 'unknown';
  @Input() eta = '';
  badge = () => statusBadge({ status: this.status, health: this.health });
  kind = () => this.badge().kind;
}

// Framework identity badge (M70): monochrome glyph tag tinted with the
// profile's registry tone. Inline SVG-free by design — the rounded-square
// letter mark ships as styled text, no external assets.
@Component({
  selector: 'dm-framework-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (badge) {
      <span class="dm-fw" [style.--dm-fw-tone]="toneColor()" [attr.title]="profileId || badge">
        <svg class="dm-fw-glyph" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1" y="1" width="14" height="14" rx="4" fill="currentColor" opacity="0.16"></rect>
          <rect x="1" y="1" width="14" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.6"></rect>
        </svg>
        <span class="dm-fw-tag">{{ badge }}</span>
      </span>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .dm-fw {
      display: inline-flex; align-items: center; gap: .25rem;
      padding: 1px 8px 1px 4px;
      border-radius: var(--dm-radius-full);
      border: 1px solid color-mix(in oklch, var(--dm-fw-tone, var(--dm-color-border)) 45%, transparent);
      background: color-mix(in oklch, var(--dm-fw-tone, var(--dm-color-surface-2)) 14%, transparent);
      color: var(--dm-fw-tone, var(--dm-color-fg-muted));
    }
    .dm-fw-glyph { width: 12px; height: 12px; flex-shrink: 0; }
    .dm-fw-tag {
      font: 600 var(--dm-text-xs)/var(--dm-line-tight) var(--dm-mono);
      letter-spacing: .02rem;
      color: var(--dm-color-fg);
    }
  `],
})
export class FrameworkBadgeComponent {
  @Input() badge = '';
  @Input() tone: number | null = null;
  @Input() profileId = '';
  toneColor = () => frameworkTone(this.tone);
}

// Tiny inline-SVG sparkline (M70): 24h uptime/error strip for mission-control
// cards. Each bucket renders as a bar — height/tone from the dominant status,
// with error buckets flagged in the danger tone.
@Component({
  selector: 'dm-sparkline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="dm-spark" [attr.viewBox]="'0 0 ' + width + ' 14'" preserveAspectRatio="none" aria-hidden="true">
      @for (b of buckets; track $index) {
        <rect
          [attr.x]="$index * step + 0.5"
          [attr.y]="14 - barHeight(b)"
          [attr.width]="step - 1"
          [attr.height]="barHeight(b)"
          [attr.class]="'sp-' + (b || 'none')"
          rx="1"></rect>
      }
    </svg>
  `,
  styles: [`
    :host { display: block; }
    .dm-spark { width: 100%; height: 14px; display: block; }
    rect.sp-none { fill: var(--dm-color-stopped); opacity: .35; }
    rect.sp-stopped { fill: var(--dm-color-stopped); }
    rect.sp-serving { fill: color-mix(in oklch, var(--dm-color-serving) 65%, transparent); }
    rect.sp-compiling, rect.sp-starting { fill: color-mix(in oklch, var(--dm-color-compiling) 70%, transparent); }
    rect.sp-error { fill: var(--dm-color-error); }
  `],
})
export class SparklineComponent {
  @Input() buckets: string[] = [];
  get step(): number { return 6; }
  get width(): number { return this.buckets.length * this.step; }
  barHeight(kind: string): number {
    if (kind === 'error') return 12;
    if (kind === 'serving') return 9;
    if (kind === 'compiling' || kind === 'starting') return 7;
    if (kind === 'stopped') return 4;
    return 2;
  }
}

@Component({
  selector: 'dm-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="dm-sk" [style.width]="width" [style.height]="height"></span>`,
  styles: [`
    .dm-sk {
      display: inline-block; border-radius: var(--dm-radius-sm);
      background: linear-gradient(90deg,
        var(--dm-color-surface-2) 0%,
        var(--dm-color-surface-3) 50%,
        var(--dm-color-surface-2) 100%);
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
    .dm-empty { display: flex; flex-direction: column; align-items: center; gap: var(--dm-space-2); padding: var(--dm-space-12) var(--dm-space-4); text-align: center; color: var(--dm-color-fg-muted); }
    .dm-empty-icon { font-size: 48px; opacity: .55; }
    .dm-empty-title { font: 500 1.125rem/var(--dm-line-loose) var(--dm-font); color: var(--dm-color-fg); margin: 0; }
    .dm-empty-hint { font: 400 var(--dm-text-md)/var(--dm-line-normal) var(--dm-font); max-width: 36rem; margin: 0; }
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
      font-family: var(--dm-mono);
      font-size: var(--dm-text-md);
      letter-spacing: 0;
    }
  `],
})
export class MonoComponent {}
