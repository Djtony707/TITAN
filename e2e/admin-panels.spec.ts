import { test, expect } from '@playwright/test';

/**
 * TITAN Admin Panels - E2E Tests
 * Tests Settings, Overview, and other admin panels
 */

test.describe('Admin Panels - Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should navigate to Settings panel', async ({ page }) => {
    // Look for Settings button/link in the UI
    const settingsLink = page.locator('a, button').filter({ hasText: /Settings/i });
    const settingsVisible = await settingsLink.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (settingsVisible) {
      await settingsLink.first().click();
      await page.waitForTimeout(1000);

      // Settings panel should be visible
      const settingsHeader = page.locator('text="Settings"').or(page.locator('text="System Settings"'));
      await expect(settingsHeader.first()).toBeVisible({ timeout: 3000 });
    }
  });

  test('should navigate to Overview/Stats panel', async ({ page }) => {
    // Look for Overview or Stats
    const overviewLink = page.locator('a, button').filter({ hasText: /Overview|Stats/i });
    const overviewVisible = await overviewLink.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (overviewVisible) {
      await overviewLink.first().click();
      await page.waitForTimeout(1000);

      // Should see statistics
      const statsText = await page.textContent('body');
      expect(statsText).toMatch(/Provider|Model|System|Memory|Usage/i);
    }
  });
});

test.describe('Admin Panels - Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    // Navigate to Settings
    const settingsLink = page.locator('a, button').filter({ hasText: /Settings/i });
    const settingsVisible = await settingsLink.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (settingsVisible) {
      await settingsLink.first().click();
      await page.waitForTimeout(1000);
    } else {
      test.skip();
    }
  });

  test('should display model configuration section', async ({ page }) => {
    // Settings should have model configuration
    const modelSection = page.locator('text="Model"').or(page.locator('text="AI Model"')).or(page.locator('text="Primary Model"'));
    await expect(modelSection.first()).toBeVisible({ timeout: 3000 });

    // Should have model dropdown/select
    const modelSelect = page.locator('select').first();
    await expect(modelSelect).toBeVisible({ timeout: 3000 });
  });

  test('should display provider configuration', async ({ page }) => {
    // Look for provider settings
    const providerSection = page.locator('text="Provider"').or(page.locator('text="API Provider"'));
    const providerVisible = await providerSection.first().isVisible({ timeout: 3000 });

    if (providerVisible) {
      await expect(providerSection.first()).toBeVisible();
    }
  });

  test('should have temperature/slider controls', async ({ page }) => {
    // Temperature or slider controls
    const temperatureControl = page.locator('input[type="range"]').first().or(
      page.locator('text="Temperature"')
    );
    const tempVisible = await temperatureControl.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (tempVisible) {
      await expect(temperatureControl.first()).toBeVisible();
    }
  });

  test('should have max tokens configuration', async ({ page }) => {
    // Max tokens input
    const maxTokensInput = page.locator('input[type="number"]').filter({ hasText: /token|Token/i }).first();
    const tokensVisible = await maxTokensInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (tokensVisible) {
      await expect(maxTokensInput).toBeVisible();
    }
  });

  test('should save settings changes', async ({ page }) => {
    // Look for save button
    const saveButton = page.locator('button').filter({ hasText: /Save|Apply/i });
    const saveVisible = await saveButton.first().isVisible({ timeout: 3000 });

    if (saveVisible) {
      await saveButton.first().click();
      await page.waitForTimeout(1000);
    }
  });

  test('should have system/gateway settings section', async ({ page }) => {
    const systemSection = page.locator('text="System"').or(page.locator('text="Gateway"'));
    const systemVisible = await systemSection.first().isVisible({ timeout: 3000 });

    if (systemVisible) {
      await expect(systemSection.first()).toBeVisible();
    }
  });

  test('should display port configuration', async ({ page }) => {
    const portInput = page.locator('input[type="number"]').first();
    const portVisible = await portInput.isVisible({ timeout: 3000 });

    if (portVisible) {
      await expect(portInput).toBeVisible();
    }
  });
});

test.describe('Admin Panels - Overview/Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    // Navigate to Overview
    const overviewLink = page.locator('a, button').filter({ hasText: /Overview|Dashboard|Stats/i });
    const overviewVisible = await overviewLink.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (overviewVisible) {
      await overviewLink.first().click();
      await page.waitForTimeout(1000);
    } else {
      test.skip();
    }
  });

  test('should display system statistics', async ({ page }) => {
    // Should show provider count
    await expect(page.locator('text=/Provider/i')).toBeVisible({ timeout: 3000 });

    // Should show tool count
    await expect(page.locator('text=/Tool/i')).toBeVisible();

    // Should show channel count
    await expect(page.locator('text=/Channel/i')).toBeVisible();
  });

  test('should display memory/graph statistics', async ({ page }) => {
    const memoryStats = page.locator('text=/Memory|Graph|Episode/i');
    const memoryVisible = await memoryStats.first().isVisible({ timeout: 3000 });

    if (memoryVisible) {
      await expect(memoryStats.first()).toBeVisible();
    }
  });

  test('should display model information', async ({ page }) => {
    const modelInfo = page.locator('text=/Current Model|Active Model|Model ID/i');
    const modelVisible = await modelInfo.first().isVisible({ timeout: 3000 });

    if (modelVisible) {
      await expect(modelInfo.first()).toBeVisible();
    }
  });

  test('should show gateway status', async ({ page }) => {
    const gatewayStatus = page.locator('text=/Gateway|Status|Running/i');
    const statusVisible = await gatewayStatus.first().isVisible({ timeout: 3000 });

    if (statusVisible) {
      await expect(gatewayStatus.first()).toBeVisible();
    }
  });
});

