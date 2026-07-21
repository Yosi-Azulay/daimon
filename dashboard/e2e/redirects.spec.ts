// Deep-link back-compat gate (M156, v1.12). Drives every URL shape in the
// route audit map and asserts each one still resolves to a rendered page at
// its expected pathname — a redirect is fine, a fall-through to the `**`
// catch-all (except where the entry expects `/`) or an empty page is a
// failure. This is the release's one unforgivable-bug guard: no URL that
// worked yesterday may 404 tomorrow.

import { test, expect } from '@playwright/test';
import { AUDIT_ROUTES } from './route-audit';

test.beforeEach(async ({ page }) => {
  // Onboarding tour's scrim would otherwise sit over the page; pre-dismiss it
  // so the content-visibility assertion scores the real route.
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

test.describe('deep-link back-compat: every audited URL resolves', () => {
  let appName: string | null = null;

  test.beforeAll(async ({ request }) => {
    try {
      const apps: { name: string }[] = await (await request.get('/api/apps')).json();
      appName = apps[0]?.name ?? null;
    } catch { appName = null; }
  });

  for (const route of AUDIT_ROUTES) {
    test(`resolves: ${route.url}`, async ({ page }) => {
      // A gate that skips itself is not a gate. When no app is registered, the
      // `needsApp` shapes used to skip SILENTLY — which is exactly how the
      // v1.12 `?tab=` deep-link break shipped unnoticed through two releases.
      // Fail loudly instead: the drive's job is to run against a daemon that
      // has apps (see e2e/seed.ts), and an environment without them is a
      // broken harness, not a passing run.
      if (route.needsApp && !appName) {
        throw new Error(
          `cannot verify ${route.url}: no app is registered on the daemon under test. ` +
          'Point the drive at a daemon whose searchRoots contain at least one discoverable app — ' +
          'skipping these routes would hide a deep-link regression.',
        );
      }
      const url = appName ? route.url.split(':name').join(encodeURIComponent(appName)) : route.url;
      const expectedPath = (route.resolvesTo ?? route.url.split('?')[0].split('#')[0])
        .split(':name').join(encodeURIComponent(appName ?? ''));

      await page.goto(url);
      await page.waitForLoadState('networkidle').catch(() => {});

      // Pathname must be where we expect — proves the URL resolved rather than
      // fell through to a 404. (Angular preserves query/fragment; we only
      // assert the pathname, which is what redirects change.)
      const landedPath = new URL(page.url()).pathname;
      expect(landedPath, `${route.url} (${route.note})`).toBe(expectedPath);

      // And a real page rendered — every route has a heading in <main>.
      await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10_000 });
    });
  }
});
