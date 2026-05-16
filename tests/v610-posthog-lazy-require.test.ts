/**
 * TITAN — v6.1.0 Phase B — Lazy require guarantee
 *
 * `posthog-node` MUST NOT be imported into memory until:
 *   1. `config.telemetry.enabled === true` AND
 *   2. `config.telemetry.consentVersion >= REQUIRED_CONSENT_VERSION` AND
 *   3. `TITAN_TELEMETRY_DISABLED` env is not set
 *
 * We verify by mocking `posthog-node` with a constructor spy and asserting
 * the spy was/wasn't called depending on config state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeLoadConfig = vi.fn();

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => fakeLoadConfig(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let ctorCount = 0;
let captureCount = 0;

vi.mock('posthog-node', () => {
    class PostHog {
        constructor(_apiKey: string, _opts: Record<string, unknown>) {
            ctorCount += 1;
        }
        capture(_props: Record<string, unknown>) {
            captureCount += 1;
        }
        async flush() { /* no-op */ }
        async shutdown() { /* no-op */ }
    }
    return { PostHog };
});

describe('v6.1.0 Phase B — posthog-node lazy require', () => {
    beforeEach(() => {
        ctorCount = 0;
        captureCount = 0;
        delete process.env.TITAN_TELEMETRY_DISABLED;
        delete process.env.TITAN_POSTHOG_KEY;
        delete process.env.TITAN_POSTHOG_HOST;
        fakeLoadConfig.mockReset();
        vi.resetModules();
    });

    it('does NOT instantiate PostHog when telemetry.enabled=false', async () => {
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: false,
                consentVersion: 2,
                posthogApiKey: 'phc_x',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent, _resetPostHogClientForTests } = await import('../src/analytics/posthog.js');
        _resetPostHogClientForTests();
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        expect(ctorCount).toBe(0);
        expect(captureCount).toBe(0);
    });

    it('does NOT instantiate PostHog when consentVersion < REQUIRED', async () => {
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                consentVersion: 1, // less than required (2)
                posthogApiKey: 'phc_x',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent, _resetPostHogClientForTests } = await import('../src/analytics/posthog.js');
        _resetPostHogClientForTests();
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        expect(ctorCount).toBe(0);
        expect(captureCount).toBe(0);
    });

    it('DOES instantiate PostHog when enabled + consentVersion is satisfied', async () => {
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                consentVersion: 2,
                posthogApiKey: 'phc_x',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent, _resetPostHogClientForTests } = await import('../src/analytics/posthog.js');
        _resetPostHogClientForTests();
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        expect(ctorCount).toBe(1);
        expect(captureCount).toBe(1);
    });

    it('reuses the SDK client across multiple sends (no re-instantiation)', async () => {
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                consentVersion: 2,
                posthogApiKey: 'phc_x',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent, _resetPostHogClientForTests } = await import('../src/analytics/posthog.js');
        _resetPostHogClientForTests();
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        expect(ctorCount).toBe(1); // single constructor across 3 sends
        expect(captureCount).toBe(3);
    });
});
