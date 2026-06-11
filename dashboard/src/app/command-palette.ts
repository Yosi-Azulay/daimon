import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { DaimonApi } from './daimon-api';

interface PaletteItem { kind: 'app' | 'nav' | 'action'; label: string; hint?: string; icon: string; run: () => void; }

@Component({
  selector: 'dm-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule],
  template: `
    @if (open()) {
      <div class="dm-palette-backdrop" (click)="close()"></div>
      <div class="dm-palette" role="dialog" aria-label="Command palette">
        <div class="dm-palette-search">
          <mat-icon fontSet="material-symbols-outlined">search</mat-icon>
          <input #input
                 [(ngModel)]="query"
                 (ngModelChange)="onQuery($event)"
                 placeholder="Jump to app, run action, navigate…"
                 autocomplete="off"
                 spellcheck="false" />
          <kbd>esc</kbd>
        </div>
        <ul class="dm-palette-list" #list>
          @for (item of visible(); track $index; let i = $index) {
            <li class="dm-palette-item"
                [class.active]="i === active()"
                (mouseenter)="active.set(i)"
                (click)="runIdx(i)">
              <mat-icon fontSet="material-symbols-outlined">{{ item.icon }}</mat-icon>
              <span class="dm-palette-label">{{ item.label }}</span>
              @if (item.hint) { <span class="dm-palette-hint">{{ item.hint }}</span> }
              <span class="dm-palette-kind">{{ item.kind }}</span>
            </li>
          } @empty {
            <li class="dm-palette-empty">No matches.</li>
          }
        </ul>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
    :host:has(.dm-palette) { pointer-events: auto; }
    .dm-palette-backdrop { position: absolute; inset: 0; background: color-mix(in oklch, var(--mat-sys-scrim) 50%, transparent); }
    .dm-palette {
      position: absolute; top: 12vh; left: 50%; transform: translateX(-50%);
      width: min(640px, 92vw);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      border-radius: 16px;
      box-shadow: var(--mat-sys-level4);
      overflow: hidden;
      border: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-palette-search {
      display: flex; align-items: center; gap: .75rem;
      padding: .875rem 1rem;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-palette-search input {
      flex: 1; background: transparent; border: 0; outline: 0;
      color: inherit; font: 400 1rem/1.5rem Roboto;
    }
    .dm-palette-search kbd {
      font-family: 'Roboto Mono', ui-monospace, monospace;
      font-size: .6875rem; padding: 2px 6px; border-radius: 4px;
      background: var(--mat-sys-surface-container-low);
      border: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-palette-list { list-style: none; margin: 0; padding: 6px; max-height: 60vh; overflow-y: auto; }
    .dm-palette-item {
      display: flex; align-items: center; gap: .75rem;
      padding: 10px 12px; border-radius: 10px; cursor: pointer;
      font: 500 .875rem/1.25rem Roboto;
    }
    .dm-palette-item.active { background: color-mix(in oklch, var(--mat-sys-primary) 14%, transparent); }
    .dm-palette-label { flex: 1; }
    .dm-palette-hint { color: var(--mat-sys-on-surface-variant); font-family: 'Roboto Mono', monospace; font-size: .75rem; }
    .dm-palette-kind {
      font-size: .6875rem; padding: 2px 8px; border-radius: 999px;
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase; letter-spacing: .05em;
    }
    .dm-palette-empty { padding: 1.5rem; color: var(--mat-sys-on-surface-variant); text-align: center; }
  `],
})
export class CommandPaletteComponent implements OnInit, OnDestroy {
  private readonly api = inject(DaimonApi);
  private readonly router = inject(Router);
  @ViewChild('input') input?: ElementRef<HTMLInputElement>;

  open = signal(false);
  query = '';
  active = signal(0);

  private allItems = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    items.push({ kind: 'nav', icon: 'apps', label: 'Go to Apps', hint: 'g a', run: () => this.go('/') });
    items.push({ kind: 'nav', icon: 'timeline', label: 'Go to Events', hint: 'g v', run: () => this.go('/events') });
    items.push({ kind: 'nav', icon: 'terminal', label: 'Go to Logs', hint: 'g l', run: () => this.go('/logs') });
    items.push({ kind: 'nav', icon: 'error', label: 'Go to Errors', hint: 'g e', run: () => this.go('/errors') });
    items.push({ kind: 'nav', icon: 'trending_down', label: 'Go to Regressions', hint: 'g r', run: () => this.go('/regressions') });
    items.push({ kind: 'nav', icon: 'medical_services', label: 'Go to Doctor', hint: 'g d', run: () => this.go('/doctor') });
    items.push({ kind: 'nav', icon: 'tune', label: 'Go to Config', hint: 'g c', run: () => this.go('/config') });
    items.push({ kind: 'nav', icon: 'query_stats', label: 'Go to History', hint: 'g h', run: () => this.go('/history') });
    for (const a of this.api.apps()) {
      items.push({ kind: 'app', icon: 'app_registration', label: a.name, hint: a.status, run: () => this.go(`/apps/${a.name}`) });
      items.push({ kind: 'action', icon: 'play_arrow', label: `Start ${a.name}`, run: () => void this.api.startApp(a.name) });
      items.push({ kind: 'action', icon: 'restart_alt', label: `Restart ${a.name}`, run: () => void this.api.restartApp(a.name) });
      items.push({ kind: 'action', icon: 'stop', label: `Stop ${a.name}`, run: () => void this.api.stopApp(a.name) });
      items.push({ kind: 'action', icon: 'terminal', label: `Logs for ${a.name}`, run: () => this.go(`/logs/${a.name}`) });
    }
    return items;
  });

  visible = computed<PaletteItem[]>(() => {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.allItems().slice(0, 12);
    return this.allItems().filter(i => i.label.toLowerCase().includes(q) || (i.hint ?? '').toLowerCase().includes(q)).slice(0, 30);
  });

  private listener = () => this.openPalette();

  ngOnInit(): void {
    window.addEventListener('daimon:cmdk', this.listener);
  }
  ngOnDestroy(): void {
    window.removeEventListener('daimon:cmdk', this.listener);
  }

  openPalette(): void {
    this.open.set(true);
    this.query = '';
    this.active.set(0);
    setTimeout(() => this.input?.nativeElement.focus(), 0);
  }

  close(): void { this.open.set(false); }

  onQuery(_q: string): void { this.active.set(0); }

  runIdx(i: number): void {
    const item = this.visible()[i];
    if (!item) return;
    this.close();
    item.run();
  }

  go(path: string): void { void this.router.navigateByUrl(path); }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (!this.open()) return;
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this.active.update(i => Math.min(this.visible().length - 1, i + 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this.active.update(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.runIdx(this.active());
    }
  }
}
