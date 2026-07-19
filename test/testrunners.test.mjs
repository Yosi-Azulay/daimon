import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M74 — test-runner adapter kit. One fixture per runner id under
// test/fixtures/testrunners/<id>/; this suite is the gate for every parser:
// a runner without a fixture doesn't ship.

const {
  KNOWN_TEST_RUNNER_IDS,
  parseTestOutput,
  resolveTestCommand,
  guessRunnerFromCommand,
  testFailureFingerprint,
  findFlakyTests,
  TEST_RUNNER_META,
  composeRerunCommand,
} = await import('../dist/testRunners.js');
const { History } = await import('../dist/history.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures', 'testrunners');

const fixtureIds = fs.readdirSync(fixturesDir).filter(d => fs.statSync(path.join(fixturesDir, d)).isDirectory());

test('every test-runner parser ships with a fixture (and no orphan fixtures)', () => {
  for (const id of KNOWN_TEST_RUNNER_IDS) {
    assert.ok(fixtureIds.includes(id), `runner '${id}' has no fixture in test/fixtures/testrunners/ — a runner without a fixture doesn't ship`);
  }
  for (const id of fixtureIds) {
    assert.ok(KNOWN_TEST_RUNNER_IDS.includes(id), `fixture '${id}' has no matching runner id`);
  }
});

function appFor(dir, spec) {
  return {
    name: 'fixture-app',
    baseName: 'fixture-app',
    workspaceRoot: dir,
    workspaceType: spec.workspaceType ?? 'polyglot',
    command: 'noop',
    hidden: false,
    tags: [],
    serverProfile: spec.serverProfile,
  };
}

const emptyCfg = { overrides: {}, frameworks: [] };

for (const id of fixtureIds) {
  const dir = path.join(fixturesDir, id);
  const fx = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));

  test(`testrunner ${id}: runner resolution from profile hint`, () => {
    const r = resolveTestCommand(appFor(dir, fx.resolve.app), emptyCfg);
    assert.ok(!('error' in r), `resolution failed: ${JSON.stringify(r)}`);
    assert.equal(r.command, fx.resolve.expectCommand);
    assert.equal(r.runner, fx.resolve.expectRunner);
  });

  for (const c of fx.cases) {
    test(`testrunner ${id}: case '${c.name}' parses totals + failures`, () => {
      const parsed = parseTestOutput(fx.runner, c.output.join('\n'));
      if (c.expectTotals === null) {
        // Fail-soft: garbage output must not fabricate totals or failures.
        assert.equal(parsed.totals, null, `expected no totals, got ${JSON.stringify(parsed.totals)}`);
        assert.equal(parsed.failures.length, 0);
        return;
      }
      assert.ok(parsed.totals, `expected totals, got null`);
      assert.equal(parsed.totals.total, c.expectTotals.total, 'total');
      assert.equal(parsed.totals.passed, c.expectTotals.passed, 'passed');
      assert.equal(parsed.totals.failed, c.expectTotals.failed, 'failed');
      assert.equal(parsed.totals.skipped, c.expectTotals.skipped, 'skipped');
      if (c.expectTotals.durationMs !== undefined) {
        assert.equal(parsed.totals.durationMs, c.expectTotals.durationMs, 'durationMs');
      }
      assert.equal(parsed.failures.length, c.expectFailures.length, `failure count; got ${JSON.stringify(parsed.failures)}`);
      for (let i = 0; i < c.expectFailures.length; i++) {
        const want = c.expectFailures[i];
        const got = parsed.failures[i];
        assert.equal(got.suite, want.suite, `failure[${i}].suite`);
        assert.equal(got.test, want.test, `failure[${i}].test`);
        assert.equal(got.file, want.file, `failure[${i}].file`);
        assert.equal(got.line, want.line, `failure[${i}].line`);
        if (want.messageIncludes) {
          assert.ok(got.message.includes(want.messageIncludes), `failure[${i}].message '${got.message}' should include '${want.messageIncludes}'`);
        }
      }
    });
  }

  test(`testrunner ${id}: autodetect (runner=null) still parses a failing case`, () => {
    const failing = fx.cases.find(c => c.expectTotals && c.expectTotals.failed > 0);
    if (!failing) return;
    const parsed = parseTestOutput(null, failing.output.join('\n'));
    assert.ok(parsed.totals, 'autodetect found totals');
    assert.equal(parsed.totals.failed, failing.expectTotals.failed);
  });
}

