import { spawn, ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import stripAnsi from 'strip-ansi';
import type { AppState, AppStatus, DiscoveredApp, ErrorEntry } from './types.js';
import { parseLine } from './parser.js';

const LOG_BUFFER_MAX = 500;

export interface AppProcessDeps {
  state: AppState;
  app: DiscoveredApp;
  port: number;
  onStateChange: () => void;
  onStatusChange?: (from: AppStatus, to: AppStatus, message?: string) => void;
  onErrorRecorded?: (entry: ErrorEntry, isNew: boolean) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null, stopping: boolean) => void;
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

    const now = Date.now();
    state.status = 'starting';
    state.startedAt = now;
    state.compileStartedAt = now;
    state.lastCompileMs = null;
    state.lastCompileAt = null;
    state.errors.clear();
    state.logBuffer.length = 0;
    state.lastStatusMessage = undefined;

    const fullCmd = `${app.command} --port ${port}`;
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(app.env || {}), PORT: String(port), FORCE_COLOR: '0' };
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
      state.logBuffer.push({ ts: Date.now(), line: clean });
      if (state.logBuffer.length > LOG_BUFFER_MAX) {
        state.logBuffer.splice(0, state.logBuffer.length - LOG_BUFFER_MAX);
      }
      const prev = state.status;
      const r = parseLine(state, clean);
      if (r?.statusChanged) {
        changed = true;
        this.deps.onStatusChange?.(prev, state.status);
      }
      if (r?.error) {
        this.deps.onErrorRecorded?.(r.error.entry, r.error.isNew);
      }
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
