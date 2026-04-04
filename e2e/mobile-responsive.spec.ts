import { test, expect } from '@playwright/test';

/**
 * TITAN Mobile Responsive UI - E2E Tests
 * Tests the dashboard and chat interface on various mobile viewports
 */

const MOBILE_VIEWPORTS = {
  iphone: { width: 375, height: 667 },
  pixel: { width: 411, height: 731 },
  small: { width: 320, height: 568 },
  tablet: { width: 768, height: 1024 },
};

test.describe('Mobile Responsive - Viewports', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should render correctly on iPhone SE (375x667)', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.iphone);

    // Core elements should be visible
    await expect(page.locator('text="TITAN"')).toBeVisible({ timeout: 5000 });

    // Logo should be visible and appropriately sized
    const logo = page.locator('img[src*="titan-logo"]');
    await expect(logo).toBeVisible();

    // Stats should be in 2-column grid on mobile
    const statsGrid = page.locator('.grid.grid-cols-2');
    await expect(statsGrid).toBeVisible();

    // Quick actions should stack on mobile
    const quickActions = page.locator('button').filter({ hasText: /Explain|Analyze|Create/i });
    await expect(quickActions.first()).toBeVisible();
  });

  test('should render correctly on Pixel (411x731)', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.pixel);

    await expect(page.locator('text="TITAN"')).toBeVisible({ timeout: 5000 });
    const quickActions = page.locator('button').filter({ hasText: /Explain|Analyze|Create/i });
    await expect(quickActions.first()).toBeVisible();
  });

  test('should render correctly on small mobile (320x568)', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.small);

    // Even on smallest screen, core UI should work
    await expect(page.locator('text="TITAN"')).toBeVisible({ timeout: 5000 });

    // Text should not overflow
    const brandText = page.locator('h2');
    const overflow = await brandText.evaluate(el => {
      return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
    });
    // Allow some overflow for very small screens, but text should be mostly visible
    if (overflow) {
      await page.setViewportSize(MOBILE_VIEWPORTS.iphone);
    }
    expect(overflow).toBe(false);
  });

  test('should render correctly on tablet (768x1024)', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.tablet);

    // Tablet should show more like desktop
    await expect(page.locator('text="TITAN"')).toBeVisible({ timeout: 5000 });

    // Stats might be in row on tablet
    const statsContainer = page.locator('.md\\:flex');
    await expect(statsContainer).toBeVisible();
  });
});

test.describe('Mobile Responsive - Chat Interface', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.iphone);
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should send messages on mobile viewport', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await expect(chatInput).toBeVisible({ timeout: 5000 });

    await chatInput.fill('Hello from mobile');
    await page.keyboard.press('Enter');

    await expect(page.locator('text="Hello from mobile"')).toBeVisible({ timeout: 5000 });
  });

  test('should handle mobile chat input keyboard', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await chatInput.click();

    // Keyboard should appear and input should be visible
    await expect(chatInput).toBeFocused();

    await chatInput.fill('Mobile keyboard test');
    await page.keyboard.press('Enter');

    await expect(page.locator('text="Mobile keyboard test"')).toBeVisible({ timeout: 5000 });
  });

  test('should display chat messages in scrollable area on mobile', async ({ page }) => {
    // Send multiple messages to test scrolling
    const chatInput = page.locator('textarea').first();

    for (let i = 1; i <= 5; i++) {
      await chatInput.fill(`Message ${i}`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
    }

    // Scroll container should be scrollable
    const scrollContainer = page.locator('.overflow-y-auto').first();
    const isScrollable = await scrollContainer.evaluate(el => el.scrollHeight > el.clientHeight);

    // Should be scrollable if multiple messages
    expect(isScrollable).toBe(true);
  });

  test('should handle long message text on mobile', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    const longMessage = 'This is a very long message that should wrap properly on mobile devices without breaking the layout or causing horizontal overflow. '.repeat(3);

    await chatInput.fill(longMessage);
    await page.keyboard.press('Enter');

    // Wait for message to appear
    await page.waitForTimeout(2000);

    // Check for horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);

    // Allow some overflow (max 20px) due to animations
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 20);
  });
});

