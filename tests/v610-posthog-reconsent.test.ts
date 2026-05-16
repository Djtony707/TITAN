/**
 * TITAN — v6.1.0 Phase B — Re-consent flow
 *
 * v5.x users who opted in to telemetry must be re-prompted before any
 * v6 payload flows. Default deny: anything other than "yes" / "y" turns
 * telemetry off. `consentVersion` always lands at the current required
 * value so we don't re-prompt forever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';

const fakeUpdateConfig = vi.fn();
let fakeConfig: Record<string, unknown> = {};

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => fakeConfig,
    updateConfig: (partial: Record<string, unknown>) => {
        fakeUpdateConfig(partial);
        // Mirror the merge so subsequent loadConfig() reads see the new state.
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

/**
 * Make a duplex stream pair the reconsent module can read from. The
 * input side is a `PassThrough` that we manually write into; the output
 * side captures every banner / confirmation line for assertions.
 */
function makeStreams(answer: string | null) {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => { written.push(chunk.toString('utf-8')); });
    if (answer === null) {
        // Simulate EOF / Ctrl-D: end the stream without writing anything.
        setImmediate(() => input.end());
    } else {
        setImmediate(() => input.end(answer + '\n'));
    }
    return { input, output, written };
}

describe('v6.1.0 Phase B — telemetry re-consent flow', () => {
    beforeEach(() => {
        fakeUpdateConfig.mockReset();
        fakeConfig = {};
        vi.resetModules();
    });

    it('prompts when enabled=true and consentVersion < REQUIRED_CONSENT_VERSION', async () => {
        fakeConfig = { telemetry: { enabled: true, consentVersion: 0 } };
        const { needsReconsent } = await import('../src/cli/reconsent.js');
        expect(needsReconsent()).toBe(true);
    });

    it('"yes" turns telemetry ON and sets consentVersion to REQUIRED', async () => {
        fakeConfig = { telemetry: { enabled: true, consentVersion: 0 } };
        const { runReconsent } = await import('../src/cli/reconsent.js');
        const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
        const { input, output } = makeStreams('yes');
        const result = await runReconsent({ input, output });
        expect(result.accepted).toBe(true);
        expect(result.enabled).toBe(true);
        expect(result.consentVersion).toBe(REQUIRED_CONSENT_VERSION);
        const call = fakeUpdateConfig.mock.calls[0]?.[0]?.telemetry as Record<string, unknown>;
        expect(call.enabled).toBe(true);
        expect(call.consentVersion).toBe(REQUIRED_CONSENT_VERSION);
    });

    it('"no" turns telemetry OFF and stamps consentVersion (no re-prompt loop)', async () => {
        fakeConfig = { telemetry: { enabled: true, consentVersion: 0 } };
        const { runReconsent } = await import('../src/cli/reconsent.js');
        const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
        const { input, output } = makeStreams('no');
        const result = await runReconsent({ input, output });
        expect(result.accepted).toBe(false);
        expect(result.enabled).toBe(false);
        expect(result.consentVersion).toBe(REQUIRED_CONSENT_VERSION);
    });

    it('empty / EOF / Ctrl-C is treated as "no" — defaults OFF', async () => {
        fakeConfig = { telemetry: { enabled: true, consentVersion: 0 } };
        const { runReconsent } = await import('../src/cli/reconsent.js');
        const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
        const { input, output } = makeStreams(null);
        const result = await runReconsent({ input, output });
        expect(result.accepted).toBe(false);
        expect(result.enabled).toBe(false);
        expect(result.consentVersion).toBe(REQUIRED_CONSENT_VERSION);
    });

    it('does NOT prompt when consentVersion is already at REQUIRED', async () => {
        const { REQUIRED_CONSENT_VERSION } = await import('../src/analytics/consent.js');
        fakeConfig = { telemetry: { enabled: true, consentVersion: REQUIRED_CONSENT_VERSION } };
        const { needsReconsent, reconsentIfNeeded } = await import('../src/cli/reconsent.js');
        expect(needsReconsent()).toBe(false);
        const result = await reconsentIfNeeded();
        expect(result).toBeNull();
        expect(fakeUpdateConfig).not.toHaveBeenCalled();
    });

    it('does NOT prompt when enabled=false regardless of consentVersion', async () => {
        fakeConfig = { telemetry: { enabled: false, consentVersion: 0 } };
        const { needsReconsent, reconsentIfNeeded } = await import('../src/cli/reconsent.js');
        expect(needsReconsent()).toBe(false);
        const result = await reconsentIfNeeded();
        expect(result).toBeNull();
        expect(fakeUpdateConfig).not.toHaveBeenCalled();
    });
});
