import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { SkeletonComponent, MonoComponent } from './ui-primitives';

interface SessionStatus { recording: boolean; path?: string }

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

@Component({
  selector: 'dm-sessions-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule, MatButtonModule, MatIconModule,
    SkeletonComponent, MonoComponent,
  ],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Sessions</h1>
        <div class="dm-page-sub">
          @if (loading()) {
            <dm-skeleton width="12rem" height="1rem"></dm-skeleton>
          } @else if (recording()) {
            <span>Recording in progress Â· {{ elapsedLabel() }}</span>
          } @else {
            <span>Not recording</span>
          }
        </div>
      </div>
    </div>

    @if (loading()) {
      <div class="dm-skel-grid">
        <dm-skeleton height="9rem"></dm-skeleton>
        <dm-skeleton height="9rem"></dm-skeleton>
        <dm-skeleton height="9rem"></dm-skeleton>
      </div>
    } @else {
      <mat-card class="dm-status-card">
        <mat-card-content>
          <div class="dm-status-row">
            <div class="dm-state" [class.dm-state-rec]="recording()">
              @if (recording()) {
                <span class="dm-rec-dot"></span>
                <span class="dm-rec-label">REC</span>
              } @else {
                <span class="dm-idle-label">Idle</span>
              }
            </div>
            <button mat-flat-button color="primary"
                    class="dm-toggle-btn"
                    [disabled]="busy()"
                    (click)="toggle()">
              <mat-icon>{{ recording() ? 'stop_circle' : 'radio_button_checked' }}</mat-icon>
              {{ recording() ? 'Stop recording' : 'Start recording' }}
            </button>
          </div>
          @if (recording()) {
            <div class="dm-rec-meta">
              <div class="dm-meta-row">
                <span class="dm-meta-label">Elapsed</span>
                <dm-mono><span class="dm-meta-value">{{ elapsedLabel() }}</span></dm-mono>
              </div>
              @if (path()) {
                <div class="dm-meta-row">
                  <span class="dm-meta-label">Path</span>
                  <dm-mono><span class="dm-meta-value dm-path">{{ path() }}</span></dm-mono>
                </div>
              }
            </div>
          }
        </mat-card-content>
      </mat-card>

      <div class="dm-info-grid">
        <mat-card class="dm-info-card">
          <mat-card-header><mat-card-title>What gets recorded</mat-card-title></mat-card-header>
          <mat-card-content>
            <ul class="dm-info-list">
              <li>App lifecycle events (start, stop, restart)</li>
              <li>Task invocations</li>
              <li>Config changes</li>
            </ul>
            <div class="dm-info-row">
              <span class="dm-info-label">Saved as</span>
              <dm-mono><span class="dm-info-mono">~/.daimon/sessions/session-&lt;timestamp&gt;.jsonl</span></dm-mono>
            </div>
            <div class="dm-info-row">
              <span class="dm-info-label">Replay</span>
              <dm-mono><span class="dm-info-mono">daimon replay session.jsonl --speed 1</span></dm-mono>
            </div>
            <div class="dm-info-hint">
              Each JSONL line is <dm-mono><span class="dm-info-mono">{{ '{' }} ts, kind, app?, task?, args? {{ '}' }}</span></dm-mono>.
            </div>
          </mat-card-content>
        </mat-card>

        <mat-card class="dm-info-card">
          <mat-card-header><mat-card-title>Replay primer</mat-card-title></mat-card-header>
          <mat-card-content>
            <div class="dm-replay-row">
              <dm-mono><span class="dm-info-mono">daimon replay &lt;file.jsonl&gt;</span></dm-mono>
              <span class="dm-replay-desc">play at default speed</span>
            </div>
            <div class="dm-replay-row">
              <dm-mono><span class="dm-info-mono">daimon replay &lt;file.jsonl&gt; --speed 2</span></dm-mono>
              <span class="dm-replay-desc">2x faster</span>
            </div>
            <div class="dm-info-hint">
              Replay runs from the CLI. The dashboard doesn't trigger replays.
            </div>
          </mat-card-content>
        </mat-card>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-page-header h1 { margin: 0; }
    .dm-page-sub { color: var(--dm-color-fg-muted); margin-top: .25rem; font-size: .875rem; }

    .dm-skel-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(18rem, 100%), 1fr)); }

    .dm-status-card {
      margin-bottom: 1rem;
      border: 1px solid var(--dm-color-border);
    }
    .dm-status-row {
      display: flex; align-items: center; justify-content: space-between; gap: 1.5rem;
      flex-wrap: wrap;
    }
    .dm-state {
      display: inline-flex; align-items: center; gap: .65rem;
      font: 500 1.5rem/2rem Roboto;
      color: var(--dm-color-fg-muted);
    }
    .dm-state-rec { color: var(--dm-color-error); }
    .dm-rec-dot {
      width: 14px; height: 14px; border-radius: 999px;
      background: var(--dm-color-error);
      box-shadow: 0 0 0 4px color-mix(in oklch, var(--dm-color-error) 22%, transparent);
      animation: dm-pulse 1.4s ease-in-out infinite;
    }
    @keyframes dm-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: .35; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dm-rec-dot { animation: none; }
    }
    .dm-rec-label { letter-spacing: .05rem; }
    .dm-idle-label { color: var(--dm-color-fg-muted); }
    .dm-toggle-btn { min-height: 48px; padding: 0 1.25rem; font-size: 1rem; }

    .dm-rec-meta {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--dm-color-border);
      display: flex; flex-direction: column; gap: .5rem;
    }
    .dm-meta-row { display: flex; align-items: baseline; gap: .75rem; }
    .dm-meta-label {
      font: 500 .6875rem/1rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem;
      color: var(--dm-color-fg-muted);
      min-width: 4.5rem;
    }
    .dm-meta-value { color: var(--dm-color-fg); }
    .dm-path { word-break: break-all; }

    .dm-info-grid {
      display: grid; gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr));
    }
    .dm-info-card { border: 1px solid var(--dm-color-border); }
    .dm-info-list {
      margin: 0 0 1rem 0; padding-left: 1.25rem;
      color: var(--dm-color-fg);
      font-size: .875rem;
    }
    .dm-info-list li { margin-bottom: .25rem; }
    .dm-info-row {
      display: flex; flex-direction: column; gap: .15rem; margin-bottom: .65rem;
    }
    .dm-info-label {
      font: 500 .6875rem/1rem Roboto;
      text-transform: uppercase; letter-spacing: .04rem;
      color: var(--dm-color-fg-muted);
    }
    .dm-info-mono { color: var(--dm-color-fg); word-break: break-all; }
    .dm-info-hint {
      margin-top: .5rem;
      font-size: .8125rem;
      color: var(--dm-color-fg-muted);
    }
    .dm-replay-row {
      display: flex; flex-direction: column; gap: .15rem; margin-bottom: .65rem;
    }
    .dm-replay-desc {
      font-size: .8125rem;
      color: var(--dm-color-fg-muted);
    }
  `],
})
export class SessionsPageComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly snack = inject(MatSnackBar);

  readonly loading = signal(true);
  readonly recording = signal(false);
  readonly path = signal<string | undefined>(undefined);
  readonly busy = signal(false);
  readonly startedAt = signal<number | null>(null);
  private readonly tick = signal(0);

  readonly elapsedLabel = computed(() => {
    this.tick();
    const start = this.startedAt();
    if (!start) return '0s';
    return fmtElapsed(Date.now() - start);
  });

  private tickTimer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    void this.loadStatus();
    this.tickTimer = setInterval(() => {
      if (this.recording()) this.tick.update(v => v + 1);
    }, 1000);
  }

  ngOnDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  private async loadStatus(): Promise<void> {
    this.loading.set(true);
    try {
      const s = await firstValueFrom(this.http.get<SessionStatus>('/api/session/status'));
      this.recording.set(!!s?.recording);
      this.path.set(s?.path);
      // If recording is already in progress when the page mounts, we don't know
      // the actual start time â€” anchor at "now" so the elapsed timer is at least
      // monotonic from this moment.
      if (s?.recording) this.startedAt.set(Date.now());
      else this.startedAt.set(null);
    } catch {
      this.recording.set(false);
      this.startedAt.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  async toggle(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const wasRecording = this.recording();
    try {
      const res = await firstValueFrom(
        this.http.post<SessionStatus>('/api/session/record?action=toggle', {}),
      );
      const nowRecording = !!res?.recording;
      this.recording.set(nowRecording);
      this.path.set(res?.path);
      if (nowRecording && !wasRecording) {
        this.startedAt.set(Date.now());
        this.snack.open(
          res?.path ? `Started session at ${res.path}` : 'Started session',
          '',
          { duration: 2500 },
        );
      } else if (!nowRecording && wasRecording) {
        this.startedAt.set(null);
        this.snack.open('Stopped session', '', { duration: 2500 });
      }
    } catch (e: any) {
      this.snack.open(
        `Session toggle failed: ${e?.message ?? 'error'}`,
        'Dismiss',
        { duration: 4000, panelClass: 'dm-snack-error' },
      );
    } finally {
      this.busy.set(false);
    }
  }
}
