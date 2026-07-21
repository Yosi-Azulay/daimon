// Workspace switcher persistence (M173, v1.15 "Atlas"). The preference is
// CLIENT-SIDE by design: localStorage `daimon.workspace` + the
// `daimon:workspace` CustomEvent bus — never a daemon-global. These drives
// assert the acceptance triad: reload restores the stored choice, an explicit
// ?workspace= deep-link wins over it, and clearing the scope clears storage.

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

// The switcher chip is the first .dm-chip in the topbar (workspace), showing
// the active label or "All workspaces".
const chip = (page: import('@playwright/test').Page) => page.locator('.dm-topbar .dm-chip').first();

test('reload restores the stored workspace choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.workspace', 'atlas-ws'));
  await page.goto('/apps');
  await expect(chip(page)).toContainText('atlas-ws');
  await page.reload();
  await expect(chip(page)).toContainText('atlas-ws');
});

test('an explicit ?workspace= deep-link wins over the stored preference', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.workspace', 'stored-ws'));
  await page.goto('/apps?workspace=linked-ws');
  await expect(chip(page)).toContainText('linked-ws');
  const stored = await page.evaluate(() => localStorage.getItem('daimon.workspace'));
  expect(stored).toBe('linked-ws');
});

test('clearing the scope returns to All workspaces and clears storage', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.workspace', 'atlas-ws'));
  await page.goto('/apps');
  await page.locator('.dm-scope-x').click();
  await expect(chip(page)).toContainText('All workspaces');
  const stored = await page.evaluate(() => localStorage.getItem('daimon.workspace'));
  expect(stored).toBeNull();
});
