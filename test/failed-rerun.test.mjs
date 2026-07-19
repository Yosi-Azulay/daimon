import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M131 (v1.7) — `daimon test --failed`. Reruns only the last recorded run's
// failures via the runner's registry-declared rerunFlag. Every unmet
// precondition is an explicit error (with remedy) or an honest no-op — it NEVER
// silently falls back to a full run.

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-failedrerun-'));
process.env.DAIMON_HOME = fakeHome;

const { Registry } = await import('../dist/registry.js');
const { History } = await import('../dist/history.js');

// A fake runner: echoes its own argv so we can confirm nothing is spawned we
// didn't compose, and exits cleanly. The daimon-level command is what we assert
// (runTests returns the exact command it used).
const echo = path.join(fakeHome, 'echo.mjs');
fs.writeFileSync(echo, `process.stdout.write(process.argv.slice(2).join(' ') + "\\n");\n`);

function cfg(overrides) {
  return {
    searchRoots: [], portRange: [4000, 4099], apiPort: 0, overrides,
    autoStart: [], profiles: {}, tags: {},
    autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: path.join(fakeHome, 'history.db'), retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 },
  };
}

function app(name) {
  return { name, baseName: name, workspaceRoot: fakeHome, workspaceType: 'polyglot', command: 'noop', hidden: false, tags: [] };
}

function seedRun(history, appName, runner, failures) {
  return history.recordTestRun(
    { app: appName, runner, durationMs: 10, total: 5, passed: 5 - failures.length, failed: failures.length, skipped: 0, exitCode: failures.length ? 1 : 0, gitHead: 'h' },
    failures.map(t => ({ suite: '', test: t, message: 'x', fingerprint: `fp:${t}` })),
  );
}

function freshRegistry(overrides) {
  const config = cfg(overrides);
  const reg = new Registry(config, Object.keys(overrides).map(app));
  const history = new History(config.history);
  reg.setHistory(history);
  return { reg, history };
}

test('go runner: --failed reruns exactly the seeded failures via an anchored -run alternation', async () => {
  const { reg, history } = freshRegistry({ gofix: { testCommand: `node "${echo}" go test ./...` } });
  seedRun(history, 'gofix', 'go-test', ['TestB', 'TestA']);
  const r = await reg.runTests('gofix', { failedOnly: true });
  assert.ok(!('error' in r), `unexpected error: ${JSON.stringify(r)}`);
  assert.equal(r.failedOnly, true);
  assert.equal(r.command, `node "${echo}" go test ./... -run "^(TestA|TestB)$"`, 'command-line asserted (names deduped + sorted)');
  // The rerun lands in test_runs with failedOnly set.
  const latest = history.queryTestRuns({ app: 'gofix', limit: 1 })[0];
  assert.equal(latest.failedOnly, 1);
  history.close();
});

test('pytest: --failed uses --lf (stateful, no name placeholder)', async () => {
  const { reg, history } = freshRegistry({ pyfix: { testCommand: `node "${echo}" pytest` } });
  seedRun(history, 'pyfix', 'pytest', ['test_add']);
  const r = await reg.runTests('pyfix', { failedOnly: true });
  assert.ok(!('error' in r));
  assert.equal(r.command, `node "${echo}" pytest --lf`);
  assert.ok(!/\-run|\-t /.test(r.command), 'no name filter for a stateful runner');
  history.close();
});

test('no prior run: --failed errors with a remedy pointing at plain daimon test', async () => {
  const { reg, history } = freshRegistry({ fresh: { testCommand: `node "${echo}" pytest` } });
  const r = await reg.runTests('fresh', { failedOnly: true });
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
  assert.match(r.error, /no recorded test run/);
  assert.match(r.hint, /daimon test fresh/);
  history.close();
});

test('all-green prior run: --failed is a no-op (nothing spawned, exit 0, note)', async () => {
  const { reg, history } = freshRegistry({ green: { testCommand: `node "${echo}" go test ./...` } });
  seedRun(history, 'green', 'go-test', []); // zero failures
  const before = history.queryTestRuns({ app: 'green' }).length;
  const r = await reg.runTests('green', { failedOnly: true });
  assert.ok(!('error' in r));
  assert.equal(r.exitCode, 0);
  assert.equal(r.command, null, 'nothing was spawned');
  assert.match(r.note, /nothing to rerun/);
  const after = history.queryTestRuns({ app: 'green' }).length;
  assert.equal(after, before, 'no new run recorded for a no-op');
  history.close();
});

test('undeclared runner (cargo): --failed errors naming the runner + rerunFlag gap', async () => {
  const { reg, history } = freshRegistry({ rust: { testCommand: `node "${echo}" cargo test` } });
  seedRun(history, 'rust', 'cargo-test', ['tests::it_works']);
  const r = await reg.runTests('rust', { failedOnly: true });
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
  assert.match(r.error, /cargo-test/);
  assert.match(r.hint, /rerunFlag/);
  history.close();
});

test('name-filter runner with unparseable names: --failed errors, never a full rerun', async () => {
  const { reg, history } = freshRegistry({ goblank: { testCommand: `node "${echo}" go test ./...` } });
  seedRun(history, 'goblank', 'go-test', ['', '   ']); // no usable names
  const r = await reg.runTests('goblank', { failedOnly: true });
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
  assert.match(r.error, /no usable test names/);
  assert.match(r.hint, /daimon test goblank/);
  history.close();
});
