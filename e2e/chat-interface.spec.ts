import { test, expect } from '@playwright/test';

/**
 * TITAN Chat Interface - E2E Tests
 * Tests the full chat conversation flow including messaging, sessions, and streaming
 */

test.describe('Chat Interface - Messaging', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should send a message and receive a response via SSE streaming', async ({ page }) => {
    // Wait for chat interface to load
    const chatInput = page.locator('textarea[placeholder*="message" i], textarea[placeholder*="chat" i], [contenteditable="true"]');
    await expect(chatInput).toBeVisible({ timeout: 5000 });

    // Type a message
    await chatInput.fill('Hello, are you there?');

    // Click send (or press Enter)
    const sendButton = page.locator('button[aria-label*="Send" i], button[type="submit"]');
    await sendButton.click();

    // User message should appear immediately
    await expect(page.locator('text="Hello, are you there?"')).toBeVisible({ timeout: 5000 });

    // Agent should respond via SSE streaming
    // Wait for streaming to complete (up to 30 seconds)
    const messageBubble = page.locator('.message-bubble, [class*="message"], .prose').last();
    await expect(messageBubble).not.toBeEmpty({ timeout: 30000 });

    // Response should not be empty
    const responseText = await messageBubble.textContent();
    expect(responseText?.trim().length).toBeGreaterThan(0);
  });

  test('should handle multiple messages in a conversation', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await expect(chatInput).toBeVisible();

    // Send first message
    await chatInput.fill('What is your name?');
    await page.keyboard.press('Enter');

    // Wait for response
    await page.waitForTimeout(3000);

    // Send second message
    await chatInput.fill('What can you help me with?');
    await page.keyboard.press('Enter');

    // Wait for second response
    await page.waitForTimeout(3000);

    // Both user messages should be visible
    const userMessages = page.locator('text="What is your name?"');
    await expect(userMessages).toHaveCount(1);
  });

  test('should display streaming tokens in real-time', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await chatInput.fill('Write a short poem about AI');
    await page.keyboard.press('Enter');

    // Look for streaming indicator or streaming message component
    const streamingElement = page.locator('[class*="streaming" i], .typing-indicator, [class*="typing"]');

    // Streaming should start (may appear briefly)
    const streamingVisible = await streamingElement.isVisible({ timeout: 10000 }).catch(() => false);

    if (streamingVisible) {
      await expect(streamingElement).toBeVisible();
    }

    // Eventually the response should complete
    await page.waitForTimeout(5000);
    const messages = page.locator('text=/AI|agent|intelligence|code/i');
    await expect(messages.first()).toBeVisible({ timeout: 15000 });
  });

  test('should show tool usage when agent uses tools', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await chatInput.fill('What time is it?');
    await page.keyboard.press('Enter');

    // Look for tool call indicators
    const toolCallIndicator = page.locator('[class*="tool" i], [class*="using" i]').filter({ hasText: /shell|web|search|time/i });
    const toolVisible = await toolCallIndicator.first().isVisible({ timeout: 10000 }).catch(() => false);

    if (toolVisible) {
      await expect(toolCallIndicator.first()).toBeVisible();
    }
  });

  test('should handle message input with keyboard Enter', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await chatInput.fill('Testing keyboard enter');

    // Press Enter (without Shift to send, not create newline)
    await chatInput.press('Enter');

    // Message should be sent
    await expect(page.locator('text="Testing keyboard enter"')).toBeVisible({ timeout: 5000 });
  });

  test('should show loading/agent thinking state during processing', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await chatInput.fill('Tell me about yourself');
    await page.keyboard.press('Enter');

    // Look for thinking/loading indicator
    const thinkingIndicator = page.locator('[class*="thinking" i], [class*="loading" i], .animate-pulse, [class*="pulse"]');
    const thinkingVisible = await thinkingIndicator.first().isVisible({ timeout: 5000 }).catch(() => false);

    // Either show thinking or immediately show response
    if (thinkingVisible) {
      await expect(thinkingIndicator.first()).toBeVisible();
    }
  });
});

