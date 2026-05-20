import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type StatusKind = 'stopped' | 'starting' | 'compiling' | 'serving' | 'error';
export type HealthKind = 'unknown' | 'healthy' | 'unhealthy';

export interface AppRow {
  name: string;
  status: StatusKind;
  port: number | null;
  url?: string | null;
  health: HealthKind;
  errorCount: number;
  uptimeMs: number | null;
  workspaceLabel: string | null;
  lastChangeMs?: number;
  cpu?: number | null;
  memMB?: number | null;
  tags?: string[];
}

export interface Overview {
  ts: number;
  version?: string;
  totals: { apps: number; serving: number; errors: number; stopped: number; totalErrCount: number; totalCpuPct?: number; totalMemMb?: number };
  byStatus: Record<string, string[]>;
  needsAttention: { name: string; status: string; errCount: number; firstError: { file: string | null; line: number | null; code: string | null; message: string } | null }[];
  recentlyChanged: { name: string; transition: string; msAgo: number }[];
  _meta?: { suggestion?: string };
}

export interface EventRecord {
  ts: number;
  app?: string;
  type: string;
  from?: string;
  to?: string;
  message?: string;
}

export interface DiscoveryMeta {
  searchRoots: string[];
  scanned: number;
  rejected: Record<string, number>;
  warnings: string[];
  appsFound: number;
  suggestion: string;
}

const EVENT_BUFFER_MAX = 200;
const POLL_MS = 5_000;

@Injectable({ providedIn: 'root' })
export class DaimonApi {
  private readonly http = inject(HttpClient);

  apps = signal<AppRow[]>([]);
  overview = signal<Overview | null>(null);
  events = signal<EventRecord[]>([]);
  connected = signal<boolean>(false);
  ready = signal<boolean>(false);

  workspaces = computed(() => {
    const seen = new Set<string>();
    for (const a of this.apps()) if (a.workspaceLabel) seen.add(a.workspaceLabel);
    return Array.from(seen).sort();
  });

  byName(name: string): AppRow | undefined {
    return this.apps().find(a => a.name === name);
  }

  private streamStop?: () => void;
  private pollTimer?: ReturnType<typeof setInterval>;

  // Start the live data layer. SSE events drive targeted patches; a low-rate
  // poll backstops cpu/mem/uptime (which don't emit events).
  start(): void {
    if (this.streamStop) return;
    void this.refresh();
    this.streamStop = this.openEventStream();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
  }

