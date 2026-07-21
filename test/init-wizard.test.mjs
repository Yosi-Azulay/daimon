// M168 (v1.14) — `daimon init` is a UI over the real discovery scan.
//
// The two things this suite exists to protect: init proposes exactly what
// discovery reports (no forked marker list), and init never eats a config the
// user already wrote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const { buildProposal, proposalToConfig, runInit, runInitAuto, runInitYes, explainEmpty, CONFIG_FILENAME } =
  await import('../dist/init.js');
const { discoverApps } = await import('../dist/discovery.js');
const { validateConfig } = await import('../dist/config.js');

function tmpdir(prefix = 'daimon-init-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function viteWorkspace(name = 'my-vite-app') {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, scripts: { dev: 'vite' }, devDependencies: { vite: '^6.0.0' } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'vite.config.ts'), 'export default {};\n');
  return dir;
}

function emptyWorkspace() {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'nothing to see here\n');
  return dir;
}

// Every regular file under `dir`, relative + sorted — the filesystem sentinel.
function snapshotTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

// Drives the interactive wizard with a canned list of answers.
//
// Answers are fed ONE AT A TIME: readline drops lines that arrive while no
// question is pending, so writing them all upfront would consume the whole
// script on the first prompt. A prompt is an output chunk that does not end in
// a newline (every rendered line does).
function scriptedIo(answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  const queue = [...answers];
  let seen = '';
  output.on('data', c => {
    const s = c.toString();
    seen += s;
    if (!s.endsWith('\n') && queue.length) {
      const next = queue.shift();
      setImmediate(() => input.write(next + '\n'));
    }
  });
  return { input, output, transcript: () => seen };
}

test('proposal matches what the real discovery scan reports (no forked marker list)', () => {
  const dir = viteWorkspace();
  const p = buildProposal({ cwd: dir });

  const direct = discoverApps({ searchRoots: p.searchRoots, frameworks: [], overrides: {}, tags: {} }, { warnings: [] });
  assert.deepEqual(
    p.apps.map(a => a.name).sort(),
    direct.map(a => a.name).sort(),
    'init must propose exactly the apps discoverApps finds',
  );
  assert.equal(p.apps.length, 1);
  assert.equal(p.apps[0].profile, 'vite');
  assert.ok(p.apps[0].command.includes('vite'), `command should come from the profile: ${p.apps[0].command}`);
  // The searchRoot is labelled from package.json name.
  assert.deepEqual(p.searchRoots, [{ path: dir, label: 'my-vite-app' }]);
});

test('a framework with no hard-coded marker in the old wizard is still detected', () => {
  // django: the deleted MARKERS list knew nothing about it; discovery does.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'manage.py'), '#!/usr/bin/env python\nimport django\n');
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'Django==5.0\n');
  const p = buildProposal({ cwd: dir });
  assert.equal(p.apps.length, 1, JSON.stringify(p.apps));
  assert.equal(p.apps[0].profile, 'django');
});

test('--yes writes a config the daemon validates cleanly', async () => {
  const dir = viteWorkspace();
  const r = await runInitYes({ cwd: dir });
  assert.equal(r.yes, true);
  assert.equal(r.path, path.join(dir, CONFIG_FILENAME));

  const raw = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  const cfg = validateConfig(raw, r.path);
  assert.equal(cfg.apiPort, 4999);
  assert.deepEqual(cfg.portRange, [4200, 4299]);
  assert.equal(cfg.searchRoots.length, 1);
  // And the daemon's scan over that config finds the app init promised.
  const apps = discoverApps(cfg, { warnings: [] });
  assert.deepEqual(apps.map(a => a.name), r.proposal.apps.map(a => a.name));
});

test('--yes refuses to overwrite an existing config and leaves it byte-identical', async () => {
  const dir = viteWorkspace();
  const target = path.join(dir, CONFIG_FILENAME);
  const original = '{\n  "searchRoots": ["C:/hand/written"],\n  "apiPort": 4321\n}\n';
  fs.writeFileSync(target, original, 'utf8');
  const before = fs.statSync(target);

  await assert.rejects(() => runInitYes({ cwd: dir }), /refusing to overwrite/);

  const after = fs.statSync(target);
  assert.equal(fs.readFileSync(target, 'utf8'), original, 'config content must be untouched');
  assert.equal(after.mtimeMs, before.mtimeMs, 'config mtime must be untouched');
});

test('the refusal names the file and both remedies', async () => {
  const dir = viteWorkspace();
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), '{}\n', 'utf8');
  const err = await runInitYes({ cwd: dir }).then(() => null, e => e);
  assert.ok(err, 'expected a refusal');
  assert.ok(err.message.includes(CONFIG_FILENAME), 'names the file');
  assert.ok(err.message.includes('--force'), 'names the overwrite remedy');
  assert.ok(err.message.includes('daimon init'), 'names the interactive path');
});

