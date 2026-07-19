// M137 (v1.8 "Rewind") — the dashboard Timeline: density strip + brush, kind
// filter, roving keyboard navigation with an aria-live announcement, and the
// `?ts=`/`?session=` deep-link targets. The underlying `/api/history/timeline`
// and `/api/sessions/<id>` calls are intercepted with a small deterministic
// fixture (same rationale as agents.spec.ts's synthetic roster — brushing and
// keyboard math need known, stable timestamps rather than whatever the live
// e2e daemon happens to have recorded).

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const NOW = Date.now();
const ROW_COUNT = 30;

// Newest-first, one row per minute going back — matches the API's own
// ordering convention (see daimon-api.ts getTimeline callers).
const ROWS = Array.from({ length: ROW_COUNT }, (_, i) => {
  let kind = 'status';
  if ([3, 7, 12].includes(i)) kind = 'error';
  else if (i === 20) kind = 'compile';
  else if (i === 25) kind = 'warning';
  return {
    ts: NOW - i * 60_000,
    app: i % 2 === 0 ? 'web-admin' : 'api-gateway',
    kind,
    summary: `Event ${i}`,
    payload: { i },
  };
});

const SESSION_DETAIL = {
  id: 's-fixture',
  start: ROWS[20].ts,
  end: ROWS[5].ts,
  durationMs: ROWS[5].ts - ROWS[20].ts,
  endedCleanly: true,
  current: false,
  apps: ['web-admin', 'api-gateway'],
  errorCount: 3,
  testRunCount: 0,
  compileCount: 1,
  blocks: {
    apps: { started: ['web-admin'], stopped: [] },
    errors: { note: 'fixture' },
    tests: { note: 'fixture' },
    compiles: { note: 'fixture' },
    crashes: { note: 'fixture' },
    env: { note: 'fixture' },
  },
};

async function withTimelineFixture(page: import('@playwright/test').Page) {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
  await page.route('**/api/history/timeline*', async route => {
    try { await route.fulfill({ json: ROWS }); }
    catch { try { await route.abort(); } catch {} }
  });
  await page.route('**/api/sessions/s-fixture', async route => {
    try { await route.fulfill({ json: SESSION_DETAIL }); }
    catch { try { await route.abort(); } catch {} }
  });
}

function headerCounts(page: import('@playwright/test').Page) {
  return page.locator('.dm-page-sub');
}

// The toolbar's kind-filter chip and each row's own kind badge both carry
// class `dm-kind-chip` + `[data-kind=...]` (shared coloring rules) — scope to
// the toolbar so the locator is unambiguous.
function kindChip(page: import('@playwright/test').Page, kind: string) {
  return page.locator(`.dm-toolbar .dm-kind-chip[data-kind="${kind}"]`);
}

