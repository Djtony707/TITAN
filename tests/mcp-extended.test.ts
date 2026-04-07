/**
 * TITAN — MCP Client Extended Tests
 * Additional coverage for MCP client: HTTP tool calls, stdio tool calls,
 * concurrent tool calls, timeout handling, edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

const { mockStdin, mockStdout, mockStderr, mockProc } = vi.hoisted(() => {
    const mockStdin = { write: vi.fn() };
    const mockStdout = { on: vi.fn(), off: vi.fn() };
    const mockStderr = { on: vi.fn() };
    const mockProc = {
        stdin: mockStdin,
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
        pid: 99999,
    };
    return { mockStdin, mockStdout, mockStderr, mockProc };
});

vi.mock('child_process', () => ({
    spawn: vi.fn().mockReturnValue(mockProc),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-mcp-ext',
    TITAN_VERSION: '2026.5.2',
}));

const { mockRegisterTool, mockUnregisterTool } = vi.hoisted(() => ({
    mockRegisterTool: vi.fn(),
    mockUnregisterTool: vi.fn(),
}));
vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: mockRegisterTool,
    unregisterTool: mockUnregisterTool,
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ────────────────────────────────────────────────────

import { connectMcpServer, disconnectMcpServer, getMcpConnections, testMcpServer, type McpServer } from '../src/mcp/client.js';
import { spawn } from 'child_process';
import logger from '../src/utils/logger.js';

// ── Test Suite ────────────────────────────────────────────────────────────

describe('MCP Client — Extended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRegisterTool.mockClear();
        mockUnregisterTool.mockClear();
        mockStdin.write.mockClear();
        mockStdout.on.mockClear();
        mockStdout.off.mockClear();
        mockProc.on.mockClear();
        mockProc.kill.mockClear();
        mockFetch.mockReset();
    });

    afterEach(() => {
        for (const conn of getMcpConnections()) {
            disconnectMcpServer(conn.server.id);
        }
    });

    // ── HTTP tool call tests ────────────────────────────────────────

    describe('HTTP tool calls', () => {
        const httpServer: McpServer = {
            id: 'ext-http-call',
            name: 'HTTP Call Test',
            description: 'Test HTTP tool calls',
            type: 'http',
            url: 'http://localhost:7777',
            timeoutMs: 5000,
            enabled: true,
        };

        it('should register tools with execute function that calls HTTP endpoint', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'search_web', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
                        ],
                    },
                }),
            });

            const conn = await connectMcpServer(httpServer);
            expect(conn.status).toBe('connected');
            expect(mockRegisterTool).toHaveBeenCalledTimes(1);

            // Get the registered execute function
            const registeredTool = mockRegisterTool.mock.calls[0][0];
            expect(registeredTool.name).toBe('mcp_ext_http_call_search_web');
            expect(typeof registeredTool.execute).toBe('function');

            // Call the tool
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        content: [
                            { text: 'Search result 1' },
                            { text: 'Search result 2' },
                        ],
                    },
                }),
            });

            const result = await registeredTool.execute({ query: 'TITAN framework' });
            expect(result).toBe('Search result 1\nSearch result 2');

            // Verify the fetch call
            const callArgs = mockFetch.mock.calls[1];
            expect(callArgs[0]).toBe('http://localhost:7777/tools/call');
            const body = JSON.parse(callArgs[1].body);
            expect(body.method).toBe('tools/call');
            expect(body.params.name).toBe('search_web');
            expect(body.params.arguments.query).toBe('TITAN framework');
        });

        it('should return "No output" when tool result has no content', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'empty_tool', description: 'Returns nothing', inputSchema: {} },
                        ],
                    },
                }),
            });

            const conn = await connectMcpServer({ ...httpServer, id: 'ext-http-empty' });
            const registeredTool = mockRegisterTool.mock.calls[0][0];

            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: {} }),
            });

            const result = await registeredTool.execute({});
            expect(result).toBe('No output');
        });

        it('should handle content items with no text field', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'image_tool', description: 'Returns image', inputSchema: {} },
                        ],
                    },
                }),
            });

            const conn = await connectMcpServer({ ...httpServer, id: 'ext-http-notext' });
            const registeredTool = mockRegisterTool.mock.calls[0][0];

            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        content: [
                            { image: 'base64data' }, // No text field
                        ],
                    },
                }),
            });

            const result = await registeredTool.execute({});
            // Content items with no text field map to '' which join to '' but || 'No output' fallback kicks in
            expect(result).toBe('No output');
        });
    });

    // ── Stdio tool call tests ───────────────────────────────────────

    describe('Stdio tool calls', () => {
        const stdioServer: McpServer = {
            id: 'ext-stdio-call',
            name: 'Stdio Call Test',
            description: 'Test stdio tool calls',
            type: 'stdio',
            command: 'node mcp-server.js',
            timeoutMs: 5000,
            enabled: true,
        };

        /** Helper: set up mock stdout with proper on/off tracking */
        function setupStdoutMock() {
            const dataListeners: Function[] = [];
            mockStdout.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'data') dataListeners.push(cb);
            });
            mockStdout.off.mockImplementation((event: string, cb: Function) => {
                if (event === 'data') {
                    const idx = dataListeners.indexOf(cb);
                    if (idx >= 0) dataListeners.splice(idx, 1);
                }
            });
            mockProc.on.mockImplementation(() => {});
            return {
                emit(data: string | Buffer) {
                    for (const cb of [...dataListeners]) cb(Buffer.from(typeof data === 'string' ? data : data));
                },
            };
        }

        it('should successfully call a tool via stdio and receive result', async () => {
            const stdout = setupStdoutMock();

            const connPromise = connectMcpServer(stdioServer);
            await new Promise(r => setTimeout(r, 20));

            // Simulate server init + tools/list
            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {} } } }) + '\n');
            await new Promise(r => setTimeout(r, 10));
            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'run_query', description: 'Run a query', inputSchema: { type: 'object' } }] } }) + '\n');

            const conn = await connPromise;
            expect(conn.status).toBe('connected');
            expect(conn.tools.length).toBe(1);

            const registeredTool = mockRegisterTool.mock.calls[0][0];

            // Call tool — the persistent handler resolves from pendingRequests map
            const toolPromise = registeredTool.execute({ sql: 'SELECT 1' });
            await new Promise(r => setTimeout(r, 20));

            // Find request ID from stdin write and simulate response
            const lastWrite = mockStdin.write.mock.calls[mockStdin.write.mock.calls.length - 1][0];
            const sentMsg = JSON.parse(lastWrite.trim());
            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: sentMsg.id, result: { content: [{ text: 'Query executed: 1 row' }] } }) + '\n');

            const result = await toolPromise;
            expect(result).toBe('Query executed: 1 row');
        });

        it('should reject when process stdin is not available', async () => {
            const stdout = setupStdoutMock();

            const connPromise = connectMcpServer({ ...stdioServer, id: 'ext-stdio-nostdin' });
            await new Promise(r => setTimeout(r, 20));

            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }) + '\n');
            await new Promise(r => setTimeout(r, 10));
            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'test', description: 'test', inputSchema: {} }] } }) + '\n');

            const conn = await connPromise;
            const tool = mockRegisterTool.mock.calls[0][0];

            const origStdin = conn.process!.stdin;
            (conn.process as any).stdin = null;
            await expect(tool.execute({})).rejects.toThrow('MCP process not running');
            (conn.process as any).stdin = origStdin;
        });

        it('should handle tool call with error message in response', async () => {
            const stdout = setupStdoutMock();

            const connPromise = connectMcpServer({ ...stdioServer, id: 'ext-stdio-toolerr' });
            await new Promise(r => setTimeout(r, 20));

            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }) + '\n');
            await new Promise(r => setTimeout(r, 10));
            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'err_tool', description: 'Errors', inputSchema: {} }] } }) + '\n');

            const conn = await connPromise;
            const tool = mockRegisterTool.mock.calls[0][0];

            const toolPromise = tool.execute({});
            await new Promise(r => setTimeout(r, 20));

            const lastWrite = mockStdin.write.mock.calls[mockStdin.write.mock.calls.length - 1][0];
            const sentMsg = JSON.parse(lastWrite.trim());
            stdout.emit(JSON.stringify({ jsonrpc: '2.0', id: sentMsg.id, error: { message: 'Tool execution failed' } }) + '\n');

            const result = await toolPromise;
            expect(result).toBe('Tool execution failed');
        });
    });

    // ── Connection management ───────────────────────────────────────

    describe('Connection management', () => {
        it('should log info when connecting', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: { tools: [] } }),
            });

            await connectMcpServer({
                id: 'ext-log-test',
                name: 'Log Test Server',
                description: 'Tests logging',
                type: 'http',
                url: 'http://localhost:3333',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(logger.info).toHaveBeenCalledWith('MCP', expect.stringContaining('Connecting to MCP server: Log Test Server'));
        });

        it('should log connected with tool count', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 't1', description: 'd1', inputSchema: {} },
                            { name: 't2', description: 'd2', inputSchema: {} },
                        ],
                    },
                }),
            });

            await connectMcpServer({
                id: 'ext-tool-count',
                name: 'Tool Count',
                description: 'Count tools',
                type: 'http',
                url: 'http://localhost:4444',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(logger.info).toHaveBeenCalledWith('MCP', expect.stringContaining('2 tools available'));
        });

        it('should log error on failed connection', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

            await connectMcpServer({
                id: 'ext-fail-log',
                name: 'Fail Log',
                description: 'Fails',
                type: 'http',
                url: 'http://localhost:1111',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(logger.error).toHaveBeenCalledWith('MCP', expect.stringContaining('Failed to connect'));
        });

        it('should disconnect and unregister multiple tools', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'tool_a', description: 'A', inputSchema: {} },
                            { name: 'tool_b', description: 'B', inputSchema: {} },
                            { name: 'tool_c', description: 'C', inputSchema: {} },
                        ],
                    },
                }),
            });

            await connectMcpServer({
                id: 'ext-multi-unreg',
                name: 'Multi Unreg',
                description: 'Multiple unregister',
                type: 'http',
                url: 'http://localhost:5555',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(mockRegisterTool).toHaveBeenCalledTimes(3);

            disconnectMcpServer('ext-multi-unreg');

            expect(mockUnregisterTool).toHaveBeenCalledTimes(3);
            expect(mockUnregisterTool).toHaveBeenCalledWith('mcp_ext_multi_unreg_tool_a');
            expect(mockUnregisterTool).toHaveBeenCalledWith('mcp_ext_multi_unreg_tool_b');
            expect(mockUnregisterTool).toHaveBeenCalledWith('mcp_ext_multi_unreg_tool_c');
        });

        it('should kill process on disconnect', async () => {
            const dataListeners: Function[] = [];
            mockStdout.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'data') dataListeners.push(cb);
            });
            mockStdout.off.mockImplementation((event: string, cb: Function) => {
                if (event === 'data') {
                    const idx = dataListeners.indexOf(cb);
                    if (idx >= 0) dataListeners.splice(idx, 1);
                }
            });
            mockProc.on.mockImplementation(() => {});

            const connPromise = connectMcpServer({
                id: 'ext-kill-proc',
                name: 'Kill Proc',
                description: 'Kill process test',
                type: 'stdio',
                command: 'node server.js',
                timeoutMs: 5000,
                enabled: true,
            });

            await new Promise(r => setTimeout(r, 20));

            const emit = (data: string) => dataListeners.forEach(cb => cb(Buffer.from(data)));
            emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }) + '\n');
            await new Promise(r => setTimeout(r, 10));
            emit(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) + '\n');

            await connPromise;

            disconnectMcpServer('ext-kill-proc');
            expect(mockProc.kill).toHaveBeenCalled();
        });
    });

    // ── testMcpServer ───────────────────────────────────────────────

    describe('testMcpServer', () => {
        it('should return ok=true and tool count for working HTTP server', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'a', description: 'a', inputSchema: {} },
                            { name: 'b', description: 'b', inputSchema: {} },
                        ],
                    },
                }),
            });

            const result = await testMcpServer({
                id: 'ext-test-ok',
                name: 'Test OK',
                description: 'Works',
                type: 'http',
                url: 'http://localhost:8888',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(result.ok).toBe(true);
            expect(result.tools).toBe(2);
            expect(result.error).toBeUndefined();
        });

        it('should return ok=false and error for failing HTTP server', async () => {
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const result = await testMcpServer({
                id: 'ext-test-fail',
                name: 'Test Fail',
                description: 'Fails',
                type: 'http',
                url: 'http://localhost:9999',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(result.ok).toBe(false);
            expect(result.tools).toBe(0);
            expect(result.error).toBe('ECONNREFUSED');
        });
    });

    // ── Tool name sanitization ──────────────────────────────────────

    describe('Tool name sanitization', () => {
        it('should replace hyphens and dots with underscores in server ID and tool name', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'my-tool.v2', description: 'Versioned', inputSchema: {} },
                        ],
                    },
                }),
            });

            await connectMcpServer({
                id: 'srv-with.dots',
                name: 'Dot Server',
                description: 'Dots and hyphens',
                type: 'http',
                url: 'http://localhost:6666',
                timeoutMs: 5000,
                enabled: true,
            });

            const registeredName = mockRegisterTool.mock.calls[0][0].name;
            expect(registeredName).toBe('mcp_srv_with_dots_my_tool_v2');
        });

        it('should use empty inputSchema as default when tool has no inputSchema', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'no_schema', description: 'No schema', inputSchema: undefined },
                        ],
                    },
                }),
            });

            await connectMcpServer({
                id: 'ext-no-schema',
                name: 'No Schema',
                description: 'No schema test',
                type: 'http',
                url: 'http://localhost:7777',
                timeoutMs: 5000,
                enabled: true,
            });

            const registered = mockRegisterTool.mock.calls[0][0];
            expect(registered.parameters).toEqual({ type: 'object', properties: {} });
        });
    });

    // ── Stdio command parsing ───────────────────────────────────────

    describe('Stdio command parsing', () => {
        it('should parse quoted arguments in command string', async () => {
            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'exit') setTimeout(() => cb(0), 10);
            });
            mockStdout.on.mockImplementation(() => {});

            await connectMcpServer({
                id: 'ext-quoted-cmd',
                name: 'Quoted Cmd',
                description: 'Quoted args',
                type: 'stdio',
                command: 'node "path with spaces/server.js" --flag',
                timeoutMs: 500,
                enabled: true,
            });

            expect(spawn).toHaveBeenCalled();
            const spawnCall = (spawn as any).mock.calls[(spawn as any).mock.calls.length - 1];
            expect(spawnCall[0]).toBe('node');
            // Should have parsed the quoted path
            expect(spawnCall[1]).toContain('"path with spaces/server.js"');
        });

        it('should handle server timeout correctly', async () => {
            vi.useFakeTimers();
            mockProc.on.mockImplementation(() => {}); // No exit
            mockStdout.on.mockImplementation(() => {}); // No data

            const connPromise = connectMcpServer({
                id: 'ext-timeout',
                name: 'Timeout Server',
                description: 'Times out',
                type: 'stdio',
                command: 'node slow.js',
                timeoutMs: 100,
                enabled: true,
            });

            // Advance past timeout
            await vi.advanceTimersByTimeAsync(200);

            const conn = await connPromise;
            expect(conn.status).toBe('error');
            expect(conn.error).toContain('timed out');
            expect(mockProc.kill).toHaveBeenCalled();

            vi.useRealTimers();
        });
    });

    // ── Concurrent tool calls ───────────────────────────────────────

    describe('Concurrent HTTP tool calls', () => {
        it('should handle multiple concurrent HTTP tool calls', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'concurrent_tool', description: 'Concurrent', inputSchema: {} },
                        ],
                    },
                }),
            });

            const conn = await connectMcpServer({
                id: 'ext-concurrent',
                name: 'Concurrent',
                description: 'Concurrent test',
                type: 'http',
                url: 'http://localhost:3456',
                timeoutMs: 5000,
                enabled: true,
            });

            const tool = mockRegisterTool.mock.calls[0][0];

            // Set up multiple mock responses
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: { content: [{ text: 'Result A' }] } }),
            });
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: { content: [{ text: 'Result B' }] } }),
            });
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: { content: [{ text: 'Result C' }] } }),
            });

            // Fire all 3 concurrently
            const [a, b, c] = await Promise.all([
                tool.execute({ id: 'a' }),
                tool.execute({ id: 'b' }),
                tool.execute({ id: 'c' }),
            ]);

            expect(a).toBe('Result A');
            expect(b).toBe('Result B');
            expect(c).toBe('Result C');
        });
    });
});
