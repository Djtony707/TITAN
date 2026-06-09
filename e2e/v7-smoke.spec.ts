import { test, expect } from '@playwright/test';

/**
 * v7.0 reliable smoke — proves the v7.0 features work end-to-end against the
 * running gateway (TITAN_BASE_URL). API assertions are state-independent; the UI
 * checks are lenient (app mounts + new panels reachable) and modal-resilient, so
 * this is a dependable ship-gate (unlike the legacy state/selector-coupled specs).
 */

test.describe('v7.0 — API surface', () => {
  test('gateway is healthy', async ({ request }) => {
    const r = await request.get('/api/health');
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).status).toBe('ok');
  });

  test('memory taxonomy: 9 named types incl. the drive-backed emotional differentiator', async ({ request }) => {
    const r = await request.get('/api/memory/taxonomy');
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.total).toBeGreaterThanOrEqual(9);
    const emotional = (d.types as Array<{ key: string; differentiator?: boolean }>).find(t => t.key === 'emotional');
    expect(emotional?.differentiator).toBe(true);
  });

  test('security self-audit returns a findings array', async ({ request }) => {
    const r = await request.get('/api/security/audit');
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray((await r.json()).findings)).toBeTruthy();
  });

  test('observability traces: summary + OTel export shapes', async ({ request }) => {
    const s = await request.get('/api/traces/summary');
    expect(s.ok()).toBeTruthy();
    expect(await s.json()).toHaveProperty('totalRuns');
    const e = await request.get('/api/traces/export');
    expect(e.ok()).toBeTruthy();
    expect(await e.json()).toHaveProperty('resourceSpans');
  });

  test('new v7.0 skills are registered (codebase_explore + delegate_agent)', async ({ request }) => {
    const r = await request.get('/api/skills');
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    const arr = Array.isArray(body) ? body : (body.skills || body.tools || []);
    const names = arr.map((x: unknown) => (typeof x === 'string' ? x : (x as { name?: string }).name));
    expect(names).toContain('codebase_explore');
    expect(names).toContain('delegate_agent');
  });

  test('config + models endpoints serve', async ({ request }) => {
    expect((await request.get('/api/config')).ok()).toBeTruthy();
    expect((await request.get('/api/models')).ok()).toBeTruthy();
  });
});

test.describe('v7.0 — UI mounts + new panels reachable', () => {
  // Dismiss any blocking onboarding/modal overlay so panel content is reachable.
  async function dismissOverlays(page: import('@playwright/test').Page) {
    for (const name of [/skip/i, /close/i, /later/i, /not now/i, /dismiss/i, /^×$/]) {
      const btn = page.getByRole('button', { name }).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) { await btn.click().catch(() => {}); }
    }
  }

  test('dashboard shell mounts', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/TITAN/i);
    // #root gets real content (the SPA mounted, no white-screen crash).
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15000 });
  });

  for (const [route, label] of [
    ['/system/security', 'Security'],
    ['/knowledge/memory-taxonomy', 'Memory Taxonomy'],
    ['/tools/observability', 'Observability'],
    ['/missions/workflow-builder', 'Workflow Builder'],
    ['/studio', 'Live Studio'],
  ] as const) {
    test(`panel renders: ${label}`, async ({ page }) => {
      await page.goto(route);
      await dismissOverlays(page);
      // The panel's PageHeader title should be visible (any of the matches).
      await expect(page.getByText(label, { exact: false }).first()).toBeVisible({ timeout: 15000 });
    });
  }
});
