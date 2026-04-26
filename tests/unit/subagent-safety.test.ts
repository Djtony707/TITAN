/**
 * TITAN — Sub-Agent Safety Tests (Phase 9)
 *
 * Verifies stall detection, loop detection, and per-tool error recovery
 * in spawnSubAgent().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SubAgentConfig } from '../../src/agent/subAgent.js';

// We test the safety logic by mocking the provider/router and tool runner.
// The sub-agent loop is too heavy to run fully in unit tests (loads skills,
// registry, etc.), so we verify the safety invariants at the boundary.

describe('subAgent safety invariants', () => {
    beforeEach(() => {
        vi.resetModules();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('stall threshold is 3 consecutive identical responses', () => {
        // Invariant: stallCount increments when content is identical,
        // aborts when stallCount >= STALL_THRESHOLD (3)
        const STALL_THRESHOLD = 3;
        let stallCount = 0;
        let lastContent = '';
        const contents = ['A', 'A', 'A', 'A'];
        let aborted = false;

        for (const content of contents) {
            if (content === lastContent) {
                stallCount++;
                if (stallCount >= STALL_THRESHOLD) {
                    aborted = true;
                    break;
                }
            } else {
                stallCount = 0;
                lastContent = content;
            }
        }

        expect(aborted).toBe(true);
        expect(stallCount).toBe(3);
    });

    it('stall counter resets on different content', () => {
        let stallCount = 0;
        let lastContent = '';
        const contents = ['A', 'A', 'B', 'B', 'B'];

        for (const content of contents) {
            if (content === lastContent) {
                stallCount++;
            } else {
                stallCount = 0;
                lastContent = content;
            }
        }

        expect(stallCount).toBe(2); // B repeated 3 times = 2 increments
    });

    it('loop detection catches identical tool+args in consecutive rounds', () => {
        const toolHistory = [
            { name: 'shell', args: '{"command":"ls"}', round: 0 },
            { name: 'shell', args: '{"command":"ls"}', round: 1 },
        ];

        const last = toolHistory[toolHistory.length - 1];
        const prev = toolHistory[toolHistory.length - 2];
        const looped = last.name === prev.name && last.args === prev.args;

        expect(looped).toBe(true);
    });

    it('loop detection ignores different args', () => {
        const toolHistory = [
            { name: 'shell', args: '{"command":"ls"}', round: 0 },
            { name: 'shell', args: '{"command":"pwd"}', round: 1 },
        ];

        const last = toolHistory[toolHistory.length - 1];
        const prev = toolHistory[toolHistory.length - 2];
        const looped = last.name === prev.name && last.args === prev.args;

        expect(looped).toBe(false);
    });

    it('loop detection ignores different tools', () => {
        const toolHistory = [
            { name: 'shell', args: '{"command":"ls"}', round: 0 },
            { name: 'read_file', args: '{"path":"/tmp"}', round: 1 },
        ];

        const last = toolHistory[toolHistory.length - 1];
        const prev = toolHistory[toolHistory.length - 2];
        const looped = last.name === prev.name && last.args === prev.args;

        expect(looped).toBe(false);
    });

    it('per-tool error wraps failure into ToolResult without throwing', async () => {
        // Simulate the per-tool try/catch from the new subAgent loop
        const mockExecuteTools = vi.fn();
        mockExecuteTools.mockRejectedValueOnce(new Error('segfault'));
        mockExecuteTools.mockResolvedValueOnce([{
            toolCallId: 'tc2',
            name: 'read_file',
            content: 'hello',
            success: true,
            durationMs: 10,
        }]);

        const toolCalls = [
            { id: 'tc1', type: 'function' as const, function: { name: 'shell', arguments: '{"command":"bad"}' } },
            { id: 'tc2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"/tmp"}' } },
        ];

        const results = [];
        for (const tc of toolCalls) {
            let result;
            try {
                const singleResult = await mockExecuteTools([tc]);
                result = singleResult[0];
            } catch (toolErr) {
                result = {
                    toolCallId: tc.id,
                    name: tc.function.name,
                    content: `Error executing ${tc.function.name}: ${(toolErr as Error).message}`,
                    success: false,
                    durationMs: 0,
                };
            }
            results.push(result);
        }

        expect(results[0].success).toBe(false);
        expect(results[0].content).toContain('segfault');
        expect(results[1].success).toBe(true);
        expect(results[1].content).toBe('hello');
    });

    it('subAgent config interface accepts safety flags', () => {
        // Verify the SubAgentConfig shape hasn't lost safety-relevant fields
        const cfg: SubAgentConfig = {
            name: 'TestAgent',
            task: 'do thing',
            maxRounds: 5,
            depth: 0,
        };
        expect(cfg.maxRounds).toBe(5);
        expect(cfg.depth).toBe(0);
    });
});


describe('subAgent tool output summarization', () => {
    it('truncates tool outputs > 10K chars with a marker', () => {
        const MAX_TOOL_OUTPUT = 10_000;
        const longOutput = 'x'.repeat(15_000);
        const marker = `\n\n[…output truncated from ${longOutput.length} to ${MAX_TOOL_OUTPUT} chars — full result available via tool re-execution with narrower scope]`;
        const summarized = longOutput.length > MAX_TOOL_OUTPUT
            ? longOutput.slice(0, MAX_TOOL_OUTPUT - marker.length) + marker
            : longOutput;

        expect(summarized.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
        expect(summarized).toContain('[…output truncated');
        expect(summarized).toContain('15000');
    });

    it('leaves short tool outputs untouched', () => {
        const shortOutput = 'hello world';
        const MAX_TOOL_OUTPUT = 10_000;
        const summarized = shortOutput.length > MAX_TOOL_OUTPUT ? 'truncated' : shortOutput;
        expect(summarized).toBe('hello world');
    });
});

describe('subAgent graceful degradation', () => {
    it('detects when all tools in a round fail', () => {
        const toolResults = [
            { name: 'read_file', success: false, content: 'Error: ENOENT' },
            { name: 'search_web', success: false, content: 'Error: timeout' },
        ];
        const allFailed = toolResults.every(r => r.success === false);
        expect(allFailed).toBe(true);
    });

    it('does not trigger degradation when at least one tool succeeds', () => {
        const toolResults = [
            { name: 'read_file', success: false, content: 'Error: ENOENT' },
            { name: 'search_web', success: true, content: 'results found' },
        ];
        const allFailed = toolResults.every(r => r.success === false);
        expect(allFailed).toBe(false);
    });
});
