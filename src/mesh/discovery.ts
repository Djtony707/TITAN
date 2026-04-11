/**
 * TITAN — Mesh Peer Discovery
 * Auto-discovers TITAN instances on the local network (mDNS/Bonjour)
 * and across Tailscale VPN networks.
 *
 * Discovery is two-stage:
 *   1. Discovered peers land in a "pending" queue
 *   2. User approves (or autoApprove is on) → peer moves to "approved" and WebSocket connects
 *   3. Approved peer IDs are persisted to ~/.titan/approved-peers.json for restarts
 */
import { execFileSync } from 'child_process';
import { hostname } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME, TITAN_VERSION } from '../utils/constants.js';

const COMPONENT = 'MeshDiscovery';
const PROBE_TIMEOUT_MS = 2000;
const PROBE_JITTER_MS = 500; // ±500ms jitter to avoid thundering-herd probes
const MDNS_RESTART_INTERVAL_MS = 300_000; // Restart mDNS every 5 minutes to handle network changes
const APPROVED_PEERS_PATH = join(TITAN_HOME, 'approved-peers.json');

export interface MeshPeer {
    nodeId: string;
    hostname: string;
    address: string;
    port: number;
    version: string;
    models: string[];
    agentCount: number;
    load: number;
    discoveredVia: 'mdns' | 'tailscale' | 'manual';
    lastSeen: number;
}

// ── Bonjour structural types (dynamic import) ────────────────
interface BonjourInstance {
    publish(opts: Record<string, unknown>): unknown;
    find(opts: Record<string, unknown>): BonjourBrowser;
    destroy(): void;
}
interface BonjourBrowser {
    on(event: string, cb: (service: BonjourService) => void): void;
    stop(): void;
}
interface BonjourService {
    name: string;
    port: number;
    txt?: Record<string, string>;
    referer?: { address: string };
    addresses?: string[];
}

// ── Peer stores ─────────────────────────────────────────────────
const peers = new Map<string, MeshPeer>();          // Approved & connected
const pendingPeers = new Map<string, MeshPeer>();   // Discovered, awaiting approval
let bonjourInstance: BonjourInstance | null = null;
let bonjourBrowser: BonjourBrowser | null = null;
let tailscaleInterval: ReturnType<typeof setInterval> | null = null;
let peerPruneInterval: ReturnType<typeof setInterval> | null = null;
let mdnsRestartInterval: ReturnType<typeof setInterval> | null = null;

// mDNS restart config (for network-change recovery)
let mdnsNodeId: string | null = null;
let mdnsPort: number | null = null;
let mdnsAutoApprove: boolean = false;

/** Callback fired when a new peer is discovered (for dashboard notifications) */
let onPeerDiscovered: ((peer: MeshPeer) => void) | null = null;

/** Callback to initiate WebSocket connection to an approved peer */
let connectApprovedPeer: ((peer: MeshPeer) => void) | null = null;

// ── Persisted approved peer IDs ─────────────────────────────────
let approvedNodeIds: Set<string> = new Set();

function loadApprovedPeers(): void {
    try {
        mkdirSync(TITAN_HOME, { recursive: true });
        if (existsSync(APPROVED_PEERS_PATH)) {
            const data = JSON.parse(readFileSync(APPROVED_PEERS_PATH, 'utf-8'));
            approvedNodeIds = new Set(Array.isArray(data) ? data : []);
        }
    } catch {
        approvedNodeIds = new Set();
    }
}

function saveApprovedPeers(): void {
    try {
        mkdirSync(TITAN_HOME, { recursive: true });
        writeFileSync(APPROVED_PEERS_PATH, JSON.stringify([...approvedNodeIds], null, 2), 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `Failed to save approved peers: ${(err as Error).message}`);
    }
}

/** Check if a peer is already approved (persisted) */
export function isPeerApproved(nodeId: string): boolean {
    return approvedNodeIds.has(nodeId);
}

// ── Public API ──────────────────────────────────────────────────

