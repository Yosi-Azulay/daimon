import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDividerModule } from '@angular/material/divider';
import { DaimonApi, DiscoveryMeta, Overview } from './daimon-api';
import { SkeletonComponent, EmptyStateComponent, MonoComponent } from './ui-primitives';

type AutoFixName = 'orphan-daemon' | 'stale-lock' | 'missing-search-root' | 'corrupt-history-db';
type RoutineStatus = 'unknown' | 'clean' | 'detected' | 'fixed' | 'error';

interface RoutineResult {
  name: AutoFixName;
  detected: boolean;
  description: string;
}

interface RoutineDef {
  name: AutoFixName;
  title: string;
  description: string;
}

interface RoutineState {
  status: RoutineStatus;
  detail: string;
  isPath: boolean;
}

const ROUTINES: RoutineDef[] = [
  { name: 'orphan-daemon', title: 'Orphan daemon', description: 'Daemon may be running from the wrong cwd, ignoring your local daimon.config.json' },
  { name: 'stale-lock', title: 'Stale lock', description: 'Lock file exists but the daemon process is dead' },
  { name: 'missing-search-root', title: 'Missing search root', description: 'Current cwd has an nx/angular/vite project but isn’t configured' },
  { name: 'corrupt-history-db', title: 'Corrupt history DB', description: 'History SQLite DB failed quickCheck()' },
];

