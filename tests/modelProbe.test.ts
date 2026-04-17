/**
 * TITAN — Model Probe Tests
 *
 * Guards against the "probe poisoning" bug: the empirical probe must hit the
 * target model or fail cleanly. If the router silently falls back to a
 * different model, the probe must abort without writing to the registry —
 * otherwise the registry gets populated with capabilities from whichever
 * model happened to answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { probeModel } from '../src/agent/modelProbe.js';

describe('ModelProbe — noFallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes noFallback: true on every probe chat call', async () => {
        mockChat.mockResolvedValue({
            id: 'r1',
            content: 'PROBE_OK',
            toolCalls: [{ id: 't', type: 'function', function: { name: 'echo', arguments: '{}' } }],
            finishReason: 'stop',
            model: 'ollama/some-model',
        });

        await probeModel('ollama/some-model');

        expect(mockChat).toHaveBeenCalled();
        for (const call of mockChat.mock.calls) {
            expect(call[0]).toMatchObject({ noFallback: true });
        }
    });

    it('throws (does NOT return a result) when the target model is unreachable via noFallback', async () => {
        // Simulate the router's noFallback error — identical to what
        // router.ts throws when the resolved provider fails.
        mockChat.mockRejectedValue(new Error(
            'Probe target openrouter/nvidia/nemotron-3-super unreachable (noFallback=true): ' +
            'Provider openrouter/nvidia/nemotron-3-super failed: OpenRouter API key not configured'
        ));

        await expect(probeModel('ollama/nemotron-3-super:cloud')).rejects.toThrow(/Probe aborted/);
    });

    it('registry is NOT updated when probe aborts due to unreachable target', async () => {
        mockChat.mockRejectedValue(new Error(
            'Probe target openrouter/nvidia/nemotron-3-super unreachable (noFallback=true): key missing'
        ));

        // Simulate the CLI flow: probeModel throws → recordProbeResult never runs.
        const recordProbeResult = vi.fn();
        let caught: Error | null = null;
        try {
            const result = await probeModel('ollama/nemotron-3-super:cloud');
            recordProbeResult(result);
        } catch (err) {
            caught = err as Error;
        }

        expect(caught).not.toBeNull();
        expect(caught?.message).toMatch(/Registry not updated/);
        expect(recordProbeResult).not.toHaveBeenCalled();
    });

    it('does not swallow noFallback errors as ordinary probe errors', async () => {
        // Before the fix, the thinking probe would catch and push to errors[],
        // then subsequent probes would run against the fallback model, and
        // probeModel would return a ProbeResult with misleading data.
        // After the fix, the first unreachable error aborts the whole probe.
        mockChat.mockRejectedValueOnce(new Error(
            'Probe target openrouter/nvidia/foo unreachable (noFallback=true): no key'
        ));
        // If probeModel continued, these would return fabricated data:
        mockChat.mockResolvedValue({
            id: 'r2',
            content: 'YES',
            finishReason: 'stop',
            model: 'ollama/gemma4:31b-cloud',
        });

        await expect(probeModel('ollama/nemotron-3-super:cloud')).rejects.toThrow(/Probe aborted/);
        // Only the first (thinking) probe should have run before abort.
        expect(mockChat).toHaveBeenCalledTimes(1);
    });
});
