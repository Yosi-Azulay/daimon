import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { DaimonApi } from './daimon-api';
import { ThemeToggleComponent } from './theme-toggle';

const WS_KEY = 'daimon.workspace';
const PROFILE_KEY = 'daimon.profile';

type MenuKey = 'ws' | 'profile' | null;

@Component({
  selector: 'dm-topbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ThemeToggleComponent],
  template: `
    <header class="dm-topbar">
      <div class="dm-popwrap">
        <button class="dm-chip" type="button" (click)="toggle('ws')" [title]="'Filter by workspace'"
                aria-haspopup="true" [attr.aria-expanded]="openMenu() === 'ws'">
          <span class="material-symbols-outlined">folder_open</span>
          <span>{{ workspace() || 'All workspaces' }}</span>
          <span class="material-symbols-outlined dm-chip-caret">expand_more</span>
        </button>
        @if (openMenu() === 'ws') {
          <div class="dm-pop" role="menu">
            <button type="button" role="menuitem" (click)="setWorkspace(null)">All workspaces</button>
            @for (w of api.workspaces(); track w) {
              <button type="button" role="menuitem" (click)="setWorkspace(w)">{{ w }}</button>
            }
          </div>
        }
      </div>

      <div class="dm-popwrap">
        <button class="dm-chip" type="button" (click)="toggle('profile')" [title]="'Run profile: ensure-up'"
                aria-haspopup="true" [attr.aria-expanded]="openMenu() === 'profile'">
          <span class="material-symbols-outlined">play_circle</span>
          <span>{{ profile() || 'No profile' }}</span>
          <span class="material-symbols-outlined dm-chip-caret">expand_more</span>
        </button>
        @if (openMenu() === 'profile') {
          <div class="dm-pop" role="menu">
            @if (!profiles().length) {
              <div class="dm-pop-empty">No profiles configured</div>
            }
            @for (p of profiles(); track p) {
              <div class="dm-pop-row" role="menuitem">
                <span class="dm-pop-label">{{ p }}</span>
                <button class="dm-pop-go" type="button" (click)="runProfile(p)" title="ensure-up">
                  <span class="material-symbols-outlined">rocket_launch</span>
                </button>
              </div>
            }
          </div>
        }
      </div>

      @if (workspace(); as ws) {
        <span class="dm-scope" [title]="'Scope: ' + ws + (api.cwdHint() ? '  (cwd ' + api.cwdHint() + ')' : '')">
          <span class="material-symbols-outlined">filter_alt</span>
          <span>scope: <strong>{{ ws }}</strong></span>
          <button type="button" class="dm-scope-x" (click)="setWorkspace(null)" title="Clear scope">×</button>
        </span>
      }

      <span class="dm-topbar-spacer"></span>

      <span class="dm-conn" [class.up]="api.connected()" [title]="api.connected() ? 'Live event stream connected' : 'Reconnecting…'">
        <span class="dm-conn-dot"></span>
        <span class="dm-conn-text">{{ api.connected() ? 'live' : 'offline' }}</span>
      </span>

      <button class="dm-cmdk" type="button" (click)="onCmdK()" title="Command palette">
        <span class="material-symbols-outlined">search</span>
        <span style="margin: 0 .5rem;">Jump to…</span>
        <kbd class="dm-kbd">⌘K</kbd>
      </button>

      <dm-theme-toggle />
    </header>
  `,
  styles: [`
    :host { display: contents; }
    .dm-topbar {
      grid-area: topbar;
      display: flex; align-items: center; gap: .5rem;
      padding: 10px 16px;
      background: var(--mat-sys-surface);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      min-height: 56px;
    }
    .dm-topbar-spacer { flex: 1; }
    .dm-chip {
      display: inline-flex; align-items: center; gap: .5rem;
      padding: 6px 10px; border-radius: 999px;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface);
      font: 500 .8125rem/1.25rem Roboto;
      cursor: pointer;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-chip:hover { background: var(--mat-sys-surface-container-high); }
    .dm-chip mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .dm-chip-caret { opacity: .7; }
    .dm-cmdk {
      display: inline-flex; align-items: center; gap: .25rem;
      border-radius: 12px !important;
    }
    .dm-cmdk mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .dm-kbd {
      font-family: 'Roboto Mono', ui-monospace, monospace;
      font-size: .6875rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-conn {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 4px 10px; border-radius: 999px;
      font: 500 .75rem/1rem Roboto;
      color: var(--mat-sys-on-surface-variant);
      background: var(--mat-sys-surface-container);
    }
    .dm-conn-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--mat-sys-outline); }
    .dm-conn.up .dm-conn-dot { background: var(--mat-sys-primary); box-shadow: 0 0 0 4px color-mix(in oklch, var(--mat-sys-primary) 25%, transparent); }
    .dm-conn.up .dm-conn-text { color: var(--mat-sys-primary); }
    .dm-popwrap { position: relative; display: inline-block; }
    .dm-pop { position: absolute; left: 0; top: calc(100% + 4px); min-width: 200px; max-height: 60vh; overflow-y: auto;
      background: var(--mat-sys-surface-container-high); border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px; padding: 4px; box-shadow: var(--mat-sys-level2); z-index: 50; display: flex; flex-direction: column; gap: 1px; }
    .dm-pop button { display: flex; align-items: center; padding: 8px 12px; background: transparent; border: 0; border-radius: 6px;
      text-align: left; color: var(--mat-sys-on-surface); font: 500 .8125rem/1.25rem Roboto; cursor: pointer; }
    .dm-pop button:hover { background: var(--mat-sys-surface-container-highest); }
    .dm-pop-empty { padding: .5rem 1rem; color: var(--mat-sys-on-surface-variant); }
    .dm-pop-row { display: flex; align-items: center; gap: .5rem; padding: 4px 8px; }
    .dm-pop-label { flex: 1; font: 500 .8125rem/1.25rem Roboto; color: var(--mat-sys-on-surface); }
    .dm-pop-go { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
      background: transparent; border: 0; border-radius: 999px; color: var(--mat-sys-primary); cursor: pointer; }
    .dm-pop-go:hover { background: var(--mat-sys-surface-container-highest); }
    .dm-pop-go .material-symbols-outlined { font-size: 18px; }
    .dm-cmdk { display: inline-flex; align-items: center; gap: .25rem; padding: 8px 14px; border-radius: 12px;
      background: transparent; border: 1px solid var(--mat-sys-outline); color: var(--mat-sys-on-surface); cursor: pointer; }
    .dm-cmdk:hover { background: var(--mat-sys-surface-container); }
    .dm-cmdk .material-symbols-outlined { font-size: 18px; }
    .dm-scope {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 4px 4px 4px 10px; border-radius: 999px;
      background: color-mix(in oklch, var(--mat-sys-primary) 14%, var(--mat-sys-surface-container));
      border: 1px solid color-mix(in oklch, var(--mat-sys-primary) 40%, transparent);
      color: var(--mat-sys-on-surface);
      font: 500 .75rem/1rem Roboto;
    }
    .dm-scope .material-symbols-outlined { font-size: 16px; color: var(--mat-sys-primary); }
    .dm-scope strong { font-weight: 600; }
    .dm-scope-x {
      width: 22px; height: 22px;
      background: transparent; border: 0; border-radius: 999px;
      color: var(--mat-sys-on-surface-variant); cursor: pointer;
      font-size: 1.125rem; line-height: 1; padding: 0;
    }
    .dm-scope-x:hover { background: var(--mat-sys-surface-container-highest); }
  `],
})
export class TopbarComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private readonly host = inject(ElementRef);
  workspace = signal<string | null>(null);
  profile = signal<string | null>(null);
  profiles = signal<string[]>([]);
  readonly openMenu = signal<MenuKey>(null);

  filteredCount = computed(() => {
    const ws = this.workspace();
    return ws ? this.api.apps().filter(a => a.workspaceLabel === ws).length : this.api.apps().length;
  });

  ngOnInit(): void {
    this.workspace.set(localStorage.getItem(WS_KEY));
    this.profile.set(localStorage.getItem(PROFILE_KEY));
    void this.loadProfiles();
    // Stay in sync when other components (or the cwd auto-pick) update the
    // active workspace.
    window.addEventListener('daimon:workspace', this.onWorkspaceChanged);
  }

  ngOnDestroy(): void {
    window.removeEventListener('daimon:workspace', this.onWorkspaceChanged);
  }

  private readonly onWorkspaceChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail as string | null;
    this.workspace.set(detail ?? null);
  };

  toggle(k: Exclude<MenuKey, null>): void {
    this.openMenu.update(prev => prev === k ? null : k);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (!this.openMenu()) return;
    const t = ev.target as Node;
    if (!(this.host.nativeElement as HTMLElement).contains(t)) this.openMenu.set(null);
  }

  private async loadProfiles(): Promise<void> {
    try {
      const r = await fetch('/api/config');
      if (!r.ok) return;
      const j = await r.json();
      const ps = j?.config?.profiles ? Object.keys(j.config.profiles) : [];
      this.profiles.set(ps);
    } catch {}
  }

  setWorkspace(w: string | null): void {
    this.workspace.set(w);
    if (w) localStorage.setItem(WS_KEY, w); else localStorage.removeItem(WS_KEY);
    window.dispatchEvent(new CustomEvent('daimon:workspace', { detail: w }));
    this.openMenu.set(null);
  }

  private toast(msg: string, duration = 3000): void {
    let host = document.getElementById('dm-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'dm-toast-host';
      host.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'pointer-events:auto;padding:10px 16px;background:var(--mat-sys-inverse-surface,#322f35);color:var(--mat-sys-inverse-on-surface,#f5eff4);border-radius:8px;font:500 .8125rem/1.25rem Roboto;box-shadow:var(--mat-sys-level3,0 4px 12px rgba(0,0,0,.25))';
    host.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch {} }, duration);
  }

  async runProfile(name: string): Promise<void> {
    this.profile.set(name);
    localStorage.setItem(PROFILE_KEY, name);
    this.openMenu.set(null);
    this.toast(`Bringing up profile "${name}"…`, 2000);
    try {
      const r = await this.api.ensureUp(name);
      const summary = Array.isArray(r?.apps) ? `${r.apps.length} apps ready` : 'done';
      this.toast(`Profile "${name}": ${summary}`, 3000);
    } catch (e: any) {
      this.toast(`Profile "${name}" failed: ${e?.message ?? 'error'}`, 5000);
    }
  }

  onCmdK(): void {
    window.dispatchEvent(new CustomEvent('daimon:cmdk'));
  }
}
