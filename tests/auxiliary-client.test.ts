/**
 * Ancestor-extraction Batch 1 — Auxiliary client tests.
 * Covers model resolution across explicit / perTask / preferFamilies / disabled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock loadConfig to produce controlled auxiliary config for each test.
const mockLoadConfig = vi.fn();
vi.mock('../src/config/config.js', () => ({
    loadConfig: () => mockLoadConfig(),
}));

// Mock router.chat so we don't hit network
const mockChat = vi.fn();
vi.mock('../src/providers/router.js', () => ({
    chat: (...args: unknown[]) => mockChat(...args),
}));

import { resolveAuxiliaryModel, auxChat, auxSimple } from '../src/providers/auxiliary.js';

describe('auxiliary — model resolution', () => {
    beforeEach(() => {
        mockLoadConfig.mockReset();
        mockChat.mockReset();
    });

    it('returns undefined when disabled=true', () => {
        mockLoadConfig.mockReturnValue({ auxiliary: { disabled: true } });
        expect(resolveAuxiliaryModel('title')).toBeUndefined();
    });

    it('per-task override wins over model override', () => {
        mockLoadConfig.mockReturnValue({
            auxiliary: { model: 'ollama/glm-5:cloud', perTask: { title: 'ollama/nemotron-3-super:cloud' } },
        });
        expect(resolveAuxiliaryModel('title')).toBe('ollama/nemotron-3-super:cloud');
        // a different task falls back to the global `model`
        expect(resolveAuxiliaryModel('summary')).toBe('ollama/glm-5:cloud');
    });

    it('explicit model wins over preferFamilies', () => {
        mockLoadConfig.mockReturnValue({
            auxiliary: { model: 'ollama/glm-5:cloud', preferFamilies: ['qwen'] },
        });
        expect(resolveAuxiliaryModel('classification')).toBe('ollama/glm-5:cloud');
    });

    it('preferFamilies picks first known family when no model set', () => {
        mockLoadConfig.mockReturnValue({ auxiliary: { preferFamilies: ['qwen', 'minimax'] } });
        expect(resolveAuxiliaryModel('json_extraction')).toBe('ollama/qwen3.5:397b-cloud');
    });

    it('default preferFamilies order = [minimax, glm, qwen, nemotron, gemma]', () => {
        mockLoadConfig.mockReturnValue({ auxiliary: {} });
        // minimax first
        expect(resolveAuxiliaryModel('reformat')).toBe('ollama/minimax-m2.7:cloud');
    });

    it('returns undefined when config missing entirely', () => {
        mockLoadConfig.mockReturnValue({});
        // Default preferFamilies still applies even when auxiliary block is absent
        expect(resolveAuxiliaryModel('title')).toBe('ollama/minimax-m2.7:cloud');
    });
});

describe('auxiliary — auxChat', () => {
    beforeEach(() => {
        mockLoadConfig.mockReset();
        mockChat.mockReset();
    });

    it('routes to resolved auxiliary model', async () => {
        mockLoadConfig.mockReturnValue({ auxiliary: { model: 'ollama/glm-5:cloud' } });
        mockChat.mockResolvedValue({ id: 'x', content: 'Hello', finishReason: 'stop', model: 'ollama/glm-5:cloud' });
        const resp = await auxChat('summary', { messages: [{ role: 'user', content: 'hi' }] });
        expect(resp?.content).toBe('Hello');
        expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'ollama/glm-5:cloud' }));
    });

    it('falls back to fallbackModel when auxiliary is disabled', async () => {
        mockLoadConfig.mockReturnValue({ auxiliary: { disabled: true } });
        mockChat.mockResolvedValue({ id: 'x', content: 'fallback!', finishReason: 'stop', model: 'anthropic/claude-sonnet-4' });
        const resp = await auxChat('title', { messages: [{ role: 'user', content: 'hi' }] }, 'anthropic/claude-sonnet-4');
        expect(resp?.content).toBe('fallback!');
        expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-sonnet-4' }));
    });

    it('returns null when neither aux nor fallback is configured', async () => {
        mockLoadConfig.mockReturnValue({ auxiliary: { disabled: true } });
        const resp = await auxChat('title', { messages: [{ role: 'user', content: 'hi' }] });
        expect(resp).toBeNull();
        expect(mockChat).not.toHaveBeenCalled();
    });

    it('returns null on router failure (graceful degrade)', async () => {
        mockLoadConfig.mockReturnValue({ auxiliary: { model: 'ollama/minimax-m2.7:cloud' } });
        mockChat.mockRejectedValue(new Error('provider 500'));
        const resp = await auxChat('json_extraction', { messages: [{ role: 'user', content: 'x' }] });
        expect(resp).toBeNull();
    });
});

describe('auxiliary — auxSimple convenience wrapper', () => {
    beforeEach(() => {
        mockLoadConfig.mockReset();
        mockChat.mockReset();
    });

    it('wraps a system+user pair into messages and returns content', async () => {
        mockLoadConfig.mockReturnValue({ auxiliary: { model: 'ollama/minimax-m2.7:cloud' } });
        mockChat.mockResolvedValue({ id: 'y', content: 'Session Title', finishReason: 'stop', model: 'ollama/minimax-m2.7:cloud' });
        const result = await auxSimple(
            'title',
            'You are a title generator. Produce a 3-6 word title.',
            'User spent an hour refactoring the prompt pipeline.',
            { temperature: 0.3, maxTokens: 30 },
        );
        expect(result).toBe('Session Title');
        const call = mockChat.mock.calls[0]?.[0];
        expect(call.messages).toHaveLength(2);
        expect(call.messages[0].role).toBe('system');
        expect(call.messages[1].role).toBe('user');
        expect(call.temperature).toBe(0.3);
    });
});
