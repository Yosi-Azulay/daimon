import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// M171 (v1.14, "First Run") — doctor onboarding rules: the mistakes a
// stranger makes in their first fifteen minutes get a suggest-only doctor
// finding + a remedy. None of the four is auto-fixed (nothing here clears
// verify-then-kill's bar — see src/autoFix.ts, unchanged by this milestone):
//   - config-wrong-directory: cwd has no daimon.config.json but one exists
//     up the tree, or the global ~/.daimon/config.json was the fallback.
//   - daemon-not-started: config loaded, but nothing answers on apiPort.
//   - no-apps-detected: config + discovery ran, but found zero apps — names
//     the likeliest cause from discovery's own stats.rejected tally.
//   - port-pool-absent: a detected app's framework declares portFlag/portEnv
//     but no ports.pool is configured.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'test', 'fixtures', 'frameworks');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-doctor-onboarding-'));
// Isolate ~/.daimon before anything resolves daimonDir().
process.env.DAIMON_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.DAIMON_HOME, { recursive: true });

const { runDoctor } = await import('../dist/doctor.js');
const { discoverApps } = await import('../dist/discovery.js');
const { daimonDir } = await import('../dist/daemon.js');

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [4210, 4290], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: '', retentionDays: 0 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 0 }, headless: true, envFiles: {},
    requestLog: { enabled: false, portOffset: 0 }, metrics: { enabled: false },
    editor: { scheme: '' }, apiToken: null, output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } }, dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 86400000 }, plugins: { dir: null }, webhooks: [], frameworks: [],
    tests: { flakyThreshold: 3 }, restartStorm: { perHour: 20 },
    ...overrides,
  };
}

// Doctor's config-wrong-directory rule reads process.cwd() directly (there is
// no injectable-cwd seam in config.ts either) — chdir for the duration of the
// callback and always restore. Tests in this file run sequentially (node:test
// default for top-level tests in one file), so this is safe.
async function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(srv));
  });
}

// ---------------------------------------------------------------------------
// config-wrong-directory
// ---------------------------------------------------------------------------

test('config-wrong-directory: flags a parent daimon.config.json when cwd has none', async () => {
  const parent = fs.mkdtempSync(path.join(tmp, 'parent-'));
  fs.writeFileSync(path.join(parent, 'daimon.config.json'), JSON.stringify({ searchRoots: [] }));
  const child = path.join(parent, 'sub', 'project');
  fs.mkdirSync(child, { recursive: true });
  await withCwd(child, async () => {
    const r = await runDoctor(baseCfg(), [], { configPath: path.join(daimonDir(), 'config.json') });
    const check = r.checks.find(c => c.name === 'config-wrong-directory');
    assert.ok(check, 'flags the parent config');
    assert.equal(check.ok, true, 'informational — never fails doctor');
    assert.ok(check.detail.includes(path.join(parent, 'daimon.config.json')), `names the found path (${check.detail})`);
    assert.match(check.detail, /no --config flag/);
  });
});

test('config-wrong-directory: notes the global ~/.daimon/config.json fallback when no parent config exists', async () => {
  const lonely = fs.mkdtempSync(path.join(tmp, 'lonely-'));
  await withCwd(lonely, async () => {
    const userCfgPath = path.join(daimonDir(), 'config.json');
    const r = await runDoctor(baseCfg(), [], { configPath: userCfgPath });
    const check = r.checks.find(c => c.name === 'config-wrong-directory');
    assert.ok(check, 'flags the global fallback');
    assert.equal(check.ok, true);
    assert.match(check.detail, /global config/);
    assert.ok(check.detail.includes(userCfgPath));
  });
});

