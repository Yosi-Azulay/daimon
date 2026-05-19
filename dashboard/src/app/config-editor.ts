import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatChipsModule } from '@angular/material/chips';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TextFieldModule } from '@angular/cdk/text-field';
import { firstValueFrom } from 'rxjs';
import { SECTIONS, FieldDef, get as fget, set as fset } from './config-fields';
import { SkeletonComponent, MonoComponent } from './ui-primitives';

type Mode = 'form' | 'json';
const MODE_KEY = 'daimon.config.mode';

@Component({
  selector: 'dm-config-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule,
    MatButtonModule, MatIconModule, MatTooltipModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatSlideToggleModule, MatButtonToggleModule, MatChipsModule,
    MatExpansionModule, MatProgressSpinnerModule,
    TextFieldModule,
    SkeletonComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Config</h1>
        <div class="dm-page-sub">
          Active configuration · changes apply via soft-reload where possible
          @if (etag()) { · <dm-mono>etag {{ etag().slice(0, 8) }}</dm-mono> }
        </div>
      </div>
      <div class="dm-header-actions">
        <mat-button-toggle-group [value]="mode()" (change)="setMode($event.value)" hideSingleSelectionIndicator>
          <mat-button-toggle value="form" matTooltip="Form editor with explanations">
            <mat-icon fontSet="material-symbols-outlined">tune</mat-icon> Settings
          </mat-button-toggle>
          <mat-button-toggle value="json" matTooltip="Raw JSON editor">
            <mat-icon fontSet="material-symbols-outlined">data_object</mat-icon> JSON
          </mat-button-toggle>
        </mat-button-toggle-group>
        @if (dirty()) {
          <button mat-button (click)="discard()" matTooltip="Throw away pending changes">
            <mat-icon fontSet="material-symbols-outlined">undo</mat-icon> Discard
          </button>
        }
        <button mat-button (click)="reload()" matTooltip="Reload from daemon">
          <mat-icon fontSet="material-symbols-outlined">refresh</mat-icon> Reload
        </button>
        <button mat-flat-button color="primary" (click)="save()" [disabled]="!canSave()">
          @if (saving()) { <mat-spinner diameter="18"></mat-spinner> } @else { <mat-icon fontSet="material-symbols-outlined">save</mat-icon> }
          Save
        </button>
      </div>
    </div>

    @if (conflict()) {
      <div class="dm-banner dm-banner-warn">
        <mat-icon fontSet="material-symbols-outlined">sync_problem</mat-icon>
        <div>
          <strong>Config changed elsewhere.</strong>
          Your local edits are stale. Reload to pull the latest, then re-apply.
        </div>
        <button mat-stroked-button (click)="reload()">Reload</button>
      </div>
    }

    @if (restartHints().length) {
      <div class="dm-banner dm-banner-info">
        <mat-icon fontSet="material-symbols-outlined">restart_alt</mat-icon>
        <div>
          <strong>Some changes need a daemon restart to take effect.</strong>
          @for (h of restartHints(); track h) { <span class="dm-restart-key"><dm-mono>{{ h }}</dm-mono></span> }
        </div>
        <span></span>
      </div>
    }

    @if (loading()) {
      <div class="dm-skel">
        <dm-skeleton height="3rem"></dm-skeleton>
        <dm-skeleton height="14rem"></dm-skeleton>
        <dm-skeleton height="14rem"></dm-skeleton>
        <dm-skeleton height="14rem"></dm-skeleton>
      </div>
    } @else if (mode() === 'form') {
      <div class="dm-settings">
        @for (sec of sections; track sec.id) {
          <mat-expansion-panel [expanded]="isExpanded(sec.id)" (afterExpand)="onExpand(sec.id, true)" (afterCollapse)="onExpand(sec.id, false)">
            <mat-expansion-panel-header>
              <mat-panel-title>
                <mat-icon fontSet="material-symbols-outlined">{{ sec.icon }}</mat-icon>
                <span class="dm-sec-title">{{ sec.title }}</span>
              </mat-panel-title>
              <mat-panel-description>
                {{ sec.description }}
              </mat-panel-description>
            </mat-expansion-panel-header>
            <div class="dm-fields">
              @for (f of sec.fields; track f.key) {
                <div class="dm-field" [class.dm-field-dirty]="isFieldDirty(f.key)">
                  <div class="dm-field-label-row">
                    <label class="dm-field-label">{{ f.label }}</label>
                    @if (f.restartRequired) { <span class="dm-field-tag" matTooltip="A daemon restart applies this">restart</span> }
                    @if (isFieldDirty(f.key)) { <span class="dm-field-tag dm-tag-dirty">modified</span> }
                  </div>
                  <div class="dm-field-control">
                    @switch (f.kind) {
                      @case ('boolean') {
                        <mat-slide-toggle [checked]="!!getVal(f.key)" (change)="setVal(f.key, $event.checked)">
                          {{ getVal(f.key) ? 'On' : 'Off' }}
                        </mat-slide-toggle>
                      }
                      @case ('number') {
                        <mat-form-field appearance="outline" subscriptSizing="dynamic">
                          <input matInput type="number"
                                 [min]="f.min ?? null" [max]="f.max ?? null"
                                 [value]="getVal(f.key)"
                                 (input)="setVal(f.key, toNum($any($event.target).value))" />
                          @if (f.unit) { <span matTextSuffix class="dm-suffix">{{ f.unit }}</span> }
                        </mat-form-field>
                      }
                      @case ('number-pair') {
                        <div class="dm-pair">
                          <mat-form-field appearance="outline" subscriptSizing="dynamic">
                            <mat-label>min</mat-label>
                            <input matInput type="number" [min]="f.min ?? null" [max]="f.max ?? null"
                                   [value]="getPair(f.key)[0]"
                                   (input)="setPairIdx(f.key, 0, toNum($any($event.target).value))" />
                          </mat-form-field>
                          <span class="dm-pair-sep">–</span>
                          <mat-form-field appearance="outline" subscriptSizing="dynamic">
                            <mat-label>max</mat-label>
                            <input matInput type="number" [min]="f.min ?? null" [max]="f.max ?? null"
                                   [value]="getPair(f.key)[1]"
                                   (input)="setPairIdx(f.key, 1, toNum($any($event.target).value))" />
                          </mat-form-field>
                        </div>
                      }
                      @case ('string') {
                        <mat-form-field appearance="outline" subscriptSizing="dynamic">
                          <input matInput [placeholder]="f.placeholder ?? ''"
                                 [value]="getStrOrEmpty(f.key)"
                                 (input)="setVal(f.key, $any($event.target).value || (f.kind === 'string' ? '' : null))" />
                        </mat-form-field>
                      }
                      @case ('path') {
                        <mat-form-field appearance="outline" subscriptSizing="dynamic">
                          <input matInput class="dm-mono"
                                 [placeholder]="f.placeholder ?? ''"
                                 [value]="getStrOrEmpty(f.key)"
                                 (input)="setVal(f.key, $any($event.target).value)" />
                        </mat-form-field>
                      }
                      @case ('token') {
                        <mat-form-field appearance="outline" subscriptSizing="dynamic">
                          <input matInput [type]="showToken() ? 'text' : 'password'"
                                 [placeholder]="'(unset)'"
                                 [value]="getStrOrEmpty(f.key)"
                                 (input)="setVal(f.key, $any($event.target).value || null)" />
                          <button matSuffix mat-icon-button type="button"
                                  (click)="showToken.set(!showToken())"
                                  [attr.aria-label]="showToken() ? 'Hide token' : 'Show token'">
                            <mat-icon fontSet="material-symbols-outlined">{{ showToken() ? 'visibility_off' : 'visibility' }}</mat-icon>
                          </button>
                        </mat-form-field>
                      }
                      @case ('enum') {
                        <mat-button-toggle-group [value]="enumValue(f.key, f)"
                                                 (change)="setEnum(f, $event.value)"
                                                 hideSingleSelectionIndicator>
                          @for (v of f.enumValues!; track v) {
                            <mat-button-toggle [value]="v">{{ v }}</mat-button-toggle>
                          }
                        </mat-button-toggle-group>
                      }
                      @case ('string-array') {
                        <div class="dm-array">
                          <mat-chip-set>
                            @for (item of getArr(f.key); track item; let i = $index) {
                              <mat-chip [removable]="true" (removed)="removeAt(f.key, i)">
                                <dm-mono>{{ item }}</dm-mono>
                                <button matChipRemove>
                                  <mat-icon fontSet="material-symbols-outlined">cancel</mat-icon>
                                </button>
                              </mat-chip>
                            }
                          </mat-chip-set>
                          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="dm-array-input">
                            <input matInput
                                   [placeholder]="f.placeholder ?? 'Add value and press Enter'"
                                   #addInput
                                   (keydown.enter)="addItem(f.key, addInput.value); addInput.value = ''; $event.preventDefault();" />
                            <button matSuffix mat-icon-button type="button" (click)="addItem(f.key, addInput.value); addInput.value = '';">
                              <mat-icon fontSet="material-symbols-outlined">add</mat-icon>
                            </button>
                          </mat-form-field>
                        </div>
                      }
                    }
                  </div>
                  <div class="dm-field-help">{{ f.help }}</div>
                </div>
              }
            </div>
          </mat-expansion-panel>
        }

        <section class="dm-advanced-note">
          <p>
            Some settings — <strong>overrides</strong>, <strong>profiles</strong>, <strong>tags</strong>, <strong>depends</strong>, <strong>envFiles</strong> —
            are per-app dictionaries best edited as JSON. Switch to the JSON tab in the header to edit them.
          </p>
        </section>
      </div>
    } @else {
      <div class="dm-json">
        <div class="dm-json-status">
          @if (parseError()) {
            <span class="dm-status dm-status-bad">
              <mat-icon fontSet="material-symbols-outlined">error</mat-icon>
              invalid JSON · {{ parseError() }}
            </span>
          } @else {
            <span class="dm-status dm-status-ok">
              <mat-icon fontSet="material-symbols-outlined">check_circle</mat-icon>
              valid JSON
            </span>
          }
        </div>
        <mat-form-field appearance="outline" class="dm-json-field">
          <textarea matInput cdkTextareaAutosize cdkAutosizeMinRows="20" spellcheck="false"
                    [ngModel]="jsonText()" (ngModelChange)="onJsonInput($event)"></textarea>
        </mat-form-field>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-header-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .dm-banner {
      display: grid; grid-template-columns: auto 1fr auto; gap: .75rem; align-items: center;
      padding: 12px 16px; border-radius: 12px; margin-bottom: 1rem;
    }
    .dm-banner-warn {
      background: color-mix(in oklch, var(--mat-sys-error) 14%, transparent);
      color: var(--mat-sys-on-surface);
      border: 1px solid color-mix(in oklch, var(--mat-sys-error) 35%, transparent);
    }
    .dm-banner-warn mat-icon { color: var(--mat-sys-error); }
    .dm-banner-info {
      background: color-mix(in oklch, var(--mat-sys-tertiary) 14%, transparent);
      color: var(--mat-sys-on-surface);
      border: 1px solid color-mix(in oklch, var(--mat-sys-tertiary) 35%, transparent);
    }
    .dm-banner-info mat-icon { color: var(--mat-sys-tertiary); }
    .dm-restart-key { margin-left: .35rem; }
    .dm-skel { display: flex; flex-direction: column; gap: .75rem; }
    .dm-settings { display: flex; flex-direction: column; gap: .75rem; }
    .dm-sec-title { margin-left: .5rem; font: 500 1rem/1.5rem Roboto; }
    mat-expansion-panel { border-radius: 14px !important; box-shadow: var(--mat-sys-level1) !important; }
    mat-expansion-panel-header mat-icon { color: var(--mat-sys-primary); }
    mat-panel-description { color: var(--mat-sys-on-surface-variant); }
    .dm-fields { display: flex; flex-direction: column; gap: 1.5rem; padding: 0 .5rem; }
    .dm-field { display: grid; grid-template-columns: minmax(0, 280px) 1fr; gap: .25rem 2rem; align-items: start; }
    .dm-field-label-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; padding-top: .25rem; }
    .dm-field-label { font: 500 .9375rem/1.5rem Roboto; color: var(--mat-sys-on-surface); }
    .dm-field-tag {
      font: 500 .6875rem/1rem Roboto; letter-spacing: .05em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
      border: 1px solid var(--mat-sys-outline-variant);
    }
    .dm-tag-dirty {
      background: color-mix(in oklch, var(--mat-sys-tertiary) 18%, transparent);
      color: var(--mat-sys-tertiary);
      border-color: color-mix(in oklch, var(--mat-sys-tertiary) 40%, transparent);
    }
    .dm-field-help {
      grid-column: 2;
      color: var(--mat-sys-on-surface-variant);
      font: 400 .8125rem/1.25rem Roboto;
      max-width: 56ch;
    }
    .dm-field-dirty .dm-field-label { color: var(--mat-sys-tertiary); }
    .dm-pair { display: flex; align-items: center; gap: .5rem; }
    .dm-pair-sep { color: var(--mat-sys-on-surface-variant); }
    .dm-suffix { color: var(--mat-sys-on-surface-variant); margin-left: .25rem; font: 400 .75rem/1rem Roboto; }
    .dm-array { display: flex; flex-direction: column; gap: .5rem; }
    .dm-array-input { max-width: 32rem; }
    .dm-mono input.dm-mono, input.dm-mono { font-family: var(--dm-mono); }
    .dm-advanced-note {
      margin-top: .5rem; padding: 1rem 1.25rem;
      background: var(--mat-sys-surface-container);
      border-radius: 12px;
      color: var(--mat-sys-on-surface-variant);
      font: 400 .875rem/1.5rem Roboto;
    }
    .dm-json { display: flex; flex-direction: column; gap: .5rem; }
    .dm-json-status { display: flex; gap: .5rem; }
    .dm-status {
      display: inline-flex; align-items: center; gap: .35rem;
      font: 500 .75rem/1rem Roboto;
      padding: 4px 10px; border-radius: 999px;
      background: var(--mat-sys-surface-container);
    }
    .dm-status mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .dm-status-ok { color: var(--mat-sys-primary); }
    .dm-status-bad { color: var(--mat-sys-error); }
    .dm-json-field { width: 100%; }
    .dm-json-field textarea { font-family: var(--dm-mono); font-size: .8125rem; line-height: 1.5; }
    @media (max-width: 900px) {
      .dm-field { grid-template-columns: 1fr; }
      .dm-field-help { grid-column: 1; }
    }
  `],
})
export class ConfigEditorComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly snack = inject(MatSnackBar);

  protected readonly sections = SECTIONS;
  protected readonly mode = signal<Mode>('form');
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly etag = signal<string>('');
  protected readonly original = signal<any>(null);
  protected readonly working = signal<any>(null);
  protected readonly jsonText = signal<string>('');
  protected readonly conflict = signal(false);
  protected readonly showToken = signal(false);
  protected readonly expanded = signal<Record<string, boolean>>({});

  protected readonly dirty = computed(() => JSON.stringify(this.working()) !== JSON.stringify(this.original()));
  protected readonly parseError = computed<string | null>(() => {
    if (this.mode() !== 'json') return null;
    try { JSON.parse(this.jsonText()); return null; } catch (e: any) { return e?.message ?? 'parse error'; }
  });
  protected readonly canSave = computed(() => !this.saving() && !this.loading() && this.dirty() && !this.parseError());

  protected readonly restartHints = computed<string[]>(() => {
    const o = this.original();
    const w = this.working();
    if (!o || !w) return [];
    const hints: string[] = [];
    for (const sec of SECTIONS) {
      for (const f of sec.fields) {
        if (!f.restartRequired) continue;
        if (JSON.stringify(fget(o, f.key)) !== JSON.stringify(fget(w, f.key))) hints.push(f.key);
      }
    }
    return hints;
  });

  async ngOnInit(): Promise<void> {
    try {
      const saved = localStorage.getItem(MODE_KEY) as Mode | null;
      if (saved === 'form' || saved === 'json') this.mode.set(saved);
    } catch {}
    const initial: Record<string, boolean> = {};
    for (const s of SECTIONS) initial[s.id] = ['network', 'discovery', 'healthProbe'].includes(s.id);
    this.expanded.set(initial);
    await this.load();
  }

  setMode(m: Mode): void {
    if (m === this.mode()) return;
    if (m === 'json') {
      this.jsonText.set(JSON.stringify(this.working(), null, 2));
    } else if (this.parseError() === null) {
      try { this.working.set(JSON.parse(this.jsonText())); } catch {}
    } else {
      this.snack.open('Fix the JSON parse error before switching back to the form view.', 'OK', { duration: 4000 });
      return;
    }
    this.mode.set(m);
    try { localStorage.setItem(MODE_KEY, m); } catch {}
  }

  protected onJsonInput(s: string): void {
    this.jsonText.set(s);
    try { this.working.set(JSON.parse(s)); } catch {}
  }

  protected isExpanded(id: string): boolean { return !!this.expanded()[id]; }
  protected onExpand(id: string, v: boolean): void { this.expanded.update(m => ({ ...m, [id]: v })); }

  protected getVal(k: string): any { return fget(this.working(), k); }
  protected getStrOrEmpty(k: string): string { const v = this.getVal(k); return v == null ? '' : String(v); }
  protected getArr(k: string): string[] { const v = this.getVal(k); return Array.isArray(v) ? v : []; }
  protected getPair(k: string): [number, number] {
    const v = this.getVal(k);
    return Array.isArray(v) && v.length >= 2 ? [Number(v[0]) || 0, Number(v[1]) || 0] : [0, 0];
  }
  protected setVal(k: string, v: any): void {
    const next = structuredClone(this.working());
    fset(next, k, v);
    this.working.set(next);
  }
  protected setPairIdx(k: string, idx: 0 | 1, v: number): void {
    const cur = this.getPair(k);
    cur[idx] = v;
    this.setVal(k, cur);
  }
  protected setEnum(f: FieldDef, v: string): void {
    if (f.key.startsWith('healthProbe.') && (f.key.endsWith('.scheme') || f.key.endsWith('.host'))) {
      this.setVal(f.key, v === '(announced)' ? null : v);
      return;
    }
    this.setVal(f.key, v);
  }
  protected enumValue(k: string, f: FieldDef): string {
    const v = this.getVal(k);
    if (v == null && f.enumValues?.includes('(announced)')) return '(announced)';
    return String(v ?? f.enumValues?.[0] ?? '');
  }
  protected addItem(k: string, raw: string): void {
    const v = raw.trim();
    if (!v) return;
    const arr = [...this.getArr(k)];
    if (arr.includes(v)) return;
    arr.push(v);
    this.setVal(k, arr);
  }
  protected removeAt(k: string, idx: number): void {
    const arr = [...this.getArr(k)];
    arr.splice(idx, 1);
    this.setVal(k, arr);
  }
  protected toNum(s: string): number {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  protected isFieldDirty(k: string): boolean {
    const o = this.original(); const w = this.working();
    if (!o || !w) return false;
    return JSON.stringify(fget(o, k)) !== JSON.stringify(fget(w, k));
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.conflict.set(false);
    try {
      const r = await firstValueFrom(this.http.get<{ etag: string; config: any }>('/api/config'));
      this.etag.set(r.etag ?? '');
      this.original.set(structuredClone(r.config));
      this.working.set(structuredClone(r.config));
      this.jsonText.set(JSON.stringify(r.config, null, 2));
    } catch (e: any) {
      this.snack.open(`Failed to load config: ${e?.message ?? e}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.loading.set(false);
    }
  }

  discard(): void {
    this.working.set(structuredClone(this.original()));
    this.jsonText.set(JSON.stringify(this.original(), null, 2));
    this.conflict.set(false);
  }

  async reload(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/config/reload', {}));
    } catch {}
    await this.load();
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    try {
      const r = await firstValueFrom(this.http.patch<any>('/api/config', this.working(), {
        headers: { 'if-match': this.etag(), 'content-type': 'application/json' },
        observe: 'response',
      }));
      const body: any = r.body ?? {};
      const etag = (r.headers.get('etag') ?? body.etag ?? '') as string;
      if (etag) this.etag.set(etag);
      this.original.set(structuredClone(this.working()));
      const applied = Array.isArray(body.applied) ? body.applied.length : 0;
      const added = Array.isArray(body.addedApps) ? body.addedApps.length : 0;
      const removed = Array.isArray(body.removedApps) ? body.removedApps.length : 0;
      const restart = Array.isArray(body.restartRequired) ? body.restartRequired.length : 0;
      let msg = `Applied ${applied} change${applied === 1 ? '' : 's'}`;
      if (added) msg += ` · +${added} app${added === 1 ? '' : 's'}`;
      if (removed) msg += ` · −${removed} app${removed === 1 ? '' : 's'}`;
      if (restart) msg += ` · ${restart} setting${restart === 1 ? '' : 's'} need restart`;
      this.snack.open(msg, 'OK', { duration: 4000 });
    } catch (e: any) {
      if (e?.status === 412) {
        this.conflict.set(true);
        this.snack.open('Config changed elsewhere — reload before saving.', 'Reload', { duration: 6000 }).onAction().subscribe(() => this.reload());
      } else {
        this.snack.open(`Save failed: ${e?.error?.error ?? e?.message ?? e}`, 'Dismiss', { duration: 6000 });
      }
    } finally {
      this.saving.set(false);
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save();
    }
  }
}
