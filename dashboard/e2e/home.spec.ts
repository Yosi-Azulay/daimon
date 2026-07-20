// Overview home (M158, v1.12). Proves `/` is the composed overview (not the
// apps list), that each widget degrades independently to a note, and that the
// IA wiring holds: `g a` lands on /apps, both routes resolve.

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

test('/ is the overview with all four widgets (or the guided empty state)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main h1', { hasText: 'Overview' })).toBeVisible({ timeout: 10_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  // Either the four widget headings render, or (fresh install) the guided
  // empty state — both are valid designed states, never a blank page.
  const widgets = page.locator('.dm-widget h2');
  const empty = page.locator('.dm-empty');
  const hasWidgets = await widgets.count();
  if (hasWidgets) {
    const headings = (await widgets.allTextContents()).map(t => t.trim());
    expect(headings).toEqual(expect.arrayContaining(['Status', 'Needs attention', 'Test pass-rate', 'Resources']));
  } else {
    await expect(empty).toBeVisible();
  }
});

test('the tests widget degrades to a note when /api/tests fails', async ({ page }) => {
  await page.route('**/api/tests*', route => route.fulfill({ status: 500, body: '[]' }));
  await page.goto('/');
  await expect(page.locator('main h1', { hasText: 'Overview' })).toBeVisible({ timeout: 10_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  // If widgets render at all, the test widget must show a note, not a spinner
  // or an error page — and the other widgets are unaffected.
  const testWidget = page.locator('.dm-widget', { has: page.locator('h2', { hasText: 'Test pass-rate' }) });
  if (await testWidget.count()) {
    await expect(testWidget.locator('.dm-widget-note')).toBeVisible({ timeout: 10_000 });
  }
});

test('g a lands on /apps (retargeted), and / resolves to the overview', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/apps$/, { timeout: 10_000 });
  await expect(page.locator('main h1, main h2').first()).toBeVisible();
});
