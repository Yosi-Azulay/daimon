// M112 — Report page print stylesheet: a token-layer @media print override
// (dashboard/src/styles/tokens.css) plus structural chrome hides
// (dashboard/src/styles.scss). Verifies emulateMedia({ media: 'print' })
// renders clean black-on-white regardless of the active theme, with
// nav/topbar/chord-hints/period-switcher hidden and every report section
// still present; a `media: 'screen'` pass is the regression guard that
// screen rendering was never touched.
//
// Expects: daimon daemon running at DAIMON_BASE_URL (default 127.0.0.1:4999).

import { test, expect } from '@playwright/test';

test.describe('Report page print stylesheet', () => {
  test.beforeEach(async ({ page }) => {
    // Same tour pre-dismiss as dashboard.spec.ts — the onboarding scrim would
    // otherwise sit over the page and confuse the visibility assertions.
    await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
  });

  test('print media: nav/topbar/chord-hints/period-switcher hidden, sections visible, black-on-white', async ({ page }) => {
    // Force dark theme explicitly before navigating — the print sheet must
    // override this, not merely happen to agree with a light default.
    await page.addInitScript(() => localStorage.setItem('daimon.theme', 'dark'));
    await page.goto('/report');
    await expect(page.locator('main h1', { hasText: 'Report' })).toBeVisible({ timeout: 10_000 });
    // Confirm dark mode actually took effect on screen before switching media,
    // so the print assertions below are proven to override something real.
    await expect(page.locator('html')).toHaveAttribute('style', /color-scheme:\s*dark/);

    await page.emulateMedia({ media: 'print' });

    // Chrome hidden: nav rail, topbar (carries the ⌘K chord-hint kbd), and
    // the Report page's own refresh button + period/app-scope switcher.
    await expect(page.locator('.dm-rail')).toBeHidden();
    await expect(page.locator('.dm-topbar')).toBeHidden();
    await expect(page.locator('.dm-header-actions')).toBeHidden();
    await expect(page.locator('.dm-controls')).toBeHidden();

    // Every report section still renders (data or degraded note — same
    // contract as the M85 screen drive in dashboard.spec.ts).
    for (const title of ['Uptime', 'Errors', 'Tests', 'Compiles', 'Agents', 'Env changes']) {
      await expect(page.locator('.dm-panel-title', { hasText: title }).first()).toBeVisible();
    }
    await expect(page.locator('.dm-panel-title', { hasText: /Crashes/ }).first()).toBeVisible();
    const panelCount = await page.locator('.dm-panel').count();
    expect(panelCount, 'print keeps all 7 report sections').toBeGreaterThanOrEqual(7);

    // Clean black-on-white regardless of the dark theme forced above: body
    // background resolves to white/transparent, text resolves near-black.
    const { bg, fg } = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    const isWhiteOrTransparent = /^rgba?\(255,\s*255,\s*255/.test(bg) || /^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg);
    expect(isWhiteOrTransparent, `body background should be white/transparent in print, got ${bg}`).toBe(true);
    const fgMatch = fg.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    expect(fgMatch, `body color should be a resolvable rgb(a), got ${fg}`).not.toBeNull();
    const [r, g, b] = fgMatch!.slice(1, 4).map(Number);
    expect(Math.max(r, g, b), `body text should be near-black in print, got ${fg}`).toBeLessThanOrEqual(51); // #333 ceiling
  });

  test('screen media: nav/topbar chrome stays visible (regression guard)', async ({ page }) => {
    await page.goto('/report');
    await expect(page.locator('main h1', { hasText: 'Report' })).toBeVisible({ timeout: 10_000 });

    await page.emulateMedia({ media: 'screen' });

    await expect(page.locator('.dm-rail')).toBeVisible();
    await expect(page.locator('.dm-topbar')).toBeVisible();
    await expect(page.locator('.dm-controls')).toBeVisible();
  });
});
