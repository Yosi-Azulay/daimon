// Test-runner registry (M74). Mirrors the error-parser convention: every
// runner daimon can parse is a declarative row here, gated by a fixture in
// test/fixtures/testrunners/<id>/ — a runner without a fixture doesn't ship.
//
// daimon WRAPS the project's own runner: it never installs, replaces, or
// watch-orchestrates one. Parsers are fail-soft — unparsed output still lands
// in the run's raw log and totals fall back to the exit code alone.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import treeKill from 'tree-kill';
import stripAnsi from 'strip-ansi';
import type { AppmanConfig, DiscoveredApp } from './types.js';
import { allProfiles, detectPackageManager, pmExec, pmRun, RootFs } from './frameworks.js';

export type TestRunnerId = 'vitest-jest' | 'pytest' | 'go-test' | 'cargo-test' | 'dotnet-test';

export const KNOWN_TEST_RUNNER_IDS: readonly TestRunnerId[] = [
  'vitest-jest', 'pytest', 'go-test', 'cargo-test', 'dotnet-test',
];

export interface TestFailure {
  suite: string;
  test: string;
  file?: string;
  line?: number;
  message: string;
}

export interface TestTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
}

// Coverage summary (M128, v1.7). Summary numbers ONLY — no per-file storage.
// A runner fills whichever percentage its documented output carries; the other
// stays null. Parsed, never produced: daimon reads the coverage the run already
// printed, never injects a coverage flag. Fail-soft: absent/unparseable/
// out-of-range → null, always. Fabricated totals are never acceptable.
export interface CoverageSummary {
  linesPct: number | null;
  statementsPct: number | null;
}

export interface ParsedTestRun {
  totals: TestTotals | null;
  failures: TestFailure[];
  runner: TestRunnerId | null;
  coverage: CoverageSummary | null;
}

