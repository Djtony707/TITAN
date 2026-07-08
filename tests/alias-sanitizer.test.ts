/**
 * Floor-alias sanitizer — auth-gated ollama-cloud floor aliases must resolve
 * to the user's actual working model (2026-07-07 crash-loop root cause).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeModelAliases } from '../src/config/config.js';

describe('sanitizeModelAliases', () => {
    it('rewrites cloud-floor aliases when the user drives a non-ollama model', () => {
        const { aliases, rewritten } = sanitizeModelAliases(
            { fast: 'ollama/qwen3.5:cloud', smart: 'ollama/glm-5:cloud', reasoning: 'ollama/kimi-k2.6:cloud' },
            'litellm/qwen3-coder-next',
        );
        expect(aliases.fast).toBe('litellm/qwen3-coder-next');
        expect(aliases.smart).toBe('litellm/qwen3-coder-next');
        expect(aliases.reasoning).toBe('litellm/qwen3-coder-next');
        expect(rewritten.sort()).toEqual(['fast', 'reasoning', 'smart']);
    });
    it('leaves aliases alone for an ollama-driving user (cloud signin is their choice)', () => {
        const { rewritten } = sanitizeModelAliases({ fast: 'ollama/qwen3.5:cloud' }, 'ollama/qwen3.5:cloud');
        expect(rewritten).toEqual([]);
    });
    it('leaves non-cloud aliases alone', () => {
        const { aliases, rewritten } = sanitizeModelAliases(
            { fast: 'openai/gpt-4o-mini', local: 'ollama/qwen3.5:4b' },
            'litellm/qwen3-coder-next',
        );
        expect(aliases.fast).toBe('openai/gpt-4o-mini');
        expect(aliases.local).toBe('ollama/qwen3.5:4b');
        expect(rewritten).toEqual([]);
    });
    it('empty model or aliases → no-op', () => {
        expect(sanitizeModelAliases({}, 'litellm/x').rewritten).toEqual([]);
        expect(sanitizeModelAliases({ fast: 'ollama/a:cloud' }, '').rewritten).toEqual([]);
    });
});