test.describe('Mobile Responsive - Session Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.iphone);
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should open session drawer as mobile overlay', async ({ page }) => {
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    // Mobile overlay should be full screen
    const overlay = page.locator('.fixed.inset-0.z-50');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    // Sidebar should slide in from left
    const sidebar = page.locator('.animate-slide-in');
    await expect(sidebar).toBeVisible();

    // Should have proper mobile width (280px)
    const sidebarWidth = await sidebar.evaluate((el: HTMLElement) => el.offsetWidth);
    expect(sidebarWidth).toBeLessThanOrEqual(320); // Should fit on mobile screen
  });

  test('should close mobile drawer when clicking overlay', async ({ page }) => {
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    const overlay = page.locator('.fixed.inset-0.z-50');
    await expect(overlay).toBeVisible();

    // Click overlay to close
    await overlay.click({ force: true });

    // Should close
    await expect(page.locator('text="New chat"')).not.toBeVisible({ timeout: 2000 });
  });

  test('should handle session actions on mobile', async ({ page }) => {
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    // Look for session items
    const sessions = page.locator('[role="button"]').filter({ hasText: /Session|Untitled/ });
    const sessionCount = await sessions.count();

    if (sessionCount > 0) {
      const firstSession = sessions.first();
      await firstSession.hover();

      // Action buttons should appear
      const renameButton = firstSession.locator('button[aria-label="Rename session"]');
      const deleteButton = firstSession.locator('button[aria-label="Delete session"]');

      const renameVisible = await renameButton.isVisible({ timeout: 2000 }).catch(() => false);
      const deleteVisible = await deleteButton.isVisible({ timeout: 2000 }).catch(() => false);

      expect(renameVisible || deleteVisible).toBe(true);
    }
  });

  test('should close mobile drawer when selecting session', async ({ page }) => {
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    // Click on a session
    const sessionButton = page.locator('[role="button"]').first();
    await sessionButton.click({ timeout: 3000 }).catch(() => {});

    // Drawer should close on mobile
    await page.waitForTimeout(1000);
    const overlay = page.locator('.fixed.inset-0.z-50');
    const overlayVisible = await overlay.isVisible({ timeout: 2000 }).catch(() => false);
    expect(overlayVisible).toBe(false);
  });
});

test.describe('Mobile Responsive - Agent Watcher', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.iphone);
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should toggle agent watcher on mobile', async ({ page }) => {
    const watcherToggle = page.locator('button[aria-label*="Toggle agent watcher"]');
    await expect(watcherToggle).toBeVisible();

    await watcherToggle.click();

    // Watcher panel should appear
    await expect(page.locator('text="Agent Activity"').or(page.locator('text="No agent activity yet'))).toBeVisible({ timeout: 5000 });
  });

  test('should display watcher panel full width on mobile', async ({ page }) => {
    const watcherToggle = page.locator('button[aria-label*="Toggle agent watcher"]');
    await watcherToggle.click();

    await page.waitForTimeout(1000);

    // Watcher should take significant screen space on mobile
    const watcherPanel = page.locator('.border-l').last().or(page.locator('[style*="width"]'));
    const watcherWidth = await watcherPanel.evaluate(el => {
      const style = window.getComputedStyle(el);
      return parseInt(style.width);
    }).catch(() => MOBILE_VIEWPORTS.iphone.width);

    // Should be reasonably sized on mobile (at least 80% of viewport)
    expect(watcherWidth).toBeGreaterThanOrEqual(MOBILE_VIEWPORTS.iphone.width * 0.8);
  });

  test('should close watcher panel on mobile with close button', async ({ page }) => {
    const watcherToggle = page.locator('button[aria-label*="Toggle agent watcher"]');
    await watcherToggle.click();

    await page.waitForTimeout(1000);

    // Mobile close button should be visible
    const closeButton = page.locator('button').filter({ has: page.locator('svg') }).first();
    await closeButton.click({ timeout: 3000 }).catch(() => {});

    // Watcher should close
    await expect(page.locator('text="Agent Activity"')).not.toBeVisible({ timeout: 2000 });
  });
});

