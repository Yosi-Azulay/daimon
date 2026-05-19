import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Inject,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TextFieldModule } from '@angular/cdk/text-field';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { DaimonApi } from './daimon-api';
import { SkeletonComponent, MonoComponent } from './ui-primitives';

interface ParseState {
  ok: boolean;
  value?: any;
  error?: string;
  line?: number;
  col?: number;
}

function parseLineCol(msg: string, text: string): { line?: number; col?: number } {
  const pos = /position\s+(\d+)/i.exec(msg);
  if (pos) {
    const p = Number(pos[1]);
    const before = text.slice(0, p);
    const lines = before.split('\n');
    return { line: lines.length, col: lines[lines.length - 1].length + 1 };
  }
  const lc = /line\s+(\d+)\s+column\s+(\d+)/i.exec(msg);
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
  return {};
}

@Component({
  selector: 'dm-config-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>Confirm deletions</h2>
    <mat-dialog-content>
      <p>The following top-level keys will be removed:</p>
      <ul class="dm-keys">
        @for (k of data.removed; track k) { <li><code>{{ k }}</code></li> }
      </ul>
      <p class="dm-warn">This can disable apps or change discovery. Continue?</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button color="warn" [mat-dialog-close]="true">Save anyway</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dm-keys { margin: .5rem 0 1rem; padding-left: 1.25rem; }
    .dm-keys code { font-family: var(--dm-mono); font-size: .875rem; }
    .dm-warn { color: var(--mat-sys-error); margin: 0; }
  `],
})
export class ConfigConfirmDialogComponent {
  constructor(
    public ref: MatDialogRef<ConfigConfirmDialogComponent, boolean>,
    @Inject(MAT_DIALOG_DATA) public data: { removed: string[] },
  ) {}
}

@Component({
  selector: 'dm-config-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, TextFieldModule,
    MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule,
    MatSnackBarModule, MatDialogModule,
    SkeletonComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Config</h1>
        <div class="dm-page-sub">
          <dm-mono>Active config</dm-mono>
          @if (etag()) {
            <span class="dm-sep">·</span>
            <dm-mono>etag {{ shortEtag() }}</dm-mono>
          }
          <span class="dm-sep">·</span>
          @if (parse().ok) {
            <span class="dm-chip dm-chip-ok">
              <span class="dm-dot"></span> valid
            </span>
          } @else {
            <span class="dm-chip dm-chip-bad">
              <span class="dm-dot"></span> invalid
              @if (parse().line) {
                <span class="dm-pos">line {{ parse().line }}:{{ parse().col }}</span>
              }
            </span>
          }
          @if (dirty()) {
            <span class="dm-sep">·</span>
            <span class="dm-dirty">unsaved changes</span>
          }
        </div>
      </div>
      <div class="dm-actions">
        @if (dirty()) {
          <button mat-stroked-button (click)="discard()" [disabled]="loading() || saving()">
            <mat-icon>undo</mat-icon> Discard
          </button>
        }
        <button mat-stroked-button (click)="reload()" [disabled]="loading() || saving()">
          <mat-icon>refresh</mat-icon> Reload
        </button>
        <button
          mat-flat-button
          color="primary"
          (click)="save()"
          [disabled]="loading() || saving() || !parse().ok || !dirty()">
          <mat-icon>save</mat-icon> Save
        </button>
      </div>
    </div>

    @if (conflict()) {
      <div class="dm-banner dm-banner-conflict">
        <mat-icon>sync_problem</mat-icon>
        <span>Config changed elsewhere — reload to pick up the latest version?</span>
        <button mat-stroked-button (click)="reload()">Reload</button>
      </div>
    }

    @if (restartNotice().length) {
      <div class="dm-banner dm-banner-restart">
        <mat-icon>restart_alt</mat-icon>
        <div>
          <strong>Some settings need a daemon restart</strong>
          <div class="dm-restart-list">
            @for (k of restartNotice(); track k) { <code>{{ k }}</code> }
          </div>
          <a href="https://github.com/Yosi-Azulay/daimon" target="_blank" rel="noopener">
            github.com/Yosi-Azulay/daimon
          </a>
        </div>
      </div>
    }

    @if (loading()) {
      <div class="dm-skel">
        <dm-skeleton height="22rem"></dm-skeleton>
      </div>
    } @else {
      <div class="dm-layout">
        <aside class="dm-tree">
          <div class="dm-tree-title">Sections</div>
          @if (topKeys().length === 0) {
            <div class="dm-tree-empty">No keys</div>
          } @else {
            <ul>
              @for (k of topKeys(); track k) {
                <li>
                  <button class="dm-tree-key" type="button" (click)="jumpTo(k)">
                    <span class="dm-tree-dot"></span>
                    <span class="dm-tree-name">{{ k }}</span>
                  </button>
                </li>
              }
            </ul>
          }
        </aside>
        <div class="dm-editor">
          <mat-form-field appearance="outline" class="dm-field">
            <mat-label>Config JSON</mat-label>
            <textarea
              #ta
              matInput
              cdkTextareaAutosize
              cdkAutosizeMinRows="24"
              cdkAutosizeMaxRows="48"
              spellcheck="false"
              [disabled]="loading() || saving()"
              [ngModel]="current()"
              (ngModelChange)="current.set($event)"
              class="dm-ta">
            </textarea>
          </mat-form-field>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-page-header h1 { display: flex; align-items: center; gap: .5rem; }
    .dm-page-sub { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; }
    .dm-sep { color: var(--mat-sys-outline); }
    .dm-actions { display: flex; gap: .5rem; align-items: flex-end; }
    .dm-dirty { color: var(--mat-sys-tertiary); font-weight: 500; }

    .dm-chip {
      display: inline-flex; align-items: center; gap: .35rem;
      padding: 2px 10px; border-radius: 999px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
      font: 500 .75rem/1rem Roboto;
    }
    .dm-chip .dm-dot { width: 7px; height: 7px; border-radius: 999px; background: currentColor; }
    .dm-chip-ok {
      color: var(--mat-sys-primary);
      background: color-mix(in oklch, var(--mat-sys-primary) 12%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-primary) 28%, transparent);
    }
    .dm-chip-bad {
      color: var(--mat-sys-error);
      background: color-mix(in oklch, var(--mat-sys-error) 14%, transparent);
      border-color: color-mix(in oklch, var(--mat-sys-error) 30%, transparent);
    }
    .dm-pos { font-family: var(--dm-mono); margin-left: .35rem; }

    .dm-banner {
      display: flex; align-items: center; gap: .75rem;
      padding: .75rem 1rem; border-radius: 10px;
      margin-bottom: 1rem;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
    }
    .dm-banner-conflict {
      border-color: color-mix(in oklch, var(--mat-sys-error) 36%, transparent);
      background: color-mix(in oklch, var(--mat-sys-error) 10%, transparent);
      color: var(--mat-sys-on-surface);
    }
    .dm-banner-restart {
      border-color: color-mix(in oklch, var(--mat-sys-tertiary) 36%, transparent);
      background: color-mix(in oklch, var(--mat-sys-tertiary) 10%, transparent);
      align-items: flex-start;
    }
    .dm-restart-list {
      display: flex; flex-wrap: wrap; gap: .35rem; margin: .25rem 0;
    }
    .dm-restart-list code {
      font-family: var(--dm-mono); font-size: .8125rem;
      padding: 1px 6px; border-radius: 4px;
      background: var(--mat-sys-surface-container-high);
    }
    .dm-banner-restart a { color: var(--mat-sys-primary); }

    .dm-skel { padding: 1rem 0; }

    .dm-layout {
      display: grid;
      grid-template-columns: 14rem 1fr;
      gap: 1rem;
      align-items: start;
    }
    .dm-tree {
      position: sticky; top: 1rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px;
      background: var(--mat-sys-surface-container-lowest);
      padding: .5rem;
      max-height: calc(100vh - 12rem);
      overflow-y: auto;
    }
    .dm-tree-title {
      font: 500 .75rem/1.25rem Roboto;
      letter-spacing: .04rem;
      text-transform: uppercase;
      color: var(--mat-sys-on-surface-variant);
      padding: .35rem .5rem;
    }
    .dm-tree-empty { color: var(--mat-sys-on-surface-variant); padding: .5rem; font-size: .8125rem; }
    .dm-tree ul { list-style: none; margin: 0; padding: 0; }
    .dm-tree-key {
      display: flex; align-items: center; gap: .5rem;
      width: 100%; text-align: left;
      border: none; background: transparent;
      padding: .4rem .5rem; border-radius: 6px;
      cursor: pointer;
      color: var(--mat-sys-on-surface);
      font-family: var(--dm-mono); font-size: .8125rem;
    }
    .dm-tree-key:hover {
      background: color-mix(in oklch, var(--mat-sys-primary) 8%, transparent);
      color: var(--mat-sys-on-surface);
    }
    .dm-tree-dot {
      width: 6px; height: 6px; border-radius: 999px;
      background: var(--mat-sys-outline);
    }
    .dm-tree-key:hover .dm-tree-dot { background: var(--mat-sys-primary); }
    .dm-tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .dm-editor { min-width: 0; }
    .dm-field { width: 100%; }
    .dm-ta {
      font-family: var(--dm-mono) !important;
      font-size: .8125rem !important;
      line-height: 1.4 !important;
      tab-size: 2;
    }
  `],
})
export class ConfigEditorComponent implements OnInit {
  private readonly api = inject(DaimonApi);
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);

  @ViewChild('ta') ta?: ElementRef<HTMLTextAreaElement>;

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly etag = signal<string>('');
  readonly original = signal<string>('');
  readonly current = signal<string>('');
  readonly conflict = signal(false);
  readonly restartNotice = signal<string[]>([]);

  readonly dirty = computed(() => this.current() !== this.original());
  readonly shortEtag = computed(() => {
    const e = this.etag();
    return e.length > 10 ? e.slice(0, 10) + '…' : e;
  });

  readonly parse = computed<ParseState>(() => {
    const text = this.current();
    if (!text.trim()) return { ok: false, error: 'empty' };
    try {
      const value = JSON.parse(text);
      return { ok: true, value };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const { line, col } = parseLineCol(msg, text);
      return { ok: false, error: msg, line, col };
    }
  });

  readonly topKeys = computed<string[]>(() => {
    const p = this.parse();
    if (p.ok && p.value && typeof p.value === 'object' && !Array.isArray(p.value)) {
      return Object.keys(p.value);
    }
    // Fallback: scrape top-level keys from text so the tree still shows when invalid.
    return scrapeTopKeys(this.current());
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.api.getConfig();
      if (!res) {
        this.snack.open('Failed to load config', 'Dismiss', { duration: 4000 });
        this.etag.set('');
        this.original.set('{}');
        this.current.set('{}');
        return;
      }
      const text = JSON.stringify(res.config ?? {}, null, 2);
      this.etag.set(res.etag ?? '');
      this.original.set(text);
      this.current.set(text);
      this.conflict.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  discard(): void {
    this.current.set(this.original());
  }

  async reload(): Promise<void> {
    try {
      await this.api.reloadConfig();
      this.snack.open('Config reloaded from disk', 'Dismiss', { duration: 2500 });
    } catch {
      this.snack.open('Reload failed', 'Dismiss', { duration: 3000 });
    }
    await this.load();
  }

  async save(): Promise<void> {
    const p = this.parse();
    if (!p.ok) return;
    const parsed = p.value;

    const removed = this.computeRemovedTopKeys(parsed);
    if (removed.length) {
      const ok = await this.dialog
        .open(ConfigConfirmDialogComponent, { data: { removed }, width: '420px' })
        .afterClosed()
        .toPromise();
      if (!ok) return;
    }

    this.saving.set(true);
    try {
      const res = await this.api.patchConfig(this.etag(), parsed);
      const applied: string[] = Array.isArray(res?.applied) ? res.applied : [];
      const added: string[] = Array.isArray(res?.addedApps) ? res.addedApps : [];
      const gone: string[] = Array.isArray(res?.removedApps) ? res.removedApps : [];
      const restart: string[] = Array.isArray(res?.restartRequired) ? res.restartRequired : [];

      if (res?.etag) this.etag.set(res.etag);
      this.original.set(this.current());
      this.conflict.set(false);
      this.restartNotice.set(restart);

      const bits = [
        `applied: ${applied.length ? applied.join(', ') : '—'}`,
        added.length ? `added: ${added.join(', ')}` : '',
        gone.length ? `removed: ${gone.join(', ')}` : '',
      ].filter(Boolean);
      this.snack.open(bits.join(' · '), 'Dismiss', { duration: 4000 });
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode;
      if (status === 412) {
        this.conflict.set(true);
        this.snack.open('Etag mismatch — config changed elsewhere', 'Dismiss', { duration: 4500 });
      } else {
        const msg = e?.error?.message ?? e?.message ?? 'Save failed';
        this.snack.open(`Save failed: ${msg}`, 'Dismiss', { duration: 5000 });
      }
    } finally {
      this.saving.set(false);
    }
  }

  jumpTo(key: string): void {
    const el = this.ta?.nativeElement;
    const text = this.current();
    if (!el || !text) return;
    const idx = findTopKeyIndex(text, key);
    if (idx < 0) return;
    el.focus();
    el.setSelectionRange(idx, idx);
    // Heuristic vertical scroll based on line index.
    const before = text.slice(0, idx);
    const lineIdx = before.split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.scrollTop = Math.max(0, lineIdx * lineHeight - el.clientHeight / 3);
  }

  private computeRemovedTopKeys(nextParsed: any): string[] {
    let prev: any;
    try { prev = JSON.parse(this.original()); } catch { return []; }
    if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return [];
    if (!nextParsed || typeof nextParsed !== 'object' || Array.isArray(nextParsed)) return [];
    const prevKeys = Object.keys(prev);
    const nextKeys = new Set(Object.keys(nextParsed));
    return prevKeys.filter(k => !nextKeys.has(k));
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (!this.loading() && !this.saving() && this.parse().ok && this.dirty()) {
        void this.save();
      }
    }
  }
}

