import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AppRow, DaimonApi } from './daimon-api';
import { EmptyStateComponent, MonoComponent, SkeletonComponent, StatusPillComponent } from './ui-primitives';
import { workspaceTone } from './workspace-tone';

type Level = 'error' | 'warning' | 'lint';

interface RawError {
  message: string;
  count: number;
  firstSeen?: number;
  lastSeen?: number;
  // Both compact (file/line/col/code/message at top level) and full (parsed{...}) shapes flow through here.
  file?: string | null;
  line?: number | null;
  col?: number | null;
  code?: string | null;
  level?: Level;
  parsed?: { file?: string; line?: number; col?: number; code?: string; message?: string; tool?: string };
}

interface FlatError {
  app: string;
  workspaceLabel: string | null;
  file: string;
  line: number | null;
  col: number | null;
  code: string;
  message: string;
  count: number;
  tool: string;
  level: Level;
  firstSeen: number | null;
  lastSeen: number | null;
}

type Severity = 'errors' | 'warnings' | 'lint' | 'all';
type GroupBy = 'app' | 'file' | 'code' | 'tool' | 'fingerprint';

const WS_KEY = 'daimon.workspace';

const TS_CODE_DESCRIPTIONS: Record<string, string> = {
  TS2322: 'Type is not assignable to target type',
  TS2345: 'Argument type mismatch',
  TS2339: 'Property does not exist on type',
  TS18046: 'Variable is of type unknown',
  TS2304: 'Cannot find name',
  TS7006: 'Parameter implicitly has an any type',
  TS6133: 'Declared but never used',
  TS2769: 'No overload matches this call',
};

