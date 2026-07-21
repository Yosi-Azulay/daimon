import { inject, Injectable, EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NAV_GROUPS } from './nav-model';

@Component({
  selector: 'dm-shortcuts-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Keyboard shortcuts</h2>
    <div mat-dialog-content>
      <table class="dm-keys">
        <thead>
          <tr><th scope="col" class="dm-sr-only">Shortcut</th><th scope="col" class="dm-sr-only">Action</th></tr>
        </thead>
        <tbody>
          <tr><td><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></td><td>Command palette</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td></tr>
          <tr><td><kbd>/</kbd></td><td>Focus filter</td></tr>
        </tbody>
        <!-- Nav chords, grouped to mirror the rail (M156). Rendered from the
             same NAV_GROUPS model the rail uses, so the help can never drift
             from where a chord actually lands. -->
        @for (group of navGroups; track group.label) {
          <tbody>
            <tr class="dm-keys-group"><th scope="colgroup" colspan="2">{{ group.label }}</th></tr>
            @for (e of group.entries; track e.path) {
              <tr>
                <td>{{ chordCells(e.shortcut)[0] }} <kbd>{{ chordCells(e.shortcut)[1] }}</kbd></td>
                <td>{{ e.label }}</td>
              </tr>
            }
          </tbody>
        }
        <tbody>
          <tr class="dm-keys-group"><th scope="colgroup" colspan="2">Focused app</th></tr>
          <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>Next / prev item</td></tr>
          <tr><td><kbd>s</kbd></td><td>Start focused app</td></tr>
          <tr><td><kbd>r</kbd></td><td>Restart focused app</td></tr>
          <tr><td><kbd>x</kbd></td><td>Stop focused app</td></tr>
          <tr><td><kbd>.</kbd></td><td>Toggle list / cards</td></tr>
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    .dm-keys { width: 100%; border-collapse: collapse; }
    .dm-keys td { padding: var(--dm-space-1) var(--dm-space-2); vertical-align: middle; font: 400 var(--dm-text-sm)/var(--dm-line-normal) var(--dm-font); }
    .dm-keys td:first-child { width: 9rem; }
    .dm-keys-group th {
      text-align: left; padding: var(--dm-space-3) var(--dm-space-2) var(--dm-space-1);
      font: 600 var(--dm-text-xs)/1rem var(--dm-font);
      text-transform: uppercase; letter-spacing: .06em;
      color: var(--dm-color-fg-muted);
    }
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
export class ShortcutsHelpComponent {
  protected readonly navGroups = NAV_GROUPS;

  // Split a "g a" chord into its two key cells; the first ("g") renders as
  // plain text and the second as a <kbd>. Everything in NAV_GROUPS is a
  // two-key `g <x>` chord, but fall back gracefully for a single token.
  protected chordCells(shortcut: string): [string, string] {
    const parts = shortcut.split(' ');
    return parts.length === 2 ? [parts[0], parts[1]] : ['', parts[0]];
  }
}

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
      dialog.open(ShortcutsHelpComponent, { width: 'min(480px, 92vw)' });
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
      // `g a` → /apps since v1.12 (the apps list moved off `/`, which is now
      // the overview). `g c` stays a config alias. Every other chord is
      // unchanged from v1.11 — same key, same destination page.
      const map: Record<string, string> = { a: '/apps', e: '/errors', l: '/logs', s: '/config', d: '/doctor', v: '/events', h: '/history', t: '/trends', x: '/tests', n: '/sessions', g: '/agents', r: '/regressions', c: '/config', i: '/timeline', p: '/report', y: '/graph' };
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
