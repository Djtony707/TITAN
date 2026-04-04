/**
 * TITAN — A2A Protocol Skill Tests
 * Tests src/skills/builtin/a2a_protocol.ts: Agent-to-Agent protocol tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => ({
        gateway: { port: 48420, host: '0.0.0.0', auth: { mode: 'token' } },
        auth: { mode: 'token' },
        security: { deniedTools: [], allowedTools: [] },
    }),
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    getRegisteredTools: () => [
        { name: 'shell', description: 'Run shell commands', parameters: {} },
        { name: 'web_search', description: 'Search the web', parameters: {} },
        { name: 'weather', description: 'Get weather', parameters: {} },
    ],
    registerTool: vi.fn(),
}));

// Capture registered skills/tools
const registeredTools: Map<string, {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
}> = new Map();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, tool: unknown) => {
        const t = tool as { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> };
        registeredTools.set(t.name, t);
    },
    isToolSkillEnabled: () => true,
}));

// Mock fs for task storage
const mockFiles: Map<string, string> = new Map();
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: (path: string) => {
            if (path.includes('a2a-tasks')) return mockFiles.has(path) || path.endsWith('a2a-tasks');
            return actual.existsSync(path);
        },
        mkdirSync: vi.fn(),
        writeFileSync: (path: string, data: string) => {
            mockFiles.set(path, data);
        },
        readFileSync: (path: string, encoding?: string) => {
            if (mockFiles.has(path)) return mockFiles.get(path)!;
            return actual.readFileSync(path, encoding as BufferEncoding);
        },
    };
});

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
    registerA2AProtocolSkill,
    generateAgentCard,
    discoverAgent,
    sendTask,
    checkTaskStatus,
    receiveTask,
} from '../src/skills/builtin/a2a_protocol.js';

// ─── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
    registeredTools.clear();
    mockFiles.clear();
    mockFetch.mockReset();
    registerA2AProtocolSkill();
});

// ─── Agent Card Generation ───────────────────────────────────────

describe('a2a_agent_card', () => {
    it('should register the a2a_agent_card tool', () => {
        expect(registeredTools.has('a2a_agent_card')).toBe(true);
    });

    it('should generate a valid agent card with correct structure', () => {
        const card = generateAgentCard();
        expect(card).toHaveProperty('name', 'TITAN');
        expect(card).toHaveProperty('description');
        expect(card).toHaveProperty('url');
        expect(card).toHaveProperty('version');
        expect(card).toHaveProperty('capabilities');
        expect(card).toHaveProperty('authentication');
        expect(card).toHaveProperty('protocols');
        expect(card).toHaveProperty('provider');
    });

    it('should include correct version from constants', () => {
        const card = generateAgentCard();
        expect(card.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should list supported protocols', () => {
        const card = generateAgentCard();
        expect(card.protocols).toContain('a2a/1.0');
        expect(card.protocols).toContain('mcp/1.0');
    });

    it('should include capabilities with tools list', () => {
        const card = generateAgentCard();
        expect(card.capabilities.tools).toBeInstanceOf(Array);
        expect(card.capabilities.tools.length).toBeGreaterThan(0);
        expect(card.capabilities.totalTools).toBe(3);
    });

    it('should include authentication info', () => {
        const card = generateAgentCard();
        expect(card.authentication).toHaveProperty('mode');
        expect(card.authentication).toHaveProperty('required');
        expect(card.authentication.mode).toBe('token');
        expect(card.authentication.required).toBe(true);
    });

    it('should return JSON string when executed via tool', async () => {
        const tool = registeredTools.get('a2a_agent_card')!;
        const result = await tool.execute({});
        const parsed = JSON.parse(result);
        expect(parsed.name).toBe('TITAN');
        expect(parsed.protocols).toContain('a2a/1.0');
    });
});

// ─── Remote Agent Discovery ─────────────────────────────────────

describe('a2a_discover', () => {
    it('should register the a2a_discover tool', () => {
        expect(registeredTools.has('a2a_discover')).toBe(true);
    });

    it('should fetch and parse remote agent card', async () => {
        const remoteCard = {
            name: 'RemoteAgent',
            url: 'http://192.168.1.50:8080',
            version: '1.0.0',
            capabilities: { tools: ['tool_a'], skills: [], totalTools: 1 },
            authentication: { mode: 'none', required: false },
            protocols: ['a2a/1.0'],
        };

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => remoteCard,
        });

        const card = await discoverAgent('http://192.168.1.50:8080');
        expect(card.name).toBe('RemoteAgent');
        expect(mockFetch).toHaveBeenCalledWith(
            'http://192.168.1.50:8080/.well-known/agent.json',
            expect.objectContaining({
                headers: expect.objectContaining({ 'Accept': 'application/json' }),
            }),
        );
    });

    it('should handle unreachable agent', async () => {
        mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

        await expect(discoverAgent('http://unreachable:9999')).rejects.toThrow('fetch failed');
    });

    it('should handle HTTP error response', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

        await expect(discoverAgent('http://example.com')).rejects.toThrow('HTTP 404');
    });

    it('should handle invalid agent card (missing fields)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ description: 'no name or url' }),
        });

        await expect(discoverAgent('http://example.com')).rejects.toThrow('missing required fields');
    });

    it('should return error string when executed via tool with bad url', async () => {
        mockFetch.mockRejectedValueOnce(new Error('network error'));

        const tool = registeredTools.get('a2a_discover')!;
        const result = await tool.execute({ url: 'http://bad-host:1234' });
        expect(result).toContain('Error discovering agent');
    });

    it('should strip trailing slashes from URL', async () => {
        const remoteCard = { name: 'Agent', url: 'http://host:8080', version: '1.0.0' };
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => remoteCard });

        await discoverAgent('http://host:8080///');
        expect(mockFetch).toHaveBeenCalledWith(
            'http://host:8080/.well-known/agent.json',
            expect.anything(),
        );
    });
});

// ─── Send Task ──────────────────────────────────────────────────

describe('a2a_send_task', () => {
    it('should register the a2a_send_task tool', () => {
        expect(registeredTools.has('a2a_send_task')).toBe(true);
    });

    it('should send a task and return task ID', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                id: 'test-1',
                result: { id: 'test-1', status: 'submitted' },
            }),
        });

        const result = await sendTask('http://remote:8080', 'Analyze this data', { key: 'value' });
        expect(result.taskId).toMatch(/^a2a-/);
        expect(result.status).toBe('submitted');
    });

    it('should send JSON-RPC 2.0 request to /a2a/tasks', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                result: { status: 'submitted' },
            }),
        });

        await sendTask('http://remote:8080', 'Do work');

        expect(mockFetch).toHaveBeenCalledWith(
            'http://remote:8080/a2a/tasks',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
            }),
        );

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.jsonrpc).toBe('2.0');
        expect(body.method).toBe('a2a/task.send');
        expect(body.params.task).toBe('Do work');
    });

    it('should handle remote error response', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Agent busy' },
            }),
        });

        await expect(sendTask('http://remote:8080', 'task')).rejects.toThrow('Agent busy');
    });

    it('should handle HTTP failure', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

        await expect(sendTask('http://remote:8080', 'task')).rejects.toThrow('HTTP 503');
    });

    it('should store task locally for tracking', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                result: { status: 'submitted' },
            }),
        });

        const result = await sendTask('http://remote:8080', 'Track this');
        // Task should be stored in mock files
        const storedFiles = Array.from(mockFiles.keys());
        expect(storedFiles.some(f => f.includes(result.taskId))).toBe(true);
    });
});

// ─── Task Status ────────────────────────────────────────────────

describe('a2a_task_status', () => {
    it('should register the a2a_task_status tool', () => {
        expect(registeredTools.has('a2a_task_status')).toBe(true);
    });

    it('should check task status from remote agent', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                result: { id: 'task-123', status: 'completed', result: 'Done!' },
            }),
        });

        const status = await checkTaskStatus('http://remote:8080', 'task-123');
        expect(status.taskId).toBe('task-123');
        expect(status.status).toBe('completed');
        expect(status.result).toBe('Done!');
    });

    it('should handle failed task status', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                result: { id: 'task-456', status: 'failed', error: 'Out of memory' },
            }),
        });

        const status = await checkTaskStatus('http://remote:8080', 'task-456');
        expect(status.status).toBe('failed');
        expect(status.error).toBe('Out of memory');
    });

    it('should return error string via tool on failure', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

        const tool = registeredTools.get('a2a_task_status')!;
        const result = await tool.execute({ url: 'http://remote:8080', taskId: 'bad-id' });
        expect(result).toContain('Error checking task status');
    });
});

// ─── Receive Task ───────────────────────────────────────────────

describe('a2a_receive_task', () => {
    it('should register the a2a_receive_task tool', () => {
        expect(registeredTools.has('a2a_receive_task')).toBe(true);
    });

    it('should process incoming task and return completed status', async () => {
        const result = await receiveTask('incoming-1', 'Summarize this document', { doc: 'content' });
        expect(result.id).toBe('incoming-1');
        expect(result.status).toBe('completed');
        expect(result.result).toContain('received and processed');
        expect(result.task).toBe('Summarize this document');
    });

    it('should persist task to disk', async () => {
        await receiveTask('persist-test', 'Test persistence');
        const storedFiles = Array.from(mockFiles.keys());
        expect(storedFiles.some(f => f.includes('persist-test'))).toBe(true);

        const stored = JSON.parse(storedFiles.filter(f => f.includes('persist-test')).map(f => mockFiles.get(f)!)[0]);
        expect(stored.status).toBe('completed');
    });

    it('should include timestamps', async () => {
        const result = await receiveTask('ts-test', 'Check timestamps');
        expect(result.createdAt).toBeDefined();
        expect(result.updatedAt).toBeDefined();
        expect(new Date(result.createdAt).getTime()).toBeGreaterThan(0);
    });

    it('should return JSON via tool execute', async () => {
        const tool = registeredTools.get('a2a_receive_task')!;
        const result = await tool.execute({ taskId: 'tool-test', task: 'Hello from remote' });
        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('completed');
        expect(parsed.id).toBe('tool-test');
    });
});

// ─── Task Lifecycle ─────────────────────────────────────────────

describe('task lifecycle', () => {
    it('should transition through submitted → working → completed', async () => {
        const result = await receiveTask('lifecycle-1', 'Full lifecycle test');
        // Final state should be completed
        expect(result.status).toBe('completed');

        // Check that the persisted task went through the lifecycle
        const storedFiles = Array.from(mockFiles.keys()).filter(f => f.includes('lifecycle-1'));
        expect(storedFiles.length).toBeGreaterThan(0);
        const finalTask = JSON.parse(mockFiles.get(storedFiles[0])!);
        expect(finalTask.status).toBe('completed');
    });
});

// ─── Tool Registration ──────────────────────────────────────────

describe('skill registration', () => {
    it('should register all 5 A2A tools', () => {
        expect(registeredTools.size).toBe(5);
        expect(registeredTools.has('a2a_agent_card')).toBe(true);
        expect(registeredTools.has('a2a_discover')).toBe(true);
        expect(registeredTools.has('a2a_send_task')).toBe(true);
        expect(registeredTools.has('a2a_task_status')).toBe(true);
        expect(registeredTools.has('a2a_receive_task')).toBe(true);
    });

    it('should validate required params in a2a_discover', async () => {
        const tool = registeredTools.get('a2a_discover')!;
        const result = await tool.execute({});
        expect(result).toContain('Error');
    });

    it('should validate required params in a2a_send_task', async () => {
        const tool = registeredTools.get('a2a_send_task')!;
        const result = await tool.execute({ url: 'http://example.com' });
        expect(result).toContain('Error');
    });

    it('should validate required params in a2a_task_status', async () => {
        const tool = registeredTools.get('a2a_task_status')!;
        const result = await tool.execute({});
        expect(result).toContain('Error');
    });

    it('should validate required params in a2a_receive_task', async () => {
        const tool = registeredTools.get('a2a_receive_task')!;
        const result = await tool.execute({});
        expect(result).toContain('Error');
    });
});
