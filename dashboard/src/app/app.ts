import { ChangeDetectionStrategy, Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavRailComponent } from './nav-rail';
import { TopbarComponent } from './topbar';
import { CommandPaletteComponent } from './command-palette';
import { OnboardingTourComponent } from './onboarding-tour';
import { AwayPanelComponent } from './away-panel';
import { KeyboardShortcutsService } from './keyboard-shortcuts';
import { DaimonApi } from './daimon-api';

const WS_KEY = 'daimon.workspace';

@Component({
  selector: 'dm-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, NavRailComponent, TopbarComponent, CommandPaletteComponent, OnboardingTourComponent, AwayPanelComponent],
  template: `
    <a class="dm-skip-link" href="#dm-main-content">Skip to content</a>
    <div class="dm-shell">
      <dm-nav-rail></dm-nav-rail>
      <dm-topbar></dm-topbar>
      <!-- tabindex 0 (not -1): the main region scrolls, and a scrollable
           region must be keyboard-reachable (axe scrollable-region-focusable
           — surfaced on /agents once its content grew past the viewport).
           Still serves as the skip-link target. -->
      <main id="dm-main-content" class="dm-main" tabindex="0">
        @if (api.cwdUnknown() && api.cwdHint(); as cwd) {
          <div class="dm-cwd-banner" role="status">
            <span class="material-symbols-outlined">help_outline</span>
            <span>cwd <code>{{ cwd }}</code> isn't covered by any registered workspace.</span>
            <button type="button" (click)="registerCwd(cwd)" [disabled]="registering()">
              {{ registering() ? 'Registering…' : 'Register' }}
            </button>
            <button type="button" class="dm-cwd-dismiss" (click)="dismissBanner()" aria-label="Dismiss" title="Dismiss">×</button>
          </div>
        }
        <dm-away-panel></dm-away-panel>
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
    /* Skip-to-content link (M89): first tabbable element in the app. Visually
       hidden until it receives focus, then pinned to the top-left corner so
       keyboard users can jump straight past the nav rail and topbar. */
    .dm-skip-link {
      position: fixed; top: -100%; left: var(--dm-space-3); z-index: 2000;
      padding: 10px 16px; border-radius: var(--dm-radius-md);
      background: var(--dm-color-primary); color: var(--dm-color-on-primary);
      font: 600 var(--dm-text-sm)/1.25rem var(--dm-font);
      text-decoration: none;
    }
    .dm-skip-link:focus-visible {
      top: var(--dm-space-3);
    }
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
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      border-radius: 10px;
      color: var(--dm-color-fg);
      font: 500 .8125rem/1.25rem Roboto;
    }
    .dm-cwd-banner code { font-family: 'Roboto Mono', ui-monospace, monospace; }
    .dm-cwd-banner button {
      padding: 4px 12px;
      background: var(--dm-color-primary); color: var(--dm-color-on-primary);
      border: 0; border-radius: 8px; cursor: pointer;
      font: 500 .8125rem/1.25rem Roboto;
    }
    .dm-cwd-banner button[disabled] { opacity: .6; cursor: progress; }
    .dm-cwd-banner button.dm-cwd-dismiss {
      background: transparent; color: var(--dm-color-fg-muted);
      padding: 4px 10px; font-size: 1.125rem; line-height: 1;
    }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private readonly keys = inject(KeyboardShortcutsService);
  readonly paletteActivated = signal(false);
  readonly registering = signal(false);
  // First-open handshake: the palette mounts via @defer, so the very first
  // cmdk request arrives before its listener exists. A timed re-dispatch (the
  // old 50ms setTimeout) silently DROPPED the open on a slow machine — the
  // palette announces 'daimon:cmdk-ready' from its ngOnInit instead, and the
  // pending open replays exactly then. Deterministic, no timing gamble.
  private pendingPaletteOpen: { query?: string } | null = null;
  private readonly onCmdK = (e: Event) => {
    if (this.paletteActivated()) return;
    this.paletteActivated.set(true);
    // Keep the event detail (M102's search prefill) — the replay must carry
    // it or a first-ever open from the Logs page lands blank.
    this.pendingPaletteOpen = { query: (e as CustomEvent<{ query?: string }>).detail?.query };
  };
  private readonly onPaletteReady = () => {
    if (!this.pendingPaletteOpen) return;
    const detail = this.pendingPaletteOpen;
    this.pendingPaletteOpen = null;
    window.dispatchEvent(new CustomEvent('daimon:cmdk', { detail }));
  };

  ngOnInit(): void {
    this.api.start();
    this.keys.install();
    window.addEventListener('daimon:cmdk', this.onCmdK);
    window.addEventListener('daimon:cmdk-ready', this.onPaletteReady);
    void this.detectCwd();
  }

  ngOnDestroy(): void {
    this.api.stop();
    this.keys.uninstall();
    window.removeEventListener('daimon:cmdk', this.onCmdK);
    window.removeEventListener('daimon:cmdk-ready', this.onPaletteReady);
  }

  // Read `?cwd=<path>` from the URL; if present, ask the daemon which workspace
  // covers it, then pre-select the workspace filter pill. If no workspace
  // covers the cwd, raise the unknown-cwd banner.
  //
  // Precedence (M173, v1.15): an EXPLICIT `?workspace=<label>` deep-link wins
  // over both the stored preference and the cwd auto-pick — a shared link must
  // land on the workspace it names, not on whatever the viewer last selected.
  private async detectCwd(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const explicit = params.get('workspace');
    if (explicit) {
      try { localStorage.setItem(WS_KEY, explicit); } catch {}
      window.dispatchEvent(new CustomEvent('daimon:workspace', { detail: explicit }));
    }
    const cwd = params.get('cwd');
    if (!cwd) return;
    this.api.cwdHint.set(cwd);
    const r = await this.api.resolveCwd(cwd);
    if (!r) {
      this.api.cwdUnknown.set(true);
      return;
    }
    this.api.cwdResolved.set({ path: r.path, label: r.label ?? null });
    if (r.label && !explicit) {
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