// Same shape as the error-fingerprint scheme (errorGroups.ts): source location
// when we have one, else a normalized-message hash — so grouping and flaky
// detection fold reruns of the same failing test together.
export function testFailureFingerprint(f: Pick<TestFailure, 'suite' | 'test' | 'file' | 'line'>): string {
  if (f.file && f.line != null) return `${f.file}:${f.line}`;
  const norm = `${f.suite}::${f.test}`.replace(/\d+/g, '#').trim().toLowerCase();
  return 'test:' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Runner resolution.
// ---------------------------------------------------------------------------

export interface ResolvedRunner {
  command: string;
  runner: TestRunnerId | null;
  source: 'override' | 'profile' | 'package-script';
}

export interface RunnerResolutionError {
  error: string;
  hint: string;
}

export function guessRunnerFromCommand(cmd: string): TestRunnerId | null {
  const c = cmd.toLowerCase();
  if (/\bvitest\b|\bjest\b|\bnx\s+(run\s+\S+:)?test\b|\bng\s+test\b/.test(c)) return 'vitest-jest';
  if (/\bpytest\b/.test(c)) return 'pytest';
  if (/\bgo\s+test\b/.test(c)) return 'go-test';
  if (/\bcargo\s+(test|nextest)\b/.test(c)) return 'cargo-test';
  if (/\bdotnet\s+test\b/.test(c)) return 'dotnet-test';
  return null;
}

// npm's stub `test` script fails by design — never treat it as a runner.
const NPM_STUB_TEST = /no test specified/i;

// Resolve the test command + parser for an app. Precedence:
//   1. overrides.<app>.testCommand (config always wins),
//   2. the app's registry profile testRunner hint,
//   3. a real package.json `test` script (JS fallback).
// `platform` is injectable for tests.
export function resolveTestCommand(
  app: DiscoveredApp,
  cfg: Pick<AppmanConfig, 'overrides' | 'frameworks'>,
  platform: NodeJS.Platform = process.platform,
): ResolvedRunner | RunnerResolutionError {
  void platform;
  const key = app.baseName ?? app.name;
  const override = cfg.overrides?.[app.name]?.testCommand ?? cfg.overrides?.[key]?.testCommand;
  if (override && override.trim()) {
    return { command: override.trim(), runner: guessRunnerFromCommand(override), source: 'override' };
  }

  const profile = app.serverProfile
    ? allProfiles(cfg.frameworks).find(p => p.id === app.serverProfile)
    : undefined;
  const hint = profile?.testRunner;

  if (hint === 'pytest') return { command: 'python -m pytest', runner: 'pytest', source: 'profile' };
  if (hint === 'go-test') return { command: 'go test ./...', runner: 'go-test', source: 'profile' };
  if (hint === 'cargo-test') return { command: 'cargo test', runner: 'cargo-test', source: 'profile' };
  if (hint === 'dotnet-test') return { command: 'dotnet test', runner: 'dotnet-test', source: 'profile' };

  if (hint === 'vitest-jest') {
    // Workspace enumerators delegate to their own runner wrapper.
    if (app.workspaceType === 'nx' && profile?.id === 'nx') {
      return { command: `npx nx test ${key}`, runner: 'vitest-jest', source: 'profile' };
    }
    if (app.workspaceType === 'angular' && profile?.id === 'angular') {
      return { command: `npx ng test ${key} --watch=false`, runner: 'vitest-jest', source: 'profile' };
    }
    const dirFs = new RootFs(app.workspaceRoot);
    const pkg = dirFs.packageJson();
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const pm = detectPackageManager([dirFs]);
    if (Object.prototype.hasOwnProperty.call(deps, 'vitest')) {
      return { command: pmExec(pm, 'vitest run'), runner: 'vitest-jest', source: 'profile' };
    }
    if (Object.prototype.hasOwnProperty.call(deps, 'jest')) {
      return { command: pmExec(pm, 'jest --ci'), runner: 'vitest-jest', source: 'profile' };
    }
    const script = pkg?.scripts?.test;
    if (typeof script === 'string' && script.trim() && !NPM_STUB_TEST.test(script)) {
      return { command: pmRun(pm, 'test'), runner: guessRunnerFromCommand(script), source: 'package-script' };
    }
  }

  return {
    error: `no test runner resolved for '${key}'`,
    hint: `set overrides.${JSON.stringify(key)}.testCommand in daimon.config.json (daimon wraps your runner — it never installs one)`,
  };
}

// ---------------------------------------------------------------------------
// Parsers. Each extracts { suite, test, file?, line?, message } per failure
// plus totals. All fail-soft: no match → totals null, failures [].
// ---------------------------------------------------------------------------

const MAX_FAILURES = 200;
const MAX_MSG = 400;

function clampMsg(s: string): string {
  const t = s.trim();
  return t.length > MAX_MSG ? t.slice(0, MAX_MSG) + '…' : t;
}

function parseVitestJest(lines: string[]): ParsedTestRun {
  const failures: TestFailure[] = [];
  let totals: TestTotals | null = null;
  let durationMs: number | null = null;

  // jest: "Tests:       1 failed, 2 skipped, 3 passed, 6 total"
  const JEST_TOTALS = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/;
  // vitest: "Tests  3 failed | 240 passed | 1 skipped (244)"
  const VITEST_TOTALS = /Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed\s*\|?\s*)?(?:(\d+)\s+skipped\s*)?\((\d+)\)/;
  const JEST_TIME = /Time:\s+([\d.]+)\s*s/;
  const VITEST_TIME = /Duration\s+([\d.]+)\s*s/;

  // vitest one-liner: " FAIL  src/x.test.ts > suite > nested > test name"
  const VITEST_FAIL = /^\s*FAIL\s+(\S+)\s+>\s+(.+)$/;
  // jest per-file: "FAIL src/x.test.ts", then "  ● suite › test"
  const JEST_FILE = /^\s*FAIL\s+(\S+)\s*(?:\(.*\))?$/;
  const JEST_BULLET = /^\s*●\s+(.+)$/;
  const STACK_LOC = /[(\s]((?:[A-Za-z]:)?[^\s():]+?):(\d+)(?::\d+)?\)?\s*$/;

  let jestFile: string | undefined;
  let pending: TestFailure | null = null;
  let pendingNeedsMsg = false;

  for (const raw of lines) {
    const line = raw;
    const vf = line.match(VITEST_FAIL);
    if (vf) {
      const chain = vf[2].split(' > ').map(s => s.trim()).filter(Boolean);
      const test = chain.pop() ?? '';
      pending = { suite: chain.join(' > '), test, file: vf[1], message: '' };
      pendingNeedsMsg = true;
      if (failures.length < MAX_FAILURES) failures.push(pending);
      continue;
    }
    const jf = line.match(JEST_FILE);
    if (jf && !jf[1].includes('>')) { jestFile = jf[1]; continue; }
    const jb = line.match(JEST_BULLET);
    if (jb && !/Test suite failed to run/i.test(jb[1])) {
      const chain = jb[1].split(' › ').map(s => s.trim()).filter(Boolean);
      const test = chain.pop() ?? '';
      pending = { suite: chain.join(' › '), test, file: jestFile, message: '' };
      pendingNeedsMsg = true;
      if (failures.length < MAX_FAILURES) failures.push(pending);
      continue;
    }
    if (pending && pendingNeedsMsg) {
      const t = line.trim();
      if (t && !t.startsWith('❯') && !t.startsWith('at ')) {
        pending.message = clampMsg(t);
        pendingNeedsMsg = false;
        continue;
      }
    }
    if (pending && pending.line == null) {
      const t = line.trim();
      if (t.startsWith('❯') || t.startsWith('at ')) {
        const m = line.match(STACK_LOC);
        // Only take a frame that points into the failure's own file (or adopt
        // the first frame when the file is unknown) — node_modules frames in a
        // deep stack must not win.
        if (m) {
          const sameFile = pending.file != null && (m[1].endsWith(pending.file) || pending.file.endsWith(m[1]));
          if (!pending.file) { pending.file = m[1]; pending.line = Number(m[2]); }
          else if (sameFile) pending.line = Number(m[2]);
        }
      }
    }
    const jt = line.match(JEST_TOTALS);
    if (jt) {
      const failed = jt[1] ? Number(jt[1]) : 0;
      const skipped = jt[2] ? Number(jt[2]) : 0;
      const passed = jt[3] ? Number(jt[3]) : 0;
      totals = { total: Number(jt[4]), passed, failed, skipped, durationMs };
      continue;
    }
    const vt = line.match(VITEST_TOTALS);
    if (vt) {
      const failed = vt[1] ? Number(vt[1]) : 0;
      const passed = vt[2] ? Number(vt[2]) : 0;
      const skipped = vt[3] ? Number(vt[3]) : 0;
      totals = { total: Number(vt[4]), passed, failed, skipped, durationMs };
      continue;
    }
    const tm = line.match(JEST_TIME) ?? line.match(VITEST_TIME);
    if (tm) {
      durationMs = Math.round(Number(tm[1]) * 1000);
      if (totals) totals.durationMs = durationMs;
    }
  }
  return { totals, failures, runner: 'vitest-jest', coverage: null };
}

