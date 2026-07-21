// Depends-graph page drive (M174/M176, v1.15 "Atlas"). The graph itself is
// seeded by intercepting /api/graph (the plugins-badge discipline — never
// plant state in the live daemon), so the fixture is exact: 5 apps, a chain,
// a cycle, one group. Covers: nodes/edges match the fixture, the cycle is
// flagged and named, the full keyboard round-trip (graph → arrows → Enter →
// app detail → back), cluster hulls + the up start-order preview, recolor on
// the existing refresh path, and axe zero serious/critical with clusters on.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const NODE = (name: string, over: Record<string, unknown> = {}) => ({
  name, baseName: name, status: 'serving', health: 'healthy',
  workspaceLabel: 'main', groups: [] as string[],
  dependsOn: [] as string[], dependedOnBy: [] as string[], inCycle: false,
  ...over,
});

// web → api → db chain + c1 ⇄ c2 cycle; web/api form group "day".
const VIEW = {
  workspace: null,
  nodes: [
    NODE('api', { dependsOn: ['db'], dependedOnBy: ['web'], groups: ['day'] }),
    NODE('c1', { dependsOn: ['c2'], dependedOnBy: ['c2'], inCycle: true, status: 'error', health: 'unhealthy' }),
    NODE('c2', { dependsOn: ['c1'], dependedOnBy: ['c1'], inCycle: true, status: 'stopped', health: 'unknown' }),
    NODE('db', { dependedOnBy: ['api'], status: 'stopped', health: 'unknown' }),
    NODE('web', { dependsOn: ['api'], groups: ['day'] }),
  ],
  edges: [
    { from: 'api', to: 'db' },
    { from: 'c1', to: 'c2' },
    { from: 'c2', to: 'c1' },
    { from: 'web', to: 'api' },
  ],
  levels: [['db'], ['api'], ['web']],
  cycles: [['c1', 'c2']],
  unordered: [] as string[],
  groups: [{ name: 'day', apps: ['web', 'api'], levels: [['db'], ['api'], ['web']], cyclic: [], unknown: [] }],
};

async function withGraph(page: import('@playwright/test').Page, view: object = VIEW) {
  await page.route('**/api/graph*', route => route.fulfill({ json: view }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('daimon.tourDismissed', '1'));
});

test('renders nodes and edges matching the seeded depends exactly', async ({ page }) => {
  await withGraph(page);
  await page.goto('/graph');
  for (const n of VIEW.nodes) {
    await expect(page.getByTestId(`graph-node-${n.name}`)).toBeVisible();
  }
  await expect(page.locator('svg [data-testid^="graph-node-"]')).toHaveCount(5);
  await expect(page.locator('.gp-edge')).toHaveCount(4);
  // The sr summary narrates the same structure for screen readers.
  const summary = page.getByTestId('graph-summary');
  await expect(summary).toContainText('5 apps');
  await expect(summary).toContainText('level 1: db');
});

test('a seeded cycle is visibly flagged and named', async ({ page }) => {
  await withGraph(page);
  await page.goto('/graph');
  const banner = page.getByTestId('graph-cycle-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('c1 → c2 → c1');
  await expect(page.locator('.gp-edge-cycle')).toHaveCount(2);
  // Node text carries the non-color cycle marker.
  await expect(page.getByTestId('graph-node-c1')).toContainText('cycle');
});

test('full keyboard round-trip: traverse edges with arrows, Enter opens app detail, back returns', async ({ page }) => {
  await withGraph(page);
  await page.goto('/graph');
  // Land on a node, walk dependency-ward and dependent-ward.
  await page.getByTestId('graph-node-api').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('graph-node-db')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('graph-node-api')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('graph-node-web')).toBeFocused();
  // Enter → app detail; browser back → graph again.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/apps\/web/);
  await page.goBack();
  await expect(page).toHaveURL(/\/graph/);
  await expect(page.getByTestId('graph-node-web')).toBeVisible();
});

test('group cluster hull contains exactly its members; preview matches the plannedOrder levels', async ({ page }) => {
  await withGraph(page);
  await page.goto('/graph');
  await expect(page.getByTestId('graph-hull-day')).toBeVisible();
  await expect(page.getByTestId('graph-hull-day')).toContainText('day · 2');
  const preview = page.getByTestId('graph-group-preview-day');
  await expect(preview).toContainText('level 1: db');
  await expect(preview).toContainText('level 2: api');
  await expect(preview).toContainText('level 3: web');
  // Hull geometry: both members inside, the cycle nodes outside.
  const hull = await page.getByTestId('graph-hull-day').locator('rect').boundingBox();
  const webBox = await page.getByTestId('graph-node-web').boundingBox();
  const c1Box = await page.getByTestId('graph-node-c1').boundingBox();
  expect(hull && webBox && c1Box).toBeTruthy();
  expect(webBox!.x).toBeGreaterThanOrEqual(hull!.x - 1);
  expect(webBox!.x + webBox!.width).toBeLessThanOrEqual(hull!.x + hull!.width + 1);
  const c1Inside = c1Box!.x >= hull!.x && c1Box!.x + c1Box!.width <= hull!.x + hull!.width
    && c1Box!.y >= hull!.y && c1Box!.y + c1Box!.height <= hull!.y + hull!.height;
  expect(c1Inside).toBe(false);
});

test('a status change recolors the node on the existing refresh path — no reload', async ({ page }) => {
  let killed = false;
  await page.route('**/api/graph*', route => {
    const view = killed
      ? { ...VIEW, nodes: VIEW.nodes.map(n => n.name === 'web' ? { ...n, status: 'error', health: 'unhealthy' } : n) }
      : VIEW;
    return route.fulfill({ json: view });
  });
  await page.goto('/graph');
  await expect(page.getByTestId('graph-node-web')).toHaveAttribute('data-status', 'serving');
  killed = true;
  // The page re-fetches whenever the api layer's apps signal refreshes (5s
  // poll / SSE) — no manual reload here, that's the point of the test.
  await expect(page.getByTestId('graph-node-web')).toHaveAttribute('data-status', 'error', { timeout: 15_000 });
  await expect(page.getByTestId('graph-node-web')).toContainText('error');
});

test('empty workspace view degrades to guidance, never a blank page', async ({ page }) => {
  await withGraph(page, { workspace: 'beta', nodes: [], edges: [], levels: [], cycles: [], unordered: [], groups: [] });
  await page.addInitScript(() => localStorage.setItem('daimon.workspace', 'beta'));
  await page.goto('/graph');
  await expect(page.getByTestId('graph-empty')).toBeVisible();
  await expect(page.getByTestId('graph-empty')).toContainText('beta');
});

test('axe: zero serious/critical on the graph page with clusters on', async ({ page }) => {
  await withGraph(page);
  await page.goto('/graph');
  await expect(page.getByTestId('graph-svg')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const gating = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(gating, JSON.stringify(gating, null, 2)).toEqual([]);
});
