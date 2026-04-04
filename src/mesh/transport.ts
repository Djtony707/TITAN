/**
 * TITAN — Mesh Transport Layer
 * WebSocket peer-to-peer connections between TITAN nodes.
 * Reuses the existing gateway WS server — no new protocol needed.
 */
import { WebSocket } from 'ws';
import { createHmac, timingSafeEqual } from 'crypto';
import logger from '../utils/logger.js';
import { registerPeer } from './discovery.js';
import { getOrCreateNodeId } from './identity.js';

const COMPONENT = 'MeshTransport';

// ── Active WebSocket connections to peers ──────────────────────
const peerConnections = new Map<string, WebSocket>();
const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout>; peerNodeId?: string }>();
const reconnectState = new Map<string, { attempts: number; nodeId: string; address: string; port: number; meshSecret: string; timer?: ReturnType<typeof setTimeout> }>();
const peerUseTls = new Map<string, boolean>();

/** Reconnection config constants */
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 60000;
const RECONNECT_JITTER_FRAC = 0.2; // ±20% jitter
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 0; // 0 = unlimited reconnection attempts

/** Mark a peer as using TLS (called by discovery after successful HTTPS probe) */
export function setPeerTls(address: string, port: number, tls: boolean): void {
    peerUseTls.set(`${address}:${port}`, tls);
}

/**
 * Update reconnect state when a peer moves to a new address (mDNS/Tailscale rediscovery).
 * Preserves the current attempt counter but points reconnect at the new endpoint.
 */