export function getPeers(): MeshPeer[] {
    return Array.from(peers.values());
}

export function getPeer(nodeId: string): MeshPeer | undefined {
    return peers.get(nodeId);
}

export function removePeer(nodeId: string): void {
    peers.delete(nodeId);
}

export function getPendingPeers(): MeshPeer[] {
    return Array.from(pendingPeers.values());
}

/** Set callback for when new peers are discovered (null to disable approval flow) */
export function setOnPeerDiscovered(cb: ((peer: MeshPeer) => void) | null): void {
    onPeerDiscovered = cb;
}

/** Set callback for initiating WebSocket connections */
export function setConnectApprovedPeer(cb: ((peer: MeshPeer) => void) | null): void {
    connectApprovedPeer = cb;
}

/** Register a peer (from any discovery source). Routes through approval. */
export function registerPeer(peer: MeshPeer, options?: { skipApproval?: boolean }): void {
    // Already an active approved peer — update with fresh data
    const existing = peers.get(peer.nodeId);
    if (existing) {
        // Address changed (mDNS/Tailscale rediscovery) — update transport reconnect state
        if (existing.address !== peer.address || existing.port !== peer.port) {
            const oldAddr = existing.address;
            const oldPort = existing.port;
            existing.address = peer.address;
            existing.port = peer.port;
            existing.lastSeen = Date.now();
            // Notify transport layer so reconnection uses new address
            (async () => {
                try {
                    const { updatePeerAddress } = await import('./transport.js');
                    updatePeerAddress(oldAddr, oldPort, peer.address, peer.port);
                } catch { /* transport not loaded */ }
            })();
        }
        // Use the new model list if provided, otherwise keep existing
        existing.models = peer.models.length > 0 ? peer.models : existing.models;
        existing.agentCount = peer.agentCount;
        existing.load = peer.load;
        existing.version = peer.version;
        return;
    }

    // Skip approval for: already-approved peers, manual adds, explicit skip,
    // or when no approval listener is registered (no gateway/UI watching)
    if (options?.skipApproval || approvedNodeIds.has(peer.nodeId) || !onPeerDiscovered) {
        peer.lastSeen = Date.now();
        peers.set(peer.nodeId, peer);
        logger.info(COMPONENT, `New peer: ${peer.hostname} (${peer.address}:${peer.port}) via ${peer.discoveredVia}`);
        return;
    }

    // New discovery — add to pending (don't connect yet)
    if (!pendingPeers.has(peer.nodeId)) {
        peer.lastSeen = Date.now();
        pendingPeers.set(peer.nodeId, peer);
        logger.info(COMPONENT, `New peer discovered: ${peer.hostname} (${peer.address}:${peer.port}) — awaiting approval`);
        onPeerDiscovered(peer);
    } else {
        // Update pending peer info
        const p = pendingPeers.get(peer.nodeId)!;
        // Same address-change logic for pending peers
        if (p.address !== peer.address || p.port !== peer.port) {
            const oldAddr = p.address;
            const oldPort = p.port;
            p.address = peer.address;
            p.port = peer.port;
            (async () => {
                try {
                    const { updatePeerAddress } = await import('./transport.js');
                    updatePeerAddress(oldAddr, oldPort, peer.address, peer.port);
                } catch { /* transport not loaded */ }
            })();
        }
        p.models = peer.models;
        p.lastSeen = Date.now();
    }
}

/** Set the max peers limit (called from server on startup) */
let maxPeersLimit = 5;
export function setMaxPeers(n: number): void {
    maxPeersLimit = n;
}

