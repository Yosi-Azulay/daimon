import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NAV_GROUPS } from './nav-model';

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
      <a class="dm-rail-brand" routerLink="/" aria-label="daimon overview" matTooltip="Overview" matTooltipPosition="right" [matTooltipDisabled]="expanded()">
        <mat-icon fontSet="material-symbols-outlined">developer_board</mat-icon>
        @if (expanded()) { <span>daimon</span> }
      </a>
      <div class="dm-rail-items">
        @for (group of groups; track group.label) {
          <div class="dm-rail-group" role="group" [attr.aria-label]="group.label">
            @if (expanded()) {
              <div class="dm-rail-group-label" aria-hidden="true">{{ group.label }}</div>
            }
            @for (e of group.entries; track e.path) {
              <a class="dm-rail-item"
                 [routerLink]="e.path"
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
      text-decoration: none;
    }
    .dm-rail-brand:hover { color: var(--dm-color-primary); }
    .dm-rail-items { display: flex; flex-direction: column; gap: 2px; padding: 8px; overflow-y: auto; }
    .dm-rail-group { display: flex; flex-direction: column; gap: 2px; }
    .dm-rail-group + .dm-rail-group { margin-top: 10px; }
    .dm-rail-group-label {
      padding: 8px 12px 4px; font: 600 var(--dm-text-xs, .6875rem)/1rem Roboto;
      text-transform: uppercase; letter-spacing: .06em;
      color: var(--dm-color-fg-muted);
    }
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
    /* Bottom bar under 768px (M71): horizontal, icon-only, scrollable. Group
       headers and dividers collapse away — the rail is one flat icon strip,
       group boundaries marked by a thin divider so grouping is still legible. */
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
      .dm-rail-toggle, .dm-rail-brand, .dm-rail-label, .dm-rail-group-label { display: none; }
      .dm-rail-items { flex-direction: row; gap: 2px; padding: 4px 6px; overflow: visible; }
      .dm-rail-group { flex-direction: row; gap: 2px; }
      .dm-rail-group + .dm-rail-group { margin-top: 0; margin-left: 6px; padding-left: 6px; border-left: 1px solid var(--dm-color-border); }
      .dm-rail-item { padding: 8px 10px; border-radius: var(--dm-radius-lg); }
    }
  `],
})
export class NavRailComponent implements OnInit {
  protected readonly groups = NAV_GROUPS;
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
