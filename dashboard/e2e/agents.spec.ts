// M126 (v1.6) — the Agent Ledger: the agents page's roster (merged live +
// audit-derived agents, M123) and contention (per-app lock-wait/steal
// hotspots, M124) sections. Rather than seeding real multi-agent contention
// against the live e2e daemon (fragile timing, cross-test pollution — see
// plugins-badge.spec.ts's header for the same rationale), the /api/agents
// response is intercepted and given a synthetic `roster`/`contention` block:
// the page renders from those keys alone, which is exactly the contract
// under test.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

const SYNTHETIC_ROSTER = [
  {
    id: 'macbook-1234-ab12',
    lastSeen: Date.now() - 5_000,
    active: true,
    cwd: '/Users/dev/workspace/daimon',
    callCount: 42,
    firstSeen: Date.now() - 3_600_000,
    actions: { start: 3, stop: 1, status: 12 },
    locks: ['web-app'],
    waits: 2,
    steals: 1,
  },
  {
    id: '(unknown)',
    lastSeen: Date.now() - 120_000,
    active: false,
    cwd: null,
    callCount: 7,
    firstSeen: Date.now() - 7_200_000,
    actions: { list: 7 },
    locks: [],
    waits: 0,
    steals: 0,
  },
];

const SYNTHETIC_CONTENTION = {
  hotspots: [
    {
      app: 'web-app',
      waits: 4,
      steals: 2,
      stealsLive: 1,
      stealsAfterExpiry: 1,
      longestHoldMs: 65_000,
    },
  ],
};

async function withAgentsRoster(
  page: import('@playwright/test').Page,
  opts: { roster?: object[] | null; contention?: object | null } = {},
) {
  await page.route('**/api/agents*', async route => {
    // The page polls /api/agents every few seconds; a poll can fire while the
    // context is tearing down at test end, so route.fetch()/fulfill() may throw
    // "Target … has been closed". Swallow that race — it never means a failure.
    try {
      const response = await route.fetch();
      const json = await response.json();
      if (opts.roster === null) delete json.roster;
      else json.roster = opts.roster ?? SYNTHETIC_ROSTER;
      if (opts.contention === null) delete json.contention;
      else json.contention = opts.contention ?? SYNTHETIC_CONTENTION;
      json.advisoryIdentity = true;
      // Keep the legacy `locks` map consistent with the synthetic roster's
      // `locks: ['web-app']` row so the "expires in" TTL line has data to read.
      json.locks = { 'web-app': { agent: 'macbook-1234-ab12', lockedAt: Date.now() - 10_000, expiresAt: Date.now() + 20_000 } };
      await route.fulfill({ response, json });
    } catch {
      try { await route.abort(); } catch { /* context already gone */ }
    }
  });
}

test('roster rows render with id, state, and per-action chips', async ({ page }) => {
  await withAgentsRoster(page);
  await page.goto('/agents');
  const rows = page.getByTestId('roster-row');
  await expect(rows).toHaveCount(2);

  const active = page.locator('[data-testid="roster-row"][data-agent-id="macbook-1234-ab12"]');
  await expect(active).toBeVisible();
  await expect(active).toContainText('active');
  await expect(active).toContainText('42');
  const chips = active.getByTestId('action-chip');
  await expect(chips).toHaveCount(3);
  await expect(chips.filter({ hasText: 'start' })).toContainText('×3');
  await expect(chips.filter({ hasText: 'stop' })).toContainText('×1');
});

test('unknown-id rows are visibly flagged', async ({ page }) => {
  await withAgentsRoster(page);
  await page.goto('/agents');
  const unknown = page.locator('[data-testid="roster-row"][data-agent-id="(unknown)"]');
  await expect(unknown).toBeVisible();
  await expect(unknown.getByTestId('agent-unknown')).toBeVisible();
  await expect(unknown).toContainText('idle');
});

test('recent-actions link deep-links into the timeline', async ({ page }) => {
  await withAgentsRoster(page);
  await page.goto('/agents');
  const link = page.getByTestId('agent-timeline-link').first();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /\/timeline/);
});

test('contention section renders a hotspot with waits/steals/longest-hold', async ({ page }) => {
  await withAgentsRoster(page);
  await page.goto('/agents');
  const section = page.getByTestId('contention-section');
  await expect(section).toBeVisible();
  const hotspot = page.getByTestId('contention-hotspot');
  await expect(hotspot).toHaveCount(1);
  await expect(hotspot).toContainText('web-app');
  await expect(hotspot).toContainText('4 waits');
  await expect(hotspot).toContainText('2 steals');
  await expect(hotspot).toContainText('after expiry');
  await expect(hotspot).toContainText('1m 5s');
});

test('contention empty state renders when there are no hotspots', async ({ page }) => {
  await withAgentsRoster(page, { contention: { hotspots: [] } });
  await page.goto('/agents');
  await expect(page.getByTestId('contention-empty')).toBeVisible();
  await expect(page.getByTestId('contention-hotspot')).toHaveCount(0);
});

test('advisory-identity footnote is present', async ({ page }) => {
  await withAgentsRoster(page);
  await page.goto('/agents');
  const footnote = page.getByTestId('advisory-footnote');
  await expect(footnote).toBeVisible();
  await expect(footnote).toContainText('self-declared');
});

test('falls back to the legacy agents list when roster is absent (pre-v1.6 daemon)', async ({ page }) => {
  await withAgentsRoster(page, { roster: null, contention: null });
  await page.goto('/agents');
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByTestId('roster-row')).toHaveCount(0);
  // The advisory footnote is a page-level constant, independent of roster
  // support, so it still renders in the legacy fallback path.
  await expect(page.getByTestId('advisory-footnote')).toBeVisible();
});

test('axe: agents page with roster and contention has no serious/critical violations', async ({ page }) => {
  await withAgentsRoster(page);
  await page.goto('/agents');
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByTestId('roster-row').first()).toBeVisible();
  await expect(page.getByTestId('contention-section')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking, blocking.map(v => `[${v.impact}] ${v.id}: ${v.help}`).join('\n')).toEqual([]);
});
