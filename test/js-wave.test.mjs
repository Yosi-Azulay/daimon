import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// M66 — JS meta-framework wave, generic package.json fallback, monorepo
// enumerators (pnpm-workspace/turbo), package-manager awareness.

const { discoverApps } = await import('../dist/discovery.js');

function makeRoot(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-jswave-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function baseCfg(roots) {
  return {
    searchRoots: roots,
    portRange: [4200, 4300],
    apiPort: 6822,
    overrides: {},
    autoStart: [],
    profiles: {},
    tags: {},
    autoRestart: { enabled: false, maxAttempts: 3, windowMs: 60000 },
    healthProbe: { enabled: false, intervalMs: 5000, timeoutMs: 2000, path: '/' },
    logs: { enabled: false, dir: '', maxFiles: 5, maxBytesPerFile: 1024 * 1024 },
    depends: {},
    cascadeRestart: false,
    history: { enabled: false, path: '', retentionDays: 7 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 60000 },
    headless: true,
    envFiles: {},
    requestLog: { enabled: false, portOffset: 1000 },
    metrics: { enabled: false },
    editor: { scheme: 'vscode' },
    apiToken: null,
    output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } },
    dashboard: { theme: 'auto', density: 'comfortable' },
  };
}

const PKG = (extra = {}) => JSON.stringify({ name: 'x', version: '0.0.0', ...extra });

// --- the five meta-frameworks -------------------------------------------------

