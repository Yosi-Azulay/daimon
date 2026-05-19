import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'dm-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterOutlet, MatToolbarModule, MatIconModule, MatButtonModule],
  template: `
    <mat-toolbar color="primary">
      <a routerLink="/" style="display:flex;align-items:center;gap:.5rem;color:inherit;text-decoration:none;">
        <mat-icon fontSet="material-symbols-outlined">developer_board</mat-icon>
        <span>daimon</span>
      </a>
      <span style="flex:1"></span>
      <a mat-button href="/api/overview" target="_blank">overview JSON</a>
    </mat-toolbar>
    <main style="padding: 1.5rem; max-width: 1200px; margin: 0 auto;">
      <router-outlet />
    </main>
  `,
})
export class AppComponent {}
