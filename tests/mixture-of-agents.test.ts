/**
 * TITAN — Mixture of Agents Tests
 * Tests P5 from Hermes integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockChat = vi.hoisted(() => vi.fn());
vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'anthropic/claude-sonnet-4-20250514' },
        providers: {
            anthropic: { apiKey: 'sk-ant-test' },
            openai: { apiKey: 'sk-test' },
            google: { apiKey: 'goog-test' },
        },
    }),
}));

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: vi.fn(),
    isToolSkillEnabled: vi.fn().mockReturnValue(true),
}));

// Import after mocks
import { registerMixtureOfAgentsSkill } from '../src/skills/builtin/mixture_of_agents.js';
import { registerSkill } from '../src/skills/registry.js';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('Mixture of Agents', () => {
    it('registers the skill with correct metadata', () => {
        registerMixtureOfAgentsSkill();
        expect(registerSkill).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'mixture_of_agents', source: 'bundled' }),
            expect.objectContaining({ name: 'mixture_of_agents' }),
        );
    });

    it('executes with synthesize strategy', async () => {
        registerMixtureOfAgentsSkill();
        const [, handler] = (registerSkill as ReturnType<typeof vi.fn>).mock.calls[0];

        // Mock 3 model responses
        mockChat
            .mockResolvedValueOnce({ content: 'Answer from model A: The result is 42.' })
            .mockResolvedValueOnce({ content: 'Answer from model B: 42 is the answer.' })
            .mockResolvedValueOnce({ content: 'Answer from model C: I calculate 42.' })
            // Synthesis call
            .mockResolvedValueOnce({ content: 'The consensus answer is 42, confirmed by all three models.' });

        const result = await handler.execute({
            query: 'What is the answer to everything?',
            models: ['model-a', 'model-b', 'model-c'],
            strategy: 'synthesize',
        });

        expect(result).toContain('42');
        expect(result).toContain('3 models consulted');
        // 3 fan-out calls + 1 synthesis = 4 total
        expect(mockChat).toHaveBeenCalledTimes(4);
    });

    it('executes with vote strategy', async () => {
        registerMixtureOfAgentsSkill();
        const [, handler] = (registerSkill as ReturnType<typeof vi.fn>).mock.calls[0];

        mockChat
            .mockResolvedValueOnce({ content: 'The capital of France is Paris.' })
            .mockResolvedValueOnce({ content: 'Paris is the capital of France.' })
            .mockResolvedValueOnce({ content: 'Tokyo is the capital of Japan.' });

        const result = await handler.execute({
            query: 'What is the capital of France?',
            models: ['model-a', 'model-b', 'model-c'],
            strategy: 'vote',
        });

        // Vote should pick the response most similar to others (Paris-related)
        expect(result).toContain('Paris');
        // No synthesis call needed for vote
        expect(mockChat).toHaveBeenCalledTimes(3);
    });

    it('handles partial failures gracefully', async () => {
        registerMixtureOfAgentsSkill();
        const [, handler] = (registerSkill as ReturnType<typeof vi.fn>).mock.calls[0];

        mockChat
            .mockResolvedValueOnce({ content: 'Success from model A' })
            .mockRejectedValueOnce(new Error('Model B timeout'))
            // Synthesis with single response just returns it
            ;

        const result = await handler.execute({
            query: 'Test query',
            models: ['model-a', 'model-b'],
            strategy: 'synthesize',
        });

        // Should succeed with partial results
        expect(result).toContain('Success from model A');
        expect(result).toContain('1 models consulted');
    });

    it('returns error when all models fail', async () => {
        registerMixtureOfAgentsSkill();
        const [, handler] = (registerSkill as ReturnType<typeof vi.fn>).mock.calls[0];

        mockChat
            .mockRejectedValueOnce(new Error('Timeout'))
            .mockRejectedValueOnce(new Error('Rate limit'));

        const result = await handler.execute({
            query: 'Test query',
            models: ['model-a', 'model-b'],
        });

        expect(result).toContain('All 2 models failed');
    });

    it('uses temperature 0.6 for fan-out queries', async () => {
        registerMixtureOfAgentsSkill();
        const [, handler] = (registerSkill as ReturnType<typeof vi.fn>).mock.calls[0];

        mockChat.mockResolvedValue({ content: 'Response' });

        await handler.execute({
            query: 'Test',
            models: ['model-a'],
            strategy: 'synthesize',
        });

        expect(mockChat).toHaveBeenCalledWith(
            expect.objectContaining({ temperature: 0.6 }),
        );
    });
});
