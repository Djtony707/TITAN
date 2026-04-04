# TITAN E2E Tests - Playwright

End-to-end tests for TITAN Mission Control dashboard using Playwright. These tests verify the full stack from UI through API to backend.

## Test Structure

```
e2e/
├── README.md                        # This file
├── test_onboarding.spec.ts          # Onboarding wizard tests
├── mission-control.spec.ts          # Dashboard overview tests
├── chat-interface.spec.ts           # Chat functionality tests
├── admin-panels.spec.ts             # Admin panels tests
└── mobile-responsive.spec.ts        # Mobile responsive tests
```

## Test Coverage

### 1. Mission Control Dashboard (`mission-control.spec.ts`)
- Dashboard loads successfully
- Empty state with branding
- Quick action grid visibility
- Session sidebar toggle
- Agent watcher panel toggle
- Mobile viewport handling
- Stats display
- API integration (health, config endpoints)

### 2. Chat Interface (`chat-interface.spec.ts`)
- Send message and receive SSE streaming response
- Multiple message conversation handling
- Real-time token streaming display
- Tool usage indicators
- Keyboard enter functionality
- Agent thinking/loading states
- Session management (create, list, rename, delete)
- Quick actions from empty state
- Mobile chat messaging
- Error handling (empty messages, long messages, API errors)

### 3. Admin Panels (`admin-panels.spec.ts`)
- Navigation to Settings, Overview panels
- Model configuration display
- Provider configuration
- Temperature/slider controls
- Max tokens configuration
- Save settings functionality
- System/Gateway settings
- Overview statistics display
- Memory/graph statistics
- Learning, Goals, Autopilot, Workflows panels
- Skills, Agents, Memory Graph panels
- Integrations panel
- Error states handling

### 4. Mobile Responsive UI (`mobile-responsive.spec.ts`)
- Multiple mobile viewports (iPhone, Pixel, small, tablet)
- Chat messaging on mobile
- Session drawer as mobile overlay
- Agent watcher on mobile
- Layout and typography on mobile
- Touch-friendly button sizes
- No horizontal scrolling
- Stacked layout on mobile
- Performance on mobile
- Accessibility (ARIA labels, keyboard navigation, color contrast)

### 5. Onboarding Wizard (`test_onboarding.spec.ts`)
- Onboarding flow steps
- Model optgroups display
- Profile saving

## Running Tests

### Prerequisites

Make sure Playwright is installed:
```bash
npm install playwright
npx playwright install
```

### Start the Gateway

The tests expect the TITAN gateway to be running on port 48420:
```bash
npm run dev:gateway
```

Or use the webServer config (automatic):
```bash
# webServer will start automatically if no server is running
```

### Run All Tests

```bash
npm run test:e2e
```

### Run Tests with UI Mode

```bash
npm run test:e2e:ui
```

This opens the Playwright UI for interactive test debugging.

### Run Tests in Debug Mode

```bash
npm run test:e2e:debug
```

### Run Specific Test File

```bash
npx playwright test e2e/chat-interface.spec.ts
```

### Run Specific Test by Name

```bash
npx playwright test -g "should send a message and receive a response"
```

### Run Mobile Tests Only

```bash
npx playwright test -g "Mobile"
npx playwright test --project="Mobile Chrome"
npx playwright test --project="Mobile Safari"
```

### Run on Specific Browser

```bash
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit
```

### Generate HTML Report

```bash
npx playwright show-report
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TITAN_BASE_URL` | Gateway URL for tests | `http://127.0.0.1:48420` |
| `CI` | CI mode (stricter, more retries) | `false` |

Example:
```bash
TITAN_BASE_URL=http://192.168.1.11:48420 npx playwright test
```

## Test Configuration

Located in `playwright.config.ts`:
- **testDir**: `./e2e`
- **timeout**: 30s default, 10s for actions, 15s for navigation
- **retries**: 2 on CI, 0 locally
- **workers**: 1 on CI, auto-detect locally
- **reporter**: HTML + List
- **trace**: On first retry
- **screenshot**: Only on failure
- **video**: Retain on failure

## Writing New Tests

### Test Template

```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:48420/');
    await page.waitForLoadState('networkidle');
  });

  test('should do something', async ({ page }) => {
    // Your test code
  });
});
```

### Best Practices

1. **Use data-testid for selectors** when possible:
   ```typescript
   await page.getByTestId('send-button').click();
   ```

2. **Wait for network idle** before assertions:
   ```typescript
   await page.waitForLoadState('networkidle');
   ```

3. **Use timeouts wisely**:
   ```typescript
   await expect(element).toBeVisible({ timeout: 5000 });
   ```

4. **Test conditional elements** with try/catch or isVisible checks:
   ```typescript
   const isVisible = await element.isVisible().catch(() => false);
   if (isVisible) {
     // Test the element
   }
   ```

5. **Use descriptive test names**:
   ```typescript
   test('should send a message and receive a response via SSE streaming')
   ```

## CI/CD Integration

Tests run automatically in CI mode with:
- Single worker
- 2 retries
- HTML report generation
- Screenshots on failure

Add to your CI pipeline:
```yaml
- name: Install Playwright
  run: npx playwright install --with-deps

- name: Run E2E Tests
  run: npm run test:e2e
  env:
    CI: true
```

## Debugging Failed Tests

1. **Check the HTML report**:
   ```bash
   npx playwright show-report
   ```

2. **Run in debug mode**:
   ```bash
   npx playwright test --debug
   ```

3. **Run with UI mode**:
   ```bash
   npx playwright test --ui
   ```

4. **Check screenshots** in `test-results/` directory

5. **Check videos** in `test-results/` directory

## Mobile Testing

Test multiple viewports:
```typescript
const MOBILE_VIEWPORTS = {
  iphone: { width: 375, height: 667 },
  pixel: { width: 411, height: 731 },
  small: { width: 320, height: 568 },
  tablet: { width: 768, height: 1024 },
};
```

Run mobile-specific tests:
```bash
npx playwright test --project="Mobile Chrome"
npx playwright test -g "mobile"
```

## Troubleshooting

### Tests timeout
- Increase timeout in config
- Check if gateway is running
- Check network connectivity

### Element not found
- Use `waitForLoadState('networkidle')`
- Add explicit waits with timeout
- Check if element selector is correct

### Tests fail on CI but pass locally
- Check environment variables
- Check resource limits
- Increase timeouts

### Gateway not starting
- Check port 48420 is free
- Run `npm run dev:gateway` manually first
- Check logs for errors
