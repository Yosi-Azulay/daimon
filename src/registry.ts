import { EventEmitter } from 'node:events';
import type {
  AppEvent,
  AppEventType,
  AppHealth,
  AppmanConfig,
  AppState,
  AppStatus,
  AppSummary,
  DiscoveredApp,
  ErrorEntry,
  LogEntry,
} from './types.js';
import { isPathUnder } from './pathScope.js';
import { AppProcess } from './appProcess.js';
import { PortAllocator, isPortFree } from './ports.js';
import { DiskLogger } from './diskLogger.js';
import type { History } from './history.js';
import { dependants, topoLevels, transitiveClosure } from './depends.js';
import { runOneShot, startWatch, type OneShotResult, type WatchTask } from './taskRunner.js';
import { assertSafeCommandParts } from './shellSafe.js';
import { describeHolder, findPortHolder } from './portDiag.js';
import { existingEnvFiles, parseEnvFile, resolveEnvFilePath } from './envFiles.js';
import { readSecrets, substituteSecrets } from './secrets.js';
import { SessionRecorder } from './session.js';
import { detectBundleRegression, detectCompileRegression, detectErrorFlapRegression, suspectCommitForDir } from './regressions.js';
import { allProfiles } from './frameworks.js';
import { compileParseContext } from './parser.js';

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
  private readonly lastStatusEventTs = new Map<string, number>();
  private history: History | null = null;
  private readonly watchTasks = new Map<string, WatchTask>();
  readonly sessionRecorder = new SessionRecorder();

  constructor(config: AppmanConfig, apps: DiscoveredApp[], portAlloc?: PortAllocator) {
    super();
    // Each dashboard tab, long-poll, focus stream, and MCP subscribe_events adds
    // an 'event'/'log' listener (removed on close). More than the default 10
    // concurrent subscribers is normal here, so lift the cap to avoid a spurious
    // MaxListenersExceededWarning on stderr. 0 = unlimited; listeners are still
    // cleaned up on every disconnect path.
    this.setMaxListeners(0);
    this.config = config;
    this.portAlloc = portAlloc ?? new PortAllocator(config.portRange);
    for (const app of apps) {
      this.entries.set(app.name, {
        app,
        state: this.freshState(app.name, app.baseName ?? app.name, app.tags, app.workspaceLabel ?? null, app.workspaceRoot ?? null),
        proc: null,
      });
    }
  }

  getConfig(): AppmanConfig {
    return this.config;
  }

  addDiscoveredApp(app: DiscoveredApp): void {
    if (this.entries.has(app.name)) return;
    this.entries.set(app.name, { app, state: this.freshState(app.name, app.baseName ?? app.name, app.tags, app.workspaceLabel ?? null, app.workspaceRoot ?? null), proc: null });
    this.emit('change');
  }

  // Orphaned-app cleanup (M55): when a soft-reload drops an app from
  // searchRoots, terminate its child process and remove all of its state so
  // it can't keep running with config that no longer exists.
  async detachApp(name: string): Promise<boolean> {
    const e = this.entries.get(name);
    if (!e) return false;
    try { if (e.proc?.isRunning()) await e.proc.stop(); } catch {}
    e.proc = null;
    try { e.logger?.close(); } catch {}
    this.entries.delete(name);
    this.lastStatusEventTs.delete(name);
    this.recordEvent({ app: '__daemon__', type: 'self-warn', message: `orphaned app detached after config reload: ${name}` });
    this.emit('change');
    return true;
  }

  // Session preservation (M55): export/restore the recoverable per-app state
  // (errors, recent logs, compile stats) across daemon restarts and crashes.
  exportSessionState(): { savedAt: number; apps: { name: string; status: AppStatus; port: number | null; errors: ErrorEntry[]; logTail: LogEntry[]; compileHistory: number[] }[] } {
    return {
      savedAt: Date.now(),
      apps: this.names().map(n => {
        const s = this.getState(n)!;
        return {
          name: n,
          status: s.status,
          port: s.port,
          errors: [...s.errors.values()].slice(-50),
          logTail: s.logBuffer.slice(-200),
          compileHistory: s.compileHistory.slice(-10),
        };
      }),
    };
  }

  restoreSessionState(snap: { apps?: { name: string; status?: AppStatus; errors?: ErrorEntry[]; logTail?: LogEntry[]; compileHistory?: number[] }[] } | null): number {
    if (!snap?.apps) return 0;
    let restored = 0;
    for (const a of snap.apps) {
      const s = this.getState(a.name);
      // Only hydrate apps that haven't produced fresh state this session.
      if (!s || s.status !== 'stopped' || s.logBuffer.length || s.errors.size) continue;
      for (const e of a.errors ?? []) {
        if (e && typeof e.message === 'string') s.errors.set(e.message, { ...e });
      }
      if (a.logTail?.length) s.logBuffer.push(...a.logTail);
      if (a.compileHistory?.length && !s.compileHistory.length) s.compileHistory.push(...a.compileHistory);
      if (a.status && a.status !== 'stopped') {
        this.recordEvent({ app: a.name, type: 'status', from: a.status, to: 'stopped', message: 'state restored after daemon restart' });
      }
      restored++;
    }
    if (restored) this.emit('change');
    return restored;
  }

  updateDiscoveredApp(app: DiscoveredApp): void {
    const e = this.entries.get(app.name);
    if (!e) return;
    e.app = app;
    e.state.tags = app.tags;
    e.state.workspaceLabel = app.workspaceLabel ?? null;
    e.state.workspaceRoot = app.workspaceRoot ?? null;
    e.state.baseName = app.baseName ?? app.name;
    e.state.dependsOn = this.config.depends?.[app.baseName ?? app.name] ?? [];
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

  private freshState(name: string, baseName: string, tags: string[], workspaceLabel: string | null = null, workspaceRoot: string | null = null): AppState {
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
      dependsOn: this.config.depends?.[baseName] ?? [],
      workspaceLabel,
      workspaceRoot,
      baseName,
      discoveredHealthPath: null,
    };
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  // Resolve a user-facing name (typically a baseName) plus an optional cwd to a
  // single internal app key. Used by every per-app endpoint: when two
  // workspaces share an app baseName ("editor"), the CLI's process.cwd()
  // disambiguates which one the user means.
  resolveByCwd(name: string, cwd?: string | null): {
    kind: 'unique' | 'none' | 'collision';
    key?: string;
    candidates: { name: string; baseName: string; workspaceLabel: string | null; workspaceRoot: string | null }[];
  } {
    const all = [...this.entries.values()];
    let matches = all.filter(e => e.state.name === name || (e.state.baseName ?? e.state.name) === name);
    if (cwd) {
      matches = matches.filter(e => {
        const root = e.app.workspaceRoot;
        if (!root) return false;
        // Either direction counts: the cwd may sit inside a workspace
        // (`/repo/apps/editor` under `/repo`) or be an umbrella that contains
        // workspaces (`/repos` over `/repos/project-a`). Both are intuitive
        // "cwd belongs to this app" answers.
        return isPathUnder(root, cwd) || isPathUnder(cwd, root);
      });
    }
    const candidates = matches.map(e => ({
      name: e.state.name,
      baseName: e.state.baseName ?? e.state.name,
      workspaceLabel: e.state.workspaceLabel,
      workspaceRoot: e.state.workspaceRoot ?? e.app.workspaceRoot ?? null,
    }));
    if (matches.length === 0) return { kind: 'none', candidates };
    if (matches.length > 1) return { kind: 'collision', candidates };
    return { kind: 'unique', key: matches[0].state.name, candidates };
  }

  pruneOldErrors(now = Date.now()): number {
    const maxAgeMs = this.config.errorRetention?.maxAgeMs ?? 86400000;
    let removed = 0;
    for (const entry of this.entries.values()) {
      for (const [hash, e] of entry.state.errors) {
        if (now - e.lastSeen > maxAgeMs) {
          entry.state.errors.delete(hash);
          removed++;
        }
      }
    }
    return removed;
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
    // Maintained incrementally by recordEvent — summary() is on the
    // /api/apps hot path and must not rescan the event buffer per app (M54).
    const lastStatusTs = this.lastStatusEventTs.get(name);
    const lastChangeMs = lastStatusTs != null ? Date.now() - lastStatusTs : undefined;
    // Ready-time estimate (M61): if the app is currently compiling and we have
    // enough successful compile history, project compileStartedAt + p50 of
    // last 10. The UI can render `~Xs to ready` and the CLI appends a hint.
    let estimatedReadyAtMs: number | undefined;
    if (s.status === 'compiling' && s.compileStartedAt && s.compileHistory.length >= 3) {
      const recent = s.compileHistory.slice(-10).slice().sort((a, b) => a - b);
      const mid = recent.length >> 1;
      const p50 = recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
      if (p50 > 0) estimatedReadyAtMs = s.compileStartedAt + Math.round(p50);
    }
    let errorCount = 0, warningCount = 0, lintCount = 0;
    for (const x of s.errors.values()) {
      const lvl = x.level ?? 'error';
      if (lvl === 'error') errorCount += x.count;
      else if (lvl === 'warning') warningCount += x.count;
      else if (lvl === 'lint') lintCount += x.count;
    }
    return {
      name: s.name,
      status: s.status,
      port: s.port,
      url: resolvedUrl,
      errorCount,
      warningCount,
      lintCount,
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
      workspaceRoot: s.workspaceRoot,
      baseName: s.baseName ?? s.name,
      lastChangeMs,
      estimatedReadyAtMs,
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
    if (full.type === 'status') this.lastStatusEventTs.set(full.app, full.ts);
    if (this.eventBuffer.length > EVENT_BUFFER_MAX) {
      this.eventBuffer.splice(0, this.eventBuffer.length - EVENT_BUFFER_MAX);
    }
    this.history?.recordEvent(full);
    this.emit('event', full);
  }

  // TCP readiness fallback (M68): profiles with healthProbe 'tcp' have no
  // reliable stdout signature — the HealthMonitor flips them to serving when
  // the port accepts a connection. Mirrors the parser's serving transition,
  // including the compile/ready-cycle accounting that feeds M61 estimates.
  markServing(name: string, message?: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    const s = e.state;
    if (s.status !== 'starting' && s.status !== 'compiling') return;
    const prev = s.status;
    const now = Date.now();
    if (s.compileStartedAt != null) {
      const ms = now - s.compileStartedAt;
      s.lastCompileMs = ms;
      s.lastCompileAt = now;
      s.compileStartedAt = null;
      s.compileHistory.push(ms);
      if (s.compileHistory.length > 20) s.compileHistory.splice(0, s.compileHistory.length - 20);
      this.history?.recordCompile(name, ms, now);
    } else {
      s.lastCompileAt = now;
    }
    s.status = 'serving';
    this.recordEvent({ app: name, type: 'status', from: prev, to: 'serving', message });
    this.emit('change');
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
    // Per-profile readiness/url/error-parser context (M67): the registry row
    // for this app's serverProfile, compiled once per profile.
    const profileRow = e.app.serverProfile
      ? allProfiles(this.config.frameworks).find(p => p.id === e.app.serverProfile)
      : undefined;
    const proc = new AppProcess({
      state: e.state,
      app: e.app,
      port,
      parseCtx: compileParseContext(profileRow),
      envOverride: Object.keys(mergedEnvOverride).length ? mergedEnvOverride : undefined,
      commandOverride: so?.command,
      onStateChange: () => this.emit('change'),
      onStatusChange: (from, to, message) => {
        this.recordEvent({ app: name, type: 'status', from, to, message });
        if ((to === 'stopped' || to === 'error') && (from === 'serving' || from === 'compiling')) {
          this.armCascade(name);
        }
      },
      onErrorRecorded: (entry, isNew) => {
        const lvl = entry.level ?? 'error';
        let type: AppEventType;
        if (lvl === 'lint') type = isNew ? 'lint-new' : 'lint-recur';
        else if (lvl === 'warning') type = isNew ? 'warning-new' : 'warning-recur';
        else type = isNew ? 'error-new' : 'error-recur';
        this.recordEvent({ app: name, type, message: entry.message });
        if (lvl === 'error') this.checkErrorFlapRegression(name, entry.message);
      },
      onExit: (code, signal, stopping) => this.emit('childExit', { name, code, signal, stopping }),
      onLogLine: line => { e.logger?.write(line); this.emit('log', { name, ts: Date.now(), line }); },
      onCompile: ms => {
        const compileTs = Date.now();
        this.history?.recordCompile(name, ms, compileTs);
        const state = this.getState(name)!;
        const prevInit = e.lastBundleInitialKB;
        if (state.bundle && state.bundle.initialKB > 0) {
          if (prevInit && prevInit > 0) {
            const pct = ((state.bundle.initialKB - prevInit) / prevInit) * 100;
            state.bundleRegressionPct = Math.round(pct * 10) / 10;
            // Rolling median of the prior builds (the current one isn't recorded
            // until onBundleUpdate fires); fall back to the previous build when
            // history is disabled or empty.
            const priorKBs = this.history?.queryBundles({ app: name, limit: 10 }).map(b => b.initialKB) ?? [];
            const detected = detectBundleRegression(priorKBs.length ? priorKBs : prevInit, state.bundle.initialKB, 1.1);
            if (detected) {
              // Legacy event + structured regression-detected.
              this.recordEvent({ app: name, type: 'bundle-regression', message: `initialKB +${state.bundleRegressionPct}% (${prevInit}->${state.bundle.initialKB})` });
              void suspectCommitForDir(e.app.workspaceRoot).then(suspect => {
                this.recordEvent({
                  app: name,
                  type: 'regression-detected',
                  message: JSON.stringify({ ...detected, suspectCommit: suspect }),
                });
              });
            }
          } else {
            state.bundleRegressionPct = null;
          }
          e.lastBundleInitialKB = state.bundle.initialKB;
        }
        this.checkCompileRegression(name, ms, compileTs);
        this.emit('compile', { name, ms });
      },
      onBundleUpdate: () => {
        const s = this.getState(name);
        if (s?.bundle && (s.bundle.initialKB > 0 || s.bundle.lazyKB > 0)) {
          this.history?.recordBundle(name, s.bundle.initialKB, s.bundle.lazyKB, s.bundle.files.length);
        }
        this.emit('bundleUpdate', { name });
      },
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
        // Fire-and-forget, but swallow rejections so a failed cascade restart
        // can't surface as an unhandledRejection that takes down the daemon.
        void this.restart(d).catch(() => {});
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
    try { assertSafeCommandParts(app.name, task, args); }
    catch (err: any) { return { error: err?.message || 'unsafe task input' }; }
    const result = await runOneShot(app, task, args);
    this.history?.recordTaskRun(name, task, result.exitCode, result.durationMs, result.summary);
    this.recordEvent({ app: name, type: 'task-run', message: `${task} exit=${result.exitCode} duration=${result.durationMs}ms` });
    this.emit('taskRun', { name, task, result });
    return result;
  }

  startWatchTask(name: string, task: string, args: string[] = []): { ok: boolean; pid?: number | null; error?: string } {
    const app = this.getApp(name);
    if (!app) return { ok: false, error: 'unknown app' };
    try { assertSafeCommandParts(app.name, task, args); }
    catch (err: any) { return { ok: false, error: err?.message || 'unsafe task input' }; }
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

  private checkCompileRegression(name: string, ms: number, compileTs: number): void {
    const h = this.history;
    if (!h) return;
    const rows = h.queryCompiles({ app: name, limit: 21 });
    // The just-recorded compile may already be flushed to the DB — exclude
    // exactly that row (by ts+ms), never priors that merely share the duration.
    const prior = rows.filter(r => !(r.ts === compileTs && r.ms === ms)).slice(0, 20).map(r => r.ms);
    const factor = this.config.overrides?.[name]?.compileRegressionFactor ?? 2.0;
    const detected = detectCompileRegression(prior, ms, factor);
    if (!detected) return;
    // Legacy event (back-compat for v0.9 consumers) plus the new structured one.
    this.recordEvent({ app: name, type: 'compile-regression', message: `${(ms / 1000).toFixed(1)}s vs baseline ${(detected.baseline / 1000).toFixed(1)}s (×${detected.factor})` });
    const app = this.getApp(name);
    void suspectCommitForDir(app?.workspaceRoot ?? null).then(suspect => {
      this.recordEvent({
        app: name,
        type: 'regression-detected',
        message: JSON.stringify({ ...detected, suspectCommit: suspect }),
      });
    });
  }

  // In-memory per-fingerprint sliding window (24h) backing the error-flap
  // detector. Keyed `${app}::${message}`; alerts throttled to one per hour
  // per fingerprint so a sustained flap doesn't flood the events feed.
  private readonly errorFlapWindows = new Map<string, number[]>();
  private readonly errorFlapAlerted = new Map<string, number>();

  private checkErrorFlapRegression(name: string, message: string): void {
    const now = Date.now();
    const key = `${name}::${message}`;
    const window = this.errorFlapWindows.get(key) ?? [];
    window.push(now);
    const dayAgo = now - 24 * 3600_000;
    while (window.length && window[0] < dayAgo) window.shift();
    this.errorFlapWindows.set(key, window);
    const hourAgo = now - 3600_000;
    if (this.errorFlapWindows.size > 2000) {
      for (const [k, w] of this.errorFlapWindows) {
        if (!w.length || w[w.length - 1] < dayAgo) {
          this.errorFlapWindows.delete(k);
          // Drop the paired throttle entry too — otherwise errorFlapAlerted
          // (which was never pruned) grows one permanent record per unique
          // `${app}::${message}` and leaks the heap on a long-running daemon.
          this.errorFlapAlerted.delete(k);
        }
      }
      // A throttle entry older than the 1h window no longer suppresses anything,
      // so it's safe to evict even if its window is still live.
      for (const [k, ts] of this.errorFlapAlerted) {
        if (ts < hourAgo) this.errorFlapAlerted.delete(k);
      }
    }
    const hourEvents = window.filter(ts => ts >= hourAgo).length;
    const dayEvents = window.length - hourEvents;
    const fingerprint = message.slice(0, 120);
    const detected = detectErrorFlapRegression(hourEvents, dayEvents, fingerprint, 3.0);
    if (!detected) return;
    const lastAlert = this.errorFlapAlerted.get(key) ?? 0;
    if (now - lastAlert < 3600_000) return;
    this.errorFlapAlerted.set(key, now);
    const app = this.getApp(name);
    void suspectCommitForDir(app?.workspaceRoot ?? null).then(suspect => {
      this.recordEvent({
        app: name,
        type: 'regression-detected',
        message: JSON.stringify({ ...detected, suspectCommit: suspect }),
      });
    });
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
