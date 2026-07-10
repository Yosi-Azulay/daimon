import { ChangeDetectionStrategy, Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavRailComponent } from './nav-rail';
import { TopbarComponent } from './topbar';
import { CommandPaletteComponent } from './command-palette';
import { OnboardingTourComponent } from './onboarding-tour';
import { KeyboardShortcutsService } from './keyboard-shortcuts';
import { DaimonApi } from './daimon-api';

const WS_KEY = 'daimon.workspace';

@Component({
  selector: 'dm-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, NavRailComponent, TopbarComponent, CommandPaletteComponent, OnboardingTourComponent],
  template: `
    <div class="dm-shell">
      <dm-nav-rail></dm-nav-rail>
      <dm-topbar></dm-topbar>
      <main class="dm-main">
        @if (api.cwdUnknown() && api.cwdHint(); as cwd) {
          <div class="dm-cwd-banner" role="status">
            <span class="material-symbols-outlined">help_outline</span>
            <span>cwd <code>{{ cwd }}</code> isn't covered by any registered workspace.</span>
            <button type="button" (click)="registerCwd(cwd)" [disabled]="registering()">
              {{ registering() ? 'Registering…' : 'Register' }}
            </button>
            <button type="button" class="dm-cwd-dismiss" (click)="dismissBanner()" title="Dismiss">×</button>
          </div>
        }
        <router-outlet />
      </main>
    </div>
    @defer (when paletteActivated()) {
      <dm-command-palette></dm-command-palette>
    }
    <dm-onboarding-tour></dm-onboarding-tour>
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    .dm-shell {
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-rows: auto 1fr;
      grid-template-areas:
        "rail topbar"
        "rail main";
      height: 100vh;
      min-height: 100vh;
    }
    .dm-main {
      grid-area: main;
      overflow-y: auto;
      padding: var(--dm-space-6);
      background: var(--dm-color-bg);
    }
    /* Responsive shell (M71): under 768px the rail becomes a bottom bar and
       the topbar condenses; every route stays usable down to 390px. */
    @media (max-width: 768px) {
      .dm-shell {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr auto;
        grid-template-areas:
          "topbar"
          "main"
          "rail";
      }
      .dm-main { padding: var(--dm-space-3); }
    }
    .dm-cwd-banner {
      display: flex; align-items: center; gap: .75rem;
      padding: 10px 14px;
      margin-bottom: 1rem;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px;
      color: var(--mat-sys-on-surface);
      font: 500 .8125rem/1.25rem Roboto;
    }
    .dm-cwd-banner code { font-family: 'Roboto Mono', ui-monospace, monospace; }
    .dm-cwd-banner button {
      padding: 4px 12px;
      background: var(--mat-sys-primary); color: var(--mat-sys-on-primary);
      border: 0; border-radius: 8px; cursor: pointer;
      font: 500 .8125rem/1.25rem Roboto;
    }
    .dm-cwd-banner button[disabled] { opacity: .6; cursor: progress; }
    .dm-cwd-banner button.dm-cwd-dismiss {
      background: transparent; color: var(--mat-sys-on-surface-variant);
      padding: 4px 10px; font-size: 1.125rem; line-height: 1;
    }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private readonly keys = inject(KeyboardShortcutsService);
  readonly paletteActivated = signal(false);
  readonly registering = signal(false);
  private readonly onCmdK = () => {
    if (this.paletteActivated()) return;
    this.paletteActivated.set(true);
    // The palette mounts after defer resolves; re-dispatch so it can hear the
    // open signal once its own ngOnInit listener is attached.
    setTimeout(() => window.dispatchEvent(new CustomEvent('daimon:cmdk')), 50);
  };

  ngOnInit(): void {
    this.api.start();
    this.keys.install();
    window.addEventListener('daimon:cmdk', this.onCmdK);
    void this.detectCwd();
  }

  ngOnDestroy(): void {
    this.api.stop();
    this.keys.uninstall();
    window.removeEventListener('daimon:cmdk', this.onCmdK);
  }

  // Read `?cwd=<path>` from the URL; if present, ask the daemon which workspace
  // covers it, then pre-select the workspace filter pill. If no workspace
  // covers the cwd, raise the unknown-cwd banner.
  private async detectCwd(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const cwd = params.get('cwd');
    if (!cwd) return;
    this.api.cwdHint.set(cwd);
    const r = await this.api.resolveCwd(cwd);
    if (!r) {
      this.api.cwdUnknown.set(true);
      return;
    }
    this.api.cwdResolved.set({ path: r.path, label: r.label ?? null });
    if (r.label) {
      // Hand the workspace label to the existing topbar/apps-list filter via
      // localStorage + the same daimon:workspace event they already subscribe to.
      try { localStorage.setItem(WS_KEY, r.label); } catch {}
      window.dispatchEvent(new CustomEvent('daimon:workspace', { detail: r.label }));
    }
  }

  async registerCwd(cwd: string): Promise<void> {
    if (this.registering()) return;
    this.registering.set(true);
    try {
      await this.api.registerWorkspace(cwd);
      const r = await this.api.resolveCwd(cwd);
      if (r) {
        this.api.cwdResolved.set({ path: r.path, label: r.label ?? null });
        this.api.cwdUnknown.set(false);
        if (r.label) {
          try { localStorage.setItem(WS_KEY, r.label); } catch {}
          window.dispatchEvent(new CustomEvent('daimon:workspace', { detail: r.label }));
        }
        await this.api.refresh();
      }
    } catch {} finally {
      this.registering.set(false);
    }
  }

  dismissBanner(): void {
    this.api.cwdUnknown.set(false);
  }
}
