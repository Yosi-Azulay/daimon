// First-run walkthrough card (M169, v1.14). A stranger's very first daemon
// has zero configured apps — this card teaches `daimon init` instead of
// leaving the apps list (and the overview home) a blank table. Route
// interception force-empties the apps endpoints the same way
// empty-states.spec.ts and plugins-badge.spec.ts already do, rather than
// depending on a clean DAIMON_HOME.
//
// PRIVACY: the card's own state is localStorage-only (`daimon.firstRun.dismissed`,
// distinct from the M79 product tour's `daimon.tourDismissed` so dismissing one
// never dismisses the other). Nothing here should ever produce a non-loopback
// request — the network-log assertion below is the enforcement.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const FIRST_RUN_KEY = 'daimon.firstRun.dismissed';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

async function emptyApps(page: import('@playwright/test').Page) {
  await page.route('**/api/apps*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/overview*', async route => {
    const res = await route.fetch();
    const json = await res.json().catch(() => ({}));
    json.totals = { apps: 0, serving: 0, errors: 0, stopped: 0 };
    json.needsAttention = [];
    delete json.plugins;
    await route.fulfill({ response: res, json });
  });
}

test('walkthrough card shows on /apps with zero apps, with a copy-able daimon init', async ({ page }) => {
  await emptyApps(page);
  await page.goto('/apps');
  const card = page.getByTestId('first-run-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('No apps yet');
  await expect(page.getByTestId('first-run-cmd')).toHaveText('daimon init');
  await expect(card).toContainText(/what happens next/i);
  await expect(card).toContainText(/QUICKSTART/);
});

test('walkthrough card shows on / (overview) with zero apps', async ({ page }) => {
  await emptyApps(page);
  await page.goto('/');
  await expect(page.locator('main h1', { hasText: 'Overview' })).toBeVisible({ timeout: 10_000 });
  const card = page.getByTestId('first-run-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('first-run-cmd')).toHaveText('daimon init');
});

test('copying the command writes "daimon init" to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await emptyApps(page);
  await page.goto('/apps');
  const copyBtn = page.getByTestId('first-run-copy');
  await expect(copyBtn).toBeVisible({ timeout: 10_000 });
  await copyBtn.click();
  await expect(copyBtn).toContainText('Copied');
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe('daimon init');
});

test('dismissing the card persists across reload via localStorage, never the server', async ({ page }) => {
  await emptyApps(page);
  const requests: string[] = [];
  page.on('request', r => requests.push(r.url()));

  await page.goto('/apps');
  const card = page.getByTestId('first-run-card');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('first-run-dismiss').click();
  await expect(card).toHaveCount(0);
  // The plain M160 empty state still teaches the next step — dismissing
  // never leaves a dead end.
  await expect(page.locator('.dm-empty')).toBeVisible();

  const dismissed = await page.evaluate((k) => localStorage.getItem(k), FIRST_RUN_KEY);
  expect(dismissed).toBe('1');

  await page.reload();
  await expect(page.getByTestId('first-run-card')).toHaveCount(0);
  await expect(page.locator('.dm-empty')).toBeVisible({ timeout: 10_000 });

  // No phone-home: every request stayed on the loopback API, with exactly ONE
  // documented exception — the Material Symbols icon font, which the dashboard
  // page has fetched from Google since v0.14 and which SECURITY.md names as
  // "the ONE third-party request" (self-hosting a subset is still queued).
  // It carries no daimon data and happens on every page, first-run or not.
  // Anything ELSE leaving the machine fails here, which is the point: this
  // assertion is the enforcement that first-run adds no telemetry.
  const ICON_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
  const offMachine = requests
    .map(u => ({ url: u, host: new URL(u).hostname }))
    .filter(r => !/^(127\.0\.0\.1|localhost)$/.test(r.host));
  for (const r of offMachine) {
    expect(ICON_FONT_HOSTS.has(r.host), `unexpected off-machine request: ${r.url}`).toBe(true);
  }
});

test('guided empty states on tests/report explain what will appear and link back to apps when there are no apps', async ({ page }) => {
  await emptyApps(page);
  // A fresh install has no test runs and no report either. Emptying only
  // /api/apps is not enough: the drive's seeded history still answers these
  // two, so the pages would render real cards and never reach the empty state.
  await page.route('**/api/tests*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"runs":[],"flaky":[],"threshold":3}',
  }));
  await page.route('**/api/report*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"sections":{},"since":0,"until":0}',
  }));

  await page.goto('/tests');
  await expect(page.locator('.dm-empty', { hasText: 'No apps yet' })).toBeVisible({ timeout: 10_000 });

  await page.goto('/report');
  await expect(page.locator('.dm-empty', { hasText: 'No apps yet' })).toBeVisible({ timeout: 10_000 });
});

test('axe: the walkthrough card has no serious/critical violations', async ({ page }) => {
  await emptyApps(page);
  await page.goto('/apps');
  await expect(page.getByTestId('first-run-card')).toBeVisible({ timeout: 10_000 });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking, blocking.map(v => `[${v.impact}] ${v.id}: ${v.help}`).join('\n')).toEqual([]);
});
