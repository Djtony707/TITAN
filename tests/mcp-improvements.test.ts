/**
 * TITAN — MCP Improvements Tests
 * Tests for dynamic tool discovery, session management, error handling, and health check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Mock tool registry with many tools
const createMockTools = (count: number) => {
    return Array.from({ length: count }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool number ${i} for testing`,
        parameters: { type: 'object', properties: { param: { type: 'string' } } },
        execute: vi.fn(async (args: Record<string, unknown>) => `Result from tool_${i}: ${args.param}`),
    }));
};

const mockTools = createMockTools(10);
mockTools.push({
    name: 'large_output_tool',
    description: 'Generates large output',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => 'x'.repeat(150000)), // 150KB output
});
mockTools.push({
    name: 'failing_tool',
    description: 'Always fails',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => { throw new Error('Intentional failure'); }),
});

vi.mock('../src/agent/toolRunner.js', () => ({
    getRegisteredTools: vi.fn(() => mockTools),
}));

vi.mock('../src/skills/registry.js', () => ({
    isToolSkillEnabled: vi.fn(() => true),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_VERSION: '2026.10.70',
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_NAME: 'TITAN',
}));

import {
    handleJsonRpcRequest,
    getMcpServerStatus,
    mountMcpHttpEndpoints,
} from '../src/mcp/server.js';

// ─── Dynamic Tool Discovery ──────────────────────────────────────
describe('MCP Server — Dynamic Tool Discovery', () => {
    beforeEach(async () => {
        // Ensure server is initialized before each test
        await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: { clientInfo: { name: 'test-client' } },
        });
    });

    it('should list all enabled tools with complete metadata', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
        });

        expect(response).not.toBeNull();
        const result = response!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
        expect(result.tools).toBeDefined();
        expect(result.tools.length).toBe(12); // 10 normal + large_output + failing

        // Verify each tool has complete metadata
        for (const tool of result.tools) {
            expect(tool.name).toBeDefined();
            expect(tool.description).toBeDefined();
            expect(tool.inputSchema).toBeDefined();
        }
    });

    it('should include skill source information', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
        });

        const result = response!.result as { tools: Array<{ _skillSource?: string }> };
        // Tools should have skill source if available
        expect(result.tools[0]._skillSource).toBeDefined();
    });

    it('should handle empty tool registry gracefully', async () => {
        // Need to reset modules to get fresh handler
        const { handleJsonRpcRequest: freshHandler } = await import('../src/mcp/server.js');

        // Mock tools to empty
        const { getRegisteredTools } = await import('../src/agent/toolRunner.js');
        vi.mocked(getRegisteredTools).mockReturnValueOnce([]);

        const response = await freshHandler({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/list',
        });

        const result = response!.result as { tools: unknown[] };
        expect(result.tools.length).toBe(0);
    });
});

// ─── Session Management ──────────────────────────────────────────
describe('MCP Server — Session Management', () => {
    it('should create a session on initialize', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 10,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                clientInfo: { name: 'test-client', version: '1.0' },
            },
        });

        expect(response).not.toBeNull();
        const result = response!.result as { sessionId?: string; capabilities: unknown };
        expect(result.sessionId).toBeDefined();
        expect(result.sessionId).toMatch(/^mcp-session-/);
        expect(result.capabilities).toBeDefined();
    });

    it('should track active sessions', async () => {
        // Initialize multiple sessions
        await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 11,
            method: 'initialize',
            params: { clientInfo: { name: 'client-1' } },
        });

        await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 12,
            method: 'initialize',
            params: { clientInfo: { name: 'client-2' } },
        });

        const status = getMcpServerStatus();
        expect(status.activeSessions).toBeGreaterThan(0);
    });

    it('should provide session info via session/info method', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 13,
            method: 'session/info',
        });

        expect(response).not.toBeNull();
        const result = response!.result as {
            sessionId: string | null;
            activeSessions: number;
            serverVersion: string;
        };
        expect(result.activeSessions).toBeGreaterThanOrEqual(0);
        expect(result.serverVersion).toBe('2026.10.70');
    });
});

// ─── Error Handling (JSON-RPC 2.0 spec) ──────────────────────────
describe('MCP Server — Error Handling', () => {
    it('should return proper error for invalid JSON-RPC version', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '1.0' as '2.0',
            id: 20,
            method: 'ping',
        });

        expect(response).not.toBeNull();
        expect(response!.error).toBeDefined();
        expect(response!.error!.code).toBe(-32600);
        expect(response!.error!.message).toContain('Invalid JSON-RPC version');
    });

    it('should return error for missing method', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 21,
            method: '' as string,
        });

        expect(response).not.toBeNull();
        expect(response!.error!.code).toBe(-32601);
    });

    it('should return NOT_INITIALIZED error when calling tools before init', async () => {
        // Reset modules to clear initialized state
        vi.resetModules();
        const { handleJsonRpcRequest: freshHandler } = await import('../src/mcp/server.js');

        const response = await freshHandler({
            jsonrpc: '2.0',
            id: 22,
            method: 'tools/list',
        });

        expect(response).not.toBeNull();
        expect(response!.error!.code).toBe(-32000);
        expect(response!.error!.message).toContain('not initialized');
    });

    it('should return INVALID_PARAMS for tools/call without name', async () => {
        await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 23,
            method: 'initialize',
            params: { clientInfo: { name: 'test' } },
        });

        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 24,
            method: 'tools/call',
            params: { arguments: {} }, // missing name
        });

        expect(response).not.toBeNull();
        expect(response!.error!.code).toBe(-32602);
        expect(response!.error!.message).toContain('Tool name');
    });

    it('should return TOOL_NOT_FOUND for unknown tool', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 25,
            method: 'tools/call',
            params: { name: 'nonexistent_tool', arguments: {} },
        });

        const result = response!.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('unknown tool');
        expect(result.content[0].text).toContain('tools are available');
    });

    it('should handle tool execution errors with proper error format', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 26,
            method: 'tools/call',
            params: { name: 'failing_tool', arguments: {} },
        });

        const result = response!.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Intentional failure');
    });

    it('should truncate large tool output', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 27,
            method: 'tools/call',
            params: { name: 'large_output_tool', arguments: {} },
        });

        const result = response!.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(false);
        expect(result.content[0].text.length).toBeLessThan(150000);
        expect(result.content[0].text).toContain('truncated');
    });

    it('should handle internal errors gracefully', async () => {
        // Mock a handler that throws an error during execution
        vi.mocked(mockTools[0].execute).mockRejectedValueOnce(new Error('Unexpected internal error'));

        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 28,
            method: 'tools/call',
            params: { name: 'tool_0', arguments: { param: 'test' } },
        });

        const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unexpected internal error');
    });
});

// ─── Health Check Endpoint ───────────────────────────────────────
describe('MCP Server — Health Check', () => {
    it('should return health status with all required fields', () => {
        const status = getMcpServerStatus();

        expect(status.enabled).toBeDefined();
        expect(status.initialized).toBeDefined();
        expect(status.toolCount).toBeDefined();
        expect(status.totalToolCount).toBeDefined();
        expect(status.activeSessions).toBeDefined();
        expect(status.clientInfo).toBeDefined();
        expect(status.totalToolCount).toBeGreaterThanOrEqual(status.toolCount);
    });

    it('should distinguish between enabled and total tool counts', () => {
        const status = getMcpServerStatus();
        // Total should include all registered tools
        // Tool count should filter by skill enabled status
        expect(status.totalToolCount).toBe(12);
        expect(status.toolCount).toBeLessThanOrEqual(status.totalToolCount);
    });
});

// ─── HTTP Endpoint Tests (Integration) ───────────────────────────
describe('MCP Server — HTTP Endpoints', () => {
    const mockApp: {
        get: ReturnType<typeof vi.fn>;
        post: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
    } = {
        get: vi.fn(),
        post: vi.fn(),
        delete: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mountMcpHttpEndpoints(mockApp as unknown as ReturnType<typeof vi.fn> & typeof mockApp);
    });

    it('should register GET /mcp/health endpoint', () => {
        expect(mockApp.get).toHaveBeenCalledWith('/mcp/health', expect.any(Function));
    });

    it('should register POST /mcp endpoint', () => {
        expect(mockApp.post).toHaveBeenCalledWith('/mcp', expect.any(Function));
    });

    it('should register GET /mcp endpoint for SSE', () => {
        expect(mockApp.get).toHaveBeenCalledWith('/mcp', expect.any(Function));
    });

    it('should register DELETE /mcp endpoint', () => {
        expect(mockApp.delete).toHaveBeenCalledWith('/mcp', expect.any(Function));
    });

    it('should health check return complete status', async () => {
        const mockReq = {};
        const mockRes = {
            json: vi.fn(),
        };

        // Get the health handler
        mountMcpHttpEndpoints(mockApp as unknown as ReturnType<typeof vi.fn> & typeof mockApp);
        const healthHandler = mockApp.get.mock.calls.find(
            (call) => call[0] === '/mcp/health'
        )?.[1];

        if (healthHandler) {
            healthHandler(mockReq, mockRes);
            expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
                status: 'ok',
                version: expect.any(String),
                toolCount: expect.any(Number),
                activeSessions: expect.any(Number),
            }));
        }
    });
});

// ─── JSON-RPC Validation ─────────────────────────────────────────
describe('MCP Server — JSON-RPC Validation', () => {
    it('should reject non-2.0 JSON-RPC requests', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '1.0' as '2.0',
            id: 100,
            method: 'ping',
        });

        expect(response!.error!.code).toBe(-32600);
    });

    it('should handle requests without id (notifications)', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            method: 'notifications/test',
        });
        expect(response).toBeNull();
    });

    it('should handle malformed requests', async () => {
        const response = await handleJsonRpcRequest({
            jsonrpc: '2.0',
            id: 101,
            method: undefined as unknown as string,
        });

        expect(response).not.toBeNull();
        expect(response!.error!.code).toBe(-32601);
    });
});