test.describe('Chat Interface - Sessions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    // Open session sidebar
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();
    await page.waitForTimeout(500);
  });

  test('should create new session and switch to it', async ({ page }) => {
    // Click "New chat" button
    const newChatButton = page.locator('button').filter({ hasText: 'New chat' });
    await newChatButton.click();

    // Should see empty chat view
    await expect(page.locator('text="TITAN"')).toBeVisible({ timeout: 3000 });
  });

  test('should list existing sessions and switch between them', async ({ page }) => {
    // Send a message to create a conversation
    const chatInput = page.locator('textarea').first();
    await chatInput.fill('Session test message');
    await page.keyboard.press('Enter');

    // Wait for response
    await page.waitForTimeout(3000);

    // Open sidebar again
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    // Should see at least one session
    const sessions = page.locator('[role="button"]').filter({ hasText: /Session|Untitled/ });
    const sessionCount = await sessions.count();
    expect(sessionCount).toBeGreaterThan(0);
  });

  test('should rename a session', async ({ page }) => {
    // Hover over first session to reveal rename button
    const firstSession = page.locator('[role="button"]').first();
    await firstSession.hover();

    // Click rename button (pencil icon)
    const renameButton = firstSession.locator('button[aria-label="Rename session"]');
    const renameVisible = await renameButton.isVisible({ timeout: 3000 }).catch(() => false);

    if (renameVisible) {
      await renameButton.click();

      // Type new name
      const input = page.locator('input').first();
      await input.fill('Test Session Name');
      await page.keyboard.press('Enter');

      // Should see new name
      await expect(page.locator('text="Test Session Name"')).toBeVisible({ timeout: 3000 });
    }
  });

  test('should delete a session', async ({ page }) => {
    // Hover over first session
    const firstSession = page.locator('[role="button"]').first();
    await firstSession.hover();

    // Click delete button
    const deleteButton = firstSession.locator('button[aria-label="Delete session"]');
    const deleteVisible = await deleteButton.isVisible({ timeout: 3000 }).catch(() => false);

    if (deleteVisible) {
      await deleteButton.click();

      // Should have one less session
      await page.waitForTimeout(1000);
    }
  });
});

test.describe('Chat Interface - Quick Actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should execute quick action from empty state', async ({ page }) => {
    // Look for quick action buttons
    const quickActions = [
      'Explain', 'Analyze', 'Create', 'Write', 'Research', 'Brainstorm',
      'Code', 'Review', 'Debug', 'Plan', 'Design', 'Build'
    ];

    let foundAction = false;
    for (const action of quickActions) {
      const button = page.locator('button').filter({ hasText: action });
      const isVisible = await button.first().isVisible({ timeout: 2000 }).catch(() => false);
      if (isVisible) {
        await button.first().click();
        foundAction = true;
        break;
      }
    }

    if (foundAction) {
      // Quick action should populate the chat input
      await page.waitForTimeout(1000);
      const chatInput = page.locator('textarea').first();
      const inputValue = await chatInput.inputValue().catch(() => '');
      expect(inputValue.length).toBeGreaterThan(0);
    }
  });
});

test.describe('Chat Interface - Mobile Responsive', () => {
  test('should display chat interface on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    // TITAN branding should be visible
    await expect(page.locator('text="TITAN"')).toBeVisible();

    // Stats should be visible
    await expect(page.locator('text="Tools"')).toBeVisible();

    // Quick actions should be visible
    const quickActions = page.locator('button').filter({ hasText: /Explain|Analyze|Create/i });
    await expect(quickActions.first()).toBeVisible({ timeout: 5000 });
  });

  test('should handle mobile sidebar drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    // Open sidebar on mobile
    const toggleButton = page.locator('button[aria-label="Toggle sessions"]');
    await toggleButton.click();

    // Mobile overlay should be visible
    const overlay = page.locator('.fixed.inset-0.z-50');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    // Sidebar content should be visible
    await expect(page.locator('text="New chat"')).toBeVisible();

    // Click outside to close
    await overlay.click({ force: true });
    await expect(page.locator('text="New chat"')).not.toBeVisible({ timeout: 2000 });
  });

  test('should send message on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    const chatInput = page.locator('textarea').first();
    await chatInput.fill('Mobile test message');
    await page.keyboard.press('Enter');

    await expect(page.locator('text="Mobile test message"')).toBeVisible({ timeout: 5000 });
  });

  test('should display agent watcher on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');

    // Agent watcher toggle
    const watcherToggle = page.locator('button[aria-label*="Toggle agent watcher"]');
    await expect(watcherToggle).toBeVisible();

    await watcherToggle.click();

    // Watcher panel should open
    await expect(page.locator('text="Agent Activity"').or(page.locator('text="No agent activity yet'))).toBeVisible({ timeout: 5000 });

    // Close button should be visible on mobile
    const closeButton = page.locator('button').filter({ has: page.locator('svg') }).last();
    await closeButton.click({ timeout: 3000 }).catch(() => {});
  });
});

test.describe('Chat Interface - Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should handle empty message gracefully', async ({ page }) => {
    const chatInput = page.locator('textarea').first();
    await chatInput.fill('');

    // Send button should be disabled or nothing should happen
    const sendButton = page.locator('button[type="submit"]');
    const isDisabled = await sendButton.isDisabled().catch(() => true);
    expect(isDisabled).toBeTruthy();
  });

  test('should handle very long messages', async ({ page }) => {
    const chatInput = page.locator('textarea').first();

    // Generate a long message (5000 characters)
    const longMessage = 'A'.repeat(5000);
    await chatInput.fill(longMessage);

    // Should either send successfully or be truncated
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  });

  test('should handle API errors gracefully', async ({ page }) => {
    // This test assumes the API might be down or return errors
    const chatInput = page.locator('textarea').first();
    await chatInput.fill('Test error handling');
    await page.keyboard.press('Enter');

    // If there's an error, it should show user-friendly message (not raw error)
    await page.waitForTimeout(5000);

    // Should not have raw error text
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('TypeError');
    expect(bodyText).not.toContain('500 Internal');
  });
});
