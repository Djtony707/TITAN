/**
 * TITAN — Mesh Routing Integration Tests
 * Tests router.ts mesh fallback, transport task counting, and server-side enforcement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-mesh-routing',
    TITAN_VERSION: '2026.5.18',
}));

const mockFindModelOnMesh = vi.fn();
vi.mock('../src/mesh/registry.js', () => ({
    findModelOnMesh: (...args: unknown[]) => mockFindModelOnMesh(...args),
}));

const mockRouteTaskToNode = vi.fn();
vi.mock('../src/mesh/transport.js', () => ({
    routeTaskToNode: (...args: unknown[]) => mockRouteTaskToNode(...args),
    getActiveRemoteTaskCount: vi.fn().mockReturnValue(0),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    broadcastToMesh: vi.fn(),
}));

// Mock config with mesh enabled/disabled
let meshEnabled = false;
let meshAllowRemoteModels = true;
let meshMaxRemoteTasks = 3;
vi.mock('../src/config/config.js', () => ({
    loadConfig: () => ({
        agent: { modelAliases: {}, allowedModels: [] },
        mesh: {
            enabled: meshEnabled,
            secret: 'test-secret',
            mdns: false,
            tailscale: false,
            staticPeers: [],
            allowRemoteModels: meshAllowRemoteModels,
            maxRemoteTasks: meshMaxRemoteTasks,
        },
        gateway: { auth: null },
    }),
    updateConfig: vi.fn(),
}));

// Mock providers
const mockChat = vi.fn();
const mockChatStream = vi.fn();
const mockHealthCheck = vi.fn().mockResolvedValue(false);
const mockListModels = vi.fn().mockResolvedValue([]);

vi.mock('../src/providers/anthropic.js', () => ({
    AnthropicProvider: vi.fn().mockImplementation(() => ({
        name: 'anthropic', displayName: 'Anthropic', chat: mockChat, chatStream: mockChatStream,
        healthCheck: mockHealthCheck, listModels: mockListModels,
    })),
}));
vi.mock('../src/providers/openai.js', () => ({
    OpenAIProvider: vi.fn().mockImplementation(() => ({
        name: 'openai', displayName: 'OpenAI', chat: vi.fn().mockRejectedValue(new Error('no')),
        chatStream: vi.fn(), healthCheck: vi.fn().mockResolvedValue(false), listModels: vi.fn().mockResolvedValue([]),
    })),
}));
vi.mock('../src/providers/google.js', () => ({
    GoogleProvider: vi.fn().mockImplementation(() => ({
        name: 'google', displayName: 'Google', chat: vi.fn().mockRejectedValue(new Error('no')),
        chatStream: vi.fn(), healthCheck: vi.fn().mockResolvedValue(false), listModels: vi.fn().mockResolvedValue([]),
    })),
}));
vi.mock('../src/providers/ollama.js', () => ({
    OllamaProvider: vi.fn().mockImplementation(() => ({
        name: 'ollama', displayName: 'Ollama', chat: vi.fn().mockRejectedValue(new Error('no')),
        chatStream: vi.fn(), healthCheck: vi.fn().mockResolvedValue(false), listModels: vi.fn().mockResolvedValue([]),
    })),
}));
vi.mock('../src/providers/openai_compat.js', () => ({
    OpenAICompatProvider: vi.fn(),
    PROVIDER_PRESETS: [],
}));
vi.mock('../src/providers/base.js', () => ({
    LLMProvider: class {
        static parseModelId(id: string) {
            const slash = id.indexOf('/');
            if (slash === -1) return { provider: 'anthropic', model: id };
            return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
        }
    },
}));

// ── Tests ────────────────────────────────────────────────────────

describe('Mesh Routing in Router', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        meshEnabled = false;
        meshAllowRemoteModels = true;
        meshMaxRemoteTasks = 3;
    });

    it('does not attempt mesh routing when mesh is disabled', async () => {
        meshEnabled = false;
        mockChat.mockRejectedValueOnce(new Error('Provider down'));

        const { chat } = await import('../src/providers/router.js');
        await expect(chat({
            model: 'anthropic/claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'Hello' }],
        })).rejects.toThrow();

        expect(mockFindModelOnMesh).not.toHaveBeenCalled();
    });

    it('uses local provider when it succeeds (no mesh needed)', async () => {
        meshEnabled = true;
        const expectedResponse = { content: 'Hello!', model: 'claude-sonnet-4-20250514' };
        mockChat.mockResolvedValueOnce(expectedResponse);

        const { chat } = await import('../src/providers/router.js');
        const result = await chat({
            model: 'anthropic/claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(result).toEqual(expectedResponse);
        expect(mockFindModelOnMesh).not.toHaveBeenCalled();
        expect(mockRouteTaskToNode).not.toHaveBeenCalled();
    });

    it('routes to mesh peer when local fails and peer has the model', async () => {
        meshEnabled = true;
        mockChat.mockRejectedValueOnce(new Error('Provider down'));
        const fakePeer = { nodeId: 'peer-123', hostname: 'titan-pc', load: 0, models: ['anthropic/claude-sonnet-4-20250514'] };
        mockFindModelOnMesh.mockReturnValueOnce(fakePeer);
        mockRouteTaskToNode.mockResolvedValueOnce({ content: 'Hello from mesh!', model: 'claude-sonnet-4-20250514' });

        const { chat } = await import('../src/providers/router.js');
        const result = await chat({
            model: 'anthropic/claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(result.content).toBe('Hello from mesh!');
        expect(mockFindModelOnMesh).toHaveBeenCalledWith('anthropic/claude-sonnet-4-20250514');
        expect(mockRouteTaskToNode).toHaveBeenCalledWith(
            'peer-123',
            expect.any(String),
            'Hello',
            'anthropic/claude-sonnet-4-20250514',
            120_000,
        );
    });

    it('falls through to existing failover when no mesh peer has the model', async () => {
        meshEnabled = true;
        mockChat.mockRejectedValueOnce(new Error('Provider down'));
        mockFindModelOnMesh.mockReturnValueOnce(null);

        const { chat } = await import('../src/providers/router.js');
        // All failover providers also fail in our mocks, so it should throw
        await expect(chat({
            model: 'anthropic/claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'Hello' }],
        })).rejects.toThrow('Provider down');
    });

    it('falls through when mesh peer returns an error', async () => {
        meshEnabled = true;
        mockChat.mockRejectedValueOnce(new Error('Provider down'));
        const fakePeer = { nodeId: 'peer-123', hostname: 'titan-pc', load: 0, models: [] };
        mockFindModelOnMesh.mockReturnValueOnce(fakePeer);
        mockRouteTaskToNode.mockResolvedValueOnce({ error: 'Node at capacity' });

        const { chat } = await import('../src/providers/router.js');
        await expect(chat({
            model: 'anthropic/claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'Hello' }],
        })).rejects.toThrow();
    });
});

describe('Transport — Active task counter', () => {
    it('exports getActiveRemoteTaskCount', async () => {
        const { getActiveRemoteTaskCount } = await import('../src/mesh/transport.js');
        expect(typeof getActiveRemoteTaskCount).toBe('function');
    });
});

describe('Mesh barrel exports', () => {
    it('exports getActiveRemoteTaskCount from mesh index', async () => {
        const mesh = await import('../src/mesh/index.js');
        expect(mesh.getActiveRemoteTaskCount).toBeDefined();
    });

    it('exports approval functions from mesh index', async () => {
        const mesh = await import('../src/mesh/index.js');
        expect(mesh.approvePeer).toBeDefined();
        expect(mesh.rejectPeer).toBeDefined();
        expect(mesh.revokePeer).toBeDefined();
        expect(mesh.getPendingPeers).toBeDefined();
        expect(mesh.setMaxPeers).toBeDefined();
        expect(mesh.setOnPeerDiscovered).toBeDefined();
        expect(mesh.setConnectApprovedPeer).toBeDefined();
    });
});

describe('Peer Approval System', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // Reset the discovery module state
        const disc = await import('../src/mesh/discovery.js');
        disc.stopDiscovery();
    });

    it('routes discovered peers to pending when listener is set', async () => {
        const disc = await import('../src/mesh/discovery.js');
        const discovered: any[] = [];
        disc.setOnPeerDiscovered((peer) => discovered.push(peer));

        disc.registerPeer({
            nodeId: 'pending-001', hostname: 'new-machine', address: '192.168.1.50',
            port: 48420, version: '2026.5.18', models: ['ollama/llama3'],
            agentCount: 0, load: 0, discoveredVia: 'mdns', lastSeen: Date.now(),
        });

        // Should be in pending, not active
        expect(disc.getPeers().find(p => p.nodeId === 'pending-001')).toBeUndefined();
        expect(disc.getPendingPeers().find(p => p.nodeId === 'pending-001')).toBeDefined();
        expect(discovered.length).toBe(1);
        expect(discovered[0].hostname).toBe('new-machine');
    });

    it('approvePeer moves peer from pending to active', async () => {
        const disc = await import('../src/mesh/discovery.js');
        disc.setOnPeerDiscovered(() => {});
        disc.setMaxPeers(5);

        disc.registerPeer({
            nodeId: 'approve-001', hostname: 'titan-pc', address: '192.168.1.100',
            port: 48420, version: '2026.5.18', models: ['ollama/llama3:70b'],
            agentCount: 1, load: 0.2, discoveredVia: 'mdns', lastSeen: Date.now(),
        });

        expect(disc.getPendingPeers().length).toBe(1);
        expect(disc.getPeers().length).toBe(0);

        const approved = disc.approvePeer('approve-001');
        expect(approved).not.toBeNull();
        expect(approved!.hostname).toBe('titan-pc');
        expect(disc.getPendingPeers().length).toBe(0);
        expect(disc.getPeers().length).toBe(1);
    });

    it('rejectPeer removes peer from pending', async () => {
        const disc = await import('../src/mesh/discovery.js');
        disc.setOnPeerDiscovered(() => {});

        disc.registerPeer({
            nodeId: 'reject-001', hostname: 'unknown-machine', address: '10.0.0.5',
            port: 48420, version: '2026.5.18', models: [],
            agentCount: 0, load: 0, discoveredVia: 'mdns', lastSeen: Date.now(),
        });

        expect(disc.getPendingPeers().length).toBe(1);
        const rejected = disc.rejectPeer('reject-001');
        expect(rejected).toBe(true);
        expect(disc.getPendingPeers().length).toBe(0);
        expect(disc.getPeers().length).toBe(0);
    });

    it('revokePeer removes active peer', async () => {
        const disc = await import('../src/mesh/discovery.js');

        // Clear listener so registerPeer goes directly to active
        disc.setOnPeerDiscovered(null as any);
        disc.registerPeer({
            nodeId: 'revoke-001', hostname: 'titan-mini', address: '192.168.1.20',
            port: 48420, version: '2026.5.18', models: ['openai/gpt-4o'],
            agentCount: 0, load: 0, discoveredVia: 'manual', lastSeen: Date.now(),
        });

        expect(disc.getPeers().length).toBe(1);
        const revoked = disc.revokePeer('revoke-001');
        expect(revoked).toBe(true);
        expect(disc.getPeers().length).toBe(0);
    });

    it('enforces maxPeers limit on approval', async () => {
        const disc = await import('../src/mesh/discovery.js');
        disc.setOnPeerDiscovered(() => {});
        disc.setMaxPeers(1);

        // Add one peer directly (no listener at that point)
        disc.setOnPeerDiscovered(undefined as any);
        disc.registerPeer({
            nodeId: 'existing-001', hostname: 'machine-1', address: '192.168.1.1',
            port: 48420, version: '2026.5.18', models: [],
            agentCount: 0, load: 0, discoveredVia: 'manual', lastSeen: Date.now(),
        });
        expect(disc.getPeers().length).toBe(1);

        // Now set listener and try to add another
        disc.setOnPeerDiscovered(() => {});
        disc.registerPeer({
            nodeId: 'overflow-001', hostname: 'machine-2', address: '192.168.1.2',
            port: 48420, version: '2026.5.18', models: [],
            agentCount: 0, load: 0, discoveredVia: 'mdns', lastSeen: Date.now(),
        });

        // Try to approve — should fail because maxPeers=1 and we already have 1
        const result = disc.approvePeer('overflow-001');
        expect(result).toBeNull();
        expect(disc.getPeers().length).toBe(1);
    });

    it('triggers connectApprovedPeer callback on approval', async () => {
        const disc = await import('../src/mesh/discovery.js');
        const connected: any[] = [];
        disc.setOnPeerDiscovered(() => {});
        disc.setConnectApprovedPeer((peer) => connected.push(peer));
        disc.setMaxPeers(5);

        disc.registerPeer({
            nodeId: 'connect-001', hostname: 'gpu-machine', address: '192.168.1.200',
            port: 48420, version: '2026.5.18', models: ['ollama/qwen3:72b'],
            agentCount: 0, load: 0, discoveredVia: 'mdns', lastSeen: Date.now(),
        });

        disc.approvePeer('connect-001');
        expect(connected.length).toBe(1);
        expect(connected[0].hostname).toBe('gpu-machine');
    });
});
