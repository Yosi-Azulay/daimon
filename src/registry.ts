import { EventEmitter } from 'node:events';
import type { AppmanConfig, AppState, AppSummary, DiscoveredApp, ErrorEntry } from './types.js';
import { AppProcess } from './appProcess.js';
import { PortAllocator, isPortFree } from './ports.js';

interface Entry {
  app: DiscoveredApp;
  state: AppState;
  proc: AppProcess | null;
}

export class Registry extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private readonly portAlloc: PortAllocator;
  private readonly config: AppmanConfig;

  constructor(config: AppmanConfig, apps: DiscoveredApp[]) {
    super();
    this.config = config;
    this.portAlloc = new PortAllocator(config.portRange);
    for (const app of apps) {
      this.entries.set(app.name, {
        app,
        state: this.freshState(app.name),
        proc: null,
      });
    }
  }

  private freshState(name: string): AppState {
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
    const uptimeMs =
      e.state.startedAt && (e.state.status === 'serving' || e.state.status === 'compiling' || e.state.status === 'starting')
        ? Date.now() - e.state.startedAt
        : null;
    return {
      name: e.state.name,
      status: e.state.status,
      port: e.state.port,
      url: e.state.port ? `http://127.0.0.1:${e.state.port}` : null,
      errorCount: [...e.state.errors.values()].reduce((s, x) => s + x.count, 0),
      uptimeMs,
      lastCompileMs: e.state.lastCompileMs,
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

  async start(name: string): Promise<{ ok: boolean; status: string; error?: string }> {
    const e = this.entries.get(name);
    if (!e) return { ok: false, status: 'unknown', error: 'unknown app' };
    if (e.proc?.isRunning()) return { ok: true, status: e.state.status };

    let port: number;
    try {
      port = await this.portAlloc.allocate(name, e.app.pinnedPort);
    } catch (err: any) {
      e.state.status = 'error';
      e.state.lastStatusMessage = err.message;
      this.emit('change');
      return { ok: false, status: 'error', error: err.message };
    }

    const free = await isPortFree(port);
    if (!free) {
      e.state.status = 'error';
      e.state.port = port;
      e.state.lastStatusMessage = `port ${port} already in use`;
      this.emit('change');
      return { ok: false, status: 'error', error: `port ${port} already in use` };
    }

    const proc = new AppProcess({
      state: e.state,
      app: e.app,
      port,
      onStateChange: () => this.emit('change'),
    });
    e.proc = proc;
    proc.start();
    return { ok: true, status: e.state.status };
  }

  async stop(name: string): Promise<{ ok: boolean; status: string; error?: string }> {
    const e = this.entries.get(name);
    if (!e) return { ok: false, status: 'unknown', error: 'unknown app' };
    if (!e.proc || !e.proc.isRunning()) {
      e.state.status = 'stopped';
      e.state.pid = null;
      this.emit('change');
      return { ok: true, status: 'stopped' };
    }
    await e.proc.stop();
    e.proc = null;
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
  }
}
