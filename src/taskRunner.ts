import { spawn, ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import stripAnsi from 'strip-ansi';
import type { DiscoveredApp } from './types.js';

export interface FailedTestRow {
  name: string;
  file?: string;
  line?: number;
}

export interface TaskSummary {
  passed?: number;
  failed?: number;
  total?: number;
  suites?: number;
  durationMs?: number;
  framework?: 'jest' | 'vitest' | 'karma' | 'playwright' | 'pytest' | 'rspec' | 'go' | 'cargo';
  failedTests?: FailedTestRow[];
}

const JEST_TESTS_RX = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(\d+)\s+passed(?:,\s+(\d+)\s+total)?/;
const JEST_SUITES_RX = /Test Suites:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed(?:,\s+(\d+)\s+total)?/;
const KARMA_RX = /Executed (\d+) of (\d+)(?:\s*\((\d+)\s*FAILED\))?/;
const PLAYWRIGHT_RX = /(\d+)\s+passed(?:.*?(\d+)\s+failed)?/i;
// vitest summary: "Test Files  1 failed | 6 passed (7)"  and  "Tests  3 failed | 240 passed (243)"
const VITEST_TESTS_RX = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\((\d+)\))?/;
const VITEST_FILES_RX = /Test Files\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\((\d+)\))?/;
// pytest: "1 failed, 2 passed in 0.05s" or "5 passed in 0.10s"
const PYTEST_RX = /(?:(\d+)\s+failed,\s+)?(\d+)\s+passed(?:,\s+\d+\s+skipped)?\s+in\s+([\d.]+)s/;
// RSpec: "10 examples, 1 failure" / "10 examples, 0 failures"
const RSPEC_RX = /(\d+)\s+examples?,\s+(\d+)\s+failures?/;
// go test: "ok      pkg  0.123s" or "FAIL    pkg  0.123s"
const GO_TEST_LINE_RX = /^(ok|FAIL|---\s+FAIL)\s+\S+\s+([\d.]+)s/;
// cargo test: "test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"
const CARGO_RX = /test result:\s*(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/;

const JEST_FAIL_LINE_RX = /^\s*✕\s+(.+?)(?:\s+\((\d+)\s*ms\))?$/;
const JEST_FAIL_FILE_RX = /^\s*FAIL\s+(\S+\.(?:tsx?|jsx?|mjs|cjs|spec\.[a-z]+))/;
const PYTEST_FAIL_RX = /^FAILED\s+(\S+)::([^\s]+)/;

function extractFailedTests(output: string): FailedTestRow[] {
  const out: FailedTestRow[] = [];
  let lastFile: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const ff = line.match(JEST_FAIL_FILE_RX);
    if (ff) { lastFile = ff[1]; continue; }
    const j = line.match(JEST_FAIL_LINE_RX);
    if (j) { out.push({ name: j[1].trim(), file: lastFile }); continue; }
    const p = line.match(PYTEST_FAIL_RX);
    if (p) { out.push({ name: p[2], file: p[1] }); continue; }
  }
  return out.slice(0, 50);
}

export function parseTaskSummary(output: string): TaskSummary | null {
  // Jest
  const jt = output.match(JEST_TESTS_RX);
  if (jt) {
    const failed = jt[1] ? Number(jt[1]) : 0;
    const passed = Number(jt[3]);
    const total = jt[4] ? Number(jt[4]) : passed + failed;
    const suites = output.match(JEST_SUITES_RX);
    return {
      passed, failed, total,
      suites: suites ? Number(suites[3] ?? suites[2]) : undefined,
      framework: 'jest',
      failedTests: failed > 0 ? extractFailedTests(output) : undefined,
    };
  }
  // Vitest
  const vt = output.match(VITEST_TESTS_RX);
  if (vt) {
    const failed = vt[1] ? Number(vt[1]) : 0;
    const passed = Number(vt[2]);
    const total = vt[3] ? Number(vt[3]) : passed + failed;
    const files = output.match(VITEST_FILES_RX);
    return {
      passed, failed, total,
      suites: files ? Number(files[3] ?? files[2]) : undefined,
      framework: 'vitest',
      failedTests: failed > 0 ? extractFailedTests(output) : undefined,
    };
  }
  // Karma
  const k = output.match(KARMA_RX);
  if (k) {
    const exec = Number(k[1]);
    const total = Number(k[2]);
    const failed = k[3] ? Number(k[3]) : 0;
    return { passed: exec - failed, failed, total, framework: 'karma' };
  }
  // Playwright
  const pw = output.match(PLAYWRIGHT_RX);
  if (pw && /playwright/i.test(output)) {
    const passed = Number(pw[1]);
    const failed = pw[2] ? Number(pw[2]) : 0;
    return { passed, failed, total: passed + failed, framework: 'playwright' };
  }
  // pytest
  const py = output.match(PYTEST_RX);
  if (py) {
    const failed = py[1] ? Number(py[1]) : 0;
    const passed = Number(py[2]);
    return {
      passed, failed, total: passed + failed,
      durationMs: Math.round(Number(py[3]) * 1000),
      framework: 'pytest',
      failedTests: failed > 0 ? extractFailedTests(output) : undefined,
    };
  }
  // RSpec
  const rs = output.match(RSPEC_RX);
  if (rs) {
    const total = Number(rs[1]);
    const failed = Number(rs[2]);
    return { passed: total - failed, failed, total, framework: 'rspec' };
  }
  // cargo test
  const ct = output.match(CARGO_RX);
  if (ct) {
    const passed = Number(ct[1]);
    const failed = Number(ct[2]);
    return { passed, failed, total: passed + failed, framework: 'cargo' };
  }
  // go test (summed across multiple package lines)
  let goPassed = 0, goFailed = 0, goDur = 0, sawGo = false;
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(GO_TEST_LINE_RX);
    if (m) {
      sawGo = true;
      goDur += Math.round(Number(m[2]) * 1000);
      if (m[1] === 'ok') goPassed++;
      else goFailed++;
    }
  }
  if (sawGo) {
    return { passed: goPassed, failed: goFailed, total: goPassed + goFailed, durationMs: goDur, framework: 'go' };
  }
  // Fallback playwright detection without an explicit "playwright" tag
  if (pw) {
    const passed = Number(pw[1]);
    const failed = pw[2] ? Number(pw[2]) : 0;
    return { passed, failed, total: passed + failed, framework: 'playwright' };
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
      resolve({ app: app.name, task, exitCode: -1, durationMs: Date.now() - start, summary: null, outputTail: [...lines, `[daimon] task spawn error`] });
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
