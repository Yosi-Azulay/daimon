// M170 (v1.14) — QUICKSTART.md is executable documentation.
//
// Every ```bash block on the page is run AS WRITTEN against a clean
// DAIMON_HOME, in page order, so the five-minute path cannot rot. A block is
// exempt only via an explicit `<!-- quickstart:skip <reason> -->` marker, and
// this suite asserts the exemption list stays small and reasoned.
//
// Markers understood:
//   quickstart:skip <reason>   not executed (reason is required and shown)
//   quickstart:config          a json block: validated, then written as the
//                              fixture's daimon.config.json
//   quickstart:fresh           run in a pristine workspace copy (no config) —
//                              for the `daimon init` alternative path
//   quickstart:exit 0,1 <why>  allowed exit codes for that block
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(repoRoot, 'dist', 'cli.js');
const DOC = path.join(repoRoot, 'QUICKSTART.md');
// A fresh port per run, never a fixed one. This gate starts a REAL daemon, and
// a fixed port is a trap twice over: two copies of the file collide (the
// standing ports.test.mjs gotcha), and a daemon orphaned by an earlier failed
// run squats the port forever — its DAIMON_HOME is deleted, so no `daimon
// daemon stop` can ever reach it again. 45000-45899 is outside every other
// suite's range.
const API_PORT = String(45000 + Math.floor(Math.random() * 900));

function parseBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let markers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^<!--\s*quickstart:(\S+)\s*(.*?)\s*-->$/.exec(lines[i].trim());
    if (m) { markers.push({ kind: m[1], rest: m[2] }); continue; }
    const fence = /^```(\w*)\s*$/.exec(lines[i]);
    if (!fence) {
      if (lines[i].trim() === '') continue; // blank lines don't clear markers
      markers = [];                          // prose does
      continue;
    }
    const lang = fence[1];
    const body = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
    blocks.push({ lang, body, markers, line: i + 1 });
    markers = [];
  }
  return blocks;
}

function makeWorkspace(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  // A real (tiny) dev server so `daimon start` has something to spawn.
  const server =
    "require('http').createServer((q,s)=>s.end('ok'))" +
    ".listen(process.env.PORT||3000,()=>console.log('Local: http://localhost:'+(process.env.PORT||3000)))";
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, private: true, scripts: { dev: `node -e "${server}"` } }, null, 2) + '\n',
  );
  return dir;
}

test('QUICKSTART.md commands execute as written on a clean DAIMON_HOME', { timeout: 180_000 }, async t => {
  assert.ok(fs.existsSync(CLI), 'run `npm run build` first — the quickstart gate runs the compiled CLI');
  const md = fs.readFileSync(DOC, 'utf8');
  const blocks = parseBlocks(md);

  const bash = blocks.filter(b => b.lang === 'bash');
  assert.ok(bash.length >= 8, `expected the five-minute path to be at least 8 blocks, saw ${bash.length}`);

  const skipped = bash.filter(b => b.markers.some(m => m.kind === 'skip'));
  assert.ok(skipped.length <= 2, `only install/browser blocks may be exempt; saw ${skipped.length}`);
  for (const b of skipped) {
    const reason = b.markers.find(m => m.kind === 'skip').rest;
    assert.ok(reason.length > 10, `every skip needs a stated reason (block at line ${b.line})`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-qs-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-qs-home-'));
  const main = makeWorkspace(root, 'hello-web');
  const fresh = makeWorkspace(root, 'fresh-hello-web');
  const env = { ...process.env, DAIMON_HOME: home, DAIMON_PORT: API_PORT, NO_COLOR: '1' };

  const once = (line, cwd) => {
    // `daimon` on PATH is the published binary; here it is the build under test.
    const argv = line.replace(/^daimon\s+/, '').trim();
    return spawnSync(process.execPath, [CLI, ...argv.split(/\s+/)], {
      cwd, env, encoding: 'utf8', timeout: 90_000,
    });
  };

  // This gate spawns a REAL daemon and a REAL dev server, so it is the one
  // file in the suite whose commands can lose a race against a saturated
  // machine — `daemon start` gives up after a fixed 5s, and 40 parallel test
  // processes can push a cold boot past it. One retry after a pause absorbs
  // that without hiding anything: a command that is genuinely broken fails
  // twice, and every retry is reported as a diagnostic rather than swallowed.
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  // Did the daemon come up, regardless of how long the CLI was willing to wait?
  const daemonUp = cwd => {
    const st = once('daimon daemon status', cwd);
    return st.status === 0 && /"running"\s*:\s*true/.test(st.stdout);
  };

  // Retries are allowed for exactly ONE command and one reason.
  //
  // `daimon daemon start` gives up after a fixed 5s window; this file used to
  // run beside ~40 parallel test processes and a cold boot could miss that
  // window while still succeeding a moment later. That is the only tolerated
  // flake, and it is resolved by asserting on STATE (did the daemon come up?)
  // rather than on the stopwatch.
  //
  // Every other command is asserted on its FIRST result. A blanket retry would
  // be wrong for state-mutating verbs: a `start` that fails and then succeeds
  // because the first attempt already half-started the app is indistinguishable
  // from contention, so retrying would hide a real ordering bug.
  const run = (line, cwd, allowed) => {
    const r = once(line, cwd);
    if (!allowed.includes(r.status) && /^daimon daemon start/.test(line)) {
      for (let i = 0; i < 25; i++) {
        if (daemonUp(cwd)) {
          t.diagnostic(`\`${line}\` exceeded its 5s window but the daemon came up (machine contention)`);
          return r; // the documented command achieved its documented effect
        }
        sleep(1000);
      }
    }
    assert.ok(
      allowed.includes(r.status),
      `\`${line}\` exited ${r.status} (allowed: ${allowed.join(',')})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    return r;
  };

  try {
    // The one json block on the page is the documented minimum config: it must
    // validate under the daemon's own loader, and it becomes the fixture's.
    const cfgBlock = blocks.find(b => b.markers.some(m => m.kind === 'config'));
    assert.ok(cfgBlock, 'QUICKSTART must show a config block marked quickstart:config');
    const { validateConfig } = await import('../dist/config.js');
    const raw = JSON.parse(cfgBlock.body.join('\n'));
    const validated = validateConfig(raw, 'QUICKSTART.md');
    assert.deepEqual(raw.searchRoots, ['.'], 'the documented minimum config scans cwd');
    assert.ok(Array.isArray(validated.portRange) && validated.portRange.length === 2);
    fs.writeFileSync(path.join(main, 'daimon.config.json'), JSON.stringify(raw, null, 2) + '\n');

    let ran = 0;
    for (const b of bash) {
      if (b.markers.some(m => m.kind === 'skip')) continue;
      const exitMarker = b.markers.find(m => m.kind === 'exit');
      const allowed = exitMarker
        ? exitMarker.rest.split(/\s+/)[0].split(',').map(Number)
        : [0];
      const cwd = b.markers.some(m => m.kind === 'fresh') ? fresh : main;
      for (const line of b.body.map(l => l.trim()).filter(Boolean)) {
        assert.match(line, /^daimon\s/, `every executed line must be a daimon command: ${line}`);
        run(line, cwd, allowed);
        ran++;
      }
    }
    t.diagnostic(`quickstart: executed ${ran} commands, skipped ${skipped.length} blocks`);
    assert.ok(ran >= 8, `expected the documented path to be at least 8 commands, ran ${ran}`);

    // The optional `daimon init` shortcut really produced a config, in the
    // fresh workspace only.
    const freshCfg = path.join(fresh, 'daimon.config.json');
    assert.ok(fs.existsSync(freshCfg), '`daimon init --yes` must write daimon.config.json');
    const written = JSON.parse(fs.readFileSync(freshCfg, 'utf8'));
    assert.equal(written.searchRoots.length, 1);
  } finally {
    spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { cwd: main, env, encoding: 'utf8', timeout: 30_000 });

    // Then make sure it is ACTUALLY gone. `daemon stop` can miss (it needs the
    // lock file and a responsive daemon), and once DAIMON_HOME is deleted no
    // CLI can ever reach that daemon again — it would hold its port and
    // outlive the whole suite. So the authority here is the PORT, not the lock
    // file: ask whoever is listening who they are, and only kill a process
    // that answers as the daimon this test started (verify-then-kill, M81).
    const askPort = () => {
      const probe = spawnSync(process.execPath, ['-e',
        `fetch('http://127.0.0.1:${API_PORT}/api/signature')` +
        `.then(r=>r.json()).then(j=>process.stdout.write(j&&j.daimon?String(j.pid):''))` +
        `.catch(()=>{})`,
      ], { encoding: 'utf8', timeout: 10_000 });
      const pid = Number(probe.stdout.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    };
    for (let i = 0; i < 5; i++) {
      const pid = askPort();
      if (!pid) break;                       // nobody home — the normal path
      if (pid === process.pid) break;        // paranoia: never signal ourselves
      // TREE-kill: QUICKSTART step 6 starts a real dev server, so the daemon
      // has children. A bare `process.kill(pid)` reaps only the daemon and
      // orphans the dev server, which then holds a port out of the documented
      // 4200-4299 range that other suites use — and DAIMON_HOME is deleted a
      // few lines below, so nothing could ever find it again. tree-kill is
      // already a dependency and handles the Windows/POSIX split for us; it is
      // callback-based, so it runs in a child we can wait on synchronously.
      spawnSync(process.execPath, ['-e',
        `require('tree-kill')(${pid}, 'SIGKILL', () => process.exit(0));`,
      ], { cwd: repoRoot, encoding: 'utf8', timeout: 20_000 });
      try { process.kill(pid); } catch {}
      t.diagnostic(`quickstart: force-stopped leftover daemon pid ${pid} on :${API_PORT}`);
      sleep(500);
    }

    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('QUICKSTART.md keeps the promises the release makes about it', () => {
  const md = fs.readFileSync(DOC, 'utf8');
  assert.ok(!md.includes('yosi@flycotech.com'), 'no personal email in published docs');
  // The locked decision: the hand-written config is documented BEFORE the wizard.
  assert.ok(md.indexOf('daimon.config.json') < md.indexOf('daimon init'), 'hand-written config comes first');
  assert.match(md, /daimon doctor/, 'the support path is on the page');
  assert.match(md, /127\.0\.0\.1|loopback/i, 'the local-only posture is stated');
});

test('README leads with the first-run path', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const firstScreen = readme.slice(0, 3500);
  assert.match(firstScreen, /npm i -g daimon/, 'install is on the first screen');
  assert.match(firstScreen, /QUICKSTART/, 'the first screen points at QUICKSTART.md');
});