test('config-wrong-directory: green path — cwd already holds the active config, even with a parent config present', async () => {
  const parent = fs.mkdtempSync(path.join(tmp, 'parent-green-'));
  fs.writeFileSync(path.join(parent, 'daimon.config.json'), '{}');
  const child = path.join(parent, 'sub');
  fs.mkdirSync(child, { recursive: true });
  const childCfgPath = path.join(child, 'daimon.config.json');
  fs.writeFileSync(childCfgPath, '{}');
  await withCwd(child, async () => {
    const r = await runDoctor(baseCfg(), [], { configPath: childCfgPath });
    assert.ok(!r.checks.some(c => c.name === 'config-wrong-directory'), 'no finding when cwd already has the active config');
  });
});

test('config-wrong-directory: green path — no opts.configPath (a request path that never resolved one) stays silent', async () => {
  const r = await runDoctor(baseCfg(), []);
  assert.ok(!r.checks.some(c => c.name === 'config-wrong-directory'));
});

// ---------------------------------------------------------------------------
// daemon-not-started
// ---------------------------------------------------------------------------

test('daemon-not-started: fires when nothing listens on apiPort', async () => {
  const cfg = baseCfg({ apiPort: 43521 });
  const r = await runDoctor(cfg, []);
  const check = r.checks.find(c => c.name === 'daemon-not-started');
  assert.ok(check, 'flags the unstarted daemon');
  assert.equal(check.ok, false);
  assert.match(check.detail, /daimon daemon start/);
  // Distinct from the existing port-holder rules: nothing holds the port at
  // all, so those stay clean — this is a NEW signal, not a rename.
  const apiPortCheck = r.checks.find(c => c.name === 'apiPort 43521');
  const holder = r.checks.find(c => c.name === 'port-holder-no-lock');
  assert.ok(apiPortCheck?.ok === true && holder?.ok === true, 'port-holder rules are unaffected — nothing holds the port');
});

