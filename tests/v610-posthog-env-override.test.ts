/**
 * TITAN — v6.1.0 Phase A · Gap 5
 *
 * `TITAN_POSTHOG_KEY` / `TITAN_POSTHOG_HOST` env vars must take
 * precedence over the schema defaults. Telemetry must be enabled
 * (otherwise the resolver short-circuits before reading either).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeLoadConfig = vi.fn();

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => fakeLoadConfig(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Captures fetch calls fired by sendPostHogEvent — we read the URL +
// Authorization-style api_key from the body to confirm overrides land.
let lastFetch: { url: string; body: Record<string, unknown> } | null = null;
const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
    lastFetch = { url, body: JSON.parse(init.body as string) };
    return { ok: true, status: 200, text: async () => '' } as unknown as Response;
});

describe('v6.1.0 Phase A — Gap 5 — PostHog env-var override', () => {
    let originalFetch: typeof globalThis.fetch;
    let originalKey: string | undefined;
    let originalHost: string | undefined;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
        originalKey = process.env.TITAN_POSTHOG_KEY;
        originalHost = process.env.TITAN_POSTHOG_HOST;
        delete process.env.TITAN_POSTHOG_KEY;
        delete process.env.TITAN_POSTHOG_HOST;
        lastFetch = null;
        fakeLoadConfig.mockReset();
        fetchSpy.mockClear();
        vi.resetModules();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.TITAN_POSTHOG_KEY;
        else process.env.TITAN_POSTHOG_KEY = originalKey;
        if (originalHost === undefined) delete process.env.TITAN_POSTHOG_HOST;
        else process.env.TITAN_POSTHOG_HOST = originalHost;
    });

    it('uses the schema default when no env vars are set', async () => {
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                posthogApiKey: 'phc_schema_default_key',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(lastFetch).not.toBeNull();
        expect(lastFetch!.url).toBe('https://us.i.posthog.com/capture/');
        expect(lastFetch!.body.api_key).toBe('phc_schema_default_key');
    });

    it('TITAN_POSTHOG_KEY overrides the schema key', async () => {
        process.env.TITAN_POSTHOG_KEY = 'phc_override_from_env';
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                posthogApiKey: 'phc_schema_default_key',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(lastFetch!.body.api_key).toBe('phc_override_from_env');
    });

    it('TITAN_POSTHOG_HOST overrides the schema host', async () => {
        process.env.TITAN_POSTHOG_HOST = 'https://eu.i.posthog.com';
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                posthogApiKey: 'phc_any_key',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(lastFetch!.url).toBe('https://eu.i.posthog.com/capture/');
    });

    it('short-circuits when telemetry is disabled (no fetch at all)', async () => {
        process.env.TITAN_POSTHOG_KEY = 'phc_override_from_env';
        fakeLoadConfig.mockReturnValue({
            telemetry: { enabled: false, posthogApiKey: 'phc_x', posthogHost: 'https://us.i.posthog.com' },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