test('detects Next.js via next.config.js; package.json fallback stays quiet', () => {
  const root = makeRoot({
    'next.config.js': 'module.exports = {}\n',
    'package.json': PKG({ scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0' } }),
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1, `expected 1 app, got ${apps.map(a => a.serverProfile).join(', ')}`);
  assert.equal(apps[0].serverProfile, 'nextjs');
  assert.equal(apps[0].command, 'npx next dev');
});

test('detects Nuxt via nuxt.config.ts', () => {
  const root = makeRoot({ 'nuxt.config.ts': 'export default {}\n' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'nuxt');
  assert.equal(apps[0].command, 'npx nuxi dev');
});

test('detects SvelteKit via svelte.config.js + @sveltejs/kit dep; suppresses vite', () => {
  const root = makeRoot({
    'svelte.config.js': 'export default {}\n',
    'vite.config.ts': 'export default {}\n',
    'package.json': PKG({ devDependencies: { '@sveltejs/kit': '2.0.0', vite: '6.0.0' } }),
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'sveltekit');
  assert.equal(apps[0].command, 'npx vite dev');
});

test('plain svelte config without @sveltejs/kit stays a vite app', () => {
  const root = makeRoot({
    'svelte.config.js': 'export default {}\n',
    'vite.config.ts': 'export default {}\n',
    'package.json': PKG({ devDependencies: { svelte: '5.0.0', vite: '6.0.0' } }),
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'vite');
});

test('detects Astro via astro.config.mjs', () => {
  const root = makeRoot({ 'astro.config.mjs': 'export default {}\n' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'astro');
  assert.equal(apps[0].command, 'npx astro dev');
});

test('detects Remix/React Router via react-router.config.ts (and legacy remix.config.js)', () => {
  const modern = makeRoot({ 'react-router.config.ts': 'export default {}\n', 'vite.config.ts': 'export default {}\n' });
  const apps1 = discoverApps(baseCfg([modern]));
  assert.equal(apps1.length, 1);
  assert.equal(apps1[0].serverProfile, 'remix');

  const legacy = makeRoot({ 'remix.config.js': 'module.exports = {}\n' });
  const apps2 = discoverApps(baseCfg([legacy]));
  assert.equal(apps2[0].serverProfile, 'remix');
});

// --- generic package.json fallback ---------------------------------------------

test('bare package.json with a dev script is found by the fallback', () => {
  const root = makeRoot({ 'package.json': PKG({ scripts: { dev: 'node server.js' } }) });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].serverProfile, 'package-json');
  assert.equal(apps[0].command, 'npm run dev');
});

test('fallback script order is dev > serve > start', () => {
  const root = makeRoot({ 'package.json': PKG({ scripts: { start: 'node s.js', serve: 'node v.js' } }) });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps[0].command, 'npm run serve');
});

test('fallback rejection stats: superseded by named profile / no eligible script', () => {
  const named = makeRoot({
    'vite.config.ts': 'export default {}\n',
    'package.json': PKG({ scripts: { dev: 'vite' } }),
  });
  const stats1 = { scanned: 0, rejected: {} };
  const apps1 = discoverApps(baseCfg([named]), { stats: stats1 });
  assert.equal(apps1.length, 1);
  assert.equal(apps1[0].serverProfile, 'vite');
  assert.equal(stats1.rejected['fallback superseded by named profile'], 1);

  const noScript = makeRoot({ 'package.json': PKG({ scripts: { build: 'tsc' } }) });
  const stats2 = { scanned: 0, rejected: {} };
  const apps2 = discoverApps(baseCfg([noScript]), { stats: stats2 });
  assert.equal(apps2.length, 0);
  assert.equal(stats2.rejected['package.json has no dev/serve/start script'], 1);
});

test('fallback never fires inside node_modules', () => {
  const base = makeRoot({ 'node_modules/some-dep/package.json': PKG({ scripts: { dev: 'evil' } }) });
  const stats = { scanned: 0, rejected: {} };
  const apps = discoverApps(baseCfg([path.join(base, 'node_modules', 'some-dep')]), { stats });
  assert.equal(apps.length, 0);
  assert.equal(stats.rejected['fallback: inside node_modules'], 1);
});

// --- package-manager awareness ---------------------------------------------------

test('lockfile drives the fallback command: pnpm / yarn / bun', () => {
  const pnpm = makeRoot({ 'package.json': PKG({ scripts: { dev: 'x' } }), 'pnpm-lock.yaml': '' });
  assert.equal(discoverApps(baseCfg([pnpm]))[0].command, 'pnpm run dev');

  const yarn = makeRoot({ 'package.json': PKG({ scripts: { dev: 'x' } }), 'yarn.lock': '' });
  assert.equal(discoverApps(baseCfg([yarn]))[0].command, 'yarn dev');

  const bun = makeRoot({ 'package.json': PKG({ scripts: { dev: 'x' } }), 'bun.lockb': '' });
  assert.equal(discoverApps(baseCfg([bun]))[0].command, 'bun run dev');
});

test('lockfile drives meta-framework exec: pnpm exec next dev', () => {
  const root = makeRoot({ 'next.config.js': 'module.exports = {}\n', 'pnpm-lock.yaml': '' });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps[0].command, 'pnpm exec next dev');
});

// --- monorepo enumerators ---------------------------------------------------------

test('pnpm-workspace.yaml enumerates member packages with per-package detection', () => {
  const root = makeRoot({
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "!apps/excluded"\n',
    'pnpm-lock.yaml': '',
    'package.json': PKG({ scripts: { dev: 'turbo dev' } }),
    'apps/web/package.json': PKG({ scripts: { dev: 'vite' } }),
    'apps/web/vite.config.ts': 'export default {}\n',
    'apps/api/package.json': PKG({ scripts: { dev: 'node index.js' } }),
    'apps/excluded/package.json': PKG({ scripts: { dev: 'nope' } }),
  });
  const stats = { scanned: 0, rejected: {} };
  const apps = discoverApps(baseCfg([root]), { stats });
  const byName = Object.fromEntries(apps.map(a => [a.baseName, a]));
  assert.equal(apps.length, 2, `got ${apps.map(a => a.name).join(', ')}`);
  assert.equal(byName.web.serverProfile, 'vite');
  assert.equal(byName.api.serverProfile, 'package-json');
  // Member inherits the workspace root's lockfile → pnpm.
  assert.equal(byName.api.command, 'pnpm run dev');
  assert.equal(byName.web.workspaceRoot, path.join(root, 'apps', 'web'));
  // Root fallback is suppressed because the enumerator matched the root.
  assert.ok(!apps.some(a => a.workspaceRoot === root));
});

test('turbo.json + package.json workspaces enumerates members', () => {
  const root = makeRoot({
    'turbo.json': '{}',
    'package.json': PKG({ workspaces: ['packages/*'], scripts: { dev: 'turbo dev' } }),
    'packages/site/package.json': PKG({ scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0' } }),
    'packages/site/next.config.js': 'module.exports = {}\n',
    'packages/lib/package.json': PKG({ scripts: { build: 'tsc' } }),
  });
  const apps = discoverApps(baseCfg([root]));
  assert.equal(apps.length, 1, `got ${apps.map(a => `${a.name}:${a.serverProfile}`).join(', ')}`);
  assert.equal(apps[0].baseName, 'site');
  assert.equal(apps[0].serverProfile, 'nextjs');
  assert.equal(apps[0].command, 'npx next dev');
});

test('per-profile stats count meta-framework and member matches', () => {
  const root = makeRoot({
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
    'apps/a/package.json': PKG({ scripts: { dev: 'x' } }),
    'apps/b/package.json': PKG({ scripts: { dev: 'x' } }),
  });
  const stats = { scanned: 0, rejected: {} };
  discoverApps(baseCfg([root]), { stats });
  assert.equal(stats.profiles['package-json'], 2);
  assert.equal(stats.scanned, 2, 'members count as scanned');
});
