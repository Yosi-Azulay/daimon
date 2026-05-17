import { EventEmitter } from 'node:events';
import type {
  AppEvent,
  AppEventType,
  AppHealth,
  AppmanConfig,
  AppState,
  AppSummary,
  DiscoveredApp,
  ErrorEntry,
} from './types.js';
import { AppProcess } from './appProcess.js';
import { PortAllocator, isPortFree } from './ports.js';
import { DiskLogger } from './diskLogger.js';

interface Entry {
  app: DiscoveredApp;
  state: AppState;
  proc: AppProcess | null;
  logger?: DiskLogger;
}

const EVENT_BUFFER_MAX = 500;

export class Registry extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private readonly portAlloc: PortAllocator;
  private readonly config: AppmanConfig;
  private readonly eventBuffer: AppEvent[] = [];

  constructor(config: AppmanConfig, apps: DiscoveredApp[], portAlloc?: PortAllocator) {
    super();
    this.config = config;
    this.portAlloc = portAlloc ?? new PortAllocator(config.portRange);
    for (const app of apps) {
      this.entries.set(app.name, {
        app,
        state: this.freshState(app.name, app.tags),
        proc: null,
      });
    }
  }

  getConfig(): AppmanConfig {
    return this.config;
  }

  getPortAllocator(): PortAllocator {
    return this.portAlloc;
  }

  private freshState(name: string, tags: string[]): AppState {
    return {
      name,
      status: 'stopped',
      port: null,
      pid: null,
      startedAt: null,
      compileStartedAt: null,
      lastCompileMs: null,
      lastCompileAt: null,
      logBuffer: [],
      errors: new Map<string, ErrorEntry>(),
      compileHistory: [],
      health: 'unknown',
      lastHealthAt: null,
      cpu: null,
      memMB: null,
      restartAttempts: 0,
      restartWindowStart: null,
      nextRestartAt: null,
      tags,
    };
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  list(): AppSummary[] {
    return this.names().map(n => this.summary(n)!);
  }

  summary(name: string): AppSummary | null {
    const e = this.entries.get(name);
    if (!e) return null;
    const s = e.state;
    const uptimeMs =
      s.startedAt && (s.status === 'serving' || s.status === 'compiling' || s.status === 'starting')
        ? Date.now() - s.startedAt
        : null;
    return {
      name: s.name,
      status: s.status,
      port: s.port,
      url: s.port ? `http://127.0.0.1:${s.port}` : null,
      errorCount: [...s.errors.values()].reduce((acc, x) => acc + x.count, 0),
      uptimeMs,
      lastCompileMs: s.lastCompileMs,
      health: s.health,
      lastHealthAt: s.lastHealthAt,
      cpu: s.cpu,
      memMB: s.memMB,
      compileHistoryMs: [...s.compileHistory],
      tags: [...s.tags],
      restartAttempts: s.restartAttempts,
      nextRestartAt: s.nextRestartAt,
    };
  }

  getState(name: string): AppState | null {
    return this.entries.get(name)?.state ?? null;
  }

  getApp(name: string): DiscoveredApp | null {
    return this.entries.get(name)?.app ?? null;
  }

  errors(name: string): ErrorEntry[] | null {
    const s = this.getState(name);
    if (!s) return null;
    return [...s.errors.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  errorsSince(name: string, sinceMs: number): ErrorEntry[] | null {
    const s = this.getState(name);
    if (!s) return null;
    return [...s.errors.values()].filter(e => e.lastSeen > sinceMs).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  logs(name: string, opts: { tail?: number; sinceMs?: number } = {}): string[] | null {
    const s = this.getState(name);
    if (!s) return null;
    let entries = s.logBuffer;
    if (opts.sinceMs && opts.sinceMs > 0) {
      const cutoff = Date.now() - opts.sinceMs;
      entries = entries.filter(e => e.ts >= cutoff);
    }
    if (opts.tail && opts.tail > 0) entries = entries.slice(-opts.tail);
    return entries.map(e => e.line);
  }

  events(opts: { sinceMs?: number; app?: string } = {}): AppEvent[] {
    const cutoff = opts.sinceMs && opts.sinceMs > 0 ? Date.now() - opts.sinceMs : 0;
    return this.eventBuffer.filter(e => e.ts >= cutoff && (!opts.app || e.app === opts.app));
  }

  recordEvent(ev: Omit<AppEvent, 'ts'> & { ts?: number }): void {
    const full: AppEvent = { ts: ev.ts ?? Date.now(), ...ev } as AppEvent;
    this.eventBuffer.push(full);
    if (this.eventBuffer.length > EVENT_BUFFER_MAX) {
      this.eventBuffer.splice(0, this.eventBuffer.length - EVENT_BUFFER_MAX);
    }
    this.emit('event', full);
  }

  setHealth(name: string, health: AppHealth): void {
    const s = this.getState(name);
    if (!s) return;
    if (s.health === health) return;
    const from = s.health;
    s.health = health;
    s.lastHealthAt = Date.now();
    this.recordEvent({ app: name, type: 'health', from, to: health });
    this.emit('change');
  }

  async start(name: string): Promise<{ ok: boolean; status: string; error?: string }> {
    const e = this.entries.get(name);
    if (!e) return { ok: false, status: 'unknown', error: 'unknown app' };
    if (e.proc?.isRunning()) return { ok: true, status: e.state.status };

    const prevStatus = e.state.status;
    let port: number;
    try {
      port = await this.portAlloc.allocate(name, e.app.pinnedPort);
    } catch (err: any) {
      e.state.status = 'error';
      e.state.lastStatusMessage = err.message;
      this.recordEvent({ app: name, type: 'status', from: prevStatus, to: 'error', message: err.message });
      this.emit('change');
      return { ok: false, status: 'error', error: err.message };
    }

    const free = await isPortFree(port);
    if (!free) {
      e.state.status = 'error';
      e.state.port = port;
      e.state.lastStatusMessage = `port ${port} already in use`;
      this.recordEvent({ app: name, type: 'status', from: prevStatus, to: 'error', message: `port ${port} already in use` });
      this.emit('change');
      return { ok: false, status: 'error', error: `port ${port} already in use` };
    }

    e.state.health = 'unknown';
    e.state.lastHealthAt = null;
    if (!e.logger && this.config.logs.enabled) {
      e.logger = new DiskLogger(name, this.config.logs);
    }
    const proc = new AppProcess({
      state: e.state,
      app: e.app,
      port,
      onStateChange: () => this.emit('change'),
      onStatusChange: (from, to, message) =>
        this.recordEvent({ app: name, type: 'status', from, to, message }),
      onErrorRecorded: (entry, isNew) =>
        this.recordEvent({ app: name, type: isNew ? 'error-new' : 'error-recur', message: entry.message }),
      onExit: (code, signal, stopping) => this.emit('childExit', { name, code, signal, stopping }),
      onLogLine: line => e.logger?.write(line),
    });
    e.proc = proc;
    this.recordEvent({ app: name, type: 'status', from: prevStatus, to: 'starting' });
    proc.start();
    return { ok: true, status: e.state.status };
  }

  async stop(name: string): Promise<{ ok: boolean; status: string; error?: string }> {
    const e = this.entries.get(name);
    if (!e) return { ok: false, status: 'unknown', error: 'unknown app' };
    this.emit('userStop', { name });
    if (!e.proc || !e.proc.isRunning()) {
      if (e.state.status !== 'stopped') {
        this.recordEvent({ app: name, type: 'status', from: e.state.status, to: 'stopped' });
      }
      e.state.status = 'stopped';
      e.state.pid = null;
      e.state.health = 'unknown';
      this.emit('change');
      return { ok: true, status: 'stopped' };
    }
    const prev = e.state.status;
    await e.proc.stop();
    e.proc = null;
    if (e.state.status !== prev) {
      this.recordEvent({ app: name, type: 'status', from: prev, to: e.state.status });
    }
    return { ok: true, status: e.state.status };
  }

  async restart(name: string): Promise<{ ok: boolean; status: string; error?: string }> {
    await this.stop(name);
    return this.start(name);
  }

  async stopAll(timeoutMs = 3000): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const e of this.entries.values()) {
      if (e.proc?.isRunning()) tasks.push(e.proc.stop());
    }
    await Promise.race([
      Promise.all(tasks),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
    for (const e of this.entries.values()) e.logger?.close();
  }

  waitFor(
    name: string,
    until: 'serving' | 'healthy' | 'stopped' | 'error',
    timeoutMs: number,
  ): Promise<{ name: string; status: string; health: AppHealth; timedOut: boolean; waitedMs: number }> {
    return new Promise(resolve => {
      const start = Date.now();
      const e = this.entries.get(name);
      const check = (): boolean => {
        if (!e) return true;
        const s = e.state;
        if (until === 'serving' && s.status === 'serving') return true;
        if (until === 'healthy' && s.status === 'serving' && s.health === 'healthy') return true;
        if (until === 'stopped' && s.status === 'stopped') return true;
        if (until === 'error' && s.status === 'error') return true;
        return false;
      };
      const done = (timedOut: boolean) => {
        this.off('change', onChange);
        clearTimeout(timer);
        const s = e?.state;
        resolve({
          name,
          status: s?.status ?? 'unknown',
          health: s?.health ?? 'unknown',
          timedOut,
          waitedMs: Date.now() - start,
        });
      };
      const onChange = () => { if (check()) done(false); };
      if (check()) { resolve({ name, status: e!.state.status, health: e!.state.health, timedOut: false, waitedMs: 0 }); return; }
      const timer = setTimeout(() => done(true), timeoutMs);
      this.on('change', onChange);
    });
  }
}