test('--force overwrites deliberately (legacy meaning preserved)', async () => {
  const dir = viteWorkspace();
  const target = path.join(dir, CONFIG_FILENAME);
  fs.writeFileSync(target, '{"searchRoots":[]}\n', 'utf8');
  const r = await runInitYes({ cwd: dir, force: true });
  assert.equal(r.path, target);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).searchRoots.length, 1);
});

test('interactive decline on an existing config leaves the file byte-identical', async () => {
  const dir = viteWorkspace();
  const target = path.join(dir, CONFIG_FILENAME);
  const original = '{\n  "searchRoots": [],\n  "apiPort": 4998\n}\n';
  fs.writeFileSync(target, original, 'utf8');
  const before = fs.statSync(target);

  const io = scriptedIo(['n']);
  const r = await runInit({ cwd: dir, input: io.input, output: io.output });

  assert.equal(r.cancelled, true);
  assert.equal(r.config, null);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
  assert.match(io.transcript(), /nothing was written/);
});

test('interactive accept writes the proposal and prints next-step hints, starting nothing', async () => {
  const dir = viteWorkspace();
  const io = scriptedIo(['y', '', '']); // confirm, default port range, default apiPort
  const r = await runInit({ cwd: dir, input: io.input, output: io.output });

  assert.equal(r.cancelled, undefined);
  assert.ok(fs.existsSync(r.path));
  const t = io.transcript();
  assert.match(t, /daimon daemon start/, 'points at the next command');
  assert.match(t, /daimon claude install/, 'points at the optional integration');
  assert.equal(r.installClaude, false, 'init never installs anything');
});

test('interactive accepts custom port range and apiPort', async () => {
  const dir = viteWorkspace();
  const io = scriptedIo(['y', '5100-5199', '4777']);
  const r = await runInit({ cwd: dir, input: io.input, output: io.output });
  const cfg = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.deepEqual(cfg.portRange, [5100, 5199]);
  assert.equal(cfg.apiPort, 4777);
});

test('a directory with no framework markers still succeeds and explains why', async () => {
  const dir = emptyWorkspace();
  const p = buildProposal({ cwd: dir });
  assert.equal(p.apps.length, 0);
  const reasons = explainEmpty(p);
  assert.ok(reasons.length > 0);
  assert.ok(reasons.some(r => r.includes('daimon frameworks')), 'points at the registry: ' + reasons.join(' | '));

  const r = await runInitYes({ cwd: dir });
  assert.ok(fs.existsSync(r.path), 'a zero-detection run still writes a usable config');
  const cfg = validateConfig(JSON.parse(fs.readFileSync(r.path, 'utf8')), r.path);
  assert.equal(cfg.searchRoots.length, 1, 'searchRoot is still cwd so the user can add apps by hand');
});

test('init writes EXACTLY ONE file and touches nothing else', async () => {
  const dir = viteWorkspace();
  // Own the state dir for this assertion rather than depending on the runner
  // to have set one. The previous version guarded the ~/.daimon check behind
  // `if (process.env.DAIMON_HOME)`, which npm test never sets — so the branch
  // was DEAD: a regression to writing state files would have passed here and
  // polluted the developer's real ~/.daimon. That is the silent-gate pattern
  // M142 banned; never guard an assertion on optional env.
  const home = tmpdir('daimon-init-home-');
  const prevHome = process.env.DAIMON_HOME;
  process.env.DAIMON_HOME = home;
  try {
    const before = snapshotTree(dir);
    const homeBefore = snapshotTree(home);

    await runInitYes({ cwd: dir });

    const after = snapshotTree(dir);
    const added = after.filter(f => !before.includes(f));
    assert.deepEqual(added, [CONFIG_FILENAME], 'exactly one new file: ' + JSON.stringify(added));
    assert.deepEqual(after.filter(f => before.includes(f)).sort(), before, 'no file removed');
    assert.deepEqual(snapshotTree(home), homeBefore, 'the runInit module must not touch the state dir');
  } finally {
    if (prevHome === undefined) delete process.env.DAIMON_HOME; else process.env.DAIMON_HOME = prevHome;
  }
});

test('--auto keeps its legacy result shape, now discovery-driven', async () => {
  const dir = viteWorkspace();
  const r = await runInitAuto({ cwd: dir });
  assert.equal(r.auto, true);
  assert.equal(r.installClaude, false);
  assert.equal(typeof r.path, 'string');
  assert.deepEqual(Object.keys(r.config).sort(), ['apiPort', 'portRange', 'searchRoots']);
  assert.equal(r.proposal.apps.length, 1, '--auto now sees what discovery sees');
});