@Component({
  selector: 'dm-errors-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatExpansionModule,
    MatIconModule,
    MatTooltipModule,
    StatusPillComponent,
    SkeletonComponent,
    EmptyStateComponent,
    MonoComponent,
  ],
  template: `
    <div class="dm-page">
      <header class="dm-page-header">
        <div>
          <h1>Errors</h1>
          <div class="dm-page-sub">
            @if (loading()) {
              <dm-skeleton width="14rem" height=".875rem"></dm-skeleton>
            } @else {
              {{ totalErrors() }} {{ totalErrors() === 1 ? 'error' : 'errors' }}
              · {{ totalWarnings() }} {{ totalWarnings() === 1 ? 'warning' : 'warnings' }}
              · {{ totalLint() }} lint
              across {{ appsWithErrors() }} {{ appsWithErrors() === 1 ? 'app' : 'apps' }}
              @if (workspace()) { · workspace <dm-mono>{{ workspace() }}</dm-mono> }
            }
          </div>
        </div>
        <div class="dm-header-actions">
          <button type="button" class="ib" (click)="refresh()" [disabled]="loading()"
                  matTooltip="Refresh" aria-label="Refresh">
            <span class="material-symbols-outlined" [class.spin]="loading()">refresh</span>
          </button>
        </div>
      </header>

      <div class="dm-filterbar">
        <div class="dm-search">
          <span class="material-symbols-outlined dm-search-icon">search</span>
          <input type="search" placeholder="Filter by file, code, or message…"
                 [value]="query()" (input)="onQuery($any($event.target).value)"
                 aria-label="Filter errors" />
          @if (query()) {
            <button type="button" class="dm-search-clear" (click)="onQuery('')" aria-label="Clear">
              <span class="material-symbols-outlined">close</span>
            </button>
          }
        </div>
        <div class="dm-chips" role="tablist" aria-label="Severity filter">
          @for (f of severityFilters; track f.key) {
            <button type="button" role="tab" [attr.aria-selected]="severity() === f.key"
                    class="dm-chip" [class.active]="severity() === f.key"
                    (click)="setSeverity(f.key)">{{ f.label }}</button>
          }
        </div>
        <div class="dm-chips" role="tablist" aria-label="Group by">
          <span class="dm-chips-label">Group by</span>
          @for (g of groupOptions; track g.key) {
            <button type="button" role="tab" [attr.aria-selected]="groupBy() === g.key"
                    class="dm-chip" [class.active]="groupBy() === g.key"
                    (click)="setGroupBy(g.key)">{{ g.label }}</button>
          }
        </div>
      </div>

      @if (loading() && !raw().size) {
        <div class="dm-cards">
          @for (i of skeletonItems; track i) {
            <article class="dm-card-sk">
              <div class="dm-sk-accent"></div>
              <div class="dm-sk-body">
                <dm-skeleton width="40%" height="1.125rem"></dm-skeleton>
                <dm-skeleton width="70%" height=".875rem"></dm-skeleton>
                <dm-skeleton width="55%" height=".875rem"></dm-skeleton>
              </div>
            </article>
          }
        </div>
      } @else if (api.apps().length === 0) {
        <dm-empty icon="error" title="No apps to scan" hint="Discover some apps first">
          <div class="dm-empty-actions">
            <a routerLink="/" class="dm-link-btn">
              <span class="material-symbols-outlined">home</span>Go home
            </a>
          </div>
        </dm-empty>
      } @else if (totalErrors() === 0 && totalWarnings() === 0) {
        <dm-empty icon="check_circle"
                  [title]="'Clean — 0 errors across ' + api.apps().length + ' apps'"
                  hint="The last build was clean. Keep going."></dm-empty>
      } @else if (filteredFlat().length === 0) {
        <dm-empty icon="filter_alt_off" title="No matches"
                  hint="Try clearing the search or severity filter"></dm-empty>
      } @else {
        @if (groupBy() === 'file' && allFilesMissing()) {
          <div class="dm-hint">
            <span class="material-symbols-outlined">info</span>
            <span>None of these errors include a file path on the same line as the error. Try <button type="button" class="dm-link" (click)="setGroupBy('app')">group by app</button>.</span>
          </div>
        }
        <div class="dm-cards">
          @switch (groupBy()) {
            @case ('app') {
              @for (g of byApp(); track g.key) {
                <mat-expansion-panel class="dm-panel" expanded>
                  <mat-expansion-panel-header>
                    <mat-panel-title>
                      <div class="ac" [style.background]="tone(g.workspaceLabel)"></div>
                      <span class="ttl"><dm-mono>{{ g.key }}</dm-mono></span>
                      @if (g.app) {
                        <dm-status-pill [status]="g.app.status" [health]="g.app.health"></dm-status-pill>
                      }
                      <span class="eb">{{ g.errors.length }}</span>
                    </mat-panel-title>
                    <mat-panel-description>
                      <a class="lnk" [routerLink]="['/apps', g.key]" (click)="$event.stopPropagation()">
                        Open app<span class="material-symbols-outlined">chevron_right</span>
                      </a>
                    </mat-panel-description>
                  </mat-expansion-panel-header>
                  <div class="rows" [class.rows-nofile]="g.allMissingFile">
                    @for (e of g.errors; track $index) {
                      <div class="row" [class.is-warning]="e.level === 'warning'" [class.is-lint]="e.level === 'lint'">
                        @if (e.file) {
                          <a class="loc" [href]="editorUrl(e)" (click)="openEditor($event, e)"
                             [matTooltip]="e.file">
                            <dm-mono>{{ shortPath(e.file) }}@if (e.line) {<span class="dim">:{{ e.line }}@if (e.col) {:{{ e.col }}}</span>}</dm-mono>
                          </a>
                        } @else if (!g.allMissingFile) {
                          <span class="loc dim"><dm-mono>—</dm-mono></span>
                        }
                        @if (e.code) { <span class="code"><dm-mono>{{ e.code }}</dm-mono></span> }
                        <span class="msg" [matTooltip]="e.message">{{ e.message }}</span>
                        @if (e.count > 1) { <span class="cnt">×{{ e.count }}</span> }
                      </div>
                    }
                  </div>
                </mat-expansion-panel>
              }
            }
            @case ('file') {
              @for (g of byFile(); track g.key) {
                <mat-expansion-panel class="dm-panel" expanded>
                  <mat-expansion-panel-header>
                    <mat-panel-title>
                      <span class="ttl"><dm-mono>{{ shortPath(g.key) }}</dm-mono></span>
                      <span class="eb">{{ g.errors.length }}</span>
                    </mat-panel-title>
                  </mat-expansion-panel-header>
                  <div class="rows">
                    @for (e of g.errors; track $index) {
                      <div class="row" [class.is-warning]="e.level === 'warning'" [class.is-lint]="e.level === 'lint'">
                        <a class="loc" [routerLink]="['/apps', e.app]"
                           (click)="$event.stopPropagation()">
                          <dm-mono>{{ e.app }}</dm-mono>
                        </a>
                        @if (e.code) { <span class="code"><dm-mono>{{ e.code }}</dm-mono></span> }
                        <span class="msg" [matTooltip]="e.message">{{ e.message }}</span>
                        @if (e.line) {
                          <a class="dim ln" [href]="editorUrl(e)" (click)="openEditor($event, e)">
                            <dm-mono>:{{ e.line }}@if (e.col) {:{{ e.col }}}</dm-mono>
                          </a>
                        }
                        @if (e.count > 1) { <span class="cnt">×{{ e.count }}</span> }
                      </div>
                    }
                  </div>
                </mat-expansion-panel>
              }
            }
            @case ('code') {
              @for (g of byCode(); track g.key) {
                <mat-expansion-panel class="dm-panel" expanded>
                  <mat-expansion-panel-header>
                    <mat-panel-title>
                      <span class="ttl"><dm-mono>{{ g.key }}</dm-mono></span>
                      @if (codeHint(g.key); as h) { <span class="hint">{{ h }}</span> }
                      <span class="eb">{{ g.errors.length }}</span>
                    </mat-panel-title>
                  </mat-expansion-panel-header>
                  <div class="rows">
                    @for (e of g.errors; track $index) {
                      <div class="row" [class.is-warning]="e.level === 'warning'" [class.is-lint]="e.level === 'lint'">
                        <a class="loc" [routerLink]="['/apps', e.app]"
                           (click)="$event.stopPropagation()">
                          <dm-mono>{{ e.app }}</dm-mono>
                        </a>
                        <a class="loc" [href]="editorUrl(e)" (click)="openEditor($event, e)"
                           [matTooltip]="e.file">
                          <dm-mono>{{ shortPath(e.file) }}@if (e.line) {<span class="dim">:{{ e.line }}@if (e.col) {:{{ e.col }}}</span>}</dm-mono>
                        </a>
                        <span class="msg" [matTooltip]="e.message">{{ e.message }}</span>
                        @if (e.count > 1) { <span class="cnt">×{{ e.count }}</span> }
                      </div>
                    }
                  </div>
                </mat-expansion-panel>
              }
            }
            @case ('fingerprint') {
              @for (g of byFingerprint(); track g.key) {
                <mat-expansion-panel class="dm-panel">
                  <mat-expansion-panel-header>
                    <mat-panel-title>
                      <span class="ttl"><dm-mono>{{ g.title }}</dm-mono></span>
                      <span class="eb">×{{ g.count }}</span>
                    </mat-panel-title>
                    <mat-panel-description>
                      <span class="fp-meta">{{ g.apps.length }} {{ g.apps.length === 1 ? 'app' : 'apps' }} · first {{ fmtAgo(g.firstSeen) }} · last {{ fmtAgo(g.lastSeen) }}</span>
                    </mat-panel-description>
                  </mat-expansion-panel-header>
                  <div class="rows">
                    @for (e of g.errors; track $index) {
                      <div class="row" [class.is-warning]="e.level === 'warning'" [class.is-lint]="e.level === 'lint'">
                        <a class="loc" [routerLink]="['/apps', e.app]" (click)="$event.stopPropagation()">
                          <dm-mono>{{ e.app }}</dm-mono>
                        </a>
                        @if (e.file) {
                          <a class="loc" [href]="editorUrl(e)" (click)="openEditor($event, e)" [matTooltip]="e.file">
                            <dm-mono>{{ shortPath(e.file) }}@if (e.line) {<span class="dim">:{{ e.line }}</span>}</dm-mono>
                          </a>
                        } @else {
                          <span class="loc dim"><dm-mono>—</dm-mono></span>
                        }
                        <span class="msg" [matTooltip]="e.message">{{ e.message }}</span>
                        @if (e.count > 1) { <span class="cnt">×{{ e.count }}</span> }
                      </div>
                    }
                  </div>
                </mat-expansion-panel>
              }
            }
            @case ('tool') {
              @for (g of byTool(); track g.key) {
                <mat-expansion-panel class="dm-panel" expanded>
                  <mat-expansion-panel-header>
                    <mat-panel-title>
                      <span class="tool-chip" [attr.data-tool]="g.key">{{ g.key }}</span>
                      <span class="eb">{{ g.errors.length }}</span>
                    </mat-panel-title>
                  </mat-expansion-panel-header>
                  <div class="rows">
                    @for (e of g.errors; track $index) {
                      <div class="row" [class.is-warning]="e.level === 'warning'" [class.is-lint]="e.level === 'lint'">
                        <a class="loc" [routerLink]="['/apps', e.app]"
                           (click)="$event.stopPropagation()">
                          <dm-mono>{{ e.app }}</dm-mono>
                        </a>
                        @if (e.file) {
                          <a class="loc" [href]="editorUrl(e)" (click)="openEditor($event, e)"
                             [matTooltip]="e.file">
                            <dm-mono>{{ shortPath(e.file) }}@if (e.line) {<span class="dim">:{{ e.line }}@if (e.col) {:{{ e.col }}}</span>}</dm-mono>
                          </a>
                        } @else {
                          <span class="loc dim"><dm-mono>—</dm-mono></span>
                        }
                        @if (e.code) { <span class="code"><dm-mono>{{ e.code }}</dm-mono></span> }
                        <span class="msg" [matTooltip]="e.message">{{ e.message }}</span>
                        @if (e.count > 1) { <span class="cnt">×{{ e.count }}</span> }
                      </div>
                    }
                  </div>
                </mat-expansion-panel>
              }
            }
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host{display:block}
    .dm-page{display:flex;flex-direction:column;gap:1rem}
    .dm-page-header{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem}
    .dm-page-header h1{margin:0;font:400 1.5rem/2rem Roboto}
    .dm-page-sub{font:400 .8125rem/1.25rem Roboto;color:var(--mat-sys-on-surface-variant);margin-top:.25rem;display:flex;gap:.25rem;flex-wrap:wrap;align-items:center}
    .dm-header-actions{display:flex;gap:.5rem}
    .ib{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;background:transparent;border:1px solid var(--mat-sys-outline-variant);border-radius:10px;color:var(--mat-sys-on-surface-variant);cursor:pointer}
    .ib:hover:not(:disabled){background:var(--mat-sys-surface-container-high);color:var(--mat-sys-on-surface)}
    .ib:disabled{opacity:.55;cursor:not-allowed}
    .ib .material-symbols-outlined{font-size:20px}
    .spin{animation:dm-spin 1s linear infinite}
    @keyframes dm-spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.spin{animation:none}}
    .dm-filterbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.5rem;background:var(--mat-sys-surface);border:1px solid var(--mat-sys-outline-variant);border-radius:12px}
    .dm-search{position:relative;flex:1;min-width:220px;display:inline-flex;align-items:center;background:var(--mat-sys-surface-container);border:1px solid var(--mat-sys-outline-variant);border-radius:10px}
    .dm-search:focus-within{border-color:var(--mat-sys-primary)}
    .dm-search input{flex:1;border:0;outline:0;background:transparent;padding:8px 36px;font:400 .875rem/1.25rem Roboto;color:var(--mat-sys-on-surface)}
    .dm-search input::placeholder{color:var(--mat-sys-on-surface-variant)}
    .dm-search-icon{position:absolute;left:10px;pointer-events:none;font-size:18px;color:var(--mat-sys-on-surface-variant)}
    .dm-search-clear{position:absolute;right:6px;background:transparent;border:0;cursor:pointer;color:var(--mat-sys-on-surface-variant);width:24px;height:24px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center}
    .dm-search-clear:hover{background:var(--mat-sys-surface-container-high)}
    .dm-search-clear .material-symbols-outlined{font-size:16px}
    .dm-chips{display:inline-flex;align-items:center;padding:2px;border-radius:10px;background:var(--mat-sys-surface-container);border:1px solid var(--mat-sys-outline-variant);gap:2px}
    .dm-chips-label{font:500 .6875rem/1rem Roboto;text-transform:uppercase;letter-spacing:.04rem;color:var(--mat-sys-on-surface-variant);padding:0 .5rem 0 .25rem}
    .dm-chip{display:inline-flex;align-items:center;gap:.375rem;padding:5px 10px;border-radius:8px;background:transparent;border:0;color:var(--mat-sys-on-surface-variant);cursor:pointer;font:500 .8125rem/1rem Roboto}
    .dm-chip:hover{color:var(--mat-sys-on-surface)}
    .dm-chip.active{background:var(--mat-sys-surface);color:var(--mat-sys-primary);box-shadow:var(--mat-sys-level1)}
    .dm-cards{display:flex;flex-direction:column;gap:.75rem}
    .dm-hint{display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;border-radius:10px;background:color-mix(in oklch,var(--mat-sys-tertiary) 10%,transparent);border:1px solid color-mix(in oklch,var(--mat-sys-tertiary) 24%,transparent);color:var(--mat-sys-on-surface);font:400 .8125rem/1.25rem Roboto}
    .dm-hint .material-symbols-outlined{font-size:18px;color:var(--mat-sys-tertiary)}
    .dm-hint .dm-link{background:transparent;border:0;padding:0;color:var(--mat-sys-primary);cursor:pointer;font:500 .8125rem/1.25rem Roboto;text-decoration:underline}
    .dm-panel{background:var(--mat-sys-surface-container-low)!important;border:1px solid var(--mat-sys-outline-variant);border-radius:14px!important;overflow:hidden;box-shadow:none!important}
    .dm-panel.mat-expanded{box-shadow:var(--mat-sys-level1)!important}
    ::ng-deep .dm-panel .mat-expansion-panel-header{padding:0 1rem;height:56px;background:var(--mat-sys-surface-container-low)}
    ::ng-deep .dm-panel .mat-expansion-panel-header:hover{background:var(--mat-sys-surface-container)!important}
    ::ng-deep .dm-panel .mat-expansion-panel-body{padding:0 1rem 1rem}
    ::ng-deep .dm-panel .mat-expansion-panel-content{background:var(--mat-sys-surface-container-low)}
    .ac{width:4px;height:24px;border-radius:2px;margin-right:.5rem}
    .ttl{font:500 .9375rem/1.25rem Roboto;display:inline-flex;align-items:center;gap:.5rem}
    .hint{font:400 .75rem/1rem Roboto;color:var(--mat-sys-on-surface-variant);margin-left:.5rem}
    .fp-meta{font:400 .75rem/1rem Roboto;color:var(--mat-sys-on-surface-variant);white-space:nowrap}
    mat-panel-title{display:flex;align-items:center;gap:.5rem;flex:1;min-width:0}
    mat-panel-description{justify-content:flex-end;color:var(--mat-sys-on-surface-variant)}
    .eb{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font:600 .75rem/1rem Roboto;background:color-mix(in oklch,var(--mat-sys-error) var(--dm-badge-tint),transparent);color:var(--mat-sys-error);border:1px solid color-mix(in oklch,var(--mat-sys-error) 30%,transparent);margin-left:.25rem}
    .lnk{display:inline-flex;align-items:center;gap:.125rem;color:var(--mat-sys-primary);text-decoration:none;font:500 .8125rem/1.25rem Roboto}
    .lnk:hover{text-decoration:underline}
    .lnk .material-symbols-outlined{font-size:16px}
    .rows{display:flex;flex-direction:column}
    .row{display:grid;grid-template-columns:minmax(0,1.4fr) auto minmax(0,2fr) auto;align-items:center;gap:.75rem;padding:.5rem .25rem;border-bottom:1px solid var(--mat-sys-outline-variant);border-left:3px solid transparent;padding-left:.5rem}
    .row.is-warning{border-left-color:color-mix(in oklch,var(--mat-sys-tertiary) 70%,transparent);background:color-mix(in oklch,var(--mat-sys-tertiary) 4%,transparent)}
    .row.is-warning .code{background:color-mix(in oklch,var(--mat-sys-tertiary) var(--dm-badge-tint),transparent);color:var(--mat-sys-tertiary)}
    .row.is-lint{border-left-color:color-mix(in oklch,var(--mat-sys-secondary) 70%,transparent);background:color-mix(in oklch,var(--mat-sys-secondary) 4%,transparent)}
    .row.is-lint .code{background:color-mix(in oklch,var(--mat-sys-secondary) var(--dm-badge-tint),transparent);color:var(--mat-sys-secondary)}
    .rows-nofile .row{grid-template-columns:auto minmax(0,1fr) auto}
    .row:last-child{border-bottom:0}
    .row:hover{background:var(--mat-sys-surface-container)}
    .loc{color:var(--mat-sys-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .loc:hover{text-decoration:underline}
    .dim{color:var(--mat-sys-on-surface-variant)}
    .ln{justify-self:end}
    .code{display:inline-flex;align-items:center;padding:1px 8px;border-radius:6px;background:color-mix(in oklch,var(--mat-sys-tertiary) var(--dm-badge-tint),transparent);color:var(--mat-sys-tertiary);border:1px solid color-mix(in oklch,var(--mat-sys-tertiary) 28%,transparent);font-weight:500}
    .tool-chip{display:inline-flex;align-items:center;padding:2px 10px;border-radius:6px;background:var(--mat-sys-surface-container-high);color:var(--mat-sys-on-surface);border:1px solid var(--mat-sys-outline-variant);font:600 .8125rem/1.125rem Roboto;text-transform:lowercase;letter-spacing:.02rem}
    .tool-chip[data-tool="esbuild"],.tool-chip[data-tool="vite"]{color:var(--mat-sys-primary);border-color:color-mix(in oklch,var(--mat-sys-primary) 36%,transparent)}
    .tool-chip[data-tool="jest"],.tool-chip[data-tool="nx"]{color:var(--mat-sys-secondary);border-color:color-mix(in oklch,var(--mat-sys-secondary) 36%,transparent)}
    .tool-chip[data-tool="storybook"],.tool-chip[data-tool="webpack"]{color:var(--mat-sys-tertiary);border-color:color-mix(in oklch,var(--mat-sys-tertiary) 36%,transparent)}
    .tool-chip[data-tool="node"],.tool-chip[data-tool="typescript"]{color:var(--mat-sys-on-surface-variant)}
    .msg{color:var(--mat-sys-on-surface);font-size:.875rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .cnt{color:var(--mat-sys-on-surface-variant);font:500 .75rem/1rem Roboto;justify-self:end}
    .dm-card-sk{background:var(--mat-sys-surface-container-low);border:1px solid var(--mat-sys-outline-variant);border-radius:14px;overflow:hidden}
    .dm-sk-accent{height:4px;background:var(--mat-sys-surface-container)}
    .dm-sk-body{padding:1rem;display:flex;flex-direction:column;gap:.5rem}
    .dm-empty-actions{margin-top:.75rem}
    .dm-link-btn{display:inline-flex;align-items:center;gap:.375rem;padding:6px 14px;border-radius:10px;background:var(--mat-sys-primary);color:var(--mat-sys-on-primary);text-decoration:none;font:500 .875rem/1.25rem Roboto}
    .dm-link-btn .material-symbols-outlined{font-size:18px}
    @media (max-width:760px){.row{grid-template-columns:1fr;gap:.25rem}.ln{justify-self:start}.cnt{justify-self:start}}
  `],
})
export class ErrorsPanelComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly raw = signal<Map<string, RawError[]>>(new Map());
  readonly loading = signal<boolean>(false);
  readonly query = signal<string>('');
  readonly severity = signal<Severity>('errors');
  readonly groupBy = signal<GroupBy>('app');
  readonly workspace = signal<string | null>(null);

  readonly skeletonItems = [0, 1, 2];
  readonly totalLint = computed(() => this.flat().reduce((acc, e) => acc + (e.level === 'lint' ? e.count : 0), 0));
  readonly severityFilters: { key: Severity; label: string }[] = [
    { key: 'errors', label: 'errors' },
    { key: 'warnings', label: 'warnings' },
    { key: 'lint', label: 'lint' },
    { key: 'all', label: 'all' },
  ];
  readonly groupOptions: { key: GroupBy; label: string }[] = [
    { key: 'app', label: 'app' },
    { key: 'file', label: 'file' },
    { key: 'code', label: 'code' },
    { key: 'tool', label: 'tool' },
    { key: 'fingerprint', label: 'fingerprint' },
  ];
  readonly tone = workspaceTone;

  private readonly appsByName = computed<Map<string, AppRow>>(() => {
    const m = new Map<string, AppRow>();
    for (const a of this.api.apps()) m.set(a.name, a);
    return m;
  });

  readonly flat = computed<FlatError[]>(() => {
    const out: FlatError[] = [];
    const apps = this.appsByName();
    for (const [name, errs] of this.raw()) {
      const app = apps.get(name);
      for (const e of errs) {
        // Server compact-format puts file/line/col/code at top level; full-format nests under parsed{}.
        const file = e.parsed?.file ?? e.file ?? '';
        const line = e.parsed?.line ?? e.line ?? null;
        const col = e.parsed?.col ?? e.col ?? null;
        const code = e.parsed?.code ?? e.code ?? '';
        out.push({
          app: name,
          workspaceLabel: app?.workspaceLabel ?? null,
          file: file ?? '',
          line: line ?? null,
          col: col ?? null,
          code: code ?? '',
          message: e.parsed?.message ?? e.message ?? '',
          count: e.count ?? 1,
          tool: e.parsed?.tool ?? '',
          level: e.level ?? 'error',
          firstSeen: e.firstSeen ?? null,
          lastSeen: e.lastSeen ?? null,
        });
      }
    }
    return out;
  });

  readonly totalErrors = computed(() => this.flat().reduce((acc, e) => acc + (e.level === 'error' ? e.count : 0), 0));
  readonly totalWarnings = computed(() => this.flat().reduce((acc, e) => acc + (e.level === 'warning' ? e.count : 0), 0));
  readonly appsWithErrors = computed(() => {
    const s = new Set<string>();
    for (const e of this.flat()) if (e.level === 'error') s.add(e.app);
    return s.size;
  });

  readonly filteredFlat = computed<FlatError[]>(() => {
    const q = this.query().trim().toLowerCase();
    const sev = this.severity();
    // Lint findings live in a separate severity tab. The default 'errors' tab
    // hides them entirely so they don't drown the headline metric.
    const ws = this.workspace();
    return this.flat().filter(e => {
      if (ws && e.workspaceLabel !== ws) return false;
      if (sev === 'errors' && e.level !== 'error') return false;
      if (sev === 'warnings' && e.level !== 'warning') return false;
      if (sev === 'lint' && e.level !== 'lint') return false;
      if (q) {
        const hay = `${e.file} ${e.code} ${e.message}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  readonly byApp = computed(() => {
    const groups = new Map<string, FlatError[]>();
    for (const e of this.filteredFlat()) {
      const arr = groups.get(e.app);
      if (arr) arr.push(e);
      else groups.set(e.app, [e]);
    }
    const apps = this.appsByName();
    return Array.from(groups.entries())
      .map(([key, errors]) => ({
        key,
        app: apps.get(key) ?? null,
        workspaceLabel: apps.get(key)?.workspaceLabel ?? null,
        errors,
        allMissingFile: errors.every(e => !e.file),
      }))
      .sort((a, b) => b.errors.length - a.errors.length);
  });

  // Fingerprint grouping (M72): same source location (file:line[:code]) —
  // or, unparsed, the same number-normalized message — folds into one group
  // with total count, first/last-seen and the affected apps. Mirrors the
  // server's GET /api/errors?group=fingerprint semantics.
  readonly byFingerprint = computed(() => {
    const groups = new Map<string, { key: string; title: string; message: string; errors: FlatError[]; count: number; apps: string[]; firstSeen: number | null; lastSeen: number | null }>();
    for (const e of this.filteredFlat()) {
      const key = e.file && e.line != null
        ? `${e.file}:${e.line}${e.code ? ':' + e.code : ''}`
        : 'msg:' + e.message.replace(/0x[0-9a-fA-F]+/g, '#').replace(/\d+/g, '#').trim().toLowerCase();
      let g = groups.get(key);
      if (!g) {
        g = { key, title: e.file && e.line != null ? `${this.shortPath(e.file)}:${e.line}${e.code ? ' ' + e.code : ''}` : e.message, message: e.message, errors: [], count: 0, apps: [], firstSeen: e.firstSeen, lastSeen: e.lastSeen };
        groups.set(key, g);
      }
      g.errors.push(e);
      g.count += e.count;
      if (!g.apps.includes(e.app)) g.apps.push(e.app);
      if (e.firstSeen != null && (g.firstSeen == null || e.firstSeen < g.firstSeen)) g.firstSeen = e.firstSeen;
      if (e.lastSeen != null && (g.lastSeen == null || e.lastSeen > g.lastSeen)) g.lastSeen = e.lastSeen;
    }
    return Array.from(groups.values()).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  });

  fmtAgo(ts: number | null): string {
    if (!ts) return '—';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  readonly byFile = computed(() => {
    const groups = new Map<string, FlatError[]>();
    for (const e of this.filteredFlat()) {
      const k = e.file || '(no file detected)';
      const arr = groups.get(k);
      if (arr) arr.push(e);
      else groups.set(k, [e]);
    }
    return Array.from(groups.entries())
      .map(([key, errors]) => ({ key, errors }))
      .sort((a, b) => b.errors.length - a.errors.length);
  });

  readonly allFilesMissing = computed(() => {
    const fs = this.filteredFlat();
    if (!fs.length) return false;
    return fs.every(e => !e.file);
  });

  readonly byCode = computed(() => {
    const groups = new Map<string, FlatError[]>();
    for (const e of this.filteredFlat()) {
      const k = e.code || '(no-code)';
      const arr = groups.get(k);
      if (arr) arr.push(e);
      else groups.set(k, [e]);
    }
    return Array.from(groups.entries())
      .map(([key, errors]) => ({ key, errors }))
      .sort((a, b) => b.errors.length - a.errors.length);
  });

  readonly byTool = computed(() => {
    const groups = new Map<string, FlatError[]>();
    for (const e of this.filteredFlat()) {
      const k = e.tool || '(unknown)';
      const arr = groups.get(k);
      if (arr) arr.push(e);
      else groups.set(k, [e]);
    }
    return Array.from(groups.entries())
      .map(([key, errors]) => ({ key, errors }))
      .sort((a, b) => b.errors.length - a.errors.length);
  });

  // Membership-keyed via computed: only emits when the app set actually changes (add/remove).
  private readonly appsKey = computed(() => this.api.apps().map(a => a.name).sort().join('|'));
  private lastEventCount = 0;
  // Plain in-flight flag (NOT a signal): keeps the fetchAll guard out of any effect's dependency graph.
  // If we read `loading()` here, writing `loading.set(true/false)` inside fetchAll would re-fire the
  // effect that called it, causing an infinite loop.
  private busy = false;

  constructor() {
    this.workspace.set(localStorage.getItem(WS_KEY));
    const onWs = (e: Event) => this.workspace.set(((e as CustomEvent).detail as string | null) ?? null);
    window.addEventListener('daimon:workspace', onWs);
    this.destroyRef.onDestroy(() => window.removeEventListener('daimon:workspace', onWs));

    // Membership change → refetch (e.g. discovered app appears/disappears).
    effect(() => {
      const key = this.appsKey();
      if (key) void this.fetchAll();
    });

    // Push-driven: refetch only when an error or status event arrives on the SSE stream.
    // Drops the v0.8.0 polling storm (one fetch per app per signal tick) to one fetch per real change.
    effect(() => {
      const evs = this.api.events();
      const tail = evs.slice(this.lastEventCount);
      this.lastEventCount = evs.length;
      if (tail.some(e => e.type === 'error-new' || e.type === 'error-recur' || e.type === 'warning-new' || e.type === 'warning-recur' || e.type === 'lint-new' || e.type === 'lint-recur' || e.type === 'status')) {
        void this.fetchAll();
      }
    });
  }

  async ngOnInit(): Promise<void> {
    if (this.api.apps().length === 0 && !this.api.ready()) {
      await this.api.refresh();
    } else {
      await this.fetchAll();
    }
  }

  ngOnDestroy(): void {}

  @HostListener('window:storage', ['$event'])
  onStorage(ev: StorageEvent): void {
    if (ev.key === WS_KEY) this.workspace.set(ev.newValue);
  }

  refresh(): void { void this.fetchAll(); }

  onQuery(q: string): void { this.query.set(q); }
  setSeverity(s: Severity): void { this.severity.set(s); }
  setGroupBy(g: GroupBy): void { this.groupBy.set(g); }

  codeHint(code: string): string {
    return TS_CODE_DESCRIPTIONS[code] ?? '';
  }

  // Truncate to last two path segments for display while keeping full path in tooltip.
  shortPath(file: string): string {
    if (!file) return '—';
    const parts = file.split(/[\\/]/);
    if (parts.length <= 3) return file;
    return '…/' + parts.slice(-2).join('/');
  }

  editorUrl(e: FlatError): string {
    if (!e.file) return '#';
    const l = e.line ?? 1;
    const c = e.col ?? 1;
    return `vscode://file/${e.file}:${l}:${c}`;
  }

  openEditor(ev: MouseEvent, e: FlatError): void {
    if (!e.file) { ev.preventDefault(); return; }
    ev.preventDefault();
    window.open(this.editorUrl(e), '_self');
  }

  private async fetchAll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.loading.set(true);
    try {
      const apps = this.api.apps();
      const pairs = await Promise.all(
        apps.map(async a => [a.name, await this.api.appErrors(a.name)] as const),
      );
      const next = new Map<string, RawError[]>();
      for (const [name, errs] of pairs) next.set(name, errs as RawError[]);
      this.raw.set(next);
    } finally {
      this.busy = false;
      this.loading.set(false);
    }
  }
}
