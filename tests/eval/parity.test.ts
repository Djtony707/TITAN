/**
 * Cross-Model Parity Tests (Phase 6 / v5.3.0)
 *
 * Replays the same scenario through multiple provider tapes and asserts
 * behavioural equivalence: same tool, same args, same finish reason, same
 * content presence. We don't compare content text — different models
 * phrase things differently and that's fine. We do compare *behaviour*.
 *
 * For the v5.3.0 baseline we use existing Phase 2 tapes — every
 * "provider" loads the same tape file, so divergence count is always 0
 * and we're really exercising the comparison machinery itself. As soon
 * as we have provider-specific tapes recorded (Phase 6 / Phase 7), this
 * suite becomes the regression net for cross-provider behaviour.
 */

import { describe, it, expect } from 'vitest';
import { compareProviderBehavior, formatParityReport } from '../../src/eval/parity.js';

describe('Cross-Model Parity', () => {
    it('weather scenario: providers replaying the same tape have full parity', async () => {
        // Three "providers" all loading weather.json — divergence must be 0.
        // This is the lowest-bar test: it exercises the comparison logic
        // without depending on having three separately-recorded tapes yet.
        const report = await compareProviderBehavior('weather', [
            { name: 'ollama',    tape: 'weather' },
            { name: 'anthropic', tape: 'weather' },
            { name: 'openai',    tape: 'weather' },
        ]);
        expect(report.providers).toEqual(['ollama', 'anthropic', 'openai']);
        expect(report.rounds).toBe(2);
        expect(report.divergences).toEqual([]);
        // First-round tool call must match across providers
        expect(report.matrix[0][0].tool).toBe('weather');
        expect(report.matrix[1][0].tool).toBe('weather');
        expect(report.matrix[2][0].tool).toBe('weather');
    });

    it('safety_refusal: 0 tool calls, all providers agree', async () => {
        const report = await compareProviderBehavior('safety_refusal', [
            { name: 'ollama',    tape: 'safety_refusal' },
            { name: 'anthropic', tape: 'safety_refusal' },
        ]);
        expect(report.divergences).toEqual([]);
        expect(report.matrix[0][0].tool).toBeNull();
        expect(report.matrix[0][0].finishReason).toBe('stop');
    });

    it('file_write: 2-round write_file then confirmation, parity holds', async () => {
        const report = await compareProviderBehavior('file_write', [
            { name: 'ollama',    tape: 'file_write' },
            { name: 'anthropic', tape: 'file_write' },
        ]);
        expect(report.rounds).toBe(2);
        expect(report.divergences).toEqual([]);
        expect(report.matrix[0][0].tool).toBe('write_file');
        expect(report.matrix[0][0].finishReason).toBe('tool_calls');
        expect(report.matrix[0][1].tool).toBeNull();
        expect(report.matrix[0][1].finishReason).toBe('stop');
    });

    it('detects a divergence when providers replay different tapes', async () => {
        // Force a mismatch: weather (calls weather tool) vs safety_refusal
        // (no tool call). The reporter must catch it.
        const report = await compareProviderBehavior('mixed', [
            { name: 'provider_a', tape: 'weather' },
            { name: 'provider_b', tape: 'safety_refusal' },
        ]);
        expect(report.divergences.length).toBeGreaterThan(0);
        // First divergence on round 1: weather called a tool, safety_refusal didn't
        const firstRoundDivergences = report.divergences.filter(d => d.round === 0);
        expect(firstRoundDivergences.some(d => d.field === 'tool')).toBe(true);
    });

    it('formatParityReport produces a useful string for assertion failures', async () => {
        const report = await compareProviderBehavior('weather', [
            { name: 'ollama',    tape: 'weather' },
            { name: 'anthropic', tape: 'weather' },
        ]);
        const text = formatParityReport(report);
        expect(text).toContain('Cross-model parity: ollama vs anthropic');
        expect(text).toContain('Round 1');
        expect(text).toContain('weather');
        expect(text).toContain('Full behavioural parity');
    });

    it('formatParityReport flags divergences with the expected→actual format', async () => {
        const report = await compareProviderBehavior('mixed', [
            { name: 'a', tape: 'weather' },
            { name: 'b', tape: 'safety_refusal' },
        ]);
        const text = formatParityReport(report);
        expect(text).toMatch(/divergence/i);
    });

    it('throws when fewer than 2 providers are passed', async () => {
        await expect(
            compareProviderBehavior('weather', [{ name: 'ollama', tape: 'weather' }]),
        ).rejects.toThrow(/at least 2 providers/);
    });

    it('throws with a useful message when a tape file is missing', async () => {
        await expect(
            compareProviderBehavior('missing', [
                { name: 'a', tape: 'weather' },
                { name: 'b', tape: 'this_tape_does_not_exist_zzz' },
            ]),
        ).rejects.toThrow(/Parity tape not found/);
    });
});
