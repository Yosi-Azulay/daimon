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
import { DaimonApi, AgentRecord, LockSnapshot } from './daimon-api';
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
        <h1>Agents <span class="dm-count">Â· {{ agents().length }}</span></h1>
        <div class="dm-page-sub">
          @if (self()) {
            <span>You are <dm-mono>{{ self() }}</dm-mono></span>
          } @else {
            <span>Live view of every CLI / MCP / dashboard caller against this daemon</span>
          }
        </div>
      </div>
    </div>

    @if (agents().length === 0) {
      <dm-empty icon="badge" title="No active agents"
        hint="Agents appear here within a few seconds of their first daimon call. Try &#96;daimon list&#96; from a terminal."></dm-empty>
    } @else {
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
    }
  `,
  styles: [`
    :host { display: block; padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
    .dm-page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; }
    .dm-page-header h1 { font: 500 1.5rem/2rem Roboto; margin: 0; color: var(--mat-sys-on-surface); }
    .dm-count { color: var(--mat-sys-on-surface-variant); font-weight: 400; }
    .dm-page-sub { color: var(--mat-sys-on-surface-variant); font-size: .875rem; margin-top: .25rem; }
    .dm-agents-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr)); }
    .dm-agent-card { border: 1px solid var(--mat-sys-outline-variant); }
    .dm-agent-self { border-color: var(--mat-sys-primary); box-shadow: 0 0 0 1px var(--mat-sys-primary); }
    .dm-agent-row { display: flex; align-items: center; gap: .5rem; margin: .375rem 0; font-size: .875rem; color: var(--mat-sys-on-surface); }
    .dm-agent-row mat-icon { font-size: 18px; width: 18px; height: 18px; color: var(--mat-sys-on-surface-variant); }
    .dm-agent-row-muted { color: var(--mat-sys-on-surface-variant); font-style: italic; }
    .dm-agent-locks { margin-top: .5rem; padding-top: .5rem; border-top: 1px dashed var(--mat-sys-outline-variant); }
    .dm-agent-locks h4 { font: 500 .75rem/1rem Roboto; text-transform: uppercase; letter-spacing: .05rem; color: var(--mat-sys-on-surface-variant); margin: 0 0 .375rem; }
    .dm-lock-row, .dm-orphan-row { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; font-size: .875rem; }
    .dm-lock-icon { font-size: 18px; width: 18px; height: 18px; color: var(--mat-sys-tertiary); }
    .dm-app-link { color: var(--mat-sys-primary); text-decoration: underline; text-underline-offset: 2px; font-weight: 500; }
    .dm-app-link:hover { text-decoration: underline; }
    .dm-lock-ttl { color: var(--mat-sys-on-surface-variant); font-size: .75rem; margin-left: auto; }
    .dm-tag { display: inline-block; margin-left: .5rem; padding: 1px 8px; border-radius: 999px; font: 500 .6875rem/1rem Roboto; letter-spacing: .05rem; text-transform: uppercase; }
    .dm-tag-self { background: color-mix(in oklch, var(--mat-sys-primary) var(--dm-badge-tint), transparent); color: var(--mat-sys-primary); }
    .dm-section-h { font: 500 1rem/1.5rem Roboto; margin: 1.5rem 0 .5rem; color: var(--mat-sys-on-surface-variant); }
    .dm-orphan-list { display: flex; flex-direction: column; gap: .25rem; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: .5rem 1rem; }
  `],
})
export class AgentsPageComponent implements OnInit, OnDestroy {
  protected readonly api = inject(DaimonApi);
  protected readonly agents = signal<AgentRecord[]>([]);
  protected readonly locks = signal<Record<string, LockSnapshot>>({});
  protected readonly self = signal<string | null>(null);
  protected readonly now = signal<number>(Date.now());

  protected readonly orphanLocks = computed(() => {
    const active = new Set(this.agents().map(a => a.id));
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

  protected rel(ts: number): string { return relTime(ts, this.now()); }
  protected ttl(ts: number): string { return ttl(ts, this.now()); }

  private async refresh(): Promise<void> {
    const r = await this.api.getAgents();
    this.agents.set(r.agents);
    this.locks.set(r.locks);
    this.self.set(r.self);
  }
}
