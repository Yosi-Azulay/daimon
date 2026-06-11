import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';
import { DaimonApi, LockSnapshot } from './daimon-api';
import { MetricsChartComponent } from './metrics-chart';
import { StatusPillComponent, EmptyStateComponent, MonoComponent, SkeletonComponent } from './ui-primitives';
import { workspaceTone } from './workspace-tone';

Chart.register(...registerables);

interface DetailError {
  message: string;
  count: number;
  parsed?: { file?: string; line?: number; col?: number; code?: string; message?: string };
}

interface BundleFile {
  path?: string;
  name?: string;
  sizeKb?: number;
  size?: number;
  kb?: number;
}

interface EnvInfo {
  active?: string | null;
  files?: string[];
  available?: string[];
  current?: string | null;
  use?: string | null;
}

@Component({
  selector: 'dm-app-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatTabsModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MetricsChartComponent,
    StatusPillComponent,
    EmptyStateComponent,
    MonoComponent,
    SkeletonComponent,
  ],
  template: `
    <div class="dm-detail">
      <header class="dm-detail-header">
        <a routerLink="/" class="dm-back" matTooltip="Back to apps">
          <span class="material-symbols-outlined">arrow_back</span>
          <span>Apps</span>
        </a>
        @if (summary(); as s) {
          <div class="dm-title-row">
            <h1 class="dm-title"><dm-mono>{{ s.name }}</dm-mono></h1>
            <dm-status-pill [status]="s.status" [health]="s.health" [eta]="etaFor(s)"></dm-status-pill>
            @if (s.workspaceLabel) {
              <span class="dm-ws-chip" [style.--dm-tone]="tone(s.workspaceLabel)">
                <span class="dm-ws-dot"></span>
                <span>{{ s.workspaceLabel }}</span>
              </span>
            }
            @if (lock(); as lk) {
              <span class="dm-lock-chip" [matTooltip]="'locked by ' + lk.agent + ' · expires in ' + lockTtl(lk)">
                🔒 <dm-mono>{{ lk.agent }}</dm-mono><span class="dm-lock-ttl">{{ lockTtl(lk) }}</span>
              </span>
            }
            @for (g of agentChips(); track g) {
              <span class="dm-agent-chip" matTooltip="recently interacted"><dm-mono>{{ g }}</dm-mono></span>
            }
          </div>
          <div class="dm-action-bar">
            @if (s.status === 'stopped' || s.status === 'error') {
              <button
                class="dm-action-btn dm-action-primary"
                [disabled]="busy('start')"
                (click)="act('start')">
                @if (busy('start')) { <mat-spinner diameter="14"></mat-spinner> }
                @else { <span class="material-symbols-outlined">play_arrow</span> }
                <span>Start</span>
              </button>
            } @else {
              <button
                class="dm-action-btn"
                [disabled]="busy('stop')"
                (click)="act('stop')">
                @if (busy('stop')) { <mat-spinner diameter="14"></mat-spinner> }
                @else { <span class="material-symbols-outlined">stop</span> }
                <span>Stop</span>
              </button>
            }
            <button
              class="dm-action-btn"
              [disabled]="busy('restart')"
              (click)="act('restart')">
              @if (busy('restart')) { <mat-spinner diameter="14"></mat-spinner> }
              @else { <span class="material-symbols-outlined">restart_alt</span> }
              <span>Restart</span>
            </button>
            <button
              class="dm-action-btn"
              [disabled]="busy('clean')"
              (click)="onClean()"
              matTooltip="Clean caches (confirms)">
              @if (busy('clean')) { <mat-spinner diameter="14"></mat-spinner> }
              @else { <span class="material-symbols-outlined">cleaning_services</span> }
              <span>Clean</span>
            </button>
            <button
              class="dm-action-btn"
              [disabled]="busy('snapshot')"
              (click)="onSnapshot()"
              matTooltip="Write a snapshot of the current state">
              @if (busy('snapshot')) { <mat-spinner diameter="14"></mat-spinner> }
              @else { <span class="material-symbols-outlined">photo_camera</span> }
              <span>Snapshot</span>
            </button>
            @if (s.url) {
              <a class="dm-action-btn" [href]="s.url" target="_blank" rel="noopener">
                <span class="material-symbols-outlined">open_in_new</span>
                <span>Open</span>
              </a>
            }
          </div>
        } @else {
          <div class="dm-title-row">
            <dm-skeleton width="220px" height="2rem"></dm-skeleton>
          </div>
        }
      </header>

      @if (summary(); as s) {
        <mat-tab-group [animationDuration]="'200ms'" class="dm-tabs">
          <mat-tab>
            <ng-template mat-tab-label>
              <span class="material-symbols-outlined dm-tab-icon">info</span>
              Overview
            </ng-template>
            <div class="dm-tab-body">
              <div class="dm-cards-row">
                <section class="dm-panel">
                  <h3 class="dm-panel-title">Runtime</h3>
                  <dl class="dm-kv">
                    <dt>Port</dt><dd><dm-mono>{{ s.port ?? '—' }}</dm-mono></dd>
                    <dt>URL</dt>
                    <dd>
                      @if (s.url) {
                        <a [href]="s.url" target="_blank" rel="noopener"><dm-mono>{{ s.url }}</dm-mono></a>
                      } @else { — }
                    </dd>
                    <dt>Uptime</dt><dd><dm-mono>{{ fmtUptime(s.uptimeMs) }}</dm-mono></dd>
                    <dt>Last compile</dt><dd><dm-mono>{{ s.lastCompileMs ?? 0 }} ms</dm-mono></dd>
                    <dt>CPU</dt><dd><dm-mono>{{ fmtPct(s.cpu) }}</dm-mono></dd>
                    <dt>Mem</dt><dd><dm-mono>{{ fmtMem(s.memMB) }}</dm-mono></dd>
                    @if (s.lastHealthError) {
                      <dt>Health</dt><dd class="dm-err-text"><dm-mono>{{ s.lastHealthError }}</dm-mono></dd>
                    }
                  </dl>
                </section>

                <section class="dm-panel dm-panel-wide">
                  <h3 class="dm-panel-title">Resources</h3>
                  <dm-metrics-chart [name]="s.name"></dm-metrics-chart>
                </section>
              </div>

              <div class="dm-cards-row">
                <section class="dm-panel">
                  <h3 class="dm-panel-title">Bundle</h3>
                  @if (bundleFiles().length) {
                    <table class="dm-bundle">
                      <thead>
                        <tr><th>file</th><th class="dm-right">size</th></tr>
                      </thead>
                      <tbody>
                        @for (f of bundleFiles(); track $index) {
                          <tr>
                            <td><dm-mono>{{ f.path || f.name }}</dm-mono></td>
                            <td class="dm-right"><dm-mono>{{ fmtKb(f.sizeKb ?? f.kb ?? toKb(f.size)) }}</dm-mono></td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else {
                    <div class="dm-dim">No bundle information.</div>
                  }
                </section>

                <section class="dm-panel">
                  <h3 class="dm-panel-title">Depends on</h3>
                  @if (dependsOn().length) {
                    <div class="dm-chips-row">
                      @for (d of dependsOn(); track d) {
                        <a class="dm-dep-chip" [routerLink]="['/apps', d]">
                          <span class="material-symbols-outlined">link</span>
                          <dm-mono>{{ d }}</dm-mono>
                        </a>
                      }
                    </div>
                  } @else {
                    <div class="dm-dim">No dependencies.</div>
                  }
                </section>
              </div>
            </div>
          </mat-tab>

          <mat-tab>
            <ng-template mat-tab-label>
              <span class="material-symbols-outlined dm-tab-icon">error</span>
              Errors
              @if (errors().length) { <span class="dm-tab-count">{{ errors().length }}</span> }
            </ng-template>
            <div class="dm-tab-body">
              @if (errorsByFile().length) {
                @for (group of errorsByFile(); track group.file) {
                  <section class="dm-panel dm-err-group">
                    <header class="dm-err-group-head">
                      <dm-mono><strong>{{ group.file }}</strong></dm-mono>
                      <span class="dm-tab-count">{{ group.items.length }}</span>
                    </header>
                    <ul class="dm-err-list">
                      @for (e of group.items; track $index) {
                        <li class="dm-err-item">
                          <div class="dm-err-meta">
                            @if (e.parsed?.line != null) {
                              <dm-mono>:{{ e.parsed?.line }}@if (e.parsed?.col != null) {<span>:{{ e.parsed?.col }}</span>}</dm-mono>
                            }
                            @if (e.parsed?.code) {
                              <span class="dm-err-code"><dm-mono>{{ e.parsed?.code }}</dm-mono></span>
                            }
                            @if (e.count > 1) {
                              <span class="dm-err-count">×{{ e.count }}</span>
                            }
                          </div>
                          <dm-mono><span class="dm-err-msg">{{ e.parsed?.message ?? e.message }}</span></dm-mono>
                        </li>
                      }
                    </ul>
                  </section>
                }
              } @else {
                <dm-empty icon="check_circle" title="No errors" hint="Nothing to fix right now."></dm-empty>
              }
            </div>
          </mat-tab>

          <mat-tab>
            <ng-template mat-tab-label>
              <span class="material-symbols-outlined dm-tab-icon">terminal</span>
              Logs
            </ng-template>
            <div class="dm-tab-body dm-tab-logs">
              <div class="dm-logs-toolbar">
                <span class="dm-dim">Live tail — last {{ logLines().length }} lines</span>
                <span class="dm-spacer"></span>
                <button class="dm-iconbtn" (click)="clearLogs()" matTooltip="Clear">
                  <span class="material-symbols-outlined">delete_sweep</span>
                </button>
                <button
                  class="dm-iconbtn"
                  [class.active]="autoScroll()"
                  (click)="autoScroll.set(!autoScroll())"
                  matTooltip="Auto-scroll">
                  <span class="material-symbols-outlined">vertical_align_bottom</span>
                </button>
              </div>
              <div #logBox class="dm-logbox" (scroll)="onLogScroll($event)">
                @for (l of logLines(); track $index) {
                  <div class="dm-logline"><dm-mono>{{ l }}</dm-mono></div>
                } @empty {
                  <div class="dm-dim" style="padding: 1rem;">Waiting for log lines…</div>
                }
              </div>
            </div>
          </mat-tab>

          <mat-tab>
            <ng-template mat-tab-label>
              <span class="material-symbols-outlined dm-tab-icon">timeline</span>
              History
            </ng-template>
            <div class="dm-tab-body">
              <section class="dm-panel">
                <h3 class="dm-panel-title">Compile times</h3>
                @if (compileTimes().length) {
                  <div class="dm-history-stats">
                    <div class="dm-stat"><span class="dm-stat-label">samples</span><span class="dm-stat-num">{{ compileTimes().length }}</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">p50</span><span class="dm-stat-num">{{ p50() }} ms</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">p95</span><span class="dm-stat-num">{{ p95() }} ms</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">max</span><span class="dm-stat-num">{{ pMax() }} ms</span></div>
                  </div>
                  <div class="dm-spark-wrap">
                    <canvas #spark></canvas>
                  </div>
                } @else {
                  <div class="dm-dim">No compile history yet.</div>
                }
              </section>
            </div>
          </mat-tab>

          <mat-tab>
            <ng-template mat-tab-label>
              <span class="material-symbols-outlined dm-tab-icon">tune</span>
              Env
            </ng-template>
            <div class="dm-tab-body">
              <section class="dm-panel">
                <h3 class="dm-panel-title">Environment file</h3>
                @if (envFiles().length) {
                  <div class="dm-radios">
                    @for (f of envFiles(); track f) {
                      <label class="dm-radio">
                        <input
                          type="radio"
                          name="env-file"
                          [value]="f"
                          [checked]="envActive() === f"
                          [disabled]="busy('env')"
                          (change)="onEnvSwitch(f)" />
                        <span class="dm-radio-mark"></span>
                        <dm-mono>{{ f }}</dm-mono>
                        @if (envActive() === f) { <span class="dm-env-active">active</span> }
                      </label>
                    }
                  </div>
                } @else {
                  <div class="dm-dim">No env files available.</div>
                }
              </section>
            </div>
          </mat-tab>
        </mat-tab-group>
      } @else {
        <div class="dm-loading">
          <dm-skeleton width="100%" height="200px"></dm-skeleton>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dm-detail { display: flex; flex-direction: column; gap: 1rem; }

    .dm-detail-header {
      display: flex; flex-direction: column; gap: .75rem;
      padding-bottom: .5rem;
    }
    .dm-back {
      display: inline-flex; align-items: center; gap: .25rem;
      width: max-content;
      color: var(--mat-sys-on-surface-variant);
      text-decoration: none;
      font: 500 .8125rem/1.25rem Roboto;
      padding: 4px 8px; border-radius: 8px;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-back:hover { background: var(--mat-sys-surface-container); color: var(--mat-sys-on-surface); }
    .dm-back .material-symbols-outlined { font-size: 18px; }

    .dm-title-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .dm-title { margin: 0; font: 400 1.625rem/2rem Roboto; }
    .dm-title .dm-mono { font-size: 1.625rem; font-weight: 500; }

    .dm-ws-chip {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 4px 10px; border-radius: 999px;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      font: 500 .75rem/1rem Roboto;
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-ws-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--dm-tone, var(--mat-sys-primary)); }

    .dm-lock-chip, .dm-agent-chip {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 2px 10px; border-radius: 999px;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      font: 500 .75rem/1rem Roboto;
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-lock-chip {
      background: color-mix(in oklch, var(--mat-sys-tertiary) 12%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-tertiary) 28%, transparent);
      color: var(--mat-sys-on-surface);
    }
    .dm-lock-chip .dm-mono, .dm-agent-chip .dm-mono { font-size: .75rem; }
    .dm-lock-ttl { font: 600 .6875rem/1rem 'Roboto Mono', ui-monospace, monospace; color: var(--mat-sys-on-surface-variant); }

    .dm-action-bar { display: flex; flex-wrap: wrap; gap: .375rem; }
    .dm-action-btn {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 6px 12px; border-radius: 10px;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface);
      font: 500 .8125rem/1.25rem Roboto;
      cursor: pointer; text-decoration: none;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-action-btn:hover:not(:disabled) { background: var(--mat-sys-surface-container-high); }
    .dm-action-btn:disabled { opacity: .55; cursor: not-allowed; }
    .dm-action-btn .material-symbols-outlined { font-size: 18px; }
    .dm-action-primary {
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
      border-color: transparent;
    }
    .dm-action-primary:hover:not(:disabled) { background: color-mix(in oklch, var(--mat-sys-primary) 88%, black); }

    .dm-tabs { background: transparent; }
    .dm-tab-icon { font-size: 18px; margin-right: .375rem; vertical-align: middle; }
    .dm-tab-count {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; padding: 0 6px; margin-left: .375rem;
      border-radius: 999px;
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface-variant);
      font: 600 .6875rem/1rem 'Roboto Mono', ui-monospace, monospace;
    }
    .dm-tab-body { padding-top: 1rem; display: flex; flex-direction: column; gap: 1rem; }

    .dm-cards-row {
      display: grid; gap: 1rem;
      grid-template-columns: minmax(260px, 1fr) minmax(0, 1.5fr);
    }
    @media (max-width: 880px) { .dm-cards-row { grid-template-columns: 1fr; } }

    .dm-panel {
      padding: 1rem 1.125rem;
      border-radius: 14px;
      background: var(--mat-sys-surface-container-low);
      border: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-panel-wide { min-width: 0; }
    .dm-panel-title {
      margin: 0 0 .5rem;
      font: 500 .8125rem/1.25rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem;
      color: var(--mat-sys-on-surface-variant);
    }

    .dm-kv {
      display: grid; grid-template-columns: max-content 1fr; gap: .25rem .75rem;
      margin: 0;
    }
    .dm-kv dt { color: var(--mat-sys-on-surface-variant); font: 400 .8125rem/1.25rem Roboto; }
    .dm-kv dd { margin: 0; color: var(--mat-sys-on-surface); }
    .dm-kv a { color: var(--mat-sys-primary); text-decoration: none; }
    .dm-kv a:hover { text-decoration: underline; }
    .dm-err-text { color: var(--mat-sys-error); }

    .dm-bundle { width: 100%; border-collapse: collapse; }
    .dm-bundle th, .dm-bundle td { text-align: left; padding: .375rem .5rem; font-size: .8125rem; }
    .dm-bundle th { font-weight: 500; color: var(--mat-sys-on-surface-variant); border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .dm-bundle tbody tr { border-bottom: 1px solid color-mix(in oklch, var(--mat-sys-outline-variant) 50%, transparent); }
    .dm-bundle tbody tr:last-child { border-bottom: 0; }
    .dm-right { text-align: right; }

    .dm-chips-row { display: flex; flex-wrap: wrap; gap: .375rem; }
    .dm-dep-chip {
      display: inline-flex; align-items: center; gap: .25rem;
      padding: 4px 10px; border-radius: 999px;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface);
      text-decoration: none;
      font: 500 .8125rem/1rem Roboto;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-dep-chip:hover { background: var(--mat-sys-surface-container-high); }
    .dm-dep-chip .material-symbols-outlined { font-size: 14px; color: var(--mat-sys-on-surface-variant); }

    .dm-err-group { padding: 0; overflow: hidden; }
    .dm-err-group-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: .625rem .875rem;
      background: var(--mat-sys-surface-container);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-err-list { list-style: none; margin: 0; padding: 0; }
    .dm-err-item {
      padding: .5rem .875rem;
      border-bottom: 1px solid color-mix(in oklch, var(--mat-sys-outline-variant) 60%, transparent);
      display: flex; flex-direction: column; gap: .25rem;
    }
    .dm-err-item:last-child { border-bottom: 0; }
    .dm-err-meta { display: flex; align-items: center; gap: .5rem; color: var(--mat-sys-on-surface-variant); font-size: .75rem; }
    .dm-err-code { color: var(--mat-sys-error); }
    .dm-err-count {
      padding: 0 6px; border-radius: 999px;
      background: color-mix(in oklch, var(--mat-sys-error) 12%, transparent);
      color: var(--mat-sys-error);
      font: 600 .6875rem/1rem 'Roboto Mono', ui-monospace, monospace;
    }
    .dm-err-msg { color: var(--mat-sys-on-surface); white-space: pre-wrap; word-break: break-word; }

    .dm-tab-logs { gap: 0; }
    .dm-logs-toolbar {
      display: flex; align-items: center; gap: .375rem;
      padding: .375rem .5rem;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      border-bottom: 0;
      border-radius: 12px 12px 0 0;
    }
    .dm-spacer { flex: 1; }
    .dm-iconbtn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 6px;
      background: transparent; border: 0;
      color: var(--mat-sys-on-surface-variant); cursor: pointer;
      transition: background var(--dm-motion-short) var(--dm-motion-easing), color var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-iconbtn:hover { background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface); }
    .dm-iconbtn.active { color: var(--mat-sys-primary); }
    .dm-iconbtn .material-symbols-outlined { font-size: 18px; }

    .dm-logbox {
      height: 480px;
      overflow: auto;
      padding: .5rem .75rem;
      background: var(--mat-sys-surface);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 0 0 12px 12px;
      font-family: var(--dm-mono);
    }
    .dm-logline { white-space: pre-wrap; word-break: break-word; padding: 1px 0; color: var(--mat-sys-on-surface); }
    .dm-logline .dm-mono { font-size: .8125rem; }

    .dm-history-stats { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: .75rem; }
    .dm-stat {
      display: flex; flex-direction: column;
      padding: .5rem .75rem; border-radius: 10px;
      background: var(--mat-sys-surface-container);
      min-width: 70px;
    }
    .dm-stat-label { font: 500 .6875rem/1rem Roboto; text-transform: uppercase; letter-spacing: .04rem; color: var(--mat-sys-on-surface-variant); }
    .dm-stat-num { font: 600 1.125rem/1.5rem 'Roboto Mono', ui-monospace, monospace; color: var(--mat-sys-on-surface); }
    .dm-spark-wrap { position: relative; height: 200px; }

    .dm-radios { display: flex; flex-direction: column; gap: .25rem; }
    .dm-radio {
      display: inline-flex; align-items: center; gap: .5rem;
      padding: .375rem .5rem; border-radius: 8px;
      cursor: pointer;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-radio:hover { background: var(--mat-sys-surface-container); }
    .dm-radio input { position: absolute; opacity: 0; pointer-events: none; }
    .dm-radio-mark {
      display: inline-block; width: 16px; height: 16px; border-radius: 999px;
      border: 2px solid var(--mat-sys-outline);
      position: relative; flex-shrink: 0;
    }
    .dm-radio input:checked + .dm-radio-mark {
      border-color: var(--mat-sys-primary);
    }
    .dm-radio input:checked + .dm-radio-mark::after {
      content: ''; position: absolute; inset: 3px;
      border-radius: 999px; background: var(--mat-sys-primary);
    }
    .dm-env-active {
      margin-left: auto;
      padding: 2px 8px; border-radius: 999px;
      font: 500 .6875rem/1rem Roboto;
      background: color-mix(in oklch, var(--mat-sys-primary) 14%, transparent);
      color: var(--mat-sys-primary);
    }

    .dm-dim { color: var(--mat-sys-on-surface-variant); font-size: .875rem; }
    .dm-loading { padding: 2rem 0; }
  `],
})
export class AppDetailComponent implements OnInit, OnDestroy, AfterViewInit {
  @Input() name = '';

