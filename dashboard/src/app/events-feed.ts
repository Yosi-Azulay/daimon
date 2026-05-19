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
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DaimonApi, EventRecord } from './daimon-api';
import { EmptyStateComponent, MonoComponent } from './ui-primitives';

const KNOWN_TYPES = ['status', 'health', 'error', 'compile', 'log'] as const;
type EventType = typeof KNOWN_TYPES[number];

function relTime(ms: number, now: number): string {
  const d = Math.max(0, Math.floor((now - ms) / 1000));
  if (d < 1) return 'just now';
  if (d < 60) return `${d}s ago`;
  const m = Math.floor(d / 60);
  const s = d % 60;
  if (m < 60) return s ? `${m}m ${s}s ago` : `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

@Component({
  selector: 'dm-events-feed',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatFormFieldModule, MatSelectModule, MatInputModule,
    MatChipsModule, MatButtonModule, MatIconModule, MatTooltipModule,
    EmptyStateComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Events <span class="dm-count">· {{ liveEvents().length }}</span></h1>
        <div class="dm-page-sub">
          <span class="dm-conn" [class.dm-conn-on]="api.connected()">
            <span class="dm-conn-dot"></span>
            {{ api.connected() ? 'live' : 'disconnected' }}
          </span>
          @if (paused()) { <span class="dm-sep">·</span> <span class="dm-paused-tag">paused</span> }
          @if (paused() && pendingCount() > 0) {
            <span class="dm-sep">·</span>
            <span>{{ pendingCount() }} new while paused</span>
          }
        </div>
      </div>
      <div class="dm-header-actions">
        <button mat-stroked-button (click)="togglePause()" [matTooltip]="paused() ? 'Resume feed' : 'Pause feed'">
          <mat-icon>{{ paused() ? 'play_arrow' : 'pause' }}</mat-icon>
          {{ paused() ? 'Resume' : 'Pause' }}
        </button>
      </div>
    </div>

    <div class="dm-toolbar">
      <mat-form-field appearance="outline" class="dm-app-filter">
        <mat-label>App</mat-label>
        <mat-select [ngModel]="appFilter()" (ngModelChange)="appFilter.set($event)">
          <mat-option [value]="''">All apps</mat-option>
          @for (a of api.apps(); track a.name) {
            <mat-option [value]="a.name">{{ a.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline" class="dm-text-filter">
        <mat-label>Search</mat-label>
        <input matInput [ngModel]="textFilter()" (ngModelChange)="textFilter.set($event)" placeholder="filter message / app" />
        @if (textFilter()) {
          <button matSuffix mat-icon-button (click)="textFilter.set('')"><mat-icon>close</mat-icon></button>
        }
      </mat-form-field>

      <div class="dm-type-chips">
        @for (t of types; track t) {
          <button
            class="dm-chip"
            [attr.data-kind]="t"
            [class.dm-chip-active]="typeFilter().has(t)"
            (click)="toggleType(t)">
            {{ t }}
          </button>
        }
        @if (typeFilter().size > 0) {
          <button class="dm-chip dm-chip-clear" (click)="clearTypes()">
            <mat-icon>close</mat-icon>
          </button>
        }
      </div>
    </div>

    @if (rendered().length === 0) {
      @if (liveEvents().length === 0) {
        <dm-empty
          icon="timeline"
          title="Quiet"
          hint="No events in this session — start an app to see status transitions, errors, and compiles">
        </dm-empty>
      } @else {
        <dm-empty icon="filter_alt_off" title="No matches" hint="Adjust filters to see events"></dm-empty>
      }
    } @else {
      <ol class="dm-list">
        @for (item of rendered(); track item.key) {
          @if (item.divider) {
            <li class="dm-divider">
              <span class="dm-divider-label">{{ item.gapLabel }}</span>
            </li>
          }
          <li
            class="dm-event"
            [attr.data-kind]="item.ev.type"
            [class.dm-flash]="item.flash">
            <span class="dm-time" [matTooltip]="absTime(item.ev.ts)">
              <dm-mono>{{ rel(item.ev.ts) }}</dm-mono>
            </span>
            <span class="dm-type" [attr.data-kind]="item.ev.type">{{ item.ev.type }}</span>
            @if (item.ev.app) {
              <a class="dm-app" [routerLink]="['/apps', item.ev.app]"><dm-mono>{{ item.ev.app }}</dm-mono></a>
            } @else {
              <span class="dm-app dm-app-empty">—</span>
            }
            <span class="dm-msg">
              @if (item.ev.type === 'status' && (item.ev.from || item.ev.to)) {
                <dm-mono>{{ item.ev.from ?? '?' }}</dm-mono>
                <span class="dm-arrow">→</span>
                <dm-mono>{{ item.ev.to ?? '?' }}</dm-mono>
              } @else {
                {{ item.ev.message ?? '' }}
              }
            </span>
          </li>
        }
      </ol>
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-count { color: var(--mat-sys-on-surface-variant); font-weight: 400; }
    .dm-conn { display: inline-flex; align-items: center; gap: .35rem; }
    .dm-conn-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--mat-sys-outline); }
    .dm-conn-on .dm-conn-dot {
      background: var(--mat-sys-primary);
      box-shadow: 0 0 0 3px color-mix(in oklch, var(--mat-sys-primary) 24%, transparent);
    }
    .dm-sep { color: var(--mat-sys-outline); margin: 0 .15rem; }
    .dm-paused-tag { color: var(--mat-sys-tertiary); font-weight: 500; }
    .dm-toolbar {
      display: flex; flex-wrap: wrap; gap: .75rem;
      align-items: center; margin-bottom: .5rem;
    }
    .dm-app-filter { width: 12rem; }
    .dm-text-filter { flex: 1; min-width: 14rem; max-width: 28rem; }
    .dm-type-chips { display: flex; gap: .35rem; flex-wrap: wrap; }
    .dm-chip {
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
      border-radius: 999px; padding: 4px 12px;
      font: 500 .75rem/1rem Roboto;
      cursor: pointer; letter-spacing: .025rem;
    }
    .dm-chip:hover { background: var(--mat-sys-surface-container-high); }
    .dm-chip-active { color: var(--mat-sys-on-surface); }
    .dm-chip-clear { display: inline-flex; align-items: center; padding: 2px 8px; }
    .dm-chip-clear mat-icon { font-size: 16px; width: 16px; height: 16px; }

    .dm-list {
      list-style: none; margin: 0; padding: 0;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px;
      background: var(--mat-sys-surface-container-lowest);
      overflow: hidden;
    }
    .dm-event {
      display: grid;
      grid-template-columns: 7.5rem max-content 10rem 1fr;
      gap: .75rem; align-items: center;
      height: 28px; padding: 0 .75rem;
      border-top: 1px solid var(--mat-sys-outline-variant);
      font-size: .8125rem;
      color: var(--mat-sys-on-surface);
    }
    .dm-event:first-child { border-top: 0; }
    .dm-time { color: var(--mat-sys-on-surface-variant); }
    .dm-type {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 1px 8px; border-radius: 999px;
      font: 500 .6875rem/1rem Roboto; letter-spacing: .03rem;
      border: 1px solid var(--mat-sys-outline-variant);
      text-transform: lowercase;
      white-space: nowrap;
    }
    .dm-type[data-kind="status"], .dm-chip[data-kind="status"].dm-chip-active {
      background: color-mix(in oklch, var(--mat-sys-primary) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-primary) 30%, transparent);
      color: var(--mat-sys-primary);
    }
    .dm-type[data-kind="health"], .dm-chip[data-kind="health"].dm-chip-active {
      background: color-mix(in oklch, var(--mat-sys-secondary) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-secondary) 30%, transparent);
      color: var(--mat-sys-secondary);
    }
    .dm-type[data-kind="error"], .dm-chip[data-kind="error"].dm-chip-active {
      background: color-mix(in oklch, var(--mat-sys-error) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-error) 32%, transparent);
      color: var(--mat-sys-error);
    }
    .dm-type[data-kind="compile"], .dm-chip[data-kind="compile"].dm-chip-active {
      background: color-mix(in oklch, var(--mat-sys-tertiary) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-tertiary) 30%, transparent);
      color: var(--mat-sys-tertiary);
    }
    .dm-type[data-kind="log"], .dm-chip[data-kind="log"].dm-chip-active {
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
    }
    .dm-app {
      text-decoration: none; color: var(--mat-sys-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dm-app:hover { text-decoration: underline; }
    .dm-app-empty { color: var(--mat-sys-outline); }
    .dm-msg {
      color: var(--mat-sys-on-surface);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: .35rem;
    }
    .dm-arrow { color: var(--mat-sys-on-surface-variant); }
    .dm-divider {
      height: 18px;
      display: flex; align-items: center; justify-content: center;
      border-top: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
    }
    .dm-divider-label {
      font: 400 .6875rem/1rem Roboto;
      color: var(--mat-sys-on-surface-variant);
      letter-spacing: .04rem;
    }
    .dm-flash { animation: dm-event-pulse 600ms var(--dm-motion-easing); }
    @keyframes dm-event-pulse {
      0%   { background: color-mix(in oklch, var(--mat-sys-primary) 24%, transparent); }
      100% { background: transparent; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dm-flash { animation: none; }
    }
  `],
})
export class EventsFeedComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  readonly types = KNOWN_TYPES;

  readonly paused = signal(false);
  readonly appFilter = signal('');
  readonly textFilter = signal('');
  readonly typeFilter = signal<Set<EventType>>(new Set());
  readonly now = signal(Date.now());
  readonly snapshot = signal<EventRecord[] | null>(null);
  readonly lastSeenTs = signal(0);

  private tickTimer?: ReturnType<typeof setInterval>;

  readonly liveEvents = computed(() => this.snapshot() ?? this.api.events());

  readonly pendingCount = computed(() => {
    const snap = this.snapshot();
    if (!snap) return 0;
    const live = this.api.events();
    return Math.max(0, live.length - snap.length);
  });

  readonly rendered = computed(() => {
    const list = this.liveEvents();
    const app = this.appFilter();
    const text = this.textFilter().toLowerCase();
    const types = this.typeFilter();
    const lastSeen = this.lastSeenTs();

    const filtered: EventRecord[] = [];
    for (const ev of list) {
      if (app && ev.app !== app) continue;
      if (types.size && !types.has(ev.type as EventType)) continue;
      if (text) {
        const hay = `${ev.app ?? ''} ${ev.type} ${ev.message ?? ''} ${ev.from ?? ''} ${ev.to ?? ''}`.toLowerCase();
        if (!hay.includes(text)) continue;
      }
      filtered.push(ev);
    }

    const out: { key: string; ev: EventRecord; divider: boolean; gapLabel: string; flash: boolean }[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const ev = filtered[i];
      const prev = filtered[i + 1];
      const gapMs = prev ? ev.ts - prev.ts : 0;
      const divider = !!prev && gapMs > 30_000;
      out.push({
        key: `${ev.ts}:${i}`,
        ev,
        divider,
        gapLabel: divider ? gapLabel(gapMs) : '',
        flash: ev.ts > lastSeen,
      });
    }
    return out.sort((a, b) => b.ev.ts - a.ev.ts);
  });

  ngOnInit(): void {
    this.lastSeenTs.set(Date.now());
    this.tickTimer = setInterval(() => {
      this.now.set(Date.now());
      const live = this.api.events();
      if (live.length) this.lastSeenTs.set(live[live.length - 1].ts);
    }, 1000);
  }

  ngOnDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  togglePause(): void {
    if (this.paused()) {
      this.paused.set(false);
      this.snapshot.set(null);
    } else {
      this.snapshot.set(this.api.events().slice());
      this.paused.set(true);
    }
  }

  toggleType(t: EventType): void {
    this.typeFilter.update(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }

  clearTypes(): void {
    this.typeFilter.set(new Set());
  }

  rel(ts: number): string { return relTime(ts, this.now()); }
  absTime(ts: number): string { return new Date(ts).toLocaleString(); }
}

function gapLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s gap`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m gap`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m gap`;
}