test.describe('Timeline (M137)', () => {
  test.beforeEach(async ({ page }) => {
    await withTimelineFixture(page);
  });

  test('loads with the full fixture and shows the density strip', async ({ page }) => {
    await page.goto('/timeline');
    await expect(headerCounts(page)).toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);
    await expect(page.locator('.dm-tl-density')).toBeVisible();
    await expect(page.locator('.dm-tl-density-svg rect')).toHaveCount(48);
  });

  test('kind filter hides and re-shows a kind', async ({ page }) => {
    await page.goto('/timeline');
    await expect(headerCounts(page)).toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);

    const errorChip = kindChip(page, 'error');
    await expect(errorChip).toHaveClass(/active/);
    await errorChip.click();
    await expect(errorChip).not.toHaveClass(/active/);
    // 3 rows are kind:error in the fixture.
    await expect(headerCounts(page)).toContainText(`${ROW_COUNT - 3} of ${ROW_COUNT} events`);
    await expect(page.locator('.dm-tl-row[data-kind="error"]')).toHaveCount(0);

    await errorChip.click();
    await expect(headerCounts(page)).toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);
  });

  test('dragging the density strip brushes a narrower range, and reset restores it', async ({ page }) => {
    await page.goto('/timeline');
    await expect(headerCounts(page)).toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);

    const strip = page.locator('.dm-tl-density');
    const box = await strip.boundingBox();
    if (!box) throw new Error('density strip has no bounding box');

    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const rangeBar = page.locator('.dm-range-bar');
    await expect(rangeBar).toBeVisible();
    // The list follows: filtered count must have narrowed below the total.
    await expect(headerCounts(page)).not.toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);
    await expect(headerCounts(page)).toContainText(`of ${ROW_COUNT} events`);

    await page.getByRole('button', { name: 'Reset range' }).click();
    await expect(rangeBar).toBeHidden();
    await expect(headerCounts(page)).toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);
  });

  test('keyboard round-trip: arrows move focus, Home/End jump to the edges, aria-live announces each move', async ({ page }) => {
    await page.goto('/timeline');
    await expect(headerCounts(page)).toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);

    const viewport = page.locator('.dm-tl-viewport');
    const live = page.locator('.dm-page [role="status"][aria-live="polite"]');
    await viewport.focus();

    await viewport.press('ArrowDown');
    await expect(live).toContainText('Event 0');
    await expect(page.locator('.dm-tl-row.dm-tl-kbfocus')).toHaveCount(1);

    await viewport.press('ArrowDown');
    await expect(live).toContainText('Event 1');

    await viewport.press('ArrowUp');
    await expect(live).toContainText('Event 0');

    await viewport.press('End');
    await expect(live).toContainText(`Event ${ROW_COUNT - 1}`);

    await viewport.press('Home');
    await expect(live).toContainText('Event 0');
    await expect(page.locator('.dm-tl-row.dm-tl-kbfocus')).toHaveCount(1);
  });

  test('Enter on the keyboard-focused row opens its drawer', async ({ page }) => {
    await page.goto('/timeline');
    const viewport = page.locator('.dm-tl-viewport');
    await viewport.focus();
    await viewport.press('ArrowDown');
    await viewport.press('Enter');
    const drawer = page.locator('.dm-tl-drawer');
    await expect(drawer).toBeVisible();
    // The drawer shows app/kind/ts + the raw JSON payload, not the row's
    // one-line summary — assert on the payload it actually renders.
    await expect(drawer).toContainText('web-admin');
    await expect(drawer).toContainText('"i": 0');
  });

  test('?ts= deep link lands on and highlights the matching event', async ({ page }) => {
    const target = ROWS[10];
    await page.goto(`/timeline?ts=${target.ts}`);
    const anchored = page.locator('.dm-tl-row.dm-tl-anchored');
    await expect(anchored).toBeVisible();
    await expect(anchored).toContainText('Event 10');
    await expect(page.locator('.dm-tl-drawer')).toContainText('"i": 10');
  });

  test('?app= deep link presets the app filter', async ({ page }) => {
    await page.goto('/timeline?app=web-admin');
    await expect(headerCounts(page)).toContainText('app web-admin');
  });

  test('?session= deep link sets the range to the session bounds', async ({ page }) => {
    await page.goto('/timeline?session=s-fixture');
    await expect(page.locator('.dm-range-bar')).toBeVisible();
    await expect(headerCounts(page)).toContainText('session');
    await expect(headerCounts(page)).toContainText('s-fixture');
    // Session covers rows[20..5] inclusive-ish (16 rows); narrower than the full 30.
    await expect(headerCounts(page)).not.toContainText(`${ROW_COUNT} of ${ROW_COUNT} events`);
  });

  test('axe: timeline with an active kind filter and a brushed range has no serious/critical violations', async ({ page }) => {
    await page.goto('/timeline');
    await kindChip(page, 'error').click();
    const strip = page.locator('.dm-tl-density');
    const box = await strip.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(blocking, blocking.map(v => `[${v.impact}] ${v.id}: ${v.help}`).join('\n')).toEqual([]);
  });
});