function scrapeTopKeys(text: string): string[] {
  const keys: string[] = [];
  const len = text.length;
  let i = 0;
  while (i < len && text[i] !== '{') i++;
  if (i >= len) return keys;
  i++;
  let depth = 1;
  let inStr = false;
  let strBuf = '';
  let collecting = false;
  let pendingKey: string | null = null;
  while (i < len) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { strBuf += ch + (text[i + 1] ?? ''); i += 2; continue; }
      if (ch === '"') {
        inStr = false;
        if (collecting) { pendingKey = strBuf; collecting = false; }
        strBuf = '';
        i++;
        continue;
      }
      strBuf += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      strBuf = '';
      if (depth === 1) collecting = true;
      i++;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth <= 0) break; }
    else if (ch === ':' && depth === 1 && pendingKey != null) {
      if (!keys.includes(pendingKey)) keys.push(pendingKey);
      pendingKey = null;
    }
    i++;
  }
  return keys;
}

function findTopKeyIndex(text: string, key: string): number {
  const needle = '"' + key.replace(/[\\"]/g, m => '\\' + m) + '"';
  const len = text.length;
  let i = 0;
  while (i < len && text[i] !== '{') i++;
  if (i >= len) return -1;
  i++;
  let depth = 1;
  let inStr = false;
  while (i < len) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      if (depth === 1 && text.slice(i, i + needle.length) === needle) return i;
      inStr = true; i++; continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth <= 0) return -1; }
    i++;
  }
  return -1;
}