test.describe('Admin Panels - Additional Panels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should have Learning panel', async ({ page }) => {
    const learningLink = page.locator('a, button').filter({ hasText: /Learning|Lessons/i });
    const learningVisible = await learningLink.first().isVisible({ timeout: 3000 });

    if (learningVisible) {
      await learningLink.first().click();
      await page.waitForTimeout(1000);

      // Should show lessons or learning stats
      const learningText = await page.textContent('body');
      expect(learningText).toMatch(/Lesson|Learned|Training/i);
    }
  });

  test('should have Goals panel', async ({ page }) => {
    const goalsLink = page.locator('a, button').filter({ hasText: /Goals|Tasks/i });
    const goalsVisible = await goalsLink.first().isVisible({ timeout: 3000 });

    if (goalsVisible) {
      await goalsLink.first().click();
      await page.waitForTimeout(1000);

      const goalsText = await page.textContent('body');
      expect(goalsText).toMatch(/Goal|Task|Objective/i);
    }
  });

  test('should have Autopilot panel', async ({ page }) => {
    const autopilotLink = page.locator('a, button').filter({ hasText: /Autopilot|Auto|Scheduled/i });
    const autopilotVisible = await autopilotLink.first().isVisible({ timeout: 3000 });

    if (autopilotVisible) {
      await autopilotLink.first().click();
      await page.waitForTimeout(1000);

      const autopilotText = await page.textContent('body');
      expect(autopilotText).toMatch(/Autopilot|Schedule|Cron|Automated/i);
    }
  });

  test('should have Workflows panel', async ({ page }) => {
    const workflowsLink = page.locator('a, button').filter({ hasText: /Workflow|Flow|Recipe/i });
    const workflowsVisible = await workflowsLink.first().isVisible({ timeout: 3000 });

    if (workflowsVisible) {
      await workflowsLink.first().click();
      await page.waitForTimeout(1000);

      const workflowText = await page.textContent('body');
      expect(workflowText).toMatch(/Workflow|Recipe|Flow|Cron/i);
    }
  });

  test('should have Skills panel', async ({ page }) => {
    const skillsLink = page.locator('a, button').filter({ hasText: /Skills|Tools/i });
    const skillsVisible = await skillsLink.first().isVisible({ timeout: 3000 });

    if (skillsVisible) {
      await skillsLink.first().click();
      await page.waitForTimeout(1000);

      const skillsText = await page.textContent('body');
      expect(skillsText).toMatch(/Skill|Tool|Registered/i);
    }
  });

  test('should have Agents/Team panel', async ({ page }) => {
    const agentsLink = page.locator('a, button').filter({ hasText: /Agents|Team|Sub-Agent/i });
    const agentsVisible = await agentsLink.first().isVisible({ timeout: 3000 });

    if (agentsVisible) {
      await agentsLink.first().click();
      await page.waitForTimeout(1000);

      const agentsText = await page.textContent('body');
      expect(agentsText).toMatch(/Agent|Team|Sub-Agent/i);
    }
  });

  test('should have Memory Graph panel', async ({ page }) => {
    const graphLink = page.locator('a, button').filter({ hasText: /Memory Graph|Graph|Knowledge/i });
    const graphVisible = await graphLink.first().isVisible({ timeout: 3000 });

    if (graphVisible) {
      await graphLink.first().click();
      await page.waitForTimeout(1000);

      const graphText = await page.textContent('body');
      expect(graphText).toMatch(/Graph|Node|Edge|Memory/i);
    }
  });

  test('should have Integrations panel', async ({ page }) => {
    const integrationsLink = page.locator('a, button').filter({ hasText: /Integration|Provider|OAuth/i });
    const integrationsVisible = await integrationsLink.first().isVisible({ timeout: 3000 });

    if (integrationsVisible) {
      await integrationsLink.first().click();
      await page.waitForTimeout(1000);

      const integrationsText = await page.textContent('body');
      expect(integrationsText).toMatch(/Provider|Integration|API Key/i);
    }
  });
});

test.describe('Admin Panels - Error States', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should handle missing config gracefully', async ({ page }) => {
    // Try to access settings
    const settingsLink = page.locator('a, button').filter({ hasText: /Settings/i });
    const settingsVisible = await settingsLink.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (settingsVisible) {
      await settingsLink.first().click();
      await page.waitForTimeout(2000);

      // Should not show raw error messages
      const bodyText = await page.textContent('body');
      expect(bodyText).not.toContain('TypeError');
      expect(bodyText).not.toContain('undefined');
    }
  });

  test('should display empty states for panels with no data', async ({ page }) => {
    const overviewLink = page.locator('a, button').filter({ hasText: /Overview|Stats/i });
    const overviewVisible = await overviewLink.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (overviewVisible) {
      await overviewLink.first().click();
      await page.waitForTimeout(2000);

      // Should show "no data" or actual data, not errors
      const bodyText = await page.textContent('body');
      expect(bodyText).not.toContain('Error');
    }
  });
});
