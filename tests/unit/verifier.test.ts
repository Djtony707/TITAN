/**
 * TITAN — Unit Tests: verifier (Bug #2 regression suite)
 *
 * Bug #2: llmJudgeVerify was calling the LLM judge for code/shell tasks
 * even with high confidence. The judge reads summary text (not actual
 * files) and produces false negatives. Fix: skip judge for code/shell
 * when confidence >= 0.90.
 */
import { describe, it, expect } from 'vitest';
import { shouldSkipLLMJudge } from '../../src/agent/verifier.js';

describe('shouldSkipLLMJudge — Bug #2 regression', () => {
    it('skips judge for code with confidence >= 0.90', () => {
        expect(shouldSkipLLMJudge('code', 0.95)).toBe(true);
        expect(shouldSkipLLMJudge('code', 0.90)).toBe(true);
    });

    it('skips judge for shell with confidence >= 0.90', () => {
        expect(shouldSkipLLMJudge('shell', 0.95)).toBe(true);
        expect(shouldSkipLLMJudge('shell', 0.90)).toBe(true);
    });

    it('does NOT skip judge for code with confidence < 0.90', () => {
        expect(shouldSkipLLMJudge('code', 0.89)).toBe(false);
        expect(shouldSkipLLMJudge('code', 0.70)).toBe(false);
        expect(shouldSkipLLMJudge('code', undefined)).toBe(false);
    });

    it('does NOT skip judge for shell with confidence < 0.90', () => {
        expect(shouldSkipLLMJudge('shell', 0.89)).toBe(false);
        expect(shouldSkipLLMJudge('shell', 0.50)).toBe(false);
        expect(shouldSkipLLMJudge('shell', undefined)).toBe(false);
    });

    it('does NOT skip judge for research regardless of confidence', () => {
        expect(shouldSkipLLMJudge('research', 0.95)).toBe(false);
        expect(shouldSkipLLMJudge('research', 0.50)).toBe(false);
    });

    it('does NOT skip judge for analysis regardless of confidence', () => {
        expect(shouldSkipLLMJudge('analysis', 0.95)).toBe(false);
        expect(shouldSkipLLMJudge('analysis', 0.50)).toBe(false);
    });

    it('does NOT skip judge for write regardless of confidence', () => {
        expect(shouldSkipLLMJudge('write', 0.95)).toBe(false);
        expect(shouldSkipLLMJudge('write', 0.50)).toBe(false);
    });
});
