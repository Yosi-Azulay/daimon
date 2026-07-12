// M64 — Playwright drive across every dashboard route. Visits each path,
// asserts the page-specific landmark renders, and captures a console-error
// budget per route. Expects:
//   • daimon daemon running at DAIMON_BASE_URL (default 127.0.0.1:4999)
//   • seed data pushed via `npm run e2e:seed`
//   • two agents to have touched the daemon recently (e.g. `daimon list` from
//     two shells) so the Agents route shows ≥2 rows.

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROUTE_PATHS } from './routes';
export { ROUTE_PATHS } from './routes';

// The why-panel drive needs a crash row attached to a REAL registry app (the
// /api/why route resolves registry names; seed.ts's default fake apps 404).
// Same direct-insert approach as e2e/seed.ts, but via a plain-CJS child
// process so it works under whichever module transform runs this spec.
// WAL mode allows the insert while the daemon is live; the row is
// ring-buffered (10/app) and retention-pruned like any crash.
function seedCrashFor(app: string): void {
  const dbPath = process.env.DAIMON_HISTORY_DB || path.join(os.homedir(), '.daimon', 'history.db');
  const code = [
    "const Database = require('better-sqlite3');",
    'const db = new Database(process.argv[1]);',
    "db.prepare('INSERT INTO crashes (ts, app, exitCode, signal, uptimeMs, lastLines, gitHead) VALUES (?, ?, ?, ?, ?, ?, ?)')",
    "  .run(Date.now() - 60000, process.argv[2], 1, null, 340000, 'TypeError: Cannot read properties of undefined\\n    at gateway (src/index.ts:42:7)\\n[nodemon] app crashed', 'a1b2c3d');",
    'db.close();',
  ].join('\n');
  // cwd = repo root so better-sqlite3 resolves from the root node_modules
  // (playwright runs specs with cwd = dashboard/).
  execFileSync(process.execPath, ['-e', code, dbPath, app], { cwd: path.resolve(process.cwd(), '..') });
}

// Landmark assertions are scoped to <main>: at 390px the nav-rail labels are
// (correctly) hidden in the bottom bar, so an unscoped getByText would match
// a hidden nav label first and false-fail.
const ROUTES: { path: string; expect: (page: Page) => Promise<void> }[] = [
  { path: '/',           expect: async p => { await expect(p.locator('main h1, main h2').first()).toBeVisible(); } },
  { path: '/errors',     expect: async p => { await expect(p.locator('main').getByText(/error|warning/i).first()).toBeVisible(); } },
  { path: '/logs',       expect: async p => { await expect(p.locator('main h1, main h2').first()).toBeVisible(); } },
  { path: '/config',     expect: async p => { await expect(p.locator('main h1, main h2').first()).toBeVisible(); } },
  { path: '/doctor',     expect: async p => { await expect(p.locator('main').getByText(/doctor|check/i).first()).toBeVisible(); } },
  { path: '/events',     expect: async p => { await expect(p.locator('main').getByText(/event/i).first()).toBeVisible(); } },
  { path: '/history',    expect: async p => { await expect(p.locator('main h1, main h2').first()).toBeVisible(); } },
  { path: '/trends',     expect: async p => { await expect(p.locator('main').getByText(/trend/i).first()).toBeVisible(); } },
  { path: '/timeline',   expect: async p => { await expect(p.locator('main').getByText(/timeline/i).first()).toBeVisible(); } },
  { path: '/tests',      expect: async p => { await expect(p.locator('main h1, main h2').first()).toBeVisible(); } },
  { path: '/sessions',   expect: async p => { await expect(p.locator('main h1, main h2').first()).toBeVisible(); } },
  { path: '/agents',     expect: async p => { await expect(p.locator('main').getByText(/agent/i).first()).toBeVisible(); } },
  { path: '/regressions', expect: async p => { await expect(p.locator('main').getByText(/regression|compile|bundle/i).first()).toBeVisible(); } },
];

