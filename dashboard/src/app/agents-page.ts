import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { DaimonApi, AgentRecord, AgentRosterRow, ContentionHotspot, LockSnapshot } from './daimon-api';
import { EmptyStateComponent, MonoComponent } from './ui-primitives';

const POLL_MS = 4_000;

function relTime(ms: number, now: number): string {
  const d = Math.max(0, Math.floor((now - ms) / 1000));
  if (d < 1) return 'just now';
  if (d < 60) return `${d}s ago`;
  const m = Math.floor(d / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function ttl(ms: number, now: number): string {
  const d = Math.max(0, Math.ceil((ms - now) / 1000));
  if (d <= 0) return 'expired';
  if (d < 60) return `${d}s`;
  return `${Math.floor(d / 60)}m ${d % 60}s`;
}

// Renders a millisecond hold duration for the contention section
// (longestHoldMs) — same "Xm Ys" shape as ttl() above but counting up from
// zero rather than down to an expiry, so it gets its own tiny formatter.
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

@Component({
  selector: 'dm-agents-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, RouterLink,
    MatCardModule, MatIconModule, MatTooltipModule, MatChipsModule,
    EmptyStateComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Agents <span class="dm-count">Â· {{ rosterSupported() ? roster().length : agents().length }}</span></h1>
        <div class="dm-page-sub">
          @if (self()) {
            <span>You are <dm-mono>{{ self() }}</dm-mono></span>
          } @else {
            <span>Live view of every CLI / MCP / dashboard caller against this daemon</span>
          }
        </div>
      </div>
    </div>

    @if (rosterSupported()) {
      <!-- Agent Ledger (M126, v1.6): the merged live + audit-derived roster. -->
      @if (roster().length === 0) {
        <dm-empty icon="badge" title="No known agents"
          hint="Agents appear here within a few seconds of their first daimon call. Try &#96;daimon list&#96; from a terminal." data-testid="roster-empty"></dm-empty>
      } @else {
        <div class="dm-agents-grid" data-testid="roster-grid">
          @for (row of roster(); track row.id) {
            <mat-card class="dm-agent-card" [class.dm-agent-self]="row.id === self()" data-testid="roster-row" [attr.data-agent-id]="row.id">
              <mat-card-header>
                <mat-card-title>
                  <dm-mono>{{ row.id }}</dm-mono>
                  @if (row.id === self()) { <span class="dm-tag dm-tag-self">you</span> }
                  @if (row.id === '(unknown)') { <span class="dm-tag dm-tag-unknown" data-testid="agent-unknown" matTooltip="No X-Daimon-Agent header was declared for these calls">unknown</span> }
                  <span class="dm-tag" [class.dm-tag-active]="row.active" [class.dm-tag-idle]="!row.active">{{ row.active ? 'active' : 'idle' }}</span>
                </mat-card-title>
                <mat-card-subtitle>
                  {{ row.callCount }} calls · last seen {{ relOrNever(row.lastSeen) }}
                  @if (row.firstSeen != null) { · first seen {{ relOrNever(row.firstSeen) }} }
                </mat-card-subtitle>
              </mat-card-header>
              <mat-card-content>
                @if (row.cwd) {
                  <div class="dm-agent-row"><mat-icon fontSet="material-symbols-outlined">folder_open</mat-icon><dm-mono>{{ row.cwd }}</dm-mono></div>
                }

                @if (actionEntries(row.actions).length > 0) {
                  <div class="dm-agent-actions">
                    <h4>Actions</h4>
                    <mat-chip-set aria-label="Action counts" data-testid="action-chip-set">
                      @for (kv of actionEntries(row.actions); track kv[0]) {
                        <mat-chip data-testid="action-chip">{{ kv[0] }} ×{{ kv[1] }}</mat-chip>
                      }
                    </mat-chip-set>
                  </div>
                }

                @if (row.locks.length > 0) {
                  <div class="dm-agent-locks">
                    <h4>Holds {{ row.locks.length }} lock{{ row.locks.length === 1 ? '' : 's' }}</h4>
                    @for (app of row.locks; track app) {
                      <div class="dm-lock-row">
                        <mat-icon fontSet="material-symbols-outlined" class="dm-lock-icon">lock</mat-icon>
                        <a [routerLink]="['/apps', app]" class="dm-app-link">{{ app }}</a>
                        @if (locks()[app]) { <span class="dm-lock-ttl">expires in {{ ttl(locks()[app].expiresAt) }}</span> }
                      </div>
                    }
                  </div>
                } @else {
                  <div class="dm-agent-row dm-agent-row-muted">
                    <mat-icon fontSet="material-symbols-outlined">lock_open</mat-icon>
                    <span>No active locks</span>
                  </div>
                }

                @if (row.waits > 0 || row.steals > 0) {
                  <div class="dm-agent-row dm-agent-contention-note">
                    <mat-icon fontSet="material-symbols-outlined">bolt</mat-icon>
                    <span>{{ row.waits }} wait{{ row.waits === 1 ? '' : 's' }} · {{ row.steals }} steal{{ row.steals === 1 ? '' : 's' }}</span>
                  </div>
                }

                <a class="dm-recent-actions-link" [routerLink]="['/timeline']" data-testid="agent-timeline-link">
                  <mat-icon fontSet="material-symbols-outlined">history</mat-icon>
                  Recent actions
                </a>
              </mat-card-content>
            </mat-card>
          }
        </div>
      }

      <h2 class="dm-section-h">Contention</h2>
      @if (contention().hotspots.length === 0) {
        <dm-empty icon="bolt" title="No lock contention"
          hint="Hotspots appear when multiple agents wait for or steal an app's lock. Nothing to show yet." data-testid="contention-empty"></dm-empty>
      } @else {
        <div class="dm-contention-list" data-testid="contention-section">
          @for (h of contention().hotspots; track h.app) {
            <div class="dm-contention-row" data-testid="contention-hotspot" [attr.data-app]="h.app">
              <a [routerLink]="['/apps', h.app]" class="dm-app-link dm-contention-app">{{ h.app }}</a>
              <span class="dm-contention-stat"><mat-icon fontSet="material-symbols-outlined">hourglass_top</mat-icon>{{ h.waits }} wait{{ h.waits === 1 ? '' : 's' }}</span>
              <span class="dm-contention-stat"><mat-icon fontSet="material-symbols-outlined">swap_horiz</mat-icon>{{ h.steals }} steal{{ h.steals === 1 ? '' : 's' }}
                @if (h.stealsAfterExpiry > 0) { <span class="dm-contention-substat">({{ h.stealsAfterExpiry }} after expiry)</span> }
              </span>
              <span class="dm-contention-stat"><mat-icon fontSet="material-symbols-outlined">timer</mat-icon>longest hold {{ duration(h.longestHoldMs) }}</span>
            </div>
          }
        </div>
      }
    } @else if (agents().length === 0) {
      <dm-empty icon="badge" title="No active agents"
        hint="Agents appear here within a few seconds of their first daimon call. Try &#96;daimon list&#96; from a terminal."></dm-empty>
    } @else {
      <!-- Pre-v1.6 daemon: no roster/contention in the /api/agents response. -->
      <div class="dm-agents-grid">
        @for (a of agents(); track a.id) {
          <mat-card class="dm-agent-card" [class.dm-agent-self]="a.id === self()">
            <mat-card-header>
              <mat-card-title>
                <dm-mono>{{ a.id }}</dm-mono>
                @if (a.id === self()) { <span class="dm-tag dm-tag-self">you</span> }
              </mat-card-title>
              <mat-card-subtitle>
                {{ a.callCount }} calls Â· last seen {{ rel(a.lastSeen) }} Â· first seen {{ rel(a.firstSeen) }}
              </mat-card-subtitle>
            </mat-card-header>
            <mat-card-content>
              @if (a.cwd) {
                <div class="dm-agent-row"><mat-icon fontSet="material-symbols-outlined">folder_open</mat-icon><dm-mono>{{ a.cwd }}</dm-mono></div>
              }
              @if (locksForAgent(a.id).length > 0) {
                <div class="dm-agent-locks">
                  <h4>Holds {{ locksForAgent(a.id).length }} lock{{ locksForAgent(a.id).length === 1 ? '' : 's' }}</h4>
                  @for (lk of locksForAgent(a.id); track lk.app) {
                    <div class="dm-lock-row">
                      <mat-icon fontSet="material-symbols-outlined" class="dm-lock-icon">lock</mat-icon>
                      <a [routerLink]="['/apps', lk.app]" class="dm-app-link">{{ lk.app }}</a>
                      <span class="dm-lock-ttl">expires in {{ ttl(lk.expiresAt) }}</span>
                    </div>
                  }
                </div>
              } @else {
                <div class="dm-agent-row dm-agent-row-muted">
                  <mat-icon fontSet="material-symbols-outlined">lock_open</mat-icon>
                  <span>No active locks</span>
                </div>
              }
            </mat-card-content>
          </mat-card>
        }
      </div>
    }

    @if (orphanLocks().length > 0) {
      <h2 class="dm-section-h">Locks held by inactive agents</h2>
      <div class="dm-orphan-list">
        @for (lk of orphanLocks(); track lk.app) {
          <div class="dm-orphan-row">
            <mat-icon fontSet="material-symbols-outlined" class="dm-lock-icon">lock_clock</mat-icon>
            <a [routerLink]="['/apps', lk.app]" class="dm-app-link">{{ lk.app }}</a>
            <dm-mono>{{ lk.agent }}</dm-mono>
            <span class="dm-lock-ttl">expires in {{ ttl(lk.expiresAt) }}</span>
          </div>
        }
      </div>
    }

    <p class="dm-advisory-note" data-testid="advisory-footnote">
      <mat-icon fontSet="material-symbols-outlined" matTooltip="Any caller can send any X-Daimon-Agent value — treat ids as labels, not credentials.">info</mat-icon>
      Agent ids are self-declared headers, not verified identities.
    </p>
  `,
  styles: [`
    :host { display: block; padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; }
    .dm-page-header h1 { font: 500 1.5rem/2rem Roboto; margin: 0; color: var(--dm-color-fg); }
    .dm-count { color: var(--dm-color-fg-muted); font-weight: 400; }
    .dm-page-sub { color: var(--dm-color-fg-muted); font-size: .875rem; margin-top: .25rem; }
    .dm-agents-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr)); }
    .dm-agent-card { border: 1px solid var(--dm-color-border); }
    .dm-agent-self { border-color: var(--dm-color-primary); box-shadow: 0 0 0 1px var(--dm-color-primary); }
    .dm-agent-row { display: flex; align-items: center; gap: .5rem; margin: .375rem 0; font-size: .875rem; color: var(--dm-color-fg); }
    .dm-agent-row mat-icon { font-size: 18px; width: 18px; height: 18px; color: var(--dm-color-fg-muted); }
    .dm-agent-row-muted { color: var(--dm-color-fg-muted); font-style: italic; }
    .dm-agent-contention-note { color: var(--dm-color-accent); }
    .dm-agent-contention-note mat-icon { color: var(--dm-color-accent); }
    .dm-agent-actions { margin-top: .5rem; padding-top: .5rem; border-top: 1px dashed var(--dm-color-border); }
    .dm-agent-actions h4, .dm-agent-locks h4 { font: 500 .75rem/1rem Roboto; text-transform: uppercase; letter-spacing: .05rem; color: var(--dm-color-fg-muted); margin: 0 0 .375rem; }
    .dm-agent-actions mat-chip-set { --mat-chip-container-height: 24px; }
    .dm-agent-locks { margin-top: .5rem; padding-top: .5rem; border-top: 1px dashed var(--dm-color-border); }
    .dm-lock-row, .dm-orphan-row { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; font-size: .875rem; flex-wrap: wrap; }
    .dm-lock-icon { font-size: 18px; width: 18px; height: 18px; color: var(--dm-color-accent); }
    .dm-app-link { color: var(--dm-color-primary); text-decoration: underline; text-underline-offset: 2px; font-weight: 500; }
    .dm-app-link:hover { text-decoration: underline; }
    .dm-lock-ttl { color: var(--dm-color-fg-muted); font-size: .75rem; margin-left: auto; }
    .dm-tag { display: inline-block; margin-left: .5rem; padding: 1px 8px; border-radius: 999px; font: 500 .6875rem/1rem Roboto; letter-spacing: .05rem; text-transform: uppercase; }
    .dm-tag-self { background: color-mix(in oklch, var(--dm-color-primary) var(--dm-badge-tint), transparent); color: var(--dm-color-primary); }
    .dm-tag-unknown { background: color-mix(in oklch, var(--dm-color-error) var(--dm-badge-tint), transparent); color: var(--dm-color-error); }
    .dm-tag-active { background: color-mix(in oklch, var(--dm-color-primary) var(--dm-badge-tint), transparent); color: var(--dm-color-primary); }
    .dm-tag-idle { background: var(--dm-color-surface-3); color: var(--dm-color-fg-muted); }
    .dm-section-h { font: 500 1rem/1.5rem Roboto; margin: 1.5rem 0 .5rem; color: var(--dm-color-fg-muted); }
    .dm-orphan-list { display: flex; flex-direction: column; gap: .25rem; border: 1px solid var(--dm-color-border); border-radius: 12px; padding: .5rem 1rem; }
    .dm-recent-actions-link {
      display: inline-flex; align-items: center; gap: .375rem; margin-top: .75rem;
      font: 500 .8125rem/1.25rem Roboto; color: var(--dm-color-primary); text-decoration: none;
    }
    .dm-recent-actions-link mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .dm-recent-actions-link:hover { text-decoration: underline; }
    .dm-contention-list { display: flex; flex-direction: column; gap: .25rem; border: 1px solid var(--dm-color-border); border-radius: 12px; padding: .25rem 1rem; }
    .dm-contention-row { display: flex; align-items: center; gap: 1rem; padding: .5rem 0; flex-wrap: wrap; font-size: .875rem; border-bottom: 1px solid color-mix(in oklch, var(--dm-color-border) 50%, transparent); }
    .dm-contention-row:last-child { border-bottom: none; }
    .dm-contention-app { min-width: 120px; }
    .dm-contention-stat { display: inline-flex; align-items: center; gap: .25rem; color: var(--dm-color-fg-muted); }
    .dm-contention-stat mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .dm-contention-substat { color: var(--dm-color-error); margin-left: .25rem; }
    .dm-advisory-note {
      display: flex; align-items: center; gap: .5rem; margin-top: 1.5rem; padding-top: 1rem;
      border-top: 1px dashed var(--dm-color-border);
      font: 400 .75rem/1rem Roboto; color: var(--dm-color-fg-muted);
    }
    .dm-advisory-note mat-icon { font-size: 16px; width: 16px; height: 16px; }
    @media (max-width: 480px) {
      :host { padding: 1rem; }
      .dm-contention-row { flex-direction: column; align-items: flex-start; gap: .375rem; }
    }
  `],
})
export class AgentsPageComponent implements OnInit, OnDestroy {
  protected readonly api = inject(DaimonApi);
  protected readonly agents = signal<AgentRecord[]>([]);
  protected readonly locks = signal<Record<string, LockSnapshot>>({});
  protected readonly self = signal<string | null>(null);
  protected readonly now = signal<number>(Date.now());

  // Agent Ledger (M123-M126, v1.6 — experimental). `rosterSupported` is only
  // false when a pre-v1.6 daemon's /api/agents response omits `roster`
  // entirely — an empty roster from a v1.6+ daemon is a real (rare) empty
  // state, not a fallback trigger.
  protected readonly roster = signal<AgentRosterRow[]>([]);
  protected readonly rosterSupported = signal<boolean>(true);
  protected readonly contention = signal<{ hotspots: ContentionHotspot[] }>({ hotspots: [] });

  protected readonly orphanLocks = computed(() => {
    const active = this.rosterSupported()
      ? new Set(this.roster().filter(r => r.active).map(r => r.id))
      : new Set(this.agents().map(a => a.id));
    const out: (LockSnapshot & { app: string })[] = [];
    for (const [app, lk] of Object.entries(this.locks())) {
      if (!active.has(lk.agent)) out.push({ app, ...lk });
    }
    return out.sort((a, b) => a.app.localeCompare(b.app));
  });

  private pollTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
    this.tickTimer = setInterval(() => this.now.set(Date.now()), 1000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  protected locksForAgent(id: string): (LockSnapshot & { app: string })[] {
    const out: (LockSnapshot & { app: string })[] = [];
    for (const [app, lk] of Object.entries(this.locks())) {
      if (lk.agent === id) out.push({ app, ...lk });
    }
    return out.sort((a, b) => a.app.localeCompare(b.app));
  }

  // Sorted for stable, meaningful chip order: busiest action first, then
  // alphabetical for ties.
  protected actionEntries(actions: Record<string, number>): [string, number][] {
    return Object.entries(actions ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  protected rel(ts: number): string { return relTime(ts, this.now()); }
  protected relOrNever(ts: number | null): string { return ts == null ? 'never' : relTime(ts, this.now()); }
  protected ttl(ts: number): string { return ttl(ts, this.now()); }
  protected duration(ms: number): string { return duration(ms); }

  private async refresh(): Promise<void> {
    const r = await this.api.getAgents();
    this.agents.set(r.agents);
    this.locks.set(r.locks);
    this.self.set(r.self);
    if (r.roster) {
      this.roster.set(r.roster);
      this.rosterSupported.set(true);
    } else {
      this.rosterSupported.set(false);
    }
    this.contention.set(r.contention ?? { hotspots: [] });
  }
}