// ---------------------------------------------------------------------------
// Coverage capture (M128, v1.7). supportsCoverage gates the coverage fixtures;
// with-coverage yields the documented percentage, without/malformed → null.
// Fabricated coverage is the same violation as a fabricated test total.
// ---------------------------------------------------------------------------

for (const id of KNOWN_TEST_RUNNER_IDS) {
  const meta = TEST_RUNNER_META[id];
  if (!meta.supportsCoverage) continue;
  const dir = path.join(fixturesDir, id);
  const fx = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));

  test(`coverage ${id}: supportsCoverage runner ships with/without/malformed coverage cases`, () => {
    assert.ok(Array.isArray(fx.coverage) && fx.coverage.length >= 1,
      `runner '${id}' declares supportsCoverage but its fixture has no coverage cases`);
    assert.ok(fx.coverage.some(c => c.expectCoverage === null),
      `runner '${id}' needs at least one coverage case expecting null (without/malformed)`);
    assert.ok(fx.coverage.some(c => c.expectCoverage && (c.expectCoverage.linesPct != null || c.expectCoverage.statementsPct != null)),
      `runner '${id}' needs at least one with-coverage case`);
  });

  for (const c of (fx.coverage ?? [])) {
    test(`coverage ${id}: case '${c.name}'`, () => {
      const parsed = parseTestOutput(fx.runner, c.output.join('\n'));
      if (c.expectCoverage === null) {
        assert.equal(parsed.coverage, null, `expected null coverage, got ${JSON.stringify(parsed.coverage)}`);
        return;
      }
      assert.ok(parsed.coverage, 'expected coverage, got null');
      assert.equal(parsed.coverage.linesPct, c.expectCoverage.linesPct ?? null, 'linesPct');
      assert.equal(parsed.coverage.statementsPct, c.expectCoverage.statementsPct ?? null, 'statementsPct');
    });
  }
}

test('coverage: a runner without supportsCoverage never surfaces coverage', () => {
  for (const id of KNOWN_TEST_RUNNER_IDS) {
    if (TEST_RUNNER_META[id].supportsCoverage) continue;
    const fx = JSON.parse(fs.readFileSync(path.join(fixturesDir, id, 'fixture.json'), 'utf8'));
    for (const c of fx.cases) {
      const parsed = parseTestOutput(fx.runner, c.output.join('\n'));
      assert.equal(parsed.coverage, null, `${id} case '${c.name}' must have null coverage`);
    }
  }
});

// ---------------------------------------------------------------------------
// Failed-only rerun composition (M131, v1.7). rerunFlag is registry-declared;
// no flag = explicit non-participation (no-rerun-flag). name-filter runners
// error on empty names rather than silently rerunning everything.
// ---------------------------------------------------------------------------

test('rerun: pytest is stateful — appends --lf with no placeholder', () => {
  const r = composeRerunCommand('python -m pytest', 'pytest', ['test_add', 'test_sub']);
  assert.deepEqual(r, { command: 'python -m pytest --lf' });
});

test('rerun: go builds an anchored regex-escaped -run alternation', () => {
  const r = composeRerunCommand('go test ./...', 'go-test', ['TestSub', 'TestAdd']);
  // names deduped + sorted → deterministic
  assert.deepEqual(r, { command: 'go test ./... -run "^(TestAdd|TestSub)$"' });
});

test('rerun: vitest/jest join names literally into a -t pattern', () => {
  const r = composeRerunCommand('npx vitest run', 'vitest-jest', ['adds numbers', 'divides']);
  assert.deepEqual(r, { command: 'npx vitest run -t "adds numbers|divides"' });
});

test('rerun: dotnet joins names literally into a --filter expression', () => {
  // dotnet --filter's bare tokens default to FullyQualifiedName~<value>, and `|`
  // is the OR operator — so a pipe-joined name list is a valid filter.
  const r = composeRerunCommand('dotnet test', 'dotnet-test', ['Calc.Adds', 'Calc.Subs']);
  assert.deepEqual(r, { command: 'dotnet test --filter "Calc.Adds|Calc.Subs"' });
});