test('daemon-not-started: green path — something listening on apiPort suppresses the finding', async () => {
  const port = 43522;
  const srv = await listen(port);
  try {
    const r = await runDoctor(baseCfg({ apiPort: port }), []);
    assert.ok(!r.checks.some(c => c.name === 'daemon-not-started'), 'a listener is present — not this rule\'s case');
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// no-apps-detected
// ---------------------------------------------------------------------------

test('no-apps-detected: names "searchRoot missing" as the likeliest cause', async () => {
  const missing = path.join(tmp, 'never-created');
  const cfg = baseCfg({ searchRoots: [missing] });
  const stats = { scanned: 0, rejected: {} };
  const apps = discoverApps(cfg, { warnings: [], stats });
  assert.equal(apps.length, 0, 'sanity: nothing found');
  const r = await runDoctor(cfg, apps, { discoveryStats: stats });
  const check = r.checks.find(c => c.name === 'no-apps-detected');
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.match(check.detail, /searchRoot missing/);
  assert.match(check.detail, /searchRoots/);
});

test('no-apps-detected: names "no project markers" as a distinct likeliest cause', async () => {
  const blank = fs.mkdtempSync(path.join(tmp, 'blank-'));
  fs.writeFileSync(path.join(blank, 'README.md'), '# nothing here');
  const cfg = baseCfg({ searchRoots: [blank] });
  const stats = { scanned: 0, rejected: {} };
  const apps = discoverApps(cfg, { warnings: [], stats });
  assert.equal(apps.length, 0, 'sanity: nothing found');
  const r = await runDoctor(cfg, apps, { discoveryStats: stats });
  const check = r.checks.find(c => c.name === 'no-apps-detected');
  assert.ok(check);
  assert.match(check.detail, /no project markers/);
  assert.match(check.detail, /daimon frameworks/);
});

test('no-apps-detected: no searchRoots configured at all gets its own distinct remedy', async () => {
  const r = await runDoctor(baseCfg({ searchRoots: [] }), []);
  const check = r.checks.find(c => c.name === 'no-apps-detected');
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.match(check.detail, /no searchRoots configured/);
  assert.match(check.detail, /daimon init/);
});

test('no-apps-detected: without discoveryStats it still fires, just without naming a cause', async () => {
  const missing = path.join(tmp, 'still-never-created');
  const r = await runDoctor(baseCfg({ searchRoots: [missing] }), []);
  const check = r.checks.find(c => c.name === 'no-apps-detected');
  assert.ok(check, 'still fires on an empty apps[]');
  assert.equal(check.ok, false);
});

test('no-apps-detected: green path — a real vite fixture is discovered, no finding', async () => {
  const cfg = baseCfg({ searchRoots: [path.join(fixturesDir, 'vite')] });
  const stats = { scanned: 0, rejected: {} };
  const apps = discoverApps(cfg, { warnings: [], stats });
  assert.ok(apps.length > 0, 'sanity: the vite fixture is discovered');
  const r = await runDoctor(cfg, apps, { discoveryStats: stats });
  assert.ok(!r.checks.some(c => c.name === 'no-apps-detected'));
});

// ---------------------------------------------------------------------------
// port-pool-absent
// ---------------------------------------------------------------------------

test('port-pool-absent: suggests the pool key when a discovered app declares portFlag/portEnv', async () => {
  const cfg = baseCfg({ searchRoots: [path.join(fixturesDir, 'vite')] });
  const apps = discoverApps(cfg, { warnings: [] });
  assert.ok(apps.length > 0 && apps.some(a => a.serverProfile === 'vite'), 'sanity: vite app discovered');
  const r = await runDoctor(cfg, apps);
  const check = r.checks.find(c => c.name === 'port-pool-absent');
  assert.ok(check, 'suggests a ports.pool');
  assert.equal(check.ok, true, 'suggest-only — never fails doctor');
  assert.match(check.detail, /"pool":\s*"4200-4299"/);
});

test('port-pool-absent: green path — ports.pool already configured', async () => {
  const cfg = baseCfg({ searchRoots: [path.join(fixturesDir, 'vite')], ports: { pool: '4300-4399' } });
  const apps = discoverApps(cfg, { warnings: [] });
  assert.ok(apps.length > 0, 'sanity: vite app discovered');
  const r = await runDoctor(cfg, apps);
  assert.ok(!r.checks.some(c => c.name === 'port-pool-absent'), 'already configured — nothing to suggest');
});

test("port-pool-absent: green path — the detected app's framework has no port-injection mechanism", async () => {
  const cfg = baseCfg({ searchRoots: [path.join(fixturesDir, 'dotnet')] });
  const apps = discoverApps(cfg, { warnings: [] });
  assert.ok(apps.length > 0 && apps.some(a => a.serverProfile === 'dotnet'), 'sanity: dotnet app discovered');
  const r = await runDoctor(cfg, apps);
  assert.ok(!r.checks.some(c => c.name === 'port-pool-absent'), 'dotnet does not declare portFlag/portEnv (M81 registry discipline)');
});

// ---------------------------------------------------------------------------
// Combined: a healthy, fully configured setup stays clean
// ---------------------------------------------------------------------------

test('a fully healthy configured setup produces none of the four new findings', async () => {
  const projectDir = fs.mkdtempSync(path.join(tmp, 'healthy-'));
  const projectCfgPath = path.join(projectDir, 'daimon.config.json');
  fs.writeFileSync(projectCfgPath, '{}');
  const port = 43523;
  const srv = await listen(port);
  try {
    await withCwd(projectDir, async () => {
      const cfg = baseCfg({
        apiPort: port,
        searchRoots: [path.join(fixturesDir, 'vite')],
        ports: { pool: '4300-4399' },
      });
      const stats = { scanned: 0, rejected: {} };
      const apps = discoverApps(cfg, { warnings: [], stats });
      assert.ok(apps.length > 0, 'sanity: apps discovered');
      const r = await runDoctor(cfg, apps, { configPath: projectCfgPath, discoveryStats: stats });
      for (const name of ['config-wrong-directory', 'daemon-not-started', 'no-apps-detected', 'port-pool-absent']) {
        assert.ok(
          !r.checks.some(c => c.name === name),
          `${name} should not false-positive on a healthy setup (got: ${JSON.stringify(r.checks.filter(c => c.name === name))})`,
        );
      }
    });
  } finally {
    srv.close();
  }
});
