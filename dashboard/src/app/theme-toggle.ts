import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

type Theme = 'auto' | 'light' | 'dark';
const KEY = 'daimon.theme';

@Component({
  selector: 'dm-theme-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule],
  template: `
    <button mat-icon-button [matMenuTriggerFor]="menu" aria-label="Theme">
      <mat-icon fontSet="material-symbols-outlined">{{ icon() }}</mat-icon>
    </button>
    <mat-menu #menu>
      <button mat-menu-item (click)="set('auto')">Auto</button>
      <button mat-menu-item (click)="set('light')">Light</button>
      <button mat-menu-item (click)="set('dark')">Dark</button>
    </mat-menu>
  `,
})
export class ThemeToggleComponent implements OnInit {
  private readonly theme = signal<Theme>('auto');

  icon = () => this.theme() === 'dark' ? 'dark_mode' : this.theme() === 'light' ? 'light_mode' : 'contrast';

  ngOnInit(): void {
    const t = (localStorage.getItem(KEY) as Theme | null) || 'auto';
    this.set(t);
  }

  set(t: Theme): void {
    this.theme.set(t);
    localStorage.setItem(KEY, t);
    const root = document.documentElement;
    if (t === 'auto') root.style.removeProperty('color-scheme');
    else root.style.setProperty('color-scheme', t);
  }
}
