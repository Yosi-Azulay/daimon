import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { FlakyTest, TestRun } from './tests-page-helpers';
import type { SearchHit } from './command-palette-helpers';

export type StatusKind = 'stopped' | 'starting' | 'compiling' | 'serving' | 'error';
export type HealthKind = 'unknown' | 'healthy' | 'unhealthy';

export interface AppRow {
  name: string;
  baseName?: string;
  status: StatusKind;
  port: number | null;
  url?: string | null;
  health: HealthKind;
  errorCount: number;
  warningCount?: number;
  lintCount?: number;
  uptimeMs: number | null;
  workspaceLabel: string | null;
  workspaceRoot?: string | null;
  lastChangeMs?: number;
  cpu?: number | null;
  memMB?: number | null;
  tags?: string[];
  estimatedReadyAtMs?: number;
  // Framework registry profile id — drives the badge + tone (M70).
  serverProfile?: string | null;
}

export interface FrameworkMeta {
  id: string;
  family: string;
  builtin: boolean;
  badge: string;
  tone: number;
  matches: number;
  apps: string[];
}

export interface WorkspaceRow {
  path: string;
  label: string | null;
  appCount: number;
  apps: string[];
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

export interface AgentRecord {
  id: string;
  firstSeen: number;
  lastSeen: number;
  cwd: string | null;
  callCount: number;
}

export interface LockSnapshot {
  agent: string;
  lockedAt: number;
  expiresAt: number;
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
// Matches the server's agent-inactive window (agents.ts AGENT_INACTIVE_MS).
const AGENT_RECENT_MS = 5 * 60_000;

@Injectable({ providedIn: 'root' })
export class DaimonApi {
  private readonly http = inject(HttpClient);

  apps = signal<AppRow[]>([]);
  overview = signal<Overview | null>(null);
  events = signal<EventRecord[]>([]);
  connected = signal<boolean>(false);
  ready = signal<boolean>(false);
  // cwd hint from `?cwd=` query param; null when not present. Used by M49
  // pre-select + unknown-cwd banner. `cwdResolved` is the workspace label
  // covering that cwd (null when daemon hasn't seen it yet).
  cwdHint = signal<string | null>(null);
  cwdResolved = signal<{ path: string; label: string | null } | null>(null);
  cwdUnknown = signal<boolean>(false);
  workspaceRows = signal<WorkspaceRow[]>([]);
  agentLocks = signal<Record<string, LockSnapshot>>({});
  agentSelf = signal<string | null>(null);
  // /api/agents only ties agents to apps through live locks, so lock sightings
  // are accumulated across polls to build a per-app "recently interacted" list.
  appAgents = signal<Record<string, { agent: string; at: number }[]>>({});
  // Framework registry metadata (badge/tone per profile id), fetched once —
  // the registry only changes on daemon restart or config reload (M70).
  frameworks = signal<Record<string, FrameworkMeta>>({});
  // 24h status/error buckets per app for the mission-control sparkline (M70).
  sparkBuckets = signal<Record<string, string[]>>({});

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
    void this.loadFrameworks();
    void this.loadSparkline();
    this.streamStop = this.openEventStream();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
    this.sparkTimer = setInterval(() => void this.loadSparkline(), 60_000);
  }

  private sparkTimer?: ReturnType<typeof setInterval>;

