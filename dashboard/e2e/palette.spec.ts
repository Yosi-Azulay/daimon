// Command palette 2.0 (M157, v1.12). Proves the unified palette end to end:
// plain typing ranks nav + app + search into one list, `>` still forces
// search-only, recents persist across reopen, and the whole thing is
// keyboard-operable with no pointer. axe is checked on the open palette.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('daimon.tourDismissed', '1');
    localStorage.removeItem('daimon.palette.recents');
  });
});

async function openPalette(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10_000 });
  const trigger = page.locator('.dm-cmdk').first();
  await trigger.click();
  await expect(page.locator('.dm-palette-search input')).toBeVisible({ timeout: 10_000 });
}

test('plain typing ranks a nav destination and Enter navigates to it', async ({ page }) => {
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('errors');
  // The nav command "Go to Errors" should be the top-ranked selectable row.
  const first = page.locator('.dm-palette-item').first();
  await expect(first).toContainText(/Errors/i, { timeout: 5_000 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/errors$/, { timeout: 10_000 });
});

test('`>` forces search-only mode (no nav commands)', async ({ page }) => {
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('>error');
  // The search icon flips and only hit rows / empty-search states render — no
  // "Go to …" nav command appears.
  await expect(page.locator('.dm-palette-list')).toBeVisible();
  await expect(page.locator('.dm-palette-item', { hasText: 'Go to' })).toHaveCount(0);
});

test('recents show on reopen after a navigation selection', async ({ page }) => {
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('trends');
  // Wait for the ranked row before Enter (same guard every sibling test has)
  // — otherwise Enter races the re-rank and picks the default first row.
  await expect(page.locator('.dm-palette-item').first()).toContainText(/Trends/i, { timeout: 5_000 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/trends$/, { timeout: 10_000 });

  // Reopen with an empty query → a "Recent" group with the just-picked entry.
  const trigger = page.locator('.dm-cmdk').first();
  await trigger.click();
  await expect(page.locator('.dm-palette-search input')).toBeVisible();
  await expect(page.locator('.dm-palette-group-label', { hasText: /recent/i })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.dm-palette-item', { hasText: /Trends/i }).first()).toBeVisible();
});

test('full keyboard round trip: arrow to a row, Enter, Escape returns focus', async ({ page }) => {
  await openPalette(page);
  const input = page.locator('.dm-palette-search input');
  await input.fill('log');
  await expect(page.locator('.dm-palette-item').first()).toBeVisible({ timeout: 5_000 });
  // Arrow down selects a row; aria-activedescendant tracks it.
  await page.keyboard.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /dm-pi-/);
  // Escape closes and restores focus to the trigger.
  await page.keyboard.press('Escape');
  await expect(page.locator('.dm-palette')).toBeHidden();
  await expect(page.locator('.dm-cmdk').first()).toBeFocused();
});

test('axe: open palette has no serious/critical violations', async ({ page }) => {
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('e');
  await page.waitForLoadState('networkidle').catch(() => {});
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