function parsePytest(lines: string[]): ParsedTestRun {
  const failures: TestFailure[] = [];
  let totals: TestTotals | null = null;
  // "FAILED tests/test_math.py::TestMath::test_add - AssertionError: assert 3 == 4"
  const FAILED = /^FAILED\s+(\S+?)::(\S+?)(?:\s+-\s+(.*))?$/;
  // summary: "==== 1 failed, 2 passed, 1 skipped in 0.12s ===="
  const SUMMARY = /(?:=+\s*)?(?=.*\b(?:passed|failed|skipped|error)\b)(.*?)\bin\s+([\d.]+)s\s*(?:=+\s*)?$/;
  // traceback location "tests/test_math.py:12: AssertionError"
  const TB_LOC = /^(\S+?\.py):(\d+):\s/;

  const locByFile = new Map<string, number>();
  for (const line of lines) {
    const tb = line.match(TB_LOC);
    if (tb && !locByFile.has(tb[1])) locByFile.set(tb[1], Number(tb[2]));
  }
  for (const line of lines) {
    const m = line.match(FAILED);
    if (m) {
      const file = m[1];
      const parts = m[2].split('::');
      const test = parts.pop() ?? '';
      failures.push({
        suite: parts.join('::'),
        test,
        file,
        line: locByFile.get(file),
        message: clampMsg(m[3] ?? ''),
      });
      if (failures.length >= MAX_FAILURES) break;
    }
  }
  for (const line of lines) {
    if (!/\b(passed|failed|skipped|error)\b/.test(line)) continue;
    const s = line.match(SUMMARY);
    if (!s) continue;
    const counts = s[1];
    const num = (word: string) => {
      const m2 = counts.match(new RegExp(`(\\d+)\\s+${word}`));
      return m2 ? Number(m2[1]) : 0;
    };
    const failed = num('failed') + num('error');
    const passed = num('passed');
    const skipped = num('skipped');
    if (failed + passed + skipped === 0) continue;
    totals = { total: failed + passed + skipped, passed, failed, skipped, durationMs: Math.round(Number(s[2]) * 1000) };
  }
  return { totals, failures, runner: 'pytest', coverage: null };
}