  readonly api = inject(DaimonApi);
  private readonly http = inject(HttpClient);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('logBox') logBox?: ElementRef<HTMLDivElement>;
  @ViewChild('spark') sparkRef?: ElementRef<HTMLCanvasElement>;

  private readonly state = signal<any>(null);
  private readonly errs = signal<DetailError[]>([]);
  readonly logLines = signal<string[]>([]);
  readonly autoScroll = signal<boolean>(true);
  readonly compileTimes = signal<{ ts: number; ms: number }[]>([]);
  readonly envInfo = signal<EnvInfo | null>(null);
  private readonly busyMap = signal<Record<string, boolean>>({});

  private logStop?: () => void;
  private pollTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private spark?: Chart;

  readonly tone = workspaceTone;
  private readonly now = signal<number>(Date.now());

  readonly summary = computed(() => this.state());
  readonly errors = computed(() => this.errs());

  readonly lock = computed<LockSnapshot | null>(() => {
    const lk = this.api.agentLocks()[this.name];
    return lk && lk.expiresAt > this.now() ? lk : null;
  });

  readonly agentChips = computed<string[]>(() => {
    const lk = this.lock();
    return (this.api.appAgents()[this.name] ?? [])
      .filter(e => !lk || e.agent !== lk.agent)
      .map(e => e.agent);
  });

