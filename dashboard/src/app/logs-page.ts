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
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DaimonApi } from './daimon-api';
import { StatusPillComponent, EmptyStateComponent, MonoComponent } from './ui-primitives';

interface LogRow {
  ts: number;
  line: string;
  severity: 'error' | 'warn' | 'info';
}

const MAX_LINES = 1000;
const ANSI = /\x1b\[[0-9;]*m/g;

function classifySeverity(line: string): 'error' | 'warn' | 'info' {
  if (/\berror:|\bERROR\b|\bError\b/.test(line)) return 'error';
  if (/\bWARN\b|\bWarning\b/.test(line)) return 'warn';
  return 'info';
}

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
    MatButtonModule, MatIconModule, MatChipsModule, MatTooltipModule,
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
      <div class="dm-toolbar">
        <mat-form-field appearance="outline" class="dm-filter">
          <mat-label>Filter</mat-label>
          <input matInput [ngModel]="filter()" (ngModelChange)="filter.set($event)"
                 [placeholder]="useRegex() ? 'regex (case-insensitive)' : 'case-insensitive substring'" />
          @if (filter()) {
            <button matSuffix mat-icon-button (click)="filter.set('')"><mat-icon>close</mat-icon></button>
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
          (scrolledIndexChange)="onScroll()">
          <div
            *cdkVirtualFor="let row of filtered(); trackBy: trackTs; templateCacheSize: 0"
            class="dm-row"
            [attr.data-sev]="row.severity">
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
    .dm-toolbar {
      display: flex; gap: 1rem; align-items: center;
      margin-bottom: .75rem;
    }
    .dm-filter { flex: 1; max-width: 28rem; }
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
    .dm-row[data-sev="error"] {
      border-left-color: var(--mat-sys-error);
      background: color-mix(in oklch, var(--mat-sys-error) 6%, transparent);
    }
    .dm-row[data-sev="warn"] {
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
  readonly api = inject(DaimonApi);
  private readonly router = inject(Router);

  @ViewChild('viewport') viewport?: CdkVirtualScrollViewport;

  readonly lines = signal<LogRow[]>([]);
  readonly filter = signal('');
  readonly useRegex = signal(false);
  readonly paused = signal(false);
  readonly stuckToBottom = signal(true);

  private buffered: LogRow[] = [];
  private stop?: () => void;
  private rafScheduled = false;

  readonly currentApp = computed(() => this.name ? this.api.byName(this.name) : undefined);

  // Single derived pair so the predicate and the user-facing regex error are
  // computed together without ever writing a signal from inside `computed`.
  private readonly filterState = computed<{ pred: ((s: string) => boolean) | null; error: string | null }>(() => {
    const raw = this.filter();
    if (!raw) return { pred: null, error: null };
    if (!this.useRegex()) {
      const needle = raw.toLowerCase();
      return { pred: (s: string) => s.toLowerCase().includes(needle), error: null };
    }
    try {
      const rx = new RegExp(raw, 'i');
      return { pred: (s: string) => rx.test(s), error: null };
    } catch (e: any) {
      return { pred: null, error: e?.message ?? 'invalid regex' };
    }
  });

  readonly regexError = computed<string | null>(() => this.filterState().error);

  readonly filtered = computed<LogRow[]>(() => {
    const { pred } = this.filterState();
    const rows = this.lines();
    if (!pred) return rows;
    return rows.filter(r => pred(r.line));
  });

  readonly hasNextError = computed<boolean>(() => this.filtered().some(r => r.severity === 'error'));

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
      this.stuckToBottom.set(true);
      if (this.name) this.openStream();
    }
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  private openStream(): void {
    const name = this.name;
    this.stop = this.api.openLogStream(name, ({ ts, line }) => {
      const clean = (line ?? '').replace(ANSI, '');
      const row: LogRow = { ts, line: clean, severity: classifySeverity(clean) };
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
    for (let i = start; i < rows.length; i++) if (rows[i].severity === 'error') { found = i; break; }
    if (found === -1) {
      for (let i = 0; i < Math.min(start, rows.length); i++) if (rows[i].severity === 'error') { found = i; break; }
    }
    if (found === -1) return;
    this.stuckToBottom.set(false);
    vp.scrollToIndex(found, 'smooth');
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
