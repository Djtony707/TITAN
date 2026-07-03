/**
 * Context-Fit / model-agnostic local-model tests (v7.1).
 *
 * Covers the learned-deployment-limits store, source-aware capability lookup,
 * strict system-message placement, the LiteLLM no-route fast-fail, and the
 * slimmed tool_search catalog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpHome = mkdtempSync(join(tmpdir(), 'titan-ctxfit-'));
process.env.TITAN_HOME = tmpHome;

const { recordLearnedContextWindow, getModelCapabilities, getModelCapabilitiesEx, resetLearnedLimitsCache } =
    await import('../src/providers/modelCapabilities.js');
const { normalizeSystemPlacement } = await import('../src/providers/openai_compat.js');
const { classifyProviderError, FailoverReason } = await import('../src/providers/errorTaxonomy.js');

afterEach(() => { resetLearnedLimitsCache(); });

describe('learned deployment limits', () => {
    it('records a ceiling and applies it as a min over the family default', () => {
        // glm-4.7-flash family default is 198K; a 16K deployment must win
        recordLearnedContextWindow('glm-4.7-flash', 16_384);
        resetLearnedLimitsCache();
        const caps = getModelCapabilities('glm-4.7-flash');
        expect(caps.contextWindow).toBe(16_384);
        expect(existsSync(join(tmpHome, 'learned-model-limits.json'))).toBe(true);
    });

    it('keeps the smallest observed ceiling and ignores junk', () => {
        recordLearnedContextWindow('some-model-x', 32_768);
        recordLearnedContextWindow('some-model-x', 65_536); // larger — ignored
        recordLearnedContextWindow('some-model-x', 900);    // absurd — ignored
        resetLearnedLimitsCache();
        const file = JSON.parse(readFileSync(join(tmpHome, 'learned-model-limits.json'), 'utf-8'));
        expect(file['some-model-x'].contextWindow).toBe(32_768);
    });

    it('source-aware lookup distinguishes fallback guesses from knowledge', () => {
        expect(getModelCapabilitiesEx('totally-unknown-model-zzz').source).toBe('fallback');
        expect(getModelCapabilitiesEx('glm-4.7-fresh-deployment').source).toBe('family');
        recordLearnedContextWindow('totally-unknown-model-zzz', 8_192);
        resetLearnedLimitsCache();
        expect(getModelCapabilitiesEx('totally-unknown-model-zzz').source).toBe('learned');
        expect(getModelCapabilitiesEx('totally-unknown-model-zzz').caps.contextWindow).toBe(8_192);
    });

    it(':cloud models never inherit the ollama 32K catch-all', () => {
        // qwen3.5:cloud hits the static table (128K); a made-up :cloud model
        // must hit the :cloud family row, not the ^ollama/ 32K catch-all.
        expect(getModelCapabilities('ollama/qwen3.5:cloud').contextWindow).toBeGreaterThanOrEqual(100_000);
        expect(getModelCapabilities('ollama/somebig:cloud').contextWindow).toBe(262_144);
    });

    it('GX10 family rows resolve', () => {
        expect(getModelCapabilities('qwen3-coder-30b-a3b-instruct-fp8').contextWindow).toBe(262_144);
        expect(getModelCapabilities('minimax-m2.5-reap-172b').contextWindow).toBe(200_000);
        expect(getModelCapabilities('nemotron-nano').contextWindow).toBe(131_072);
    });
});

describe('strict system-message placement', () => {
    it('leaves a leading system message alone, converts mid-conversation ones', () => {
        const out = normalizeSystemPlacement([
            { role: 'system', content: 'you are titan' },
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'task continuation: finish step 2' },
            { role: 'assistant', content: 'ok' },
        ]);
        expect(out[0].role).toBe('system');
        expect(out[2].role).toBe('user');
        expect(out[2].content).toContain('[System note]');
        expect(out[2].content).toContain('task continuation');
        expect(out[3].role).toBe('assistant');
    });

    it('no-ops when there are no misplaced system messages', () => {
        const msgs = [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
        ];
        expect(normalizeSystemPlacement(msgs)).toEqual(msgs);
    });
});

describe('gateway no-route fast-fail', () => {
    it('classifies LiteLLM "no healthy deployments" as non-retryable MODEL_NOT_FOUND', () => {
        const err = new Error('LiteLLM (Universal Proxy) API error (400): {"error":{"message":"litellm.BadRequestError: You passed in model=glm-4.7-flash. There are no healthy deployments for this modelNo fallback model group found","code":"400"}}');
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.MODEL_NOT_FOUND);
        expect(classified.retryable).toBe(false);
    });
});
