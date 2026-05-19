import { HttpClient } from '@angular/common/http';
import { inject, Injectable, NgZone, signal, Signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AppRow {
  name: string;
  status: 'stopped' | 'starting' | 'compiling' | 'serving' | 'error';
  port: number | null;
  url?: string | null;
  health: 'unknown' | 'healthy' | 'unhealthy';
  errorCount: number;
  uptimeMs: number | null;
  workspaceLabel: string | null;
  lastChangeMs?: number;
  cpu?: number | null;
  memMB?: number | null;
}

export interface Overview {
  ts: number;
  totals: { apps: number; serving: number; errors: number; stopped: number; totalErrCount: number };
  byStatus: Record<string, string[]>;
  needsAttention: { name: string; status: string; errCount: number; firstError: { file: string | null; line: number | null; code: string | null; message: string } | null }[];
  recentlyChanged: { name: string; transition: string; msAgo: number }[];
  _meta?: { suggestion?: string };
}

@Injectable({ providedIn: 'root' })
export class DaimonApi {
  private readonly http = inject(HttpClient);
  private readonly zone = inject(NgZone);

  apps = signal<AppRow[]>([]);
  overview = signal<Overview | null>(null);
  connected = signal<boolean>(false);

  async refresh(): Promise<void> {
    try {
      const [apps, overview] = await Promise.all([
        firstValueFrom(this.http.get<AppRow[]>('/api/apps?format=full')),
        firstValueFrom(this.http.get<Overview>('/api/overview')),
      ]);
      this.apps.set(Array.isArray(apps) ? apps : []);
      this.overview.set(overview ?? null);
      this.connected.set(true);
    } catch {
      this.connected.set(false);
    }
  }

  async start(name: string): Promise<void> { await firstValueFrom(this.http.post(`/api/apps/${encodeURIComponent(name)}/start`, {})); await this.refresh(); }
  async stop(name: string): Promise<void> { await firstValueFrom(this.http.post(`/api/apps/${encodeURIComponent(name)}/stop`, {})); await this.refresh(); }
  async restart(name: string): Promise<void> { await firstValueFrom(this.http.post(`/api/apps/${encodeURIComponent(name)}/restart`, {})); await this.refresh(); }

  startEventStream(onEvent: (ev: any) => void): () => void {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/events?stream=ndjson', { signal: ctl.signal });
        const reader = res.body?.getReader();
        if (!reader) return;
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try { onEvent(JSON.parse(line)); } catch {}
          }
        }
      } catch {}
    })();
    return () => ctl.abort();
  }
}

export function statusBadge(s: AppRow): { color: string; label: string } {
  switch (s.status) {
    case 'serving': return { color: 'var(--mat-sys-primary)', label: s.health === 'healthy' ? 'healthy' : 'serving' };
    case 'compiling': return { color: '#eab308', label: 'compiling' };
    case 'starting': return { color: '#3b82f6', label: 'starting' };
    case 'error': return { color: 'var(--mat-sys-error)', label: 'error' };
    default: return { color: 'var(--mat-sys-outline)', label: 'stopped' };
  }
}

void NgZone;
void Signal;
