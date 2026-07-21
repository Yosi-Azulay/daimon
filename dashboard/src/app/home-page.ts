import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DaimonApi } from './daimon-api';
import { StatusPillComponent, EmptyStateComponent, MonoComponent } from './ui-primitives';
import { FirstRunCardComponent } from './first-run-card';
import { readFirstRunDismissed } from './first-run-helpers';
import {
  computePassRate,
  filterByMemberSet,
  passRateTone,
  resourceTotalsFromApps,
  statusSummary,
  statusSummaryFromApps,
  type PassRate,
} from './home-page-helpers';
import { filterAppsByWorkspace, workspaceMemberNames } from './workspace-helpers';

const WS_KEY = 'daimon.workspace';

// Overview home (M158, v1.12). `/` answers "how are things" before a click, by
// COMPOSING existing endpoints only — status + needs-attention from
// /api/overview, pass-rate from /api/tests, resource glance from /api/self.
// No new endpoint, no new analytics, no new state. Every widget degrades
// INDEPENDENTLY to a note: a daemon reachable but one section's data missing
// shows that section's note, never a spinner forever and never an error page.
// The apps list itself lives at /apps now; each widget links onward to its
// full page, teaching the IA by use.
@Component({
  selector: 'dm-home-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StatusPillComponent, EmptyStateComponent, MonoComponent, FirstRunCardComponent],
  template: `
    <div class="dm-home">
      <header class="dm-home-head">
        <h1>Overview</h1>
        <p class="dm-home-sub">How things are right now — jump into any area below.</p>
      </header>

      @if (freshInstall()) {
        <!-- Guided fresh-install state (M158/M160, walkthrough card added
             M169): no apps, no history yet. The rich walkthrough shows once
             per browser; dismissing it falls back to the plain M160 state
             below rather than an empty page. -->
        @if (!firstRunDismissed()) {
          <dm-first-run-card (dismissed)="firstRunDismissed.set(true)">
            <a class="dm-home-cta" routerLink="/apps">Go to apps</a>
          </dm-first-run-card>
        } @else {
          <dm-empty
            icon="rocket_launch"
            title="No apps yet"
            hint="daimon watches the dev servers in your workspaces. Open a workspace folder and run your framework's dev command, or start one from the apps list — it'll show up here.">
            <a class="dm-home-cta" routerLink="/apps">Go to apps</a>
          </dm-empty>
        }
      } @else {
        <div class="dm-home-grid">
          <!-- Status summary ────────────────────────────────────────────── -->
          <section class="dm-widget" aria-labelledby="w-status">
            <div class="dm-widget-head">
              <h2 id="w-status">Status</h2>
              <a routerLink="/apps" class="dm-widget-link">Apps →</a>
            </div>
            @if (api.overview(); as ov) {
              <div class="dm-stat-row">
                <a routerLink="/apps" class="dm-stat">
                  <span class="dm-stat-num">{{ status().apps }}</span>
                  <span class="dm-stat-lbl">apps</span>
                </a>
                <a routerLink="/apps" class="dm-stat dm-tone-ok">
                  <span class="dm-stat-num">{{ status().serving }}</span>
                  <span class="dm-stat-lbl">serving</span>
                </a>
                <a routerLink="/apps" class="dm-stat" [class.dm-tone-error]="status().errors > 0">
                  <span class="dm-stat-num">{{ status().errors }}</span>
                  <span class="dm-stat-lbl">errored</span>
                </a>
                <a routerLink="/apps" class="dm-stat">
                  <span class="dm-stat-num">{{ status().stopped }}</span>
                  <span class="dm-stat-lbl">stopped</span>
                </a>
              </div>
            } @else {
              <p class="dm-widget-note">Status unavailable — the daemon isn't reporting an overview.</p>
            }
          </section>

          <!-- Recent errors ─────────────────────────────────────────────── -->
          <section class="dm-widget" aria-labelledby="w-errors">
            <div class="dm-widget-head">
              <h2 id="w-errors">Needs attention</h2>
              <a routerLink="/errors" class="dm-widget-link">Errors →</a>
            </div>
            @if (attention(); as att) {
              @if (att.length) {
                <ul class="dm-attn-list">
                  @for (a of att.slice(0, 5); track a.name) {
                    <li>
                      <a [routerLink]="['/apps', a.name]" [queryParams]="{ tab: 'errors' }" class="dm-attn-row">
                        <dm-status-pill [status]="$any(a.status)" health="unknown"></dm-status-pill>
                        <dm-mono class="dm-attn-name">{{ a.name }}</dm-mono>
                        <span class="dm-attn-msg">{{ a.firstError?.message || (a.errCount + ' error' + (a.errCount === 1 ? '' : 's')) }}</span>
                        <span class="dm-attn-count">{{ a.errCount }}</span>
                      </a>
                    </li>
                  }
                </ul>
              } @else {
                <p class="dm-widget-note dm-tone-ok-text">All clear — no apps need attention.</p>
              }
            } @else {
              <p class="dm-widget-note">Error summary unavailable.</p>
            }
          </section>

          <!-- Test pass-rate ────────────────────────────────────────────── -->
          <section class="dm-widget" aria-labelledby="w-tests">
            <div class="dm-widget-head">
              <h2 id="w-tests">Test pass-rate</h2>
              <a routerLink="/tests" class="dm-widget-link">Tests →</a>
            </div>
            @if (passRate(); as pr) {
              @if (pr.pct !== null) {
                <div class="dm-passrate" [attr.data-tone]="passTone()">
                  <span class="dm-passrate-num">{{ pr.pct }}<span class="dm-passrate-pct">%</span></span>
                  <span class="dm-passrate-sub">{{ pr.passed }} / {{ pr.total }} across {{ pr.runs }} recent run{{ pr.runs === 1 ? '' : 's' }}</span>
                </div>
              } @else {
                <p class="dm-widget-note">No test runs with totals yet — run <dm-mono>daimon test &lt;app&gt;</dm-mono>.</p>
              }
            } @else {
              <p class="dm-widget-note">Loading test history…</p>
            }
          </section>

          <!-- Resource glance ───────────────────────────────────────────── -->
          <section class="dm-widget" aria-labelledby="w-res">
            <div class="dm-widget-head">
              <h2 id="w-res">Resources</h2>
              <a routerLink="/trends" class="dm-widget-link">Trends →</a>
            </div>
            @if (resource(); as r) {
              <dl class="dm-res">
                <div><dt>App CPU</dt><dd><dm-mono>{{ r.cpuPct }}</dm-mono></dd></div>
                <div><dt>App memory</dt><dd><dm-mono>{{ r.memMb }}</dm-mono></dd></div>
                <div><dt>Daemon RSS</dt><dd><dm-mono>{{ r.rss }}</dm-mono></dd></div>
              </dl>
            } @else {
              <p class="dm-widget-note">Resource metrics unavailable.</p>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [`
    .dm-home { display: flex; flex-direction: column; gap: var(--dm-space-5); }
    .dm-home-head h1 { margin: 0; font: 600 1.5rem/2rem var(--dm-font); color: var(--dm-color-fg); }
    .dm-home-sub { margin: .25rem 0 0; color: var(--dm-color-fg-muted); font: 400 var(--dm-text-md)/1.5rem var(--dm-font); }
    .dm-home-cta {
      margin-top: var(--dm-space-3); display: inline-block;
      padding: 8px 16px; border-radius: var(--dm-radius-md);
      background: var(--dm-color-primary); color: var(--dm-color-on-primary);
      text-decoration: none; font: 600 var(--dm-text-sm)/1.25rem var(--dm-font);
    }
    .dm-home-grid {
      display: grid; gap: var(--dm-space-4);
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .dm-widget {
      background: var(--dm-color-surface-2);
      border: 1px solid var(--dm-color-border);
      border-radius: var(--dm-radius-lg);
      padding: var(--dm-space-4);
      display: flex; flex-direction: column; gap: var(--dm-space-3);
      min-width: 0;
    }
    .dm-widget-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
    .dm-widget-head h2 { margin: 0; font: 600 1rem/1.5rem var(--dm-font); color: var(--dm-color-fg); }
    .dm-widget-link { color: var(--dm-color-primary); text-decoration: none; font: 500 var(--dm-text-sm)/1.25rem var(--dm-font); white-space: nowrap; }
    .dm-widget-link:hover { text-decoration: underline; }
    .dm-widget-note { margin: 0; color: var(--dm-color-fg-muted); font: 400 var(--dm-text-sm)/1.375rem var(--dm-font); }
    .dm-tone-ok-text { color: var(--dm-color-ok, var(--dm-color-primary)); }

    .dm-stat-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--dm-space-2); }
    .dm-stat {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      padding: var(--dm-space-2); border-radius: var(--dm-radius-md);
      background: var(--dm-color-surface); text-decoration: none; color: var(--dm-color-fg);
    }
    .dm-stat:hover { background: var(--dm-color-surface-3); }
    .dm-stat-num { font: 600 1.5rem/2rem var(--dm-font); }
    .dm-stat-lbl { font: 500 var(--dm-text-xs)/1rem var(--dm-font); color: var(--dm-color-fg-muted); text-transform: uppercase; letter-spacing: .05em; }
    .dm-tone-ok .dm-stat-num { color: var(--dm-color-ok, var(--dm-color-primary)); }
    .dm-tone-error .dm-stat-num { color: var(--dm-color-error, #d33); }

    .dm-attn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .dm-attn-row {
      display: flex; align-items: center; gap: .5rem;
      padding: 6px 8px; border-radius: var(--dm-radius-md);
      text-decoration: none; color: var(--dm-color-fg);
    }
    .dm-attn-row:hover { background: var(--dm-color-surface-3); }
    .dm-attn-name { flex-shrink: 0; }
    .dm-attn-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dm-color-fg-muted); font: 400 var(--dm-text-sm)/1.25rem var(--dm-font); }
    .dm-attn-count {
      flex-shrink: 0; padding: 1px 8px; border-radius: 999px;
      /* --dm-badge-tint (6%) is the AA-verified tint every other error badge
         uses — the 16% this shipped with sank error-on-tint below 4.5:1
         (caught by the axe gate the first time home rendered live errors). */
      background: color-mix(in oklch, var(--dm-color-error, #d33) var(--dm-badge-tint, 6%), transparent);
      color: var(--dm-color-error, #d33); font: 600 var(--dm-text-xs)/1.125rem var(--dm-font);
    }

    .dm-passrate { display: flex; flex-direction: column; gap: 2px; }
    .dm-passrate-num { font: 700 2.25rem/2.5rem var(--dm-font); color: var(--dm-color-fg); }
    .dm-passrate-pct { font-size: 1.25rem; color: var(--dm-color-fg-muted); }
    .dm-passrate-sub { font: 400 var(--dm-text-sm)/1.25rem var(--dm-font); color: var(--dm-color-fg-muted); }
    .dm-passrate[data-tone="ok"] .dm-passrate-num { color: var(--dm-color-ok, var(--dm-color-primary)); }
    .dm-passrate[data-tone="warn"] .dm-passrate-num { color: var(--dm-color-warn, #b80); }
    .dm-passrate[data-tone="error"] .dm-passrate-num { color: var(--dm-color-error, #d33); }

    .dm-res { margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .dm-res > div { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
    .dm-res dt { color: var(--dm-color-fg-muted); font: 400 var(--dm-text-sm)/1.25rem var(--dm-font); margin: 0; }
    .dm-res dd { margin: 0; font: 500 var(--dm-text-sm)/1.25rem var(--dm-font); }

    @media (max-width: 768px) {
      .dm-home-grid { grid-template-columns: 1fr; }
    }
  `],
})
export class HomePageComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly firstRunDismissed = signal(readFirstRunDismissed(localStorage));
  readonly workspace = signal<string | null>(null);

  // TestRun's `app` field is needed to scope the pass-rate widget to the
  // active workspace — widened from the original { passed, total } shape.
  private readonly testRuns = signal<{ app: string; passed: number | null; total: number | null }[] | null>(null);
  private readonly self = signal<any | null | undefined>(undefined);
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    this.workspace.set(localStorage.getItem(WS_KEY));
    const onWs = (e: Event) => this.workspace.set(((e as CustomEvent).detail as string | null) ?? null);
    window.addEventListener('daimon:workspace', onWs);
    this.destroyRef.onDestroy(() => window.removeEventListener('daimon:workspace', onWs));
  }

  @HostListener('window:storage', ['$event'])
  onStorage(ev: StorageEvent): void {
    if (ev.key === WS_KEY) this.workspace.set(ev.newValue);
  }

  // Status widget: server-composed overview.totals when unfiltered (cheapest
  // path, matches every other page's default), recomputed client-side from
  // the workspace-filtered app rows once a filter is active — the server
  // total has no workspace dimension to slice by.
  readonly status = computed(() => {
    const ws = this.workspace();
    return ws === null
      ? statusSummary(this.api.overview()?.totals)
      : statusSummaryFromApps(filterAppsByWorkspace(this.api.apps(), ws));
  });

  // Fresh install: daemon reachable, but nothing to show anywhere yet. Always
  // unfiltered — a workspace filter that happens to match zero apps is "no
  // apps here", not "no apps anywhere", so it must not trigger the walkthrough.
  readonly freshInstall = computed(() => {
    const ov = this.api.overview();
    if (!ov) return false; // not fresh — just not loaded; keep widgets (with notes)
    return (ov.totals?.apps ?? 0) === 0 && this.api.apps().length === 0;
  });

  // Needs-attention rows are keyed by app name only (no workspaceLabel of
  // their own), so membership is cross-referenced against the live registry.
  readonly attention = computed(() => {
    const ov = this.api.overview();
    if (!ov) return null;
    const members = workspaceMemberNames(this.api.apps(), this.workspace());
    return filterByMemberSet(ov.needsAttention, members, a => a.name);
  });

  readonly passRate = computed<PassRate | null>(() => {
    const runs = this.testRuns();
    if (runs === null) return null;
    const members = workspaceMemberNames(this.api.apps(), this.workspace());
    return computePassRate(filterByMemberSet(runs, members, r => r.app));
  });
  readonly passTone = computed(() => passRateTone(this.passRate()?.pct ?? null));

  // Resource glance: App CPU/mem scope to the workspace (recomputed from app
  // rows once filtered, same split as `status` above) — Daemon RSS from
  // /api/self stays daemon-global and is never filtered. Null → note.
  readonly resource = computed<{ cpuPct: string; memMb: string; rss: string } | null>(() => {
    const ov = this.api.overview();
    const s = this.self();
    if (s === undefined) return null; // not loaded yet
    const ws = this.workspace();
    const totals = ws === null
      ? { cpuPct: ov?.totals?.totalCpuPct ?? null, memMb: ov?.totals?.totalMemMb ?? null }
      : resourceTotalsFromApps(filterAppsByWorkspace(this.api.apps(), ws));
    const rss = s?.rssMB ?? s?.rss ?? s?.memory?.rssMB;
    if (totals.cpuPct == null && totals.memMb == null && rss == null) return null;
    return {
      cpuPct: totals.cpuPct == null ? '—' : `${Math.round(totals.cpuPct)}%`,
      memMb: totals.memMb == null ? '—' : `${Math.round(totals.memMb)} MB`,
      rss: rss == null ? '—' : `${Math.round(Number(rss))} MB`,
    };
  });

  async ngOnInit(): Promise<void> {
    await this.loadWidgets();
    // Light refresh so pass-rate / self track without a second poller — the
    // shell's api.start() already refreshes apps+overview on its own cadence.
    this.timer = setInterval(() => void this.loadWidgets(), 15_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async loadWidgets(): Promise<void> {
    // Each source degrades independently — a failure sets a note, never throws.
    try {
      const runs = await this.api.getTestRuns({ limit: 25 });
      this.testRuns.set(Array.isArray(runs) ? runs : []);
    } catch { this.testRuns.set([]); }
    try {
      this.self.set(await this.api.getSelf());
    } catch { this.self.set(null); }
  }
}
