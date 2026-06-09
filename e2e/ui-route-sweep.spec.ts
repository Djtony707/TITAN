import { test, expect } from '@playwright/test';

/**
 * Whole-web-UI sweep: load every major screen like a user clicking through the
 * app, and fail a route only if it CRASHES (uncaught pageerror) or white-screens
 * (#root stays empty). "Disabled" states still count as rendered. Runs against
 * TITAN_BASE_URL (staging).
 */

const ROUTES: Array<[string, string]> = [
  ['/', 'dashboard'],
  ['/chat', 'chat'],
  ['/missions', 'missions'],
  ['/missions/library', 'mission library'],
  ['/missions/workflow-builder', 'workflow builder'],
  ['/missions/goals', 'goals'],
  ['/missions/issues', 'issues'],
  ['/missions/approvals', 'approvals'],
  ['/missions/activity', 'activity'],
  ['/missions/work', 'work'],
  ['/studio', 'live studio'],
  ['/knowledge/memory-taxonomy', 'memory taxonomy'],
  ['/knowledge/memory-graph', 'memory graph'],
  ['/knowledge/self-improve', 'self improve'],
  ['/knowledge/autoresearch', 'autoresearch'],
  ['/knowledge/dreams', 'dreams'],
  ['/knowledge/wiki', 'wiki'],
  ['/tools/skills', 'skills'],
  ['/tools/observability', 'observability'],
  ['/tools/evals', 'evals'],
  ['/tools/integrations', 'integrations'],
  ['/tools/channels', 'channels'],
  ['/tools/recipes', 'recipes'],
  ['/tools/files', 'files'],
  ['/tools/mcp', 'mcp'],
  ['/tools/mesh', 'mesh'],
  ['/system/security', 'security'],
  ['/system/audit', 'audit'],
  ['/system/costs', 'costs'],
  ['/system/cron', 'cron'],
  ['/system/vram', 'vram'],
  ['/system/gpu', 'gpu'],
  ['/system/homelab', 'homelab'],
  ['/system/logs', 'logs'],
  ['/system/backup-recovery', 'backup'],
  ['/system/settings', 'settings'],
  ['/team/agents', 'agents'],
  ['/team/org-chart', 'org chart'],
  ['/team/personas', 'personas'],
  ['/soma', 'soma'],
];

async function dismissOverlays(page: import('@playwright/test').Page) {
  for (const name of [/skip/i, /close/i, /later/i, /not now/i, /dismiss/i]) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) await btn.click().catch(() => {});
  }
}

for (const [route, label] of ROUTES) {
  test(`renders without crashing: ${label} (${route})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await dismissOverlays(page);
    // The SPA mounted real content (no white-screen crash).
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15000 });
    // No uncaught exception bubbled up while rendering this screen.
    expect(errors, `uncaught errors on ${route}:\n${errors.join('\n')}`).toEqual([]);
  });
}
