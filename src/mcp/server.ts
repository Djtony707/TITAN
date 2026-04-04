/**
 * TITAN — MCP Server
 * Exposes TITAN's registered tools via the Model Context Protocol (MCP).
 * Other agents (Claude Code, Cursor, Windsurf, etc.) can connect to TITAN
 * as an MCP server and use any of its ~195 tools.
 *
 * Supports two transport modes:
 * - **HTTP/SSE**: Runs on a configurable port (default 48421), compatible with
 *   MCP clients that use HTTP transport (e.g. Claude Code remote MCP).
 * - **Stdio**: When launched as a subprocess, communicates via stdin/stdout
 *   JSON-RPC (standard MCP stdio transport).
 *
 * Protocol: JSON-RPC 2.0 per MCP specification (2025-03-26)
 *
 * Features:
 * - Dynamic tool discovery (exposes all registered TITAN tools)
 * - Session management for multi-turn conversations
 * - Proper error responses per JSON-RPC 2.0 spec
 * - Health check endpoint
 */
import type { Express } from 'express';
import { getRegisteredTools } from '../agent/toolRunner.js';
import { isToolSkillEnabled } from '../skills/registry.js';
import { loadConfig } from '../config/config.js';
import { TITAN_VERSION, TITAN_NAME } from '../utils/constants.js';
import logger from '../utils/logger.js';

// ─── Session Management ──────────────────────────────────────────

interface McpSession {
    sessionId: string;
    createdAt: number;
    lastActivityAt: number;
    messageCount: number;
    clientInfo: Record<string, unknown>;
    metadata: Record<string, unknown>;
}

const sessions = new Map<string, McpSession>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const COMPONENT = 'MCPServer';

// ─── JSON-RPC Types ──────────────────────────────────────────────

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

// ─── MCP Server State ────────────────────────────────────────────

let initialized = false;
let clientCapabilities: Record<string, unknown> = {};

// ─── Session Management Helpers ───────────────────────────────────

function generateSessionId(): string {
    return `mcp-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createSession(clientInfo: Record<string, unknown>): McpSession {
    const sessionId = generateSessionId();
    const now = Date.now();
    const session: McpSession = {
        sessionId,
        createdAt: now,
        lastActivityAt: now,
        messageCount: 0,
        clientInfo,
        metadata: {},
    };
    sessions.set(sessionId, session);

    // Clean up expired sessions
    cleanupExpiredSessions();

    logger.info(COMPONENT, `Created session ${sessionId}`);
    return session;
}

function updateSessionActivity(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) {
        session.lastActivityAt = Date.now();
        session.messageCount++;
    }
}

function cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
        if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
            sessions.delete(id);
            logger.debug(COMPONENT, `Expired session: ${id}`);
        }
    }
}

function getSessionCount(): number {
    return sessions.size;
}

// ─── MCP Protocol Handlers ───────────────────────────────────────

function handleInitialize(params: Record<string, unknown>): unknown {
    const clientInfo = (params.clientInfo as Record<string, unknown>) || {};
    clientCapabilities = (params.capabilities as Record<string, unknown>) || {};
    initialized = true;

    // Create session for this client
    const session = createSession(clientInfo);

    logger.info(COMPONENT, `Client initialized: ${JSON.stringify(clientInfo)} [session: ${session.sessionId}]`);

    return {
        protocolVersion: '2025-03-26',
        capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: false },
            prompts: { listChanged: false },
        },
        serverInfo: {
            name: TITAN_NAME,
            version: TITAN_VERSION,
        },
        sessionId: session.sessionId,
    };
}

function handleToolsList(): unknown {
    const config = loadConfig();
    const denied = new Set(config.security.deniedTools);
    const allowed = new Set(config.security.allowedTools);

    const allTools = getRegisteredTools();
    const tools = allTools
        .filter((tool) => {
            if (denied.has(tool.name)) return false;
            if (allowed.size > 0 && !allowed.has(tool.name)) return false;
            if (!isToolSkillEnabled(tool.name)) return false;
            return true;
        })
        .map((tool) => ({
            name: tool.name,
            description: tool.description || 'No description available',
            inputSchema: tool.parameters || { type: 'object', properties: {} },
            _skillSource: (tool as Record<string, unknown>)._skillSource || 'core',
        }));

    logger.info(COMPONENT, `Listed ${tools.length} of ${allTools.length} total tools (filtered by security policy)`);
    return { tools };
}

async function handleToolsCall(params: Record<string, unknown>): Promise<unknown> {
    return internalToolsCall(params);
}

async function internalToolsCall(params: Record<string, unknown>): Promise<unknown> {
    const toolName = params.name as string;
    const args = (params.arguments as Record<string, unknown>) || {};

    // Validate tool name
    if (!toolName || typeof toolName !== 'string') {
        return {
            content: [{ type: 'text', text: 'Error: tool name is required and must be a string' }],
            isError: true,
        };
    }

    const tools = getRegisteredTools();
    const handler = tools.find((t) => t.name === toolName);

    if (!handler) {
        // Provide helpful error with available tools count
        const totalTools = tools.length;
        return {
            content: [{ type: 'text', text: `Error: unknown tool "${toolName}". ${totalTools} tools are available. Use tools/list to see available tools.` }],
            isError: true,
        };
    }

    // Check if skill is enabled
    if (!isToolSkillEnabled(handler.name)) {
        return {
            content: [{ type: 'text', text: `Error: tool "${toolName}" is disabled (skill not loaded)` }],
            isError: true,
        };
    }

    // Check security policy
    const config = loadConfig();
    if (config.security.deniedTools.includes(handler.name)) {
        return {
            content: [{ type: 'text', text: `Error: tool "${toolName}" is denied by security policy` }],
            isError: true,
        };
    }

    try {
        const timeout = config.security.commandTimeout || 30000;
        const startTime = Date.now();

        const result = await Promise.race([
            handler.execute(args),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${timeout}ms`)), timeout)
            ),
        ]);

        const durationMs = Date.now() - startTime;
        logger.info(COMPONENT, `Tool ${toolName} executed in ${durationMs}ms via MCP`);

        // Truncate large output at 100KB for MCP safety
        const maxOutputSize = 100000;
        const content = typeof result === 'string' && result.length > maxOutputSize
            ? result.slice(0, maxOutputSize) + `\n\n[Output truncated at ${maxOutputSize / 1000}KB]`
            : (typeof result === 'string' ? result : JSON.stringify(result));

        return {
            content: [{ type: 'text', text: content }],
            isError: false,
        };
    } catch (err) {
        const errorDetails = err instanceof Error ? {
            message: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        } : String(err);

        logger.error(COMPONENT, `Tool ${toolName} failed: ${errorDetails.message}`);
        return {
            content: [{ type: 'text', text: `Error: ${errorDetails.message}` }],
            isError: true,
        };
    }
}

