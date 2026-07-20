// M89 — automated axe gate. Drives every route in ROUTE_PATHS (shared with
// dashboard.spec.ts so the a11y sweep never silently drifts from the route
// table) at whichever viewport project is currently running (the chromium /
// mobile-390 projects in playwright.config.ts already give us the 1280px +
// 390px matrix — no separate viewport loop needed here).
//
// Gate: zero serious/critical violations on every route. Moderate/minor
// violations are either fixed at the source or individually waived below
// with a written reason — never filtered away wholesale.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ROUTE_PATHS } from './routes';
import { seedRealGroups } from './seed-groups.ts';

test.beforeEach(async ({ page }) => {
  // Same pre-dismiss as dashboard.spec.ts — the onboarding tour's full-
  // viewport scrim would otherwise sit on top of every route and axe would
  // flag the page behind it as inert/unreachable rather than testing it.
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

// Rules waived app-wide, with reasons — re-check these periodically rather
// than treating the list as permanent:
//   (none yet — every finding found during this audit was fixed at the
//   source: tokens, ARIA labels, table scope, or canvas roles. This array
//   exists so a future waiver has an obvious place to land instead of
//   growing a second, undocumented exclusion mechanism.)
const WAIVED_RULE_IDS: string[] = [];

for (const path of ROUTE_PATHS) {
  test(`axe: ${path} has no serious/critical violations`, async ({ page }) => {
    await page.goto(path);
    // Let the route's own data fetch settle so axe scores the real content,
    // not a loading skeleton (matches the settle pattern dashboard.spec.ts
    // uses via its `expect.soft` visibility waits).
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .disableRules(WAIVED_RULE_IDS)
      .analyze();

    const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    if (blocking.length) {
      const detail = blocking.map(v =>
        `[${v.impact}] ${v.id}: ${v.help}\n  ${v.nodes.slice(0, 5).map(n => n.target.join(' ')).join('\n  ')}`,
      ).join('\n\n');
      expect(blocking, `serious/critical axe violations on ${path}:\n\n${detail}`).toEqual([]);
    }

    // Moderate/minor are reported but not gated — surfaced via a soft
    // expectation so they show up in the report without failing the run,
    // making regressions visible without re-litigating every waiver.
    const nonBlocking = results.violations.filter(v => v.impact !== 'serious' && v.impact !== 'critical');
    expect.soft(nonBlocking, `moderate/minor axe violations on ${path}`).toEqual([]);
  });
}

// M97 — named app groups: three extra page states the ROUTE_PATHS sweep
// above never exercises (chip-filtered list, grouped sections, the
// app-detail group row). Self-seeded via seedRealGroups rather than relying
// on ROUTE_PATHS-driven `npm run e2e:seed` timing/ordering — same
// independence dashboard.spec.ts's seedCrashFor / mute-badge tests have from
// the rest of the seed data.
test.describe('axe: named app groups states', () => {
  let seededApp: string | null = null;

  test.beforeAll(async ({ baseURL }) => {
    const seeded = await seedRealGroups(baseURL!);
    seededApp = seeded?.day[0] ?? null;
  });

  const axeCheck = async (page: import('@playwright/test').Page) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  };

  test('axe: /apps with grouped sections (no chip filter) has no serious/critical violations', async ({ page }) => {
    test.skip(!seededApp, 'no registry apps in the driven workspace, or daemon predates /api/groups');
    await page.goto('/apps');
    await axeCheck(page);
  });

  test('axe: /apps?group=web (chip-filtered list) has no serious/critical violations', async ({ page }) => {
    test.skip(!seededApp, 'no registry apps in the driven workspace, or daemon predates /api/groups');
    await page.goto('/apps?group=web');
    await axeCheck(page);
  });

  test('axe: app detail with group chips has no serious/critical violations', async ({ page }) => {
    test.skip(!seededApp, 'no registry apps in the driven workspace, or daemon predates /api/groups');
    await page.goto(`/apps/${encodeURIComponent(seededApp!)}`);
    await axeCheck(page);
  });
});

// M102 — Log Sense (v1.2) dashboard states the ROUTE_PATHS sweep never
// reaches: the level-chip row and a regex filter's inline error, both of
// which only render once a specific app is selected (bare '/logs' from
// ROUTE_PATHS never has an app, so never shows either). Storm banner is
// deliberately not covered here — see logs.spec.ts's header comment for why
// it can't be seeded deterministically in this harness.
test.describe('axe: log-sense states', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
  });

  const axeCheck = async (page: import('@playwright/test').Page) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  };

  test('axe: logs page with level chips visible has no serious/critical violations', async ({ page, request }) => {
    const apps: { name: string }[] = await (await request.get('/api/apps')).json();
    test.skip(!apps.length, 'no registry apps in the driven workspace');
    await page.goto(`/logs/${encodeURIComponent(apps[0].name)}`);
    await expect(page.locator('.dm-lvl-chip').first()).toBeVisible({ timeout: 10_000 });
    await axeCheck(page);
  });

  test('axe: logs page with an active level chip and an invalid-regex inline error has no serious/critical violations', async ({ page, request }) => {
    const apps: { name: string }[] = await (await request.get('/api/apps')).json();
    test.skip(!apps.length, 'no registry apps in the driven workspace');
    await page.goto(`/logs/${encodeURIComponent(apps[0].name)}`);
    await expect(page.locator('.dm-lvl-chip').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('.dm-lvl-chip[data-lvl="error"]').click();
    await page.getByRole('button', { name: /regex/i }).click();
    await page.locator('.dm-filter input').fill('(unterminated');
    await expect(page.locator('.dm-rxerr')).toBeVisible({ timeout: 5_000 });
    await axeCheck(page);
  });
});
