/**
 * TITAN — v6.1.0 Phase B — posthog-node SDK init contract
 *
 * Verifies the CLI-tuned init options + anonymous-by-default event shape
 * + that Phase A env-var precedence and EU/US detection still hold under
 * the new SDK code path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeLoadConfig = vi.fn();

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => fakeLoadConfig(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let ctorCalls: Array<{ apiKey: string; opts: Record<string, unknown> }> = [];
let captured: Array<Record<string, unknown>> = [];
let shutdownCount = 0;

vi.mock('posthog-node', () => {
    class PostHog {
        constructor(apiKey: string, opts: Record<string, unknown>) {
            ctorCalls.push({ apiKey, opts });
        }
        capture(props: Record<string, unknown>) {
            captured.push(props);
        }
        async flush() { /* no-op */ }
        async shutdown() {
            shutdownCount += 1;
        }
    }
    return { PostHog };
});

describe('v6.1.0 Phase B — posthog-node SDK init', () => {
    beforeEach(() => {
        ctorCalls = [];
        captured = [];
        shutdownCount = 0;
        delete process.env.TITAN_TELEMETRY_DISABLED;
        delete process.env.TITAN_POSTHOG_KEY;
        delete process.env.TITAN_POSTHOG_HOST;
        fakeLoadConfig.mockReset();
        vi.resetModules();
    });

    it('initializes with CLI-tuned options (flushAt:1, flushInterval:0, disableGeoip:true)', async () => {
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
        expect(ctorCalls).toHaveLength(1);
        expect(ctorCalls[0].opts.flushAt).toBe(1);
        expect(ctorCalls[0].opts.flushInterval).toBe(0);
        expect(ctorCalls[0].opts.disableGeoip).toBe(true);
    });

    it('installs a beforeExit shutdown handler that calls client.shutdown()', async () => {
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
        const before = process.listenerCount('beforeExit');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        const after = process.listenerCount('beforeExit');
        expect(after).toBeGreaterThan(before);
        // Manually invoke the most recently attached beforeExit listener.
        const listeners = process.listeners('beforeExit');
        const ours = listeners[listeners.length - 1] as (...args: unknown[]) => unknown;
        await ours(0);
        expect(shutdownCount).toBe(1);
        // Clean up so we don't leak listeners into other tests.
        process.removeListener('beforeExit', ours as never);
    });

    it('includes $process_person_profile=false on every captured event', async () => {
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
        await sendPostHogEvent({ type: 'install', installId: 'a', version: '6.1.0' });
        expect(captured.length).toBeGreaterThanOrEqual(2);
        for (const ev of captured) {
            const props = ev.properties as Record<string, unknown>;
            expect(props.$process_person_profile).toBe(false);
        }
    });

    it('preserves Phase A env-var precedence — TITAN_POSTHOG_KEY beats config', async () => {
        process.env.TITAN_POSTHOG_KEY = 'phc_from_env';
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                consentVersion: 2,
                posthogApiKey: 'phc_from_config',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent, _resetPostHogClientForTests } = await import('../src/analytics/posthog.js');
        _resetPostHogClientForTests();
        await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
        expect(ctorCalls[0].apiKey).toBe('phc_from_env');
    });

    it('preserves Phase A env-var precedence — TITAN_POSTHOG_HOST beats config', async () => {
        process.env.TITAN_POSTHOG_HOST = 'https://eu.i.posthog.com';
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
        expect(ctorCalls[0].opts.host).toBe('https://eu.i.posthog.com');
    });

    it('preserves Phase A EU detection — Europe/Berlin timezone routes to eu.i.posthog.com', async () => {
        // EU detection lives in resolvePostHogHost(); verify it directly
        // since that's what posthog.ts feeds the SDK when no env / config
        // host is set.
        const { resolvePostHogHost } = await import('../src/analytics/posthog.js');
        expect(resolvePostHogHost({ timeZone: 'Europe/Berlin' })).toBe('https://eu.i.posthog.com');
        expect(resolvePostHogHost({ timeZone: 'America/Los_Angeles' })).toBe('https://us.i.posthog.com');
    });
});