export function updatePeerAddress(
    oldAddress: string,
    oldPort: number,
    newAddress: string,
    newPort: number,
): void {
    const oldKey = `${oldAddress}:${oldPort}`;
    const newKey = `${newAddress}:${newPort}`;
    const state = reconnectState.get(oldKey);
    if (state && (oldAddress !== newAddress || oldPort !== newPort)) {
        if (state.timer) clearTimeout(state.timer);
        reconnectState.set(newKey, { ...state, address: newAddress, port: newPort });
        reconnectState.delete(oldKey);
        logger.debug(COMPONENT, `Peer address updated: ${oldKey} → ${newKey}`);
    }
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let activeRemoteTasks = 0;

/** Get current number of active remote tasks being processed */
export function getActiveRemoteTaskCount(): number {
    return activeRemoteTasks;
}

/** Mesh message format */
export interface MeshMessage {
    type: 'mesh';
    action: 'heartbeat' | 'task_request' | 'task_response' | 'model_query' | 'model_list' | 'route_broadcast' | 'route_forward';
    fromNodeId: string;
    toNodeId?: string;
    requestId?: string;
    payload: Record<string, unknown>;
    timestamp: string;
    /** TTL for multi-hop routing (decremented at each hop) */
    ttl?: number;
    /** Hop counter for loop detection */
    hopCount?: number;
    /** Visited node IDs for loop detection */
    visitedNodes?: string[];
}

/** Routing table entry: next-hop info to reach a destination node */
interface RouteEntry {
    destinationNodeId: string;
    nextHopNodeId: string;      // immediate next hop
    cost: number;                // distance metric (hops, RTT, etc.)
    discoveredAt: number;
    lastUsedAt: number;
}

/** Broadcasted route advertisement from a peer */
interface RouteAdvertisement {
    destinationNodeId: string;
    cost: number;
    visitedNodes: string[];     // path taken so far
}

// ── Routing table ──────────────────────────────────────────────────
const routingTable = new Map<string, RouteEntry>();
const MAX_ROUTE_TTL = 10;
const ROUTE_PRUNE_INTERVAL_MS = 60_000;
const ROUTE_STALE_MS = 300_000; // 5 minutes
let routeBroadcastInterval: ReturnType<typeof setInterval> | null = null;

/** Get all routing table entries */
export function getRoutingTable(): RouteEntry[] {
    return Array.from(routingTable.values());
}

/** Find the next-hop node to reach a destination */
export function findNextHop(destinationNodeId: string): string | null {
    const entry = routingTable.get(destinationNodeId);
    if (!entry) return null;
    // Check if route is stale
    if (Date.now() - entry.lastUsedAt > ROUTE_STALE_MS) {
        routingTable.delete(destinationNodeId);
        return null;
    }
    return entry.nextHopNodeId;
}

/** Update or insert a routing table entry */
function upsertRoute(entry: RouteEntry): void {
    const existing = routingTable.get(entry.destinationNodeId);
    if (!existing || entry.cost < existing.cost) {
        routingTable.set(entry.destinationNodeId, entry);
    } else if (entry.destinationNodeId === entry.nextHopNodeId) {
        // Always prefer direct routes even if cost is equal
        routingTable.set(entry.destinationNodeId, entry);
    }
}

/** Prune stale routes */
function pruneStaleRoutes(): void {
    const cutoff = Date.now() - ROUTE_STALE_MS;
    for (const [dest, entry] of routingTable) {
        if (entry.lastUsedAt < cutoff) {
            routingTable.delete(dest);
            logger.debug(COMPONENT, `Pruned stale route to ${dest}`);
        }
    }
}

/** Handle incoming route broadcast advertisements */
function handleRouteBroadcast(msg: MeshMessage, fromNodeId: string): void {
    if (msg.action !== 'route_broadcast' || !msg.payload.advertisements) return;

    const ads = msg.payload.advertisements as RouteAdvertisement[];
    const localNodeId = getOrCreateNodeId();
    let updated = false;

    for (const ad of ads) {
        // Skip if this node is the destination
        if (ad.destinationNodeId === localNodeId) continue;

        // Skip if we've already seen a better path
        const newCost = ad.cost + 1;
        const existing = routingTable.get(ad.destinationNodeId);
        if (existing && existing.cost <= newCost) continue;

        // Skip if path would create a loop (our nodeId in visited list)
        if (ad.visitedNodes.includes(localNodeId)) continue;

        upsertRoute({
            destinationNodeId: ad.destinationNodeId,
            nextHopNodeId: fromNodeId,
            cost: newCost,
            discoveredAt: Date.now(),
            lastUsedAt: Date.now(),
        });
        updated = true;
    }

    if (updated) {
        logger.debug(COMPONENT, `Updated routing table from broadcast by ${fromNodeId}, table size: ${routingTable.size}`);
    }
}

/** Broadcast our routing table to all connected peers (distance-vector) */
function broadcastRouteAdvertisement(): void {
    const localNodeId = getOrCreateNodeId();
    const advertisements: RouteAdvertisement[] = [];

    // Advertise ourselves
    advertisements.push({
        destinationNodeId: localNodeId,
        cost: 0,
        visitedNodes: [localNodeId],
    });

    // Advertise routes we know about
    for (const [, entry] of routingTable) {
        advertisements.push({
            destinationNodeId: entry.destinationNodeId,
            cost: entry.cost,
            visitedNodes: [localNodeId],
        });
    }

    const msg: MeshMessage = {
        type: 'mesh',
        action: 'route_broadcast',
        fromNodeId: localNodeId,
        payload: { advertisements },
        timestamp: new Date().toISOString(),
    };
    broadcastToMesh(msg);
}

/** Start route broadcast interval */
export function startRouteBroadcast(intervalMs = 30_000): void {
    if (routeBroadcastInterval) return;
    broadcastRouteAdvertisement(); // Immediate initial broadcast
    routeBroadcastInterval = setInterval(() => {
        // Prune stale routes first
        pruneStaleRoutes();
        broadcastRouteAdvertisement();
    }, intervalMs);
    logger.debug(COMPONENT, `Route broadcast started (${Math.round(intervalMs / 1000)}s)`);
}

export function stopRouteBroadcast(): void {
    if (routeBroadcastInterval) {
        clearInterval(routeBroadcastInterval);
        routeBroadcastInterval = null;
    }
    routingTable.clear();
}

/** Route a message through the mesh using the routing table (multi-hop) */
export function routeMessageMultiHop(
    destinationNodeId: string,
    message: MeshMessage,
): boolean {
    const localNodeId = getOrCreateNodeId();

    // Already at destination
    if (destinationNodeId === localNodeId) return false;

    // Direct connection — send straight there
    if (peerConnections.has(destinationNodeId)) {
        return sendToPeer(destinationNodeId, message);
    }

    // Multi-hop: find next hop
    const nextHop = findNextHop(destinationNodeId);
    if (!nextHop) {
        logger.warn(COMPONENT, `No route to ${destinationNodeId}`);
        return false;
    }

    // Check TTL
    message.ttl = (message.ttl ?? MAX_ROUTE_TTL) - 1;
    if (message.ttl <= 0) {
        logger.warn(COMPONENT, `TTL expired for message to ${destinationNodeId}`);
        return false;
    }

    // Loop detection
    message.visitedNodes = [...(message.visitedNodes || []), localNodeId];
    if (message.visitedNodes.includes(nextHop)) {
        logger.warn(COMPONENT, `Loop detected: ${nextHop} already visited for dest ${destinationNodeId}`);
        return false;
    }

    message.hopCount = (message.hopCount || 0) + 1;

    // Forward to next hop
    const sent = sendToPeer(nextHop, message);
    if (sent) {
        // Update lastUsed
        const entry = routingTable.get(destinationNodeId);
        if (entry) entry.lastUsedAt = Date.now();
        logger.debug(COMPONENT, `Forwarded to ${nextHop} for ${destinationNodeId} (hop ${message.hopCount})`);
    }
    return sent;
}

/** Generate HMAC auth token for mesh handshake */
export function generateMeshAuth(nodeId: string, meshSecret: string): string {
    const ts = Math.floor(Date.now() / 30000).toString(); // 30-second window
    return createHmac('sha256', meshSecret).update(ts + nodeId).digest('hex');
}

/** Verify HMAC auth token */
export function verifyMeshAuth(token: string, nodeId: string, meshSecret: string): boolean {
    const now = Math.floor(Date.now() / 30000);
    // Check current and previous window to handle clock skew
    for (const ts of [now.toString(), (now - 1).toString()]) {
        const expected = createHmac('sha256', meshSecret).update(ts + nodeId).digest('hex');
        if (token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return true;
    }
    return false;
}

/** Connect to a peer via WebSocket */
export async function connectToPeer(
    address: string,
    port: number,
    localNodeId: string,
    meshSecret: string,
): Promise<boolean> {
    const peerKey = `${address}:${port}`;

    return new Promise((resolve) => {
        const auth = generateMeshAuth(localNodeId, meshSecret);
        // Try wss:// first (TITAN auto-HTTPS via mkcert), fall back to ws://
        const wsUrl = `ws://${address}:${port}?mesh=true&nodeId=${localNodeId}&auth=${auth}`;
        const wssUrl = `wss://${address}:${port}?mesh=true&nodeId=${localNodeId}&auth=${auth}`;
        const url = peerUseTls.get(peerKey) ? wssUrl : wsUrl;

        const ws = new WebSocket(url, { handshakeTimeout: 5000 });
        let remoteNodeId: string | null = null;
        let resolved = false;

        ws.on('open', () => {
            logger.info(COMPONENT, `Connected to peer at ${address}:${port}`);
            // Reset reconnect state on successful connection
            const existing = reconnectState.get(peerKey);
            if (existing?.timer) clearTimeout(existing.timer);
            reconnectState.delete(peerKey);
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString()) as MeshMessage;
                if (msg.type !== 'mesh') return;

                if (msg.action === 'heartbeat' && msg.fromNodeId) {
                    remoteNodeId = msg.fromNodeId;
                    peerConnections.set(remoteNodeId, ws);
                    registerPeer({
                        nodeId: remoteNodeId,
                        hostname: (msg.payload?.hostname as string) || address,
                        address,
                        port,
                        version: (msg.payload?.version as string) || 'unknown',
                        models: (msg.payload?.models as string[]) || [],
                        agentCount: (msg.payload?.agentCount as number) || 0,
                        load: (msg.payload?.load as number) || 0,
                        discoveredVia: 'manual',
                        lastSeen: Date.now(),
                    });
                    if (!resolved) { resolved = true; resolve(true); }
                }

                if (msg.action === 'task_response' && msg.requestId) {
                    const pending = pendingRequests.get(msg.requestId);
                    if (pending) {
                        clearTimeout(pending.timeout);
                        pendingRequests.delete(msg.requestId);
                        pending.resolve(msg.payload);
                    }
                }
            } catch {
                // Ignore malformed messages
            }
        });

        ws.on('error', () => {
            if (!resolved) { resolved = true; resolve(false); }
        });

        ws.on('close', () => {
            if (remoteNodeId) {
                peerConnections.delete(remoteNodeId);
                // Reject any pending requests targeted at this peer
                for (const [reqId, req] of pendingRequests) {
                    if (req.peerNodeId === remoteNodeId) {
                        clearTimeout(req.timeout);
                        req.reject(new Error(`Peer disconnected: ${remoteNodeId}`));
                        pendingRequests.delete(reqId);
                    }
                }
                logger.info(COMPONENT, `Peer disconnected: ${remoteNodeId}`);
            }
            if (!resolved) { resolved = true; resolve(false); }

            // ── Reconnect with exponential backoff + jitter ──
            const existing = reconnectState.get(peerKey);
            if (existing && existing.address === address && existing.port === port) {
                // Existing reconnect state with matching address — bump attempt counter
                existing.attempts++;
            } else if (existing) {
                // Address changed (e.g., new mDNS/Tailscale discovery) — reset
                if (existing.timer) clearTimeout(existing.timer);
                reconnectState.set(peerKey, { attempts: 1, nodeId: remoteNodeId || existing.nodeId, address, port, meshSecret });
            } else {
                reconnectState.set(peerKey, { attempts: 1, nodeId: remoteNodeId || 'unknown', address, port, meshSecret });
            }

            const state = reconnectState.get(peerKey)!;
            const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, state.attempts - 1), RECONNECT_MAX_DELAY);
            const jitter = delay * RECONNECT_JITTER_FRAC * (Math.random() * 2 - 1);
            const jitteredDelay = Math.max(100, Math.round(delay + jitter));

            logger.info(COMPONENT, `Reconnecting to ${address}:${port} in ${jitteredDelay}ms (attempt ${state.attempts})`);

            const timer = setTimeout(() => {
                connectToPeer(address, port, localNodeId, meshSecret).catch(() => {});
            }, jitteredDelay);
            state.timer = timer;
        });

        // Timeout
        setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                ws.close();
                if (!resolved) { resolved = true; resolve(false); }
            }
        }, 5000);
    });
}

