/**
 * TITAN — Unit Tests: tokens
 *
 * Fast token estimation utilities.
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens } from '../../src/utils/tokens.js';

describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('returns 0 for empty input', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('estimates prose at ~3.8 chars/token', () => {
        const text = 'The quick brown fox jumps over the lazy dog.';
        // 44 chars / 3.8 ≈ 12 tokens → ceil = 12
        expect(estimateTokens(text)).toBeGreaterThanOrEqual(10);
        expect(estimateTokens(text)).toBeLessThanOrEqual(15);
    });

    it('estimates code lower due to symbol density', () => {
        const prose = 'The quick brown fox jumps over the lazy dog';
        const code = 'const x = { a: 1, b: 2 }; function() { return x; }';
        expect(estimateTokens(code)).toBeGreaterThanOrEqual(estimateTokens(prose) * 0.5);
    });

    it('estimates symbol-heavy text at ~2.5 chars/token', () => {
        const code = '{}();:=<>[]/\\|&!?@#$%~^*+-`"\'';
        const len = code.length;
        const est = estimateTokens(code);
        // Very symbol-dense should use 2.5 divisor
        expect(est).toBeGreaterThanOrEqual(Math.ceil(len / 3));
        expect(est).toBeLessThanOrEqual(Math.ceil(len / 2));
    });

    it('handles unicode text', () => {
        const text = '你好世界こんにちは안녕하세요';
        expect(estimateTokens(text)).toBeGreaterThan(0);
    });

    it('handles long text', () => {
        const text = 'word '.repeat(1000);
        expect(estimateTokens(text)).toBeGreaterThan(500);
    });
});

describe('estimateMessageTokens', () => {
    it('sums tokens across string contents', () => {
        const messages = [
            { content: 'hello' },
            { content: 'world' },
        ];
        expect(estimateMessageTokens(messages)).toBe(
            estimateTokens('hello') + estimateTokens('world')
        );
    });

    it('handles non-string content by stringifying', () => {
        const messages = [
            { content: { key: 'value' } },
        ];
        expect(estimateMessageTokens(messages)).toBeGreaterThan(0);
    });

    it('handles undefined content', () => {
        const messages = [
            { content: undefined },
            { content: 'hello' },
        ];
        expect(estimateMessageTokens(messages)).toBe(estimateTokens('hello'));
    });

    it('returns 0 for empty array', () => {
        expect(estimateMessageTokens([])).toBe(0);
    });
});
