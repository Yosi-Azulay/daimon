// M118 (v1.5) — the plugin count badge on the apps overview. The badge is a
// pointer only (`daimon plugins` is the detail view) and appears solely when
// the daemon reports plugin files. Rather than planting files in the REAL
// ~/.daimon/plugins (the e2e daemon's live state dir — more invasive than the
// history-row seeding the other specs do), the /api/overview response is
// intercepted and given a `plugins` count block: the badge renders from that
// key alone, which is exactly the contract under test.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

async function withOverviewPlugins(page: import('@playwright/test').Page, plugins: object | null) {
  await page.route('**/api/overview*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    if (plugins === null) delete json.plugins;
    else json.plugins = plugins;
    await route.fulfill({ response, json });
  });
}

test('plugins badge shows active/total and flags non-active plugins', async ({ page }) => {
  await withOverviewPlugins(page, { total: 3, active: 2, nonActive: 1 });
  await page.goto('/apps');
  const badge = page.getByTestId('plugins-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('2');
  await expect(badge).toContainText('/3');
  await expect(badge).toContainText('plugins');
  // Non-active count paints the badge with the error accent class.
  await expect(badge).toHaveClass(/dm-total-error/);
});

test('all-active plugins render without the error accent', async ({ page }) => {
  await withOverviewPlugins(page, { total: 2, active: 2, nonActive: 0 });
  await page.goto('/apps');
  const badge = page.getByTestId('plugins-badge');
  await expect(badge).toBeVisible();
  await expect(badge).not.toHaveClass(/dm-total-error/);
});

test('badge absent when the daemon reports no plugin files', async ({ page }) => {
  await withOverviewPlugins(page, null);
  await page.goto('/apps');
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByTestId('plugins-badge')).toHaveCount(0);
});

test('axe: overview with the plugins badge has no serious/critical violations', async ({ page }) => {
  await withOverviewPlugins(page, { total: 3, active: 2, nonActive: 1 });
  await page.goto('/apps');
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByTestId('plugins-badge')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking, blocking.map(v => `[${v.impact}] ${v.id}: ${v.help}`).join('\n')).toEqual([]);
});