/** Send a message to a specific peer */
export function sendToPeer(nodeId: string, message: MeshMessage): boolean {
    const ws = peerConnections.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
}

/** Broadcast a message to all connected peers */
export function broadcastToMesh(message: MeshMessage): void {
    const data = JSON.stringify(message);
    for (const [nodeId, ws] of peerConnections) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        } else {
            peerConnections.delete(nodeId);
        }
    }
}

/** Route a task to a remote node and await the response (supports multi-hop) */
export function routeTaskToNode(
    nodeId: string,
    requestId: string,
    message: string,
    model: string,
    timeoutMs = 60_000,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error(`Mesh task timed out (peer: ${nodeId})`));
        }, timeoutMs);

        pendingRequests.set(requestId, { resolve, reject, timeout, peerNodeId: nodeId });

        // First try direct send
        let sent = sendToPeer(nodeId, {
            type: 'mesh',
            action: 'task_request',
            fromNodeId: getOrCreateNodeId(),
            toNodeId: nodeId,
            requestId,
            payload: { message, model },
            timestamp: new Date().toISOString(),
        });

        // If no direct connection, try multi-hop routing
        if (!sent) {
            sent = routeMessageMultiHop(nodeId, {
                type: 'mesh',
                action: 'route_forward',
                fromNodeId: getOrCreateNodeId(),
                toNodeId: nodeId,
                requestId,
                payload: {
                    innerAction: 'task_request',
                    message,
                    model,
                },
                timestamp: new Date().toISOString(),
            });
        }

        if (!sent) {
            clearTimeout(timeout);
            pendingRequests.delete(requestId);
            reject(new Error(`Cannot reach peer: ${nodeId} (no direct or multi-hop route)`));
        }
    });
}

