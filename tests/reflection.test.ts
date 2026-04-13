/**
 * Tests for src/agent/reflection.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));
vi.mock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { shouldReflect, buildReflectionPrompt, parseReflection, reflect } from '../src/agent/reflection.js';

function makeConfig() {
    return {
        agent: {
            model: 'test-model',
            modelAliases: { fast: 'test-fast-model' },
        },
    };
}

describe('Reflection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadConfig.mockReturnValue(makeConfig());
    });

    describe('shouldReflect', () => {
        it('returns false for round 0', () => {
            expect(shouldReflect(0)).toBe(false);
        });

        it('returns true at default interval (3)', () => {
            expect(shouldReflect(3)).toBe(true);
            expect(shouldReflect(6)).toBe(true);
            expect(shouldReflect(9)).toBe(true);
        });

        it('returns false between intervals', () => {
            expect(shouldReflect(1)).toBe(false);
            expect(shouldReflect(2)).toBe(false);
            expect(shouldReflect(4)).toBe(false);
        });

        it('respects custom interval', () => {
            expect(shouldReflect(5, 5)).toBe(true);
            expect(shouldReflect(3, 5)).toBe(false);
        });
    });

    describe('buildReflectionPrompt', () => {
        it('includes original message and tools used', () => {
            const prompt = buildReflectionPrompt(6, ['web_search', 'web_read'], 'Find AI trends');
            expect(prompt).toContain('6 rounds');
            expect(prompt).toContain('Find AI trends');
            expect(prompt).toContain('web_search');
            expect(prompt).toContain('web_read');
        });

        it('deduplicates tool names', () => {
            const prompt = buildReflectionPrompt(3, ['web_search', 'web_search', 'web_read'], 'test');
            // "Tools used so far: web_search, web_read"
            const toolLine = prompt.split('\n').find(l => l.startsWith('Tools used so far'));
            expect(toolLine).not.toContain('web_search, web_search');
        });

        it('includes last tool results when provided', () => {
            const prompt = buildReflectionPrompt(3, ['shell'], 'build project', 'Build succeeded');
            expect(prompt).toContain('Build succeeded');
        });

        it('handles empty tools', () => {
            const prompt = buildReflectionPrompt(3, [], 'hello');
            expect(prompt).toContain('none');
        });
    });

    describe('parseReflection', () => {
        it('extracts "continue" decision', () => {
            const result = parseReflection('DECISION: continue\nMaking good progress.');
            expect(result.decision).toBe('continue');
            expect(result.reasoning).toBe('Making good progress.');
        });

        it('extracts "stop" decision', () => {
            const result = parseReflection('DECISION: stop\nTask is complete.');
            expect(result.decision).toBe('stop');
        });

        it('extracts "adjust" decision', () => {
            const result = parseReflection('DECISION: adjust\nNeed a different approach.');
            expect(result.decision).toBe('adjust');
        });

        it('defaults to continue for ambiguous input', () => {
            const result = parseReflection('Not sure what to do');
            expect(result.decision).toBe('continue');
        });

        it('provides default reasoning when none given', () => {
            const result = parseReflection('DECISION: stop');
            expect(result.reasoning).toBe('No reasoning provided.');
        });
    });

    describe('reflect', () => {
        it('calls chat with fast model and returns parsed result', async () => {
            mockChat.mockResolvedValue({ content: 'DECISION: continue\nStill working.' });

            const result = await reflect(6, ['web_search'], 'Find info');

            expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
                model: 'test-fast-model',
                maxTokens: 200,
            }));
            expect(result.decision).toBe('continue');
        });

        it('falls back to agent model when no fast alias', async () => {
            mockLoadConfig.mockReturnValue({
                agent: { model: 'fallback-model', modelAliases: {} },
            });
            mockChat.mockResolvedValue({ content: 'DECISION: stop\nDone.' });

            await reflect(3, [], 'test');

            expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
                model: 'fallback-model', // falls back to configured agent model, not hardcoded provider
            }));
        });

        it('returns continue on chat failure', async () => {
            mockChat.mockRejectedValue(new Error('API down'));

            const result = await reflect(3, ['shell'], 'build');

            expect(result.decision).toBe('continue');
            expect(result.reasoning).toContain('API down');
        });
    });
});
