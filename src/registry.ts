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
import type { History } from './history.js';
import { dependants, topoLevels, transitiveClosure } from './depends.js';
import { runOneShot, startWatch, type OneShotResult, type WatchTask } from './taskRunner.js';
import { describeHolder, findPortHolder } from './portDiag.js';
import { existingEnvFiles, parseEnvFile, resolveEnvFilePath } from './envFiles.js';
import { readSecrets, substituteSecrets } from './secrets.js';
import { SessionRecorder } from './session.js';

interface Entry {
  app: DiscoveredApp;
  state: AppState;
  proc: AppProcess | null;
  logger?: DiskLogger;
  resolvedUrl?: string;
  prevHealthyAt?: number;
  cascadeArmed?: boolean;
  lastBundleInitialKB?: number;
}

const EVENT_BUFFER_MAX = 500;

export class Registry extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private readonly portAlloc: PortAllocator;
  private readonly config: AppmanConfig;
  private readonly eventBuffer: AppEvent[] = [];
  private history: History | null = null;
  private readonly watchTasks = new Map<string, WatchTask>();
  readonly sessionRecorder = new SessionRecorder();

  constructor(config: AppmanConfig, apps: DiscoveredApp[], portAlloc?: PortAllocator) {
    super();
    this.config = config;
    this.portAlloc = portAlloc ?? new PortAllocator(config.portRange);
    for (const app of apps) {
      this.entries.set(app.name, {
        app,
        state: this.freshState(app.name, app.tags, app.workspaceLabel ?? null),
        proc: null,
      });
    }
  }

  getConfig(): AppmanConfig {
    return this.config;
  }

  addDiscoveredApp(app: DiscoveredApp): void {
    if (this.entries.has(app.name)) return;
    this.entries.set(app.name, { app, state: this.freshState(app.name, app.tags, app.workspaceLabel ?? null), proc: null });
    this.emit('change');
  }

  updateDiscoveredApp(app: DiscoveredApp): void {
    const e = this.entries.get(app.name);
    if (!e) return;
    e.app = app;
    e.state.tags = app.tags;
    e.state.workspaceLabel = app.workspaceLabel ?? null;
    e.state.dependsOn = this.config.depends?.[app.name] ?? [];
    this.emit('change');
  }

  getPortAllocator(): PortAllocator {
    return this.portAlloc;
  }

  setHistory(h: History | null): void {
    this.history = h;
  }

  getHistory(): History | null {
    return this.history;
  }

  private freshState(name: string, tags: string[], workspaceLabel: string | null = null): AppState {
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
      announcedUrl: null,
      lastHealthError: null,
      cachedProbeHost: null,
      lastLogTs: null,
      stale: false,
      bundle: null,
      bundleRegressionPct: null,
      activeEnvFile: null,
      sessionOverrides: null,
      dependsOn: this.config.depends?.[name] ?? [],
      workspaceLabel,
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
    const override = this.config.overrides?.[name]?.url;
    const resolvedUrl = override
      || e.resolvedUrl
      || s.announcedUrl
      || (s.port ? `http://127.0.0.1:${s.port}` : null);
    return {
      name: s.name,
      status: s.status,
      port: s.port,
      url: resolvedUrl,
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
      announcedUrl: s.announcedUrl,
      lastHealthError: s.lastHealthError,
      stale: s.stale,
      bundle: s.bundle,
      bundleRegressionPct: s.bundleRegressionPct,
      dependsOn: [...s.dependsOn],
      activeEnvFile: s.activeEnvFile,
      workspaceLabel: s.workspaceLabel,
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
    this.history?.recordEvent(full);
    this.emit('event', full);
  }

  setHealth(name: string, health: AppHealth): void {
    const e = this.entries.get(name);
    if (!e) return;
    const s = e.state;
    s.lastHealthAt = Date.now();
    if (s.health === health) return;
    const from = s.health;
    s.health = health;
    if (health === 'healthy') {
      e.prevHealthyAt = Date.now();
      if (e.cascadeArmed) {
        e.cascadeArmed = false;
        this.triggerCascadeRestart(name);
      }
    }
    this.recordEvent({ app: name, type: 'health', from, to: health });
    this.emit('change');
  }

  armCascade(name: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    if (!this.config.cascadeRestart) return;
    if (e.prevHealthyAt == null) return;
    e.cascadeArmed = true;
  }

  setLastHealthError(name: string, msg: string | null): void {
    const s = this.getState(name);
    if (!s) return;
    if (s.lastHealthError === msg) return;
    s.lastHealthError = msg;
    this.emit('change');
  }

  setResolvedUrl(name: string, url: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    if (e.resolvedUrl === url) return;
    e.resolvedUrl = url;
    this.emit('change');
  }

  setCachedProbeHost(name: string, host: string): void {
    const s = this.getState(name);
    if (!s) return;
    s.cachedProbeHost = host;
  }

  setStale(name: string, stale: boolean): void {
    const s = this.getState(name);
    if (!s) return;
    if (s.stale === stale) return;
    s.stale = stale;
    this.emit('change');
  }

  setSessionOverride(name: string, overrides: { command?: string; port?: number; env?: Record<string, string> } | null): void {
    const s = this.getState(name);
    if (!s) return;
    s.sessionOverrides = overrides;
    this.emit('change');
  }

  setActiveEnvFile(name: string, file: string | null): void {
    const s = this.getState(name);
    if (!s) return;
    s.activeEnvFile = file;
    this.emit('change');
  }

  async start(name: string): Promise<{ ok: boolean; status: string; error?: string }> {
    this.sessionRecorder.append({ kind: 'start', app: name });
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
      const holder = findPortHolder(port);
      const msg = describeHolder(port, holder);
      e.state.status = 'error';
      e.state.port = port;
      e.state.lastStatusMessage = msg;
      this.recordEvent({ app: name, type: 'status', from: prevStatus, to: 'error', message: msg });
      this.emit('change');
      return { ok: false, status: 'error', error: msg };
    }

    e.state.health = 'unknown';
    e.state.lastHealthAt = null;
    e.state.announcedUrl = null;
    e.state.lastHealthError = null;
    e.state.cachedProbeHost = null;
    e.state.stale = false;
    e.state.lastLogTs = null;
    e.resolvedUrl = undefined;
    if (!e.logger && this.config.logs.enabled) {
      e.logger = new DiskLogger(name, this.config.logs);
    }
    const so = e.state.sessionOverrides;
    const envFileCandidates = this.config.envFiles?.[name] ?? [];
    let envFromFile: Record<string, string> = {};
    if (envFileCandidates.length) {
      let active = e.state.activeEnvFile;
      if (!active || !existingEnvFiles(e.app.workspaceRoot, [active]).length) {
        const found = existingEnvFiles(e.app.workspaceRoot, envFileCandidates);
        active = found[0] ?? null;
        if (active) e.state.activeEnvFile = active;
      }
      if (active) {
        envFromFile = parseEnvFile(resolveEnvFilePath(e.app.workspaceRoot, active));
      }
    }
    const baseEnv = { ...envFromFile, ...(this.config.overrides?.[name]?.env ?? {}), ...(so?.env ?? {}) };
    const secrets = readSecrets();
    const mergedEnvOverride = substituteSecrets(baseEnv, secrets);
    const proc = new AppProcess({
      state: e.state,
      app: e.app,
      port,
      envOverride: Object.keys(mergedEnvOverride).length ? mergedEnvOverride : undefined,
      commandOverride: so?.command,
      onStateChange: () => this.emit('change'),
      onStatusChange: (from, to, message) => {
        this.recordEvent({ app: name, type: 'status', from, to, message });
        if ((to === 'stopped' || to === 'error') && (from === 'serving' || from === 'compiling')) {
          this.armCascade(name);
        }
      },
      onErrorRecorded: (entry, isNew) =>
        this.recordEvent({ app: name, type: isNew ? 'error-new' : 'error-recur', message: entry.message }),
      onExit: (code, signal, stopping) => this.emit('childExit', { name, code, signal, stopping }),
      onLogLine: line => { e.logger?.write(line); this.emit('log', { name, ts: Date.now(), line }); },
      onCompile: ms => {
        this.history?.recordCompile(name, ms);
        const state = this.getState(name)!;
        const prevInit = e.lastBundleInitialKB;
        if (state.bundle && state.bundle.initialKB > 0) {
          if (prevInit && prevInit > 0) {
            const pct = ((state.bundle.initialKB - prevInit) / prevInit) * 100;
            state.bundleRegressionPct = Math.round(pct * 10) / 10;
            if (pct > 10) {
              this.recordEvent({ app: name, type: 'bundle-regression', message: `initialKB +${state.bundleRegressionPct}% (${prevInit}->${state.bundle.initialKB})` });
            }
          } else {
            state.bundleRegressionPct = null;
          }
          e.lastBundleInitialKB = state.bundle.initialKB;
        }
        this.checkCompileRegression(name, ms);
        this.emit('compile', { name, ms });
      },
      onBundleUpdate: () => this.emit('bundleUpdate', { name }),
    });
    e.proc = proc;
    this.recordEvent({ app: name, type: 'status', from: prevStatus, to: 'starting' });
    proc.start();
    return { ok: true, status: e.state.status };
  }

  async stop(name: string): Promise<{ ok: boolean; status: string; error?: string }> {
    this.sessionRecorder.append({ kind: 'stop', app: name });
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
    this.sessionRecorder.append({ kind: 'restart', app: name });
    await this.stop(name);
    return this.start(name);
  }

  async startWithDeps(name: string, opts: { waitMs?: number } = {}): Promise<{ ok: boolean; results: { name: string; status: string; health: string; error?: string }[] }> {
    if (!this.entries.has(name)) return { ok: false, results: [{ name, status: 'unknown', health: 'unknown', error: 'unknown app' }] };
    const closure = transitiveClosure(this.config.depends ?? {}, name).filter(n => this.entries.has(n));
    const levels = topoLevels(this.config.depends ?? {}, closure);
    const results: { name: string; status: string; health: string; error?: string }[] = [];
    const waitMs = opts.waitMs ?? 60_000;
    for (const level of levels) {
      const startResults = await Promise.all(level.map(n => this.start(n)));
      for (let i = 0; i < level.length; i++) {
        const sr = startResults[i];
        if (!sr.ok) {
          results.push({ name: level[i], status: sr.status, health: 'unknown', error: sr.error });
          return { ok: false, results };
        }
      }
      const waits = await Promise.all(level.map(n => this.waitFor(n, 'healthy', waitMs)));
      for (let i = 0; i < level.length; i++) {
        const w = waits[i];
        const reachedHealthy = !w.timedOut && w.status === 'serving' && w.health === 'healthy';
        results.push({ name: w.name, status: w.status, health: w.health, error: reachedHealthy ? undefined : (w.timedOut ? 'timeout waiting for healthy' : 'did not reach healthy') });
        if (!reachedHealthy) return { ok: false, results };
      }
    }
    return { ok: true, results };
  }

  triggerCascadeRestart(target: string): void {
    if (!this.config.cascadeRestart) return;
    const ds = dependants(this.config.depends ?? {}, target);
    for (const d of ds) {
      const s = this.getState(d);
      if (!s) continue;
      if (s.status === 'serving' || s.status === 'compiling' || s.status === 'starting') {
        void this.restart(d);
      }
    }
  }

  async stopAll(timeoutMs = 3000): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const e of this.entries.values()) {
      if (e.proc?.isRunning()) tasks.push(e.proc.stop());
    }
    for (const wt of this.watchTasks.values()) tasks.push(wt.stop());
    await Promise.race([
      Promise.all(tasks),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
    for (const e of this.entries.values()) e.logger?.close();
  }

  listTasks(name: string): string[] | null {
    const app = this.getApp(name);
    if (!app) return null;
    return [...(app.tasks ?? [])];
  }

  async runTask(name: string, task: string, args: string[] = []): Promise<OneShotResult | { error: string }> {
    this.sessionRecorder.append({ kind: 'run', app: name, task, args });
    const app = this.getApp(name);
    if (!app) return { error: 'unknown app' };
    const result = await runOneShot(app, task, args);
    this.history?.recordTaskRun(name, task, result.exitCode, result.durationMs, result.summary);
    this.recordEvent({ app: name, type: 'task-run', message: `${task} exit=${result.exitCode} duration=${result.durationMs}ms` });
    this.emit('taskRun', { name, task, result });
    return result;
  }

  startWatchTask(name: string, task: string, args: string[] = []): { ok: boolean; pid?: number | null; error?: string } {
    const app = this.getApp(name);
    if (!app) return { ok: false, error: 'unknown app' };
    const key = `${name}::${task}`;
    if (this.watchTasks.has(key)) return { ok: true, pid: this.watchTasks.get(key)!.pid };
    const wt = startWatch(app, task, args);
    this.watchTasks.set(key, wt);
    wt.child.on('exit', () => this.watchTasks.delete(key));
    return { ok: true, pid: wt.pid };
  }

  async stopWatchTask(name: string, task: string): Promise<{ ok: boolean }> {
    const key = `${name}::${task}`;
    const wt = this.watchTasks.get(key);
    if (!wt) return { ok: true };
    await wt.stop();
    this.watchTasks.delete(key);
    return { ok: true };
  }

  listWatchTasks(name?: string): { app: string; task: string; pid: number | null; startedAt: number }[] {
    const out: { app: string; task: string; pid: number | null; startedAt: number }[] = [];
    for (const wt of this.watchTasks.values()) {
      if (name && wt.app !== name) continue;
      out.push({ app: wt.app, task: wt.task, pid: wt.pid, startedAt: wt.startedAt });
    }
    return out;
  }

  private checkCompileRegression(name: string, ms: number): void {
    const h = this.history;
    if (!h) return;
    const rows = h.queryCompiles({ app: name, limit: 31 });
    const prior = rows.filter(r => r.ms !== ms).slice(0, 30).map(r => r.ms);
    if (prior.length < 10) return;
    const sorted = [...prior].sort((a, b) => a - b);
    const p50 = sorted[Math.floor((sorted.length - 1) * 0.5)];
    if (ms > 2 * p50) {
      this.recordEvent({ app: name, type: 'compile-regression', message: `${(ms / 1000).toFixed(1)}s vs p50 ${(p50 / 1000).toFixed(1)}s` });
    }
  }

  watchTaskLogs(name: string, task: string, tail?: number): string[] | null {
    const wt = this.watchTasks.get(`${name}::${task}`);
    if (!wt) return null;
    const lines = wt.logs;
    return tail ? lines.slice(-tail) : [...lines];
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
