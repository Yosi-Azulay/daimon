import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { DaimonApi } from './daimon-api';

interface PanelError {
  app: string;
  file?: string | null;
  line?: number | null;
  code?: string | null;
  message: string;
  count: number;
}

@Component({
  selector: 'dm-errors-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatCardModule, MatExpansionModule, MatIconModule],
  template: `
    <mat-card>
      <mat-card-header><mat-card-title>Errors across apps</mat-card-title></mat-card-header>
      <mat-card-content>
        @if (grouped().length === 0) {
          <div style="color:var(--mat-sys-on-surface-variant);">No errors recorded across the workspace.</div>
        }
        <mat-accordion multi>
          @for (g of grouped(); track g.app) {
            <mat-expansion-panel>
              <mat-expansion-panel-header>
                <mat-panel-title>
                  <a [routerLink]="['/apps', g.app]" style="color:inherit;text-decoration:none;">{{ g.app }}</a>
                </mat-panel-title>
                <mat-panel-description>{{ g.errors.length }} errors</mat-panel-description>
              </mat-expansion-panel-header>
              @for (e of g.errors; track $index) {
                <div style="padding:.5rem 0;border-bottom:1px solid var(--mat-sys-outline-variant);">
                  @if (e.file) {
                    <a [href]="editorUrl(e.file!, e.line, null)" style="font-weight:500;text-decoration:none;color:var(--mat-sys-primary);">
                      {{ e.file }}@if (e.line) {:{{ e.line }}}
                    </a>
                    @if (e.code) { <span style="margin-left:.5rem;color:var(--mat-sys-tertiary);">{{ e.code }}</span> }
                  }
                  <div style="font-family:monospace;font-size:.875rem;">{{ e.message }}</div>
                  <div style="font-size:.75rem;color:var(--mat-sys-on-surface-variant);">×{{ e.count }}</div>
                </div>
              }
            </mat-expansion-panel>
          }
        </mat-accordion>
      </mat-card-content>
    </mat-card>
  `,
})
export class ErrorsPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(DaimonApi);
  private readonly http = inject(HttpClient);
  private timer?: ReturnType<typeof setInterval>;
  private readonly raw = signal<{ app: string; errors: PanelError[] }[]>([]);

  grouped = computed(() => this.raw().filter(g => g.errors.length));

  editorUrl(file: string, line: number | null | undefined, col: number | null): string {
    const l = line ?? 1;
    const c = col ?? 1;
    return `vscode://file/${file}:${l}:${c}`;
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private async refresh(): Promise<void> {
    try {
      const apps = this.api.apps();
      const results = await Promise.all(apps.map(async a => {
        const errs = await firstValueFrom(this.http.get<any[]>(`/api/apps/${encodeURIComponent(a.name)}/errors?format=full`));
        return {
          app: a.name,
          errors: (Array.isArray(errs) ? errs : []).map(e => ({
            app: a.name,
            file: e.parsed?.file ?? null,
            line: e.parsed?.line ?? null,
            code: e.parsed?.code ?? null,
            message: e.parsed?.message ?? e.message ?? '',
            count: e.count ?? 1,
          })) as PanelError[],
        };
      }));
      this.raw.set(results);
    } catch {}
  }
}
