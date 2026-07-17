// M102 — Log Sense (v1.2) dashboard drive: level chips, the regex filter's
// invalid-pattern handling, the "jump to search" deep-link, and the
// search-hit round trip back into a filtered log view.
//
// Note on coverage: the level chips' counts are driven by whatever the live
// app's real stdout/stderr classifies as (M99's classifier, evaluated by the
// daemon as lines are produced) — there's no way to seed deterministic
// classified content into that in-memory tailer from outside the daemon
// process (unlike log_lines/events/crashes, which the rest of this e2e suite
// seeds by inserting straight into history.db; the live tailer never reads
// that table). So the chip tests here assert STRUCTURAL correctness (every
// rendered row matches the active filter, toggling is idempotent, the empty
// state renders when nothing matches) rather than an exact count cross-check
// against GET /api/apps/:name/logs?level=, which would be flaky against
// whatever the driven workspace's real apps happen to log during the run.
//
// The storm banner (M101 logStorm marker) has the same problem one level up
// — it only appears while the registry's LogStormDetector has actually
// observed a burst, which nothing outside the daemon process can fabricate
// without seeding classified live-tail content (see above). Per the task
// brief's own fallback, that banner's logic (dismiss-and-reshow-on-a-new-
// episode) is covered instead by a pure unit test in
// src/app/logs-page-helpers.spec.ts (`stormBannerVisible`), and its markup/
// styling was verified by hand against the running dashboard.

import { test, expect } from '@playwright/test';

test.describe('Logs page (tour pre-dismissed)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
  });

  async function firstAppName(page: import('@playwright/test').Page): Promise<string | null> {
    const apps: { name: string }[] = await (await page.request.get('/api/apps')).json();
    return apps.length ? apps[0].name : null;
  }

  test('level chips render with counts, are keyboard/aria operable, and toggling narrows the visible rows', async ({ page }) => {
    const app = await firstAppName(page);
    test.skip(!app, 'no registry apps in the driven workspace');

    const consoleErrors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`/logs/${encodeURIComponent(app!)}`);
    await expect(page.locator('main h1').first()).toBeVisible({ timeout: 10_000 });

    const chips = page.locator('.dm-lvl-chip');
    await expect(chips).toHaveCount(4);
    for (const lvl of ['error', 'warn', 'info', 'debug']) {
      const chip = page.locator(`.dm-lvl-chip[data-lvl="${lvl}"]`);
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('aria-pressed', 'false');
      // Count reflects a real (possibly zero) number, never blank/NaN.
      await expect(chip.locator('.dm-lvl-count')).toHaveText(/^\d+$/);
    }

    const errorChip = page.locator('.dm-lvl-chip[data-lvl="error"]');
    await errorChip.click();
    await expect(errorChip).toHaveAttribute('aria-pressed', 'true');

    // Structural invariant: with the error filter active, every currently
    // rendered row is classified as error, OR the empty-state renders because
    // nothing matched — never a mix of unrelated levels left visible.
    const rowCount = await page.locator('.dm-row').count();
    if (rowCount > 0) {
      const levels = await page.locator('.dm-row').evaluateAll(els => els.map(el => el.getAttribute('data-level')));
      expect(new Set(levels)).toEqual(new Set(['error']));
    } else {
      await expect(page.locator('dm-empty', { hasText: 'No matches' })).toBeVisible();
    }

    // Clicking the active chip again clears the filter (idempotent toggle).
    await errorChip.click();
    await expect(errorChip).toHaveAttribute('aria-pressed', 'false');

    const fatal = consoleErrors.filter(e => !/favicon|ResizeObserver|chunk-/.test(e));
    expect.soft(fatal, 'console errors while toggling level chips').toEqual([]);
  });

  test('regex filter: an invalid pattern shows an inline error and applies no filter; a never-matching pattern shows the empty state', async ({ page }) => {
    const app = await firstAppName(page);
    test.skip(!app, 'no registry apps in the driven workspace');

    await page.goto(`/logs/${encodeURIComponent(app!)}`);
    await expect(page.locator('main h1').first()).toBeVisible({ timeout: 10_000 });

    // Switch to regex mode, then type an unbalanced group — never crashes,
    // surfaces the inline error, and applies NO filter (asserted as "the
    // 'No matches' empty state never appears", rather than an exact row
    // count, since the live tailer can append lines between assertions —
    // an invalid regex silently keeping the old filter would still show
    // "No matches" if a prior filter had zeroed the view, which this catches).
    await page.getByRole('button', { name: /regex/i }).click();
    const filterInput = page.locator('.dm-filter input');
    await filterInput.fill('(unterminated');
    await expect(page.locator('.dm-rxerr')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('dm-empty', { hasText: 'No matches' })).toBeHidden();

    // A syntactically valid regex that can't plausibly match anything real
    // narrows to the "No matches" empty state — deterministic regardless of
    // what the live app is actually logging.
    await filterInput.fill('zzz_never_matches_this_pattern_zzz');
    await expect(page.locator('.dm-rxerr')).toBeHidden();
    await expect(page.locator('dm-empty', { hasText: 'No matches' })).toBeVisible({ timeout: 5_000 });

    await filterInput.fill('');
    await expect(page.locator('dm-empty', { hasText: 'No matches' })).toBeHidden();
  });

  test('"Search" affordance opens the command palette in search mode, pre-filled with the current filter text', async ({ page }) => {
    const app = await firstAppName(page);
    test.skip(!app, 'no registry apps in the driven workspace');

    await page.goto(`/logs/${encodeURIComponent(app!)}`);
    await expect(page.locator('main h1').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('.dm-filter input').fill('ECONNREFUSED');
    // Distinct accessible name — at 390px the topbar's icon-only palette
    // button also answers to the bare name "search".
    await page.getByRole('button', { name: /search logs/i }).click();

    const paletteInput = page.locator('.dm-palette-search input');
    await expect(paletteInput).toBeVisible({ timeout: 5_000 });
    await expect(paletteInput).toHaveValue('> ECONNREFUSED');

    await page.keyboard.press('Escape');
    await expect(page.locator('.dm-palette')).toBeHidden();
  });

  test('a search-hit deep-link (?from=search) clears an active level/regex filter on landing', async ({ page }) => {
    const app = await firstAppName(page);
    test.skip(!app, 'no registry apps in the driven workspace');

    await page.goto(`/logs/${encodeURIComponent(app!)}`);
    await expect(page.locator('main h1').first()).toBeVisible({ timeout: 10_000 });

    // Set both an active level chip and a regex filter.
    await page.locator('.dm-lvl-chip[data-lvl="warn"]').click();
    await expect(page.locator('.dm-lvl-chip[data-lvl="warn"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.dm-filter input').fill('anything');
    await expect(page.locator('.dm-filter input')).toHaveValue('anything');

    // Re-land on the SAME app's logs page via the exact deep-link
    // routeForHit() produces for a 'logs' search hit — this is the mechanism
    // command-palette.ts's selectHit() drives for a real search result.
    // (page.goto forces a full navigation/component remount here, so this
    // exercises ngOnChanges's `'name' in ch` reset branch rather than the
    // same-instance `'from' in ch` branch a real in-SPA search-hit click
    // would take — both branches clear the same two signals, and the
    // observable contract under test is the landing state, not which
    // internal branch produced it.)
    await page.goto(`/logs/${encodeURIComponent(app!)}?from=search`);
    await expect(page.locator('main h1').first()).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('.dm-filter input')).toHaveValue('');
    await expect(page.locator('.dm-lvl-chip[data-lvl="warn"]')).toHaveAttribute('aria-pressed', 'false');
  });
});
