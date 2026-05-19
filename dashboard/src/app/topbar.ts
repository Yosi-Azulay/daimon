import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DaimonApi } from './daimon-api';
import { ThemeToggleComponent } from './theme-toggle';

const WS_KEY = 'daimon.workspace';
const PROFILE_KEY = 'daimon.profile';

@Component({
  selector: 'dm-topbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, ThemeToggleComponent],
  template: `
    <header class="dm-topbar">
      <button class="dm-chip" [matMenuTriggerFor]="wsMenu" matTooltip="Filter by workspace">
        <mat-icon fontSet="material-symbols-outlined">folder_open</mat-icon>
        <span>{{ workspace() || 'All workspaces' }}</span>
        <mat-icon fontSet="material-symbols-outlined" class="dm-chip-caret">expand_more</mat-icon>
      </button>
      <mat-menu #wsMenu>
        <button mat-menu-item (click)="setWorkspace(null)">All workspaces</button>
        @for (w of api.workspaces(); track w) {
          <button mat-menu-item (click)="setWorkspace(w)">{{ w }}</button>
        }
      </mat-menu>

      <button class="dm-chip" [matMenuTriggerFor]="profileMenu" matTooltip="Run profile: ensure-up">
        <mat-icon fontSet="material-symbols-outlined">play_circle</mat-icon>
        <span>{{ profile() || 'No profile' }}</span>
        <mat-icon fontSet="material-symbols-outlined" class="dm-chip-caret">expand_more</mat-icon>
      </button>
      <mat-menu #profileMenu>
        @if (!profiles().length) {
          <div style="padding: .5rem 1rem; color: var(--mat-sys-on-surface-variant);">No profiles configured</div>
        }
        @for (p of profiles(); track p) {
          <div mat-menu-item style="display:flex;gap:.5rem;align-items:center;">
            <span style="flex:1;">{{ p }}</span>
            <button mat-icon-button (click)="runProfile(p); $event.stopPropagation()" matTooltip="ensure-up">
              <mat-icon fontSet="material-symbols-outlined">rocket_launch</mat-icon>
            </button>
          </div>
        }
      </mat-menu>

      <span class="dm-topbar-spacer"></span>

      <span class="dm-conn" [class.up]="api.connected()" [matTooltip]="api.connected() ? 'Live event stream connected' : 'Reconnecting…'">
        <span class="dm-conn-dot"></span>
        <span class="dm-conn-text">{{ api.connected() ? 'live' : 'offline' }}</span>
      </span>

      <button mat-stroked-button class="dm-cmdk" (click)="onCmdK()" matTooltip="Command palette">
        <mat-icon fontSet="material-symbols-outlined">search</mat-icon>
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
  `],
})
export class TopbarComponent implements OnInit {
  readonly api = inject(DaimonApi);
  private readonly snack = inject(MatSnackBar);
  workspace = signal<string | null>(null);
  profile = signal<string | null>(null);
  profiles = signal<string[]>([]);

  filteredCount = computed(() => {
    const ws = this.workspace();
    return ws ? this.api.apps().filter(a => a.workspaceLabel === ws).length : this.api.apps().length;
  });

  ngOnInit(): void {
    this.workspace.set(localStorage.getItem(WS_KEY));
    this.profile.set(localStorage.getItem(PROFILE_KEY));
    void this.loadProfiles();
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
  }

  async runProfile(name: string): Promise<void> {
    this.profile.set(name);
    localStorage.setItem(PROFILE_KEY, name);
    this.snack.open(`Bringing up profile "${name}"…`, '', { duration: 2000 });
    try {
      const r = await this.api.ensureUp(name);
      const summary = Array.isArray(r?.apps) ? `${r.apps.length} apps ready` : 'done';
      this.snack.open(`Profile "${name}": ${summary}`, 'OK', { duration: 3000 });
    } catch (e: any) {
      this.snack.open(`Profile "${name}" failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 5000 });
    }
  }

  onCmdK(): void {
    window.dispatchEvent(new CustomEvent('daimon:cmdk'));
  }
}