test('--auto refuses an existing config without --force (legacy message preserved)', async () => {
  const dir = viteWorkspace();
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), '{}\n', 'utf8');
  await assert.rejects(() => runInitAuto({ cwd: dir }), /pass --force to overwrite/);
});

test('proposalToConfig is minimal — no invented keys', () => {
  const dir = viteWorkspace();
  const cfg = proposalToConfig(buildProposal({ cwd: dir }));
  assert.deepEqual(Object.keys(cfg).sort(), ['apiPort', 'portRange', 'searchRoots']);
});

test('init never writes into ~/.daimon (the legacy wizard target is gone)', async () => {
  const src = fs.readFileSync(new URL('../dist/init.js', import.meta.url), 'utf8');
  assert.ok(!/daimonDir/.test(src), 'init.ts must not reference daimonDir — it writes cwd config only');
  assert.ok(!/config\.json['"]/.test(src.replace(/daimon\.config\.json/g, '')), 'no ~/.daimon/config.json target');
});

test('closed stdin cancels cleanly instead of hanging forever', async () => {
  const dir = viteWorkspace();
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = '';
  output.on('data', c => { seen += c.toString(); });
  input.end(); // EOF before any answer — `daimon init < /dev/null`

  const r = await runInit({ cwd: dir, input, output });
  assert.equal(r.cancelled, true);
  assert.ok(!fs.existsSync(path.join(dir, CONFIG_FILENAME)), 'EOF must never write a config');
  assert.match(seen, /--yes/, 'the message points at the non-interactive flag');
});

test('garbage port answers keep the defaults rather than writing an unloadable config', async () => {
  const dir = viteWorkspace();
  const io = scriptedIo(['y', 'not-a-range', '99999999']);
  const r = await runInit({ cwd: dir, input: io.input, output: io.output });
  const cfg = validateConfig(JSON.parse(fs.readFileSync(r.path, 'utf8')), r.path);
  assert.deepEqual(cfg.portRange, [4200, 4299], 'unparseable range falls back to the default');
  assert.equal(cfg.apiPort, 4999, 'out-of-range apiPort falls back to the default');
});

test('an inverted or out-of-range port range is rejected, not written', async () => {
  const dir = viteWorkspace();
  const io = scriptedIo(['y', '9000-100', '']);
  const r = await runInit({ cwd: dir, input: io.input, output: io.output });
  const cfg = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.deepEqual(cfg.portRange, [4200, 4299], 'hi < lo must not reach the config');
});

// A symlink at the config path used to defeat BOTH promises: existsSync
// follows links, so a dangling link read as "no config here" (no refusal, no
// overwrite prompt) and the write then landed on the link's target — outside
// cwd entirely. Decide on the path itself (lstat), never on what it points at.
function canSymlink(dir) {
  try {
    fs.writeFileSync(path.join(dir, '_t'), 'x');
    fs.symlinkSync(path.join(dir, '_t'), path.join(dir, '_l'));
    fs.rmSync(path.join(dir, '_l'), { force: true });
    fs.rmSync(path.join(dir, '_t'), { force: true });
    return true;
  } catch { return false; }
}

test('a DANGLING symlink at the config path is treated as occupied, not as empty', async t => {
  const dir = viteWorkspace();
  if (!canSymlink(dir)) return t.skip('symlink creation not permitted on this host');
  const victimDir = tmpdir('daimon-victim-');
  const victim = path.join(victimDir, 'not-created-yet.json');
  fs.symlinkSync(victim, path.join(dir, CONFIG_FILENAME));

  await assert.rejects(() => runInitYes({ cwd: dir }), /refusing/,
    '--yes must refuse: something occupies the config path');
  assert.ok(!fs.existsSync(victim), 'nothing may be written outside cwd');
});

test('a LIVE symlink is never written through, even with --force', async t => {
  const dir = viteWorkspace();
  if (!canSymlink(dir)) return t.skip('symlink creation not permitted on this host');
  const victimDir = tmpdir('daimon-victim-');
  const victim = path.join(victimDir, 'thesis.txt');
  const original = 'important user content\n'.repeat(20);
  fs.writeFileSync(victim, original, 'utf8');
  fs.symlinkSync(victim, path.join(dir, CONFIG_FILENAME));

  await assert.rejects(() => runInitYes({ cwd: dir, force: true }), /symlink/,
    '--force is consent to replace the config, not to truncate the link target');
  assert.equal(fs.readFileSync(victim, 'utf8'), original, 'the target file must be untouched');
});

test('the config write is atomic (tmp+rename), leaving no partial file behind', async () => {
  const dir = viteWorkspace();
  await runInitYes({ cwd: dir });
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `no temp files may survive: ${leftovers}`);
});
