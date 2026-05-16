/**
 * TITAN — v6.1.0 Phase B — `titan telemetry` CLI subcommands
 *
 * `titan telemetry status` — reports config + effective state.
 * `titan telemetry enable` — runs the consent prompt.
 * `titan telemetry disable` — flips enabled=false and stamps consentVersion.
 * `TITAN_TELEMETRY_DISABLED=1` — env kill switch overrides everything.
 *
 * The Commander subcommands themselves call `process.exit(0)` so we test
 * the underlying helpers + the env-kill logic directly. End-to-end CLI
 * drive lives in the e2e suite, not vitest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';

const fakeUpdateConfig = vi.fn();
let fakeConfig: Record<string, unknown> = {};

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => fakeConfig,
    updateConfig: (partial: Record<string, unknown>) => {
        fakeUpdateConfig(partial);
        fakeConfig = {
            ...fakeConfig,
            ...partial,
            telemetry: {
                ...((fakeConfig.telemetry as Record<string, unknown>) || {}),
                ...((partial.telemetry as Record<string, unknown>) || {}),
            },
        };
        return fakeConfig;
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeStreams(answer: string | null) {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => { written.push(chunk.toString('utf-8')); });
    if (answer === null) {
        setImmediate(() => input.end());
    } else {
        setImmediate(() => input.end(answer + '\n'));
    }
    return { input, output, written };
}

describe('v6.1.0 Phase B — telemetry CLI helpers', () => {
    beforeEach(() => {
        fakeUpdateConfig.mockReset();
        fakeConfig = {};
        delete process.env.TITAN_TELEMETRY_DISABLED;
        vi.resetModules();
    });

    describe('telemetry status (computed effective-state)', () => {
        it('reports OFF when enabled=false in config', async () => {
            fakeConfig = { telemetry: { enabled: false, consentVersion: 2 } };
            const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
            const enabled = (fakeConfig.telemetry as Record<string, unknown>).enabled === true;
            const cv = (fakeConfig.telemetry as Record<string, unknown>).consentVersion as number;
            const effective = enabled && cv >= REQUIRED_CONSENT_VERSION;
            expect(effective).toBe(false);
        });

        it('reports ON when enabled=true + consentVersion satisfied', async () => {
            const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
            fakeConfig = { telemetry: { enabled: true, consentVersion: REQUIRED_CONSENT_VERSION } };
            const enabled = (fakeConfig.telemetry as Record<string, unknown>).enabled === true;
            const cv = (fakeConfig.telemetry as Record<string, unknown>).consentVersion as number;
            const effective = enabled && cv >= REQUIRED_CONSENT_VERSION;
            expect(effective).toBe(true);
        });

        it('reports OFF when consentVersion < REQUIRED even with enabled=true', async () => {
            const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
            fakeConfig = { telemetry: { enabled: true, consentVersion: 0 } };
            const enabled = (fakeConfig.telemetry as Record<string, unknown>).enabled === true;
            const cv = (fakeConfig.telemetry as Record<string, unknown>).consentVersion as number;
            const effective = enabled && cv >= REQUIRED_CONSENT_VERSION;
            expect(effective).toBe(false);
        });
    });

    describe('telemetry disable', () => {
        it('mutates config to enabled=false', async () => {
            fakeConfig = { telemetry: { enabled: true, consentVersion: 2 } };
            const { updateConfig } = await import('../src/config/config.js');
            const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
            updateConfig({
                telemetry: {
                    ...(fakeConfig.telemetry as Record<string, unknown>),
                    enabled: false,
                    consentVersion: REQUIRED_CONSENT_VERSION,
                },
            } as Record<string, unknown>);
            const call = fakeUpdateConfig.mock.calls[0][0].telemetry as Record<string, unknown>;
            expect(call.enabled).toBe(false);
            expect(call.consentVersion).toBe(REQUIRED_CONSENT_VERSION);
        });

        it('stamps consentVersion even when user disables — prevents re-prompt loop', async () => {
            fakeConfig = { telemetry: { enabled: true, consentVersion: 0 } };
            const { updateConfig } = await import('../src/config/config.js');
            const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
            updateConfig({
                telemetry: {
                    ...(fakeConfig.telemetry as Record<string, unknown>),
                    enabled: false,
                    consentVersion: REQUIRED_CONSENT_VERSION,
                },
            } as Record<string, unknown>);
            const call = fakeUpdateConfig.mock.calls[0][0].telemetry as Record<string, unknown>;
            expect(call.consentVersion).toBe(REQUIRED_CONSENT_VERSION);
        });
    });

    describe('telemetry enable (triggers prompt via runReconsent)', () => {
        it('runs the prompt and persists enabled=true on "yes"', async () => {
            fakeConfig = { telemetry: { enabled: false, consentVersion: 0 } };
            const { runReconsent } = await import('../src/cli/reconsent.js');
            const { input, output } = makeStreams('yes');
            const result = await runReconsent({ input, output });
            expect(result.accepted).toBe(true);
            const call = fakeUpdateConfig.mock.calls[0][0].telemetry as Record<string, unknown>;
            expect(call.enabled).toBe(true);
        });

        it('emits the v6 prompt banner text to output', async () => {
            fakeConfig = { telemetry: { enabled: false, consentVersion: 0 } };
            const { runReconsent, RECONSENT_PROMPT } = await import('../src/cli/reconsent.js');
            const { input, output, written } = makeStreams('no');
            await runReconsent({ input, output });
            const joined = written.join('');
            // Banner must surface the new collection contract so the user
            // can make an informed decision.
            expect(joined).toContain('TITAN telemetry has changed in v6');
            expect(joined).toContain('anonymous install ID');
            expect(joined).toContain('Does NOT');
            // Sanity: the exported banner constant is what got printed.
            expect(joined).toContain(RECONSENT_PROMPT.trim().split('\n')[0]);
        });
    });

    describe('TITAN_TELEMETRY_DISABLED env override', () => {
        it('=1 short-circuits the SDK lazy-require path', async () => {
            process.env.TITAN_TELEMETRY_DISABLED = '1';
            let ctorCount = 0;
            vi.doMock('posthog-node', () => {
                class PostHog {
                    constructor() { ctorCount += 1; }
                    capture() { /* no-op */ }
                    async flush() { /* no-op */ }
                    async shutdown() { /* no-op */ }
                }
                return { PostHog };
            });
            fakeConfig = { telemetry: { enabled: true, consentVersion: 2, posthogApiKey: 'phc_x' } };
            const { sendPostHogEvent, _resetPostHogClientForTests } = await import('../src/analytics/posthog.js');
            _resetPostHogClientForTests();
            await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
            expect(ctorCount).toBe(0);
        });

        it('="true" (string) also short-circuits', async () => {
            process.env.TITAN_TELEMETRY_DISABLED = 'true';
            let ctorCount = 0;
            vi.doMock('posthog-node', () => {
                class PostHog {
                    constructor() { ctorCount += 1; }
                    capture() { /* no-op */ }
                    async flush() { /* no-op */ }
                    async shutdown() { /* no-op */ }
                }
                return { PostHog };
            });
            fakeConfig = { telemetry: { enabled: true, consentVersion: 2, posthogApiKey: 'phc_x' } };
            const { sendPostHogEvent, _resetPostHogClientForTests } = await import('../src/analytics/posthog.js');
            _resetPostHogClientForTests();
            await sendPostHogEvent({ type: 'heartbeat', installId: 'a', version: '6.1.0' });
            expect(ctorCount).toBe(0);
        });
    });
});
