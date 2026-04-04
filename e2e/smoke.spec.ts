import { test, expect } from '@playwright/test';

test.describe('TITAN Smoke Tests', () => {
  test('should verify gateway health endpoint', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:48420/api/health');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body).toMatchObject({
      status: expect.any(String),
    });
  });

  test('should serve the dashboard', async ({ page }) => {
    const response = await page.goto('http://127.0.0.1:48420/');
    expect(response?.status()).toBe(200);
  });

  test('should have config endpoint', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:48420/api/config');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    // Config should have nested structure
    expect(body).toHaveProperty('agent');
  });

  test('should have models endpoint', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:48420/api/models');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    // Models should be an object with provider keys
    expect(typeof body).toBe('object');
  });
});
