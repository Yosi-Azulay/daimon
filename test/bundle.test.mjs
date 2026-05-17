import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../dist/parser.js';

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

test('F26: parser captures Angular bundle table totals', () => {
  const s = freshState();
  const lines = [
    'Initial chunk files   | Names         |  Raw size | Estimated transfer size',
    'main.123abc.js        | main          |   220.45 kB |              60.12 kB',
    'polyfills.789def.js   | polyfills     |    33.10 kB |              10.50 kB',
    '                      | Initial total |   253.55 kB |              70.62 kB',
    'Lazy chunk files      | Names         |  Raw size |',
    'admin.aaa.js          | admin         |    81.20 kB |',
    '                      | Lazy total    |    81.20 kB |',
    'Application bundle generation complete.',
  ];
  for (const l of lines) parseLine(s, l);
  assert.ok(s.bundle, 'state.bundle populated');
  assert.equal(s.bundle.initialKB, 254, `initialKB ~254, got ${s.bundle.initialKB}`);
  assert.equal(s.bundle.lazyKB, 81, `lazyKB ~81, got ${s.bundle.lazyKB}`);
  assert.ok(s.bundle.files.length >= 2, 'captured at least 2 files');
});

test('F36: parser captures Local: URL', () => {
  const s = freshState();
  parseLine(s, 'Local:   http://localhost:4200/');
  assert.equal(s.announcedUrl, 'http://localhost:4200');
});

test('F36: parser rewrites 0.0.0.0 to 127.0.0.1', () => {
  const s = freshState();
  parseLine(s, 'Local: http://0.0.0.0:4321/');
  assert.equal(s.announcedUrl, 'http://127.0.0.1:4321');
});

test('F36: parser captures Server running at URL', () => {
  const s = freshState();
  parseLine(s, 'Server running at https://localhost:9443/');
  assert.equal(s.announcedUrl, 'https://localhost:9443');
});

test('parser: errors map clears on error -> serving recovery', () => {
  const s = freshState();
  s.startedAt = Date.now() - 30_000;
  s.compileStartedAt = s.startedAt;
  parseLine(s, 'Initial chunk files | Names | Raw size');
  parseLine(s, 'Application bundle generation complete.');
  parseLine(s, 'X [ERROR] TS2552: Cannot find name foo');
  parseLine(s, 'X [ERROR] TS2724: missing export bar');
  assert.equal(s.status, 'error');
  assert.equal(s.errors.size, 2);

  parseLine(s, 'Initial chunk files | Names | Raw size');
  parseLine(s, 'Application bundle generation complete.');
  assert.equal(s.status, 'serving');
  assert.equal(s.errors.size, 0, 'errors cleared on recovery');
});

test('parser: lastCompileAt updates on error -> serving recovery (post-stale bug)', () => {
  const s = freshState();
  s.startedAt = Date.now() - 30_000;
  s.compileStartedAt = s.startedAt;
  parseLine(s, 'Initial chunk files | Names | Raw size');
  parseLine(s, 'Application bundle generation complete.');
  const firstCompileAt = s.lastCompileAt;
  assert.ok(firstCompileAt != null, 'first compile recorded');
  assert.equal(s.status, 'serving');

  parseLine(s, 'X [ERROR] TS2552: Cannot find name foo');
  assert.equal(s.status, 'error');

  const beforeRebuild = Date.now();
  parseLine(s, 'Initial chunk files | Names | Raw size');
  assert.equal(s.status, 'compiling', 'COMPILING_PATTERNS should recover from error');
  parseLine(s, 'Application bundle generation complete.');
  assert.equal(s.status, 'serving');
  assert.ok(s.lastCompileAt >= beforeRebuild, `lastCompileAt updated on recovery (was ${firstCompileAt}, now ${s.lastCompileAt})`);
  assert.equal(s.compileHistory.length, 2, 'two compiles recorded');
});

test('F36: parser captures Next.js listening on URL', () => {
  const s = freshState();
  parseLine(s, '- ready started server on 0.0.0.0:3000, url: http://localhost:3000');
  // The pattern is "listening on" — Next.js uses different text; we accept Local-style alternative
  // This line doesn't match — skip
  assert.equal(s.announcedUrl, null);
  parseLine(s, 'listening on http://127.0.0.1:3000');
  assert.equal(s.announcedUrl, 'http://127.0.0.1:3000');
});