/** Approve a pending peer — persist, move to active, initiate connection */
export function approvePeer(nodeId: string): MeshPeer | null {
    const peer = pendingPeers.get(nodeId);
    if (!peer) return null;

    if (peers.size >= maxPeersLimit) {
        logger.warn(COMPONENT, `Cannot approve peer — at max capacity (${maxPeersLimit} peers)`);
        return null;
    }

    pendingPeers.delete(nodeId);
    approvedNodeIds.add(nodeId);
    saveApprovedPeers();

    peer.lastSeen = Date.now();
    peers.set(nodeId, peer);
    logger.info(COMPONENT, `Peer approved: ${peer.hostname} (${peer.nodeId.slice(0, 8)}...)`);

    // Trigger WebSocket connection
    if (connectApprovedPeer) connectApprovedPeer(peer);

    return peer;
}

/** Reject a pending peer — remove from pending */
export function rejectPeer(nodeId: string): boolean {
    return pendingPeers.delete(nodeId);
}

/** Revoke a previously approved peer — disconnect and remove from trusted list */
export function revokePeer(nodeId: string): boolean {
    const removed = peers.delete(nodeId);
    approvedNodeIds.delete(nodeId);
    saveApprovedPeers();
    if (removed) {
        logger.info(COMPONENT, `Peer revoked: ${nodeId.slice(0, 8)}...`);
    }
    return removed;
}

/** Get count of approved (active) peers */
export function getApprovedPeerCount(): number {
    return peers.size;
}

// ── mDNS / Bonjour ─────────────────────────────────────────────

async function startMdns(nodeId: string, port: number, autoApprove: boolean): Promise<void> {
    // Stop existing mDNS if running (to avoid duplicates on restart)
    stopMdnsInternal();

    mdnsNodeId = nodeId;
    mdnsPort = port;
    mdnsAutoApprove = autoApprove;

    try {
        const bonjourModule = await import('bonjour-service');
        const BonjourClass = (bonjourModule as Record<string, unknown>).Bonjour
            ?? (bonjourModule as { default?: unknown }).default;
        if (!BonjourClass || typeof BonjourClass !== 'function') {
            throw new Error('bonjour-service module loaded but Bonjour constructor not found');
        }
        bonjourInstance = new (BonjourClass as new () => BonjourInstance)();

        // Publish this node
        bonjourInstance.publish({
            name: `titan-${nodeId.slice(0, 8)}`,
            type: 'titan-mesh',
            port,
            txt: {
                nodeId,
                version: TITAN_VERSION,
                hostname: hostname(),
            },
        });

        // Browse for peers
        bonjourBrowser = bonjourInstance.find({ type: 'titan-mesh' });
        bonjourBrowser.on('up', async (service: BonjourService) => {
            const peerNodeId = service.txt?.nodeId;
            if (!peerNodeId || peerNodeId === nodeId) return;

            const address = service.referer?.address || service.addresses?.[0];
            if (!address) return;

            // Probe the peer to get its capabilities
            const info = await probePeer(address, service.port);
            if (info) {
                const peer: MeshPeer = {
                    nodeId: peerNodeId,
                    hostname: service.txt?.hostname || service.name,
                    address,
                    port: service.port,
                    version: info.version || service.txt?.version || 'unknown',
                    models: info.models || [],
                    agentCount: info.agentCount || 0,
                    load: info.load || 0,
                    discoveredVia: 'mdns',
                    lastSeen: Date.now(),
                };
                registerPeer(peer);
                // Auto-approve if configured or previously approved
                if (autoApprove || approvedNodeIds.has(peerNodeId)) {
                    if (pendingPeers.has(peerNodeId)) approvePeer(peerNodeId);
                }
            }
        });

        bonjourBrowser.on('down', async (service: BonjourService) => {
            const peerNodeId = service.txt?.nodeId;
            if (peerNodeId) {
                removePeer(peerNodeId);
                pendingPeers.delete(peerNodeId);
                // Also close the WebSocket connection
                try {
                    const { disconnectPeer } = await import('./transport.js');
                    disconnectPeer(peerNodeId);
                } catch { /* transport not loaded */ }
                logger.info(COMPONENT, `mDNS peer went down: ${peerNodeId.slice(0, 8)}...`);
            }
        });

        logger.info(COMPONENT, 'mDNS discovery active');
    } catch (err) {
        logger.warn(COMPONENT, `mDNS unavailable (install bonjour-service for LAN discovery): ${(err as Error).message}`);
    }
}

