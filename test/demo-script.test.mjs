import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// M114: the demo script (scripts/demo/run-demo.mjs) is what a screencast
// runs against — a real daemon under a throwaway DAIMON_HOME, driven by
// dist/cli.js. This test proves three things: it exits 0, its transcript
// contains the markers a viewer/reader would look for, and — the one that
// matters most — it never touches the REAL ~/.daimon, only its own temp
// dirs. Same isolation discipline as test/lifecycle-torture.test.mjs.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoScript = path.join(repoRoot, 'scripts', 'demo', 'run-demo.mjs');

const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-demo-probe-'));
const prevHome = process.env.DAIMON_HOME;
process.env.DAIMON_HOME = probeHome;
const { lockPath, isPidAlive } = await import('../dist/daemon.js');
const isolated = lockPath().startsWith(probeHome);
process.env.DAIMON_HOME = prevHome;

// isPidAlive is a pure pid check (no DAIMON_HOME dependency) — safe to reuse
// against the REAL lock file to detect a daemon already running on this
// machine outside this test's control (e.g. dogfooded during interactive
// development, or another agent's session). When one is live, its own
// history.db-wal/notifications.log/session-state.json mutate on their own
// clock regardless of anything this test does, so an exact mtime/size
// snapshot would be flaky for reasons that have nothing to do with the demo
// script — verified empirically: a real daemon here rewrites
// session-state.json (and its .bak) every few seconds with zero paths
// added/removed. Fall back to a structural check (no paths added/removed)
// in that case; use the strict exact-snapshot check otherwise.
function hasLiveLock(realHome) {
  try {
    const raw = fs.readFileSync(path.join(realHome, 'daemon.lock'), 'utf8');
    const info = JSON.parse(raw);
    return typeof info?.pid === 'number' && isPidAlive(info.pid);
  } catch {
    return false;
  }
}

/**
 * Is something OTHER than this test writing to the real ~/.daimon right now?
 *
 * The lock file alone is not a reliable answer. Observed during v1.10: a real
 * daemon was live and appending to notifications.log while ~/.daimon/daemon.lock
 * did not exist at all (an unclean exit can leave the lock behind, and a
 * later daemon need not recreate it). The strict exact-snapshot check then ran
 * against a home that a background daemon was actively mutating, and failed for
 * a reason that had nothing to do with the demo.
 *
 * So rather than infer the confound, MEASURE it: snapshot the tree twice with a
 * pause between and see whether it moves on its own. A live writer is exactly
 * what that detects, whether or not it kept a lock file.
 */
async function isDaemonAnswering(realHome) {
  let apiPort = 4999;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(realHome, 'config.json'), 'utf8'));
    if (Number.isInteger(cfg?.apiPort)) apiPort = cfg.apiPort;
  } catch { /* default port */ }
  try {
    const ctrl = AbortSignal.timeout(1500);
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/signature`, { signal: ctrl });
    return r.ok;
  } catch {
    return false;
  }
}

async function hasForeignWriter(realHome, settleMs = 2500) {
  // Decisive signal first: a daemon answering on the real apiPort owns this
  // home and writes to it on its own clock, lock file or not.
  if (hasLiveLock(realHome)) return true;
  if (await isDaemonAnswering(realHome)) return true;
  // Fallback: watch the tree actually move. Catches a writer that is neither
  // locked nor listening (a shutting-down daemon flushing its last rows).
  const a = snapshotTree(realHome);
  await new Promise(r => setTimeout(r, settleMs));
  const b = snapshotTree(realHome);
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** Human-readable diff of two snapshots, for a failure message worth reading. */
function describeDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const lines = [];
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (!b) lines.push(`  + ${k}`);
    else if (!a) lines.push(`  - ${k}`);
    else if (b.mtimeMs !== a.mtimeMs || b.size !== a.size) {
      lines.push(`  ~ ${k} (size ${b.size} -> ${a.size})`);
    }
  }
  return lines.length ? lines.join('\n') : '  (no path-level differences)';
}

function snapshotTree(dir) {
  const map = {};
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        try {
          const st = fs.statSync(full);
          map[full] = { mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          // Unreadable entry (permissions, transient) — record as absent
          // rather than crash the probe; a real mutation still shows up as
          // a diff in the surrounding entries.
        }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return map;
}

function runDemo(timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [demoScript], {
      cwd: repoRoot,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    // Tree-kill on watchdog: a bare child.kill on Windows would orphan the
    // demo's daemon + fixture servers (the script's finally-cleanup never
    // runs under SIGKILL). tree-kill is a runtime dep of the daemon itself.
    const killer = setTimeout(() => {
      import('tree-kill').then(({ default: treeKill }) => treeKill(child.pid, 'SIGKILL', () => {}))
        .catch(() => { try { child.kill('SIGKILL'); } catch {} });
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

if (!isolated) {
  test('demo-script: DAIMON_HOME isolation is unavailable on this OS — skipping', () => {});
} else {
  test('demo-script: runs a full headless session, exits 0, never touches the real ~/.daimon', async () => {
    const realHome = path.join(os.homedir(), '.daimon');
    const liveBefore = await hasForeignWriter(realHome);
    const before = snapshotTree(realHome);

    const result = await runDemo(120_000);

    const after = snapshotTree(realHome);
    if (liveBefore) {
      const beforeKeys = new Set(Object.keys(before));
      const afterKeys = new Set(Object.keys(after));
      const added = [...afterKeys].filter(k => !beforeKeys.has(k));
      const removed = [...beforeKeys].filter(k => !afterKeys.has(k));
      assert.deepEqual(added, [], `demo run added files under the real ~/.daimon while a live daemon was already running (own state was excluded from the check): ${added.join(', ')}`);
      assert.deepEqual(removed, [], `demo run removed files under the real ~/.daimon while a live daemon was already running: ${removed.join(', ')}`);
    } else {
      assert.deepEqual(after, before, `real ~/.daimon was mutated by the demo run (no foreign writer was detected beforehand)\n--- changed paths ---\n${describeDiff(before, after)}\n--- stdout tail ---\n${result.stdout.slice(-1200)}\n--- stderr tail ---\n${result.stderr.slice(-1200)}`);
    }

    assert.equal(result.code, 0, `demo script exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);

    const out = result.stdout;
    assert.match(out, /\$ daimon list/, 'transcript shows `daimon list`');
    assert.match(out, /\$ daimon start demo-web/, 'transcript shows starting demo-web');
    assert.match(out, /\$ daimon start demo-broken/, 'transcript shows starting demo-broken');
    assert.match(out, /\$ daimon wait demo-web --until serving/, 'transcript shows waiting for demo-web');
    assert.match(out, /\$ daimon errors demo-broken/, 'transcript shows the errors call');
    assert.match(out, /ECONNREFUSED/, 'the seeded error surfaces in the errors output');
    assert.match(out, /\$ daimon report --md/, 'transcript shows the report call');
    assert.match(out, /\$ daimon export --format md/, 'transcript shows the export call');
    assert.match(out, /\$ daimon stop demo-web/, 'transcript shows stopping demo-web');
    assert.match(out, /\$ daimon daemon stop/, 'transcript shows the daemon shutdown');
    assert.match(out, /=== daimon demo complete ===/, 'transcript ends with the completion marker');

    const combined = out + result.stderr;
    assert.ok(!combined.includes('yosi@flycotech.com'), 'demo output never prints the private author email');
  });
}
