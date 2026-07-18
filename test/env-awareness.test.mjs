import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M82 — env awareness: salted-hash snapshots at spawn, `daimon env` / `env
// diff`, why's envChanged, doctor's env-file-missing, and the redaction suite
// (no raw env value in the DB, events, API responses, or webhook payloads).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-env-'));
// Isolate ~/.daimon (salt file) before anything touches it.
process.env.DAIMON_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.DAIMON_HOME, { recursive: true });

const SENTINEL = 'XZQV_SECRET_VALUE_93711';

const { envSalt, saltPath, hashEnvValue, snapshotEnvFiles, diffEnvSnapshots, envFileCandidates, _resetSaltCacheForTest } = await import('../dist/envFiles.js');
const { History } = await import('../dist/history.js');
const { Registry } = await import('../dist/registry.js');
const { startServer } = await import('../dist/server.js');
const { shapePayload } = await import('../dist/webhooks.js');

function baseCfg(overrides = {}) {
  return {
    searchRoots: [], portRange: [43500, 43590], apiPort: 0, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 0, windowMs: 0 },
    healthProbe: { enabled: false, intervalMs: 0, timeoutMs: 0, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 0, maxBytesPerFile: 0 },
    depends: {}, cascadeRestart: false,
    history: { enabled: true, path: path.join(tmp, 'history.db'), retentionDays: 7 },
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

function quietApp(name, root, extra = {}) {
  return {
    name, baseName: name, workspaceRoot: root, workspaceType: 'polyglot',
    // Exits quickly without echoing anything (redaction sweep must not be
    // polluted by an app that prints its own env).
    command: 'node -e "setTimeout(() => process.exit(0), 150)" --',
    hidden: false, tags: [],
    ...extra,
  };
}

async function spawnOnce(reg, name) {
  const exited = new Promise(resolve => reg.once('childExit', resolve));
  const r = await reg.start(name);
  assert.equal(r.ok, true, JSON.stringify(r));
  await exited;
}

test('salt file is created once and reused', () => {
  const s1 = envSalt();
  assert.ok(s1.length >= 32);
  assert.ok(fs.existsSync(saltPath()), 'salt persisted');
  const onDisk = fs.readFileSync(saltPath(), 'utf8').trim();
  assert.equal(onDisk, s1);
  _resetSaltCacheForTest();
  assert.equal(envSalt(), s1, 'reloaded from disk, not regenerated');
});

test('snapshot carries key names + truncated hashes, never values', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'snap-'));
  fs.writeFileSync(path.join(root, '.env'), `API_KEY=${SENTINEL}\n# comment\nDB_URL="postgres://u:p@h/db"\n`);
  const snap = snapshotEnvFiles(root, ['.env', '.env.local']);
  const f = snap.files.find(x => x.file === '.env');
  assert.deepEqual(f.keyNames.sort(), ['API_KEY', 'DB_URL']);
  assert.match(f.keyHashes.API_KEY, /^[0-9a-f]{12}$/);
  const missing = snap.files.find(x => x.file === '.env.local');
  assert.equal(missing.exists, false);
  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes(SENTINEL), 'raw value never leaves the snapshot function');
  assert.ok(!serialized.includes('postgres://'), 'no value fragments either');
});

test('hashes are per-key and value-sensitive', () => {
  const salt = envSalt();
  const h1 = hashEnvValue(salt, 'A', 'same');
  const h2 = hashEnvValue(salt, 'B', 'same');
  const h3 = hashEnvValue(salt, 'A', 'different');
  assert.notEqual(h1, h2, 'key is mixed into the hash');
  assert.notEqual(h1, h3, 'value changes the hash');
  assert.equal(h1, hashEnvValue(salt, 'A', 'same'), 'deterministic');
});

test('diffEnvSnapshots reports files/keys added/removed/changed', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'diff-'));
  fs.writeFileSync(path.join(root, '.env'), 'KEEP=1\nCHANGE=old\nDROP=x\n');
  const before = snapshotEnvFiles(root, ['.env', '.env.local']);
  fs.writeFileSync(path.join(root, '.env'), 'KEEP=1\nCHANGE=new\nADDED=y\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'LOCAL=1\n');
  const after = snapshotEnvFiles(root, ['.env', '.env.local']);
  const d = diffEnvSnapshots(before, after);
  assert.equal(d.changed, true);
  assert.deepEqual(d.filesAdded, ['.env.local']);
  assert.deepEqual(d.filesRemoved, []);
  assert.deepEqual(d.keysAdded, [{ file: '.env', key: 'ADDED' }]);
  assert.deepEqual(d.keysRemoved, [{ file: '.env', key: 'DROP' }]);
  assert.deepEqual(d.keysChanged, [{ file: '.env', key: 'CHANGE' }]);
});