  readonly errorsByFile = computed<{ file: string; items: DetailError[] }[]>(() => {
    const groups = new Map<string, DetailError[]>();
    for (const e of this.errs()) {
      const file = e.parsed?.file ?? '(no file)';
      const list = groups.get(file) ?? [];
      list.push(e);
      groups.set(file, list);
    }
    return Array.from(groups.entries()).map(([file, items]) => ({ file, items }));
  });

  readonly bundleFiles = computed<BundleFile[]>(() => {
    const s = this.state();
    const raw: BundleFile[] = s?.bundle?.files ?? [];
    if (!Array.isArray(raw)) return [];
    const score = (f: BundleFile) => f.sizeKb ?? f.kb ?? (f.size ? f.size / 1024 : 0);
    return [...raw].sort((a, b) => (score(b) - score(a))).slice(0, 8);
  });

  readonly dependsOn = computed<string[]>(() => {
    const s = this.state();
    const d = s?.dependsOn ?? s?.depends_on ?? [];
    return Array.isArray(d) ? d : [];
  });

  readonly envFiles = computed<string[]>(() => {
    const info = this.envInfo();
    if (!info) return [];
    return info.files ?? info.available ?? [];
  });
  readonly envActive = computed<string | null>(() => {
    const info = this.envInfo();
    if (!info) return null;
    return info.active ?? info.current ?? info.use ?? null;
  });

