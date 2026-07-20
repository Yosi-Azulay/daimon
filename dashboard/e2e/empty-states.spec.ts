// Guided empty states (M160, v1.12). A fresh install (no apps, no history) is
// a DESIGNED state with a next step, never a blank table or an endless
// spinner. Rather than depend on a clean DAIMON_HOME (the human runs that
// drive), these force-empty the relevant endpoints via route interception —
// the same technique plugins-badge.spec.ts uses — and assert the guidance
// renders.

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

test('home shows a guided fresh-install state when there are no apps', async ({ page }) => {
  await page.route('**/api/apps*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/overview*', async route => {
    const res = await route.fetch();
    const json = await res.json().catch(() => ({}));
    json.totals = { apps: 0, serving: 0, errors: 0, stopped: 0 };
    json.needsAttention = [];
    await route.fulfill({ response: res, json });
  });
  await page.goto('/');
  await expect(page.locator('main h1', { hasText: 'Overview' })).toBeVisible({ timeout: 10_000 });
  const empty = page.locator('.dm-empty');
  await expect(empty).toBeVisible({ timeout: 10_000 });
  await expect(empty).toContainText(/no apps/i);
  // A next step is offered, not just a dead end.
  await expect(page.locator('.dm-home-cta')).toBeVisible();
});

test('errors page explains what will appear when there are no apps', async ({ page }) => {
  await page.route('**/api/apps*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/errors');
  await expect(page.locator('.dm-empty')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.dm-empty')).toContainText(/error/i);
});

test('tests page names the command that feeds it when empty', async ({ page }) => {
  await page.route('**/api/tests*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) }));
  await page.goto('/tests');
  const empty = page.locator('.dm-empty');
  await expect(empty).toBeVisible({ timeout: 10_000 });
  await expect(empty).toContainText(/daimon test/i);
});
