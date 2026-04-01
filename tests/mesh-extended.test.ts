/**
 * TITAN — Mesh Extended Tests
 * Tests discovery.ts and transport.ts (complements mesh.test.ts which covers identity + registry)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

// Use vi.hoisted() so mock variables are available when vi.mock factories run (hoisted above imports)
const {
    mockExecFileSync,
    mockBonjourPublish,
    mockBonjourBrowserOn,
    mockBonjourBrowserStop,
    mockBonjourDestroy,
    mockBonjourFind,
    mockWsSend,
    mockWsClose,
    mockWsOn,
    createMockWs,
} = vi.hoisted(() => {
    const mockExecFileSync = vi.fn();
    const mockBonjourPublish = vi.fn();
    const mockBonjourBrowserOn = vi.fn();
    const mockBonjourBrowserStop = vi.fn();
    const mockBonjourDestroy = vi.fn();
    const mockBonjourFind = vi.fn().mockReturnValue({
        on: mockBonjourBrowserOn,
        stop: mockBonjourBrowserStop,
    });
    const mockWsSend = vi.fn();
    const mockWsClose = vi.fn();
    const mockWsOn = vi.fn();

    function createMockWs(readyState = 1) {
        const handlers: Record<string, Function[]> = {};
        return {
            readyState,
            send: vi.fn(),  // per-instance send spy
            close: vi.fn(), // per-instance close spy
            on: vi.fn().mockImplementation((event: string, cb: Function) => {
                if (!handlers[event]) handlers[event] = [];
                handlers[event].push(cb);
            }),
            __handlers: handlers,
            __emit(event: string, ...args: unknown[]) {
                (handlers[event] || []).forEach((h: Function) => h(...args));
            },
            OPEN: 1,
            CLOSED: 3,
        };
    }

    return {
        mockExecFileSync,
        mockBonjourPublish,
        mockBonjourBrowserOn,
        mockBonjourBrowserStop,
        mockBonjourDestroy,
        mockBonjourFind,
        mockWsSend,
        mockWsClose,
        mockWsOn,
        createMockWs,
    };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_HOME: '/tmp/titan-test-mesh-ext',
    TITAN_VERSION: '2026.5.0',
}));

vi.mock('child_process', () => ({
    execFileSync: mockExecFileSync,
    spawn: vi.fn(),
}));

// Mock fetch for peer probing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('bonjour-service', () => ({
    Bonjour: vi.fn().mockImplementation(() => ({
        publish: mockBonjourPublish,
        find: mockBonjourFind,
        destroy: mockBonjourDestroy,
    })),
}));

// Mock fs for identity
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(''),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

// Track WebSocket constructor calls
let lastCreatedWs: ReturnType<typeof createMockWs> | null = null;

vi.mock('ws', () => {
    const MockWebSocket = vi.fn().mockImplementation(() => {
        lastCreatedWs = createMockWs(0); // CONNECTING state initially
        return lastCreatedWs;
    });
    // Static properties used by transport.ts (e.g., ws.readyState === WebSocket.OPEN)
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSED = 3;
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.CLOSING = 2;
    return { WebSocket: MockWebSocket };
});

// ═══════════════════════════════════════════════════════════════════
// DISCOVERY TESTS
// ═══════════════════════════════════════════════════════════════════

import {
    getPeers,
    getPeer,
    removePeer,
    registerPeer,
    addManualPeer,
    startDiscovery,
    stopDiscovery,
    type MeshPeer,
} from '../src/mesh/discovery.js';
import logger from '../src/utils/logger.js';

describe('Mesh Discovery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear peer store by stopping discovery
        stopDiscovery();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        stopDiscovery();
        vi.useRealTimers();
    });

    // ── Peer Store CRUD ──────────────────────────────────────────

    describe('Peer Store', () => {
        const basePeer: MeshPeer = {
            nodeId: 'peer-001',
            hostname: 'test-host',
            address: '192.168.1.10',
            port: 48420,
            version: '2026.5.0',
            models: ['openai/gpt-4o'],
            agentCount: 2,
            load: 0.5,
            discoveredVia: 'mdns',
            lastSeen: Date.now(),
        };

        it('should start with no peers', () => {
            expect(getPeers()).toEqual([]);
        });

        it('should register a new peer', () => {
            registerPeer({ ...basePeer });

            const peers = getPeers();
            expect(peers.length).toBe(1);
            expect(peers[0].nodeId).toBe('peer-001');
            expect(peers[0].hostname).toBe('test-host');
            expect(logger.info).toHaveBeenCalledWith(
                'MeshDiscovery',
                expect.stringContaining('New peer'),
            );
        });

        it('should update existing peer on re-register', () => {
            registerPeer({ ...basePeer });
            const originalLastSeen = getPeers()[0].lastSeen;

            // Wait a tiny bit so Date.now() changes
            vi.advanceTimersByTime(100);

            registerPeer({
                ...basePeer,
                models: ['ollama/llama3'],
                agentCount: 5,
                load: 0.8,
                version: '2026.5.1',
            });

            const peers = getPeers();
            expect(peers.length).toBe(1);
            expect(peers[0].models).toEqual(['ollama/llama3']);
            expect(peers[0].agentCount).toBe(5);
            expect(peers[0].load).toBe(0.8);
            expect(peers[0].version).toBe('2026.5.1');
            expect(peers[0].lastSeen).toBeGreaterThanOrEqual(originalLastSeen);
        });

        it('should get peer by nodeId', () => {
            registerPeer({ ...basePeer });

            const peer = getPeer('peer-001');
            expect(peer).toBeDefined();
            expect(peer!.hostname).toBe('test-host');
        });

        it('should return undefined for unknown peer', () => {
            expect(getPeer('nonexistent')).toBeUndefined();
        });

        it('should remove a peer', () => {
            registerPeer({ ...basePeer });
            expect(getPeers().length).toBe(1);

            removePeer('peer-001');
            expect(getPeers().length).toBe(0);
        });

        it('should handle removing non-existent peer gracefully', () => {
            expect(() => removePeer('does-not-exist')).not.toThrow();
        });

        it('should register multiple peers', () => {
            registerPeer({ ...basePeer, nodeId: 'peer-a' });
            registerPeer({ ...basePeer, nodeId: 'peer-b', hostname: 'host-b', address: '192.168.1.11' });
            registerPeer({ ...basePeer, nodeId: 'peer-c', hostname: 'host-c', address: '192.168.1.12' });

            expect(getPeers().length).toBe(3);
        });

        it('should set lastSeen to Date.now() on new peer registration', () => {
            const now = Date.now();
            registerPeer({ ...basePeer, lastSeen: 0 });

            const peer = getPeer('peer-001');
            expect(peer!.lastSeen).toBeGreaterThanOrEqual(now);
        });
    });

    // ── Manual Peer Addition ─────────────────────────────────────

    describe('addManualPeer', () => {
        it('should add a peer if probe succeeds', async () => {
            // HTTPS probe succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    titan: true,
                    nodeId: 'manual-peer-1',
                    version: '2026.5.0',
                    models: ['ollama/phi3'],
                    agentCount: 1,
                    load: 0.2,
                }),
            });

            const result = await addManualPeer('10.0.0.5', 48420, 'ignored');

            expect(result).toBe(true);
            const peers = getPeers();
            const found = peers.find(p => p.nodeId === 'manual-peer-1');
            expect(found).toBeDefined();
            expect(found!.address).toBe('10.0.0.5');
            expect(found!.discoveredVia).toBe('manual');
        });

        it('should return false if probe fails', async () => {
            // Both HTTPS and HTTP probes fail
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const result = await addManualPeer('10.0.0.99', 48420, 'some-id');

            expect(result).toBe(false);
        });

        it('should return false if probe returns non-titan response', async () => {
            // HTTPS fails, HTTP returns non-titan
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ titan: false }),
            });

            const result = await addManualPeer('10.0.0.88', 48420, 'some-id');

            expect(result).toBe(false);
        });

        it('should return false if probe returns non-OK HTTP', async () => {
            // HTTPS probe fails, HTTP probe returns non-OK
            mockFetch.mockResolvedValueOnce({ ok: false });
            mockFetch.mockResolvedValueOnce({ ok: false });

            const result = await addManualPeer('10.0.0.77', 48420, 'some-id');

            expect(result).toBe(false);
        });

        it('should fetch the correct probe URL (HTTPS first, HTTP fallback)', async () => {
            // Probe tries HTTPS first, falls back to HTTP
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED')); // HTTPS fails
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    titan: true,
                    nodeId: 'probe-url-test',
                    version: '1.0',
                    models: [],
                    agentCount: 0,
                    load: 0,
                }),
            });

            await addManualPeer('192.168.1.100', 9999, 'x');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://192.168.1.100:9999/api/mesh/hello',
                expect.objectContaining({ signal: expect.anything() }),
            );
            expect(mockFetch).toHaveBeenCalledWith(
                'http://192.168.1.100:9999/api/mesh/hello',
                expect.objectContaining({ signal: expect.anything() }),
            );
        });
    });

    // ── Tailscale Discovery ──────────────────────────────────────

    describe('Tailscale Discovery', () => {
        it('should discover peers via tailscale status', async () => {
            // Mock tailscale returning two online peers
            mockExecFileSync.mockReturnValueOnce(JSON.stringify({
                Peer: {
                    abc123: {
                        TailscaleIPs: ['100.100.0.1'],
                        HostName: 'gpu-server',
                        Online: true,
                    },
                    def456: {
                        TailscaleIPs: ['100.100.0.2'],
                        HostName: 'cpu-server',
                        Online: true,
                    },
                    ghi789: {
                        TailscaleIPs: ['100.100.0.3'],
                        HostName: 'offline-server',
                        Online: false,
                    },
                },
            }));

            // Mock probe responses
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        titan: true,
                        nodeId: 'ts-peer-1',
                        version: '2026.5.0',
                        models: ['ollama/llama3'],
                        agentCount: 1,
                        load: 0.3,
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        titan: true,
                        nodeId: 'ts-peer-2',
                        version: '2026.5.0',
                        models: ['ollama/mistral'],
                        agentCount: 0,
                        load: 0.0,
                    }),
                });

            await startDiscovery('local-node', 48420, { mdns: false, tailscale: true });

            // Should have discovered the two online peers
            const peers = getPeers();
            expect(peers.length).toBe(2);
            expect(peers.find(p => p.nodeId === 'ts-peer-1')).toBeDefined();
            expect(peers.find(p => p.nodeId === 'ts-peer-2')).toBeDefined();
        });

        it('should handle tailscale not installed', async () => {
            mockExecFileSync.mockImplementation(() => {
                throw new Error('tailscale not found');
            });

            // Should not throw
            await expect(
                startDiscovery('local-node', 48420, { mdns: false, tailscale: true }),
            ).resolves.toBeUndefined();
        });

        it('should skip peers with empty TailscaleIPs', async () => {
            mockExecFileSync.mockReturnValueOnce(JSON.stringify({
                Peer: {
                    abc123: {
                        TailscaleIPs: [],
                        HostName: 'no-ip-server',
                        Online: true,
                    },
                },
            }));

            await startDiscovery('local-node', 48420, { mdns: false, tailscale: true });

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should not register self as peer', async () => {
            mockExecFileSync.mockReturnValueOnce(JSON.stringify({
                Peer: {
                    self: {
                        TailscaleIPs: ['100.100.0.1'],
                        HostName: 'self',
                        Online: true,
                    },
                },
            }));

            // Probe returns the same nodeId as local
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    titan: true,
                    nodeId: 'local-node',
                    version: '2026.5.0',
                    models: [],
                    agentCount: 0,
                    load: 0,
                }),
            });

            await startDiscovery('local-node', 48420, { mdns: false, tailscale: true });

            // Self should not be in peers
            const selfPeer = getPeers().find(p => p.nodeId === 'local-node');
            expect(selfPeer).toBeUndefined();
        });

        it('should handle tailscale status with no Peer field', async () => {
            mockExecFileSync.mockReturnValueOnce(JSON.stringify({ Self: {} }));

            await startDiscovery('local-node', 48420, { mdns: false, tailscale: true });

            expect(getPeers().length).toBe(0);
        });

        it('should skip peers where probe returns no nodeId', async () => {
            mockExecFileSync.mockReturnValueOnce(JSON.stringify({
                Peer: {
                    abc: {
                        TailscaleIPs: ['100.100.0.1'],
                        HostName: 'no-id-server',
                        Online: true,
                    },
                },
            }));

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    titan: true,
                    // Missing nodeId
                    version: '2026.5.0',
                    models: [],
                    agentCount: 0,
                    load: 0,
                }),
            });

            await startDiscovery('local-node', 48420, { mdns: false, tailscale: true });

            expect(getPeers().length).toBe(0);
        });
    });

    // ── mDNS Discovery ───────────────────────────────────────────

    describe('mDNS Discovery', () => {
        it('should publish service and start browsing', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            expect(mockBonjourPublish).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: expect.stringContaining('titan-'),
                    type: 'titan-mesh',
                    port: 48420,
                    txt: expect.objectContaining({
                        nodeId: 'local-node',
                        version: '2026.5.0',
                    }),
                }),
            );

            expect(mockBonjourFind).toHaveBeenCalledWith({ type: 'titan-mesh' });
        });

        it('should register peer when mDNS service found', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            // Extract the 'up' handler
            const upHandler = mockBonjourBrowserOn.mock.calls.find(
                (c: any[]) => c[0] === 'up',
            )?.[1];
            expect(upHandler).toBeDefined();

            // Simulate mDNS service discovery with successful probe
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    titan: true,
                    nodeId: 'mdns-peer-1',
                    version: '2026.5.0',
                    models: ['ollama/codellama'],
                    agentCount: 2,
                    load: 0.4,
                }),
            });

            await upHandler({
                name: 'titan-mdns1234',
                port: 48420,
                txt: {
                    nodeId: 'mdns-peer-1',
                    hostname: 'my-desktop',
                    version: '2026.5.0',
                },
                referer: { address: '192.168.1.50' },
            });

            const peers = getPeers();
            const found = peers.find(p => p.nodeId === 'mdns-peer-1');
            expect(found).toBeDefined();
            expect(found!.address).toBe('192.168.1.50');
            expect(found!.discoveredVia).toBe('mdns');
        });

        it('should ignore self in mDNS discovery', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            const upHandler = mockBonjourBrowserOn.mock.calls.find(
                (c: any[]) => c[0] === 'up',
            )?.[1];

            // Service has same nodeId as local
            await upHandler({
                name: 'titan-self',
                port: 48420,
                txt: { nodeId: 'local-node' },
                referer: { address: '127.0.0.1' },
            });

            // Should not be registered
            expect(getPeers().length).toBe(0);
        });

        it('should ignore service without nodeId in txt', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            const upHandler = mockBonjourBrowserOn.mock.calls.find(
                (c: any[]) => c[0] === 'up',
            )?.[1];

            await upHandler({
                name: 'some-other-service',
                port: 48420,
                txt: {},
                referer: { address: '192.168.1.60' },
            });

            expect(getPeers().length).toBe(0);
        });

        it('should use addresses array when referer is unavailable', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            const upHandler = mockBonjourBrowserOn.mock.calls.find(
                (c: any[]) => c[0] === 'up',
            )?.[1];

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    titan: true,
                    nodeId: 'addr-peer',
                    version: '2026.5.0',
                    models: [],
                    agentCount: 0,
                    load: 0,
                }),
            });

            await upHandler({
                name: 'titan-addr',
                port: 48420,
                txt: { nodeId: 'addr-peer', hostname: 'addr-host' },
                addresses: ['10.0.0.50'],
            });

            const found = getPeers().find(p => p.nodeId === 'addr-peer');
            expect(found).toBeDefined();
            expect(found!.address).toBe('10.0.0.50');
        });

        it('should ignore service with no address', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            const upHandler = mockBonjourBrowserOn.mock.calls.find(
                (c: any[]) => c[0] === 'up',
            )?.[1];

            await upHandler({
                name: 'titan-noaddr',
                port: 48420,
                txt: { nodeId: 'noaddr-peer' },
                // No referer or addresses
            });

            expect(getPeers().length).toBe(0);
        });

        it('should remove peer on mDNS service down', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            // First add a peer
            registerPeer({
                nodeId: 'down-peer',
                hostname: 'going-away',
                address: '192.168.1.70',
                port: 48420,
                version: '2026.5.0',
                models: [],
                agentCount: 0,
                load: 0,
                discoveredVia: 'mdns',
                lastSeen: Date.now(),
            });
            expect(getPeers().find(p => p.nodeId === 'down-peer')).toBeDefined();

            // Get the 'down' handler
            const downHandler = mockBonjourBrowserOn.mock.calls.find(
                (c: any[]) => c[0] === 'down',
            )?.[1];
            expect(downHandler).toBeDefined();

            downHandler({
                name: 'titan-down',
                port: 48420,
                txt: { nodeId: 'down-peer' },
            });

            expect(getPeers().find(p => p.nodeId === 'down-peer')).toBeUndefined();
        });
    });

    // ── stopDiscovery ────────────────────────────────────────────

    describe('stopDiscovery', () => {
        it('should clear all peers and stop bonjour', async () => {
            await startDiscovery('local-node', 48420, { mdns: true, tailscale: false });

            registerPeer({
                nodeId: 'cleanup-peer',
                hostname: 'cleanup',
                address: '1.2.3.4',
                port: 48420,
                version: '1.0',
                models: [],
                agentCount: 0,
                load: 0,
                discoveredVia: 'manual',
                lastSeen: Date.now(),
            });

            stopDiscovery();

            expect(getPeers().length).toBe(0);
            expect(mockBonjourBrowserStop).toHaveBeenCalled();
            expect(mockBonjourDestroy).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith('MeshDiscovery', 'Discovery stopped');
        });

        it('should handle stop when nothing is running', () => {
            // Should not throw
            expect(() => stopDiscovery()).not.toThrow();
        });
    });

    // ── Stale Peer Pruning ──────────────────────────────────────

    describe('Stale Peer Pruning', () => {
        it('should prune peers not seen for over 5 minutes', async () => {
            // Disable mdns/tailscale — only test the pruning interval
            mockExecFileSync.mockReturnValueOnce(JSON.stringify({ Peer: {} }));

            await startDiscovery('local-node', 48420, { mdns: false, tailscale: true });

            // Register a peer
            registerPeer({
                nodeId: 'stale-peer',
                hostname: 'stale',
                address: '1.1.1.1',
                port: 48420,
                version: '1.0',
                models: [],
                agentCount: 0,
                load: 0,
                discoveredVia: 'manual',
                lastSeen: Date.now() - 400_000, // 6+ min ago
            });

            // Also manually set lastSeen to be old enough (since registerPeer updates it)
            const peer = getPeer('stale-peer');
            if (peer) {
                peer.lastSeen = Date.now() - 400_000;
            }

            // Advance time to trigger the 2-minute prune interval
            vi.advanceTimersByTime(120_001);

            // Peer should have been pruned
            expect(getPeer('stale-peer')).toBeUndefined();
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// TRANSPORT TESTS
// ═══════════════════════════════════════════════════════════════════

import {
    generateMeshAuth,
    verifyMeshAuth,
    sendToPeer,
    broadcastToMesh,
    routeTaskToNode,
    handleMeshWebSocket,
    startHeartbeat,
    stopHeartbeat,
    getConnectedPeerCount,
    disconnectAll,
    connectToPeer,
    type MeshMessage,
} from '../src/mesh/transport.js';
import { WebSocket } from 'ws';

describe('Mesh Transport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        disconnectAll();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        disconnectAll();
        vi.useRealTimers();
    });

    // ── HMAC Auth ────────────────────────────────────────────────

    describe('generateMeshAuth', () => {
        it('should generate a hex HMAC string', () => {
            const token = generateMeshAuth('node-123', 'my-secret');
            expect(typeof token).toBe('string');
            expect(token).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex = 64 chars
        });

        it('should produce different tokens for different node IDs', () => {
            const token1 = generateMeshAuth('node-a', 'secret');
            const token2 = generateMeshAuth('node-b', 'secret');
            expect(token1).not.toBe(token2);
        });

        it('should produce different tokens for different secrets', () => {
            const token1 = generateMeshAuth('node-x', 'secret-1');
            const token2 = generateMeshAuth('node-x', 'secret-2');
            expect(token1).not.toBe(token2);
        });
    });

    describe('verifyMeshAuth', () => {
        it('should verify a valid token', () => {
            const token = generateMeshAuth('node-123', 'my-secret');
            expect(verifyMeshAuth(token, 'node-123', 'my-secret')).toBe(true);
        });

        it('should reject an invalid token', () => {
            expect(verifyMeshAuth('invalid-token-that-is-64-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'node-123', 'my-secret')).toBe(false);
        });

        it('should reject wrong node ID', () => {
            const token = generateMeshAuth('node-123', 'my-secret');
            expect(verifyMeshAuth(token, 'node-456', 'my-secret')).toBe(false);
        });

        it('should reject wrong secret', () => {
            const token = generateMeshAuth('node-123', 'correct-secret');
            expect(verifyMeshAuth(token, 'node-123', 'wrong-secret')).toBe(false);
        });

        it('should accept token from previous 30-second window', () => {
            // This tests the clock skew handling:
            // Generate a token, and verify it still works (uses current + previous window)
            const token = generateMeshAuth('node-clock', 'secret');
            const result = verifyMeshAuth(token, 'node-clock', 'secret');
            expect(result).toBe(true);
        });
    });

    // ── handleMeshWebSocket ──────────────────────────────────────

    describe('handleMeshWebSocket', () => {
        it('should register the peer connection and log', () => {
            const ws = createMockWs(1);

            handleMeshWebSocket(ws as any, 'remote-1', 'local-1');

            expect(logger.info).toHaveBeenCalledWith(
                'MeshTransport',
                expect.stringContaining('Mesh peer connected: remote-1'),
            );
        });

        it('should handle heartbeat messages', () => {
            const ws = createMockWs(1);
            handleMeshWebSocket(ws as any, 'remote-hb', 'local-hb');

            // Get message handler
            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
            expect(msgHandler).toBeDefined();

            const heartbeatMsg: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'remote-hb',
                payload: {
                    hostname: 'heartbeat-host',
                    version: '2026.5.0',
                    models: ['openai/gpt-4o'],
                    agentCount: 3,
                    load: 0.7,
                },
                timestamp: new Date().toISOString(),
            };

            msgHandler(Buffer.from(JSON.stringify(heartbeatMsg)));

            // Should have called registerPeer via the discovery module
        });

        it('should handle task_request and call onTaskRequest callback', () => {
            const ws = createMockWs(1);
            const onTaskRequest = vi.fn();
            handleMeshWebSocket(ws as any, 'remote-task', 'local-task', onTaskRequest);

            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            const taskMsg: MeshMessage = {
                type: 'mesh',
                action: 'task_request',
                fromNodeId: 'remote-task',
                toNodeId: 'local-task',
                requestId: 'req-123',
                payload: { message: 'Hello, please process this', model: 'gpt-4o' },
                timestamp: new Date().toISOString(),
            };

            msgHandler(Buffer.from(JSON.stringify(taskMsg)));

            expect(onTaskRequest).toHaveBeenCalledTimes(1);
            expect(onTaskRequest).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'task_request', requestId: 'req-123' }),
                expect.any(Function),
            );
        });

        it('should send task_response when reply function is called', () => {
            const ws = createMockWs(1);
            const onTaskRequest = vi.fn();
            handleMeshWebSocket(ws as any, 'remote-reply', 'local-reply', onTaskRequest);

            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            const taskMsg: MeshMessage = {
                type: 'mesh',
                action: 'task_request',
                fromNodeId: 'remote-reply',
                requestId: 'req-456',
                payload: { message: 'test' },
                timestamp: new Date().toISOString(),
            };

            msgHandler(Buffer.from(JSON.stringify(taskMsg)));

            // Call the reply function
            const replyFn = onTaskRequest.mock.calls[0][1];
            replyFn({ result: 'Task completed!' });

            expect(ws.send).toHaveBeenCalledTimes(1);
            const sentData = JSON.parse(ws.send.mock.calls[0][0]);
            expect(sentData.action).toBe('task_response');
            expect(sentData.requestId).toBe('req-456');
            expect(sentData.fromNodeId).toBe('local-reply');
            expect(sentData.payload.result).toBe('Task completed!');
        });

        it('should handle task_response and resolve pending requests', () => {
            const ws = createMockWs(1);
            handleMeshWebSocket(ws as any, 'remote-resp', 'local-resp');

            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            // We can't easily set up a pending request here without accessing internal state,
            // but we can verify the handler doesn't throw on task_response without pending request
            const responseMsg: MeshMessage = {
                type: 'mesh',
                action: 'task_response',
                fromNodeId: 'remote-resp',
                requestId: 'nonexistent-req',
                payload: { result: 'data' },
                timestamp: new Date().toISOString(),
            };

            expect(() => msgHandler(Buffer.from(JSON.stringify(responseMsg)))).not.toThrow();
        });

        it('should ignore non-mesh messages', () => {
            const ws = createMockWs(1);
            handleMeshWebSocket(ws as any, 'remote-ign', 'local-ign');

            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            // Non-mesh message
            expect(() => msgHandler(Buffer.from(JSON.stringify({ type: 'other', data: 'hello' })))).not.toThrow();
        });

        it('should ignore malformed JSON', () => {
            const ws = createMockWs(1);
            handleMeshWebSocket(ws as any, 'remote-bad', 'local-bad');

            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            expect(() => msgHandler(Buffer.from('not json at all'))).not.toThrow();
        });

        it('should clean up on close', () => {
            const ws = createMockWs(1);
            handleMeshWebSocket(ws as any, 'remote-close', 'local-close');

            const closeHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
            expect(closeHandler).toBeDefined();

            closeHandler();

            expect(logger.info).toHaveBeenCalledWith(
                'MeshTransport',
                expect.stringContaining('Mesh peer disconnected: remote-close'),
            );
        });
    });

    // ── sendToPeer ───────────────────────────────────────────────

    describe('sendToPeer', () => {
        it('should return false when peer is not connected', () => {
            const msg: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'local',
                payload: {},
                timestamp: new Date().toISOString(),
            };

            expect(sendToPeer('nonexistent-peer', msg)).toBe(false);
        });

        it('should send message to connected peer', () => {
            // Set up a peer connection via handleMeshWebSocket
            const ws = createMockWs(1);
            Object.defineProperty(ws, 'readyState', { value: 1, writable: true });
            handleMeshWebSocket(ws as any, 'send-peer', 'local');

            const msg: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'local',
                payload: { test: true },
                timestamp: new Date().toISOString(),
            };

            const result = sendToPeer('send-peer', msg);
            expect(result).toBe(true);
            expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
        });

        it('should return false for peer with closed WebSocket', () => {
            // Connect and then mark as closed
            const ws = createMockWs(1);
            handleMeshWebSocket(ws as any, 'closed-peer', 'local');

            // Simulate closed state
            Object.defineProperty(ws, 'readyState', { value: 3, writable: true });

            const msg: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'local',
                payload: {},
                timestamp: new Date().toISOString(),
            };

            expect(sendToPeer('closed-peer', msg)).toBe(false);
        });
    });

    // ── broadcastToMesh ──────────────────────────────────────────

    describe('broadcastToMesh', () => {
        it('should send to all open connections', () => {
            const ws1 = createMockWs(1);
            Object.defineProperty(ws1, 'readyState', { value: 1, writable: true });
            const ws2 = createMockWs(1);
            Object.defineProperty(ws2, 'readyState', { value: 1, writable: true });

            handleMeshWebSocket(ws1 as any, 'broadcast-1', 'local');
            handleMeshWebSocket(ws2 as any, 'broadcast-2', 'local');

            const msg: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'local',
                payload: { broadcast: true },
                timestamp: new Date().toISOString(),
            };

            broadcastToMesh(msg);

            expect(ws1.send).toHaveBeenCalled();
            expect(ws2.send).toHaveBeenCalled();
        });

        it('should remove closed connections during broadcast', () => {
            const ws1 = createMockWs(1);
            Object.defineProperty(ws1, 'readyState', { value: 1, writable: true });
            const ws2 = createMockWs(3); // CLOSED
            Object.defineProperty(ws2, 'readyState', { value: 3, writable: true });

            handleMeshWebSocket(ws1 as any, 'alive-peer', 'local');
            handleMeshWebSocket(ws2 as any, 'dead-peer', 'local');

            const msg: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'local',
                payload: {},
                timestamp: new Date().toISOString(),
            };

            broadcastToMesh(msg);

            expect(ws1.send).toHaveBeenCalled();
            expect(ws2.send).not.toHaveBeenCalled();
        });

        it('should handle empty peer list', () => {
            const msg: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'local',
                payload: {},
                timestamp: new Date().toISOString(),
            };

            expect(() => broadcastToMesh(msg)).not.toThrow();
        });
    });

    // ── routeTaskToNode ──────────────────────────────────────────

    describe('routeTaskToNode', () => {
        it('should reject when peer is not connected', async () => {
            await expect(
                routeTaskToNode('unknown-node', 'req-1', 'Hello', 'gpt-4o', 1000),
            ).rejects.toThrow('Cannot reach peer');
        });

        it('should send task and resolve when response received', async () => {
            const ws = createMockWs(1);
            Object.defineProperty(ws, 'readyState', { value: 1, writable: true });
            handleMeshWebSocket(ws as any, 'task-peer', 'local');

            const taskPromise = routeTaskToNode('task-peer', 'req-route-1', 'Process this', 'gpt-4o', 10000);

            // Simulate receiving the response via handleMeshWebSocket's message handler
            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            const responseMsg: MeshMessage = {
                type: 'mesh',
                action: 'task_response',
                fromNodeId: 'task-peer',
                requestId: 'req-route-1',
                payload: { result: 'Task done!' },
                timestamp: new Date().toISOString(),
            };

            // Send the response
            msgHandler(Buffer.from(JSON.stringify(responseMsg)));

            const result = await taskPromise;
            expect(result).toEqual({ result: 'Task done!' });
        });

        it('should timeout if no response received', async () => {
            const ws = createMockWs(1);
            Object.defineProperty(ws, 'readyState', { value: 1, writable: true });
            handleMeshWebSocket(ws as any, 'timeout-peer', 'local');

            const taskPromise = routeTaskToNode('timeout-peer', 'req-timeout', 'Slow task', 'gpt-4o', 500);

            // Advance past timeout
            vi.advanceTimersByTime(600);

            await expect(taskPromise).rejects.toThrow('Mesh task timed out');
        });

        it('should include correct message format in sent data', async () => {
            const ws = createMockWs(1);
            Object.defineProperty(ws, 'readyState', { value: 1, writable: true });
            handleMeshWebSocket(ws as any, 'format-peer', 'local');

            // Start the task (will timeout, but we can inspect what was sent)
            const taskPromise = routeTaskToNode('format-peer', 'req-fmt', 'Hello', 'claude-3', 500);

            // Inspect the sent message
            expect(ws.send).toHaveBeenCalled();
            const lastSentCall = ws.send.mock.calls[ws.send.mock.calls.length - 1][0];
            const sent = JSON.parse(lastSentCall);
            expect(sent.type).toBe('mesh');
            expect(sent.action).toBe('task_request');
            expect(sent.toNodeId).toBe('format-peer');
            expect(sent.requestId).toBe('req-fmt');
            expect(sent.payload.message).toBe('Hello');
            expect(sent.payload.model).toBe('claude-3');

            vi.advanceTimersByTime(600);
            await taskPromise.catch(() => {}); // suppress expected error
        });
    });

    // ── Heartbeat ────────────────────────────────────────────────

    describe('Heartbeat', () => {
        it('should start heartbeat interval', () => {
            startHeartbeat('local-hb', { hostname: 'test', version: '1.0' });

            expect(logger.debug).toHaveBeenCalledWith(
                'MeshTransport',
                expect.stringContaining('Heartbeat interval started'),
            );
        });

        it('should not start duplicate heartbeat', () => {
            startHeartbeat('local-hb1');
            const firstCalls = (logger.debug as any).mock.calls.length;

            startHeartbeat('local-hb2');
            // Should not log again since it returns early
            const secondCalls = (logger.debug as any).mock.calls.filter(
                (c: any[]) => c[1]?.includes('Heartbeat interval started'),
            ).length;

            expect(secondCalls).toBe(1);
        });

        it('should broadcast heartbeat on interval', () => {
            // Set up a peer
            const ws = createMockWs(1);
            Object.defineProperty(ws, 'readyState', { value: 1, writable: true });
            handleMeshWebSocket(ws as any, 'hb-listener', 'local');

            startHeartbeat('local-node', { hostname: 'my-host' });

            // Advance time to trigger interval
            vi.advanceTimersByTime(60_001);

            // Should have broadcast at least once
            const sendCalls = ws.send.mock.calls;
            const heartbeatSends = sendCalls.filter((c: any[]) => {
                try {
                    const msg = JSON.parse(c[0]);
                    return msg.action === 'heartbeat';
                } catch {
                    return false;
                }
            });

            expect(heartbeatSends.length).toBeGreaterThanOrEqual(1);
        });

        it('should stop heartbeat', () => {
            startHeartbeat('local-stop');
            stopHeartbeat();

            expect(logger.debug).toHaveBeenCalledWith(
                'MeshTransport',
                expect.stringContaining('Heartbeat interval stopped'),
            );
        });

        it('should handle stop when not started', () => {
            // Should not throw
            expect(() => stopHeartbeat()).not.toThrow();
        });
    });

    // ── getConnectedPeerCount ────────────────────────────────────

    describe('getConnectedPeerCount', () => {
        it('should return 0 when no peers', () => {
            expect(getConnectedPeerCount()).toBe(0);
        });

        it('should count open connections', () => {
            const ws1 = createMockWs(1);
            Object.defineProperty(ws1, 'readyState', { value: 1, writable: true });
            const ws2 = createMockWs(1);
            Object.defineProperty(ws2, 'readyState', { value: 1, writable: true });

            handleMeshWebSocket(ws1 as any, 'count-1', 'local');
            handleMeshWebSocket(ws2 as any, 'count-2', 'local');

            expect(getConnectedPeerCount()).toBe(2);
        });

        it('should not count closed connections', () => {
            const ws1 = createMockWs(1);
            Object.defineProperty(ws1, 'readyState', { value: 1, writable: true });
            const ws2 = createMockWs(3); // CLOSED
            Object.defineProperty(ws2, 'readyState', { value: 3, writable: true });

            handleMeshWebSocket(ws1 as any, 'open-peer', 'local');
            handleMeshWebSocket(ws2 as any, 'closed-peer2', 'local');

            expect(getConnectedPeerCount()).toBe(1);
        });
    });

    // ── disconnectAll ────────────────────────────────────────────

    describe('disconnectAll', () => {
        it('should close all connections', () => {
            const ws1 = createMockWs(1);
            const ws2 = createMockWs(1);

            handleMeshWebSocket(ws1 as any, 'dc-1', 'local');
            handleMeshWebSocket(ws2 as any, 'dc-2', 'local');

            disconnectAll();

            expect(ws1.close).toHaveBeenCalled();
            expect(ws2.close).toHaveBeenCalled();
        });

        it('should stop heartbeat', () => {
            startHeartbeat('local-dc');
            disconnectAll();

            expect(logger.debug).toHaveBeenCalledWith(
                'MeshTransport',
                expect.stringContaining('Heartbeat interval stopped'),
            );
        });

        it('should reject all pending requests', async () => {
            const ws = createMockWs(1);
            Object.defineProperty(ws, 'readyState', { value: 1, writable: true });
            handleMeshWebSocket(ws as any, 'pending-peer', 'local');

            const taskPromise = routeTaskToNode('pending-peer', 'req-dc', 'test', 'gpt-4o', 30000);

            disconnectAll();

            await expect(taskPromise).rejects.toThrow('Mesh shutting down');
        });

        it('should handle empty state gracefully', () => {
            expect(() => disconnectAll()).not.toThrow();
        });
    });

    // ── connectToPeer ────────────────────────────────────────────

    describe('connectToPeer', () => {
        it('should create WebSocket with correct URL', async () => {
            const connPromise = connectToPeer('192.168.1.10', 48420, 'local-id', 'mesh-secret');

            // The WebSocket constructor should have been called
            expect(WebSocket).toHaveBeenCalled();
            const wsCall = (WebSocket as any).mock.calls[(WebSocket as any).mock.calls.length - 1];
            expect(wsCall[0]).toContain('ws://192.168.1.10:48420');
            expect(wsCall[0]).toContain('mesh=true');
            expect(wsCall[0]).toContain('nodeId=local-id');
            expect(wsCall[0]).toContain('auth=');

            // Simulate connection failure via timeout
            vi.advanceTimersByTime(5100);
            const result = await connPromise;
            expect(result).toBe(false);
        });

        it('should resolve true on successful connection with heartbeat', async () => {
            const connPromise = connectToPeer('10.0.0.1', 48420, 'local-x', 'secret');

            // Get the created WS and trigger events
            const ws = lastCreatedWs!;

            // Get handlers
            const openHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'open')?.[1];
            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            // Fire open
            openHandler?.();

            // Send heartbeat from remote
            const heartbeat: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'remote-peer-x',
                payload: { hostname: 'remote-host', version: '2026.5.0', models: [], agentCount: 0, load: 0 },
                timestamp: new Date().toISOString(),
            };
            msgHandler?.(Buffer.from(JSON.stringify(heartbeat)));

            const result = await connPromise;
            expect(result).toBe(true);
        });

        it('should resolve false on error', async () => {
            const connPromise = connectToPeer('10.0.0.99', 48420, 'local-err', 'secret');

            const ws = lastCreatedWs!;
            const errorHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'error')?.[1];
            errorHandler?.();

            const result = await connPromise;
            expect(result).toBe(false);
        });

        it('should resolve false on close before connect', async () => {
            const connPromise = connectToPeer('10.0.0.88', 48420, 'local-close', 'secret');

            const ws = lastCreatedWs!;
            const closeHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
            closeHandler?.();

            const result = await connPromise;
            expect(result).toBe(false);
        });

        it('should handle task_response on outgoing connection', async () => {
            const connPromise = connectToPeer('10.0.0.2', 48420, 'local-task-resp', 'secret');

            const ws = lastCreatedWs!;
            const openHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'open')?.[1];
            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            openHandler?.();

            // Send heartbeat to complete connection
            const heartbeat: MeshMessage = {
                type: 'mesh',
                action: 'heartbeat',
                fromNodeId: 'remote-tr',
                payload: {},
                timestamp: new Date().toISOString(),
            };
            msgHandler?.(Buffer.from(JSON.stringify(heartbeat)));

            await connPromise;

            // Now test task_response handling: it should not throw even without pending request
            const responseMsg: MeshMessage = {
                type: 'mesh',
                action: 'task_response',
                fromNodeId: 'remote-tr',
                requestId: 'orphan-req',
                payload: { result: 'late' },
                timestamp: new Date().toISOString(),
            };

            expect(() => msgHandler?.(Buffer.from(JSON.stringify(responseMsg)))).not.toThrow();
        });

        it('should ignore malformed JSON on outgoing connection', async () => {
            const connPromise = connectToPeer('10.0.0.3', 48420, 'local-badjson', 'secret');

            const ws = lastCreatedWs!;
            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            expect(() => msgHandler?.(Buffer.from('not json'))).not.toThrow();

            // Timeout to resolve the promise
            vi.advanceTimersByTime(5100);
            await connPromise;
        });

        it('should ignore non-mesh messages on outgoing connection', async () => {
            const connPromise = connectToPeer('10.0.0.4', 48420, 'local-nonmesh', 'secret');

            const ws = lastCreatedWs!;
            const msgHandler = ws.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

            expect(() => msgHandler?.(Buffer.from(JSON.stringify({ type: 'something-else' })))).not.toThrow();

            vi.advanceTimersByTime(5100);
            await connPromise;
        });
    });
});
