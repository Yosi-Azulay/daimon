import { ChangeDetectionStrategy, Component, inject, OnDestroy, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { NavRailComponent } from './nav-rail';
import { TopbarComponent } from './topbar';
import { CommandPaletteComponent } from './command-palette';
import { KeyboardShortcutsService } from './keyboard-shortcuts';
import { DaimonApi } from './daimon-api';

@Component({
  selector: 'dm-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, NavRailComponent, TopbarComponent, CommandPaletteComponent, MatSnackBarModule],
  template: `
    <div class="dm-shell">
      <dm-nav-rail></dm-nav-rail>
      <dm-topbar></dm-topbar>
      <main class="dm-main">
        <router-outlet />
      </main>
    </div>
    <dm-command-palette></dm-command-palette>
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    .dm-shell {
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-rows: auto 1fr;
      grid-template-areas:
        "rail topbar"
        "rail main";
      height: 100vh;
      min-height: 100vh;
    }
    .dm-main {
      grid-area: main;
      overflow-y: auto;
      padding: 1.5rem;
      background: var(--mat-sys-surface);
    }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly api = inject(DaimonApi);
  private readonly keys = inject(KeyboardShortcutsService);

  ngOnInit(): void {
    this.api.start();
    this.keys.install();
  }

  ngOnDestroy(): void {
    this.api.stop();
    this.keys.uninstall();
  }
}
