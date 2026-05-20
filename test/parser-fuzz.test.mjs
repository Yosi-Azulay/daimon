import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../dist/parser.js';

function freshState() {
  return {
    name: 'fuzz', status: 'compiling', port: null, pid: null, startedAt: Date.now(),
    compileStartedAt: Date.now(), lastCompileMs: null, lastCompileAt: null, logBuffer: [],
    errors: new Map(), compileHistory: [], health: 'unknown', lastHealthAt: null,
    cpu: null, memMB: null, restartAttempts: 0, restartWindowStart: null, nextRestartAt: null,
    tags: [], announcedUrl: null, lastHealthError: null, cachedProbeHost: null,
    lastLogTs: null, stale: false, bundle: null, bundleRegressionPct: null,
    activeEnvFile: null, sessionOverrides: null, dependsOn: [],
    workspaceLabel: null, lastErrorHash: null,
  };
}

// Deterministic mulberry32.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'error TS2322: ', '\x1b[31m', '\x1b[0m', '\x1b[1;33m',
  '✘', '●', '   File "x/y/z.py", line ', 'Cannot find module ',
  'TypeError: ', '/path/to/file.ts:42:10', 'src/app.rb:14:in ',
  'panic: nil pointer dereference', '   at handler (D:\\\\app\\\\index.ts:1:1)',
  'thread \'main\' panicked at', '🚀', '\u{1F4A5}', '\u{200D}', '\udc00',
  ' ', '\r', '\n', '<<<<<<<< merge conflict', '====================',
];

function buildLine(rand) {
  const n = 1 + Math.floor(rand() * 8);
  let s = '';
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)];
  // Cap line length to keep regex matching fast (the parser's hot regexes are not
  // engineered for unbounded backtracking on multi-MB inputs).
  return s.length > 1024 ? s.slice(0, 1024) : s;
}

test('parseLine — 2k random lines, no exceptions, bounded total time', () => {
  const state = freshState();
  const rand = rng(0xc0ffee);
  const N = 2000;
  const slow = [];
  const start = performance.now();
  for (let i = 0; i < N; i++) {
    const line = buildLine(rand);
    const t0 = performance.now();
    let result;
    try {
      result = parseLine(state, line);
    } catch (err) {
      assert.fail(`parseLine threw on iteration ${i}: ${err?.message ?? err} (line=${JSON.stringify(line.slice(0, 80))})`);
    }
    const dt = performance.now() - t0;
    if (dt > 10) slow.push(dt);
    assert.ok(result === null || typeof result === 'object', `iteration ${i} returned ${typeof result}`);
  }
  const totalMs = performance.now() - start;
  // Slow-tail bound: <2% of iterations may exceed 10ms (covers cold-start and GC jitter).
  assert.ok(slow.length < N / 50, `>2% of iterations took >10ms (${slow.length}/${N})`);
  // 2k random lines should never take more than 10s on any sane host.
  assert.ok(totalMs < 10000, `parser took ${totalMs.toFixed(0)}ms for ${N} lines (>10s)`);
  // Error map size must be bounded by the number of distinct hashes seen.
  assert.ok(state.errors.size <= N, `error map grew past N entries (${state.errors.size})`);
});

test('parseLine — empty + whitespace + ANSI-only input is null-safe', () => {
  const state = freshState();
  for (const line of ['', ' ', '\t', '\x1b[31m\x1b[0m', '\n\r\n']) {
    const r = parseLine(state, line);
    assert.ok(r === null || typeof r === 'object');
  }
});

test('parseLine — partial unicode and lone surrogate handled', () => {
  const state = freshState();
  // \udc00 is a lone low surrogate. \ud800 alone is a lone high surrogate. Combined they
  // form a valid pair, but lone surrogates appearing mid-line have crashed regex engines
  // in the past; parseLine must tolerate them.
  for (const line of ['\udc00 error TS9999: bad surrogate', 'prefix \ud800 trailing', '✘ \udc00 \udc00 oops']) {
    const r = parseLine(state, line);
    assert.ok(r === null || typeof r === 'object');
  }
});