function parseGoTest(lines: string[]): ParsedTestRun {
  const failures: TestFailure[] = [];
  let passed = 0, failed = 0, skipped = 0, durationMs = 0, sawAny = false, sawPkgLine = false;
  const RUN = /^=== RUN\s+(\S+)/;
  const FAIL = /^\s*--- FAIL: (\S+)/;
  const PASS = /^\s*--- PASS: /;
  const SKIP = /^\s*--- SKIP: /;
  const LOC = /^\s+((?:[\w./\\-]+)_test\.go):(\d+):\s*(.*)$/;
  const PKG = /^(ok|FAIL)\s+(\S+)\s+(?:([\d.]+)s|\(cached\))/;

  // In `-v` output the t.Errorf log line precedes the `--- FAIL:` marker (it
  // prints during === RUN); in non-verbose failure output it follows it. Track
  // both: locations keyed by the currently-running test, plus a pending
  // failure for the trailing-format.
  const locByTest = new Map<string, { file: string; line: number; message: string }>();
  let currentTest: string | null = null;
  const pkgs: string[] = [];
  let pending: TestFailure | null = null;
  for (const line of lines) {
    const r = line.match(RUN);
    if (r) { currentTest = r[1]; pending = null; continue; }
    const f = line.match(FAIL);
    if (f) {
      sawAny = true;
      failed++;
      pending = { suite: '', test: f[1], message: '' };
      const loc = locByTest.get(f[1]);
      if (loc) { pending.file = loc.file; pending.line = loc.line; pending.message = clampMsg(loc.message); }
      if (failures.length < MAX_FAILURES) failures.push(pending);
      continue;
    }
    if (PASS.test(line)) { sawAny = true; passed++; pending = null; continue; }
    if (SKIP.test(line)) { sawAny = true; skipped++; pending = null; continue; }
    const l = line.match(LOC);
    if (l) {
      if (pending && pending.file == null) {
        pending.file = l[1];
        pending.line = Number(l[2]);
        pending.message = clampMsg(l[3]);
      } else if (currentTest && !locByTest.has(currentTest)) {
        locByTest.set(currentTest, { file: l[1], line: Number(l[2]), message: l[3] });
      }
      continue;
    }
    const p = line.match(PKG);
    if (p) {
      sawPkgLine = true;
      if (p[1] === 'FAIL') pkgs.push(p[2]);
      if (p[3]) durationMs += Math.round(Number(p[3]) * 1000);
    }
  }
  if (pkgs.length === 1) for (const f of failures) f.suite = pkgs[0];
  const totals: TestTotals | null = sawAny
    ? { total: passed + failed + skipped, passed, failed, skipped, durationMs: sawPkgLine ? durationMs : null }
    : null;
  return { totals, failures, runner: 'go-test', coverage: null };
}

