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
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';
import { AppWhy, DaimonApi, LockSnapshot } from './daimon-api';
import type { TestRun } from './tests-page-helpers';
import { MetricsChartComponent } from './metrics-chart';
import { StatusPillComponent, EmptyStateComponent, MonoComponent, SkeletonComponent } from './ui-primitives';
import { workspaceTone } from './workspace-tone';
import { groupsForApp } from './groups-helpers';
import { hasResourceNote } from './app-detail-helpers';

Chart.register(...registerables);

// Canvas can't consume CSS custom properties directly — read the resolved
// (theme-aware) token value at chart-build time. Same pattern trends-page.ts
// and metrics-chart.ts use.
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

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
        <a routerLink="/apps" class="dm-back" matTooltip="Back to apps">
          <span class="material-symbols-outlined">arrow_back</span>
          <span>Apps</span>
        </a>
        @if (summary(); as s) {
          <div class="dm-title-row">
            <h1 class="dm-title"><dm-mono>{{ s.name }}</dm-mono></h1>
            <dm-status-pill [status]="s.status" [health]="s.health" [eta]="etaFor(s)"></dm-status-pill>
            @if (s.muted) {
              <span class="dm-mute-chip" [matTooltip]="s.muteUntil ? ('muted until ' + fmtMuteUntil(s.muteUntil)) : 'muted indefinitely'">
                <span class="material-symbols-outlined">notifications_off</span>
                <span>muted</span>
              </span>
            }
            @if (s.workspaceLabel) {
              <span class="dm-ws-chip" [style.--dm-tone]="tone(s.workspaceLabel)">
                <span class="dm-ws-dot"></span>
                <span>{{ s.workspaceLabel }}</span>
              </span>
            }
            @if (appGroups().length) {
              @for (g of appGroups(); track g) {
                <a class="dm-group-chip" [routerLink]="['/apps']" [queryParams]="{ group: g }" [matTooltip]="'filter apps by ' + g">
                  <span class="material-symbols-outlined">workspaces</span>
                  <span>{{ g }}</span>
                </a>
              }
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
            @if (s.muted) {
              <button
                class="dm-action-btn"
                [disabled]="busy('mute')"
                (click)="onUnmute()"
                matTooltip="Lift notification mute">
                @if (busy('mute')) { <mat-spinner diameter="14"></mat-spinner> }
                @else { <span class="material-symbols-outlined">notifications_active</span> }
                <span>Unmute</span>
              </button>
            } @else {
              <button
                class="dm-action-btn"
                [disabled]="busy('mute')"
                (click)="onMute()"
                matTooltip="Mute OS notifications for this app">
                @if (busy('mute')) { <mat-spinner diameter="14"></mat-spinner> }
                @else { <span class="material-symbols-outlined">notifications_off</span> }
                <span>Mute</span>
              </button>
            }
            <button
              class="dm-action-btn"
              [disabled]="busy('test')"
              (click)="onTest()"
              matTooltip="Run this app's test suite once">
              @if (busy('test')) { <mat-spinner diameter="14"></mat-spinner> }
              @else { <span class="material-symbols-outlined">science</span> }
              <span>Test</span>
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
        <!-- In-page section nav (M159): sticky, scroll-spy-highlighted, with
             stable #anchors that are a deep-link CONTRACT. -->
        <nav class="dm-section-nav" aria-label="Sections">
          @for (sec of sections; track sec.id) {
            <a [href]="'#' + sec.id"
               class="dm-section-link"
               [class.active]="activeSection() === sec.id"
               [attr.aria-current]="activeSection() === sec.id ? 'true' : null"
               (click)="onSectionNav($event, sec.id)">
              <span class="material-symbols-outlined">{{ sec.icon }}</span>
              <span>{{ sec.label }}</span>
              @if (sec.id === 'errors' && errors().length) { <span class="dm-sec-count">{{ errors().length }}</span> }
            </a>
          }
        </nav>

        <div class="dm-sections">
          <section id="overview" class="dm-section" aria-labelledby="sec-overview">
            <h2 id="sec-overview" class="dm-section-title">Overview</h2>
            <div class="dm-section-body">
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
                        <tr><th scope="col">file</th><th class="dm-right" scope="col">size</th></tr>
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

              <div class="dm-cards-row">
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
            </div>
          </section>

          <section id="errors" class="dm-section" aria-labelledby="sec-errors">
            <h2 id="sec-errors" class="dm-section-title">
              Errors
              @if (errors().length) { <span class="dm-tab-count">{{ errors().length }}</span> }
            </h2>
            <div class="dm-section-body">
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
          </section>

          <section id="logs" class="dm-section" aria-labelledby="sec-logs">
            <h2 id="sec-logs" class="dm-section-title">Logs</h2>
            <div class="dm-section-body dm-tab-logs">
              <div class="dm-logs-toolbar">
                <span class="dm-dim">Live tail — last {{ logLines().length }} lines</span>
                <span class="dm-spacer"></span>
                <button class="dm-iconbtn" (click)="clearLogs()" aria-label="Clear logs" matTooltip="Clear">
                  <span class="material-symbols-outlined">delete_sweep</span>
                </button>
                <button
                  class="dm-iconbtn"
                  [class.active]="autoScroll()"
                  (click)="autoScroll.set(!autoScroll())"
                  aria-label="Auto-scroll"
                  [attr.aria-pressed]="autoScroll()"
                  matTooltip="Auto-scroll">
                  <span class="material-symbols-outlined">vertical_align_bottom</span>
                </button>
              </div>
              <!-- tabindex=0: a scrollable region must be keyboard-reachable
                   (axe scrollable-region-focusable, WCAG 2.1.1) — arrow keys
                   scroll it once focused. Only fires when logs overflow, which
                   is why a data-poor drive never caught it. -->
              <div #logBox class="dm-logbox" tabindex="0" role="log" aria-label="Log lines" (scroll)="onLogScroll($event)">
                @for (l of logLines(); track $index) {
                  <div class="dm-logline"><dm-mono>{{ l }}</dm-mono></div>
                } @empty {
                  <div class="dm-dim" style="padding: 1rem;">Waiting for log lines…</div>
                }
              </div>
            </div>
          </section>

          <section id="tests" class="dm-section" aria-labelledby="sec-tests">
            <h2 id="sec-tests" class="dm-section-title">Tests</h2>
            <div class="dm-section-body">
              @if (testRuns() === null) {
                <dm-skeleton height="6rem"></dm-skeleton>
              } @else if (latestRun(); as lr) {
                <section class="dm-panel">
                  <h3 class="dm-panel-title">Latest run</h3>
                  <div class="dm-history-stats">
                    <div class="dm-stat"><span class="dm-stat-label">passed</span><span class="dm-stat-num">{{ lr.passed ?? '—' }}</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">failed</span><span class="dm-stat-num">{{ lr.failed ?? '—' }}</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">total</span><span class="dm-stat-num">{{ lr.total ?? '—' }}</span></div>
                    @if (lr.coverage?.linesPct != null) {
                      <div class="dm-stat"><span class="dm-stat-label">coverage</span><span class="dm-stat-num">{{ lr.coverage?.linesPct }}%</span></div>
                    }
                  </div>
                  <div class="dm-dim">{{ lr.runner || 'runner ?' }} · {{ fmtWhyAgo(lr.ts) }}@if (lr.durationMs != null) { · {{ lr.durationMs }} ms }</div>
                  <a class="dm-why-session-link" routerLink="/tests">
                    View all test runs
                    <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  </a>
                </section>
                @if (testRuns()!.length > 1) {
                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Recent runs</h3>
                    <table class="dm-bundle">
                      <thead><tr><th scope="col">when</th><th scope="col">runner</th><th class="dm-right" scope="col">pass / total</th></tr></thead>
                      <tbody>
                        @for (r of testRuns()!.slice(0, 8); track r.id) {
                          <tr>
                            <td>{{ fmtWhyAgo(r.ts) }}</td>
                            <td><dm-mono>{{ r.runner || '—' }}</dm-mono></td>
                            <td class="dm-right"><dm-mono>{{ r.passed ?? '—' }} / {{ r.total ?? '—' }}</dm-mono></td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </section>
                }
              } @else {
                <dm-empty icon="science" title="No test runs" [hint]="'Run daimon test ' + name + ' — results appear here.'"></dm-empty>
              }
            </div>
          </section>

          <section id="timeline" class="dm-section" aria-labelledby="sec-timeline">
            <h2 id="sec-timeline" class="dm-section-title">Timeline</h2>
            <div class="dm-section-body">
              <section class="dm-panel">
                <h3 class="dm-panel-title">Compile times</h3>
                @if (compileTimes().length) {
                  <div class="dm-history-stats">
                    <div class="dm-stat"><span class="dm-stat-label">samples</span><span class="dm-stat-num">{{ compileTimes().length }}</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">p50</span><span class="dm-stat-num">{{ p50() }} ms</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">p95</span><span class="dm-stat-num">{{ p95() }} ms</span></div>
                    <div class="dm-stat"><span class="dm-stat-label">max</span><span class="dm-stat-num">{{ pMax() }} ms</span></div>
                  </div>
                  <div class="dm-spark-wrap" role="img" [attr.aria-label]="'Compile time trend: ' + compileTimes().length + ' samples, p50 ' + p50() + ' ms, p95 ' + p95() + ' ms, max ' + pMax() + ' ms'">
                    <canvas #spark aria-hidden="true"></canvas>
                  </div>
                } @else {
                  <div class="dm-dim">No compile history yet.</div>
                }
              </section>
              <a class="dm-why-session-link" routerLink="/timeline" [queryParams]="{ app: name }">
                View full timeline
                <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
              </a>
            </div>
          </section>

          <section id="why" class="dm-section" aria-labelledby="sec-why">
            <h2 id="sec-why" class="dm-section-title">Why</h2>
            <div class="dm-section-body">
              @if (whyLoading()) {
                <dm-skeleton height="10rem"></dm-skeleton>
              } @else if (why(); as w) {
                <div class="dm-cards-row dm-why-row">
                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Last crash</h3>
                    @if (w.lastCrash; as c) {
                      <dl class="dm-kv">
                        <dt>When</dt><dd>{{ fmtWhyAgo(c.ts) }}</dd>
                        <dt>Exit code</dt><dd><dm-mono>{{ c.exitCode ?? '—' }}</dm-mono></dd>
                        <dt>Signal</dt><dd><dm-mono>{{ c.signal ?? '—' }}</dm-mono></dd>
                        <dt>Uptime</dt><dd><dm-mono>{{ fmtUptime(c.uptimeMs) }}</dm-mono></dd>
                      </dl>
                      @if (c.lastLines.length) {
                        <details class="dm-why-details">
                          <summary>last {{ c.lastLines.length }} lines</summary>
                          <pre class="dm-why-lines">{{ c.lastLines.join('\n') }}</pre>
                        </details>
                      }
                    } @else {
                      <div class="dm-dim">No crash recorded.</div>
                    }
                  </section>

                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Env</h3>
                    @if (w.envChanged; as ec) {
                      <div class="dm-why-hint">
                        env changed since last healthy: {{ envChangedCount(ec) }} key{{ envChangedCount(ec) === 1 ? '' : 's' }} — key names only
                      </div>
                      <ul class="dm-why-keys">
                        @for (k of ec.keysAdded; track k.file + k.key) { <li><dm-mono>+{{ k.key }}</dm-mono><span class="dm-dim">{{ k.file }}</span></li> }
                        @for (k of ec.keysRemoved; track k.file + k.key) { <li><dm-mono>-{{ k.key }}</dm-mono><span class="dm-dim">{{ k.file }}</span></li> }
                        @for (k of ec.keysChanged; track k.file + k.key) { <li><dm-mono>~{{ k.key }}</dm-mono><span class="dm-dim">{{ k.file }}</span></li> }
                      </ul>
                    } @else {
                      <div class="dm-dim">No env changes detected.</div>
                    }
                  </section>

                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Restart storm</h3>
                    <dl class="dm-kv">
                      <dt>Active</dt><dd>{{ w.storm.active ? 'yes' : 'no' }}</dd>
                      <dt>Last hour</dt><dd>{{ w.storm.countLastHour }} / {{ w.storm.threshold }}</dd>
                    </dl>
                  </section>

                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Suspect commit</h3>
                    @if (w.suspectCommit) {
                      <dm-mono>{{ w.suspectCommit }}</dm-mono>
                    } @else {
                      <div class="dm-dim">No suspect commit identified.</div>
                    }
                  </section>
                </div>

                <!-- Session context (M138, v1.8 — experimental): the failure
                     situated in the derived session it happened in — other-app
                     errors, env changes, regressions earlier in the same
                     slice — with a hop onward to the M137 timeline. -->
                @if (w.sessionContext; as sc) {
                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Session context</h3>
                    @if (sc.sessionId) {
                      @if (sc.otherAppErrors?.length || sc.envChanges?.length || sc.regressions?.length) {
                        <ul class="dm-why-keys">
                          @for (e of sc.otherAppErrors ?? []; track e.app + e.message) {
                            <li><dm-mono>{{ e.app }}</dm-mono><span class="dm-dim">{{ e.message }} ×{{ e.count }}</span></li>
                          }
                          @for (ec of sc.envChanges ?? []; track ec.app + ec.from) {
                            <li><dm-mono>{{ ec.app }}</dm-mono><span class="dm-dim">env changed</span></li>
                          }
                          @for (rg of sc.regressions ?? []; track rg.app + rg.ts) {
                            <li><dm-mono>{{ rg.app }}</dm-mono><span class="dm-dim">regression</span></li>
                          }
                        </ul>
                      } @else {
                        <div class="dm-dim">Nothing else notable happened in this session before the failure.</div>
                      }
                      <a class="dm-why-session-link" [routerLink]="['/timeline']" [queryParams]="{ session: sc.sessionId }">
                        View session in timeline
                        <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                      </a>
                    } @else {
                      <div class="dm-dim">{{ sc.note || 'No derivable session for this failure.' }}</div>
                    }
                  </section>
                }

                @if (showResourceNote(w.resourceNote)) {
                  <section class="dm-panel">
                    <h3 class="dm-panel-title">
                      <span class="material-symbols-outlined dm-why-note-icon" aria-hidden="true">memory</span>
                      Resource note
                    </h3>
                    <div class="dm-why-note" role="note">{{ w.resourceNote }}</div>
                  </section>
                }

                @if (w.errorGroups.length) {
                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Recent error groups (24h)</h3>
                    <ul class="dm-why-keys">
                      @for (g of w.errorGroups; track g.fingerprint) {
                        <li><dm-mono>{{ g.message }}</dm-mono><span class="dm-dim">×{{ g.count }}</span></li>
                      }
                    </ul>
                  </section>
                }

                @if (w.doctor.length) {
                  <section class="dm-panel">
                    <h3 class="dm-panel-title">Doctor</h3>
                    <ul class="dm-why-keys">
                      @for (d of w.doctor; track d.name) {
                        <li>
                          <span class="material-symbols-outlined" [class.dm-doc-ok]="d.ok" [class.dm-doc-bad]="!d.ok">{{ d.ok ? 'check_circle' : 'error' }}</span>
                          {{ d.name }}
                          @if (d.detail) { <span class="dm-dim">— {{ d.detail }}</span> }
                        </li>
                      }
                    </ul>
                  </section>
                }
              } @else {
                <dm-empty icon="help" title="No why data" hint="Nothing recorded yet for this app."></dm-empty>
              }
            </div>
          </section>
        </div>
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
      color: var(--dm-color-fg-muted);
      text-decoration: none;
      font: 500 .8125rem/1.25rem Roboto;
      padding: 4px 8px; border-radius: 8px;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-back:hover { background: var(--dm-color-surface-2); color: var(--dm-color-fg); }
    .dm-back .material-symbols-outlined { font-size: 18px; }

    .dm-title-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .dm-title { margin: 0; font: 400 1.625rem/2rem Roboto; }
    .dm-title .dm-mono { font-size: 1.625rem; font-weight: 500; }

    .dm-ws-chip {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 4px 10px; border-radius: 999px;
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      font: 500 .75rem/1rem Roboto;
      color: var(--dm-color-fg-muted);
    }
    .dm-ws-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--dm-tone, var(--dm-color-primary)); }

    .dm-group-chip {
      display: inline-flex; align-items: center; gap: .3rem;
      padding: 4px 10px; border-radius: 999px;
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      font: 500 .75rem/1rem Roboto;
      color: var(--dm-color-fg-muted);
      text-decoration: none;
      transition: background var(--dm-motion-short) var(--dm-motion-easing), color var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-group-chip:hover { background: var(--dm-color-surface-3); color: var(--dm-color-fg); }
    .dm-group-chip .material-symbols-outlined { font-size: 14px; }

    .dm-lock-chip, .dm-agent-chip {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 2px 10px; border-radius: 999px;
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      font: 500 .75rem/1rem Roboto;
      color: var(--dm-color-fg-muted);
    }
    .dm-lock-chip {
      background: color-mix(in oklch, var(--dm-color-accent) 12%, transparent);
      border-color: color-mix(in oklch, var(--dm-color-accent) 28%, transparent);
      color: var(--dm-color-fg);
    }
    .dm-lock-chip .dm-mono, .dm-agent-chip .dm-mono { font-size: .75rem; }
    .dm-lock-ttl { font: 600 .6875rem/1rem 'Roboto Mono', ui-monospace, monospace; color: var(--dm-color-fg-muted); }

    .dm-mute-chip {
      display: inline-flex; align-items: center; gap: .3rem;
      padding: 2px 10px; border-radius: 999px;
      background: color-mix(in oklch, var(--dm-color-border-strong) 16%, transparent);
      border: 1px solid color-mix(in oklch, var(--dm-color-border-strong) 40%, transparent);
      color: var(--dm-color-fg-muted);
      font: 500 .75rem/1rem Roboto;
    }
    .dm-mute-chip .material-symbols-outlined { font-size: 14px; }

    .dm-action-bar { display: flex; flex-wrap: wrap; gap: .375rem; }
    .dm-action-btn {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 6px 12px; border-radius: 10px;
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      color: var(--dm-color-fg);
      font: 500 .8125rem/1.25rem Roboto;
      cursor: pointer; text-decoration: none;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-action-btn:hover:not(:disabled) { background: var(--dm-color-surface-3); }
    .dm-action-btn:disabled { opacity: .55; cursor: not-allowed; }
    .dm-action-btn .material-symbols-outlined { font-size: 18px; }
    .dm-action-primary {
      background: var(--dm-color-primary);
      color: var(--dm-color-on-primary);
      border-color: transparent;
    }
    .dm-action-primary:hover:not(:disabled) { background: color-mix(in oklch, var(--dm-color-primary) 88%, black); }

    .dm-tab-count {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; padding: 0 6px; margin-left: .375rem;
      border-radius: 999px;
      background: var(--dm-color-surface-3);
      color: var(--dm-color-fg-muted);
      font: 600 .6875rem/1rem 'Roboto Mono', ui-monospace, monospace;
    }

    /* In-page section nav (M159): sticky sub-nav under the header, scroll-spy
       highlighted. Horizontally scrollable on narrow viewports. */
    .dm-section-nav {
      position: sticky; top: 0; z-index: 5;
      display: flex; gap: 2px; flex-wrap: wrap;
      padding: 8px 0; margin-bottom: 4px;
      background: var(--dm-color-bg);
      border-bottom: 1px solid var(--dm-color-border);
    }
    .dm-section-link {
      display: inline-flex; align-items: center; gap: .375rem;
      padding: 6px 12px; border-radius: var(--dm-radius-full, 999px);
      color: var(--dm-color-fg-muted); text-decoration: none;
      font: 500 .8125rem/1.25rem Roboto; white-space: nowrap;
    }
    .dm-section-link:hover { background: var(--dm-color-surface-2); color: var(--dm-color-fg); }
    .dm-section-link.active {
      background: color-mix(in oklch, var(--dm-color-primary) var(--dm-badge-tint), transparent);
      color: var(--dm-color-primary);
    }
    .dm-section-link .material-symbols-outlined { font-size: 18px; }
    .dm-sec-count {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 16px; padding: 0 5px; border-radius: 999px;
      background: color-mix(in oklch, var(--dm-color-error) var(--dm-badge-tint), transparent);
      color: var(--dm-color-error); font: 600 .625rem/1rem 'Roboto Mono', ui-monospace, monospace;
    }

    .dm-sections { display: flex; flex-direction: column; gap: 1.5rem; }
    .dm-section { scroll-margin-top: 64px; }
    .dm-section-title {
      margin: 0 0 .75rem; font: 600 1.125rem/1.5rem Roboto; color: var(--dm-color-fg);
      display: flex; align-items: center; gap: .5rem;
    }
    .dm-section-body { display: flex; flex-direction: column; gap: 1rem; }

    @media (max-width: 768px) {
      .dm-section-nav { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
      .dm-section-nav::-webkit-scrollbar { display: none; }
    }

    .dm-cards-row {
      display: grid; gap: 1rem;
      grid-template-columns: minmax(260px, 1fr) minmax(0, 1.5fr);
    }
    @media (max-width: 880px) { .dm-cards-row { grid-template-columns: 1fr; } }

    .dm-panel {
      padding: 1rem 1.125rem;
      border-radius: 14px;
      background: var(--dm-color-surface);
      border: 1px solid var(--dm-color-border);
    }
    .dm-panel-wide { min-width: 0; }
    .dm-panel-title {
      margin: 0 0 .5rem;
      font: 500 .8125rem/1.25rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem;
      color: var(--dm-color-fg-muted);
    }

    .dm-kv {
      display: grid; grid-template-columns: max-content 1fr; gap: .25rem .75rem;
      margin: 0;
    }
    .dm-kv dt { color: var(--dm-color-fg-muted); font: 400 .8125rem/1.25rem Roboto; }
    .dm-kv dd { margin: 0; color: var(--dm-color-fg); }
    .dm-kv a { color: var(--dm-color-primary); text-decoration: underline; text-underline-offset: 2px; }
    .dm-kv a:hover { text-decoration: underline; }
    .dm-err-text { color: var(--dm-color-error); }

    .dm-bundle { width: 100%; border-collapse: collapse; }
    .dm-bundle th, .dm-bundle td { text-align: left; padding: .375rem .5rem; font-size: .8125rem; }
    .dm-bundle th { font-weight: 500; color: var(--dm-color-fg-muted); border-bottom: 1px solid var(--dm-color-border); }
    .dm-bundle tbody tr { border-bottom: 1px solid color-mix(in oklch, var(--dm-color-border) 50%, transparent); }
    .dm-bundle tbody tr:last-child { border-bottom: 0; }
    .dm-right { text-align: right; }

    .dm-chips-row { display: flex; flex-wrap: wrap; gap: .375rem; }
    .dm-dep-chip {
      display: inline-flex; align-items: center; gap: .25rem;
      padding: 4px 10px; border-radius: 999px;
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      color: var(--dm-color-fg);
      text-decoration: none;
      font: 500 .8125rem/1rem Roboto;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-dep-chip:hover { background: var(--dm-color-surface-3); }
    .dm-dep-chip .material-symbols-outlined { font-size: 14px; color: var(--dm-color-fg-muted); }

    .dm-err-group { padding: 0; overflow: hidden; }
    .dm-err-group-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: .625rem .875rem;
      background: var(--dm-color-surface-2);
      border-bottom: 1px solid var(--dm-color-border);
    }
    .dm-err-list { list-style: none; margin: 0; padding: 0; }
    .dm-err-item {
      padding: .5rem .875rem;
      border-bottom: 1px solid color-mix(in oklch, var(--dm-color-border) 60%, transparent);
      display: flex; flex-direction: column; gap: .25rem;
    }
    .dm-err-item:last-child { border-bottom: 0; }
    .dm-err-meta { display: flex; align-items: center; gap: .5rem; color: var(--dm-color-fg-muted); font-size: .75rem; }
    .dm-err-code { color: var(--dm-color-error); }
    .dm-err-count {
      padding: 0 6px; border-radius: 999px;
      background: color-mix(in oklch, var(--dm-color-error) var(--dm-badge-tint), transparent);
      color: var(--dm-color-error);
      font: 600 .6875rem/1rem 'Roboto Mono', ui-monospace, monospace;
    }
    .dm-err-msg { color: var(--dm-color-fg); white-space: pre-wrap; word-break: break-word; }

    .dm-tab-logs { gap: 0; }
    .dm-logs-toolbar {
      display: flex; align-items: center; gap: .375rem;
      padding: .375rem .5rem;
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      border-bottom: 0;
      border-radius: 12px 12px 0 0;
    }
    .dm-spacer { flex: 1; }
    .dm-iconbtn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 6px;
      background: transparent; border: 0;
      color: var(--dm-color-fg-muted); cursor: pointer;
      transition: background var(--dm-motion-short) var(--dm-motion-easing), color var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-iconbtn:hover { background: var(--dm-color-surface-3); color: var(--dm-color-fg); }
    .dm-iconbtn.active { color: var(--dm-color-primary); }
    .dm-iconbtn .material-symbols-outlined { font-size: 18px; }

    .dm-logbox {
      height: 480px;
      overflow: auto;
      padding: .5rem .75rem;
      background: var(--dm-color-bg);
      border: 1px solid var(--dm-color-border);
      border-radius: 0 0 12px 12px;
      font-family: var(--dm-mono);
    }
    .dm-logline { white-space: pre-wrap; word-break: break-word; padding: 1px 0; color: var(--dm-color-fg); }
    .dm-logline .dm-mono { font-size: .8125rem; }

    .dm-history-stats { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: .75rem; }
    .dm-stat {
      display: flex; flex-direction: column;
      padding: .5rem .75rem; border-radius: 10px;
      background: var(--dm-color-surface-2);
      min-width: 70px;
    }
    .dm-stat-label { font: 500 .6875rem/1rem Roboto; text-transform: uppercase; letter-spacing: .04rem; color: var(--dm-color-fg-muted); }
    .dm-stat-num { font: 600 1.125rem/1.5rem 'Roboto Mono', ui-monospace, monospace; color: var(--dm-color-fg); }
    .dm-spark-wrap { position: relative; height: 200px; }

    .dm-radios { display: flex; flex-direction: column; gap: .25rem; }
    .dm-radio {
      display: inline-flex; align-items: center; gap: .5rem;
      padding: .375rem .5rem; border-radius: 8px;
      cursor: pointer;
      transition: background var(--dm-motion-short) var(--dm-motion-easing);
    }
    .dm-radio:hover { background: var(--dm-color-surface-2); }
    .dm-radio input { position: absolute; opacity: 0; pointer-events: none; }
    .dm-radio-mark {
      display: inline-block; width: 16px; height: 16px; border-radius: 999px;
      border: 2px solid var(--dm-color-border-strong);
      position: relative; flex-shrink: 0;
    }
    .dm-radio input:checked + .dm-radio-mark {
      border-color: var(--dm-color-primary);
    }
    .dm-radio input:checked + .dm-radio-mark::after {
      content: ''; position: absolute; inset: 3px;
      border-radius: 999px; background: var(--dm-color-primary);
    }
    .dm-env-active {
      margin-left: auto;
      padding: 2px 8px; border-radius: 999px;
      font: 500 .6875rem/1rem Roboto;
      background: color-mix(in oklch, var(--dm-color-primary) var(--dm-badge-tint), transparent);
      color: var(--dm-color-primary);
    }

    .dm-dim { color: var(--dm-color-fg-muted); font-size: .875rem; }
    .dm-loading { padding: 2rem 0; }

    .dm-why-row { grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); }
    .dm-why-hint { color: var(--dm-color-fg-muted); font-size: .8125rem; margin-bottom: .5rem; }
    .dm-why-session-link { display: inline-flex; align-items: center; gap: .25rem; margin-top: .5rem; color: var(--dm-color-primary); font: 500 .8125rem/1.25rem Roboto; text-decoration: none; }
    .dm-why-session-link:hover { text-decoration: underline; }
    .dm-why-session-link .material-symbols-outlined { font-size: 16px; }
    .dm-why-keys { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
    .dm-why-keys li { display: flex; align-items: center; gap: .5rem; padding: .25rem .5rem; border-radius: 8px; background: var(--dm-color-surface-2); font-size: .8125rem; }
    .dm-why-keys .material-symbols-outlined { font-size: 16px; }
    .dm-doc-ok { color: var(--dm-color-primary); }
    .dm-doc-bad { color: var(--dm-color-error); }
    .dm-why-details { margin-top: .5rem; font-size: .8125rem; color: var(--dm-color-fg-muted); }
    .dm-why-details summary { cursor: pointer; }
    .dm-why-note-icon { font-size: 18px; vertical-align: middle; color: var(--dm-color-accent); }
    .dm-why-note {
      padding: .65rem .85rem;
      border-radius: 10px;
      background: color-mix(in oklch, var(--dm-color-accent) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--dm-color-accent) 28%, transparent);
      color: var(--dm-color-fg);
      font-size: .875rem;
    }
    .dm-why-lines {
      margin: .5rem 0 0; padding: .5rem .625rem;
      background: var(--dm-color-bg); border: 1px solid var(--dm-color-border); border-radius: 8px;
      font-family: var(--dm-mono); font-size: .75rem; white-space: pre-wrap; word-break: break-word;
      color: var(--dm-color-fg); max-height: 16rem; overflow: auto;
    }
  `],
})
export class AppDetailComponent implements OnInit, OnDestroy, AfterViewInit {
  @Input() name = '';
  // `?tab=errors|logs|history|env|why` deep-link (M85) — a permanent
  // back-compat input (v1.12 turned tabs into anchored sections). On init it
  // is mapped to the corresponding section anchor and scrolled to, so every
  // old `?tab=` URL still lands on the right content. Bound by
  // withComponentInputBinding().
  @Input() tab?: string;

  readonly api = inject(DaimonApi);
  private readonly http = inject(HttpClient);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly hostEl = inject(ElementRef);

  @ViewChild('logBox') logBox?: ElementRef<HTMLDivElement>;
  @ViewChild('spark') sparkRef?: ElementRef<HTMLCanvasElement>;

  // Sectioned layout (M159). The ids are a DEEP-LINK CONTRACT — once shipped
  // they never rename (the URL-back-compat rule applies to fragments too).
  protected readonly sections = [
    { id: 'overview', label: 'Overview', icon: 'info' },
    { id: 'errors',   label: 'Errors',   icon: 'error' },
    { id: 'logs',     label: 'Logs',     icon: 'terminal' },
    { id: 'tests',    label: 'Tests',    icon: 'science' },
    { id: 'timeline', label: 'Timeline', icon: 'timeline' },
    { id: 'why',      label: 'Why',      icon: 'help' },
  ];
  readonly activeSection = signal<string>('overview');
  private sectionObserver?: IntersectionObserver;
  // See setupSectionSpy: observer updates are held while a programmatic
  // scroll (deep link / nav click) settles, so the pinned target survives.
  private spyHoldUntil = 0;

  private readonly state = signal<any>(null);
  private readonly errs = signal<DetailError[]>([]);
  readonly logLines = signal<string[]>([]);
  readonly autoScroll = signal<boolean>(true);
  readonly compileTimes = signal<{ ts: number; ms: number }[]>([]);
  readonly envInfo = signal<EnvInfo | null>(null);
  readonly why = signal<AppWhy | null>(null);
  readonly whyLoading = signal<boolean>(true);
  readonly testRuns = signal<TestRun[] | null>(null);
  readonly latestRun = computed<TestRun | null>(() => this.testRuns()?.[0] ?? null);
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

  // Group membership chips (M97) — [] (row omitted) when the app is in no
  // group or the daemon predates groups (GET /api/groups 404 → api.groups()
  // stays `{}`). Matches by both the live app name and its baseName, same
  // as the apps-list chip filter.
  readonly appGroups = computed<string[]>(() => {
    const s = this.state();
    if (!s) return [];
    return groupsForApp({ name: s.name, baseName: s.baseName ?? null }, this.api.groups());
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
    void this.loadWhy();
    void this.loadTests();
  }

  // Map an old `?tab=` value (M85) or a `#fragment` to a section anchor. The
  // env tab folded into overview; history became the timeline section. Unknown
  // → overview.
  private initialSection(): string {
    const frag = this.route.snapshot.fragment;
    if (frag && this.sections.some(s => s.id === frag)) return frag;
    switch (this.tab) {
      case 'errors': return 'errors';
      case 'logs': return 'logs';
      case 'history': return 'timeline';
      case 'env': return 'overview';
      case 'why': return 'why';
      case 'tests': return 'tests';
      default: return 'overview';
    }
  }

  private viewInitDone = false;

  ngAfterViewInit(): void {
    // The sections + spark canvas live behind `@if (summary())`, which is only
    // truthy after the first refresh() resolves — so at this point the DOM may
    // still be the loading skeleton. tryInitView() runs the one-time view wiring
    // (chart, scroll-spy, deep-link scroll) and is also called from refresh(),
    // so it fires whenever the sections actually land, cold-load or not.
    this.tryInitView();
  }

  // Runs the one-time section wiring once the sections are in the DOM. Idempotent.
  private tryInitView(): void {
    if (this.viewInitDone || !this.state()) return;
    // Defer a macrotask so Angular has rendered the sections after state.set.
    setTimeout(() => {
      if (this.viewInitDone) return;
      const host = this.hostEl.nativeElement as HTMLElement;
      if (!host.querySelector('#overview')) return; // not rendered yet; a later refresh retries
      this.viewInitDone = true;

      this.setupSectionSpy();

      // Scroll to the deep-linked section (from `#fragment` or a legacy
      // `?tab=`). Overview is the no-op default so a bare /apps/:name stays put.
      const target = this.initialSection();
      if (target !== 'overview') this.scrollToSection(target, false);

      if (this.sparkRef) {
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
    }, 0);
  }

  // Scroll-spy: highlight the section-nav link for whichever section is
  // currently in view. Uses a top-biased rootMargin so a section registers as
  // active once its heading nears the top, matching how the nav reads.
  private setupSectionSpy(): void {
    const host = this.hostEl.nativeElement as HTMLElement;
    const els = this.sections
      .map(s => host.querySelector<HTMLElement>('#' + s.id))
      .filter((e): e is HTMLElement => !!e);
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    this.sectionObserver = new IntersectionObserver(
      entries => {
        // A programmatic scroll (deep-link cold load, section-nav click) just
        // pinned its target as active; on a page short enough that the target
        // can't reach the viewport top, this callback's initial batch would
        // immediately override the pin with the topmost section — so the pin
        // holds until the programmatic scroll has settled. Real user scrolls
        // after that update normally.
        if (Date.now() < this.spyHoldUntil) return;
        const visible = entries.filter(e => e.isIntersecting);
        if (visible.length) {
          // Topmost intersecting section wins.
          visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          this.activeSection.set(visible[0].target.id);
        }
      },
      { rootMargin: '-72px 0px -55% 0px', threshold: 0 },
    );
    for (const el of els) this.sectionObserver.observe(el);
  }

  onSectionNav(ev: Event, id: string): void {
    ev.preventDefault();
    this.scrollToSection(id, true);
  }

  private scrollToSection(id: string, smooth: boolean): void {
    const host = this.hostEl.nativeElement as HTMLElement;
    const el = host.querySelector<HTMLElement>('#' + id);
    if (!el) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.spyHoldUntil = Date.now() + (smooth && !reduced ? 800 : 300);
    el.scrollIntoView({ behavior: smooth && !reduced ? 'smooth' : 'auto', block: 'start' });
    this.activeSection.set(id);
    // Keep the deep-link honest without adding a history entry per click.
    //
    // The URL must be ABSOLUTE-ish: `replaceState` resolves a relative URL
    // against the document's BASE url, and index.html sets `<base href="/">`,
    // so a bare '#errors' rewrote the address to `/#errors` and threw the
    // `/apps/<name>` path away. That silently broke every legacy `?tab=`
    // deep-link (M85) — they landed on the overview home — and corrupted the
    // address bar on any section scroll. Deep-link back-compat is a hard rule;
    // keep the path and query, change only the fragment.
    try {
      history.replaceState(history.state, '', location.pathname + location.search + '#' + id);
    } catch {}
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.logStop?.();
    this.spark?.destroy();
    this.sectionObserver?.disconnect();
  }

  private async refresh(): Promise<void> {
    const [s, e] = await Promise.all([this.api.appDetail(this.name), this.api.appErrors(this.name)]);
    if (s) this.state.set(s);
    this.errs.set(Array.isArray(e) ? (e as DetailError[]) : []);
    // First time state lands, wire up the sections (spark, scroll-spy, deep-link).
    this.tryInitView();
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

  // Fetched once (not on the 4s poll): composes doctor + a `git log` shell-out
  // server-side, too heavy to repeat every tick for a tab most sessions never
  // open. Mirrors loadCompile/loadEnv's one-shot-on-init convention.
  private async loadWhy(): Promise<void> {
    this.whyLoading.set(true);
    try {
      this.why.set(await this.api.getAppWhy(this.name));
    } finally {
      this.whyLoading.set(false);
    }
  }

  // Recent test runs for the Tests section (M159) — recomposes GET /api/tests.
  // Degrades to [] (a note) on failure, never throws.
  private async loadTests(): Promise<void> {
    try {
      const runs = await this.api.getTestRuns({ app: this.name, limit: 10 });
      this.testRuns.set(Array.isArray(runs) ? runs : []);
    } catch {
      this.testRuns.set([]);
    }
  }

  envChangedCount(ec: NonNullable<AppWhy['envChanged']>): number {
    return ec.keysAdded.length + ec.keysRemoved.length + ec.keysChanged.length;
  }

  // M109 (v1.3, experimental): show/hide the Why panel's resource note.
  // Delegates to the pure predicate in app-detail-helpers.ts so it's
  // testable without booting Angular; the template calls this wrapper.
  showResourceNote(note: string | null | undefined): boolean {
    return hasResourceNote(note);
  }

  fmtWhyAgo(ts: number): string {
    const s = Math.max(0, Math.floor((this.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  fmtMuteUntil(ts: number): string {
    return new Date(ts).toLocaleString();
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

  // Mute / unmute / test — the consistent header action row (M159), same
  // endpoints the palette and apps list use. `mute` busy-key covers both.
  async onMute(): Promise<void> {
    if (this.busy('mute')) return;
    this.setBusy('mute', true);
    try {
      await this.api.muteApp(this.name);
      this.snack.open(`Muted ${this.name}`, '', { duration: 1500 });
      await this.refresh();
    } catch (e: any) {
      this.snack.open(`Mute failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy('mute', false);
    }
  }

  async onUnmute(): Promise<void> {
    if (this.busy('mute')) return;
    this.setBusy('mute', true);
    try {
      await this.api.unmuteApp(this.name);
      this.snack.open(`Unmuted ${this.name}`, '', { duration: 1500 });
      await this.refresh();
    } catch (e: any) {
      this.snack.open(`Unmute failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy('mute', false);
    }
  }

  async onTest(): Promise<void> {
    if (this.busy('test')) return;
    this.setBusy('test', true);
    this.snack.open(`Running tests for ${this.name}…`, '', { duration: 2000 });
    try {
      await this.api.runAppTest(this.name);
      await this.loadTests();
      const lr = this.latestRun();
      const summary = lr ? `${lr.passed ?? '?'} / ${lr.total ?? '?'} passed` : 'done';
      this.snack.open(`Tests: ${summary}`, '', { duration: 3000 });
    } catch (e: any) {
      this.snack.open(`Test run failed: ${e?.message ?? 'error'}`, 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy('test', false);
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
    const compileColor = readToken('--dm-chart-1');
    this.spark.data.labels = labels;
    this.spark.data.datasets = [
      {
        label: 'compile ms',
        data: ms,
        borderColor: compileColor,
        backgroundColor: `color-mix(in oklch, ${compileColor} 15%, transparent)`,
        tension: 0.25,
        pointRadius: 0,
        fill: true,
      },
      {
        label: 'p50',
        data: labels.map(() => p50),
        borderColor: readToken('--dm-chart-3'),
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
      },
      {
        label: 'p95',
        data: labels.map(() => p95),
        borderColor: readToken('--dm-chart-4'),
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
