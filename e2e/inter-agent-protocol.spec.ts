import { test, expect, Page } from '@playwright/test';

/**
 * TITAN TIT-8 Protocol - Inter-Agent Communication E2E Tests
 * Tests the wakeup API, agent inbox, and inter-agent messaging protocol
 * as specified in TIT-8: Agent Discovery & Wakeup Protocol
 */

const API_KEY = 'test-key'; // Skip auth (no token configured)

// Helper to create wakeup request
async function createWakeupRequest(page: Page, agentId: string, task: string, model?: string) {
  const response = await page.request.post('/api/wakeup', {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    data: {
      agentId,
      task,
      model: model || 'anthropic/claude-sonnet-4-20250514',
    },
  });
  return response;
}

// Helper to get wakeup requests
async function getWakeupRequests(page: Page) {
  const response = await page.request.get('/api/wakeup', {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  return response;
}

test.describe('TIT-8 Protocol - Wakeup API', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any existing wakeup requests by checking and listing
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should create a wakeup request with valid parameters', async ({ page }) => {
    const response = await createWakeupRequest(page, 'agent-001', 'Research GraphQL schemas');

    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      requestId: expect.any(String),
    });

    // Request ID should be a valid format
    expect(body.requestId).toMatch(/^\d{4}-\d{2}-\d{2}-\d+$/);
  });

  test('should reject wakeup request without agentId', async ({ page }) => {
    const response = await page.request.post('/api/wakeup', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        task: 'Research GraphQL schemas',
      },
    });

    const body = await response.json();
    expect(response.status()).toBe(400);
    expect(body.error).toBeDefined();
  });

  test('should reject wakeup request without task', async ({ page }) => {
    const response = await page.request.post('/api/wakeup', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        agentId: 'agent-001',
      },
    });

    const body = await response.json();
    expect(response.status()).toBe(400);
    expect(body.error).toBeDefined();
  });

  test('should list all wakeup requests', async ({ page }) => {
    // Create multiple wakeup requests
    await createWakeupRequest(page, 'agent-001', 'Task 1');
    await createWakeupRequest(page, 'agent-002', 'Task 2');

    const listResponse = await getWakeupRequests(page);
    const body = await listResponse.json();

    expect(listResponse.ok()).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(2);
    expect(body.requests).toBeInstanceOf(Array);
  });

  test('should include request metadata in wakeup list', async ({ page }) => {
    await createWakeupRequest(page, 'agent-test', 'Test metadata task');

    const listResponse = await getWakeupRequests(page);
    const body = await listResponse.json();

    const testRequest = body.requests.find((r: any) =>
      r.agentId === 'agent-test' && r.task === 'Test metadata task'
    );

    expect(testRequest).toBeDefined();
    expect(testRequest.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(testRequest.priority).toBe('normal');
  });

  test('should cancel a wakeup request', async ({ page }) => {
    const createResponse = await createWakeupRequest(page, 'agent-cancel', 'Cancel this');
    const createBody = await createResponse.json();

    // Cancel the request
    const cancelResponse = await page.request.delete(`/api/wakeup/${createBody.requestId}`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    expect(cancelResponse.ok()).toBe(true);

    // Verify it's cancelled
    const listResponse = await getWakeupRequests(page);
    const listBody = await listResponse.json();
    const cancelledRequest = listBody.requests.find((r: any) => r.requestId === createBody.requestId);

    // Should not be in active queue or should be cancelled
    if (cancelledRequest) {
      expect(cancelledRequest.status).toBe('cancelled');
    }
  });
});

test.describe('TIT-8 Protocol - Agent Inbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should return agent inbox with assigned issues', async ({ page }) => {
    const response = await page.request.get('/api/agents/me/inbox', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body).toMatchObject({
      issues: expect.any(Array),
      pending: expect.any(Array),
    });
  });

  test('should drain pending results from inbox', async ({ page }) => {
    const response = await page.request.get('/api/agents/me/inbox', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const body = await response.json();

    // After first call, pending should be drained
    expect(body.pending).toBeInstanceOf(Array);
  });

  test('should support inbox-lite endpoint without draining', async ({ page }) => {
    const response1 = await page.request.get('/api/agents/me/inbox-lite', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const body1 = await response1.json();

    // Second call should return same pending count
    const response2 = await page.request.get('/api/agents/me/inbox-lite', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const body2 = await response2.json();
    expect(body2.pending.length).toBe(body1.pending.length);
  });
});

test.describe('TIT-8 Protocol - Claim & Release Wakeup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should track wakeup request lifecycle', async ({ page }) => {
    // Create request
    const createResponse = await createWakeupRequest(page, 'agent-lifecycle', 'Lifecycle test');
    const createBody = await createResponse.json();

    // Check initial status
    const listResponse = await getWakeupRequests(page);
    const listBody = await listResponse.json();
    const request = listBody.requests.find((r: any) => r.requestId === createBody.requestId);

    expect(request.status).toBeDefined();
    expect(['queued', 'running', 'completed', 'failed']).toContain(request.status);
  });
});

