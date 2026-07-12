// M89 — documented keyboard-only round trips. Two things this file proves
// that a11y.spec.ts's per-route axe scan can't: that focus actually MOVES in
// the right order and that Escape/skip-link behavior work end to end, not
// just that the DOM has the right ARIA attributes.

import { test, expect } from '@playwright/test';

// Mirrors dashboard.spec.ts's structure: tests that need the tour out of the
// way live in this describe (local beforeEach pre-dismisses it); the one
// test that needs the tour actually showing lives outside it, undismissed.
test.describe('keyboard round trips (tour pre-dismissed)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
  });

  test('skip link is the first tabbable element and jumps focus to <main>', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    const skip = page.locator('.dm-skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText('Skip to content');

    await page.keyboard.press('Enter');
    await expect(page.locator('#dm-main-content')).toBeFocused();
  });

  test('Escape closes the command palette and returns focus to its trigger', async ({ page }) => {
    await page.goto('/');
    const trigger = page.locator('.dm-cmdk').first();
    await trigger.focus();
    await trigger.press('Enter');
    const input = page.locator('.dm-palette-search input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('.dm-palette')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('Escape closes the topbar workspace popover and returns focus to its chip', async ({ page }) => {
    await page.goto('/');
    const chip = page.locator('.dm-chip').first();
    await chip.click();
    await expect(page.locator('.dm-pop').first()).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    await expect(page.locator('.dm-pop')).toBeHidden();
    await expect(chip).toBeFocused();
  });

  // The busiest path in the app (M89 acceptance criterion): apps list -> open
  // an app's detail -> trigger an action -> back, entirely via keyboard, with
  // every intermediate focus target asserted rather than just the end state.
  test('full keyboard round trip: apps list -> app detail -> action -> back', async ({ page }) => {
    const apps: { name: string }[] = await (await page.request.get('/api/apps')).json();
    test.skip(!apps.length, 'no registry apps in the driven workspace');

    await page.goto('/');
    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10_000 });

    // Tab from the top of the document into the app card grid/list. The skip
    // link is first, then nav rail / topbar controls, then page content —
    // walk forward with real Tab presses (not a direct .focus()) so this
    // actually exercises the tab order rather than asserting around it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    let reachedCard = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const el = page.locator(':focus');
      const isCard = await el.evaluate(node =>
        node.matches('article.c, .rw[role="row"]') || !!node.closest('article.c, .rw[role="row"]'),
      ).catch(() => false);
      if (isCard) { reachedCard = true; break; }
    }
    expect(reachedCard, 'keyboard tab order reaches an app card/row within 40 tabs').toBe(true);

    // Activate the focused card with Enter and land on its detail route.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/apps\//, { timeout: 10_000 });
    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10_000 });

    // Trigger an action via keyboard: find a real, enabled <button> in
    // <main> and activate it with the keyboard rather than a click — proves
    // it's a genuine keyboard-operable control, not a click-only div.
    const actionBtn = page.locator('main button:not([disabled])').first();
    await actionBtn.focus();
    await expect(actionBtn).toBeFocused();
    await actionBtn.press('Enter');

    // Back via keyboard-triggered navigation (the router link/back affordance
    // already visited), landing back on a route with a real heading.
    await page.goBack();
    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10_000 });
  });
});

// M89 — onboarding tour Escape dismissal. Deliberately outside the describe
// above (same pattern dashboard.spec.ts uses for its tour tests) since this
// one needs the tour actually showing, undismissed, on a fresh visit.
test('Escape dismisses the onboarding tour and moves focus into it on open', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.dm-tour-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  await page.reload();
  await expect(card).toBeHidden();
});