  async loadFrameworks(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ profiles: FrameworkMeta[] }>('/api/frameworks'));
      const map: Record<string, FrameworkMeta> = {};
      for (const p of r?.profiles ?? []) map[p.id] = p;
      this.frameworks.set(map);
    } catch { /* badge-less rendering is fine */ }
  }

  frameworkFor(profileId: string | null | undefined): FrameworkMeta | null {
    if (!profileId) return null;
    return this.frameworks()[profileId] ?? null;
  }

  // 24 hourly buckets per app from the history timeline. Bucket kind ranks
  // error > compiling/starting > serving > stopped (an error mark must not
  // be washed out by a later serving event in the same hour).
  async loadSparkline(): Promise<void> {
    try {
      const rows = await firstValueFrom(this.http.get<any[]>('/api/history/timeline?since=24h&kinds=status,error&limit=5000'));
      if (!Array.isArray(rows)) return;
      const BUCKETS = 24;
      const windowMs = 24 * 3600 * 1000;
      const now = Date.now();
      const cutoff = now - windowMs;
      const bucketMs = windowMs / BUCKETS;
      const ranks: Record<string, number> = { stopped: 1, serving: 2, compiling: 3, starting: 3, error: 4 };
      const out: Record<string, string[]> = {};
      for (const r of rows) {
        if (!r?.app || typeof r.ts !== 'number' || r.ts < cutoff) continue;
        const kind = r.kind === 'error' ? 'error' : (r.payload?.to_state ?? r.payload?.to);
        if (!kind || !(kind in ranks)) continue;
        const idx = Math.min(BUCKETS - 1, Math.floor((r.ts - cutoff) / bucketMs));
        let arr = out[r.app];
        if (!arr) { arr = new Array(BUCKETS).fill(''); out[r.app] = arr; }
        const prev = arr[idx];
        if (!prev || ranks[kind] > (ranks[prev] ?? 0)) arr[idx] = kind;
      }
      this.sparkBuckets.set(out);
    } catch { /* sparkline is decorative — never block the page on it */ }
  }

  stop(): void {
    this.streamStop?.();
    this.streamStop = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.sparkTimer) clearInterval(this.sparkTimer);
    this.sparkTimer = undefined;
  }

  async refresh(): Promise<void> {
    try {
      const [apps, overview, agentInfo] = await Promise.all([
        firstValueFrom(this.http.get<AppRow[]>('/api/apps?format=full')),
        firstValueFrom(this.http.get<Overview>('/api/overview')),
        this.getAgents(),
      ]);
      this.apps.set(Array.isArray(apps) ? apps : []);
      this.overview.set(overview ?? null);
      this.agentLocks.set(agentInfo.locks);
      this.agentSelf.set(agentInfo.self);
      this.noteAgentActivity(agentInfo.locks);
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
      const r = await firstValueFrom(this.http.get<any[]>(`/api/apps/${encodeURIComponent(name)}/errors?format=full&level=all`));
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

  // Batched v0.9 trends fetch: one HTTP round-trip returns all four metrics
  // for one app. Cuts the Trends page from 4N parallel calls down to N.
  async getTrendsMulti(opts: { app?: string; metrics: ('compile' | 'bundle' | 'errors' | 'restarts')[]; since: '24h' | '7d' | '30d' }): Promise<{ app: string | null; since: string; metrics: Record<string, { points: { t: number; v: number; v2?: number }[]; count: number }>; _meta?: { aggregation: string } } | null> {
    try {
      const params = new URLSearchParams();
      if (opts.app) params.set('app', opts.app);
      params.set('metrics', opts.metrics.join(','));
      params.set('since', opts.since);
      return await firstValueFrom(this.http.get<any>(`/api/history/trends?${params.toString()}`));
    } catch { return null; }
  }

  async getSelf(): Promise<any | null> {
    try { return await firstValueFrom(this.http.get<any>('/api/self')); }
    catch { return null; }
  }

  async listWorkspaces(): Promise<WorkspaceRow[]> {
    try {
      const r = await firstValueFrom(this.http.get<WorkspaceRow[]>('/api/workspaces'));
      const arr = Array.isArray(r) ? r : [];
      this.workspaceRows.set(arr);
      return arr;
    } catch { return []; }
  }

  async resolveCwd(cwd: string): Promise<{ path: string; label: string | null; cwd: string } | null> {
    try {
      return await firstValueFrom(this.http.get<any>(`/api/workspaces/resolve?cwd=${encodeURIComponent(cwd)}`));
    } catch { return null; }
  }

  async registerWorkspace(p: string, label?: string | null): Promise<{ added: boolean; root?: string; reason?: string }> {
    const body: any = { path: p };
    if (label) body.label = label;
    return firstValueFrom(this.http.post<any>('/api/workspaces/ensure', body));
  }

  async getTimeline(opts: { since?: string; app?: string; kinds?: string } = {}): Promise<any[]> {
    try {
      const qs = new URLSearchParams();
      if (opts.since) qs.set('since', opts.since);
      if (opts.app) qs.set('app', opts.app);
      if (opts.kinds) qs.set('kinds', opts.kinds);
      const q = qs.toString();
      const r = await firstValueFrom(this.http.get<any[]>('/api/history/timeline' + (q ? '?' + q : '')));
      return Array.isArray(r) ? r : [];
    } catch { return []; }
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

  // Test run history (M74/M75). Omitting `app` returns the most recent runs
  // across every app, newest first — the Tests page groups client-side.
  async getTestRuns(opts: { app?: string; limit?: number; since?: string } = {}): Promise<TestRun[]> {
    try {
      const qs = new URLSearchParams();
      if (opts.app) qs.set('app', opts.app);
      if (opts.limit) qs.set('limit', String(opts.limit));
      if (opts.since) qs.set('since', opts.since);
      const q = qs.toString();
      const r = await firstValueFrom(this.http.get<{ runs: TestRun[] }>('/api/tests' + (q ? '?' + q : '')));
      return Array.isArray(r?.runs) ? r.runs : [];
    } catch { return []; }
  }

  async getFlakyTests(app?: string): Promise<{ flaky: FlakyTest[]; threshold: number }> {
    try {
      const q = app ? `?app=${encodeURIComponent(app)}` : '';
      const r = await firstValueFrom(this.http.get<{ flaky: FlakyTest[]; threshold: number }>('/api/tests/flaky' + q));
      return { flaky: Array.isArray(r?.flaky) ? r.flaky : [], threshold: r?.threshold ?? 3 };
    } catch { return { flaky: [], threshold: 3 }; }
  }

  // Full-text search (M77) — command palette's `>` search mode.
  async search(opts: { q: string; app?: string; kind?: 'logs' | 'errors' | 'events'; limit?: number }): Promise<{ hits: SearchHit[]; fallback: boolean }> {
    if (!opts.q.trim()) return { hits: [], fallback: false };
    try {
      const qs = new URLSearchParams();
      qs.set('q', opts.q);
      if (opts.app) qs.set('app', opts.app);
      if (opts.kind) qs.set('kind', opts.kind);
      qs.set('limit', String(opts.limit ?? 30));
      const r = await firstValueFrom(this.http.get<{ hits: SearchHit[]; fallback: boolean }>('/api/search?' + qs.toString()));
      return { hits: Array.isArray(r?.hits) ? r.hits : [], fallback: !!r?.fallback };
    } catch { return { hits: [], fallback: false }; }
  }

  async getAgents(): Promise<{ agents: AgentRecord[]; locks: Record<string, LockSnapshot>; self: string | null }> {
    try {
      const r = await firstValueFrom(this.http.get<any>('/api/agents'));
      return {
        agents: Array.isArray(r?.agents) ? r.agents : [],
        locks: r?.locks && typeof r.locks === 'object' ? r.locks : {},
        self: typeof r?.self === 'string' ? r.self : null,
      };
    } catch { return { agents: [], locks: {}, self: null }; }
  }

  async getHistoryEvents(opts: { type?: string; app?: string; since?: string; limit?: number } = {}): Promise<EventRecord[]> {
    try {
      const qs = new URLSearchParams();
      if (opts.type) qs.set('type', opts.type);
      if (opts.app) qs.set('app', opts.app);
      if (opts.since) qs.set('since', opts.since);
      if (opts.limit) qs.set('limit', String(opts.limit));
      const q = qs.toString();
      const r = await firstValueFrom(this.http.get<any[]>('/api/history/events' + (q ? '?' + q : '')));
      if (!Array.isArray(r)) return [];
      return r.map(row => ({
        ts: row.ts,
        app: row.app,
        type: row.type,
        from: row.from_state ?? row.from,
        to: row.to_state ?? row.to,
        message: row.message,
      }));
    } catch { return []; }
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

  private noteAgentActivity(locks: Record<string, LockSnapshot>): void {
    const now = Date.now();
    this.appAgents.update(map => {
      const next: Record<string, { agent: string; at: number }[]> = {};
      for (const [app, list] of Object.entries(map)) {
        const kept = list.filter(e => now - e.at <= AGENT_RECENT_MS);
        if (kept.length) next[app] = kept;
      }
      for (const [app, lk] of Object.entries(locks)) {
        const list = (next[app] ?? []).filter(e => e.agent !== lk.agent);
        list.unshift({ agent: lk.agent, at: Math.min(now, lk.lockedAt) });
        next[app] = list.slice(0, 3);
      }
      return next;
    });
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
