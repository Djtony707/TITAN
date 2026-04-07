/**
 * TITAN — Mesh Module Tests
 * Tests identity.ts and registry.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock filesystem for identity.ts
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    let storedNodeId = '';
    return {
        ...actual,
        existsSync: vi.fn().mockImplementation((p: string) => {
            if (typeof p === 'string' && p.endsWith('node-id')) return storedNodeId.length > 0;
            return false;
        }),
        readFileSync: vi.fn().mockImplementation((p: string) => {
            if (typeof p === 'string' && p.endsWith('node-id')) return storedNodeId;
            return '';
        }),
        writeFileSync: vi.fn().mockImplementation((p: string, data: string) => {
            if (typeof p === 'string' && p.endsWith('node-id')) storedNodeId = data;
        }),
        mkdirSync: vi.fn(),
    };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-mesh',
    TITAN_VERSION: '2026.4.33',
}));

// Mock discovery module for registry.ts
vi.mock('../src/mesh/discovery.js', () => {
    const peerStore: any[] = [];
    return {
        getPeers: vi.fn().mockImplementation(() => peerStore),
        getPeer: vi.fn(),
        registerPeer: vi.fn().mockImplementation((peer: any) => {
            peerStore.push(peer);
        }),
        removePeer: vi.fn(),
        __setPeers: (peers: any[]) => {
            peerStore.length = 0;
            peerStore.push(...peers);
        },
    };
});

// ─── Identity Tests ────────────────────────────────────────────────

describe('Mesh Identity', () => {
    let identity: typeof import('../src/mesh/identity.js');

    beforeEach(async () => {
        vi.resetModules();
        // Re-apply all the mocks we need
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            let storedNodeId = '';
            return {
                ...actual,
                existsSync: vi.fn().mockImplementation((p: string) => {
                    if (typeof p === 'string' && p.endsWith('node-id')) return storedNodeId.length > 0;
                    return false;
                }),
                readFileSync: vi.fn().mockImplementation((p: string) => {
                    if (typeof p === 'string' && p.endsWith('node-id')) return storedNodeId;
                    return '';
                }),
                writeFileSync: vi.fn().mockImplementation((p: string, data: string) => {
                    if (typeof p === 'string' && p.endsWith('node-id')) storedNodeId = data;
                }),
                mkdirSync: vi.fn(),
            };
        });
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-mesh',
            TITAN_VERSION: '2026.4.33',
        }));
        identity = await import('../src/mesh/identity.js');
    });

    describe('getOrCreateNodeId', () => {
        it('should generate a hex node ID', () => {
            const nodeId = identity.getOrCreateNodeId();
            expect(typeof nodeId).toBe('string');
            expect(nodeId.length).toBe(16); // 8 bytes in hex = 16 chars
            expect(nodeId).toMatch(/^[0-9a-f]{16}$/);
        });

        it('should return the same ID on subsequent calls', () => {
            const id1 = identity.getOrCreateNodeId();
            const id2 = identity.getOrCreateNodeId();
            expect(id1).toBe(id2);
        });
    });
});

// ─── Registry Tests ────────────────────────────────────────────────

import { findModelOnMesh, getMeshModels, resolveModelNode } from '../src/mesh/registry.js';
import { getPeers } from '../src/mesh/discovery.js';

describe('Mesh Registry', () => {
    beforeEach(() => {
        // Reset peer store
        (getPeers as any).mockReturnValue([]);
    });

    describe('findModelOnMesh', () => {
        it('should return null when no peers have the model', () => {
            (getPeers as any).mockReturnValue([]);
            expect(findModelOnMesh('openai/gpt-4o')).toBeNull();
        });

        it('should find a peer that has the requested model', () => {
            (getPeers as any).mockReturnValue([
                {
                    nodeId: 'peer1',
                    hostname: 'desktop',
                    address: '192.168.1.10',
                    port: 48420,
                    version: '2026.4.33',
                    models: ['ollama/llama3', 'ollama/mistral'],
                    agentCount: 1,
                    load: 0.5,
                    discoveredVia: 'mdns',
                    lastSeen: Date.now(),
                },
            ]);
            const peer = findModelOnMesh('ollama/llama3');
            expect(peer).not.toBeNull();
            expect(peer!.nodeId).toBe('peer1');
        });

        it('should return the peer with lowest load when multiple have the model', () => {
            (getPeers as any).mockReturnValue([
                {
                    nodeId: 'peer1', hostname: 'heavy', address: '10.0.0.1', port: 48420,
                    version: '1.0', models: ['ollama/llama3'], agentCount: 3, load: 0.9,
                    discoveredVia: 'tailscale', lastSeen: Date.now(),
                },
                {
                    nodeId: 'peer2', hostname: 'light', address: '10.0.0.2', port: 48420,
                    version: '1.0', models: ['ollama/llama3'], agentCount: 1, load: 0.1,
                    discoveredVia: 'tailscale', lastSeen: Date.now(),
                },
            ]);
            const peer = findModelOnMesh('ollama/llama3');
            expect(peer!.nodeId).toBe('peer2');
        });
    });

    describe('getMeshModels', () => {
        it('should return empty array when no peers', () => {
            (getPeers as any).mockReturnValue([]);
            expect(getMeshModels()).toEqual([]);
        });

        it('should return all models from all peers', () => {
            (getPeers as any).mockReturnValue([
                {
                    nodeId: 'p1', hostname: 'host1', address: '10.0.0.1', port: 48420,
                    version: '1.0', models: ['ollama/llama3', 'ollama/mistral'],
                    agentCount: 1, load: 0.5, discoveredVia: 'mdns', lastSeen: Date.now(),
                },
                {
                    nodeId: 'p2', hostname: 'host2', address: '10.0.0.2', port: 48420,
                    version: '1.0', models: ['ollama/phi3'],
                    agentCount: 0, load: 0.0, discoveredVia: 'tailscale', lastSeen: Date.now(),
                },
            ]);
            const models = getMeshModels();
            expect(models.length).toBe(3);
            expect(models.map(m => m.model)).toContain('ollama/llama3');
            expect(models.map(m => m.model)).toContain('ollama/phi3');
        });
    });

    describe('resolveModelNode', () => {
        it('should prefer local when model is available locally', () => {
            const result = resolveModelNode('openai/gpt-4o', ['openai/gpt-4o', 'anthropic/claude-3']);
            expect(result.local).toBe(true);
            expect(result.peer).toBeUndefined();
        });

        it('should route to mesh peer when not available locally', () => {
            (getPeers as any).mockReturnValue([
                {
                    nodeId: 'remote1', hostname: 'gpu-box', address: '10.0.0.5', port: 48420,
                    version: '1.0', models: ['ollama/llama3'], agentCount: 1, load: 0.3,
                    discoveredVia: 'mdns', lastSeen: Date.now(),
                },
            ]);
            const result = resolveModelNode('ollama/llama3', ['openai/gpt-4o']);
            expect(result.local).toBe(false);
            expect(result.peer).toBeDefined();
            expect(result.peer!.nodeId).toBe('remote1');
        });

        it('should fall back to local when model not found anywhere', () => {
            (getPeers as any).mockReturnValue([]);
            const result = resolveModelNode('unknown/model', ['openai/gpt-4o']);
            expect(result.local).toBe(true);
            expect(result.peer).toBeUndefined();
        });
    });
});
