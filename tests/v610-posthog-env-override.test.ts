/**
 * TITAN — v6.1.0 Phase A · Gap 5 — PostHog env-var override
 *
 * `TITAN_POSTHOG_KEY` / `TITAN_POSTHOG_HOST` env vars must take
 * precedence over the schema defaults. Telemetry must be enabled
 * AND `consentVersion >= REQUIRED_CONSENT_VERSION` (Phase B re-consent
 * gate) — otherwise the resolver short-circuits before either is read.
 *
 * Phase B migrated the implementation from hand-rolled `fetch()` to the
 * `posthog-node` SDK. This test verifies precedence by mocking the SDK
 * constructor and reading the `host` / api-key it was instantiated with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeLoadConfig = vi.fn();

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => fakeLoadConfig(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock posthog-node — capture constructor args + every `capture()` call.
let postHogCtorCalls: Array<{ apiKey: string; opts: Record<string, unknown> }> = [];
let capturedEvents: Array<Record<string, unknown>> = [];

vi.mock('posthog-node', () => {
    class PostHog {
        public apiKey: string;
        public opts: Record<string, unknown>;
        constructor(apiKey: string, opts: Record<string, unknown>) {
            this.apiKey = apiKey;
            this.opts = opts;
            postHogCtorCalls.push({ apiKey, opts });
        }
        capture(props: Record<string, unknown>) {
            capturedEvents.push(props);
        }
        async flush() { /* no-op */ }
        async shutdown() { /* no-op */ }
    }
    return { PostHog };
});

describe('v6.1.0 Phase A — Gap 5 — PostHog env-var override (Phase B SDK migration)', () => {
    let originalKey: string | undefined;
    let originalHost: string | undefined;
    let originalDisabled: string | undefined;

    beforeEach(() => {
        originalKey = process.env.TITAN_POSTHOG_KEY;
        originalHost = process.env.TITAN_POSTHOG_HOST;
        originalDisabled = process.env.TITAN_TELEMETRY_DISABLED;
        delete process.env.TITAN_POSTHOG_KEY;
        delete process.env.TITAN_POSTHOG_HOST;
        delete process.env.TITAN_TELEMETRY_DISABLED;
        postHogCtorCalls = [];
        capturedEvents = [];
        fakeLoadConfig.mockReset();
        vi.resetModules();
    });

    afterEach(() => {
        if (originalKey === undefined) delete process.env.TITAN_POSTHOG_KEY;
        else process.env.TITAN_POSTHOG_KEY = originalKey;
        if (originalHost === undefined) delete process.env.TITAN_POSTHOG_HOST;
        else process.env.TITAN_POSTHOG_HOST = originalHost;
        if (originalDisabled === undefined) delete process.env.TITAN_TELEMETRY_DISABLED;
        else process.env.TITAN_TELEMETRY_DISABLED = originalDisabled;
    });

    it('uses the schema default when no env vars are set', async () => {
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                consentVersion: 2,
                posthogApiKey: 'phc_schema_default_key',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(postHogCtorCalls).toHaveLength(1);
        expect(postHogCtorCalls[0].apiKey).toBe('phc_schema_default_key');
        expect(postHogCtorCalls[0].opts.host).toBe('https://us.i.posthog.com');
    });

    it('TITAN_POSTHOG_KEY overrides the schema key', async () => {
        process.env.TITAN_POSTHOG_KEY = 'phc_override_from_env';
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                consentVersion: 2,
                posthogApiKey: 'phc_schema_default_key',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(postHogCtorCalls[0].apiKey).toBe('phc_override_from_env');
    });

    it('TITAN_POSTHOG_HOST overrides the schema host', async () => {
        process.env.TITAN_POSTHOG_HOST = 'https://eu.i.posthog.com';
        fakeLoadConfig.mockReturnValue({
            telemetry: {
                enabled: true,
                consentVersion: 2,
                posthogApiKey: 'phc_any_key',
                posthogHost: 'https://us.i.posthog.com',
            },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(postHogCtorCalls[0].opts.host).toBe('https://eu.i.posthog.com');
    });

    it('short-circuits when telemetry is disabled (no SDK ever loaded)', async () => {
        process.env.TITAN_POSTHOG_KEY = 'phc_override_from_env';
        fakeLoadConfig.mockReturnValue({
            telemetry: { enabled: false, consentVersion: 2, posthogApiKey: 'phc_x', posthogHost: 'https://us.i.posthog.com' },
        });
        const { sendPostHogEvent } = await import('../src/analytics/posthog.js');
        await sendPostHogEvent({ type: 'heartbeat', installId: 'test-id', version: '6.1.0' });
        expect(postHogCtorCalls).toHaveLength(0);
    });
});