function parseCargoTest(lines: string[]): ParsedTestRun {
  const failures: TestFailure[] = [];
  let totals: TestTotals | null = null;
  const FAILED_LINE = /^test (\S+) \.\.\. FAILED/;
  const BLOCK = /^---- (\S+) stdout ----/;
  // old: "..., src/lib.rs:12:9" — new (1.73+): "panicked at src/lib.rs:12:9:"
  const LOC = /((?:[A-Za-z]:)?[\w./\\-]+\.rs):(\d+):\d+/;
  const RESULT = /test result: (?:ok|FAILED)\.\s+(\d+) passed; (\d+) failed; (\d+) ignored(?:.*finished in ([\d.]+)s)?/;

  const byName = new Map<string, TestFailure>();
  for (const line of lines) {
    const f = line.match(FAILED_LINE);
    if (f && failures.length < MAX_FAILURES) {
      const parts = f[1].split('::');
      const test = parts.pop() ?? '';
      const fail: TestFailure = { suite: parts.join('::'), test, message: '' };
      failures.push(fail);
      byName.set(f[1], fail);
    }
  }
  let current: TestFailure | null = null;
  for (const line of lines) {
    const b = line.match(BLOCK);
    if (b) { current = byName.get(b[1]) ?? null; continue; }
    if (current) {
      if (/panicked at/.test(line)) {
        // Rust ≥1.73 puts only the location after "panicked at" (message on
        // the next line); older toolchains inline the message + location.
        let msg = line.replace(/^thread '[^']*' panicked at\s*/, '').replace(/:\s*$/, '');
        const pureLoc = /^(?:[A-Za-z]:)?[\w./\\-]+\.rs:\d+:\d+$/.test(msg.trim());
        if (!pureLoc && !current.message) {
          msg = msg.replace(/,?\s*(?:[A-Za-z]:)?[\w./\\-]+\.rs:\d+:\d+$/, '').replace(/^'|'$/g, '');
          current.message = clampMsg(msg);
        }
      } else if (line.trim() && !current.message && !/^note:/.test(line.trim()) && current.file) {
        current.message = clampMsg(line);
      }
      if (current.file == null) {
        const l = line.match(LOC);
        if (l) { current.file = l[1]; current.line = Number(l[2]); }
      }
    }
    const r = line.match(RESULT);
    if (r) {
      const passed = Number(r[1]);
      const failed = Number(r[2]);
      const skipped = Number(r[3]);
      const dur = r[4] ? Math.round(Number(r[4]) * 1000) : null;
      if (totals) {
        // Multiple binaries: sum the sections.
        totals = {
          total: totals.total + passed + failed + skipped,
          passed: totals.passed + passed,
          failed: totals.failed + failed,
          skipped: totals.skipped + skipped,
          durationMs: totals.durationMs != null || dur != null ? (totals.durationMs ?? 0) + (dur ?? 0) : null,
        };
      } else {
        totals = { total: passed + failed + skipped, passed, failed, skipped, durationMs: dur };
      }
    }
  }
  return { totals, failures, runner: 'cargo-test', coverage: null };
}

function parseDotnetTest(lines: string[]): ParsedTestRun {
  const failures: TestFailure[] = [];
  let totals: TestTotals | null = null;
  const FAILED = /^\s+Failed\s+([\w.]+[\w])(?:\s+\[[^\]]+\])?\s*$/;
  const STACK = /\bin\s+((?:[A-Za-z]:)?[^:]+?):line\s+(\d+)/;
  const SUMMARY = /(?:Failed!|Passed!)\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)(?:,\s*Duration:\s*([\d.]+)\s*(ms|s|m))?/;

  let pending: TestFailure | null = null;
  let awaitingMsg = false;
  for (const line of lines) {
    const f = line.match(FAILED);
    if (f) {
      const parts = f[1].split('.');
      const test = parts.pop() ?? '';
      pending = { suite: parts.join('.'), test, message: '' };
      awaitingMsg = false;
      if (failures.length < MAX_FAILURES) failures.push(pending);
      continue;
    }
    if (pending) {
      if (/^\s*Error Message:/.test(line)) { awaitingMsg = true; continue; }
      if (awaitingMsg && line.trim()) {
        pending.message = clampMsg(line);
        awaitingMsg = false;
        continue;
      }
      if (pending.file == null) {
        const s = line.match(STACK);
        if (s) { pending.file = s[1].trim(); pending.line = Number(s[2]); }
      }
    }
    const t = line.match(SUMMARY);
    if (t) {
      const failed = Number(t[1]);
      const passed = Number(t[2]);
      const skipped = Number(t[3]);
      let durationMs: number | null = null;
      if (t[5]) {
        const n = Number(t[5]);
        durationMs = t[6] === 'ms' ? Math.round(n) : t[6] === 's' ? Math.round(n * 1000) : Math.round(n * 60_000);
      }
      if (totals) {
        totals = {
          total: totals.total + Number(t[4]),
          passed: totals.passed + passed,
          failed: totals.failed + failed,
          skipped: totals.skipped + skipped,
          durationMs: totals.durationMs != null || durationMs != null ? (totals.durationMs ?? 0) + (durationMs ?? 0) : null,
        };
      } else {
        totals = { total: Number(t[4]), passed, failed, skipped, durationMs };
      }
    }
  }
  return { totals, failures, runner: 'dotnet-test', coverage: null };
}

const PARSERS: Record<TestRunnerId, (lines: string[]) => ParsedTestRun> = {
  'vitest-jest': parseVitestJest,
  'pytest': parsePytest,
  'go-test': parseGoTest,
  'cargo-test': parseCargoTest,
  'dotnet-test': parseDotnetTest,
};

