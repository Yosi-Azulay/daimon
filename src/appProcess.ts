import { spawn, ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import stripAnsi from 'strip-ansi';
import type { AppState, AppStatus, DiscoveredApp, ErrorEntry } from './types.js';
import type { LogLevel } from './frameworks.js';
import { parseLine, type ProfileParseContext } from './parser.js';
import { isSafeAppName } from './shellSafe.js';

const LOG_BUFFER_MAX = 500;

export interface AppProcessDeps {
  state: AppState;
  app: DiscoveredApp;
  // null = no port claimed (pool mode, profile doesn't declare injection).
  port: number | null;
  // Port injection (M81). undefined = legacy behavior (append `--port <port>`
  // and set PORT). When present, EXACTLY what it says is injected — an empty
  // object means "inject nothing" (explicit non-participation).
  portInject?: { argSuffix?: string; env?: Record<string, string> };
  envOverride?: Record<string, string>;
  commandOverride?: string;
  onStateChange: () => void;
  onStatusChange?: (from: AppStatus, to: AppStatus, message?: string) => void;
  onErrorRecorded?: (entry: ErrorEntry, isNew: boolean) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null, stopping: boolean) => void;
  onLogLine?: (line: string, level: LogLevel | null) => void;
  // Log-level classifier (M99), compiled per profile by the registry.
  // FAIL-SOFT: any throw is treated as level null — classification may never
  // drop or delay a line.
  classifyLine?: (line: string) => LogLevel | null;
  onCompile?: (ms: number) => void;
  onBundleUpdate?: () => void;
  // Per-profile readiness/url/error-parser context (M67).
  parseCtx?: ProfileParseContext;
}

export class AppProcess {
  private child: ChildProcess | null = null;
  private stdoutBuf = '';
  private stderrBuf = '';
  private readonly deps: AppProcessDeps;
  private stopping = false;

  constructor(deps: AppProcessDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.stopping;
  }

  start(): void {
    if (this.isRunning()) return;
    const { app, port, state } = this.deps;

    // Defense-in-depth: discovery already rejects shell-unsafe names, but the
    // discovered name is interpolated into the command run with `shell: true`,
    // so refuse to spawn if anything constructed an app object with an unsafe
    // name (a custom `commandOverride` from the user's own trusted config is
    // exempt — the untrusted vector is the discovered name).
    if (!this.deps.commandOverride && !isSafeAppName(app.name)) {
      state.status = 'error';
      state.lastStatusMessage = `refusing to start: unsafe app name ${JSON.stringify(app.name)}`;
      this.deps.onStateChange();
      return;
    }

    const now = Date.now();
    state.status = 'starting';
    state.startedAt = now;
    state.compileStartedAt = now;
    state.lastCompileMs = null;
    state.lastCompileAt = null;
    state.errors.clear();
    state.logBuffer.length = 0;
    state.lastStatusMessage = undefined;

    const baseCmd = this.deps.commandOverride || app.command;
    const inject = this.deps.portInject;
    const fullCmd = inject ? `${baseCmd}${inject.argSuffix ?? ''}` : `${baseCmd} --port ${port}`;
    const portEnv = inject ? (inject.env ?? {}) : { PORT: String(port) };
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(app.env || {}), ...(this.deps.envOverride || {}), ...portEnv, FORCE_COLOR: '0' };
    const child = spawn(fullCmd, [], {
      cwd: app.workspaceRoot,
      shell: true,
      env: mergedEnv,
      windowsHide: true,
    });

    this.child = child;
    state.pid = child.pid ?? null;
    state.port = port;

    child.stdout?.on('data', (chunk: Buffer) => this.handleChunk(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => this.handleChunk(chunk, 'stderr'));

    child.on('exit', (code, signal) => {
      const prevStatus = state.status;
      const wasStopping = this.stopping;
      if (wasStopping) {
        state.status = 'stopped';
        state.lastStatusMessage = `stopped (code=${code ?? 'null'}${signal ? `, ${signal}` : ''})`;
      } else if (code !== 0) {
        state.status = 'error';
        state.lastStatusMessage = `process exited with code ${code}${signal ? ` (${signal})` : ''}`;
      } else {
        state.status = 'stopped';
      }
      state.pid = null;
      state.health = 'unknown';
      this.child = null;
      this.stopping = false;
      if (prevStatus !== state.status) {
        this.deps.onStatusChange?.(prevStatus, state.status, state.lastStatusMessage);
      }
      this.deps.onExit?.(code, signal, wasStopping);
      this.deps.onStateChange();
    });

    child.on('error', err => {
      state.status = 'error';
      state.lastStatusMessage = `spawn error: ${err.message}`;
      this.deps.onStateChange();
    });

    this.deps.onStateChange();
  }

  private handleChunk(chunk: Buffer, _stream: 'stdout' | 'stderr'): void {
    const text = chunk.toString('utf8');
    const buf = (this[_stream === 'stdout' ? 'stdoutBuf' : 'stderrBuf'] += text);
    const idx = buf.lastIndexOf('\n');
    if (idx < 0) return;
    const complete = buf.slice(0, idx);
    const remainder = buf.slice(idx + 1);
    if (_stream === 'stdout') this.stdoutBuf = remainder;
    else this.stderrBuf = remainder;

    const { state } = this.deps;
    let changed = false;
    for (const rawLine of complete.split(/\r?\n/)) {
      if (!rawLine.length) continue;
      const clean = stripAnsi(rawLine);
      const ts = Date.now();
      state.lastLogTs = ts;
      if (state.stale) state.stale = false;
      // Level classification (M99) is fail-soft: a classifier throw stores
      // the line with level null — never dropped, never delayed.
      let level: LogLevel | null = null;
      try { level = this.deps.classifyLine?.(clean) ?? null; } catch { level = null; }
      state.logBuffer.push(level == null ? { ts, line: clean } : { ts, line: clean, level });
      if (state.logBuffer.length > LOG_BUFFER_MAX) {
        state.logBuffer.splice(0, state.logBuffer.length - LOG_BUFFER_MAX);
      }
      this.deps.onLogLine?.(clean, level);
      const prev = state.status;
      const r = parseLine(state, clean, this.deps.parseCtx);
      if (r?.statusChanged) {
        changed = true;
        this.deps.onStatusChange?.(prev, state.status);
      }
      if (r?.error) {
        this.deps.onErrorRecorded?.(r.error.entry, r.error.isNew);
      }
      if (r?.compileMs != null) this.deps.onCompile?.(r.compileMs);
      if (r?.bundleUpdated) this.deps.onBundleUpdate?.();
    }
    if (changed || complete.length > 0) this.deps.onStateChange();
  }

  async stop(): Promise<void> {
    if (!this.child || this.stopping) return;
    this.stopping = true;
    const pid = this.child.pid;
    if (!pid) {
      this.child = null;
      this.stopping = false;
      return;
    }

    await new Promise<void>(resolve => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const onExit = () => done();
      this.child?.once('exit', onExit);

      treeKill(pid, 'SIGTERM', () => {});

      const escalate = setTimeout(() => {
        treeKill(pid, 'SIGKILL', () => {});
      }, 2000);

      const hard = setTimeout(() => {
        clearTimeout(escalate);
        done();
      }, 3000);

      this.child?.once('exit', () => {
        clearTimeout(escalate);
        clearTimeout(hard);
        done();
      });
    });
  }
}