/** Handle an incoming mesh WebSocket connection (called from gateway) */
export function handleMeshWebSocket(
    ws: WebSocket,
    nodeId: string,
    localNodeId: string,
    onTaskRequest?: (msg: MeshMessage, reply: (payload: Record<string, unknown>) => void) => void,
): void {
    peerConnections.set(nodeId, ws);
    logger.info(COMPONENT, `Mesh peer connected: ${nodeId}`);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString()) as MeshMessage;
            if (msg.type !== 'mesh') return;

            if (msg.action === 'heartbeat') {
                registerPeer({
                    nodeId: msg.fromNodeId,
                    hostname: (msg.payload?.hostname as string) || 'unknown',
                    address: '', // Already connected
                    port: 0,
                    version: (msg.payload?.version as string) || 'unknown',
                    models: (msg.payload?.models as string[]) || [],
                    agentCount: (msg.payload?.agentCount as number) || 0,
                    load: (msg.payload?.load as number) || 0,
                    discoveredVia: 'manual',
                    lastSeen: Date.now(),
                });
            }

            if (msg.action === 'task_request' && onTaskRequest && msg.requestId) {
                activeRemoteTasks++;
                let replied = false;
                const sendReply = (payload: Record<string, unknown>) => {
                    if (replied) return;
                    replied = true;
                    activeRemoteTasks = Math.max(0, activeRemoteTasks - 1);
                    const reply: MeshMessage = {
                        type: 'mesh',
                        action: 'task_response',
                        fromNodeId: localNodeId,
                        toNodeId: msg.fromNodeId,
                        requestId: msg.requestId,
                        payload,
                        timestamp: new Date().toISOString(),
                    };
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
                };
                try {
                    onTaskRequest(msg, sendReply);
                } catch (err) {
                    sendReply({ error: `Handler error: ${(err as Error).message}` });
                }
            }

            if (msg.action === 'task_response' && msg.requestId) {
                const pending = pendingRequests.get(msg.requestId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingRequests.delete(msg.requestId);
                    pending.resolve(msg.payload);
                }
            }

            // Handle route broadcast advertisements (multi-hop routing)
            if (msg.action === 'route_broadcast') {
                handleRouteBroadcast(msg, nodeId);
            }

            // Handle forwarded messages (multi-hop routing)
            if (msg.action === 'route_forward' && msg.toNodeId) {
                const localNodeId = getOrCreateNodeId();
                // Forwarded message arrived — if we are the destination, process it, otherwise re-forward
                if (msg.toNodeId === localNodeId) {
                    // This is for us — treat as the inner message
                    const innerAction = (msg.payload.innerAction as MeshMessage['action']) || 'task_request';
                    if (innerAction === 'task_request' && onTaskRequest && msg.requestId) {
                        activeRemoteTasks++;
                        let replied = false;
                        const sendReply = (payload: Record<string, unknown>) => {
                            if (replied) return;
                            replied = true;
                            activeRemoteTasks = Math.max(0, activeRemoteTasks - 1);
                            const reply: MeshMessage = {
                                type: 'mesh',
                                action: 'task_response',
                                fromNodeId: localNodeId,
                                toNodeId: msg.fromNodeId,
                                requestId: msg.requestId,
                                payload,
                                timestamp: new Date().toISOString(),
                            };
                            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
                        };
                        try {
                            onTaskRequest({ ...msg, action: 'task_request' }, sendReply);
                        } catch (err) {
                            sendReply({ error: `Handler error: ${(err as Error).message}` });
                        }
                    }
                } else {
                    // Not for us — forward along the route
                    routeMessageMultiHop(msg.toNodeId, msg);
                }
            }
        } catch {
            // Ignore
        }
    });

    ws.on('close', () => {
        peerConnections.delete(nodeId);
        // Reject any pending requests for this peer
        for (const [reqId, req] of pendingRequests) {
            if (req.peerNodeId === nodeId) {
                clearTimeout(req.timeout);
                req.reject(new Error(`Peer disconnected: ${nodeId}`));
                pendingRequests.delete(reqId);
            }
        }
        logger.info(COMPONENT, `Mesh peer disconnected: ${nodeId}`);
    });
}