test('candidate resolution: config > profile > generic', () => {
  assert.deepEqual(envFileCandidates(['custom.env'], ['.env.local']), ['custom.env']);
  assert.deepEqual(envFileCandidates(undefined, ['.env', '.env.local']), ['.env', '.env.local']);
  assert.deepEqual(envFileCandidates(undefined, undefined), ['.env']);
  assert.deepEqual(envFileCandidates([], []), ['.env']);
});

test('spawn records a snapshot; value edit shows as changed via API; why gains envChanged', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'spawn-'));
  fs.writeFileSync(path.join(root, '.env.local'), `TOKEN=${SENTINEL}\nMODE=dev\n`);
  const cfg = baseCfg({ history: { enabled: true, path: path.join(tmp, 'spawn.db'), retentionDays: 7 } });
  const reg = new Registry(cfg, [quietApp('web', root, { serverProfile: 'vite' })]);
  const history = new History(cfg.history);
  reg.setHistory(history);

  await spawnOnce(reg, 'web');
  let snaps = history.queryEnvSnapshots({ app: 'web', limit: 10 });
  assert.equal(snaps.length, 1, 'one snapshot per spawn');
  assert.ok(snaps[0].json.includes('TOKEN'), 'key name recorded');
  assert.ok(!snaps[0].json.includes(SENTINEL), 'value NOT recorded');

  // Edit the value, spawn again → second snapshot differs.
  fs.writeFileSync(path.join(root, '.env.local'), `TOKEN=rotated-${Date.now()}\nMODE=dev\n`);
  await spawnOnce(reg, 'web');
  snaps = history.queryEnvSnapshots({ app: 'web', limit: 10 });
  assert.equal(snaps.length, 2);

  const server = startServer(reg, 0, { getConfig: () => cfg });
  await new Promise(res => server.once('listening', res));
  const apiPort = server.address().port;
  try {
    // daimon env <app>
    const envRes = await (await fetch(`http://127.0.0.1:${apiPort}/api/env/web`)).json();
    const envText = JSON.stringify(envRes);
    assert.ok(envRes.candidates.some(c => c.file === '.env.local' && c.exists), 'convention file found');
    assert.ok(envRes.snapshot.files.some(f => f.keyNames?.includes('TOKEN')), 'key names surfaced');
    assert.ok(!envText.includes(SENTINEL), 'env response value-free');
    assert.ok(!envText.includes('keyHashes'), 'hashes stay server-side');

    // daimon env diff — default last two spawns
    const diffRes = await (await fetch(`http://127.0.0.1:${apiPort}/api/env/web/diff`)).json();
    assert.equal(diffRes.changed, true);
    assert.ok(diffRes.keysChanged.some(k => k.key === 'TOKEN' && k.file === '.env.local'), JSON.stringify(diffRes));
    assert.ok(!JSON.stringify(diffRes).includes(SENTINEL));

    // why gains envChanged
    const whyRes = await (await fetch(`http://127.0.0.1:${apiPort}/api/why/web`)).json();
    assert.ok(whyRes.envChanged, 'envChanged present');
    assert.ok(whyRes.envChanged.keysChanged.some(k => k.key === 'TOKEN'), JSON.stringify(whyRes.envChanged));
    assert.ok(!JSON.stringify(whyRes).includes(SENTINEL));
  } finally {
    server.close();
    history.close();
  }
});

