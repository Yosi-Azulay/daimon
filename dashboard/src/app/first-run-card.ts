import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Output, inject, signal } from '@angular/core';
import { EmptyStateComponent, MonoComponent } from './ui-primitives';
import { writeFirstRunDismissed } from './first-run-helpers';

// The no-apps-yet walkthrough (M169, v1.14). Shown on `/apps` and `/` — the
// two places a brand-new install first lands — whenever the daemon reports
// zero configured apps. Strictly presentational: no HTTP call of its own, no
// config write, no telemetry. `daimon init` is the one command a stranger
// needs; everything else here just explains what it does and what happens
// next, copying M79's onboarding-tour precedent (dismiss = localStorage, not
// server state) but scoped to the first-run walkthrough's own key so the two
// features can be dismissed independently (dismissing the product tour
// shouldn't silently dismiss this card too, and vice versa).
//
// Dismissing hides the elaborate card in favor of the page's own plain empty
// state (each host still renders that fallback) — the "no apps" fact doesn't
// go away, only the walkthrough's teaching does, and only by the user's own
// choice.
@Component({
  selector: 'dm-first-run-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, MonoComponent],
  template: `
    <div class="dm-fr" data-testid="first-run-card">
      <dm-empty icon="rocket_launch" title="No apps yet"
        hint="daimon watches the dev servers in your workspace. Get started with one command in a terminal, in the folder you want it to watch:">
        <div class="dm-fr-cmd">
          <code class="dm-fr-cmd-text" data-testid="first-run-cmd">daimon init</code>
          <button type="button" class="dm-fr-copy" (click)="copy()"
                  [attr.aria-label]="copied() ? 'Copied to clipboard' : 'Copy command to clipboard'"
                  data-testid="first-run-copy">
            <span class="material-symbols-outlined">{{ copied() ? 'check' : 'content_copy' }}</span>
            {{ copied() ? 'Copied' : 'Copy' }}
          </button>
        </div>

        <div class="dm-fr-next">
          <h4 class="dm-fr-next-title">What happens next</h4>
          <ol class="dm-fr-steps">
            <li>Scans this folder for known frameworks (Angular, Vite, Next.js, Django, Rails, and more) — the same scan <dm-mono>daimon discover</dm-mono> uses.</li>
            <li>Writes one file, <dm-mono>daimon.config.json</dm-mono>, right here. Nothing in <dm-mono>~/.daimon</dm-mono>, nothing in your source, no install.</li>
            <li>Run <dm-mono>daimon daemon start</dm-mono> and the apps it found appear on this page.</li>
          </ol>
        </div>

        <p class="dm-fr-quickstart">
          Prefer to read first? <dm-mono>QUICKSTART.md</dm-mono> in the repo walks through all of this in about five minutes.
        </p>

        <div class="dm-fr-actions">
          <ng-content></ng-content>
          <button type="button" class="dm-fr-dismiss" (click)="dismiss()" data-testid="first-run-dismiss">
            Don't show this again
          </button>
        </div>
      </dm-empty>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dm-fr-cmd {
      display: inline-flex; align-items: center; gap: var(--dm-space-2);
      margin-top: var(--dm-space-3); padding: 8px 8px 8px 16px;
      background: var(--dm-color-surface-3); border: 1px solid var(--dm-color-border);
      border-radius: var(--dm-radius-lg);
    }
    .dm-fr-cmd-text { font: 500 var(--dm-text-md)/1.5rem var(--dm-mono); color: var(--dm-color-fg); }
    .dm-fr-copy {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 6px 12px; border-radius: var(--dm-radius-md);
      background: var(--dm-color-primary); border: 0; color: var(--dm-color-on-primary);
      font: 600 var(--dm-text-sm)/1.25rem var(--dm-font); cursor: pointer;
    }
    .dm-fr-copy:hover { filter: brightness(1.05); }
    .dm-fr-copy .material-symbols-outlined { font-size: 16px; }

    .dm-fr-next { margin-top: var(--dm-space-5); text-align: left; max-width: 34rem; }
    .dm-fr-next-title {
      margin: 0 0 var(--dm-space-2); font: 600 var(--dm-text-xs)/1rem var(--dm-font);
      text-transform: uppercase; letter-spacing: .05em; color: var(--dm-color-fg-muted);
    }
    .dm-fr-steps {
      margin: 0; padding-left: 1.25rem; display: flex; flex-direction: column; gap: var(--dm-space-2);
      color: var(--dm-color-fg-muted); font: 400 var(--dm-text-sm)/var(--dm-line-normal) var(--dm-font);
    }
    .dm-fr-quickstart {
      margin: var(--dm-space-4) 0 0; color: var(--dm-color-fg-muted);
      font: 400 var(--dm-text-sm)/var(--dm-line-normal) var(--dm-font); max-width: 34rem;
    }
    .dm-fr-actions {
      margin-top: var(--dm-space-5); display: flex; align-items: center; gap: var(--dm-space-4); flex-wrap: wrap;
      justify-content: center;
    }
    .dm-fr-dismiss {
      background: transparent; border: 0; color: var(--dm-color-fg-muted);
      font: 500 var(--dm-text-sm)/1.25rem var(--dm-font); cursor: pointer; text-decoration: underline;
      text-underline-offset: 2px; padding: 4px;
    }
    .dm-fr-dismiss:hover { color: var(--dm-color-fg); }
  `],
})
export class FirstRunCardComponent {
  @Output() dismissed = new EventEmitter<void>();

  private readonly destroyRef = inject(DestroyRef);
  readonly copied = signal(false);
  private copyResetTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.destroyRef.onDestroy(() => { if (this.copyResetTimer) clearTimeout(this.copyResetTimer); });
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText('daimon init');
      this.copied.set(true);
      if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
      this.copyResetTimer = setTimeout(() => this.copied.set(false), 2000);
    } catch { /* clipboard unavailable — the command is still selectable text */ }
  }

  dismiss(): void {
    writeFirstRunDismissed(localStorage);
    this.dismissed.emit();
  }
}