/** Start sending periodic heartbeats to all connected peers */
export function startHeartbeat(
    localNodeId: string,
    payload?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>),
    intervalMs = 60_000,
): void {
    if (heartbeatInterval) return; // Already running
    heartbeatInterval = setInterval(async () => {
        const resolved = typeof payload === 'function' ? await payload() : (payload || {});
        const msg: MeshMessage = {
            type: 'mesh',
            action: 'heartbeat',
            fromNodeId: localNodeId,
            payload: resolved,
            timestamp: new Date().toISOString(),
        };
        broadcastToMesh(msg);
    }, intervalMs);
    logger.debug(COMPONENT, `Heartbeat interval started (${Math.round(intervalMs / 1000)}s)`);
}

/** Stop the heartbeat interval */
export function stopHeartbeat(): void {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        logger.debug(COMPONENT, 'Heartbeat interval stopped');
    }
}

/** Get connected peer count */
export function getConnectedPeerCount(): number {
    let count = 0;
    for (const [, ws] of peerConnections) {
        if (ws.readyState === WebSocket.OPEN) count++;
    }
    return count;
}

/** Disconnect a specific peer */
export function disconnectPeer(nodeId: string): void {
    const ws = peerConnections.get(nodeId);
    if (ws) {
        ws.close();
        peerConnections.delete(nodeId);
        // Reject any pending requests
        for (const [reqId, req] of pendingRequests) {
            if (req.peerNodeId === nodeId) {
                clearTimeout(req.timeout);
                req.reject(new Error(`Peer disconnected: ${nodeId}`));
                pendingRequests.delete(reqId);
            }
        }
        logger.info(COMPONENT, `Peer disconnected (requested): ${nodeId}`);
    }
}

/** Disconnect all peers */
export function disconnectAll(): void {
    stopHeartbeat();
    stopRouteBroadcast();
    for (const [nodeId, ws] of peerConnections) {
        ws.close();
        peerConnections.delete(nodeId);
    }
    for (const [id, req] of pendingRequests) {
        clearTimeout(req.timeout);
        req.reject(new Error('Mesh shutting down'));
        pendingRequests.delete(id);
    }
    reconnectState.clear();
}