// Drift guard (M89): ROUTES above and e2e/routes.ts's ROUTE_PATHS (consumed
// by a11y.spec.ts / keyboard.spec.ts) are two separately-maintained lists —
// ROUTE_PATHS lives in its own plain-data module specifically so importing
// it never drags this whole spec file's tests into an unrelated Playwright
// run (see routes.ts's header comment). This test is the tripwire that
// catches the two lists drifting apart instead of silently under-covering
// the a11y gate. '/report' is ROUTE_PATHS's one intentional addition — it
// gets its own dedicated drive test further down this file rather than a
// ROUTES table entry.
test('ROUTES and ROUTE_PATHS stay in sync', () => {
  const fromRoutes = new Set(ROUTES.map(r => r.path));
  const fromPaths = new Set(ROUTE_PATHS.filter(p => p !== '/report'));
  expect([...fromPaths].sort()).toEqual([...fromRoutes].sort());
  expect(ROUTE_PATHS).toContain('/report');
});

// Every test below drives routes/keyboard chords against a fresh (isolated)
// browser context, and the onboarding tour (M79) shows a full-viewport scrim
// on a first visit — it would intercept every click/keypress here. Pre-dismiss
// it via an init script so this suite exercises the app, not the tour; the
// tour gets its own dedicated test below, outside this describe.
test.describe('routes (tour pre-dismissed)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
  });

  for (const route of ROUTES) {
    test(`drives ${route.path}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await page.goto(route.path);
      await route.expect(page);
      // Console-error budget: tolerate up to 1 expected error (e.g., favicon).
      const fatal = consoleErrors.filter(e => !/favicon|ResizeObserver|chunk-/.test(e));
      expect.soft(fatal, `console errors on ${route.path}`).toEqual([]);
      // M71: no horizontal scroll at any viewport (the mobile-390 project runs
      // this same assertion at 390px).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect.soft(overflow, `horizontal overflow on ${route.path}`).toBeLessThanOrEqual(0);
    });
  }

  // M73 — v0.11 drive additions: mission control across a mixed multi-framework
  // workspace (badges from the registry), and detail reachable from a card.
  test('mission control shows framework badges for a mixed workspace', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('dm-framework-badge').first()).toBeVisible({ timeout: 10_000 });
    const badges = await page.locator('dm-framework-badge .dm-fw-tag').allTextContents();
    expect(new Set(badges.filter(Boolean)).size, `distinct badges: ${badges.join(',')}`).toBeGreaterThanOrEqual(3);
  });

  test('app detail opens from a mission-control card', async ({ page }) => {
    await page.goto('/');
    await page.locator('article.c').first().click();
    await expect(page).toHaveURL(/\/apps\//);
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('Agents route shows at least 2 agent rows', async ({ page, request, baseURL }) => {
    // Agent records are in-memory and prune after an inactivity window (see
    // e2e/seed.ts's own note) — as the suite grows, whichever agent activity
    // happened at seed time can age out before this spec runs. Re-register
    // two agents through the real API right here so the assertion doesn't
    // depend on suite ordering or how long earlier specs took.
    await request.get(`${baseURL}/api/apps`, { headers: { 'x-daimon-agent': 'e2e-agent-1-abcd' } });
    await request.get(`${baseURL}/api/apps`, { headers: { 'x-daimon-agent': 'e2e-agent-2-wxyz' } });

    await page.goto('/agents');
    // Wait for the first card to appear (data fetched via /api/agents).
    const cards = page.locator('mat-card');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    await expect(async () => expect(await cards.count()).toBeGreaterThanOrEqual(2)).toPass({ timeout: 5_000 });
  });

  test('Regressions route surfaces seeded regression-detected events', async ({ page }) => {
    await page.goto('/regressions');
    await expect(page.getByText(/×\d/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('g a → /agents, g r → /regressions chord routing', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await expect(page).toHaveURL(/\/agents$/);
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/\/regressions$/);
  });

  // M75 — Tests page run history: seeded test_runs render as run rows, and a
  // row expands into the failure drill-down (file:line via vscode links).
  test('Tests page shows seeded run history and failure drill-down', async ({ page }) => {
    await page.goto('/tests');
    // Per-app cards are collapsed when more than one app has runs — open the
    // first card to reach its run list.
    const panels = page.locator('mat-expansion-panel');
    await expect(panels.first()).toBeVisible({ timeout: 10_000 });
    await panels.first().locator('mat-expansion-panel-header').click();
    const rows = page.locator('.dm-run-row');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    expect(await rows.count(), 'seeded runs render').toBeGreaterThanOrEqual(2);
    // Runner badge hides at 390px by design — the run label is the invariant.
    await expect(page.locator('.dm-run-label').first()).toBeVisible();
    // Expand the newest web-admin run — its seeded failure carries file:line.
    await page.locator('.dm-run-main').first().click();
    await expect(page.locator('.dm-run-row.expanded').first()).toBeVisible();
    await expect(page.getByText('session.spec.ts', { exact: false }).first()).toBeVisible();
  });

  // M77 — command palette search mode: `>` switches from command matching to
  // GET /api/search. Doesn't assert on actual hits (fixture-dependent); proves
  // the mode switch, debounce, and empty/no-match rendering never crash or
  // throw, and that dropping back below `>` restores command matching.
  test('command palette switches to search mode on ">" and back', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    await page.goto('/');
    // Open via the topbar's visible "Jump to…" button rather than the Ctrl+K
    // chord — real Ctrl+K risks colliding with the browser's own address-bar
    // shortcut in a driven Chromium instance, and the button exercises the
    // identical open path (both dispatch the same 'daimon:cmdk' event).
    await page.locator('.dm-cmdk').first().click();
    const input = page.locator('.dm-palette-search input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    // "errors" matches the always-present "Go to Errors" nav entry, so this
    // doesn't depend on any particular app being seeded.
    await input.fill('errors');
    await expect(page.locator('.dm-palette-item').first()).toBeVisible();

    await input.fill('>readme');
    await expect(page.locator('.dm-palette-search input')).toHaveValue('>readme');
    // Debounced search fires ~250ms after the last keystroke; give it room to
    // settle into either a hit list or the "No matches" empty state.
    await expect(page.locator('.dm-palette-empty, .dm-palette-hit').first()).toBeVisible({ timeout: 5_000 });

    await input.fill('errors');
    await expect(page.locator('.dm-palette-item').first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.dm-palette')).toBeHidden();

    const fatal = consoleErrors.filter(e => !/favicon|ResizeObserver|chunk-/.test(e));
    expect.soft(fatal, 'console errors during palette search mode').toEqual([]);
  });

  // M85 — Report page (M83 digest UI): every section renders as either data
  // or a degraded note (never an error state), at whichever viewport this
  // spec is currently running under (the chromium/mobile-390 project matrix
  // drives this same test at both 1280px and 390px).
  test('Report page renders every section (data or note)', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    await page.goto('/report');
    await expect(page.locator('main h1', { hasText: 'Report' })).toBeVisible({ timeout: 10_000 });
    for (const title of ['Uptime', 'Errors', 'Tests', 'Compiles', 'Agents']) {
      await expect(page.locator('.dm-panel-title', { hasText: title }).first()).toBeVisible();
    }
    await expect(page.locator('.dm-panel-title', { hasText: /Crashes/ }).first()).toBeVisible();
    await expect(page.locator('.dm-panel-title', { hasText: 'Env changes' }).first()).toBeVisible();
    // Every section is either its data view or a `.dm-note` — assert none of
    // the 7 panels are stuck empty (neither rendered).
    const panelCount = await page.locator('.dm-panel').count();
    expect(panelCount, 'report renders all 7 sections').toBeGreaterThanOrEqual(7);

    const fatal = consoleErrors.filter(e => !/favicon|ResizeObserver|chunk-/.test(e));
    expect.soft(fatal, 'console errors on /report').toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect.soft(overflow, 'horizontal overflow on /report').toBeLessThanOrEqual(0);
  });

  test('Report page period switcher accepts a custom since duration', async ({ page }) => {
    await page.goto('/report');
    await page.getByText('Custom', { exact: true }).click();
    const input = page.locator('.dm-custom-input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('3d');
    // A fresh fetch fires on every valid keystroke — the meta line re-renders
    // once the new report lands, proving the custom `since` round-tripped.
    await expect(page.locator('.dm-meta')).toBeVisible({ timeout: 10_000 });
  });

  // M85 — app-detail "why" panel: GET /api/why/<app> composed into a tab.
  // /api/why resolves REGISTRY names, so the crash is seeded onto a real app
  // resolved at runtime rather than seed.ts's history-only fake names.
  test('Why panel on app detail shows the seeded crash', async ({ page, request, baseURL }) => {
    const apps: { name: string }[] = await (await request.get(`${baseURL}/api/apps`)).json();
    test.skip(!apps.length, 'no registry apps in the driven workspace');
    const target = apps[0].name;
    seedCrashFor(target);
    await page.goto(`/apps/${encodeURIComponent(target)}?tab=why`);
    await expect(page.locator('.dm-panel-title', { hasText: 'Last crash' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.dm-panel-title', { hasText: 'Restart storm' })).toBeVisible();
    // The seeded (or a real) crash card carries exit-code detail rows.
    await expect(page.getByText(/exit/i).or(page.locator('dd', { hasText: '1' })).first()).toBeVisible();
  });

  // M85 — mute indicator (M84 mute): a muted app surfaces a badge on both the
  // apps-list card and the app-detail header. Mutes via the real POST
  // endpoint rather than faking the summary shape client-side.
  test('Mute badge shows on a muted app card and its detail header', async ({ page, request, baseURL }) => {
    // Mute a REAL registry app (the mute route 404s on history-only names).
    const apps: { name: string }[] = await (await request.get(`${baseURL}/api/apps`)).json();
    test.skip(!apps.length, 'no registry apps in the driven workspace');
    const target = apps[0].name;
    await request.post(`${baseURL}/api/apps/${target}/mute`, { data: { forMs: 3_600_000 } });
    try {
      await page.goto('/');
      const card = page.locator('article.c', { hasText: target }).first();
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card.locator('.mb')).toBeVisible();

      await page.goto(`/apps/${target}`);
      await expect(page.locator('.dm-mute-chip')).toBeVisible({ timeout: 10_000 });
    } finally {
      await request.post(`${baseURL}/api/apps/${target}/unmute`, { data: {} });
    }
  });
});

// M79 — onboarding tour: shows once on a first visit (fresh, un-dismissed
// storage — deliberately outside the describe above), skip persists the
// dismissal, and a reload never shows it again.
test('onboarding tour shows once on first visit and never again after dismiss', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dm-tour-card')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.dm-tour-step')).toHaveText('1 / 6');
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.dm-tour-card')).toBeHidden();
  await page.reload();
  await expect(page.locator('.dm-tour-card')).toBeHidden();
});

test('onboarding tour Next advances through all steps to Done', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dm-tour-card')).toBeVisible({ timeout: 10_000 });
  // Target the tour's own primary button: a bare `name: 'Next'` role query
  // substring-matches an app card whose framework badge is "next" (nextjs).
  const primary = page.locator('.dm-tour-btn-primary');
  for (let i = 0; i < 5; i++) {
    await expect(primary).toHaveText('Next');
    await primary.click();
  }
  await expect(page.locator('.dm-tour-step')).toHaveText('6 / 6');
  await expect(primary).toHaveText('Done');
  await primary.click();
  await expect(page.locator('.dm-tour-card')).toBeHidden();
});
