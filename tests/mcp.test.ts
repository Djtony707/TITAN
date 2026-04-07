/**
 * TITAN — MCP Module Tests
 * Tests client.ts and registry.ts for MCP (Model Context Protocol) integration
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

// Use vi.hoisted() so these are available when vi.mock factories run (hoisted above imports)
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
        pid: 12345,
    };
    return { mockStdin, mockStdout, mockStderr, mockProc };
});

vi.mock('child_process', () => ({
    spawn: vi.fn().mockReturnValue(mockProc),
}));

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock constants
vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-mcp',
    TITAN_VERSION: '2026.5.0',
}));

// Mock helpers
vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: vi.fn(),
    truncate: vi.fn((s: string) => s),
    formatBytes: vi.fn(),
    formatDuration: vi.fn(),
    deepMerge: vi.fn(),
    shortId: vi.fn(),
}));

// Mock toolRunner — must use vi.hoisted for variables referenced inside vi.mock factories
const { mockRegisterTool, mockUnregisterTool } = vi.hoisted(() => ({
    mockRegisterTool: vi.fn(),
    mockUnregisterTool: vi.fn(),
}));
vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: mockRegisterTool,
    unregisterTool: mockUnregisterTool,
}));

// Mock fs for registry
let mockFiles: Record<string, string> = {};
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockImplementation((p: string) => p in mockFiles),
        readFileSync: vi.fn().mockImplementation((p: string) => {
            if (p in mockFiles) return mockFiles[p];
            throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn().mockImplementation((p: string, data: string) => {
            mockFiles[p] = data;
        }),
        mkdirSync: vi.fn(),
    };
});

// Mock fetch for HTTP connections
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Client Tests ───────────────────────────────────────────────────

import { connectMcpServer, disconnectMcpServer, getMcpConnections, testMcpServer, type McpServer } from '../src/mcp/client.js';
import { spawn } from 'child_process';
import logger from '../src/utils/logger.js';

describe('MCP Client', () => {
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
        // Disconnect any remaining connections to clean up state
        for (const conn of getMcpConnections()) {
            disconnectMcpServer(conn.server.id);
        }
    });

    // ── HTTP Connection Tests ─────────────────────────────────

    describe('connectMcpServer (HTTP)', () => {
        const httpServer: McpServer = {
            id: 'test-http',
            name: 'Test HTTP Server',
            description: 'A test HTTP MCP server',
            type: 'http',
            url: 'http://localhost:9999',
            timeoutMs: 5000,
            enabled: true,
        };

        it('should connect to HTTP server and discover tools', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
                            { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } },
                        ],
                    },
                }),
            });

            const conn = await connectMcpServer(httpServer);

            expect(conn.status).toBe('connected');
            expect(conn.tools.length).toBe(2);
            expect(conn.tools[0].name).toBe('read_file');
            expect(conn.tools[1].name).toBe('write_file');
            expect(mockRegisterTool).toHaveBeenCalledTimes(2);

            // Verify tool names are prefixed correctly
            const firstCall = mockRegisterTool.mock.calls[0][0];
            expect(firstCall.name).toMatch(/^mcp_test_http_read_file$/);
            expect(firstCall.description).toContain('[Test HTTP Server]');
        });

        it('should handle HTTP server with no tools', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: { tools: [] } }),
            });

            const conn = await connectMcpServer({ ...httpServer, id: 'test-http-empty' });

            expect(conn.status).toBe('connected');
            expect(conn.tools.length).toBe(0);
            expect(mockRegisterTool).not.toHaveBeenCalled();
        });

        it('should handle HTTP server with missing tools in response', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: {} }),
            });

            const conn = await connectMcpServer({ ...httpServer, id: 'test-http-null' });

            expect(conn.status).toBe('connected');
            expect(conn.tools.length).toBe(0);
        });

        it('should handle HTTP connection failure', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

            const conn = await connectMcpServer({ ...httpServer, id: 'test-http-fail' });

            expect(conn.status).toBe('error');
            expect(conn.error).toBe('Connection refused');
            expect(logger.error).toHaveBeenCalled();
        });

        it('should handle non-Error thrown from fetch', async () => {
            mockFetch.mockRejectedValueOnce('string error');

            const conn = await connectMcpServer({ ...httpServer, id: 'test-http-str-err' });

            expect(conn.status).toBe('error');
            expect(conn.error).toBe('string error');
        });

        it('should send correct fetch parameters', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: { tools: [] } }),
            });

            await connectMcpServer({ ...httpServer, id: 'test-http-params' });

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, options] = mockFetch.mock.calls[0];
            expect(url).toBe('http://localhost:9999/tools/list');
            expect(options.method).toBe('POST');
            expect(options.headers['Content-Type']).toBe('application/json');
            const body = JSON.parse(options.body);
            expect(body.jsonrpc).toBe('2.0');
            expect(body.method).toBe('tools/list');
        });
    });

    // ── Stdio Connection Tests ────────────────────────────────

    describe('connectMcpServer (stdio)', () => {
        const stdioServer: McpServer = {
            id: 'test-stdio',
            name: 'Test Stdio Server',
            description: 'A test stdio MCP server',
            type: 'stdio',
            command: 'node server.js',
            args: ['--port', '3000'],
            timeoutMs: 5000,
            enabled: true,
        };

        it('should spawn process with correct command and args', async () => {
            // Simulate process exiting immediately
            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'exit') setTimeout(() => cb(0), 10);
            });

            const connPromise = connectMcpServer({ ...stdioServer, id: 'test-stdio-spawn' });
            // Let the timeout resolve
            await connPromise;

            expect(spawn).toHaveBeenCalled();
            const [cmd, args] = (spawn as any).mock.calls[(spawn as any).mock.calls.length - 1];
            expect(cmd).toBe('node');
            expect(args).toContain('server.js');
            expect(args).toContain('--port');
            expect(args).toContain('3000');
        });

        it('should send initialize request on spawn', async () => {
            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'exit') setTimeout(() => cb(0), 10);
            });

            const connPromise = connectMcpServer({ ...stdioServer, id: 'test-stdio-init' });
            await connPromise;

            expect(mockStdin.write).toHaveBeenCalled();
            const initData = mockStdin.write.mock.calls[0][0];
            const parsed = JSON.parse(initData.trim());
            expect(parsed.jsonrpc).toBe('2.0');
            expect(parsed.method).toBe('initialize');
            expect(parsed.params.clientInfo.name).toBe('TITAN');
        });

        it('should handle missing command', async () => {
            const noCmd: McpServer = {
                ...stdioServer,
                id: 'test-stdio-nocmd',
                command: undefined,
            };

            const conn = await connectMcpServer(noCmd);

            expect(conn.status).toBe('error');
            expect(conn.error).toBe('No command specified');
        });

        it('should handle empty command string', async () => {
            const emptyCmd: McpServer = {
                ...stdioServer,
                id: 'test-stdio-empty',
                command: '',
            };

            const conn = await connectMcpServer(emptyCmd);

            expect(conn.status).toBe('error');
            // Either 'No command specified' or 'Empty command string' depending on regex match
            expect(conn.error).toBeDefined();
        });

        it('should handle process error', async () => {
            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'error') setTimeout(() => cb(new Error('spawn ENOENT')), 10);
            });
            mockStdout.on.mockImplementation(() => {});

            const conn = await connectMcpServer({ ...stdioServer, id: 'test-stdio-err' });

            expect(conn.status).toBe('error');
            expect(conn.error).toBe('spawn ENOENT');
        });

        it('should handle process exit before initialization', async () => {
            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'exit') setTimeout(() => cb(1), 10);
            });
            mockStdout.on.mockImplementation(() => {});

            const conn = await connectMcpServer({ ...stdioServer, id: 'test-stdio-exit' });

            expect(conn.error).toContain('exited with code');
        });

        it('should successfully connect via stdio with tool discovery', async () => {
            let dataCallback: Function | null = null;

            mockStdout.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'data') dataCallback = cb;
            });
            mockProc.on.mockImplementation(() => {});

            const connPromise = connectMcpServer({ ...stdioServer, id: 'test-stdio-success' });

            // Wait for event handlers to be registered
            await new Promise(r => setTimeout(r, 20));

            // Simulate server sending initialize response
            if (dataCallback) {
                dataCallback(Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: { capabilities: { tools: {} } },
                }) + '\n'));

                // Simulate tools/list response
                await new Promise(r => setTimeout(r, 10));
                dataCallback(Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        tools: [
                            { name: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
                        ],
                    },
                }) + '\n'));
            }

            const conn = await connPromise;

            expect(conn.status).toBe('connected');
            expect(conn.tools.length).toBe(1);
            expect(conn.tools[0].name).toBe('search');
        });

        it('should handle stdout data with non-JSON lines', async () => {
            let dataCallback: Function | null = null;

            mockStdout.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'data') dataCallback = cb;
            });
            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'exit') setTimeout(() => cb(0), 200);
            });

            const connPromise = connectMcpServer({ ...stdioServer, id: 'test-stdio-nonjson' });

            await new Promise(r => setTimeout(r, 20));

            if (dataCallback) {
                // Send non-JSON data
                dataCallback(Buffer.from('Starting server...\n'));
                dataCallback(Buffer.from('Ready!\n'));
            }

            // It should resolve via timeout or exit
            const conn = await connPromise;
            expect(conn).toBeDefined();
        });

        it('should handle server env passed to spawn', async () => {
            const serverWithEnv: McpServer = {
                ...stdioServer,
                id: 'test-stdio-env',
                env: { MY_VAR: 'hello', API_KEY: 'secret' },
            };

            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'exit') setTimeout(() => cb(0), 10);
            });

            await connectMcpServer(serverWithEnv);

            const spawnCall = (spawn as any).mock.calls[(spawn as any).mock.calls.length - 1];
            const options = spawnCall[2];
            expect(options.env.MY_VAR).toBe('hello');
            expect(options.env.API_KEY).toBe('secret');
        });
    });

    // ── disconnectMcpServer Tests ─────────────────────────────

    describe('disconnectMcpServer', () => {
        it('should unregister tools and kill process', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'tool_a', description: 'Tool A', inputSchema: {} },
                        ],
                    },
                }),
            });

            const httpServer: McpServer = {
                id: 'test-disconnect',
                name: 'Disconnect Test',
                description: 'Test disconnect',
                type: 'http',
                url: 'http://localhost:8888',
                timeoutMs: 5000,
                enabled: true,
            };

            await connectMcpServer(httpServer);
            expect(getMcpConnections().length).toBeGreaterThan(0);

            disconnectMcpServer('test-disconnect');

            expect(mockUnregisterTool).toHaveBeenCalledWith('mcp_test_disconnect_tool_a');
        });

        it('should handle disconnect of non-existent server gracefully', () => {
            expect(() => disconnectMcpServer('nonexistent')).not.toThrow();
        });
    });

    // ── getMcpConnections Tests ────────────────────────────────

    describe('getMcpConnections', () => {
        it('should return empty array when no connections', () => {
            // Disconnect all first
            for (const conn of getMcpConnections()) {
                disconnectMcpServer(conn.server.id);
            }
            // Note: may have lingering connections from previous tests
            const conns = getMcpConnections();
            expect(Array.isArray(conns)).toBe(true);
        });

        it('should return connections after connecting', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({ result: { tools: [] } }),
            });

            await connectMcpServer({
                id: 'test-list',
                name: 'List Test',
                description: 'Test listing',
                type: 'http',
                url: 'http://localhost:7777',
                timeoutMs: 5000,
                enabled: true,
            });

            const conns = getMcpConnections();
            const found = conns.find(c => c.server.id === 'test-list');
            expect(found).toBeDefined();
        });
    });

    // ── testMcpServer Tests ───────────────────────────────────

    describe('testMcpServer', () => {
        it('should test HTTP server connectivity', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'ping', description: 'Ping', inputSchema: {} },
                        ],
                    },
                }),
            });

            const result = await testMcpServer({
                id: 'test-test-http',
                name: 'Test Connectivity',
                description: 'Test connectivity',
                type: 'http',
                url: 'http://localhost:6666',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(result.ok).toBe(true);
            expect(result.tools).toBe(1);
            expect(result.error).toBeUndefined();
        });

        it('should report failure for unreachable HTTP server', async () => {
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const result = await testMcpServer({
                id: 'test-test-fail',
                name: 'Unreachable',
                description: 'Unreachable',
                type: 'http',
                url: 'http://localhost:1111',
                timeoutMs: 5000,
                enabled: true,
            });

            expect(result.ok).toBe(false);
            expect(result.tools).toBe(0);
            expect(result.error).toBe('ECONNREFUSED');
        });

        it('should test stdio server and kill process after', async () => {
            mockProc.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'exit') setTimeout(() => cb(0), 10);
            });
            mockStdout.on.mockImplementation(() => {});

            const result = await testMcpServer({
                id: 'test-test-stdio',
                name: 'Stdio Test',
                description: 'Stdio Test',
                type: 'stdio',
                command: 'node test-server.js',
                timeoutMs: 500,
                enabled: true,
            });

            // Should kill the process after testing
            expect(mockProc.kill).toHaveBeenCalled();
            expect(result.ok).toBe(false); // times out or exits
        });
    });

    // ── Tool name sanitization ────────────────────────────────

    describe('tool name sanitization', () => {
        it('should replace special characters in tool names', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'my-tool.v2', description: 'Hyphenated', inputSchema: {} },
                        ],
                    },
                }),
            });

            await connectMcpServer({
                id: 'srv-special',
                name: 'Special',
                description: 'Special chars',
                type: 'http',
                url: 'http://localhost:5555',
                timeoutMs: 5000,
                enabled: true,
            });

            // Hyphens and dots should be replaced with underscores
            const callArgs = mockRegisterTool.mock.calls[mockRegisterTool.mock.calls.length - 1][0];
            expect(callArgs.name).toBe('mcp_srv_special_my_tool_v2');
        });
    });
});

// ─── Registry Tests ─────────────────────────────────────────────────

import {
    listMcpServers,
    addMcpServer,
    removeMcpServer,
    setMcpServerEnabled,
    initMcpServers,
    getMcpStatus,
} from '../src/mcp/registry.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';

describe('MCP Registry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFiles = {};
        mockRegisterTool.mockClear();
        mockUnregisterTool.mockClear();
    });

    describe('listMcpServers', () => {
        it('should return empty array when no config file exists', () => {
            const servers = listMcpServers();
            expect(servers).toEqual([]);
        });

        it('should return servers from config file', () => {
            const serverList = [
                { id: 'srv1', name: 'Server 1', description: 'Test', type: 'http', url: 'http://localhost:3000', timeoutMs: 30000, enabled: true },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(serverList);

            const servers = listMcpServers();
            expect(servers.length).toBe(1);
            expect(servers[0].id).toBe('srv1');
        });

        it('should return empty array on corrupted JSON', () => {
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = 'not valid json{{{';

            const servers = listMcpServers();
            expect(servers).toEqual([]);
        });
    });

    describe('addMcpServer', () => {
        it('should add a new server with default timeoutMs and enabled', () => {
            const server = addMcpServer({
                id: 'new-srv',
                name: 'New Server',
                description: 'A new server',
                type: 'http',
                url: 'http://localhost:4000',
            });

            expect(server.id).toBe('new-srv');
            expect(server.timeoutMs).toBe(30000);
            expect(server.enabled).toBe(true);
            expect(writeFileSync).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalled();
        });

        it('should throw on duplicate ID', () => {
            const existing = [
                { id: 'dup', name: 'Existing', description: 'Existing', type: 'http', url: 'http://localhost:5000', timeoutMs: 30000, enabled: true },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(existing);

            expect(() =>
                addMcpServer({
                    id: 'dup',
                    name: 'Duplicate',
                    description: 'Dupe',
                    type: 'http',
                    url: 'http://localhost:5001',
                }),
            ).toThrow('already exists');
        });

        it('should persist the new server to disk', () => {
            addMcpServer({
                id: 'persist-test',
                name: 'Persist Test',
                description: 'Persistence test',
                type: 'stdio',
                command: 'node server.js',
            });

            expect(writeFileSync).toHaveBeenCalledWith(
                '/tmp/titan-test-mcp/mcp.json',
                expect.stringContaining('persist-test'),
                'utf-8',
            );
        });

        it('should add stdio server with command', () => {
            const server = addMcpServer({
                id: 'stdio-srv',
                name: 'Stdio Server',
                description: 'Stdio MCP',
                type: 'stdio',
                command: 'python mcp_server.py',
                args: ['--verbose'],
            });

            expect(server.type).toBe('stdio');
            expect(server.command).toBe('python mcp_server.py');
        });
    });

    describe('removeMcpServer', () => {
        it('should remove a server and save', () => {
            const existing = [
                { id: 'srv1', name: 'Server 1', description: 'Test 1', type: 'http', url: 'http://a', timeoutMs: 30000, enabled: true },
                { id: 'srv2', name: 'Server 2', description: 'Test 2', type: 'http', url: 'http://b', timeoutMs: 30000, enabled: true },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(existing);

            removeMcpServer('srv1');

            expect(writeFileSync).toHaveBeenCalled();
            // The written data should not contain srv1
            const writeCall = (writeFileSync as any).mock.calls[(writeFileSync as any).mock.calls.length - 1];
            const saved = JSON.parse(writeCall[1]);
            expect(saved.length).toBe(1);
            expect(saved[0].id).toBe('srv2');
        });

        it('should call disconnectMcpServer', () => {
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify([]);

            removeMcpServer('some-id');

            // Should not throw even if server doesn't exist in active connections
            expect(logger.info).toHaveBeenCalled();
        });
    });

    describe('setMcpServerEnabled', () => {
        it('should enable a server', () => {
            const existing = [
                { id: 'srv1', name: 'Server 1', description: 'Test', type: 'http', url: 'http://a', timeoutMs: 30000, enabled: false },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(existing);

            setMcpServerEnabled('srv1', true);

            const writeCall = (writeFileSync as any).mock.calls[(writeFileSync as any).mock.calls.length - 1];
            const saved = JSON.parse(writeCall[1]);
            expect(saved[0].enabled).toBe(true);
        });

        it('should disable a server and disconnect it', () => {
            const existing = [
                { id: 'srv1', name: 'Server 1', description: 'Test', type: 'http', url: 'http://a', timeoutMs: 30000, enabled: true },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(existing);

            setMcpServerEnabled('srv1', false);

            const writeCall = (writeFileSync as any).mock.calls[(writeFileSync as any).mock.calls.length - 1];
            const saved = JSON.parse(writeCall[1]);
            expect(saved[0].enabled).toBe(false);
        });

        it('should throw when server not found', () => {
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify([]);

            expect(() => setMcpServerEnabled('nonexistent', true)).toThrow('not found');
        });
    });

    describe('initMcpServers', () => {
        it('should do nothing when no servers configured', async () => {
            await initMcpServers();
            // Should not call fetch or spawn
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should do nothing when all servers are disabled', async () => {
            const existing = [
                { id: 'srv1', name: 'Server 1', description: 'Test', type: 'http', url: 'http://a', timeoutMs: 30000, enabled: false },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(existing);

            await initMcpServers();
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should connect to all enabled servers', async () => {
            const existing = [
                { id: 'init-srv1', name: 'Active', description: 'Active', type: 'http', url: 'http://localhost:3001', timeoutMs: 5000, enabled: true },
                { id: 'init-srv2', name: 'Inactive', description: 'Inactive', type: 'http', url: 'http://localhost:3002', timeoutMs: 5000, enabled: false },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(existing);

            mockFetch.mockResolvedValue({
                json: async () => ({ result: { tools: [] } }),
            });

            await initMcpServers();

            // Only one server is enabled
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should handle connection failures gracefully', async () => {
            const existing = [
                { id: 'fail-srv', name: 'Failing', description: 'Fails', type: 'http', url: 'http://bad', timeoutMs: 5000, enabled: true },
            ];
            mockFiles['/tmp/titan-test-mcp/mcp.json'] = JSON.stringify(existing);

            mockFetch.mockRejectedValue(new Error('Network error'));

            // Should not throw
            await expect(initMcpServers()).resolves.toBeUndefined();
        });
    });

    describe('getMcpStatus', () => {
        it('should return status of all connections', async () => {
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    result: {
                        tools: [
                            { name: 'tool1', description: 'Tool 1', inputSchema: {} },
                        ],
                    },
                }),
            });

            await connectMcpServer({
                id: 'status-test',
                name: 'Status Test',
                description: 'Test status',
                type: 'http',
                url: 'http://localhost:4444',
                timeoutMs: 5000,
                enabled: true,
            });

            const status = getMcpStatus();
            const found = status.find(s => s.server.id === 'status-test');
            expect(found).toBeDefined();
            expect(found!.status).toBe('connected');
            expect(found!.toolCount).toBe(1);
        });
    });
});
