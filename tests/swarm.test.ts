/**
 * TITAN — Swarm Architecture Tests
 *
 * v5.4.x rewrite: `runSubAgent` no longer hosts its own mini-loop. It is a
 * thin shim over `spawnSubAgent` (the canonical sub-agent path). These tests
 * verify the shim contract — domain → tool allowlist mapping, model
 * passthrough, output formatting, error handling — by mocking
 * `spawnSubAgent` directly. Internal loop semantics (rounds, stall/loop
 * detection, message history) are owned by `spawnSubAgent` and exercised in
 * `tests/subAgent.test.ts`.
 *
 * The historical tests that asserted on `chat()` mock call args were
 * dropped: they were testing the wrong layer (an internal mini-loop that
 * no longer exists). What matters now is that swarm hands the right
 * inputs to the canonical primitive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: vi.fn().mockResolvedValue({
        content: 'Sub-agent result',
        toolsUsed: [],
        rounds: 1,
        success: true,
    }),
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    getToolDefinitions: vi.fn().mockReturnValue([
        { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: {} } },
        { type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: {} } },
        { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: {} } },
        { type: 'function', function: { name: 'shell', description: 'Run shell command', parameters: {} } },
        { type: 'function', function: { name: 'memory_skill', description: 'Memory operations', parameters: {} } },
    ]),
}));

import { getSwarmRouterTools, runSubAgent, type Domain } from '../src/agent/swarm.js';
import { spawnSubAgent } from '../src/agent/subAgent.js';
import { getToolDefinitions } from '../src/agent/toolRunner.js';
import logger from '../src/utils/logger.js';

describe('Swarm', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(spawnSubAgent).mockResolvedValue({
            content: 'Sub-agent result',
            toolsUsed: [],
            rounds: 1,
            success: true,
        });
        vi.mocked(getToolDefinitions).mockReturnValue([
            { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: {} } },
            { type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: {} } },
            { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: {} } },
            { type: 'function', function: { name: 'shell', description: 'Run shell command', parameters: {} } },
            { type: 'function', function: { name: 'memory_skill', description: 'Memory operations', parameters: {} } },
        ]);
    });

    // ─── getSwarmRouterTools ────────────────────────────────────────
    describe('getSwarmRouterTools', () => {
        it('returns exactly 4 tools', () => {
            expect(getSwarmRouterTools().length).toBe(4);
        });

        it.each([
            ['delegate_to_file_agent'],
            ['delegate_to_web_agent'],
            ['delegate_to_system_agent'],
            ['delegate_to_memory_agent'],
        ])('includes %s', (name) => {
            const tools = getSwarmRouterTools();
            expect(tools.find(t => t.function.name === name)).toBeDefined();
        });

        it('every tool has an instruction parameter', () => {
            for (const tool of getSwarmRouterTools()) {
                const params = tool.function.parameters as { properties: Record<string, unknown>; required: string[]; type: string };
                expect(params.type).toBe('object');
                expect(params.properties.instruction).toBeDefined();
                expect(params.required).toContain('instruction');
            }
        });
    });

    // ─── runSubAgent — shim contract ────────────────────────────────
    describe('runSubAgent', () => {
        it('formats the result with the domain prefix', async () => {
            const result = await runSubAgent('file', 'Read /tmp/test.txt', 'openai/gpt-4o');
            expect(result).toBe('[Sub-Agent Result / Domain: file]\nSub-agent result');
        });

        it.each([['file'], ['web'], ['system'], ['memory']] as Array<[Domain]>)(
            'tags result with %s domain',
            async (domain) => {
                const result = await runSubAgent(domain, 'task', 'openai/gpt-4o');
                expect(result).toContain(`Domain: ${domain}`);
            },
        );

        it('passes the model through to spawnSubAgent', async () => {
            await runSubAgent('file', 'task', 'anthropic/claude-sonnet-4-20250514');
            expect(spawnSubAgent).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'anthropic/claude-sonnet-4-20250514' }),
            );
        });

        it('passes the instruction as the task', async () => {
            await runSubAgent('file', 'Read /etc/hosts file', 'openai/gpt-4o');
            expect(spawnSubAgent).toHaveBeenCalledWith(
                expect.objectContaining({ task: 'Read /etc/hosts file' }),
            );
        });

        it('caps maxRounds at 3 (matches historical mini-loop budget)', async () => {
            await runSubAgent('web', 'Search', 'openai/gpt-4o');
            expect(spawnSubAgent).toHaveBeenCalledWith(
                expect.objectContaining({ maxRounds: 3 }),
            );
        });

        it('names the spawned agent swarm-<domain> for governance feeds', async () => {
            await runSubAgent('system', 'task', 'openai/gpt-4o');
            expect(spawnSubAgent).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'swarm-system' }),
            );
        });

        it('restricts tools to file domain when domain=file', async () => {
            await runSubAgent('file', 'task', 'openai/gpt-4o');
            const args = vi.mocked(spawnSubAgent).mock.calls[0][0];
            expect(args.tools).toEqual(expect.arrayContaining(['read_file', 'write_file']));
            expect(args.tools).not.toContain('web_search');
            expect(args.tools).not.toContain('shell');
        });

        it('restricts tools to web domain when domain=web', async () => {
            await runSubAgent('web', 'task', 'openai/gpt-4o');
            const args = vi.mocked(spawnSubAgent).mock.calls[0][0];
            expect(args.tools).toContain('web_search');
            expect(args.tools).not.toContain('read_file');
        });

        it('restricts tools to system domain when domain=system', async () => {
            await runSubAgent('system', 'task', 'openai/gpt-4o');
            const args = vi.mocked(spawnSubAgent).mock.calls[0][0];
            expect(args.tools).toContain('shell');
            expect(args.tools).not.toContain('web_search');
        });

        it('restricts tools to memory domain when domain=memory', async () => {
            await runSubAgent('memory', 'task', 'openai/gpt-4o');
            const args = vi.mocked(spawnSubAgent).mock.calls[0][0];
            expect(args.tools).toContain('memory_skill');
        });

        it('returns silently-completed message when spawnSubAgent yields empty content', async () => {
            vi.mocked(spawnSubAgent).mockResolvedValueOnce({
                content: '', toolsUsed: [], rounds: 1, success: true,
            });
            const result = await runSubAgent('file', 'task', 'openai/gpt-4o');
            expect(result).toContain('Task completed silently');
        });

        it('catches errors thrown by spawnSubAgent and returns a string', async () => {
            vi.mocked(spawnSubAgent).mockRejectedValueOnce(new Error('Connection refused'));
            const result = await runSubAgent('web', 'task', 'openai/gpt-4o');
            expect(result).toContain('error');
            expect(result).toContain('Connection refused');
            expect(logger.error).toHaveBeenCalledWith(
                'Swarm',
                expect.stringContaining('Connection refused'),
            );
        });

        it('logs an info line when spawning', async () => {
            await runSubAgent('file', 'Read something', 'openai/gpt-4o');
            expect(logger.info).toHaveBeenCalledWith(
                'Swarm',
                expect.stringContaining('FILE Sub-Agent'),
            );
        });

        it('multiple sub-agents can run in parallel without crossing wires', async () => {
            const results = await Promise.all([
                runSubAgent('file', 'task A', 'openai/gpt-4o'),
                runSubAgent('web', 'task B', 'openai/gpt-4o'),
                runSubAgent('system', 'task C', 'openai/gpt-4o'),
                runSubAgent('memory', 'task D', 'openai/gpt-4o'),
            ]);
            expect(results[0]).toContain('Domain: file');
            expect(results[1]).toContain('Domain: web');
            expect(results[2]).toContain('Domain: system');
            expect(results[3]).toContain('Domain: memory');
            expect(spawnSubAgent).toHaveBeenCalledTimes(4);
        });

        it('one failing spawn does not block sibling spawns', async () => {
            let n = 0;
            vi.mocked(spawnSubAgent).mockImplementation(async () => {
                n++;
                if (n === 2) throw new Error('one agent failed');
                return { content: 'Success', toolsUsed: [], rounds: 1, success: true };
            });

            const results = await Promise.all([
                runSubAgent('file', 'A', 'openai/gpt-4o'),
                runSubAgent('web', 'B', 'openai/gpt-4o'),
                runSubAgent('system', 'C', 'openai/gpt-4o'),
            ]);
            expect(results[0]).toContain('Success');
            expect(results[1]).toContain('error');
            expect(results[2]).toContain('Success');
        });
    });

    // ─── Edge cases ────────────────────────────────────────────────
    describe('edge cases', () => {
        it('handles very long instruction string', async () => {
            const long = 'A'.repeat(10000);
            const result = await runSubAgent('file', long, 'openai/gpt-4o');
            expect(result).toContain('Domain: file');
            expect(spawnSubAgent).toHaveBeenCalledWith(expect.objectContaining({ task: long }));
        });

        it('handles empty string instruction', async () => {
            const result = await runSubAgent('file', '', 'openai/gpt-4o');
            expect(result).toContain('Domain: file');
        });

        it('handles instruction with special characters', async () => {
            const tricky = 'Read file with <html> & "quotes"';
            const result = await runSubAgent('file', tricky, 'openai/gpt-4o');
            expect(result).toContain('Domain: file');
            expect(spawnSubAgent).toHaveBeenCalledWith(expect.objectContaining({ task: tricky }));
        });

        it('hands an empty tool allowlist when the domain has no matching tools', async () => {
            // If getToolDefinitions returns an empty list, the resolved domain
            // tool array is empty. spawnSubAgent should still be called with
            // tools=[] — the canonical primitive treats that as "no tools".
            vi.mocked(getToolDefinitions).mockReturnValueOnce([]);
            await runSubAgent('memory', 'task', 'openai/gpt-4o');
            expect(spawnSubAgent).toHaveBeenCalledWith(
                expect.objectContaining({ tools: [] }),
            );
        });

        it.each([
            ['openai/gpt-4o'],
            ['anthropic/claude-sonnet-4-20250514'],
            ['google/gemini-pro'],
            ['kimi-k2.5:cloud'],
        ])('passes through model %s verbatim', async (model) => {
            vi.clearAllMocks();
            vi.mocked(spawnSubAgent).mockResolvedValue({ content: 'ok', toolsUsed: [], rounds: 1, success: true });
            await runSubAgent('file', 'task', model);
            expect(spawnSubAgent).toHaveBeenCalledWith(expect.objectContaining({ model }));
        });
    });
});
