// M64 — Playwright drive across every dashboard route. Visits each path,
// asserts the page-specific landmark renders, and captures a console-error
// budget per route. Expects:
//   • daimon daemon running at DAIMON_BASE_URL (default 127.0.0.1:4999)
//   • seed data pushed via `npm run e2e:seed`
//   • two agents to have touched the daemon recently (e.g. `daimon list` from
//     two shells) so the Agents route shows ≥2 rows.

import { test, expect, type Page } from '@playwright/test';

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

  test('Agents route shows at least 2 agent rows', async ({ page }) => {
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
