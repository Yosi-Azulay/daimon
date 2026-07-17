import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DaimonApi } from './daimon-api';
import { StatusPillComponent, EmptyStateComponent, MonoComponent } from './ui-primitives';
import {
  LOG_LEVELS,
  buildTextPredicate,
  countsByLevel,
  formatStormBanner,
  matchesLevel,
  searchPrefillQuery,
  stormBannerVisible,
  toggleLevel,
  type LogLevel,
} from './logs-page-helpers';

interface LogRow {
  ts: number;
  line: string;
  level: LogLevel | null;
}

const MAX_LINES = 1000;
const ANSI = /\x1b\[[0-9;]*m/g;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;'
  ));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Component({
  selector: 'dm-logs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ScrollingModule,
    MatFormFieldModule, MatSelectModule, MatInputModule,
    MatButtonModule, MatIconModule, MatTooltipModule,
    StatusPillComponent, EmptyStateComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>
          Logs
          @if (currentApp(); as app) {
            <span class="dm-sep">·</span>
            <dm-mono><span class="dm-app">{{ app.name }}</span></dm-mono>
            <dm-status-pill [status]="app.status" [health]="app.health"></dm-status-pill>
          }
        </h1>
        <div class="dm-page-sub">
          <span class="dm-conn" [class.dm-conn-on]="api.connected()">
            <span class="dm-conn-dot"></span>
            {{ api.connected() ? 'stream connected' : 'disconnected' }}
          </span>
          @if (name) { <span class="dm-sep">·</span> <span>{{ filtered().length }} / {{ lines().length }} lines</span> }
        </div>
      </div>
      @if (name) {
        <div class="dm-actions">
          <button mat-stroked-button (click)="togglePause()" [matTooltip]="paused() ? 'Resume' : 'Pause'">
            <mat-icon>{{ paused() ? 'play_arrow' : 'pause' }}</mat-icon>
            {{ paused() ? 'Resume' : 'Pause' }}
          </button>
          <button mat-stroked-button (click)="copyAll()" matTooltip="Copy buffer">
            <mat-icon>content_copy</mat-icon> Copy
          </button>
          <button mat-stroked-button (click)="clear()" matTooltip="Clear buffer">
            <mat-icon>delete_sweep</mat-icon> Clear
          </button>
        </div>
      }
    </div>

    @if (!name) {
      <div class="dm-picker">
        <h3>Pick an app to tail</h3>
        @if (api.apps().length === 0) {
          <dm-empty icon="apps" title="No apps registered" hint="Add apps to your daimon config to see logs"></dm-empty>
        } @else {
          <mat-form-field appearance="outline" class="dm-picker-field">
            <mat-label>Application</mat-label>
            <mat-select (selectionChange)="goto($event.value)">
              @for (a of api.apps(); track a.name) {
                <mat-option [value]="a.name">{{ a.name }} ({{ a.status }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
      </div>
    } @else {
      @if (showStormBanner(); as storm) {
        <div class="dm-banner dm-banner-warn" role="alert">
          <mat-icon fontSet="material-symbols-outlined">local_fire_department</mat-icon>
          <div>{{ stormText(storm) }}</div>
          <div class="dm-banner-actions">
            <button mat-stroked-button (click)="applyStormFilter()">View errors</button>
            <button type="button" class="dm-banner-dismiss" (click)="dismissStorm()" aria-label="Dismiss storm banner" title="Dismiss">×</button>
          </div>
        </div>
      }

      <div class="dm-levels" role="group" aria-label="Filter by log level">
        @for (lvl of levels; track lvl) {
          <button type="button" class="dm-lvl-chip" [attr.data-lvl]="lvl"
                  [class.dm-on]="selectedLevel() === lvl"
                  [attr.aria-pressed]="selectedLevel() === lvl"
                  [attr.aria-label]="lvl + ' level, ' + levelCounts()[lvl] + ' lines' + (selectedLevel() === lvl ? ' — click to clear filter' : ' — click to filter')"
                  (click)="toggleLevelChip(lvl)">
            <span class="dm-lvl-dot"></span>{{ lvl }}
            <span class="dm-lvl-count">{{ levelCounts()[lvl] }}</span>
          </button>
        }
      </div>

      <div class="dm-toolbar">
        <mat-form-field appearance="outline" class="dm-filter">
          <mat-label>Filter</mat-label>
          <input matInput [ngModel]="filter()" (ngModelChange)="filter.set($event)"
                 [placeholder]="useRegex() ? 'regex (case-insensitive)' : 'case-insensitive substring'" />
          @if (filter()) {
            <button matSuffix mat-icon-button aria-label="Clear filter" (click)="filter.set('')"><mat-icon>close</mat-icon></button>
          }
        </mat-form-field>
        <button mat-stroked-button [class.dm-on]="useRegex()" (click)="useRegex.set(!useRegex())"
                [matTooltip]="useRegex() ? 'Regex on — click to use substring' : 'Substring — click to use regex'">
          <mat-icon>{{ useRegex() ? 'check_circle' : 'pattern' }}</mat-icon>
          .* regex
        </button>
        <button mat-stroked-button (click)="jumpToNextError()" [disabled]="!hasNextError()"
                matTooltip="Jump to next error">
          <mat-icon>error</mat-icon> Next error
        </button>
        <button mat-stroked-button (click)="openSearch()" aria-label="Search logs in the command palette"
                matTooltip="Search this filter in the command palette">
          <mat-icon>travel_explore</mat-icon> Search
        </button>
        @if (regexError(); as re) {
          <span class="dm-rxerr" matTooltip="Invalid regex">
            <mat-icon>warning</mat-icon> {{ re }}
          </span>
        }
        @if (!stuckToBottom()) {
          <button mat-flat-button color="primary" class="dm-jump" (click)="jumpToLatest()">
            <mat-icon>arrow_downward</mat-icon> Jump to latest
          </button>
        }
      </div>

      @if (filtered().length === 0 && lines().length === 0) {
        <dm-empty icon="terminal" title="No logs yet" hint="Start the app or wait for output">
          @if (currentApp()?.status === 'stopped') {
            <button mat-flat-button color="primary" (click)="startApp()">
              <mat-icon>play_arrow</mat-icon> Start app
            </button>
          }
        </dm-empty>
      } @else if (filtered().length === 0) {
        <dm-empty icon="filter_alt_off" title="No matches" hint="Adjust your filter to see lines"></dm-empty>
      } @else {
        <cdk-virtual-scroll-viewport
          #viewport
          itemSize="22"
          class="dm-viewport"
          tabindex="0"
          aria-label="Log lines (scrollable)"
          (scrolledIndexChange)="onScroll()">
          <div
            *cdkVirtualFor="let row of filtered(); trackBy: trackTs; templateCacheSize: 0"
            class="dm-row"
            [attr.data-level]="row.level ?? 'none'">
            <span class="dm-ts">{{ fmtTs(row.ts) }}</span>
            <span class="dm-line" [innerHTML]="render(row.line)"></span>
          </div>
        </cdk-virtual-scroll-viewport>
      }
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-page-header h1 { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .dm-sep { color: var(--mat-sys-outline); margin: 0 .15rem; }
    .dm-app { color: var(--mat-sys-primary); font-weight: 500; }
    .dm-actions { display: flex; gap: .5rem; align-items: flex-end; }
    .dm-conn { display: inline-flex; align-items: center; gap: .35rem; }
    .dm-conn-dot {
      width: 7px; height: 7px; border-radius: 999px;
      background: var(--mat-sys-outline);
    }
    .dm-conn-on .dm-conn-dot {
      background: var(--mat-sys-primary);
      box-shadow: 0 0 0 3px color-mix(in oklch, var(--mat-sys-primary) 24%, transparent);
    }
    .dm-picker { max-width: 32rem; margin: 2rem auto; text-align: center; }
    .dm-picker h3 { font-weight: 400; color: var(--mat-sys-on-surface-variant); }
    .dm-picker-field { width: 100%; }
    .dm-banner {
      display: grid; grid-template-columns: auto 1fr auto; gap: .75rem; align-items: center;
      padding: 10px 16px; border-radius: 12px; margin-bottom: .75rem;
    }
    .dm-banner-warn {
      background: color-mix(in oklch, var(--mat-sys-error) 14%, transparent);
      color: var(--mat-sys-on-surface);
      border: 1px solid color-mix(in oklch, var(--mat-sys-error) 35%, transparent);
    }
    .dm-banner-warn mat-icon { color: var(--mat-sys-error); }
    .dm-banner-actions { display: flex; align-items: center; gap: .5rem; }
    .dm-banner-dismiss {
      background: transparent; border: 0; cursor: pointer;
      font-size: 1.25rem; line-height: 1; color: var(--mat-sys-on-surface-variant);
      padding: 4px 8px; border-radius: 999px;
    }
    .dm-banner-dismiss:hover { background: color-mix(in oklch, var(--mat-sys-on-surface) 8%, transparent); }
    .dm-levels { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .75rem; }
    .dm-lvl-chip {
      display: inline-flex; align-items: center; gap: .35rem;
      padding: 4px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface-variant);
      font: 500 .75rem/1rem Roboto; text-transform: capitalize;
    }
    /* WCAG AA: chip TEXT stays on-surface (the tinted per-level foregrounds
       failed 4.5:1 at 12px on the token background) — the level hue lives on
       the dot and the active border via --dm-lvl only. */
    .dm-lvl-chip .dm-lvl-count { font-family: var(--dm-mono); color: var(--mat-sys-on-surface); }
    .dm-lvl-chip { --dm-lvl: var(--mat-sys-outline); color: var(--mat-sys-on-surface); }
    .dm-lvl-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--dm-lvl); opacity: .75; }
    .dm-lvl-chip[data-lvl="error"] { --dm-lvl: var(--mat-sys-error); }
    .dm-lvl-chip[data-lvl="warn"] { --dm-lvl: var(--mat-sys-tertiary); }
    .dm-lvl-chip[data-lvl="info"] { --dm-lvl: var(--mat-sys-primary); }
    .dm-lvl-chip.dm-on {
      background: color-mix(in oklch, var(--dm-lvl) 14%, var(--mat-sys-surface-container-low));
      border-color: var(--dm-lvl);
    }
    .dm-lvl-chip.dm-on .dm-lvl-dot { opacity: 1; }
    .dm-toolbar {
      display: flex; gap: 1rem; align-items: center;
      /* 390px: wrap instead of squeezing the filter input to zero width. */
      flex-wrap: wrap;
      margin-bottom: .75rem;
    }
    .dm-filter { flex: 1; max-width: 28rem; min-width: 14rem; }
    .dm-jump { margin-left: auto; }
    button.dm-on { color: var(--mat-sys-primary); border-color: var(--mat-sys-primary); }
    .dm-rxerr { display: inline-flex; align-items: center; gap: .25rem; color: var(--mat-sys-error); font: 500 .8125rem/1rem Roboto; }
    .dm-rxerr mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .dm-viewport {
      height: calc(100vh - 13rem);
      min-height: 24rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px;
      background: var(--mat-sys-surface-container-lowest);
      contain: strict;
    }
    .dm-row {
      display: flex; align-items: center; gap: .75rem;
      height: 22px; padding: 0 .75rem;
      font-family: var(--dm-mono);
      font-size: .8125rem;
      line-height: 22px;
      white-space: pre;
      border-left: 3px solid transparent;
      color: var(--mat-sys-on-surface);
    }
    .dm-row[data-level="error"] {
      border-left-color: var(--mat-sys-error);
      background: color-mix(in oklch, var(--mat-sys-error) 6%, transparent);
    }
    .dm-row[data-level="warn"] {
      border-left-color: var(--mat-sys-tertiary);
      background: color-mix(in oklch, var(--mat-sys-tertiary) 5%, transparent);
    }
    .dm-ts {
      color: var(--mat-sys-on-surface-variant);
      flex: 0 0 auto;
    }
    .dm-line {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dm-line ::ng-deep mark {
      background: color-mix(in oklch, var(--mat-sys-tertiary) 35%, transparent);
      color: var(--mat-sys-on-tertiary-container);
      padding: 0 2px; border-radius: 3px;
    }
  `],
})
export class LogsPageComponent implements OnChanges, OnDestroy {
  @Input() name = '';
  // `?from=search` (M102 deep-link, see command-palette-helpers.ts's
  // routeForHit): bound automatically by withComponentInputBinding(). A
  // search-hit landing here clears any active level/regex filter so the
  // live buffer isn't hidden behind a stale filter from a previous visit.
  @Input() from?: string;
  readonly api = inject(DaimonApi);
  private readonly router = inject(Router);

  readonly levels = LOG_LEVELS;

  @ViewChild('viewport') viewport?: CdkVirtualScrollViewport;

  readonly lines = signal<LogRow[]>([]);
  readonly filter = signal('');
  readonly useRegex = signal(false);
  readonly selectedLevel = signal<LogLevel | null>(null);
  readonly paused = signal(false);
  readonly stuckToBottom = signal(true);

  private buffered: LogRow[] = [];
  private stop?: () => void;
  private rafScheduled = false;
  // The storm banner stays dismissed for the storm episode it was dismissed
  // for (keyed by the marker's `since`) — a NEW storm episode (a fresh
  // `since`) re-shows it rather than staying silenced forever.
  private readonly stormDismissedSince = signal<number | null>(null);

  readonly currentApp = computed(() => this.name ? this.api.byName(this.name) : undefined);

  readonly levelCounts = computed<Record<LogLevel, number>>(() => countsByLevel(this.lines()));

  readonly showStormBanner = computed(() => {
    const storm = this.currentApp()?.logStorm;
    return storm && stormBannerVisible(storm, this.stormDismissedSince()) ? storm : null;
  });

  // Single derived pair so the predicate and the user-facing regex error are
  // computed together without ever writing a signal from inside `computed`.
  private readonly filterState = computed<{ pred: ((s: string) => boolean) | null; error: string | null }>(() =>
    buildTextPredicate(this.filter(), this.useRegex()),
  );

  readonly regexError = computed<string | null>(() => this.filterState().error);

  readonly filtered = computed<LogRow[]>(() => {
    const { pred } = this.filterState();
    const level = this.selectedLevel();
    const rows = this.lines();
    return rows.filter(r => matchesLevel(r.level, level) && (!pred || pred(r.line)));
  });

  readonly hasNextError = computed<boolean>(() => this.filtered().some(r => r.level === 'error'));

  constructor() {
    effect(() => {
      this.filtered();
      if (this.stuckToBottom()) this.scrollSoon();
    });
  }

  ngOnChanges(ch: SimpleChanges): void {
    if ('name' in ch) {
      this.teardown();
      this.lines.set([]);
      this.buffered = [];
      this.filter.set('');
      this.selectedLevel.set(null);
      this.stuckToBottom.set(true);
      if (this.name) this.openStream();
    } else if ('from' in ch && this.from === 'search') {
      // Same app, but a search-hit deep-link just re-landed here (the router
      // doesn't re-instantiate the component for a query-param-only
      // navigation) — clear filters without tearing down the live stream.
      this.filter.set('');
      this.selectedLevel.set(null);
    }
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  private openStream(): void {
    const name = this.name;
    this.stop = this.api.openLogStream(name, ({ ts, line, level }) => {
      const clean = (line ?? '').replace(ANSI, '');
      const row: LogRow = { ts, line: clean, level };
      if (this.paused()) {
        this.buffered.push(row);
        if (this.buffered.length > MAX_LINES) this.buffered.splice(0, this.buffered.length - MAX_LINES);
        return;
      }
      this.append([row]);
    });
  }

  private append(rows: LogRow[]): void {
    this.lines.update(prev => {
      const next = prev.concat(rows);
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }

  private teardown(): void {
    this.stop?.();
    this.stop = undefined;
  }

  togglePause(): void {
    const next = !this.paused();
    this.paused.set(next);
    if (!next && this.buffered.length) {
      const flush = this.buffered;
      this.buffered = [];
      this.append(flush);
    }
  }

  clear(): void {
    this.lines.set([]);
    this.buffered = [];
  }

  async copyAll(): Promise<void> {
    const text = this.lines().map(r => `${fmtTime(r.ts)} ${r.line}`).join('\n');
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  onScroll(): void {
    const vp = this.viewport;
    if (!vp) return;
    const end = vp.getRenderedRange().end;
    const total = vp.getDataLength();
    this.stuckToBottom.set(total === 0 || end >= total - 1);
  }

  jumpToLatest(): void {
    this.stuckToBottom.set(true);
    this.scrollSoon();
  }

  jumpToNextError(): void {
    const vp = this.viewport;
    if (!vp) return;
    const rows = this.filtered();
    if (rows.length === 0) return;
    const start = Math.max(0, vp.getRenderedRange().end);
    let found = -1;
    for (let i = start; i < rows.length; i++) if (rows[i].level === 'error') { found = i; break; }
    if (found === -1) {
      for (let i = 0; i < Math.min(start, rows.length); i++) if (rows[i].level === 'error') { found = i; break; }
    }
    if (found === -1) return;
    this.stuckToBottom.set(false);
    vp.scrollToIndex(found, 'smooth');
  }

  toggleLevelChip(lvl: LogLevel): void {
    this.selectedLevel.set(toggleLevel(this.selectedLevel(), lvl));
  }

  stormText(storm: { observedPerMin: number; baselinePerMin: number | null }): string {
    return formatStormBanner(storm);
  }

  dismissStorm(): void {
    const storm = this.currentApp()?.logStorm;
    if (storm) this.stormDismissedSince.set(storm.since);
  }

  // "View errors" on the storm banner: apply the error-level chip so the
  // buffer narrows to what's actually storming, then dismiss the banner —
  // its job (getting you to the errors) is done once you're looking at them.
  applyStormFilter(): void {
    this.selectedLevel.set('error');
    this.dismissStorm();
  }

  // M102 "jump to search": opens the command palette straight into search
  // mode, pre-filled with the current filter text (M85 deep-link plumbing —
  // see command-palette.ts's `daimon:cmdk` listener).
  openSearch(): void {
    const query = searchPrefillQuery(this.filter());
    window.dispatchEvent(new CustomEvent('daimon:cmdk', { detail: { query } }));
  }

  private scrollSoon(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      const vp = this.viewport;
      if (!vp) return;
      const total = vp.getDataLength();
      if (total > 0) vp.scrollToIndex(total, 'auto');
    });
  }

  goto(name: string): void {
    this.router.navigateByUrl(`/logs/${encodeURIComponent(name)}`);
  }

  startApp(): void {
    if (this.name) void this.api.startApp(this.name);
  }

  fmtTs(ts: number): string { return fmtTime(ts); }
  trackTs = (_i: number, r: LogRow) => r.ts + ':' + r.line.length;

  render(line: string): string {
    const f = this.filter();
    const esc = escapeHtml(line);
    if (!f) return esc;
    try {
      const rx = this.useRegex() ? new RegExp(f, 'gi') : new RegExp(escapeRegex(f), 'gi');
      return esc.replace(rx, m => `<mark>${m}</mark>`);
    } catch {
      return esc;
    }
  }
}