// ─── JSON-RPC Error Codes ────────────────────────────────────────

const JsonRpcErrorCode = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    NOT_INITIALIZED: -32000,
    TOOL_NOT_FOUND: -32001,
    TOOL_EXECUTION_ERROR: -32002,
    SESSION_EXPIRED: -32003,
} as const;

// ─── JSON-RPC Dispatcher ─────────────────────────────────────────

export async function handleJsonRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Validate JSON-RPC version first
    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
        return {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: 'Invalid JSON-RPC version, expected "2.0"' },
        };
    }

    const { method, params, id } = request;

    // Notifications (no id) — don't send a response
    if (method?.startsWith('notifications/')) {
        logger.debug(COMPONENT, `Notification: ${method}`);
        return null;
    }

    // Validate method exists
    if (!method || typeof method !== 'string') {
        return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: JsonRpcErrorCode.METHOD_NOT_FOUND, message: 'Method name is required' },
        };
    }

    // Methods that require a response
    try {
        switch (method) {
            case 'initialize':
                return { jsonrpc: '2.0', id: id ?? null, result: handleInitialize(params || {}) };

            case 'ping':
                return { jsonrpc: '2.0', id: id ?? null, result: {} };

            case 'tools/list':
                if (!initialized) {
                    return {
                        jsonrpc: '2.0',
                        id: id ?? null,
                        error: { code: JsonRpcErrorCode.NOT_INITIALIZED, message: 'Server not initialized. Call initialize first.' },
                    };
                }
                return { jsonrpc: '2.0', id: id ?? null, result: handleToolsList() };

            case 'tools/call':
                if (!initialized) {
                    return {
                        jsonrpc: '2.0',
                        id: id ?? null,
                        error: { code: JsonRpcErrorCode.NOT_INITIALIZED, message: 'Server not initialized. Call initialize first.' },
                    };
                }
                if (!params || !(params as Record<string, unknown>).name) {
                    return {
                        jsonrpc: '2.0',
                        id: id ?? null,
                        error: { code: JsonRpcErrorCode.INVALID_PARAMS, message: 'Tool name is required in params' },
                    };
                }
                return { jsonrpc: '2.0', id: id ?? null, result: await internalToolsCall(params || {}) };

            case 'session/info':
                // New session info endpoint for debugging
                return {
                    jsonrpc: '2.0',
                    id: id ?? null,
                    result: {
                        sessionId: null, // Session not tracked via JSON-RPC
                        activeSessions: getSessionCount(),
                        serverVersion: TITAN_VERSION,
                    },
                };

            default:
                return {
                    jsonrpc: '2.0',
                    id: id ?? null,
                    error: { code: JsonRpcErrorCode.METHOD_NOT_FOUND, message: `Method not found: ${method}` },
                };
        }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(COMPONENT, `Handler error for ${method}: ${error.message}`);
        return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
                code: JsonRpcErrorCode.INTERNAL_ERROR,
                message: error.message,
                data: process.env.NODE_ENV === 'development' ? { stack: error.stack } : undefined,
            },
        };
    }
}

