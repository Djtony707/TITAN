/**
 * TITAN — MCP Server Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock config
const mockConfig = {
    security: { deniedTools: [] as string[], allowedTools: [] as string[], commandTimeout: 30000 },
    mcp: { server: { enabled: true } },
};
vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn(() => mockConfig),
}));

// Mock tool registry
const mockTools = [
    {
        name: 'shell',
        description: 'Execute a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        execute: vi.fn(async (args: Record<string, unknown>) => `Executed: ${args.command}`),
    },
    {
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        execute: vi.fn(async (args: Record<string, unknown>) => `Results for: ${args.query}`),
    },
    {
        name: 'disabled_tool',
        description: 'This tool is disabled',
        parameters: { type: 'object', properties: {} },
        execute: vi.fn(async () => 'should not run'),
    },
];

vi.mock('../src/agent/toolRunner.js', () => ({
    getRegisteredTools: vi.fn(() => mockTools),
}));

vi.mock('../src/skills/registry.js', () => ({
    isToolSkillEnabled: vi.fn((name: string) => name !== 'disabled_tool'),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_VERSION: '2026.9.0',
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_NAME: 'TITAN',
}));

import { handleJsonRpcRequest, getMcpServerStatus } from '../src/mcp/server.js';

// ─── Initialize ──────────────────────────────────────────────────
describe('MCP Server — initialize', () => {
    it('should respond with server info and capabilities', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'test-client', version: '1.0' },
            },
        });

        expect(response).not.toBeNull();
        expect(response!.id).toBe(1);
        expect(response!.result).toBeDefined();
        const result = response!.result as Record<string, unknown>;
        expect(result.protocolVersion).toBe('2025-03-26');
        expect(result.serverInfo).toEqual({ name: 'TITAN', version: '2026.9.0' });
        expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
    });
});

// ─── Ping ────────────────────────────────────────────────────────
describe('MCP Server — ping', () => {
    it('should respond to ping', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0', id: 2, method: 'ping',
        });
        expect(response).not.toBeNull();
        expect(response!.result).toEqual({});
    });
});

// ─── tools/list ──────────────────────────────────────────────────
describe('MCP Server — tools/list', () => {
    it('should list all enabled tools with correct MCP format', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0', id: 3, method: 'tools/list',
        });

        expect(response).not.toBeNull();
        const result = response!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
        expect(result.tools).toBeDefined();
        expect(result.tools.length).toBe(2); // shell + web_search (disabled_tool filtered)
        expect(result.tools[0].name).toBe('shell');
        expect(result.tools[0].description).toBe('Execute a shell command');
        expect(result.tools[0].inputSchema).toBeDefined();
    });

    it('should respect denied tools', async () => {
        mockConfig.security.deniedTools = ['shell'];
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0', id: 4, method: 'tools/list',
        });

        const result = response!.result as { tools: Array<{ name: string }> };
        expect(result.tools.length).toBe(1);
        expect(result.tools[0].name).toBe('web_search');
        mockConfig.security.deniedTools = [];
    });

    it('should respect allowed tools whitelist', async () => {
        mockConfig.security.allowedTools = ['web_search'];
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0', id: 5, method: 'tools/list',
        });

        const result = response!.result as { tools: Array<{ name: string }> };
        expect(result.tools.length).toBe(1);
        expect(result.tools[0].name).toBe('web_search');
        mockConfig.security.allowedTools = [];
    });
});

// ─── tools/call ──────────────────────────────────────────────────
describe('MCP Server — tools/call', () => {
    it('should execute a tool and return text content', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 6,
            method: 'tools/call',
            params: { name: 'shell', arguments: { command: 'ls' } },
        });

        expect(response).not.toBeNull();
        const result = response!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
        expect(result.isError).toBe(false);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toBe('Executed: ls');
    });

    it('should return error for unknown tool', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'nonexistent', arguments: {} },
        });

        const result = response!.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('unknown tool');
    });

    it('should return error for disabled tool', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 8,
            method: 'tools/call',
            params: { name: 'disabled_tool', arguments: {} },
        });

        const result = response!.result as { isError: boolean };
        expect(result.isError).toBe(true);
    });

    it('should return error for denied tool', async () => {
        mockConfig.security.deniedTools = ['shell'];
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: { name: 'shell', arguments: { command: 'rm -rf /' } },
        });

        const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('denied');
        mockConfig.security.deniedTools = [];
    });

    it('should handle tool execution errors gracefully', async () => {
        mockTools[0].execute.mockRejectedValueOnce(new Error('permission denied'));
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: { name: 'shell', arguments: { command: 'fail' } },
        });

        const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('permission denied');
    });

    it('should return error when tool name is missing', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: {},
        });

        expect(response).not.toBeNull();
        expect(response!.error).toBeDefined();
        expect(response!.error!.code).toBe(-32602);
        expect(response!.error!.message).toContain('Tool name');
    });
});

// ─── Unknown method ──────────────────────────────────────────────
describe('MCP Server — unknown method', () => {
    it('should return method not found error', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0', id: 12, method: 'resources/list',
        });

        expect(response).not.toBeNull();
        expect(response!.error).toBeDefined();
        expect(response!.error!.code).toBe(-32601);
    });
});

// ─── Notifications ───────────────────────────────────────────────
describe('MCP Server — notifications', () => {
    it('should return null for notifications/initialized', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0', method: 'notifications/initialized',
        });
        expect(response).toBeNull();
    });

    it('should return null for notifications/cancelled', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
        });
        expect(response).toBeNull();
    });
});

// ─── Server Status ───────────────────────────────────────────────
describe('MCP Server — status', () => {
    it('should report server status', () => {
        const status = getMcpServerStatus();
        expect(status.enabled).toBe(true);
        expect(status.toolCount).toBe(2); // shell + web_search (disabled excluded)
        expect(typeof status.initialized).toBe('boolean');
    });
});
