import { AfterViewChecked, ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, ViewChild, signal } from '@angular/core';

// First-run overlay (M79). Shows once; dismissing (skip or finishing the last
// step) persists `daimon.tourDismissed = '1'` and it never shows again. No
// external deps — a centered card, not per-element anchoring, so it works
// identically at 1280px and 390px without measuring target elements.
const KEY = 'daimon.tourDismissed';

interface TourStep {
  icon: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  { icon: 'dashboard', title: 'Mission control', body: 'The Apps page is home base — every dev server you’re running, its status, port, and health at a glance.' },
  { icon: 'toggle_on', title: 'Status badges', body: 'Colored pills show serving / compiling / starting / error per app, with a 24h sparkline so you can spot flapping servers fast.' },
  { icon: 'search', title: 'Command palette', body: 'Press Ctrl+K (⌘K on Mac) anywhere to jump to an app or page without touching the mouse.' },
  { icon: 'density_medium', title: 'Density', body: 'The density icon in the topbar toggles compact / comfortable spacing — handy on small screens or big monitors.' },
  { icon: 'science', title: 'Tests', body: 'The Tests page tracks daimon test run history per app: pass/fail trends, failure drill-down, and flaky-test detection.' },
  { icon: 'explore', title: 'You’re set', body: 'The nav rail covers Errors, Logs, History, Trends and more. Press ? anytime for the full keyboard shortcut list.' },
];

@Component({
  selector: 'dm-onboarding-tour',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="dm-tour-scrim" (click)="skip()"></div>
      <div class="dm-tour-card" role="dialog" aria-modal="true" tabindex="-1" #card
           [attr.aria-label]="'Onboarding step ' + (index() + 1) + ' of ' + steps.length">
        <div class="dm-tour-head">
          <span class="material-symbols-outlined dm-tour-icon">{{ step().icon }}</span>
          <span class="dm-tour-step">{{ index() + 1 }} / {{ steps.length }}</span>
        </div>
        <h3 class="dm-tour-title">{{ step().title }}</h3>
        <p class="dm-tour-body">{{ step().body }}</p>
        <div class="dm-tour-dots" aria-hidden="true">
          @for (s of steps; track $index) {
            <span class="dm-tour-dot" [class.active]="$index === index()"></span>
          }
        </div>
        <div class="dm-tour-actions">
          <button type="button" class="dm-tour-skip" (click)="skip()">Skip</button>
          <div class="dm-tour-nav">
            @if (index() > 0) {
              <button type="button" class="dm-tour-btn" (click)="back()">Back</button>
            }
            <button type="button" class="dm-tour-btn dm-tour-btn-primary" (click)="next()">{{ isLast() ? 'Done' : 'Next' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .dm-tour-scrim {
      position: fixed; inset: 0; z-index: 900;
      background: color-mix(in oklch, black 45%, transparent);
    }
    .dm-tour-card {
      position: fixed; z-index: 901;
      left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(360px, 90vw);
      max-height: 85vh; overflow-y: auto;
      padding: var(--dm-space-6);
      border-radius: var(--dm-radius-xl);
      background: var(--dm-color-surface-3);
      border: 1px solid var(--dm-color-border);
      box-shadow: var(--dm-elev-3);
      color: var(--dm-color-fg);
    }
    .dm-tour-head { display: flex; align-items: center; justify-content: space-between; }
    .dm-tour-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: var(--dm-radius-lg);
      background: color-mix(in oklch, var(--dm-color-primary) var(--dm-badge-tint), transparent);
      color: var(--dm-color-primary);
      font-size: 22px;
    }
    .dm-tour-step { color: var(--dm-color-fg-muted); font: 600 var(--dm-text-xs)/1rem var(--dm-mono); }
    .dm-tour-title { margin: var(--dm-space-4) 0 var(--dm-space-2); font: 500 1.125rem/1.5rem var(--dm-font); }
    .dm-tour-body { margin: 0; color: var(--dm-color-fg-muted); font: 400 var(--dm-text-md)/var(--dm-line-normal) var(--dm-font); }
    .dm-tour-dots { display: flex; gap: 6px; margin: var(--dm-space-5) 0 var(--dm-space-4); }
    .dm-tour-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dm-color-border-strong); }
    .dm-tour-dot.active { background: var(--dm-color-primary); width: 16px; transition: width var(--dm-motion-short) var(--dm-motion-easing); }
    .dm-tour-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--dm-space-3); }
    .dm-tour-skip {
      background: transparent; border: 0; color: var(--dm-color-fg-muted);
      font: 500 var(--dm-text-sm)/1.25rem var(--dm-font); cursor: pointer; padding: 6px 4px;
    }
    .dm-tour-skip:hover { color: var(--dm-color-fg); }
    .dm-tour-nav { display: flex; gap: var(--dm-space-2); }
    .dm-tour-btn {
      padding: 8px 16px; border-radius: var(--dm-radius-lg);
      background: var(--dm-color-surface-2); border: 1px solid var(--dm-color-border);
      color: var(--dm-color-fg); font: 500 var(--dm-text-sm)/1.25rem var(--dm-font); cursor: pointer;
    }
    .dm-tour-btn:hover { background: var(--dm-color-surface-4); }
    .dm-tour-btn-primary { background: var(--dm-color-primary); border-color: var(--dm-color-primary); color: var(--dm-color-on-primary); }
    .dm-tour-btn-primary:hover { filter: brightness(1.05); }
    @media (max-width: 480px) {
      .dm-tour-card { width: min(320px, 92vw); padding: var(--dm-space-4); }
    }
  `],
})
export class OnboardingTourComponent implements OnInit, AfterViewChecked {
  protected readonly steps = STEPS;
  readonly visible = signal(false);
  readonly index = signal(0);
  @ViewChild('card') private cardRef?: ElementRef<HTMLDivElement>;
  private focusedOnShow = false;

  ngOnInit(): void {
    let dismissed = '0';
    try { dismissed = localStorage.getItem(KEY) ?? '0'; } catch { /* localStorage unavailable — never persist, tour just won't recur within a session */ }
    if (dismissed !== '1') this.visible.set(true);
  }

  // Move focus into the dialog once it renders (M89) — the tour is a
  // first-run auto-show with no trigger element, so there's nothing to focus
  // it *from*; this just ensures keyboard users land inside it, not on
  // whatever happened to have focus (or nothing) beforehand.
  ngAfterViewChecked(): void {
    if (this.visible() && this.cardRef && !this.focusedOnShow) {
      this.focusedOnShow = true;
      this.cardRef.nativeElement.focus();
    } else if (!this.visible()) {
      this.focusedOnShow = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.visible()) this.skip();
  }

  step(): TourStep {
    return this.steps[this.index()];
  }

  isLast(): boolean {
    return this.index() === this.steps.length - 1;
  }

  next(): void {
    if (this.isLast()) { this.dismiss(); return; }
    this.index.update(i => i + 1);
  }

  back(): void {
    this.index.update(i => Math.max(0, i - 1));
  }

  skip(): void {
    this.dismiss();
  }

  private dismiss(): void {
    this.visible.set(false);
    try { localStorage.setItem(KEY, '1'); } catch { /* dismissal is best-effort; a blocked localStorage means it'll show again next visit */ }
  }
}
