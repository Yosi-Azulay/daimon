import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

interface NavEntry { path: string; icon: string; label: string; shortcut: string; }

const ENTRIES: NavEntry[] = [
  { path: '/',         icon: 'apps',                 label: 'Apps',     shortcut: 'g a' },
  { path: '/errors',   icon: 'error',                label: 'Errors',   shortcut: 'g e' },
  { path: '/logs',     icon: 'terminal',             label: 'Logs',     shortcut: 'g l' },
  { path: '/config',   icon: 'tune',                 label: 'Settings', shortcut: 'g s' },
  { path: '/doctor',   icon: 'medical_services',     label: 'Doctor',   shortcut: 'g d' },
  { path: '/events',   icon: 'timeline',             label: 'Events',   shortcut: 'g v' },
  { path: '/history',  icon: 'query_stats',          label: 'History',  shortcut: 'g h' },
  { path: '/sessions', icon: 'radio_button_checked', label: 'Sessions', shortcut: 'g n' },
];

const KEY = 'daimon.nav.expanded';

@Component({
  selector: 'dm-nav-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, MatIconModule, MatTooltipModule],
  template: `
    <nav class="dm-rail" [class.expanded]="expanded()">
      <button class="dm-rail-toggle" (click)="toggle()" [attr.aria-label]="expanded() ? 'Collapse' : 'Expand'">
        <mat-icon fontSet="material-symbols-outlined">{{ expanded() ? 'menu_open' : 'menu' }}</mat-icon>
      </button>
      <div class="dm-rail-brand">
        <mat-icon fontSet="material-symbols-outlined">developer_board</mat-icon>
        @if (expanded()) { <span>daimon</span> }
      </div>
      <div class="dm-rail-items">
        @for (e of entries; track e.path) {
          <a class="dm-rail-item"
             [routerLink]="e.path"
             [routerLinkActiveOptions]="{ exact: e.path === '/' }"
             routerLinkActive="active"
             [matTooltip]="expanded() ? e.shortcut : (e.label + ' · ' + e.shortcut)"
             matTooltipPosition="right">
            <mat-icon fontSet="material-symbols-outlined">{{ e.icon }}</mat-icon>
            @if (expanded()) {
              <span class="dm-rail-label">{{ e.label }}</span>
            }
          </a>
        }
      </div>
    </nav>
  `,
  styles: [`
    :host { display: contents; }
    .dm-rail {
      grid-area: rail;
      display: flex; flex-direction: column;
      background: var(--mat-sys-surface-container);
      border-right: 1px solid var(--mat-sys-outline-variant);
      width: 64px;
      transition: width var(--dm-motion-medium) var(--dm-motion-easing-emphasized);
      overflow: hidden;
      user-select: none;
    }
    .dm-rail.expanded { width: 240px; }
    .dm-rail-toggle {
      border: none; background: transparent; color: var(--mat-sys-on-surface-variant);
      padding: 12px; cursor: pointer; align-self: flex-end;
      display: flex; align-items: center; justify-content: center;
    }
    .dm-rail-toggle:hover { color: var(--mat-sys-on-surface); }
    .dm-rail-brand {
      display: flex; align-items: center; gap: .5rem;
      padding: 0 16px 12px 20px; color: var(--mat-sys-primary);
      font: 500 1rem/1.5rem Roboto; letter-spacing: .009rem;
    }
    .dm-rail-items { display: flex; flex-direction: column; gap: 2px; padding: 8px; }
    .dm-rail-item {
      display: flex; align-items: center; gap: .75rem;
      padding: 10px 12px; border-radius: 12px;
      color: var(--mat-sys-on-surface-variant);
      text-decoration: none;
      font: 500 .875rem/1.25rem Roboto;
      transition: background var(--dm-motion-short) var(--dm-motion-easing), color var(--dm-motion-short) var(--dm-motion-easing);
      white-space: nowrap;
    }
    .dm-rail-item:hover { background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface); }
    .dm-rail-item.active {
      background: color-mix(in oklch, var(--mat-sys-primary) 14%, transparent);
      color: var(--mat-sys-primary);
    }
    .dm-rail-label { flex: 1; }
  `],
})
export class NavRailComponent implements OnInit {
  protected readonly entries = ENTRIES;
  protected readonly expanded = signal(true);

  ngOnInit(): void {
    const saved = localStorage.getItem(KEY);
    if (saved !== null) this.expanded.set(saved === '1');
  }

  toggle(): void {
    this.expanded.update(v => !v);
    localStorage.setItem(KEY, this.expanded() ? '1' : '0');
  }
}