  readonly p50 = computed(() => this.percentile(0.5));
  readonly p95 = computed(() => this.percentile(0.95));
  readonly pMax = computed(() => {
    const xs = this.compileTimes();
    if (!xs.length) return 0;
    return Math.max(...xs.map(x => x.ms));
  });

  constructor() {
    effect(() => {
      const lines = this.logLines();
      if (!this.autoScroll() || !this.logBox || lines.length === 0) return;
      queueMicrotask(() => {
        const el = this.logBox!.nativeElement;
        el.scrollTop = el.scrollHeight;
      });
    });

    effect(() => {
      const data = this.compileTimes();
      if (!this.spark || !data.length) return;
      this.updateSpark(data);
    });
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), 4000);
    this.tickTimer = setInterval(() => this.now.set(Date.now()), 1000);
    this.logStop = this.api.openLogStream(this.name, (e) => {
      const line = `${this.fmtTs(e.ts)}  ${e.line}`;
      this.logLines.update(arr => {
        const next = arr.length >= 500 ? arr.slice(arr.length - 499) : arr.slice();
        next.push(line);
        return next;
      });
    });
    void this.loadCompile();
    void this.loadEnv();
  }

  ngAfterViewInit(): void {
    if (!this.sparkRef) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduced ? false : { duration: 200 },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
        scales: {
          x: { ticks: { maxTicksLimit: 6, autoSkip: true } },
          y: { beginAtZero: true, title: { display: true, text: 'ms' } },
        },
      },
    };
    this.spark = new Chart(this.sparkRef.nativeElement, config);
    const data = this.compileTimes();
    if (data.length) this.updateSpark(data);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.logStop?.();
    this.spark?.destroy();
  }

  private async refresh(): Promise<void> {
    const [s, e] = await Promise.all([this.api.appDetail(this.name), this.api.appErrors(this.name)]);
    if (s) this.state.set(s);
    this.errs.set(Array.isArray(e) ? (e as DetailError[]) : []);
  }

  private async loadCompile(): Promise<void> {
    const r = await this.api.getCompileTimes(this.name, 100);
    this.compileTimes.set(r);
  }

  private async loadEnv(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<EnvInfo>(`/api/apps/${encodeURIComponent(this.name)}/env`),
      );
      this.envInfo.set(r ?? null);
    } catch {
      this.envInfo.set(null);
    }
  }

  lockTtl(lk: LockSnapshot): string {
    const d = Math.max(0, Math.ceil((lk.expiresAt - this.now()) / 1000));
    return d < 60 ? `${d}s` : `${Math.floor(d / 60)}m ${d % 60}s`;
  }

  etaFor(s: any): string {
    if (s?.status !== 'compiling' || s?.estimatedReadyAtMs == null) return '';
    return '~' + Math.max(0, Math.ceil((s.estimatedReadyAtMs - this.now()) / 1000)) + 's';
  }

  busy(kind: string): boolean { return !!this.busyMap()[kind]; }
  private setBusy(kind: string, v: boolean): void {
    this.busyMap.update(m => ({ ...m, [kind]: v }));
  }

  async act(kind: 'start' | 'stop' | 'restart'): Promise<void> {
    if (this.busy(kind)) return;
    this.setBusy(kind, true);
    try {
      if (kind === 'start') await this.api.startApp(this.name);
      else if (kind === 'stop') await this.api.stopApp(this.name);
      else await this.api.restartApp(this.name);
      this.snack.open(`${kind}: ok`, '', { duration: 1500 });
      await this.refresh();
    } catch (e: any) {
      this.snack.open(`${kind} failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(kind, false);
    }
  }

  async onClean(): Promise<void> {
    if (this.busy('clean')) return;
    if (!window.confirm(`Clean caches for "${this.name}"? This may remove build artifacts.`)) return;
    this.setBusy('clean', true);
    try {
      await firstValueFrom(this.http.post(`/api/apps/${encodeURIComponent(this.name)}/clean`, {}));
      this.snack.open(`Cleaned ${this.name}`, '', { duration: 2000 });
      await this.refresh();
    } catch (e: any) {
      this.snack.open(`Clean failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy('clean', false);
    }
  }

  async onSnapshot(): Promise<void> {
    if (this.busy('snapshot')) return;
    this.setBusy('snapshot', true);
    try {
      const r = await firstValueFrom(
        this.http.post<any>(`/api/apps/${encodeURIComponent(this.name)}/snapshot?write=1`, {}),
      );
      const path = r?.path ?? r?.file ?? r?.snapshot ?? '';
      this.snack.open(path ? `Snapshot: ${path}` : 'Snapshot written', 'OK', { duration: 5000 });
    } catch (e: any) {
      this.snack.open(`Snapshot failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy('snapshot', false);
    }
  }

  async onEnvSwitch(file: string): Promise<void> {
    if (this.busy('env')) return;
    this.setBusy('env', true);
    const before = this.envInfo();
    this.envInfo.update(info => info ? { ...info, active: file, current: file } : info);
    try {
      await firstValueFrom(
        this.http.post(`/api/apps/${encodeURIComponent(this.name)}/env`, { use: file }),
      );
      this.snack.open(`Env set to ${file}`, '', { duration: 2000 });
      await this.loadEnv();
    } catch (e: any) {
      this.envInfo.set(before);
      this.snack.open(`Env switch failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy('env', false);
    }
  }

  onLogScroll(ev: Event): void {
    const el = ev.target as HTMLDivElement;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    this.autoScroll.set(atBottom);
  }

  clearLogs(): void { this.logLines.set([]); }

  private updateSpark(data: { ts: number; ms: number }[]): void {
    if (!this.spark) return;
    const labels = data.map((_, i) => i + 1);
    const ms = data.map(x => x.ms);
    const p50 = this.percentile(0.5);
    const p95 = this.percentile(0.95);
    this.spark.data.labels = labels;
    this.spark.data.datasets = [
      {
        label: 'compile ms',
        data: ms,
        borderColor: 'rgb(96, 165, 250)',
        backgroundColor: 'rgba(96, 165, 250, 0.15)',
        tension: 0.25,
        pointRadius: 0,
        fill: true,
      },
      {
        label: 'p50',
        data: labels.map(() => p50),
        borderColor: 'rgba(132, 204, 22, 0.85)',
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
      },
      {
        label: 'p95',
        data: labels.map(() => p95),
        borderColor: 'rgba(251, 146, 60, 0.85)',
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
      },
    ];
    this.spark.update('none');
  }

  private percentile(p: number): number {
    const xs = this.compileTimes().map(x => x.ms).slice().sort((a, b) => a - b);
    if (!xs.length) return 0;
    const i = Math.min(xs.length - 1, Math.max(0, Math.floor(p * (xs.length - 1))));
    return Math.round(xs[i]);
  }

  fmtUptime(ms: number | null | undefined): string {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  fmtPct(v: number | null | undefined): string {
    if (v == null || isNaN(v)) return '—';
    return v.toFixed(0) + '%';
  }
  fmtMem(v: number | null | undefined): string {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1024) return (v / 1024).toFixed(1) + ' GB';
    return Math.round(v) + ' MB';
  }
  fmtKb(v: number | null | undefined): string {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1024) return (v / 1024).toFixed(2) + ' MB';
    return v.toFixed(1) + ' KB';
  }
  toKb(bytes: number | null | undefined): number | undefined {
    if (bytes == null) return undefined;
    return bytes / 1024;
  }
  fmtTs(ts: number | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  }
}