test('rerun: cargo declares no rerunFlag → no-rerun-flag (explicit non-participation)', () => {
  const r = composeRerunCommand('cargo test', 'cargo-test', ['t']);
  assert.deepEqual(r, { error: 'no-rerun-flag' });
});

// Structural gate: EVERY runner that declares a rerunFlag must compose a usable
// command — no declared mechanism ships unexercised (the finding this closes).
test('rerun: every declared rerunFlag composes a valid command', () => {
  for (const id of KNOWN_TEST_RUNNER_IDS) {
    const flag = TEST_RUNNER_META[id].rerunFlag;
    if (!flag) continue;
    const r = composeRerunCommand('base cmd', id, ['NameA', 'NameB']);
    assert.ok('command' in r, `runner '${id}' rerunFlag did not compose: ${JSON.stringify(r)}`);
    if (flag.kind === 'stateful') {
      assert.ok(r.command.endsWith(flag.template), `stateful '${id}' must append its template verbatim`);
      assert.ok(!/\{tests\}/.test(r.command), `'${id}' left an unfilled placeholder`);
    } else {
      // name-filter: the flag token (template minus the placeholder) and both
      // names must appear; no {tests} left behind.
      const flagToken = flag.template.replace('{tests}', '').trim();
      assert.ok(r.command.includes(flagToken), `'${id}' must include its flag token '${flagToken}'`);
      assert.ok(r.command.includes('NameA') && r.command.includes('NameB'), `'${id}' must include the failure names`);
      assert.ok(!/\{tests\}/.test(r.command), `'${id}' left an unfilled placeholder`);
    }
  }
});

test('rerun: name-filter runner with no usable names errors (never a full rerun)', () => {
  const r = composeRerunCommand('go test ./...', 'go-test', ['', '  ']);
  assert.deepEqual(r, { error: 'no-names' });
});

test('rerun: null runner has no flag', () => {
  assert.deepEqual(composeRerunCommand('make test', null, ['t']), { error: 'no-rerun-flag' });
});

test('overrides.<app>.testCommand always wins over the profile hint', () => {
  const dir = path.join(fixturesDir, 'vitest-jest');
  const app = appFor(dir, { serverProfile: 'vite', workspaceType: 'vite' });
  const r = resolveTestCommand(app, { overrides: { 'fixture-app': { testCommand: 'pnpm run test:unit' } }, frameworks: [] });
  assert.ok(!('error' in r));
  assert.equal(r.command, 'pnpm run test:unit');
  assert.equal(r.source, 'override');
});

test('unresolvable runner returns { error, hint } suggesting the override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-norunner-'));
  const app = appFor(dir, { serverProfile: 'laravel' });
  const r = resolveTestCommand(app, emptyCfg);
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
  assert.match(r.hint, /testCommand/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm stub test script is never treated as a runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-stub-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'stub', scripts: { dev: 'vite', test: 'echo "Error: no test specified" && exit 1' },
  }));
  const app = appFor(dir, { serverProfile: 'package-json', workspaceType: 'vite' });
  const r = resolveTestCommand(app, emptyCfg);
  assert.ok('error' in r, 'stub script must not resolve');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real package.json test script resolves via {pm} run test', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-script-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 's', scripts: { dev: 'node server.js', test: 'node --test test/' },
  }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  const app = appFor(dir, { serverProfile: 'package-json', workspaceType: 'vite' });
  const r = resolveTestCommand(app, emptyCfg);
  assert.ok(!('error' in r));
  assert.equal(r.command, 'pnpm run test');
  assert.equal(r.source, 'package-script');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nx / angular workspace apps get their workspace test wrapper', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-nx-'));
  const nx = resolveTestCommand({ ...appFor(dir, { serverProfile: 'nx' }), workspaceType: 'nx', baseName: 'web-admin' }, emptyCfg);
  assert.equal(nx.command, 'npx nx test web-admin');
  const ng = resolveTestCommand({ ...appFor(dir, { serverProfile: 'angular' }), workspaceType: 'angular', baseName: 'web-admin' }, emptyCfg);
  assert.equal(ng.command, 'npx ng test web-admin --watch=false');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('guessRunnerFromCommand maps custom commands to parsers', () => {
  assert.equal(guessRunnerFromCommand('pnpm exec vitest run --coverage'), 'vitest-jest');
  assert.equal(guessRunnerFromCommand('python -m pytest -q'), 'pytest');
  assert.equal(guessRunnerFromCommand('go test ./... -v'), 'go-test');
  assert.equal(guessRunnerFromCommand('cargo test --workspace'), 'cargo-test');
  assert.equal(guessRunnerFromCommand('dotnet test MySln.sln'), 'dotnet-test');
  assert.equal(guessRunnerFromCommand('make check'), null);
});

