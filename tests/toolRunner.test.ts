import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        loadConfig: vi.fn().mockReturnValue({
            ...actual.getDefaultConfig(),
            security: {
                ...actual.getDefaultConfig().security,
                commandTimeout: 100,  // fast timeout for test
                deniedTools: [],
                allowedTools: [],     // empty = allow all registered tools
            },
        }),
        resetConfigCache: vi.fn(),
    };
});

import {
    registerTool, unregisterTool, getRegisteredTools, getToolDefinitions, executeTool,
} from '../src/agent/toolRunner.js';
import { loadConfig } from '../src/config/config.js';
import type { ToolCall } from '../src/providers/base.js';

function makeCall(name: string, args: Record<string, unknown> = {}): ToolCall {
    return { id: 'tc-1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const ECHO = 'test_echo_titan';
const SLOW = 'test_slow_titan';

describe('ToolRunner', () => {
    beforeEach(() => {
        registerTool({
            name: ECHO,
            description: 'Echo tool for tests',
            parameters: { type: 'object', properties: { msg: { type: 'string' } } },
            execute: async (args) => `echo:${args.msg ?? 'empty'}`,
        });
    });

    afterEach(() => {
        unregisterTool(ECHO);
        unregisterTool(SLOW);
    });

    it('registerTool adds tool to registry', () => {
        const found = getRegisteredTools().find(t => t.name === ECHO);
        expect(found).toBeDefined();
        expect(found!.description).toBe('Echo tool for tests');
    });

    it('getToolDefinitions returns correct schema shape', () => {
        const defs = getToolDefinitions();
        if (defs.length > 0) {
            expect(defs[0]).toHaveProperty('type', 'function');
            expect(defs[0].function).toHaveProperty('name');
            expect(defs[0].function).toHaveProperty('description');
            expect(defs[0].function).toHaveProperty('parameters');
        }
    });

    it('executeTool: valid tool succeeds', async () => {
        const result = await executeTool(makeCall(ECHO, { msg: 'hello' }));
        expect(result.success).toBe(true);
        expect(result.content).toBe('echo:hello');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('executeTool: unknown tool returns success=false', async () => {
        const result = await executeTool(makeCall('non_existent_tool_xyz'));
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/unknown tool/i);
    });

    it('executeTool: timed-out tool returns timeout error', async () => {
        registerTool({
            name: SLOW,
            description: 'Slow tool',
            parameters: { type: 'object', properties: {} },
            execute: () => new Promise(r => setTimeout(() => r('done'), 60000)),
        });
        const result = await executeTool(makeCall(SLOW));
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/timed out/i);
    }, 10000);

    // ─── Additional tests ───────────────────────────────────────────
    it('unregisterTool removes a tool from registry', () => {
        const TEMP = 'test_temp_tool_remove';
        registerTool({
            name: TEMP,
            description: 'Temporary',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'temp',
        });
        expect(getRegisteredTools().find(t => t.name === TEMP)).toBeDefined();
        unregisterTool(TEMP);
        expect(getRegisteredTools().find(t => t.name === TEMP)).toBeUndefined();
    });

    it('getRegisteredTools returns all registered tools', () => {
        const tools = getRegisteredTools();
        expect(Array.isArray(tools)).toBe(true);
        // ECHO is registered in beforeEach
        expect(tools.some(t => t.name === ECHO)).toBe(true);
    });

    it('getToolDefinitions filters denied tools', () => {
        vi.mocked(loadConfig).mockReturnValueOnce({
            security: {
                commandTimeout: 100,
                deniedTools: [ECHO],
                allowedTools: [],
            },
        } as any);
        const defs = getToolDefinitions();
        const echoFound = defs.find(d => d.function.name === ECHO);
        expect(echoFound).toBeUndefined();
    });

    it('getToolDefinitions filters by allowlist (only allowed tools pass)', () => {
        vi.mocked(loadConfig).mockReturnValueOnce({
            security: {
                commandTimeout: 100,
                deniedTools: [],
                allowedTools: ['only_this_tool'],
            },
        } as any);
        const defs = getToolDefinitions();
        // ECHO should not be in the list since it's not in allowedTools
        const echoFound = defs.find(d => d.function.name === ECHO);
        expect(echoFound).toBeUndefined();
    });

    it('executeTool with malformed JSON arguments uses empty args', async () => {
        const call: ToolCall = {
            id: 'tc-bad-json',
            type: 'function',
            function: { name: ECHO, arguments: '{not valid json' },
        };
        const result = await executeTool(call);
        // Should not crash, args defaults to {}
        expect(result.success).toBe(true);
        expect(result.content).toBe('echo:empty');
    });

    it('executeTool with tool that throws returns error result', async () => {
        const THROWS = 'test_throws_tool';
        registerTool({
            name: THROWS,
            description: 'Throws',
            parameters: { type: 'object', properties: {} },
            execute: async () => { throw new Error('intentional error'); },
        });
        const result = await executeTool(makeCall(THROWS));
        expect(result.success).toBe(false);
        expect(result.content).toContain('intentional error');
        unregisterTool(THROWS);
    });

    it('executeTool returns correct toolCallId', async () => {
        const call: ToolCall = {
            id: 'my-unique-id-42',
            type: 'function',
            function: { name: ECHO, arguments: '{"msg":"test"}' },
        };
        const result = await executeTool(call);
        expect(result.toolCallId).toBe('my-unique-id-42');
    });

    it('executeTool returns correct tool name in result', async () => {
        const result = await executeTool(makeCall(ECHO, { msg: 'x' }));
        expect(result.name).toBe(ECHO);
    });

    it('executeTool truncates output at 50KB', async () => {
        const LONG_OUT = 'test_long_output_tool';
        registerTool({
            name: LONG_OUT,
            description: 'Produces long output',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'X'.repeat(60000), // 60KB > 50KB limit
        });
        const result = await executeTool(makeCall(LONG_OUT));
        expect(result.success).toBe(true);
        expect(result.content.length).toBeLessThanOrEqual(50100); // 50KB + truncation message
        expect(result.content).toContain('chars omitted');
        unregisterTool(LONG_OUT);
    });

    it('executeTool does not truncate output under 50KB', async () => {
        const SHORT_OUT = 'test_short_output_tool';
        registerTool({
            name: SHORT_OUT,
            description: 'Short output',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'Y'.repeat(1000),
        });
        const result = await executeTool(makeCall(SHORT_OUT));
        expect(result.success).toBe(true);
        expect(result.content).toBe('Y'.repeat(1000));
        expect(result.content).not.toContain('[Output truncated');
        unregisterTool(SHORT_OUT);
    });

    it('executeTool blocks denied tools', async () => {
        vi.mocked(loadConfig).mockReturnValueOnce({
            security: {
                commandTimeout: 100,
                deniedTools: [ECHO],
                allowedTools: [],
            },
        } as any);
        const result = await executeTool(makeCall(ECHO, { msg: 'blocked' }));
        expect(result.success).toBe(false);
        expect(result.content).toContain('denied');
    });

    it('executeTool has durationMs >= 0', async () => {
        const result = await executeTool(makeCall(ECHO, { msg: 'timing' }));
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('registering same tool name overwrites previous', () => {
        const OVERWRITE = 'test_overwrite_tool';
        registerTool({
            name: OVERWRITE,
            description: 'Version 1',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'v1',
        });
        registerTool({
            name: OVERWRITE,
            description: 'Version 2',
            parameters: { type: 'object', properties: {} },
            execute: async () => 'v2',
        });
        const found = getRegisteredTools().filter(t => t.name === OVERWRITE);
        expect(found.length).toBe(1);
        expect(found[0].description).toBe('Version 2');
        unregisterTool(OVERWRITE);
    });
});
