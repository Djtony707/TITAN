/**
 * Tests for src/agent/subAgent.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockExecuteTools = vi.hoisted(() => vi.fn());
const mockGetToolDefinitions = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));
vi.mock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../src/agent/toolRunner.js', () => ({
    executeTools: mockExecuteTools,
    getToolDefinitions: mockGetToolDefinitions,
}));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { spawnSubAgent, SUB_AGENT_TEMPLATES, getActiveSubAgentCount } from '../src/agent/subAgent.js';

function makeConfig() {
    return {
        agent: {
            model: 'test-model',
            maxTokens: 4096,
            modelAliases: { fast: 'test-fast' },
        },
        subAgents: { maxConcurrent: 3 },
    };
}

const toolDef = (name: string) => ({
    type: 'function' as const,
    function: { name, description: `${name} tool`, parameters: {} },
});

describe('SubAgent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadConfig.mockReturnValue(makeConfig());
        mockGetToolDefinitions.mockReturnValue([
            toolDef('web_search'),
            toolDef('web_fetch'),
            toolDef('shell'),
            toolDef('spawn_agent'),
        ]);
    });

    describe('SUB_AGENT_TEMPLATES', () => {
        it('has explorer, coder, browser, analyst templates', () => {
            expect(SUB_AGENT_TEMPLATES).toHaveProperty('explorer');
            expect(SUB_AGENT_TEMPLATES).toHaveProperty('coder');
            expect(SUB_AGENT_TEMPLATES).toHaveProperty('browser');
            expect(SUB_AGENT_TEMPLATES).toHaveProperty('analyst');
        });

        it('explorer template has web tools', () => {
            expect(SUB_AGENT_TEMPLATES.explorer.tools).toContain('web_search');
            expect(SUB_AGENT_TEMPLATES.explorer.tools).toContain('web_read');
        });
    });

    describe('spawnSubAgent', () => {
        it('prevents nested sub-agents', async () => {
            const result = await spawnSubAgent({
                name: 'Test',
                task: 'Do something',
                isNested: true,
            });
            expect(result.success).toBe(false);
            expect(result.content).toContain('nesting depth limit');
        });

        it('completes when LLM returns no tool calls', async () => {
            mockChat.mockResolvedValue({ content: 'Research completed successfully with detailed findings about AI trends.', toolCalls: [] });

            const result = await spawnSubAgent({ name: 'Explorer', task: 'Research AI' });

            expect(result.success).toBe(true);
            expect(result.content).toBe('Research completed successfully with detailed findings about AI trends.');
            expect(result.rounds).toBe(1);
        });

        it('processes tool calls and loops', async () => {
            mockChat
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{ id: 'tc1', function: { name: 'web_search', arguments: '{"q":"AI"}' } }],
                })
                .mockResolvedValueOnce({ content: 'Done researching AI trends and compiling the results into a report.', toolCalls: [] });

            mockExecuteTools.mockResolvedValue([
                { name: 'web_search', content: 'Results: AI trends...', toolCallId: 'tc1' },
            ]);

            const result = await spawnSubAgent({ name: 'Explorer', task: 'Search for AI' });

            expect(result.success).toBe(true);
            expect(result.toolsUsed).toContain('web_search');
            expect(result.rounds).toBe(2);
        });

        it('respects maxRounds limit', async () => {
            // Return varying tool calls to avoid loop detection
            let round = 0;
            mockChat.mockImplementation(async () => {
                round++;
                return {
                    content: `Working round ${round}...`,
                    toolCalls: [{ id: `tc${round}`, function: { name: 'web_search', arguments: JSON.stringify({ q: round }) } }],
                };
            });
            mockExecuteTools.mockImplementation(async (calls: ToolCall[]) => {
                const name = calls[0]?.function?.name || 'tool';
                return [{ name, content: `results for ${name}`, toolCallId: calls[0]?.id || 'tc1' }];
            });

            const result = await spawnSubAgent({ name: 'Test', task: 'Loop', maxRounds: 5 });

            expect(result.rounds).toBe(5);
            expect(mockChat).toHaveBeenCalledTimes(5);
        });

        it('allows spawn_agent at depth 0 when maxDepth >= 2 (nesting enabled)', async () => {
            mockChat.mockResolvedValue({ content: 'Done', toolCalls: [] });

            await spawnSubAgent({
                name: 'Explorer',
                task: 'Search',
                tools: ['web_search', 'spawn_agent'],
                depth: 0,
            });

            const callArgs = mockChat.mock.calls[0][0];
            const toolNames = callArgs.tools.map((t: any) => t.function.name);
            expect(toolNames).toContain('web_search');
            expect(toolNames).toContain('spawn_agent'); // Allowed at depth 0 (maxDepth default = 2)
        });

        it('excludes spawn_agent at max depth', async () => {
            mockChat.mockResolvedValue({ content: 'Done', toolCalls: [] });

            await spawnSubAgent({ name: 'Test', task: 'Do something', depth: 3 }); // depth 3, maxDepth 4: can't nest further

            const callArgs = mockChat.mock.calls[0][0];
            const toolNames = callArgs.tools.map((t: any) => t.function.name);
            expect(toolNames).not.toContain('spawn_agent');
        });

        it('handles chat errors gracefully', async () => {
            mockChat.mockRejectedValue(new Error('API timeout'));

            const result = await spawnSubAgent({ name: 'Test', task: 'Fail' });

            expect(result.success).toBe(false);
            expect(result.content).toContain('API timeout');
        });

        it('uses fast model alias by default', async () => {
            mockChat.mockResolvedValue({ content: 'Done', toolCalls: [] });

            await spawnSubAgent({ name: 'Test', task: 'Quick task' });

            expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
                model: 'test-fast',
            }));
        });
    });
});
