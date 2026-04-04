import { test, expect, Page } from '@playwright/test';

test.describe('Onboarding Wizard', () => {
  test.beforeEach(async ({ page }) => {
    // Clear the profile so the wizard shows up
    await page.evaluate(async () => {
      try {
        await fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '', technicalLevel: 'intermediate' })
        });
      } catch (e) {
        // Ignore errors if profile endpoint doesn't exist
      }
    });
  });

  test('should display onboarding wizard modal', async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');

    // Wait for the modal to be visible
    const modal = page.locator('#onboarding-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveClass(/show/);
  });

  test('should complete step 1 - user info and provider selection', async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');

    const modal = page.locator('#onboarding-modal');
    await expect(modal).toBeVisible();

    // Step 1 - Fill in user info
    await page.fill('#ob-name', 'Test User');
    await page.selectOption('#ob-level', 'expert');
    await page.click('#ob-btn-next');

    // Step 2 - Provider selection
    await expect(page.locator('#ob-step-2')).toHaveClass(/active/);

    // Click the first provider box (Local provider)
    await page.locator('.provider-box').first().click();
    await page.click('#ob-btn-next');

    // Step 3 - Autonomy level
    await expect(page.locator('#ob-step-3')).toHaveClass(/active/);
    await page.selectOption('#ob-autonomy', 'autonomous');

    const finishBtn = page.locator('#ob-btn-next');
    await expect(finishBtn).toHaveText(/Finish Setup|Complete/);
    await finishBtn.click();

    // Modal should disappear
    await expect(modal).not.toBeVisible();
    await expect(modal).not.toHaveClass(/show/);
  });

  test('should navigate through all steps', async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');

    const modal = page.locator('#onboarding-modal');
    await expect(modal).toBeVisible();

    // Verify step 1 is active
    await expect(page.locator('#ob-step-1')).toHaveClass(/active/);

    // Fill name and proceed
    await page.fill('#ob-name', 'Test User');
    await page.selectOption('#ob-level', 'beginner');
    await page.click('#ob-btn-next');

    // Verify step 2 is active
    await expect(page.locator('#ob-step-2')).toHaveClass(/active/);
    await page.click('#ob-btn-back');

    // Verify step 1 is active again
    await expect(page.locator('#ob-step-1')).toHaveClass(/active/);
  });

  test('should validate required fields', async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');

    // Try to proceed without filling name
    const nextBtn = page.locator('#ob-btn-next');
    await expect(nextBtn).toBeDisabled();

    // Fill name and verify button is enabled
    await page.fill('#ob-name', 'Test User');
    await page.selectOption('#ob-level', 'intermediate');
    await expect(nextBtn).toBeEnabled();
  });
});

test.describe('Settings and Model Configuration', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to settings page
    await page.goto('http://127.0.0.1:48420/');

    // Go to Settings
    await page.click('text="⚙️ Settings"');
  });

  test('should display model optgroups in settings', async ({ page }) => {
    // Wait for settings to load
    await page.waitForTimeout(1000);

    // Check that optgroups exist
    const optgroups = page.locator('#cfg-model optgroup');
    const count = await optgroups.count();

    // Should have at least 2 optgroups (cloud and local providers)
    expect(count).toBeGreaterThanOrEqual(2);

    const labels = await optgroups.evaluateAll(elements => elements.map((e: HTMLElement) => (e as HTMLOptGroupElement).label));

    // Check for common provider labels
    expect(labels.some(label =>
      label.toLowerCase().includes('cloud') ||
      label.toLowerCase().includes('anthropic') ||
      label.toLowerCase().includes('openai')
    )).toBeTruthy();
  });

  test('should allow model selection', async ({ page }) => {
    // Wait for settings to load
    await page.waitForTimeout(1000);

    const modelSelect = page.locator('#cfg-model');
    await expect(modelSelect).toBeVisible();

    // Get available options
    const options = page.locator('#cfg-model option');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThan(0);
  });

  test('should save settings changes', async ({ page }) => {
    // Wait for settings to load
    await page.waitForTimeout(1000);

    // Make a change
    const modelSelect = page.locator('#cfg-model');
    await modelSelect.selectOption({ index: 0 });

    // Look for save button or auto-save indicator
    const saveBtn = page.locator('text="Save"');
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
    }

    // Verify change persisted (check if select still has value)
    const selectedValue = await modelSelect.inputValue();
    expect(selectedValue).toBeTruthy();
  });
});

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should display main dashboard', async ({ page }) => {
    // Check for main dashboard elements
    await expect(page).toHaveTitle(/TITAN|Mission Control/);
  });

  test('should navigate to settings', async ({ page }) => {
    await page.click('text="⚙️ Settings"');

    // Verify settings page is loaded
    await expect(page).toHaveURL(/.*settings|.*admin/);
  });

  test('should display chat interface', async ({ page }) => {
    // Look for chat input or main chat area
    const chatInput = page.locator('textarea[placeholder*="message"], input[placeholder*="message"]');
    await expect(chatInput).toBeVisible();
  });
});