// ─── Stdio Transport ─────────────────────────────────────────────

let stdioBuf = '';

function handleStdioData(chunk: string): void {
    stdioBuf += chunk;
    // Process complete lines (JSON-RPC messages are newline-delimited)
    const lines = stdioBuf.split('\n');
    stdioBuf = lines.pop() || ''; // Keep incomplete last line in buffer

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const request = JSON.parse(trimmed) as JsonRpcRequest;
            handleJsonRpcRequest(request).then((response) => {
                if (response) {
                    process.stdout.write(JSON.stringify(response) + '\n');
                }
            }).catch((err) => {
                const errorResponse: JsonRpcResponse = {
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    error: { code: -32603, message: (err as Error).message },
                };
                process.stdout.write(JSON.stringify(errorResponse) + '\n');
            });
        } catch {
            // Invalid JSON — ignore malformed input
            logger.warn(COMPONENT, `Invalid JSON-RPC input: ${trimmed.slice(0, 100)}`);
        }
    }
}

/**
 * Start MCP server in stdio mode.
 * Used when TITAN is launched as a subprocess by an MCP client.
 */
export function startStdioServer(): void {
    logger.info(COMPONENT, 'Starting MCP server (stdio transport)');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', handleStdioData);
    process.stdin.on('end', () => {
        logger.info(COMPONENT, 'Stdio transport closed');
        process.exit(0);
    });
}

// ─── HTTP/SSE Transport ──────────────────────────────────────────

/**
 * Mount MCP HTTP endpoints on an Express app.
 * Implements the MCP Streamable HTTP transport (2025-03-26 spec).
 *
 * Endpoints:
 * - GET  /mcp/health — Health check endpoint
 * - POST /mcp — JSON-RPC request/response
 * - GET  /mcp — SSE stream for server-initiated notifications (future)
 * - DELETE /mcp — Terminate session (future)
 */
export function mountMcpHttpEndpoints(app: Express): void {
    const config = loadConfig();
    if (!config.mcp?.server?.enabled) {
        logger.debug(COMPONENT, 'MCP server mode disabled in config');
        return;
    }

    // GET /mcp/health — Health check endpoint
    app.get('/mcp/health', (_req, res) => {
        const tools = getRegisteredTools();
        const enabledTools = tools.filter((t) => isToolSkillEnabled(t.name));
        const status = {
            status: 'ok',
            initialized,
            version: TITAN_VERSION,
            serverName: TITAN_NAME,
            toolCount: enabledTools.length,
            totalToolCount: tools.length,
            activeSessions: getSessionCount(),
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
        };
        res.json(status);
    });

    // POST /mcp — main JSON-RPC endpoint
    app.post('/mcp', async (req, res) => {
        try {
            const request = req.body as JsonRpcRequest;

            if (!request.jsonrpc || request.jsonrpc !== '2.0') {
                res.status(400).json({
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    error: { code: -32600, message: 'Invalid JSON-RPC version, expected "2.0"' },
                });
                return;
            }

            if (!request.method) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    error: { code: -32600, message: 'Method name is required' },
                });
                return;
            }

            const response = await handleJsonRpcRequest(request);
            if (response) {
                res.json(response);
            } else {
                // Notification — no response body
                res.status(204).end();
            }
        } catch (err) {
            res.status(500).json({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32603, message: (err as Error).message },
            });
        }
    });

    // GET /mcp — SSE stream (placeholder for future server-initiated notifications)
    app.get('/mcp', (_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write('event: endpoint\ndata: /mcp\n\n');
        // Keep connection open for future notifications
        // Client can close when done
    });

    // DELETE /mcp — Session termination (for future session management)
    app.delete('/mcp', (req, res) => {
        // For future: support session termination via ?sessionId= query param
        res.json({
            message: 'Session management - use session/info to get current session details',
            activeSessions: getSessionCount(),
        });
    });

    logger.info(COMPONENT, 'MCP HTTP endpoints mounted at /mcp and /mcp/health');
}

/**
 * Get MCP server status for the dashboard/API.
 */
export function getMcpServerStatus(): {
    enabled: boolean;
    initialized: boolean;
    toolCount: number;
    totalToolCount: number;
    activeSessions: number;
    clientInfo: unknown;
} {
    const config = loadConfig();
    const allTools = getRegisteredTools();
    const enabledTools = allTools.filter((t) => isToolSkillEnabled(t.name));
    return {
        enabled: config.mcp?.server?.enabled ?? false,
        initialized,
        toolCount: enabledTools.length,
        totalToolCount: allTools.length,
        activeSessions: getSessionCount(),
        clientInfo: clientCapabilities,
    };
}
