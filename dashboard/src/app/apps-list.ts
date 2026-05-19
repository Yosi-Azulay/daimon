import { ChangeDetectionStrategy, Component, inject, OnDestroy, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { DaimonApi, statusBadge } from './daimon-api';

@Component({
  selector: 'dm-apps-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatCardModule, MatChipsModule, MatIconModule, MatButtonModule, MatProgressBarModule],
  template: `
    @if (api.overview(); as ov) {
      <mat-card style="margin-bottom:1rem;">
        <mat-card-header>
          <mat-card-title>Workspace overview</mat-card-title>
          <mat-card-subtitle>
            {{ ov.totals.apps }} apps · {{ ov.totals.serving }} serving · {{ ov.totals.errors }} errored · {{ ov.totals.stopped }} stopped
          </mat-card-subtitle>
        </mat-card-header>
        @if (ov.needsAttention.length) {
          <mat-card-content>
            <div style="font-weight:500;margin-bottom:.25rem;">Needs attention</div>
            @for (n of ov.needsAttention; track n.name) {
              <a [routerLink]="['/apps', n.name]" style="display:block;text-decoration:none;color:inherit;padding:.25rem 0;">
                <strong>{{ n.name }}</strong> — {{ n.errCount }} errors
                @if (n.firstError) {
                  <span style="color:var(--mat-sys-error)"> · {{ n.firstError.file }}:{{ n.firstError.line }} {{ n.firstError.code }}</span>
                }
              </a>
            }
          </mat-card-content>
        }
      </mat-card>
    }
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;">
      @for (a of api.apps(); track a.name) {
        @let badge = makeBadge(a);
        <mat-card>
          <mat-card-header>
            <mat-card-title>
              <a [routerLink]="['/apps', a.name]" style="color:inherit;text-decoration:none;">{{ a.name }}</a>
            </mat-card-title>
            <mat-card-subtitle>
              <mat-chip style="background:transparent;border:1px solid var(--mat-sys-outline-variant);">
                <span [style.color]="badge.color">●</span>&nbsp;{{ badge.label }}
              </mat-chip>
              @if (a.workspaceLabel) { <span style="margin-left:.5rem;color:var(--mat-sys-on-surface-variant);">{{ a.workspaceLabel }}</span> }
            </mat-card-subtitle>
          </mat-card-header>
          <mat-card-content>
            <div style="font-size:.875rem;color:var(--mat-sys-on-surface-variant);">
              {{ a.port ? 'port ' + a.port : 'no port' }} · {{ a.errorCount }} errs · cpu {{ a.cpu ?? 0 }}% · mem {{ a.memMB ?? 0 }} MB
            </div>
          </mat-card-content>
          <mat-card-actions>
            <button mat-button (click)="api.start(a.name)" [disabled]="a.status === 'serving' || a.status === 'starting'">start</button>
            <button mat-button (click)="api.stop(a.name)" [disabled]="a.status === 'stopped'">stop</button>
            <button mat-button (click)="api.restart(a.name)">restart</button>
            @if (a.url) { <a mat-button [href]="a.url" target="_blank">open</a> }
          </mat-card-actions>
        </mat-card>
      } @empty {
        <mat-card>
          <mat-card-header><mat-card-title>No apps yet</mat-card-title></mat-card-header>
          <mat-card-content>Run <code>daimon init --auto</code> in a workspace, then refresh.</mat-card-content>
        </mat-card>
      }
    </div>
  `,
})
export class AppsListComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private stop?: () => void;
  private timer?: ReturnType<typeof setInterval>;

  makeBadge = statusBadge;

  async ngOnInit(): Promise<void> {
    await this.api.refresh();
    this.timer = setInterval(() => void this.api.refresh(), 2000);
    this.stop = this.api.startEventStream(() => void this.api.refresh());
  }
  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stop?.();
  }
}