/** Internal mDNS stop — does not clear config (used for restart) */
function stopMdnsInternal(): void {
    if (bonjourBrowser) { bonjourBrowser.stop(); bonjourBrowser = null; }
    if (bonjourInstance) { bonjourInstance.destroy(); bonjourInstance = null; }
}

// ── Tailscale Discovery ─────────────────────────────────────────

interface TailscalePeer {
    TailscaleIPs: string[];
    HostName: string;
    Online: boolean;
}

function getTailscalePeers(): TailscalePeer[] {
    try {
        const raw = execFileSync('tailscale', ['status', '--json'], {
            timeout: 5000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const status = JSON.parse(raw) as { Peer?: Record<string, TailscalePeer> };
        return Object.values(status.Peer || {}).filter(p => p.Online);
    } catch (err) {
        const msg = (err as Error).message || '';
        if (msg.includes('ENOENT')) {
            logger.debug(COMPONENT, 'Tailscale not installed — skipping VPN peer discovery');
        } else {
            logger.warn(COMPONENT, `Tailscale discovery failed: ${msg.slice(0, 100)}`);
        }
        return [];
    }
}

async function scanTailscalePeers(nodeId: string, port: number, autoApprove: boolean): Promise<void> {
    const tsPeers = getTailscalePeers();
    if (tsPeers.length === 0) return;

    logger.debug(COMPONENT, `Scanning ${tsPeers.length} Tailscale peers`);

    for (const tsPeer of tsPeers) {
        const ip = tsPeer.TailscaleIPs[0];
        if (!ip) continue;

        const info = await probePeer(ip, port);
        if (info && info.nodeId && info.nodeId !== nodeId) {
            const peer: MeshPeer = {
                nodeId: info.nodeId,
                hostname: tsPeer.HostName,
                address: ip,
                port,
                version: info.version || 'unknown',
                models: info.models || [],
                agentCount: info.agentCount || 0,
                load: info.load || 0,
                discoveredVia: 'tailscale',
                lastSeen: Date.now(),
            };
            registerPeer(peer);
            if (autoApprove || approvedNodeIds.has(info.nodeId)) {
                if (pendingPeers.has(info.nodeId)) approvePeer(info.nodeId);
            }
        }
    }
}

// ── Peer Probing ───────────────────────────────────────────────

interface ProbeResult {
    titan: boolean;
    nodeId: string;
    version: string;
    models: string[];
    agentCount: number;
    load: number;
}

async function probePeer(address: string, port: number): Promise<ProbeResult | null> {
    // Add jitter to probe timeout to avoid synchronized retries across peers
    const timeout = PROBE_TIMEOUT_MS + Math.round(PROBE_JITTER_MS * (Math.random() * 2 - 1));
    // Try HTTPS first (TITAN auto-HTTPS via mkcert), fall back to HTTP
    for (const protocol of ['https', 'http'] as const) {
        try {
            const res = await fetch(`${protocol}://${address}:${port}/api/mesh/hello`, {
                signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) {
                logger.debug(COMPONENT, `Probe ${protocol}://${address}:${port} returned ${res.status}`);
                continue;
            }
            const data = await res.json() as ProbeResult;
            if (data.titan) {
                // Record whether this peer uses TLS for WebSocket connections
                try {
                    const { setPeerTls } = await import('./transport.js');
                    setPeerTls(address, port, protocol === 'https');
                } catch { /* transport not loaded yet */ }
                return data;
            }
        } catch (err) {
            const msg = (err as Error).message || '';
            // HTTPS with self-signed cert may fail — try HTTP next
            if (protocol === 'https') {
                logger.debug(COMPONENT, `Probe https://${address}:${port} failed, trying HTTP...`);
                continue;
            }
            if (msg.includes('abort') || msg.includes('timeout')) {
                logger.debug(COMPONENT, `Probe ${address}:${port} timed out`);
            } else if (msg.includes('ECONNREFUSED')) {
                logger.debug(COMPONENT, `Probe ${address}:${port} refused — no TITAN gateway running`);
            } else {
                logger.debug(COMPONENT, `Probe ${address}:${port} failed: ${msg.slice(0, 80)}`);
            }
        }
    }
    return null;
}

// ── Manual Peer ──────────────────────────────────────────────

export async function addManualPeer(address: string, port: number, _nodeId: string): Promise<boolean> {
    const info = await probePeer(address, port);
    if (!info) return false;
    // Manual adds are auto-approved
    registerPeer({
        nodeId: info.nodeId,
        hostname: address,
        address,
        port,
        version: info.version,
        models: info.models,
        agentCount: info.agentCount,
        load: info.load,
        discoveredVia: 'manual',
        lastSeen: Date.now(),
    }, { skipApproval: true });
    approvedNodeIds.add(info.nodeId);
    saveApprovedPeers();
    if (connectApprovedPeer) {
        const peer = peers.get(info.nodeId);
        if (peer) connectApprovedPeer(peer);
    }
    return true;
}

// ── Lifecycle ──────────────────────────────────────────────────

export async function startDiscovery(
    nodeId: string,
    port: number,
    options: { mdns?: boolean; tailscale?: boolean; autoApprove?: boolean; peerStaleTimeoutMs?: number },
): Promise<void> {
    // Load persisted approved peers
    loadApprovedPeers();
    const autoApprove = options.autoApprove ?? false;

    if (options.mdns !== false) {
        await startMdns(nodeId, port, autoApprove);
        // Restart mDNS every 5 minutes to handle network interface changes
        mdnsRestartInterval = setInterval(() => {
            if (mdnsNodeId && mdnsPort !== null) {
                logger.info(COMPONENT, 'Restarting mDNS to handle network changes...');
                startMdns(mdnsNodeId, mdnsPort, mdnsAutoApprove).catch(() => {});
            }
        }, MDNS_RESTART_INTERVAL_MS);
    }

    if (options.tailscale !== false) {
        // Initial scan
        await scanTailscalePeers(nodeId, port, autoApprove);
        // Re-scan every 60 seconds
        tailscaleInterval = setInterval(() => {
            scanTailscalePeers(nodeId, port, autoApprove).catch(() => {});
        }, 60_000);
    }

    // Prune stale peers every 2 minutes
    const staleTimeout = options.peerStaleTimeoutMs ?? 300_000;
    peerPruneInterval = setInterval(() => {
        const cutoff = Date.now() - staleTimeout;
        for (const [id, peer] of peers) {
            if (peer.lastSeen < cutoff) {
                peers.delete(id);
                logger.debug(COMPONENT, `Pruned stale peer: ${peer.hostname}`);
            }
        }
        // Also prune stale pending peers
        for (const [id, peer] of pendingPeers) {
            if (peer.lastSeen < cutoff) {
                pendingPeers.delete(id);
                logger.debug(COMPONENT, `Pruned stale pending peer: ${peer.hostname}`);
            }
        }
    }, 120_000);
}

export function stopDiscovery(): void {
    if (bonjourBrowser) { bonjourBrowser.stop(); bonjourBrowser = null; }
    if (bonjourInstance) { bonjourInstance.destroy(); bonjourInstance = null; }
    if (tailscaleInterval) { clearInterval(tailscaleInterval); tailscaleInterval = null; }
    if (peerPruneInterval) { clearInterval(peerPruneInterval); peerPruneInterval = null; }
    if (mdnsRestartInterval) { clearInterval(mdnsRestartInterval); mdnsRestartInterval = null; }
    mdnsNodeId = null;
    mdnsPort = null;
    peers.clear();
    pendingPeers.clear();
    logger.info(COMPONENT, 'Discovery stopped');
}
