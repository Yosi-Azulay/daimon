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
