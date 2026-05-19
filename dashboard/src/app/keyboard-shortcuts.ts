import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'dm-shortcuts-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Keyboard shortcuts</h2>
    <div mat-dialog-content>
      <table class="dm-keys">
        <tr><td><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></td><td>Command palette</td></tr>
        <tr><td><kbd>?</kbd></td><td>This help</td></tr>
        <tr><td><kbd>/</kbd></td><td>Focus filter</td></tr>
        <tr><td><kbd>g</kbd> <kbd>a</kbd></td><td>Apps</td></tr>
        <tr><td><kbd>g</kbd> <kbd>e</kbd></td><td>Events</td></tr>
        <tr><td><kbd>g</kbd> <kbd>l</kbd></td><td>Logs</td></tr>
        <tr><td><kbd>g</kbd> <kbd>r</kbd></td><td>Errors</td></tr>
        <tr><td><kbd>g</kbd> <kbd>d</kbd></td><td>Doctor</td></tr>
        <tr><td><kbd>g</kbd> <kbd>c</kbd></td><td>Config</td></tr>
        <tr><td><kbd>g</kbd> <kbd>h</kbd></td><td>History</td></tr>
        <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>Next / prev item</td></tr>
        <tr><td><kbd>s</kbd></td><td>Start focused app</td></tr>
        <tr><td><kbd>r</kbd></td><td>Restart focused app</td></tr>
        <tr><td><kbd>x</kbd></td><td>Stop focused app</td></tr>
        <tr><td><kbd>.</kbd></td><td>Toggle list / cards</td></tr>
      </table>
    </div>
  `,
  styles: [`
    .dm-keys { width: 100%; border-collapse: collapse; }
    .dm-keys td { padding: .375rem .5rem; vertical-align: middle; }
    .dm-keys td:first-child { width: 9rem; }
    kbd {
      font-family: 'Roboto Mono', ui-monospace, monospace;
      font-size: .75rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
    }
  `],
})
export class ShortcutsHelpComponent {}

@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private pending: 'g' | null = null;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private handler = (e: KeyboardEvent) => this.onKey(e);

  install(): void { window.addEventListener('keydown', this.handler); }
  uninstall(): void { window.removeEventListener('keydown', this.handler); }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('daimon:cmdk'));
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (this.pending === 'g') {
      this.pending = null;
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      const map: Record<string, string> = { a: '/', e: '/events', l: '/logs', r: '/errors', d: '/doctor', c: '/config', h: '/history', s: '/sessions' };
      const route = map[e.key.toLowerCase()];
      if (route) { e.preventDefault(); void this.router.navigateByUrl(route); }
      return;
    }

    if (e.key === '?') { e.preventDefault(); this.dialog.open(ShortcutsHelpComponent, { width: '420px' }); return; }
    if (e.key === '/') { e.preventDefault(); window.dispatchEvent(new CustomEvent('daimon:focus-filter')); return; }
    if (e.key === 'g') { this.pending = 'g'; this.pendingTimer = setTimeout(() => (this.pending = null), 1200); return; }
    if (e.key === '.') { e.preventDefault(); window.dispatchEvent(new CustomEvent('daimon:toggle-density')); return; }

    if (['j', 'k', 's', 'r', 'x'].includes(e.key)) {
      window.dispatchEvent(new CustomEvent('daimon:key', { detail: e.key }));
    }
  }
}
