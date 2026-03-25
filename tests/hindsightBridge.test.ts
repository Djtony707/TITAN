/**
 * TITAN — Hindsight MCP Bridge Tests
 * Tests cross-session episodic memory integration via Hindsight MCP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/mcp/client.js', () => ({
    getMcpConnections: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    getRegisteredTools: vi.fn().mockReturnValue([]),
}));

import { getMcpConnections } from '../src/mcp/client.js';
import { getRegisteredTools } from '../src/agent/toolRunner.js';
import {
    isHindsightConnected,
    retainToHindsight,
    recallFromHindsight,
    retainStrategy,
    getHindsightHints,
} from '../src/memory/hindsightBridge.js';

const mockGetMcpConnections = vi.mocked(getMcpConnections);
const mockGetRegisteredTools = vi.mocked(getRegisteredTools);

describe('Hindsight MCP Bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMcpConnections.mockReturnValue([]);
        mockGetRegisteredTools.mockReturnValue([]);
    });

    describe('isHindsightConnected', () => {
        it('returns true when Hindsight is connected', () => {
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            expect(isHindsightConnected()).toBe(true);
        });

        it('returns false when Hindsight is disconnected', () => {
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'disconnected', tools: [] },
            ]);
            expect(isHindsightConnected()).toBe(false);
        });

        it('returns false when no MCP connections exist', () => {
            mockGetMcpConnections.mockReturnValue([]);
            expect(isHindsightConnected()).toBe(false);
        });

        it('returns false on error', () => {
            mockGetMcpConnections.mockImplementation(() => { throw new Error('fail'); });
            expect(isHindsightConnected()).toBe(false);
        });
    });

    describe('retainToHindsight', () => {
        it('calls retain tool when Hindsight is connected', async () => {
            const mockRetain = vi.fn().mockResolvedValue('OK');
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            mockGetRegisteredTools.mockReturnValue([
                { name: 'mcp_hindsight_retain', description: '', parameters: {}, execute: mockRetain },
            ]);

            await retainToHindsight('test memory', 'experience');

            expect(mockRetain).toHaveBeenCalledWith({
                content: 'test memory',
                network: 'experience',
            });
        });

        it('silently returns when Hindsight is not connected', async () => {
            mockGetMcpConnections.mockReturnValue([]);
            await retainToHindsight('test memory');
            // No error, no tool calls
        });

        it('silently handles retain tool errors', async () => {
            const mockRetain = vi.fn().mockRejectedValue(new Error('MCP timeout'));
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            mockGetRegisteredTools.mockReturnValue([
                { name: 'mcp_hindsight_retain', description: '', parameters: {}, execute: mockRetain },
            ]);

            await expect(retainToHindsight('test memory')).resolves.toBeUndefined();
        });
    });

    describe('recallFromHindsight', () => {
        it('returns recalled content when connected', async () => {
            const mockRecall = vi.fn().mockResolvedValue('Used shell → edit_file for coding tasks');
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            mockGetRegisteredTools.mockReturnValue([
                { name: 'mcp_hindsight_recall', description: '', parameters: {}, execute: mockRecall },
            ]);

            const result = await recallFromHindsight('coding strategy');
            expect(result).toBe('Used shell → edit_file for coding tasks');
        });

        it('returns null when not connected', async () => {
            mockGetMcpConnections.mockReturnValue([]);
            const result = await recallFromHindsight('test');
            expect(result).toBeNull();
        });

        it('returns null on empty result', async () => {
            const mockRecall = vi.fn().mockResolvedValue('No output');
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            mockGetRegisteredTools.mockReturnValue([
                { name: 'mcp_hindsight_recall', description: '', parameters: {}, execute: mockRecall },
            ]);

            const result = await recallFromHindsight('nothing');
            expect(result).toBeNull();
        });

        it('returns null on error', async () => {
            const mockRecall = vi.fn().mockRejectedValue(new Error('timeout'));
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            mockGetRegisteredTools.mockReturnValue([
                { name: 'mcp_hindsight_recall', description: '', parameters: {}, execute: mockRecall },
            ]);

            const result = await recallFromHindsight('fail');
            expect(result).toBeNull();
        });
    });

    describe('retainStrategy', () => {
        it('formats and retains strategy as experience', async () => {
            const mockRetain = vi.fn().mockResolvedValue('OK');
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            mockGetRegisteredTools.mockReturnValue([
                { name: 'mcp_hindsight_retain', description: '', parameters: {}, execute: mockRetain },
            ]);

            await retainStrategy('coding', ['shell', 'edit_file'], 3, 'Write a function');

            expect(mockRetain).toHaveBeenCalledWith({
                content: expect.stringContaining('Tool sequence: shell → edit_file'),
                network: 'experience',
            });
        });
    });

    describe('getHindsightHints', () => {
        it('returns formatted cross-session hint', async () => {
            const mockRecall = vi.fn().mockResolvedValue('Used web_search → web_fetch');
            mockGetMcpConnections.mockReturnValue([
                { server: { id: 'hindsight' } as any, status: 'connected', tools: [] },
            ]);
            mockGetRegisteredTools.mockReturnValue([
                { name: 'mcp_hindsight_recall', description: '', parameters: {}, execute: mockRecall },
            ]);

            const result = await getHindsightHints('search for AI papers');
            expect(result).toContain('[Cross-session memory]');
            expect(result).toContain('web_search');
        });

        it('returns null when not connected', async () => {
            mockGetMcpConnections.mockReturnValue([]);
            const result = await getHindsightHints('test');
            expect(result).toBeNull();
        });
    });
});
