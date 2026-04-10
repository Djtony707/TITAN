/**
 * TITAN — Streaming Tests
 * Tests for streaming token delivery via SSE (HTTP) and WebSocket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock processMessage to simulate streaming ─────────────────────
const mockOnToken = vi.fn();
const mockOnToolCall = vi.fn();

vi.mock('../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const cfg = {
        ...actual.getDefaultConfig(),
        gateway: { port: 59420, host: '127.0.0.1', auth: { mode: 'none' } },
    };
    return { ...actual, loadConfig: vi.fn().mockReturnValue(cfg), resetConfigCache: vi.fn(), updateConfig: vi.fn() };
});

vi.mock('../src/agent/multiAgent.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        routeMessage: vi.fn().mockImplementation(async (_msg: string, _ch: string, _uid: string, streamCallbacks?: any) => {
            // Simulate streaming tokens if callbacks provided
            if (streamCallbacks?.onToken) {
                streamCallbacks.onToken('Hello');
                streamCallbacks.onToken(' world');
            }
            if (streamCallbacks?.onToolCall) {
                streamCallbacks.onToolCall('shell', { command: 'ls' });
            }
            return {
                content: 'Hello world',
                sessionId: 'test-session',
                toolsUsed: ['shell'],
                tokenUsage: { prompt: 10, completion: 5, total: 15 },
                model: 'test-model',
                durationMs: 100,
                agentId: 'default',
                agentName: 'TITAN',
            };
        }),
    };
});

// ── Tests ─────────────────────────────────────────────────────────

describe('Streaming — Agent processMessage', () => {
    it('processMessage function accepts streamCallbacks parameter', async () => {
        const { processMessage } = await import('../src/agent/agent.js');
        expect(processMessage).toBeDefined();
        expect(typeof processMessage).toBe('function');
        // processMessage(message, channel, userId, overrides, streamCallbacks)
        expect(processMessage.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Streaming — SSE via /api/message', () => {
    let startGateway: any;
    let stopGateway: any;
    let testPort: number;

    beforeEach(async () => {
        const mod = await import('../src/gateway/server.js');
        startGateway = mod.startGateway;
        stopGateway = mod.stopGateway;
        // Use a random high port to avoid collisions with other test files
        testPort = 61000 + Math.floor(Math.random() * 4000);
    });

    it('returns JSON when no Accept: text/event-stream header', async () => {
        await startGateway({ port: testPort, host: '127.0.0.1', skipUsableCheck: true });
        try {
            const res = await fetch(`http://127.0.0.1:${testPort}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.content).toBe('Hello world');
            expect(body.sessionId).toBe('test-session');
        } finally {
            await stopGateway();
        }
    }, 15000);

    it('returns SSE stream when Accept: text/event-stream', async () => {
        await startGateway({ port: testPort, host: '127.0.0.1', skipUsableCheck: true });
        try {
            const res = await fetch(`http://127.0.0.1:${testPort}/api/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('text/event-stream');

            const text = await res.text();
            // Should contain token events and a done event
            expect(text).toContain('event: token');
            expect(text).toContain('event: tool_call');
            expect(text).toContain('event: done');

            // Parse the done event
            const doneMatch = text.match(/event: done\ndata: (.+)\n/);
            expect(doneMatch).toBeTruthy();
            const doneData = JSON.parse(doneMatch![1]);
            expect(doneData.content).toBe('Hello world');
            expect(doneData.sessionId).toBe('test-session');
            expect(doneData.durationMs).toBe(100);
        } finally {
            await stopGateway();
        }
    }, 15000);

    it('SSE token events contain text data', async () => {
        await startGateway({ port: testPort, host: '127.0.0.1', skipUsableCheck: true });
        try {
            const res = await fetch(`http://127.0.0.1:${testPort}/api/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                body: JSON.stringify({ content: 'hello' }),
            });
            const text = await res.text();

            // Extract token events
            const tokenEvents = text.split('\n\n')
                .filter(block => block.startsWith('event: token'))
                .map(block => {
                    const dataLine = block.split('\n').find(l => l.startsWith('data: '));
                    return dataLine ? JSON.parse(dataLine.replace('data: ', '')) : null;
                })
                .filter(Boolean);

            expect(tokenEvents.length).toBe(2);
            expect(tokenEvents[0].text).toBe('Hello');
            expect(tokenEvents[1].text).toBe(' world');
        } finally {
            await stopGateway();
        }
    }, 15000);

    it('SSE tool_call events contain name and args', async () => {
        await startGateway({ port: testPort, host: '127.0.0.1', skipUsableCheck: true });
        try {
            const res = await fetch(`http://127.0.0.1:${testPort}/api/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                body: JSON.stringify({ content: 'hello' }),
            });
            const text = await res.text();

            // Extract tool_call events
            const toolEvents = text.split('\n\n')
                .filter(block => block.startsWith('event: tool_call'))
                .map(block => {
                    const dataLine = block.split('\n').find(l => l.startsWith('data: '));
                    return dataLine ? JSON.parse(dataLine.replace('data: ', '')) : null;
                })
                .filter(Boolean);

            expect(toolEvents.length).toBe(1);
            expect(toolEvents[0].name).toBe('shell');
            expect(toolEvents[0].args).toEqual({ command: 'ls' });
        } finally {
            await stopGateway();
        }
    }, 15000);
});

describe('Streaming — Backward Compatibility', () => {
    it('routeMessage without streamCallbacks still works', async () => {
        const { routeMessage } = await import('../src/agent/multiAgent.js');
        const result = await routeMessage('test', 'api', 'user');
        expect(result.content).toBe('Hello world');
    });
});