test('testFailureFingerprint: file:line wins, message-hash fallback is number-stable', () => {
  assert.equal(testFailureFingerprint({ suite: 's', test: 't', file: 'a/b.ts', line: 12 }), 'a/b.ts:12');
  const a = testFailureFingerprint({ suite: 'math', test: 'adds 1' });
  const b = testFailureFingerprint({ suite: 'math', test: 'adds 2' });
  assert.equal(a, b, 'volatile numbers must not split fingerprints');
  assert.match(a, /^test:[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------------------
// Flaky detection (M75) — pure-function contract.
// ---------------------------------------------------------------------------

function syntheticRuns(head, states) {
  // states: array of booleans (true = fingerprint failing in that run)
  const runs = states.map((_, i) => ({ id: i + 1, ts: 1000 + i, gitHead: head }));
  const failures = states.flatMap((failing, i) => failing
    ? [{ runId: i + 1, fingerprint: 'fp1', test: 'flappy', suite: 'suite' }]
    : []);
  return { runs, failures };
}

test('flaky: 3 flips at the same gitHead flags the fingerprint exactly once', () => {
  const { runs, failures } = syntheticRuns('abc1234', [true, false, true, false]);
  const flaky = findFlakyTests(runs, () => failures, 'abc1234', 3);
  assert.equal(flaky.length, 1);
  assert.equal(flaky[0].fingerprint, 'fp1');
  assert.equal(flaky[0].flips, 3);
  assert.equal(flaky[0].test, 'flappy');
});

test('flaky: flips below threshold or across different heads do not flag', () => {
  const below = syntheticRuns('abc1234', [true, false, true]); // 2 flips
  assert.equal(findFlakyTests(below.runs, () => below.failures, 'abc1234', 3).length, 0);
  // Same flip pattern but each run on a different commit — never flaky.
  const runs = [
    { id: 1, ts: 1, gitHead: 'aaa' }, { id: 2, ts: 2, gitHead: 'bbb' },
    { id: 3, ts: 3, gitHead: 'ccc' }, { id: 4, ts: 4, gitHead: 'ddd' },
  ];
  const failures = [{ runId: 1, fingerprint: 'fp1', test: 't', suite: 's' }, { runId: 3, fingerprint: 'fp1', test: 't', suite: 's' }];
  for (const head of ['aaa', 'bbb', 'ccc', 'ddd']) {
    assert.equal(findFlakyTests(runs, () => failures, head, 3).length, 0);
  }
});

test('flaky: a consistently-failing test is not flaky', () => {
  const { runs, failures } = syntheticRuns('abc1234', [true, true, true, true]);
  assert.equal(findFlakyTests(runs, () => failures, 'abc1234', 3).length, 0);
});

// ---------------------------------------------------------------------------
// History round-trip: test_runs + test_failures (additive migration).
// ---------------------------------------------------------------------------

test('history: recordTestRun round-trips runs + failures and prunes with retention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-testhist-'));
  const h = new History({ enabled: true, path: path.join(dir, 'history.db'), retentionDays: 30 });
  const runId = h.recordTestRun(
    { app: 'web', runner: 'vitest-jest', durationMs: 1230, total: 3, passed: 2, failed: 1, skipped: 0, exitCode: 1, gitHead: 'abc1234' },
    [{ suite: 'math', test: 'adds', file: 'src/math.test.ts', line: 11, message: 'expected 4 to be 3', fingerprint: 'src/math.test.ts:11' }],
  );
  assert.ok(typeof runId === 'number' && runId > 0);
  const runs = h.queryTestRuns({ app: 'web', limit: 10 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].failed, 1);
  assert.equal(runs[0].gitHead, 'abc1234');
  const fails = h.queryTestFailures([runId]);
  assert.equal(fails.length, 1);
  assert.equal(fails[0].file, 'src/math.test.ts');
  assert.equal(fails[0].fingerprint, 'src/math.test.ts:11');
  h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