  stop(): void {
    this.streamStop?.();
    this.streamStop = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async refresh(): Promise<void> {
    try {
      const [apps, overview] = await Promise.all([
        firstValueFrom(this.http.get<AppRow[]>('/api/apps?format=full')),
        firstValueFrom(this.http.get<Overview>('/api/overview')),
      ]);
      this.apps.set(Array.isArray(apps) ? apps : []);
      this.overview.set(overview ?? null);
      this.connected.set(true);
      this.ready.set(true);
    } catch {
      this.connected.set(false);
    }
  }

  async appDetail(name: string): Promise<any | null> {
    try {
      return await firstValueFrom(this.http.get<any>(`/api/apps/${encodeURIComponent(name)}?format=full`));
    } catch { return null; }
  }

  async appErrors(name: string): Promise<any[]> {
    try {
      const r = await firstValueFrom(this.http.get<any[]>(`/api/apps/${encodeURIComponent(name)}/errors?format=full`));
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }

  async startApp(name: string): Promise<void> {
    this.patch(name, { status: 'starting' });
    await firstValueFrom(this.http.post(`/api/apps/${encodeURIComponent(name)}/start`, {}));
    await this.refresh();
  }

  async stopApp(name: string): Promise<void> {
    this.patch(name, { status: 'stopped' });
    await firstValueFrom(this.http.post(`/api/apps/${encodeURIComponent(name)}/stop`, {}));
    await this.refresh();
  }

  async restartApp(name: string): Promise<void> {
    this.patch(name, { status: 'starting' });
    await firstValueFrom(this.http.post(`/api/apps/${encodeURIComponent(name)}/restart`, {}));
    await this.refresh();
  }

  async ensureApp(name: string, until: 'serving' | 'healthy' = 'healthy', timeoutMs = 180_000): Promise<any> {
    return firstValueFrom(this.http.post<any>(`/api/apps/${encodeURIComponent(name)}/ensure?until=${until}&timeoutMs=${timeoutMs}`, {}));
  }

  async ensureUp(profile: string, until: 'serving' | 'healthy' = 'healthy', timeoutMs = 300_000): Promise<any> {
    return firstValueFrom(this.http.post<any>(`/api/profiles/${encodeURIComponent(profile)}/ensure-up?until=${until}&timeoutMs=${timeoutMs}`, {}));
  }

  async discoveryExplain(): Promise<DiscoveryMeta | null> {
    try { return await firstValueFrom(this.http.get<DiscoveryMeta>('/api/discovery/explain')); }
    catch { return null; }
  }

  async getConfig(): Promise<{ etag: string; config: any } | null> {
    try { return await firstValueFrom(this.http.get<any>('/api/config')); } catch { return null; }
  }

  async patchConfig(etag: string, patch: any): Promise<any> {
    return firstValueFrom(this.http.patch<any>('/api/config', patch, { headers: { 'if-match': etag } }));
  }

  async reloadConfig(): Promise<any> {
    return firstValueFrom(this.http.post<any>('/api/config/reload', {}));
  }

  async runAutoFix(opts: { dryRun?: boolean; permitted?: string[] } = {}): Promise<any> {
    return firstValueFrom(this.http.post<any>('/api/doctor/auto-fix', opts));
  }

  async getCompileTimes(name: string, limit = 100): Promise<{ ts: number; ms: number }[]> {
    try {
      const r = await firstValueFrom(this.http.get<any[]>(`/api/history/compile-times?app=${encodeURIComponent(name)}&limit=${limit}`));
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }

  async getTrends(opts: { app?: string; metric: 'compile' | 'bundle' | 'errors' | 'restarts'; since: '24h' | '7d' | '30d' }): Promise<{ app: string | null; metric: string; since: string; points: { t: number; v: number; v2?: number }[]; _meta?: { aggregation: string; count: number } } | null> {
    try {
      const params = new URLSearchParams();
      if (opts.app) params.set('app', opts.app);
      params.set('metric', opts.metric);
      params.set('since', opts.since);
      return await firstValueFrom(this.http.get<any>(`/api/history/trends?${params.toString()}`));
    } catch { return null; }
  }

  async getSelf(): Promise<any | null> {
    try { return await firstValueFrom(this.http.get<any>('/api/self')); }
    catch { return null; }
  }

  async getSelfHistory(since: '1h' | '6h' | '24h' | '7d' = '6h'): Promise<{ ts: number; rssMB: number; heapUsedMB: number; eventLoopLagMs: number; historyQueryP95Ms: number }[]> {
    try {
      const r = await firstValueFrom(this.http.get<any[]>(`/api/self/history?since=${since}`));
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }

  async getBundles(name: string, limit = 100): Promise<{ ts: number; initialKB: number; lazyKB: number; fileCount: number }[]> {
    try {
      const r = await firstValueFrom(this.http.get<any[]>(`/api/history/bundles?app=${encodeURIComponent(name)}&limit=${limit}`));
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }

  async getHistoryWhy(name: string): Promise<any | null> {
    try { return await firstValueFrom(this.http.get<any>(`/api/history/why/${encodeURIComponent(name)}`)); }
    catch { return null; }
  }

  openLogStream(name: string, onLine: (line: { ts: number; line: string }) => void): () => void {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(name)}/logs/stream`, { signal: ctl.signal });
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
          for (const raw of lines) {
            const line = raw.startsWith('data: ') ? raw.slice(6) : raw;
            if (!line.trim()) continue;
            try { onLine(JSON.parse(line)); } catch {}
          }
        }
      } catch {}
    })();
    return () => ctl.abort();
  }

  private patch(name: string, p: Partial<AppRow>): void {
    this.apps.update(rows => rows.map(r => r.name === name ? { ...r, ...p } : r));
  }

  private appendEvent(ev: EventRecord): void {
    this.events.update(list => {
      const next = list.concat(ev);
      return next.length > EVENT_BUFFER_MAX ? next.slice(next.length - EVENT_BUFFER_MAX) : next;
    });
  }

  // Apply an SSE event to local state without a full refetch.
  private applyEvent(ev: EventRecord): void {
    this.appendEvent(ev);
    if (!ev.app) return;
    if (ev.type === 'status' && ev.to) {
      this.patch(ev.app, { status: ev.to as StatusKind, lastChangeMs: 0 });
    } else if (ev.type === 'health' && ev.to) {
      this.patch(ev.app, { health: ev.to as HealthKind });
    } else if (ev.type === 'error') {
      this.apps.update(rows => rows.map(r => r.name === ev.app ? { ...r, errorCount: (r.errorCount ?? 0) + 1 } : r));
    }
  }

  private openEventStream(): () => void {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/events?stream=ndjson', { signal: ctl.signal });
        this.connected.set(true);
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
            try { this.applyEvent(JSON.parse(line)); } catch {}
          }
        }
      } catch {
        this.connected.set(false);
      }
    })();
    return () => ctl.abort();
  }
}

export function statusBadge(s: { status: StatusKind; health?: HealthKind }): { color: string; label: string; kind: string } {
  switch (s.status) {
    case 'serving': return { color: 'var(--mat-sys-primary)', label: s.health === 'healthy' ? 'healthy' : 'serving', kind: 'serving' };
    case 'compiling': return { color: 'var(--mat-sys-tertiary)', label: 'compiling', kind: 'compiling' };
    case 'starting': return { color: 'var(--mat-sys-secondary)', label: 'starting', kind: 'starting' };
    case 'error': return { color: 'var(--mat-sys-error)', label: 'error', kind: 'error' };
    default: return { color: 'var(--mat-sys-outline)', label: 'stopped', kind: 'stopped' };
  }
}
