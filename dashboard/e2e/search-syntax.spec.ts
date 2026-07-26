// Search flows for v1.16 "Recall" (M179–M181, M184). Drives the palette's
// search mode end to end against a live daemon: the query syntax reaches the
// API, a bad field renders the daemon's own error instead of "no results", the
// unified scope's facet summary shows, a saved search is listed and runs only
// when a human picks it, and a hit still deep-links where it always did.
//
// Route interception is used for the saved-search list so the spec does not
// have to write into the developer's real state.json — the same technique
// plugins-badge.spec.ts uses for the overview badge.

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('daimon.tourDismissed', '1');
    localStorage.removeItem('daimon.palette.recents');
  });
});

async function openPalette(page: Page) {
  await page.goto('/');
  await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('.dm-cmdk').first().click();
  await expect(page.locator('.dm-palette-search input')).toBeVisible({ timeout: 10_000 });
}

test('a syntax query reaches the API with the unified scope', async ({ page }) => {
  const requested: string[] = [];
  await page.route('**/api/search?**', async (route) => {
    requested.push(route.request().url());
    await route.continue();
  });
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('>app:web level:error boot');
  await expect.poll(() => requested.length, { timeout: 10_000 }).toBeGreaterThan(0);
  // URLSearchParams encodes a space as '+', which decodeURIComponent leaves
  // alone — normalise both so the assertion reads like the typed query.
  const last = decodeURIComponent(requested[requested.length - 1]).replace(/\+/g, ' ');
  expect(last).toContain('app:web level:error boot');
  // M180: the palette opts into the unified scope, so tests and error groups
  // are searchable from here.
  expect(last).toContain('scope=all');
});

test('an unknown field renders the daemon\'s error, not "no results"', async ({ page }) => {
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('>lvl:error boom');
  const err = page.locator('.dm-palette-error');
  await expect(err).toBeVisible({ timeout: 10_000 });
  await expect(err).toContainText('unknown field');
  await expect(err).toContainText('valid fields: app, kind, level, before, after');
  // It is announced, not just painted.
  await expect(err).toHaveAttribute('role', 'alert');
});

test('the facet summary reports what came back, per kind', async ({ page }) => {
  await page.route('**/api/search?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        fallback: false,
        facets: { errors: 2, tests: 1, logs: 3 },
        hits: [
          { kind: 'errors', app: 'web-admin', ts: Date.now(), snippet: 'boom one', ref: 'event:1' },
          { kind: 'errors', app: 'web-admin', ts: Date.now(), snippet: 'boom two', ref: 'event:2' },
          { kind: 'tests', app: 'web-admin', ts: Date.now(), snippet: 'vitest · 9/10 passed', ref: 'test:7' },
          { kind: 'logs', app: 'web-admin', ts: Date.now(), snippet: 'a log line', ref: 'log:9' },
        ],
      }),
    });
  });
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('>boom');
  const facets = page.locator('.dm-palette-facets');
  await expect(facets).toBeVisible({ timeout: 10_000 });
  await expect(facets).toContainText(/2 errors/);
  await expect(facets).toContainText(/1 test/);
  // The v1.16 kinds are rendered, and a test hit deep-links to the Tests page.
  await page.locator('.dm-palette-item', { hasText: 'vitest' }).first().click();
  await expect(page).toHaveURL(/\/tests$/, { timeout: 10_000 });
});

test('a saved search is listed and runs ONLY when picked', async ({ page }) => {
  const searchCalls: string[] = [];
  await page.route('**/api/searches', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        searches: [{ name: 'today-errors', query: 'level:error after:24h', createdMs: 1, updatedMs: 2 }],
      }),
    });
  });
  await page.route('**/api/search?**', async (route) => {
    searchCalls.push(decodeURIComponent(route.request().url()).replace(/\+/g, ' '));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fallback: false, facets: { errors: 1 }, hits: [
        { kind: 'errors', app: 'web-admin', ts: Date.now(), snippet: 'saved hit', ref: 'event:5' },
      ] }),
    });
  });

  await openPalette(page);
  await expect(page.locator('.dm-palette-group-label', { hasText: /saved searches/i })).toBeVisible({ timeout: 10_000 });
  const row = page.locator('.dm-palette-item', { hasText: 'today-errors' }).first();
  await expect(row).toBeVisible();
  // INERT: listing a saved search must not run it (M181).
  expect(searchCalls, 'a saved search ran without being chosen').toEqual([]);

  await row.click();
  await expect.poll(() => searchCalls.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(searchCalls[searchCalls.length - 1]).toContain('level:error after:24h');
  await expect(page.locator('.dm-palette-item', { hasText: 'saved hit' }).first()).toBeVisible();
});

test('axe: the palette in search mode with an error and facets has no serious/critical violations', async ({ page }) => {
  await openPalette(page);
  await page.locator('.dm-palette-search input').fill('>lvl:error boom');
  await expect(page.locator('.dm-palette-error')).toBeVisible({ timeout: 10_000 });
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