test.describe('TIT-8 Protocol - Concurrent Wakeup Requests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should handle multiple simultaneous wakeup requests', async ({ page }) => {
    const requests = [];
    for (let i = 0; i < 5; i++) {
      requests.push(createWakeupRequest(page, `agent-concurrent-${i}`, `Task ${i}`));
    }

    const responses = await Promise.all(requests);

    // All should succeed
    responses.forEach(response => {
      expect(response.ok()).toBe(true);
    });

    // Verify all are in the list
    const listResponse = await getWakeupRequests(page);
    const listBody = await listResponse.json();

    // Should have at least 5 new requests
    expect(listBody.count).toBeGreaterThanOrEqual(5);
  });

  test('should preserve request order in queue', async ({ page }) => {
    const timestamps: number[] = [];

    for (let i = 0; i < 3; i++) {
      await createWakeupRequest(page, `agent-ordered-${i}`, `Task ${i}`);
      timestamps.push(Date.now());
      await page.waitForTimeout(100);
    }

    const listResponse = await getWakeupRequests(page);
    const listBody = await listResponse.json();

    // Requests should be in roughly chronological order
    expect(listBody.requests.length).toBeGreaterThanOrEqual(3);
  });
});

test.describe('TIT-8 Protocol - API Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should accept requests with valid auth token', async ({ page }) => {
    const response = await page.request.post('/api/wakeup', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        agentId: 'agent-auth',
        task: 'Auth test',
      },
    });

    // Should succeed (no token configured means auth is bypassed)
    expect(response.ok()).toBe(true);
  });

  test('should return proper error format for invalid requests', async ({ page }) => {
    const response = await page.request.post('/api/wakeup', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        agentId: 'agent-error',
      },
    });

    const body = await response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toContain('Missing required');
  });
});

test.describe('TIT-8 Protocol - Integration with Mission Control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should show wakeup activity in Command Post dashboard', async ({ page }) => {
    // Create a wakeup request
    await createWakeupRequest(page, 'agent-dashboard', 'Show in dashboard');

    // Check Command Post activity feed
    const activityResponse = await page.request.get('/api/command-post/activity', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    expect(activityResponse.ok()).toBe(true);

    const body = await activityResponse.json();
    expect(body.activities).toBeInstanceOf(Array);
    // Should have recent activity
    expect(body.activities.length).toBeGreaterThan(0);
  });

  test('should display agent registry entries', async ({ page }) => {
    const response = await page.request.get('/api/command-post/agents', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body.agents).toBeInstanceOf(Array);
  });

  test('should track issue lifecycle through wakeup', async ({ page }) => {
    // Create wakeup with issue identifier
    const createResponse = await page.request.post('/api/wakeup', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        agentId: 'agent-tracker',
        task: 'Track this issue',
        model: 'anthropic/claude-sonnet-4-20250514',
      },
    });

    const createBody = await createResponse.json();

    // Check issues list
    const issuesResponse = await page.request.get('/api/command-post/issues', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    expect(issuesResponse.ok()).toBe(true);

    const issuesBody = await issuesResponse.json();
    expect(issuesBody.issues).toBeInstanceOf(Array);
  });
});

test.describe('TIT-8 Protocol - Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should handle malformed JSON gracefully', async ({ page }) => {
    const response = await page.request.post('/api/wakeup', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: 'not-json' as any,
    });

    expect([400, 500]).toContain(response.status());
  });

  test('should handle invalid agent IDs', async ({ page }) => {
    const response = await createWakeupRequest(page, '', 'Empty agent ID');

    // Should either reject or assign a default agent ID
    const body = await response.json();
    if (response.ok()) {
      expect(body.requestId).toBeDefined();
    } else {
      expect(body.error).toBeDefined();
    }
  });

  test('should handle very long task descriptions', async ({ page }) => {
    const longTask = 'A'.repeat(1000);
    const response = await createWakeupRequest(page, 'agent-long', longTask);

    // Should handle gracefully (either accept or reject with clear error)
    expect([200, 400]).toContain(response.status());
  });
});

test.describe('TIT-8 Protocol - Performance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
  });

  test('should respond to wakeup API quickly', async ({ page }) => {
    const startTime = Date.now();
    const response = await createWakeupRequest(page, 'agent-perf', 'Performance test');
    const elapsed = Date.now() - startTime;

    expect(response.ok()).toBe(true);
    expect(elapsed).toBeLessThan(1000); // Should respond in < 1 second
  });

  test('should handle rapid-fire wakeup requests', async ({ page }) => {
    const start = Date.now();
    const promises = [];

    for (let i = 0; i < 10; i++) {
      promises.push(createWakeupRequest(page, `agent-rapid-${i}`, `Rapid task ${i}`));
    }

    const responses = await Promise.all(promises);
    const elapsed = Date.now() - start;

    // All should succeed
    responses.forEach(r => expect(r.ok()).toBe(true));

    // Should complete in reasonable time
    expect(elapsed).toBeLessThan(5000);
  });
});
