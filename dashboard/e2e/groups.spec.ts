// M97 — named app groups (v1.1) dashboard drive: group filter chips, the
// grouped section layout, deep-linking, and the app-detail group row.
// Self-contained: seeds its own groups over the REAL registry via
// seedRealGroups (see e2e/seed-groups.ts for why groups can't reuse
// e2e/seed.ts's synthetic app names) rather than depending on
// `npm run e2e:seed` having already run — the same pattern
// dashboard.spec.ts's seedCrashFor / mute-badge tests use.
//
// Expects: daimon daemon running at DAIMON_BASE_URL (default 127.0.0.1:4999)
// with at least one real app discovered in the driven workspace.

import { test, expect } from '@playwright/test';
import { seedRealGroups, type SeededGroups } from './seed-groups.ts';

test.describe('named app groups', () => {
  let seeded: SeededGroups | null = null;

  test.beforeAll(async ({ baseURL }) => {
    seeded = await seedRealGroups(baseURL!);
  });

  test.beforeEach(async ({ page }) => {
    // Same tour pre-dismiss as dashboard.spec.ts — the onboarding scrim would
    // otherwise sit on top of the chip row and intercept every click here.
    await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
  });

  test('group chips render and filter the apps list', async ({ page }) => {
    test.skip(!seeded, 'no registry apps in the driven workspace, or daemon predates /api/groups');
    const consoleErrors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto('/');
    const webChip = page.locator('.dm-group-chip-row .dm-chip', { hasText: 'web' });
    await expect(webChip).toBeVisible({ timeout: 10_000 });
    await expect(webChip).toHaveAttribute('aria-pressed', 'false');

    await webChip.click();
    await expect(webChip).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]group=web/);

    // Exactly one chip active at a time: 'day' must not also read pressed.
    const dayChip = page.locator('.dm-group-chip-row .dm-chip', { hasText: 'day' });
    await expect(dayChip).toHaveAttribute('aria-pressed', 'false');

    // Filtered flat list: every visible row belongs to 'web'. The page-sub
    // line names the active group (apps-list.ts's `· group web`).
    await expect(page.locator('.dm-page-sub')).toContainText('group');
    await expect(page.locator('.dm-page-sub')).toContainText('web');

    // Clicking the active chip clears the filter.
    await webChip.click();
    await expect(webChip).toHaveAttribute('aria-pressed', 'false');
    await expect(page).not.toHaveURL(/[?&]group=web/);

    const fatal = consoleErrors.filter(e => !/favicon|ResizeObserver|chunk-/.test(e));
    expect.soft(fatal, 'console errors while filtering by group').toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect.soft(overflow, 'horizontal overflow with group chips visible').toBeLessThanOrEqual(0);
  });

  test('grouped sections render with proper headings when no chip filter is active', async ({ page }) => {
    test.skip(!seeded, 'no registry apps in the driven workspace, or daemon predates /api/groups');
    await page.goto('/');
    await expect(page.locator('.dm-group-chip-row')).toBeVisible({ timeout: 10_000 });

    const headings = page.locator('h2.dm-group-heading');
    await expect(headings.first()).toBeVisible();
    const texts = (await headings.allTextContents()).map(t => t.trim());
    expect(texts.some(t => t.startsWith('web'))).toBe(true);
    expect(texts.some(t => t.startsWith('day'))).toBe(true);

    // 'day' seeds a single-app group that always overlaps with 'web' (see
    // seed-groups.ts) -- that app must render under both section headings.
    // getByRole name matching normalizes the heading's template whitespace
    // (a raw hasText regex would fail on the leading newline/indent).
    const daySection = page.getByRole('region', { name: /^day\b/ });
    const webSection = page.getByRole('region', { name: /^web\b/ });
    const dayFirstCard = daySection.locator('article.c, .rw').first();
    await expect(dayFirstCard).toBeVisible();
    const dayAppName = await dayFirstCard.locator('.dm-mono').first().innerText();
    await expect(webSection.getByText(dayAppName, { exact: true }).first()).toBeVisible();
  });

  test('group filter deep-links via ?group= and survives a reload', async ({ page }) => {
    test.skip(!seeded, 'no registry apps in the driven workspace, or daemon predates /api/groups');
    await page.goto('/?group=web');
    const webChip = page.locator('.dm-group-chip-row .dm-chip', { hasText: 'web' });
    await expect(webChip).toBeVisible({ timeout: 10_000 });
    await expect(webChip).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(webChip).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]group=web/);
  });

  test('app detail shows a group membership row/chip; omitted for an app in no group', async ({ page, baseURL }) => {
    test.skip(!seeded, 'no registry apps in the driven workspace, or daemon predates /api/groups');
    const memberApp = seeded!.day[0];
    await page.goto(`/apps/${encodeURIComponent(memberApp)}`);
    await expect(page.locator('.dm-group-chip', { hasText: 'day' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.dm-group-chip', { hasText: 'web' })).toBeVisible();

    // Clicking a detail-page group chip lands back on the filtered list.
    await page.locator('.dm-group-chip', { hasText: 'day' }).click();
    await expect(page).toHaveURL(/[?&]group=day/);

    // An app not covered by any group (the last registry app, per
    // seedRealGroups) omits the row entirely.
    const appsRes = await (await page.request.get(`${baseURL}/api/apps`)).json();
    const names: string[] = appsRes.map((a: { name: string }) => a.name);
    const ungrouped = names.find(n => !seeded!.web.includes(n) && !seeded!.day.includes(n));
    test.skip(!ungrouped, 'every registry app is covered by a seeded group in this workspace');
    await page.goto(`/apps/${encodeURIComponent(ungrouped!)}`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.dm-group-chip')).toHaveCount(0);
  });
});