test('env diff with a single snapshot returns a note, not an error', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'single-'));
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
  const cfg = baseCfg({ history: { enabled: true, path: path.join(tmp, 'single.db'), retentionDays: 7 } });
  const reg = new Registry(cfg, [quietApp('solo', root)]);
  const history = new History(cfg.history);
  reg.setHistory(history);
  await spawnOnce(reg, 'solo');
  const server = startServer(reg, 0, { getConfig: () => cfg });
  await new Promise(res => server.once('listening', res));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/env/solo/diff`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.diff, null);
    assert.ok(/at least two snapshots/.test(body.note));
  } finally {
    server.close();
    history.close();
  }
});

test('doctor env-file-missing flags a convention file that vanished (suggest-only)', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'doc-'));
  fs.writeFileSync(path.join(root, '.env'), 'GONE_SOON=1\n');
  const dbPath = path.join(tmp, 'doctor-env.db');
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 7 } });
  const app = quietApp('vanish', root);
  const reg = new Registry(cfg, [app]);
  const history = new History(cfg.history);
  reg.setHistory(history);
  await spawnOnce(reg, 'vanish');
  history.close();

  fs.unlinkSync(path.join(root, '.env'));
  const { runDoctor } = await import('../dist/doctor.js');
  const r = await runDoctor(cfg, [app]);
  const check = r.checks.find(c => c.name === 'env-file-missing: vanish');
  assert.ok(check, `flagged (${JSON.stringify(r.checks.filter(c => c.name.startsWith('env-file')))})`);
  assert.equal(check.ok, true, 'suggest-only: never fails doctor');
  assert.ok(/existed at the last spawn/.test(check.detail));
});

test('REDACTION SUITE: raw value appears nowhere — db bytes, events, webhook shapes', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'redact-'));
  fs.writeFileSync(path.join(root, '.env'), `SECRET_ONE=${SENTINEL}\nPASSWORD=${SENTINEL}2\n`);
  const dbPath = path.join(tmp, 'redact.db');
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 7 } });
  const reg = new Registry(cfg, [quietApp('sealed', root, { serverProfile: 'vite' })]);
  // vite profile has no .env in root? It does: candidates ['.env', ...]; .env exists.
  const history = new History(cfg.history);
  reg.setHistory(history);
  const events = [];
  reg.on('event', ev => events.push(ev));

  await spawnOnce(reg, 'sealed');
  fs.writeFileSync(path.join(root, '.env'), `SECRET_ONE=${SENTINEL}-v2\nPASSWORD=${SENTINEL}2\n`);
  await spawnOnce(reg, 'sealed');

  // Events + webhook payload shapes carry no values.
  for (const ev of events) {
    const s = JSON.stringify(ev);
    assert.ok(!s.includes(SENTINEL), `event leaked a value: ${s}`);
    const slack = JSON.stringify(shapePayload('https://hooks.slack.com/services/T/B/X', ev));
    const generic = JSON.stringify(shapePayload('https://example.com/hook', ev));
    assert.ok(!slack.includes(SENTINEL) && !generic.includes(SENTINEL), 'webhook payloads value-free');
  }

  // The DB file itself (flushed + checkpointed) never contains the value.
  history._flushForTest();
  history.close();
  const dbBytes = fs.readFileSync(dbPath, 'latin1');
  assert.ok(!dbBytes.includes(SENTINEL), 'history.db contains no raw env value');
  assert.ok(dbBytes.includes('SECRET_ONE'), 'sanity: key names ARE in the db (snapshot was recorded)');
  const walPath = dbPath + '-wal';
  if (fs.existsSync(walPath)) {
    assert.ok(!fs.readFileSync(walPath, 'latin1').includes(SENTINEL), 'wal contains no raw env value');
  }
});

// M111 (v1.4): redaction extends to export bundles — a full exercise (env-file
// fixture spawned, errors + tests seeded) must produce bundles free of the
// seeded value AND the personal email in ALL THREE formats.
test('REDACTION SUITE (M111): export bundles carry no env value and no personal email — json, md, csv', async () => {
  const { buildExport, renderExportMd, renderExportCsv } = await import('../dist/export.js');
  const root = fs.mkdtempSync(path.join(tmp, 'redact-export-'));
  fs.writeFileSync(path.join(root, '.env'), `SECRET_ONE=${SENTINEL}\nPASSWORD=${SENTINEL}2\n`);
  const dbPath = path.join(tmp, 'redact-export.db');
  const cfg = baseCfg({ history: { enabled: true, path: dbPath, retentionDays: 7 } });
  const reg = new Registry(cfg, [quietApp('sealed', root, { serverProfile: 'vite' })]);
  const history = new History(cfg.history);
  reg.setHistory(history);

  await spawnOnce(reg, 'sealed');
  fs.writeFileSync(path.join(root, '.env'), `SECRET_ONE=${SENTINEL}-v2\nPASSWORD=${SENTINEL}2\n`);
  await spawnOnce(reg, 'sealed');
  // Seed live errors + a test run so every bundle section has real content.
  reg.getState('sealed').errors.set('e', {
    message: 'ERROR boom in service', count: 1, firstSeen: Date.now() - 1000, lastSeen: Date.now(), level: 'error',
  });
  history.recordTestRun({ app: 'sealed', ts: Date.now(), runner: 'vitest', durationMs: 50, total: 2, passed: 1, failed: 1, skipped: 0, exitCode: 1, gitHead: null }, [
    { suite: 's', test: 't', file: 'f.ts', line: 1, message: 'assert failed', fingerprint: 'fpx' },
  ]);
  history._flushForTest();

  const bundle = buildExport({ registry: reg, history }, { since: Date.now() - 3600_000 });
  const personalEmail = 'yosi' + '@flycotech.com';
  for (const [fmt, text] of Object.entries({
    json: JSON.stringify(bundle),
    md: renderExportMd(bundle),
    csv: renderExportCsv(bundle),
  })) {
    assert.ok(!text.includes(SENTINEL), `${fmt} bundle leaked a raw env value`);
    assert.ok(!text.toLowerCase().includes(personalEmail), `${fmt} bundle leaked the personal email`);
  }
  // Sanity: the exercise really produced env-bearing content (key names OK).
  assert.ok(JSON.stringify(bundle).includes('SECRET_ONE') || JSON.stringify(bundle).includes('envChanged') || bundle.sections.report.sections.env, 'env data flowed through the bundle');
  history.close();
});
