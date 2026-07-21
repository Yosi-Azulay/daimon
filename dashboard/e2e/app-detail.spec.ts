// App-detail redesign (M159, v1.12). The tabbed detail became a sectioned,
// anchored page. Proves: the section nav renders, #anchor deep-links scroll
// to and highlight their section, legacy `?tab=` still lands, and the header
// action row fires the same existing API calls.

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

async function firstApp(request: import('@playwright/test').APIRequestContext): Promise<string | null> {
  try {
    const apps: { name: string }[] = await (await request.get('/api/apps')).json();
    return apps[0]?.name ?? null;
  } catch { return null; }
}

test('section nav renders all six sections', async ({ page, request }) => {
  const app = await firstApp(request);
  test.skip(!app, 'no registered app');
  await page.goto(`/apps/${encodeURIComponent(app!)}`);
  const links = page.locator('.dm-section-nav .dm-section-link');
  await expect(links.first()).toBeVisible({ timeout: 10_000 });
  const labels = (await links.allTextContents()).map(t => t.trim().replace(/\d+$/, '').trim());
  for (const s of ['Overview', 'Errors', 'Logs', 'Tests', 'Timeline', 'Why']) {
    expect(labels.some(l => l.includes(s)), `section ${s}`).toBe(true);
  }
});

test('#errors deep-link highlights the errors section on cold load', async ({ page, request }) => {
  const app = await firstApp(request);
  test.skip(!app, 'no registered app');
  await page.goto(`/apps/${encodeURIComponent(app!)}#errors`);
  // The errors section link becomes active (aria-current) once scroll settles.
  const errorsLink = page.locator('.dm-section-link', { hasText: 'Errors' });
  await expect(errorsLink).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });
  // And the errors section itself is present.
  await expect(page.locator('#errors')).toBeVisible();
});

test('legacy ?tab=why still resolves and lands on the why section', async ({ page, request }) => {
  const app = await firstApp(request);
  test.skip(!app, 'no registered app');
  await page.goto(`/apps/${encodeURIComponent(app!)}?tab=why`);
  await expect(page).toHaveURL(/\/apps\//);
  await expect(page.locator('#why')).toBeVisible({ timeout: 10_000 });
  const whyLink = page.locator('.dm-section-link', { hasText: 'Why' });
  await expect(whyLink).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });
});

test('header action row includes start/stop, restart, mute, test', async ({ page, request }) => {
  const app = await firstApp(request);
  test.skip(!app, 'no registered app');
  await page.goto(`/apps/${encodeURIComponent(app!)}`);
  const bar = page.locator('.dm-action-bar');
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await expect(bar.getByText(/^(Start|Stop)$/)).toBeVisible();
  await expect(bar.getByText('Restart')).toBeVisible();
  await expect(bar.getByText(/^(Mute|Unmute)$/)).toBeVisible();
  await expect(bar.getByText('Test')).toBeVisible();
});

test('Test action fires POST /api/apps/:name/test', async ({ page, request }) => {
  const app = await firstApp(request);
  test.skip(!app, 'no registered app');
  await page.goto(`/apps/${encodeURIComponent(app!)}`);
  const bar = page.locator('.dm-action-bar');
  await expect(bar).toBeVisible({ timeout: 10_000 });
  const waitTest = page.waitForRequest(r => r.method() === 'POST' && /\/api\/apps\/.+\/test/.test(r.url()), { timeout: 10_000 });
  await bar.getByText('Test').click();
  await waitTest;
});

// v1.14 regression guard. `scrollToSection` rewrites the fragment with
// history.replaceState; a BARE '#id' resolves against `<base href="/">` and
// threw the /apps/<name> path away, so the address bar (and anything copied
// from it) pointed at the home page. Every legacy `?tab=` link landed there
// too. The path and query must survive a section change.
test('scrolling to a section keeps the app path in the URL', async ({ page, request }) => {
  const app = await firstApp(request);
  test.skip(!app, 'no registered app');
  const base = `/apps/${encodeURIComponent(app!)}`;
  await page.goto(base);
  await expect(page.locator('#overview')).toBeVisible({ timeout: 10_000 });

  await page.locator('.dm-section-link', { hasText: 'Errors' }).click();
  await expect(page.locator('.dm-section-link', { hasText: 'Errors' }))
    .toHaveAttribute('aria-current', 'true', { timeout: 10_000 });

  const url = new URL(page.url());
  expect(url.pathname, 'the app path must survive a section scroll').toBe(base);
  expect(url.hash).toBe('#errors');
});
