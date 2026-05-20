import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../dist/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures', 'parsers');

function freshState() {
  return {
    name: 'x', status: 'compiling', port: null, pid: null, startedAt: Date.now(),
    compileStartedAt: Date.now(), lastCompileMs: null, lastCompileAt: null, logBuffer: [],
    errors: new Map(), compileHistory: [], health: 'unknown', lastHealthAt: null, cpu: null, memMB: null,
    restartAttempts: 0, restartWindowStart: null, nextRestartAt: null, tags: [],
    announcedUrl: null, lastHealthError: null, cachedProbeHost: null, lastLogTs: null,
    stale: false, bundle: null, bundleRegressionPct: null, activeEnvFile: null,
    sessionOverrides: null, dependsOn: [],
  };
}

function runFixture(name) {
  const logPath = path.join(fixturesDir, `${name}.log`);
  const expPath = path.join(fixturesDir, `${name}.expected.json`);
  const log = fs.readFileSync(logPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  const state = freshState();
  for (const line of log.split(/\r?\n/)) parseLine(state, line);
  const collected = [...state.errors.values()].map(e => e.parsed ?? { message: e.message });
  return { state, collected, expected };
}

function pick(e) {
  const o = {};
  if (e.file !== undefined) o.file = e.file;
  if (e.line !== undefined) o.line = e.line;
  if (e.col !== undefined) o.col = e.col;
  if (e.code !== undefined) o.code = e.code;
  return o;
}

function matches(actual, want) {
  if (want.file !== undefined && actual.file !== want.file) return false;
  if (want.line !== undefined && actual.line !== want.line) return false;
  if (want.col !== undefined && actual.col !== want.col) return false;
  if (want.code !== undefined && actual.code !== want.code) return false;
  return true;
}

const FIXTURES = ['angular-esbuild', 'vite', 'storybook', 'jest', 'nx', 'webpack', 'node', 'django', 'rails', 'fastapi', 'go-air', 'rust-trunk'];

for (const name of FIXTURES) {
  test(`parser corpus: ${name}`, () => {
    const { state, collected, expected } = runFixture(name);

    let hits = 0;
    const misses = [];
    for (const want of expected.errors) {
      const ok = collected.some(actual => matches(actual, want));
      if (ok) hits++;
      else misses.push(want);
    }
    const rate = hits / expected.errors.length;
    assert.ok(
      rate >= 0.95,
      `[${name}] capture rate ${(rate * 100).toFixed(0)}% < 95%; missed: ${JSON.stringify(misses)}\ncollected: ${JSON.stringify(collected.map(pick))}`,
    );

    if (expected.status) {
      assert.equal(state.status, expected.status, `[${name}] status mismatch`);
    }
    if (expected.tool) {
      const withTool = collected.filter(e => e.tool === expected.tool);
      assert.ok(
        withTool.length > 0,
        `[${name}] no errors tagged tool='${expected.tool}' (got: ${JSON.stringify(collected.map(e => e.tool))})`,
      );
    }
  });
}

test('parser corpus: angular-esbuild has zero capture regressions on its 3 known errors', () => {
  const { collected } = runFixture('angular-esbuild');
  const withFile = collected.filter(e => e.file && e.line && e.col);
  assert.ok(withFile.length >= 3, `expected 3 file-bearing errors; got ${withFile.length}`);
});
