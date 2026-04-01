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
const reconnectState = new Map<string, { attempts: number }>();
const peerUseTls = new Map<string, boolean>();

/** Mark a peer as using TLS (called by discovery after successful HTTPS probe) */
export function setPeerTls(address: string, port: number, tls: boolean): void {
    peerUseTls.set(`${address}:${port}`, tls);
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
    action: 'heartbeat' | 'task_request' | 'task_response' | 'model_query' | 'model_list';
    fromNodeId: string;
    toNodeId?: string;
    requestId?: string;
    payload: Record<string, unknown>;
    timestamp: string;
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
                logger.debug(COMPONENT, `Peer disconnected: ${remoteNodeId}`);
            }
            if (!resolved) { resolved = true; resolve(false); }

            // ── Reconnect with exponential backoff ──
            const state = reconnectState.get(peerKey) || { attempts: 0 };
            state.attempts++;
            const maxAttempts = 5;
            if (state.attempts > maxAttempts) {
                logger.warn(COMPONENT, `Gave up reconnecting to ${address}:${port} after ${maxAttempts} attempts`);
                reconnectState.delete(peerKey);
                return;
            }
            reconnectState.set(peerKey, state);
            const delay = Math.min(2000 * Math.pow(2, state.attempts - 1), 60000);
            logger.debug(COMPONENT, `Reconnecting to ${address}:${port} in ${delay}ms (attempt ${state.attempts}/${maxAttempts})`);
            setTimeout(() => {
                connectToPeer(address, port, localNodeId, meshSecret).catch(() => {});
            }, delay);
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

/** Route a task to a remote node and await the response */
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

        const sent = sendToPeer(nodeId, {
            type: 'mesh',
            action: 'task_request',
            fromNodeId: getOrCreateNodeId(),
            toNodeId: nodeId,
            requestId,
            payload: { message, model },
            timestamp: new Date().toISOString(),
        });

        if (!sent) {
            clearTimeout(timeout);
            pendingRequests.delete(requestId);
            reject(new Error(`Cannot reach peer: ${nodeId}`));
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

/** Disconnect all peers */
export function disconnectAll(): void {
    stopHeartbeat();
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
