import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, inject, signal } from '@angular/core';

type Theme = 'auto' | 'light' | 'dark';
const KEY = 'daimon.theme';

@Component({
  selector: 'dm-theme-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button class="tt-btn" type="button" (click)="open.set(!open())" aria-label="Theme" aria-haspopup="true" [attr.aria-expanded]="open()">
      <span class="material-symbols-outlined">{{ icon() }}</span>
    </button>
    @if (open()) {
      <div class="tt-pop" role="menu">
        <button type="button" role="menuitem" (click)="set('auto')">Auto</button>
        <button type="button" role="menuitem" (click)="set('light')">Light</button>
        <button type="button" role="menuitem" (click)="set('dark')">Dark</button>
      </div>
    }
  `,
  styles: [`
    :host{position:relative;display:inline-block}
    .tt-btn{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border:0;background:transparent;border-radius:999px;color:var(--dm-color-fg-muted);cursor:pointer}
    .tt-btn:hover{background:var(--dm-color-surface-3);color:var(--dm-color-fg)}
    .tt-btn .material-symbols-outlined{font-size:20px}
    .tt-pop{position:absolute;right:0;top:calc(100% + 4px);min-width:140px;background:var(--dm-color-surface-3);border:1px solid var(--dm-color-border);border-radius:10px;padding:4px;box-shadow:var(--dm-elev-2);z-index:50;display:flex;flex-direction:column;gap:1px}
    .tt-pop button{display:flex;align-items:center;padding:8px 12px;background:transparent;border:0;border-radius:6px;text-align:left;color:var(--dm-color-fg);font:500 .8125rem/1.25rem Roboto;cursor:pointer}
    .tt-pop button:hover{background:var(--dm-color-surface-4)}
  `],
})
export class ThemeToggleComponent implements OnInit {
  private readonly theme = signal<Theme>('auto');
  private readonly host = inject(ElementRef);
  readonly open = signal(false);

  icon = () => this.theme() === 'dark' ? 'dark_mode' : this.theme() === 'light' ? 'light_mode' : 'contrast';

  ngOnInit(): void {
    const t = (localStorage.getItem(KEY) as Theme | null) || 'auto';
    this.set(t, false);
  }

  set(t: Theme, close = true): void {
    this.theme.set(t);
    localStorage.setItem(KEY, t);
    const root = document.documentElement;
    if (t === 'auto') root.style.removeProperty('color-scheme');
    else root.style.setProperty('color-scheme', t);
    if (close) this.open.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (!this.open()) return;
    if (!(this.host.nativeElement as HTMLElement).contains(ev.target as Node)) this.open.set(false);
  }

  // Escape closes the theme popover and returns focus to its trigger (M89).
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.open()) return;
    this.open.set(false);
    (this.host.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.tt-btn')?.focus();
  }
}
