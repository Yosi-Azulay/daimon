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
  { path: '/timeline', icon: 'view_timeline',        label: 'Timeline', shortcut: 'g i' },
  { path: '/trends',   icon: 'show_chart',           label: 'Trends',   shortcut: 'g t' },
  { path: '/tests',    icon: 'science',              label: 'Tests',    shortcut: 'g x' },
  { path: '/sessions', icon: 'radio_button_checked', label: 'Sessions', shortcut: 'g n' },
  { path: '/agents',   icon: 'badge',                label: 'Agents',   shortcut: 'g g' },
  { path: '/regressions', icon: 'trending_down',     label: 'Regressions', shortcut: 'g r' },
  { path: '/report',   icon: 'summarize',            label: 'Report',   shortcut: 'g p' },
];

const KEY = 'daimon.nav.expanded';

@Component({
  selector: 'dm-nav-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, MatIconModule, MatTooltipModule],
  template: `
    <nav class="dm-rail" [class.expanded]="expanded()" aria-label="Primary">
      <button class="dm-rail-toggle" (click)="toggle()" [attr.aria-label]="expanded() ? 'Collapse navigation' : 'Expand navigation'">
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
             [attr.aria-label]="e.label + ' · ' + e.shortcut"
             [matTooltip]="expanded() ? e.shortcut : (e.label + ' · ' + e.shortcut)"
             matTooltipPosition="right"
             [matTooltipShowDelay]="300"
             [matTooltipHideDelay]="0"
             (click)="dismissTooltip($event)">
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
      background: var(--dm-color-surface-2);
      border-right: 1px solid var(--dm-color-border);
      width: 64px;
      transition: width var(--dm-motion-medium) var(--dm-motion-easing-emphasized);
      overflow: hidden;
      user-select: none;
    }
    .dm-rail.expanded { width: 240px; }
    .dm-rail-toggle {
      border: none; background: transparent; color: var(--dm-color-fg-muted);
      padding: 12px; cursor: pointer; align-self: flex-end;
      display: flex; align-items: center; justify-content: center;
    }
    .dm-rail-toggle:hover { color: var(--dm-color-fg); }
    .dm-rail-brand {
      display: flex; align-items: center; gap: .5rem;
      padding: 0 16px 12px 20px; color: var(--dm-color-primary);
      font: 500 1rem/1.5rem Roboto; letter-spacing: .009rem;
    }
    .dm-rail-items { display: flex; flex-direction: column; gap: 2px; padding: 8px; }
    .dm-rail-item {
      display: flex; align-items: center; gap: .75rem;
      padding: 10px 12px; border-radius: 12px;
      color: var(--dm-color-fg-muted);
      text-decoration: none;
      font: 500 .875rem/1.25rem Roboto;
      transition: background var(--dm-motion-short) var(--dm-motion-easing), color var(--dm-motion-short) var(--dm-motion-easing);
      white-space: nowrap;
    }
    .dm-rail-item:hover { background: var(--dm-color-surface-3); color: var(--dm-color-fg); }
    .dm-rail-item.active {
      background: color-mix(in oklch, var(--dm-color-primary) var(--dm-badge-tint), transparent);
      color: var(--dm-color-primary);
    }
    .dm-rail-label { flex: 1; }
    /* Bottom bar under 768px (M71): horizontal, icon-only, scrollable. */
    @media (max-width: 768px) {
      .dm-rail, .dm-rail.expanded {
        width: 100%;
        flex-direction: row;
        align-items: center;
        border-right: 0;
        border-top: 1px solid var(--dm-color-border);
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
      }
      .dm-rail::-webkit-scrollbar { display: none; }
      .dm-rail-toggle, .dm-rail-brand, .dm-rail-label { display: none; }
      .dm-rail-items { flex-direction: row; gap: 2px; padding: 4px 6px; }
      .dm-rail-item { padding: 8px 10px; border-radius: var(--dm-radius-lg); }
    }
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

  dismissTooltip(ev: MouseEvent): void {
    // matTooltip can linger after a routerLink click because the trigger keeps focus.
    // Blur explicitly so the tooltip dismisses on navigation.
    const t = ev.currentTarget as HTMLElement | null;
    t?.blur();
  }
}