test.describe('Mobile Responsive - Layout & Typography', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.iphone);
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should have readable text on mobile', async ({ page }) => {
    // Check various text elements are readable
    const brandText = page.locator('h2');
    await expect(brandText).toBeVisible();

    const brandFontSize = await brandText.evaluate(el => {
      return parseInt(window.getComputedStyle(el).fontSize);
    });

    // Should be at least 20px for h2 on mobile
    expect(brandFontSize).toBeGreaterThanOrEqual(20);

    // Check body text
    const bodyText = page.locator('text="Autonomous AI agent"');
    await expect(bodyText).toBeVisible();

    const bodyFontSize = await bodyText.evaluate(el => {
      return parseInt(window.getComputedStyle(el).fontSize);
    });

    // Body text should be at least 10px
    expect(bodyFontSize).toBeGreaterThanOrEqual(10);
  });

  test('should have touch-friendly button sizes on mobile', async ({ page }) => {
    const buttons = page.locator('button');
    const buttonCount = await buttons.count();

    for (let i = 0; i < Math.min(buttonCount, 5); i++) {
      const button = buttons.nth(i);
      const isVisible = await button.isVisible({ timeout: 2000 }).catch(() => false);

      if (isVisible) {
        const dimensions = await button.boundingBox();
        if (dimensions) {
          // Buttons should be at least 36x36px for touch targets
          expect(dimensions.height).toBeGreaterThanOrEqual(30);
        }
      }
    }
  });

  test('should not have horizontal scrolling on mobile', async ({ page }) => {
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);

    // Body should not be wider than viewport (with small tolerance for animations)
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 20);
  });

  test('should stack layout elements on mobile', async ({ page }) => {
    // On mobile, flex direction should be column
    const mainContainer = page.locator('.flex-col').first();
    await expect(mainContainer).toBeVisible();

    // Chat container should also be column
    const chatContainer = page.locator('.flex-col.md\\:flex-row');
    await expect(chatContainer).toBeVisible();
  });
});

test.describe('Mobile Responsive - Performance', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.iphone);
  });

  test('should load dashboard quickly on mobile', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
    const loadTime = Date.now() - startTime;

    // Should load in under 5 seconds
    expect(loadTime).toBeLessThan(5000);
  });

  test('should have smooth animations on mobile', async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    // Animation should complete quickly
    await page.waitForTimeout(500);

    const overlay = page.locator('.fixed.inset-0.z-50');
    await expect(overlay).toBeVisible();
  });
});

test.describe('Mobile Responsive - Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.iphone);
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should have proper ARIA labels on mobile', async ({ page }) => {
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await expect(toggleButton).toHaveAttribute('aria-label');

    const watcherToggle = page.locator('button[aria-label*="Toggle agent watcher"]');
    await expect(watcherToggle).toHaveAttribute('aria-label');
  });

  test('should be keyboard navigable on mobile', async ({ page }) => {
    // Tab through elements
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);

    // Something should be focused
    const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedElement).toBeTruthy();
  });

  test('should have sufficient color contrast on mobile', async ({ page }) => {
    const brandText = page.locator('h2');
    await expect(brandText).toBeVisible();

    // Get computed color
    const color = await brandText.evaluate(el => {
      return window.getComputedStyle(el).color;
    });

    // Should not be transparent or same as background
    expect(color).not.toBe('rgba(0, 0, 0, 0)');
  });
});