@Component({
  selector: 'dm-doctor-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatDividerModule,
    SkeletonComponent,
    EmptyStateComponent,
    MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Doctor</h1>
        <div class="dm-page-sub">{{ subtitle() }}</div>
      </div>
      <button mat-icon-button aria-label="Refresh" (click)="refreshAll()" [disabled]="loading()">
        <mat-icon>refresh</mat-icon>
      </button>
    </div>

    <section class="dm-section">
      <h2 class="dm-section-title">System overview</h2>
      <div class="dm-grid-2">
        <mat-card class="dm-card">
          <mat-card-header><mat-card-title>Daemon</mat-card-title></mat-card-header>
          <mat-card-content>
            @if (loading() && !configLoaded()) {
              <div class="dm-stack"><dm-skeleton height="1.25rem" width="60%"></dm-skeleton><dm-skeleton height="1rem" width="40%"></dm-skeleton><dm-skeleton height="1rem" width="50%"></dm-skeleton></div>
            } @else {
              <div class="dm-kv">
                <span class="dm-k">Connection</span>
                <span class="dm-v">
                  <span class="dm-pill" [attr.data-kind]="api.connected() ? 'ok' : 'err'">
                    <span class="dm-dot"></span>{{ api.connected() ? 'connected' : 'disconnected' }}
                  </span>
                </span>
              </div>
              <div class="dm-kv">
                <span class="dm-k">Version</span>
                <span class="dm-v"><dm-mono>{{ daemonVersion() || 'unknown' }}</dm-mono></span>
              </div>
              <div class="dm-kv">
                <span class="dm-k">API port</span>
                <span class="dm-v"><dm-mono>{{ daemonPort() || '-' }}</dm-mono></span>
              </div>
              <div class="dm-kv">
                <span class="dm-k">Apps tracked</span>
                <span class="dm-v"><dm-mono>{{ api.apps().length }}</dm-mono></span>
              </div>
            }
          </mat-card-content>
        </mat-card>

        <mat-card class="dm-card">
          <mat-card-header><mat-card-title>Discovery</mat-card-title></mat-card-header>
          <mat-card-content>
            @if (loading() && !discovery()) {
              <div class="dm-stack">
                <dm-skeleton height="1rem" width="70%"></dm-skeleton>
                <dm-skeleton height="1rem" width="50%"></dm-skeleton>
                <dm-skeleton height="1rem" width="80%"></dm-skeleton>
              </div>
            } @else if (discovery() && discovery()!.appsFound === 0) {
              <dm-empty icon="search_off" [title]="'No apps discovered'" [hint]="discovery()!.suggestion || 'Run daimon init --auto in your workspace'">
                <dm-mono>daimon init --auto</dm-mono>
              </dm-empty>
            } @else if (discovery()) {
              <div class="dm-kv">
                <span class="dm-k">Apps found</span>
                <span class="dm-v"><dm-mono>{{ discovery()!.appsFound }}</dm-mono></span>
              </div>
              <div class="dm-kv">
                <span class="dm-k">Scanned</span>
                <span class="dm-v"><dm-mono>{{ discovery()!.scanned }}</dm-mono></span>
              </div>
              <div class="dm-block">
                <div class="dm-k">Search roots</div>
                <ul class="dm-list">
                  @for (r of discovery()!.searchRoots; track r) {
                    <li><dm-mono>{{ r }}</dm-mono></li>
                  }
                </ul>
              </div>
              @if (rejectedRows().length) {
                <div class="dm-block">
                  <div class="dm-k">Rejected</div>
                  <table class="dm-table">
                    <tbody>
                      @for (row of rejectedRows(); track row.reason) {
                        <tr><td><dm-mono>{{ row.reason }}</dm-mono></td><td class="dm-num"><dm-mono>{{ row.count }}</dm-mono></td></tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
              @if (discovery()!.warnings.length) {
                <div class="dm-block">
                  <div class="dm-k">Warnings</div>
                  <ul class="dm-list dm-warn">
                    @for (w of discovery()!.warnings; track w) {
                      <li><dm-mono>{{ w }}</dm-mono></li>
                    }
                  </ul>
                </div>
              }
              @if (discovery()!.suggestion) {
                <div class="dm-callout">{{ discovery()!.suggestion }}</div>
              }
            } @else {
              <div class="dm-muted">Discovery info unavailable.</div>
            }
          </mat-card-content>
        </mat-card>
      </div>
    </section>

    <section class="dm-section">
      <h2 class="dm-section-title">Auto-fix routines</h2>

      <div class="dm-banner">
        <div class="dm-banner-text">Run diagnostics across every routine, or attempt all fixes in one go.</div>
        <div class="dm-banner-actions">
          <button mat-stroked-button (click)="runAllDry()" [disabled]="busyAll()">
            @if (busyAll() && busyAllKind() === 'dry') { <mat-spinner diameter="16"></mat-spinner> } @else { <mat-icon>play_arrow</mat-icon> }
            Run all dry-run
          </button>
          <button mat-flat-button color="warn" (click)="fixAll()" [disabled]="busyAll()">
            @if (busyAll() && busyAllKind() === 'fix') { <mat-spinner diameter="16"></mat-spinner> } @else { <mat-icon>build</mat-icon> }
            Fix everything (be careful)
          </button>
        </div>
      </div>

      <div class="dm-grid-2">
        @for (r of routines; track r.name) {
          <mat-card class="dm-card">
            <mat-card-header>
              <mat-card-title>{{ r.title }}</mat-card-title>
            </mat-card-header>
            <mat-card-content>
              <div class="dm-row-between">
                <div class="dm-routine-desc">{{ r.description }}</div>
                <span class="dm-pill" [attr.data-kind]="state(r.name).status">
                  <span class="dm-dot"></span>{{ state(r.name).status }}
                </span>
              </div>
              @if (state(r.name).detail) {
                <div class="dm-detail">
                  @if (state(r.name).isPath) {
                    <dm-mono>{{ state(r.name).detail }}</dm-mono>
                  } @else {
                    <span>{{ state(r.name).detail }}</span>
                  }
                </div>
              }
            </mat-card-content>
            <mat-card-actions align="end">
              <button mat-stroked-button (click)="runOne(r.name, true)" [disabled]="busy(r.name) || busyAll()">
                @if (busy(r.name) === 'dry') { <mat-spinner diameter="16"></mat-spinner> } @else { <mat-icon>search</mat-icon> }
                Dry-run
              </button>
              <button mat-flat-button color="primary" (click)="runOne(r.name, false)" [disabled]="busy(r.name) || busyAll()">
                @if (busy(r.name) === 'fix') { <mat-spinner diameter="16"></mat-spinner> } @else { <mat-icon>build</mat-icon> }
                Fix
              </button>
            </mat-card-actions>
          </mat-card>
        }
      </div>
    </section>

    <section class="dm-section">
      <h2 class="dm-section-title">Quick links</h2>
      <div class="dm-quick">
        <button mat-stroked-button routerLink="/config">
          <mat-icon>tune</mat-icon> Open Config editor
        </button>
        <button mat-stroked-button routerLink="/events">
          <mat-icon>timeline</mat-icon> View Events
        </button>
        <button mat-stroked-button (click)="reloadConfig()" [disabled]="reloading()">
          @if (reloading()) { <mat-spinner diameter="16"></mat-spinner> } @else { <mat-icon>refresh</mat-icon> }
          Reload config
        </button>
        <div class="dm-stat">
          <div class="dm-stat-icon"><mat-icon>token</mat-icon></div>
          <div>
            <div class="dm-stat-label">API token footprint</div>
            <div class="dm-stat-value"><dm-mono>~ {{ tokenEstimate() }} tokens</dm-mono> per Claude session</div>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; padding: 1.5rem; max-width: 1200px; margin: 0 auto; }

    .dm-section { margin-bottom: 2rem; }
    .dm-section-title {
      margin: 0 0 .75rem;
      font: 500 1rem/1.5rem Roboto;
      color: var(--mat-sys-on-surface-variant);
      letter-spacing: .025rem;
      text-transform: uppercase;
      font-size: .75rem;
    }

    .dm-grid-2 {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    @media (max-width: 800px) {
      .dm-grid-2 { grid-template-columns: 1fr; }
    }

    .dm-card { background: var(--mat-sys-surface-container-low); }

    .dm-stack { display: flex; flex-direction: column; gap: .5rem; }

    .dm-kv {
      display: flex; align-items: baseline; justify-content: space-between;
      padding: .35rem 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-kv:last-child { border-bottom: 0; }
    .dm-k { color: var(--mat-sys-on-surface-variant); font-size: .8125rem; }
    .dm-v { color: var(--mat-sys-on-surface); }

    .dm-block { margin-top: .75rem; }
    .dm-block .dm-k { display: block; margin-bottom: .35rem; }

    .dm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
    .dm-list li {
      padding: .25rem .5rem;
      background: var(--mat-sys-surface-container);
      border-radius: 6px;
      overflow-wrap: anywhere;
    }
    .dm-warn li { color: var(--mat-sys-error); }

    .dm-table { width: 100%; border-collapse: collapse; font-size: .8125rem; }
    .dm-table td { padding: .25rem .5rem; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .dm-table tr:last-child td { border-bottom: 0; }
    .dm-num { text-align: right; color: var(--mat-sys-on-surface-variant); }

    .dm-callout {
      margin-top: .75rem;
      padding: .65rem .85rem;
      border-radius: 10px;
      background: color-mix(in oklch, var(--mat-sys-tertiary) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--mat-sys-tertiary) 28%, transparent);
      color: var(--mat-sys-on-surface);
      font-size: .875rem;
    }

    .dm-muted { color: var(--mat-sys-on-surface-variant); font-size: .875rem; }

    .dm-pill {
      display: inline-flex; align-items: center; gap: .4rem;
      padding: 2px 10px; border-radius: 999px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface);
      font: 500 .75rem/1rem Roboto;
      letter-spacing: .025rem;
    }
    .dm-pill .dm-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--mat-sys-outline); }
    .dm-pill[data-kind="ok"], .dm-pill[data-kind="clean"], .dm-pill[data-kind="fixed"] {
      background: color-mix(in oklch, var(--mat-sys-primary) 12%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-primary) 28%, transparent);
    }
    .dm-pill[data-kind="ok"] .dm-dot, .dm-pill[data-kind="clean"] .dm-dot, .dm-pill[data-kind="fixed"] .dm-dot {
      background: var(--mat-sys-primary);
    }
    .dm-pill[data-kind="detected"] {
      background: color-mix(in oklch, var(--mat-sys-tertiary) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-tertiary) 28%, transparent);
    }
    .dm-pill[data-kind="detected"] .dm-dot { background: var(--mat-sys-tertiary); }
    .dm-pill[data-kind="err"], .dm-pill[data-kind="error"] {
      background: color-mix(in oklch, var(--mat-sys-error) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-error) 30%, transparent);
      color: var(--mat-sys-error);
    }
    .dm-pill[data-kind="err"] .dm-dot, .dm-pill[data-kind="error"] .dm-dot { background: var(--mat-sys-error); }

    .dm-banner {
      display: flex; align-items: center; justify-content: space-between;
      gap: 1rem;
      padding: .85rem 1rem;
      margin-bottom: 1rem;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
    }
    .dm-banner-text { font-size: .875rem; color: var(--mat-sys-on-surface-variant); }
    .dm-banner-actions { display: flex; gap: .5rem; }
    @media (max-width: 700px) {
      .dm-banner { flex-direction: column; align-items: stretch; }
      .dm-banner-actions { flex-wrap: wrap; }
    }

    .dm-row-between { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
    .dm-routine-desc { font-size: .875rem; color: var(--mat-sys-on-surface-variant); flex: 1; }

    .dm-detail {
      margin-top: .75rem;
      padding: .5rem .65rem;
      background: var(--mat-sys-surface-container);
      border-radius: 8px;
      font-size: .8125rem;
      overflow-wrap: anywhere;
    }

    .dm-quick {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: .75rem;
    }
    .dm-quick button { justify-content: flex-start; padding: .75rem 1rem; height: auto; }

    .dm-stat {
      display: flex; align-items: center; gap: .75rem;
      padding: .75rem 1rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-low);
    }
    .dm-stat-icon {
      width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 10px;
      background: color-mix(in oklch, var(--mat-sys-primary) 14%, transparent);
      color: var(--mat-sys-primary);
    }
    .dm-stat-label { font-size: .75rem; color: var(--mat-sys-on-surface-variant); text-transform: uppercase; letter-spacing: .025rem; }
    .dm-stat-value { font-size: .875rem; color: var(--mat-sys-on-surface); }

    mat-spinner { display: inline-block; margin-right: .35rem; }
  `],
})
export class DoctorPageComponent implements OnInit {
  readonly api = inject(DaimonApi);
  private readonly http = inject(HttpClient);
  private readonly snack = inject(MatSnackBar);

  readonly routines = ROUTINES;

  private readonly results = signal<Map<AutoFixName, RoutineResult>>(new Map());
  private readonly results_lastIntent = signal<Map<AutoFixName, 'dry' | 'fix'>>(new Map());
  private readonly errored = signal<Set<AutoFixName>>(new Set());

  readonly loading = signal<boolean>(true);
  readonly discovery = signal<DiscoveryMeta | null>(null);
  readonly daemonVersion = signal<string>('');
  readonly daemonPort = signal<number | null>(null);
  readonly configLoaded = signal<boolean>(false);
  readonly overview = signal<Overview | null>(null);

  readonly busyMap = signal<Map<AutoFixName, 'dry' | 'fix'>>(new Map());
  readonly busyAll = signal<boolean>(false);
  readonly busyAllKind = signal<'dry' | 'fix' | null>(null);
  readonly reloading = signal<boolean>(false);

  readonly rejectedRows = computed(() => {
    const d = this.discovery();
    if (!d) return [];
    return Object.entries(d.rejected || {})
      .map(([reason, count]) => ({ reason, count: count as number }))
      .sort((a, b) => b.count - a.count);
  });

  readonly subtitle = computed(() => {
    const map = this.results();
    let issues = 0;
    for (const r of map.values()) if (r.detected) issues++;
    if (this.loading() && map.size === 0) return 'Checking system health…';
    if (map.size === 0) return 'Run diagnostics to see if any routines need fixing.';
    if (issues === 0) return 'All checked routines look clean.';
    return `${issues} routine${issues === 1 ? '' : 's'} need${issues === 1 ? 's' : ''} fixing`;
  });

  readonly tokenEstimate = computed(() => {
    const apps = this.api.apps().length;
    return 120 + apps * 34;
  });

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
  }

  async refreshAll(): Promise<void> {
    this.loading.set(true);
    try {
      const [cfg, disc, overview] = await Promise.all([
        this.api.getConfig().catch(() => null),
        this.api.discoveryExplain().catch(() => null),
        firstValueFrom(this.http.get<Overview>('/api/overview')).catch(() => null),
      ]);
      if (cfg && cfg.config) {
        this.configLoaded.set(true);
        this.daemonVersion.set(cfg.config.version || cfg.config.daemonVersion || '');
        this.daemonPort.set(cfg.config.apiPort ?? cfg.config.api?.port ?? null);
      }
      this.discovery.set(disc);
      this.overview.set(overview);
      if (!this.api.apps().length) await this.api.refresh();
    } finally {
      this.loading.set(false);
    }
  }

  state(name: AutoFixName): RoutineState {
    const res = this.results().get(name);
    const intent = this.results_lastIntent().get(name);
    const isErr = this.errored().has(name);
    if (!res) return { status: 'unknown', detail: '', isPath: false };
    let status: RoutineStatus;
    if (isErr) status = 'error';
    else if (intent === 'fix') status = res.detected ? 'fixed' : 'clean';
    else status = res.detected ? 'detected' : 'clean';
    const detail = res.description || '';
    const isPath = /[\\/]/.test(detail) || detail.includes(':\\') || detail.startsWith('/');
    return { status, detail, isPath };
  }

  busy(name: AutoFixName): 'dry' | 'fix' | undefined {
    return this.busyMap().get(name);
  }

  async runOne(name: AutoFixName, dryRun: boolean): Promise<void> {
    if (!dryRun) {
      const ok = window.confirm(`Run fix for "${name}"? This will modify daemon state.`);
      if (!ok) return;
    }
    const kind: 'dry' | 'fix' = dryRun ? 'dry' : 'fix';
    this.setBusy(name, kind);
    try {
      const res = await this.api.runAutoFix({ dryRun, permitted: [name] });
      this.ingestResults(res, kind);
      const r = this.results().get(name);
      if (r) {
        this.snack.open(
          dryRun
            ? (r.detected ? `${name}: issue detected` : `${name}: clean`)
            : (r.detected ? `${name}: fix applied` : `${name}: no action needed`),
          'OK',
          { duration: 3500 },
        );
      } else {
        this.snack.open(`${name}: no result returned`, 'OK', { duration: 3000 });
      }
    } catch (e: any) {
      this.markError(name, e?.message || String(e));
      this.snack.open(`${name} failed: ${e?.message || e}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.setBusy(name, null);
    }
  }

  async runAllDry(): Promise<void> {
    this.busyAll.set(true);
    this.busyAllKind.set('dry');
    try {
      const res = await this.api.runAutoFix({ dryRun: true });
      this.ingestResults(res, 'dry');
      this.snack.open('Dry-run complete', 'OK', { duration: 2500 });
    } catch (e: any) {
      this.snack.open(`Dry-run failed: ${e?.message || e}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.busyAll.set(false);
      this.busyAllKind.set(null);
    }
  }

  async fixAll(): Promise<void> {
    const ok = window.confirm('Run every fix routine without dry-run? This will modify daemon state.');
    if (!ok) return;
    this.busyAll.set(true);
    this.busyAllKind.set('fix');
    try {
      const res = await this.api.runAutoFix({ dryRun: false });
      this.ingestResults(res, 'fix');
      this.snack.open('Fix-all complete', 'OK', { duration: 2500 });
    } catch (e: any) {
      this.snack.open(`Fix-all failed: ${e?.message || e}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.busyAll.set(false);
      this.busyAllKind.set(null);
    }
  }

  async reloadConfig(): Promise<void> {
    this.reloading.set(true);
    try {
      await this.api.reloadConfig();
      this.snack.open('Config reloaded', 'OK', { duration: 2500 });
      await this.refreshAll();
    } catch (e: any) {
      this.snack.open(`Reload failed: ${e?.message || e}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.reloading.set(false);
    }
  }

  private setBusy(name: AutoFixName, kind: 'dry' | 'fix' | null): void {
    this.busyMap.update(m => {
      const next = new Map(m);
      if (kind === null) next.delete(name);
      else next.set(name, kind);
      return next;
    });
  }

  private ingestResults(resp: any, intent: 'dry' | 'fix'): void {
    const ran: RoutineResult[] = Array.isArray(resp?.ran) ? resp.ran : [];
    const skipped: RoutineResult[] = Array.isArray(resp?.skipped) ? resp.skipped : [];
    const errors: { name: AutoFixName; error: string }[] = Array.isArray(resp?.errors) ? resp.errors : [];

    this.results.update(m => {
      const next = new Map(m);
      for (const r of ran) next.set(r.name, r);
      for (const r of skipped) next.set(r.name, r);
      for (const e of errors) {
        const prev = next.get(e.name);
        next.set(e.name, { name: e.name, detected: prev?.detected ?? false, description: e.error || 'error' });
      }
      return next;
    });
    this.errored.update(s => {
      const next = new Set(s);
      for (const r of ran) next.delete(r.name);
      for (const r of skipped) next.delete(r.name);
      for (const e of errors) next.add(e.name);
      return next;
    });
    this.results_lastIntent.update(m => {
      const next = new Map(m);
      for (const r of ran) next.set(r.name, intent);
      for (const r of skipped) next.set(r.name, intent);
      for (const e of errors) next.set(e.name, 'fix');
      return next;
    });
    if (errors.length) {
      for (const e of errors) this.markError(e.name, e.error);
    }
  }

  private markError(name: AutoFixName, msg: string): void {
    this.results.update(m => {
      const next = new Map(m);
      next.set(name, { name, detected: false, description: msg || 'error' });
      return next;
    });
    this.results_lastIntent.update(m => {
      const next = new Map(m);
      next.set(name, 'fix');
      return next;
    });
    this.errored.update(s => {
      const next = new Set(s);
      next.add(name);
      return next;
    });
  }
}
