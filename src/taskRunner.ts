import { spawn, ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import stripAnsi from 'strip-ansi';
import type { DiscoveredApp } from './types.js';

export interface TaskSummary {
  passed?: number;
  failed?: number;
  total?: number;
}

const JEST_RX = /Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed(?:,\s+(\d+)\s+total)?/;
const KARMA_RX = /Executed (\d+) of (\d+)(?:\s*\((\d+)\s*FAILED\))?/;
const PLAYWRIGHT_RX = /(\d+)\s+passed(?:.*?(\d+)\s+failed)?/i;

export function parseTaskSummary(output: string): TaskSummary | null {
  const j = output.match(JEST_RX);
  if (j) {
    const failed = j[1] ? Number(j[1]) : 0;
    const passed = Number(j[2]);
    const total = j[3] ? Number(j[3]) : passed + failed;
    return { passed, failed, total };
  }
  const k = output.match(KARMA_RX);
  if (k) {
    const exec = Number(k[1]);
    const total = Number(k[2]);
    const failed = k[3] ? Number(k[3]) : 0;
    return { passed: exec - failed, failed, total };
  }
  const p = output.match(PLAYWRIGHT_RX);
  if (p) {
    const passed = Number(p[1]);
    const failed = p[2] ? Number(p[2]) : 0;
    return { passed, failed, total: passed + failed };
  }
  return null;
}

function commandFor(app: DiscoveredApp, task: string, args: string[]): string {
  const argTail = args.length ? ' -- ' + args.join(' ') : '';
  if (app.workspaceType === 'nx') return `npx nx run ${app.name}:${task}${argTail}`;
  if (app.workspaceType === 'angular') return `npx ng run ${app.name}:${task}${argTail}`;
  return `npx ${task}${argTail}`;
}

export interface OneShotResult {
  app: string;
  task: string;
  exitCode: number | null;
  durationMs: number;
  summary: TaskSummary | null;
  outputTail: string[];
}

export function runOneShot(app: DiscoveredApp, task: string, args: string[] = []): Promise<OneShotResult> {
  return new Promise(resolve => {
    const start = Date.now();
    const cmd = commandFor(app, task, args);
    const child = spawn(cmd, [], {
      cwd: app.workspaceRoot,
      shell: true,
      env: { ...process.env, ...(app.env || {}), FORCE_COLOR: '0' },
      windowsHide: true,
    });
    const lines: string[] = [];
    let acc = '';
    const onData = (chunk: Buffer) => {
      acc += chunk.toString('utf8');
      const idx = acc.lastIndexOf('\n');
      if (idx < 0) return;
      const complete = acc.slice(0, idx);
      acc = acc.slice(idx + 1);
      for (const raw of complete.split(/\r?\n/)) {
        if (!raw.length) continue;
        const clean = stripAnsi(raw);
        lines.push(clean);
        if (lines.length > 1000) lines.splice(0, lines.length - 1000);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      const dur = Date.now() - start;
      const all = lines.join('\n') + (acc ? '\n' + acc : '');
      const summary = parseTaskSummary(all);
      resolve({
        app: app.name,
        task,
        exitCode: code,
        durationMs: dur,
        summary,
        outputTail: lines.slice(-50),
      });
    });
    child.on('error', () => {
      resolve({ app: app.name, task, exitCode: -1, durationMs: Date.now() - start, summary: null, outputTail: [...lines, `[bosun] task spawn error`] });
    });
  });
}

export interface WatchTask {
  app: string;
  task: string;
  pid: number | null;
  child: ChildProcess;
  startedAt: number;
  logs: string[];
  stop(): Promise<void>;
}

export function startWatch(app: DiscoveredApp, task: string, args: string[] = []): WatchTask {
  const cmd = commandFor(app, task, args);
  const child = spawn(cmd, [], {
    cwd: app.workspaceRoot,
    shell: true,
    env: { ...process.env, ...(app.env || {}), FORCE_COLOR: '0' },
    windowsHide: true,
  });
  const logs: string[] = [];
  let acc = '';
  const onData = (chunk: Buffer) => {
    acc += chunk.toString('utf8');
    const idx = acc.lastIndexOf('\n');
    if (idx < 0) return;
    const complete = acc.slice(0, idx);
    acc = acc.slice(idx + 1);
    for (const raw of complete.split(/\r?\n/)) {
      if (!raw.length) continue;
      logs.push(stripAnsi(raw));
      if (logs.length > 500) logs.splice(0, logs.length - 500);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const wt: WatchTask = {
    app: app.name,
    task,
    pid: child.pid ?? null,
    child,
    startedAt: Date.now(),
    logs,
    stop: () => new Promise<void>(resolve => {
      if (!child.pid) { resolve(); return; }
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', fin);
      treeKill(child.pid, 'SIGTERM', () => {});
      setTimeout(() => { if (child.pid) treeKill(child.pid, 'SIGKILL', () => {}); }, 2000);
      setTimeout(fin, 3500);
    }),
  };
  return wt;
}
