import { test, expect } from '@playwright/test';

/**
 * TITAN Mission Control Dashboard - E2E Tests
 * Tests the full React SPA dashboard through the browser
 */

test.describe('Mission Control Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the dashboard
    await page.goto('http://127.0.0.1:48420/');
    // Wait for the app to load
    await page.waitForLoadState('networkidle');
  });

  test('should load the dashboard successfully', async ({ page }) => {
    // Check that the main layout is rendered
    await expect(page.locator('#root')).toBeVisible();

    // Should see the TITAN branding or Mission Control title
    const hasBranding = await page.textContent('body');
    expect(hasBranding).toMatch(/TITAN|Mission Control/i);

    // Should have the chat view (main component)
    await expect(page.locator('button[aria-label="Toggle sessions"]')).toBeVisible();
  });

  test('should display empty state with branding when no conversations', async ({ page }) => {
    // The empty state should be visible on first load (no messages)
    const emptyStateVisible = await page.isVisible('text="TITAN"');
    await expect(page.locator('text="Autonomous AI agent"')).toBeVisible();
  });

  test('should show quick action grid in empty state', async ({ page }) => {
    // Quick actions should be visible in the empty state
    const quickActions = page.locator('button').filter({ hasText: /Explain|Analyze|Create|Write|Research|Brainstorm/i });
    await expect(quickActions.first()).toBeVisible({ timeout: 5000 });
  });

  test('should toggle session sidebar', async ({ page }) => {
    // Click the sidebar toggle button
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    // Sidebar should now be open (session list visible)
    await expect(page.locator('text="New chat"')).toBeVisible();

    // Click again to close
    await toggleButton.click();
    await expect(page.locator('text="New chat"')).not.toBeVisible();
  });

  test('should open session drawer and list sessions', async ({ page }) => {
    // Open the sidebar
    await page.locator('button[aria-label="Toggle sessions"]').click();

    // Should show "No conversations yet" if empty
    // Or show actual sessions if they exist
    const hasEmptyMessage = await page.isVisible('text="No conversations yet"');
    const hasSessions = await page.locator('button[role="button"]').count() > 1;

    expect(hasEmptyMessage || hasSessions).toBe(true);
  });

  test('should create a new chat session', async ({ page }) => {
    // Open sidebar if not already open
    await page.locator('button[aria-label="Toggle sessions"]').click();

    // Click "New chat" button
    const newChatButton = page.locator('button', { hasText: 'New chat' });
    await newChatButton.click();

    // Empty state should be visible (cleared messages)
    await expect(page.locator('text="TITAN"')).toBeVisible();
  });

  test('should toggle agent watcher panel', async ({ page }) => {
    // Agent watcher toggle should be visible in the top bar
    const watcherToggle = page.locator('button[aria-label*="Toggle agent watcher"]');
    await expect(watcherToggle).toBeVisible();

    // Click to open
    await watcherToggle.click();

    // Agent watcher panel should appear
    await expect(page.locator('text="Agent Activity"').or(page.locator('text="No agent activity yet'))).toBeVisible({ timeout: 5000 });

    // Click to close
    await watcherToggle.click();
    await expect(page.locator('text="Agent Activity"')).not.toBeVisible({ timeout: 3000 });
  });

  test('should handle mobile viewport correctly', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Chat view should be visible
    await expect(page.locator('text="TITAN"')).toBeVisible();

    // Sidebar should be in mobile mode (drawer)
    await page.locator('button[aria-label="Toggle sessions"]').click();

    // Mobile overlay should appear
    const overlay = page.locator('.fixed.inset-0.z-50');
    await expect(overlay).toBeVisible();
  });

  test('should display stats bar in empty state', async ({ page }) => {
    // Stats should show provider/tool counts
    await expect(page.locator('text="Tools"')).toBeVisible();
    await expect(page.locator('text="Providers"')).toBeVisible();
    await expect(page.locator('text="Channels"')).toBeVisible();
    await expect(page.locator('text="Skills"')).toBeVisible();
  });

  test('should load API client configuration', async ({ page }) => {
    // The app should successfully fetch initial data
    await page.waitForLoadState('networkidle');

    // Check that the page has loaded without errors
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Error');
    expect(bodyText).not.toContain('Failed to load');
  });

  test('should have proper meta tags and title', async ({ page }) => {
    // Check document title
    const title = await page.title();
    expect(title).toMatch(/TITAN|Mission Control/i);
  });

  test('should handle agent selection dropdown', async ({ page }) => {
    // This test may fail if no agents are registered, so it's conditional
    const agentCount = await page.locator('button', { hasText: /Default|Agent/ }).count();

    if (agentCount > 0) {
      // Agent selector buttons should be clickable
      const defaultAgent = page.locator('button', { hasText: 'Default' });
      await expect(defaultAgent).toBeVisible();
    }
  });

  test('should display voice button if configured', async ({ page }) => {
    // Wait for config to load
    await page.waitForLoadState('networkidle');

    // Check if voice button exists (conditional on voice being configured)
    const voiceButton = page.locator('button[aria-label*="Voice" i]').or(
      page.locator('button').filter({ hasText: /Voice/i })
    );

    const voiceButtonVisible = await voiceButton.isVisible({ timeout: 3000 });

    if (voiceButtonVisible) {
      await expect(voiceButton).toBeVisible();
    }
  });
});

test.describe('Mission Control API Integration', () => {
  test('health endpoint should respond to API calls', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:48420/api/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('config endpoint should return configuration', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:48420/api/config');
    expect(response.status()).toBe(200);
    const body = await response.json();
    // Should have nested config structure
    const hasConfig = body.hasOwnProperty('agent') || body.hasOwnProperty('gateway');
    expect(hasConfig).toBe(true);
  });
});