// ---------------------------------------------------------------------------
// Coverage parsers (M128, v1.7). Opportunistic over output the runner ALREADY
// produced — daimon never injects a coverage flag or edits a test config.
// Each is fail-soft: absent/unparseable/out-of-range → null. Fixture-gated via
// TEST_RUNNER_META.supportsCoverage (test/testrunners.test.mjs).
// ---------------------------------------------------------------------------

// A percentage is only valid in [0,100]; anything else (NaN, negative, >100) is
// treated as unparseable and yields null — a fabricated number is never shipped.
function clampPct(n: number): number | null {
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

// vitest/jest run with `--coverage` print istanbul's summary. Two documented
// reporter shapes: the `text-summary` block ("Statements : 85.71% ( 12/14 )",
// "Lines : …") and the `text` table whose "All files" row carries "% Stmts"
// and "% Lines" columns. Parse either; the header maps table columns so a
// reordering never mislabels a number.
function parseVitestJestCoverage(lines: string[]): CoverageSummary | null {
  let linesPct: number | null = null;
  let statementsPct: number | null = null;
  for (const line of lines) {
    const s = line.match(/^\s*Statements\s*:\s*([\d.]+)%/);
    if (s) statementsPct = clampPct(Number(s[1]));
    const l = line.match(/^\s*Lines\s*:\s*([\d.]+)%/);
    if (l) linesPct = clampPct(Number(l[1]));
  }
  if (linesPct != null || statementsPct != null) return { linesPct, statementsPct };

  let stmtIdx = -1;
  let linesIdx = -1;
  for (const line of lines) {
    if (line.includes('% Stmts') && line.includes('% Lines')) {
      const cells = line.split('|').map(c => c.trim());
      stmtIdx = cells.indexOf('% Stmts');
      linesIdx = cells.indexOf('% Lines');
      break;
    }
  }
  if (stmtIdx < 0 && linesIdx < 0) return null;
  for (const line of lines) {
    if (!/\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells[0] !== 'All files') continue;
    const sp = stmtIdx >= 0 ? clampPct(Number(cells[stmtIdx])) : null;
    const lp = linesIdx >= 0 ? clampPct(Number(cells[linesIdx])) : null;
    if (lp != null || sp != null) return { linesPct: lp, statementsPct: sp };
  }
  return null;
}

// pytest-cov appends a coverage table ending in a TOTAL line:
//   "TOTAL      123     45    63%"  (Name  Stmts  Miss  Cover)
// coverage.py's "Cover" is line coverage; statement % stays null.
function parsePytestCoverage(lines: string[]): CoverageSummary | null {
  for (const line of lines) {
    const m = line.match(/^TOTAL\s+\d+\s+\d+\s+(\d+(?:\.\d+)?)%\s*$/);
    if (m) {
      const p = clampPct(Number(m[1]));
      return p == null ? null : { linesPct: p, statementsPct: null };
    }
  }
  return null;
}

// `go test -cover` prints "coverage: 85.7% of statements" per package (also on
// the trailing "ok  pkg  0.01s  coverage: …" line). Statement coverage; line %
// stays null. Last value wins (a single `./...` summary line in practice).
function parseGoCoverage(lines: string[]): CoverageSummary | null {
  let statementsPct: number | null = null;
  for (const line of lines) {
    const m = line.match(/coverage:\s+([\d.]+)%\s+of\s+statements/);
    if (m) { const p = clampPct(Number(m[1])); if (p != null) statementsPct = p; }
  }
  return statementsPct == null ? null : { linesPct: null, statementsPct };
}

// Failed-only rerun mechanism (M131, v1.7) — the portFlag discipline: declared
// per runner ONLY where its documentation confirms the mechanism, never
// guessed. Two shapes: `stateful` reuses the runner's own last-failed cache
// (pytest `--lf`, no placeholder); `name-filter` substitutes a `{tests}`
// selector built from the recorded failure names, escaped per the runner's
// filter grammar (`go-regex` = anchored regex alternation for go `-run`;
// `literal` = `|`-joined names for jest/vitest `-t` and dotnet `--filter`).
export interface RerunFlag {
  kind: 'stateful' | 'name-filter';
  template: string;
  escape?: 'literal' | 'go-regex';
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuote(s: string): string {
  return '"' + s.replace(/"/g, '\\"') + '"';
}

export type RerunComposition =
  | { command: string }
  | { error: 'no-rerun-flag' }
  | { error: 'no-names' };

// Compose a failed-only rerun command from a base command + the recorded
// failure names. no-rerun-flag = the runner declares no mechanism (explicit
// non-participation — caller errors naming the runner + registry gap);
// no-names = a name-filter runner whose failures carry no usable names (caller
// errors, never silently falls back to a full run). Names are deduped + sorted
// so the composed command is deterministic.
export function composeRerunCommand(
  baseCommand: string,
  runner: TestRunnerId | null,
  failureNames: string[],
): RerunComposition {
  const flag = runner ? TEST_RUNNER_META[runner]?.rerunFlag : undefined;
  if (!flag) return { error: 'no-rerun-flag' };
  if (flag.kind === 'stateful') {
    return { command: `${baseCommand} ${flag.template}`.trim() };
  }
  const names = [...new Set(failureNames.map(n => n.trim()).filter(Boolean))].sort();
  if (!names.length) return { error: 'no-names' };
  const tests = flag.escape === 'go-regex'
    ? `^(${names.map(regexEscape).join('|')})$`
    : names.join('|');
  const injected = flag.template.replace('{tests}', shellQuote(tests));
  return { command: `${baseCommand} ${injected}`.trim() };
}

// Per-runner metadata (M128/M131). supportsCoverage gates the coverage-fixture
// requirement; parseCoverage reads the runner's documented summary; rerunFlag
// (M131) declares the failed-only mechanism. cargo DELIBERATELY ships without
// coverage AND without a rerun flag — no documented default machine-readable
// summary was confirmed against real captured output, so it doesn't participate
// (never guess a format).
export interface TestRunnerMeta {
  supportsCoverage: boolean;
  parseCoverage?: (lines: string[]) => CoverageSummary | null;
  rerunFlag?: RerunFlag;
}

export const TEST_RUNNER_META: Record<TestRunnerId, TestRunnerMeta> = {
  'vitest-jest': { supportsCoverage: true, parseCoverage: parseVitestJestCoverage, rerunFlag: { kind: 'name-filter', template: '-t {tests}', escape: 'literal' } },
  'pytest': { supportsCoverage: true, parseCoverage: parsePytestCoverage, rerunFlag: { kind: 'stateful', template: '--lf' } },
  'go-test': { supportsCoverage: true, parseCoverage: parseGoCoverage, rerunFlag: { kind: 'name-filter', template: '-run {tests}', escape: 'go-regex' } },
  'cargo-test': { supportsCoverage: false },
  'dotnet-test': { supportsCoverage: false, rerunFlag: { kind: 'name-filter', template: '--filter {tests}', escape: 'literal' } },
};

// Parse runner output. Unknown runner (custom testCommand we couldn't guess)
// tries every parser and keeps the first that produced totals — still
// fail-soft when none does. Coverage is attached opportunistically via the
// matched runner's parser; a coverage-parse throw degrades to null, never
// blocks the run.
export function parseTestOutput(runner: TestRunnerId | null, output: string): ParsedTestRun {
  const lines = stripAnsi(output).split(/\r?\n/);
  const withCoverage = (r: ParsedTestRun): ParsedTestRun => {
    const meta = r.runner ? TEST_RUNNER_META[r.runner] : undefined;
    if (!meta?.supportsCoverage || !meta.parseCoverage) return r;
    try { r.coverage = meta.parseCoverage(lines); } catch { r.coverage = null; }
    return r;
  };
  if (runner && PARSERS[runner]) {
    try { return withCoverage(PARSERS[runner](lines)); } catch { return { totals: null, failures: [], runner, coverage: null }; }
  }
  for (const id of KNOWN_TEST_RUNNER_IDS) {
    try {
      const r = PARSERS[id](lines);
      if (r.totals) return withCoverage(r);
    } catch {}
  }
  return { totals: null, failures: [], runner: null, coverage: null };
}

// ---------------------------------------------------------------------------
// Execution. One-shot spawn with a hard timeout (tree-killed on expiry).
// ---------------------------------------------------------------------------

export interface TestRunResult {
  command: string;
  runner: TestRunnerId | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  totals: TestTotals | null;
  failures: TestFailure[];
  coverage: CoverageSummary | null;
  outputTail: string[];
}

export function runTestCommand(
  app: Pick<DiscoveredApp, 'workspaceRoot' | 'env'>,
  resolved: Pick<ResolvedRunner, 'command' | 'runner'>,
  timeoutMs: number,
): Promise<TestRunResult> {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(resolved.command, [], {
      cwd: app.workspaceRoot,
      shell: true,
      env: { ...process.env, ...(app.env || {}), FORCE_COLOR: '0', CI: process.env.CI ?? '1' },
      windowsHide: true,
    });
    const lines: string[] = [];
    let acc = '';
    let timedOut = false;
    const onData = (chunk: Buffer) => {
      acc += chunk.toString('utf8');
      const idx = acc.lastIndexOf('\n');
      if (idx < 0) return;
      const complete = acc.slice(0, idx);
      acc = acc.slice(idx + 1);
      for (const raw of complete.split(/\r?\n/)) {
        lines.push(stripAnsi(raw));
        if (lines.length > 5000) lines.splice(0, lines.length - 5000);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const killTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        treeKill(child.pid, 'SIGTERM', () => {});
        setTimeout(() => { if (child.pid) treeKill(child.pid, 'SIGKILL', () => {}); }, 2000);
      }
    }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(killTimer);
      if (acc.trim()) lines.push(stripAnsi(acc));
      const all = lines.join('\n');
      const parsed = parseTestOutput(resolved.runner, all);
      resolve({
        command: resolved.command,
        runner: parsed.runner ?? resolved.runner,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - start,
        totals: parsed.totals,
        failures: parsed.failures,
        coverage: parsed.coverage,
        outputTail: lines.slice(-50),
      });
    });
    child.on('error', () => {
      clearTimeout(killTimer);
      resolve({
        command: resolved.command,
        runner: resolved.runner,
        exitCode: -1,
        timedOut,
        durationMs: Date.now() - start,
        totals: null,
        failures: [],
        coverage: null,
        outputTail: [...lines.slice(-49), '[daimon] test spawn error'],
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Flaky detection (M75). Pure + query-derived: no new state. A fingerprint
// that flips pass↔fail `threshold`+ times across runs at the SAME gitHead is
// flaky (fail→pass and pass→fail both count as one flip each).
// ---------------------------------------------------------------------------

export interface FlakyTest {
  fingerprint: string;
  test: string;
  suite: string;
  flips: number;
  gitHead: string;
}

export function findFlakyTests(
  runs: { id: number; ts: number; gitHead: string | null }[],
  fetchFailures: (runIds: number[]) => { runId: number; fingerprint: string | null; test: string | null; suite: string | null; quarantined?: number | null }[],
  gitHead: string,
  threshold = 3,
): FlakyTest[] {
  const sameHead = runs.filter(r => r.gitHead === gitHead).sort((a, b) => a.ts - b.ts);
  if (sameHead.length < 2) return [];
  const failures = fetchFailures(sameHead.map(r => r.id));
  const byRun = new Map<number, Set<string>>();
  const meta = new Map<string, { test: string; suite: string }>();
  for (const f of failures) {
    // Quarantined failures (M130) are excluded from flaky detection — parking a
    // test silences its flaky churn without hiding that it still runs.
    if (!f.fingerprint || f.quarantined) continue;
    let set = byRun.get(f.runId);
    if (!set) { set = new Set(); byRun.set(f.runId, set); }
    set.add(f.fingerprint);
    if (!meta.has(f.fingerprint)) meta.set(f.fingerprint, { test: f.test ?? '', suite: f.suite ?? '' });
  }
  const out: FlakyTest[] = [];
  for (const [fp, m] of meta) {
    let flips = 0;
    let prev: boolean | null = null;
    for (const run of sameHead) {
      const failing = byRun.get(run.id)?.has(fp) ?? false;
      if (prev != null && failing !== prev) flips++;
      prev = failing;
    }
    if (flips >= threshold) out.push({ fingerprint: fp, test: m.test, suite: m.suite, flips, gitHead });
  }
  return out.sort((a, b) => b.flips - a.flips);
}

// Best-effort short git head for the run's workspaceRoot; null outside git.
export function gitHeadForDir(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      timeout: 1500,
      maxBuffer: 4096,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) return resolve(null);
      const out = stdout.toString().trim();
      resolve(out ? out.slice(0, 40) : null);
    });
  });
}
