import { inject, Injectable, EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
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
        <tr><td><kbd>g</kbd> <kbd>e</kbd></td><td>Errors</td></tr>
        <tr><td><kbd>g</kbd> <kbd>l</kbd></td><td>Logs</td></tr>
        <tr><td><kbd>g</kbd> <kbd>s</kbd></td><td>Settings</td></tr>
        <tr><td><kbd>g</kbd> <kbd>d</kbd></td><td>Doctor</td></tr>
        <tr><td><kbd>g</kbd> <kbd>v</kbd></td><td>Events</td></tr>
        <tr><td><kbd>g</kbd> <kbd>h</kbd></td><td>History</td></tr>
        <tr><td><kbd>g</kbd> <kbd>t</kbd></td><td>Trends</td></tr>
        <tr><td><kbd>g</kbd> <kbd>x</kbd></td><td>Tests</td></tr>
        <tr><td><kbd>g</kbd> <kbd>n</kbd></td><td>Sessions</td></tr>
        <tr><td><kbd>g</kbd> <kbd>g</kbd></td><td>Agents</td></tr>
        <tr><td><kbd>g</kbd> <kbd>r</kbd></td><td>Regressions</td></tr>
        <tr><td><kbd>g</kbd> <kbd>i</kbd></td><td>Timeline</td></tr>
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
    .dm-keys td { padding: var(--dm-space-1) var(--dm-space-2); vertical-align: middle; font: 400 var(--dm-text-sm)/var(--dm-line-normal) var(--dm-font); }
    .dm-keys td:first-child { width: 9rem; }
    kbd {
      font-family: var(--dm-mono);
      font-size: var(--dm-text-xs);
      padding: 2px 6px;
      border-radius: var(--dm-radius-xs);
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
    }
  `],
})
export class ShortcutsHelpComponent {}

@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  private readonly router = inject(Router);
  private readonly envInjector = inject(EnvironmentInjector);
  private pending: 'g' | null = null;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private handler = (e: KeyboardEvent) => this.onKey(e);

  private async openShortcutsDialog(): Promise<void> {
    const { MatDialog } = await import('@angular/material/dialog');
    runInInjectionContext(this.envInjector, () => {
      const dialog = inject(MatDialog);
      dialog.open(ShortcutsHelpComponent, { width: 'min(420px, 92vw)' });
    });
  }

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
      const map: Record<string, string> = { a: '/', e: '/errors', l: '/logs', s: '/config', d: '/doctor', v: '/events', h: '/history', t: '/trends', x: '/tests', n: '/sessions', g: '/agents', r: '/regressions', c: '/config', i: '/timeline' };
      const route = map[e.key.toLowerCase()];
      if (route) { e.preventDefault(); void this.router.navigateByUrl(route); }
      return;
    }

    if (e.key === '?') { e.preventDefault(); void this.openShortcutsDialog(); return; }
    if (e.key === '/') { e.preventDefault(); window.dispatchEvent(new CustomEvent('daimon:focus-filter')); return; }
    if (e.key === 'g') { this.pending = 'g'; this.pendingTimer = setTimeout(() => (this.pending = null), 1200); return; }
    if (e.key === '.') { e.preventDefault(); window.dispatchEvent(new CustomEvent('daimon:toggle-density')); return; }

    if (['j', 'k', 's', 'r', 'x'].includes(e.key)) {
      window.dispatchEvent(new CustomEvent('daimon:key', { detail: e.key }));
    }
  }
}
