/**
 * TITAN — Tool Runner
 * Executes tool calls from the LLM with sandboxing, timeouts, and result formatting.
 */
import type { ToolCall, ToolDefinition } from '../providers/base.js';
import { executeToolsParallel } from './parallelTools.js';
import { runPreTool, runPostTool } from '../plugins/contextEngine.js';
import type { ContextEnginePlugin } from '../plugins/contextEngine.js';

/** Tool hook plugins — set during agent initialization */
let toolHookPlugins: ContextEnginePlugin[] = [];
export function setToolHookPlugins(plugins: ContextEnginePlugin[]): void {
    toolHookPlugins = plugins;
}
import logger from '../utils/logger.js';
import { loadConfig } from '../config/config.js';
import { checkAutonomy } from './autonomy.js';
import { isToolSkillEnabled } from '../skills/registry.js';

const COMPONENT = 'ToolRunner';

/** Error classification for retry decisions */
export type ErrorClass = 'transient' | 'permanent' | 'timeout' | 'rate_limit';

/** Classify an error to determine if retry is appropriate */
export function classifyError(error: Error, _toolName: string): ErrorClass {
    const msg = error.message.toLowerCase();

    // Timeout errors
    if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('etimedout')) {
        return 'timeout';
    }

    // Rate limit errors
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests') || msg.includes('quota exceeded')) {
        return 'rate_limit';
    }

    // Transient network/connection errors
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('epipe') ||
        msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('network error') ||
        msg.includes('socket hang up') || msg.includes('connection closed') ||
        msg.includes('503') || msg.includes('502') || msg.includes('500')) {
        return 'transient';
    }

    // Everything else is permanent (bad args, not found, permission denied, etc.)
    return 'permanent';
}

/** Tool execution result */
export interface ToolResult {
    toolCallId: string;
    name: string;
    content: string;
    success: boolean;
    durationMs: number;
    /** Number of retry attempts made (0 = first try succeeded/failed) */
    retryCount?: number;
    /** Error classification if the tool failed */
    errorClass?: ErrorClass;
}

/** A registered tool handler */
export interface ToolHandler {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
}

/** Global tool registry */
const toolRegistry: Map<string, ToolHandler> = new Map();

/** Register a tool */
export function registerTool(handler: ToolHandler): void {
    toolRegistry.set(handler.name, handler);
    logger.debug(COMPONENT, `Registered tool: ${handler.name}`);
}

/** Unregister a tool */
export function unregisterTool(name: string): void {
    toolRegistry.delete(name);
}

/** Get all registered tools */
export function getRegisteredTools(): ToolHandler[] {
    return Array.from(toolRegistry.values());
}

/** Convert registered tools to LLM tool definitions */
export function getToolDefinitions(): ToolDefinition[] {
    const config = loadConfig();
    const allowed = new Set(config.security.allowedTools);
    const denied = new Set(config.security.deniedTools);

    return Array.from(toolRegistry.values())
        .filter((tool) => {
            if (denied.has(tool.name)) return false;
            if (allowed.size > 0 && !allowed.has(tool.name)) return false;
            if (!isToolSkillEnabled(tool.name)) return false;
            return true;
        })
        .map((tool) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
}

/** Execute a single tool call */
export async function executeTool(toolCall: ToolCall, channel?: string): Promise<ToolResult> {
    const config = loadConfig();
    const startTime = Date.now();
    const handler = toolRegistry.get(toolCall.function.name);

    if (!handler) {
        return {
            toolCallId: toolCall.id,
            name: toolCall.function.name,
            content: `Error: Unknown tool "${toolCall.function.name}"`,
            success: false,
            durationMs: Date.now() - startTime,
        };
    }

    // Check permissions
    if (config.security.deniedTools.includes(handler.name)) {
        return {
            toolCallId: toolCall.id,
            name: handler.name,
            content: `Error: Tool "${handler.name}" is denied by security policy`,
            success: false,
            durationMs: Date.now() - startTime,
        };
    }

    // Check if parent skill is enabled
    if (!isToolSkillEnabled(handler.name)) {
        return {
            toolCallId: toolCall.id,
            name: handler.name,
            content: `Error: Tool "${handler.name}" is disabled — its parent skill is turned off. Enable it in Mission Control.`,
            success: false,
            durationMs: Date.now() - startTime,
        };
    }

    // Parse arguments
    let args: Record<string, unknown> = {};
    try {
        args = JSON.parse(toolCall.function.arguments);
    } catch {
        args = {};
    }

    logger.info(COMPONENT, `Executing tool: ${handler.name}`);

    // Pre-tool hooks — plugins can block or modify args
    if (toolHookPlugins.length > 0) {
        const hookResult = await runPreTool(toolHookPlugins, handler.name, args);
        if (!hookResult.allow) {
            return {
                toolCallId: toolCall.id,
                name: handler.name,
                content: 'Blocked by hook: ' + (hookResult.reason || 'Plugin denied execution'),
                success: false,
                durationMs: Date.now() - startTime,
            };
        }
        if (hookResult.modifiedArgs) args = hookResult.modifiedArgs;
    }

    // Autonomy gate: check if the tool is permitted under current mode
    const autonomyResult = await checkAutonomy(handler.name, args, channel);
    if (!autonomyResult.allowed) {
        return {
            toolCallId: toolCall.id,
            name: handler.name,
            content: 'Action blocked by autonomy policy: ' + (autonomyResult.reason || 'Not permitted'),
            success: false,
            durationMs: Date.now() - startTime,
        };
    }

    // Per-tool timeout lookup
    const toolTimeouts = (config.security as Record<string, unknown>).toolTimeouts as Record<string, number> | undefined;
    const baseTimeout = toolTimeouts?.[handler.name] || config.security.commandTimeout || 30000;

    // Retry config
    const retryConfig = (config.security as Record<string, unknown>).toolRetry as { enabled?: boolean; maxRetries?: number; backoffBaseMs?: number } | undefined;
    const retryEnabled = retryConfig?.enabled !== false;
    const maxRetries = retryConfig?.maxRetries ?? 3;
    const backoffBase = retryConfig?.backoffBaseMs ?? 1000;

    let lastError: Error | null = null;
    let lastErrorClass: ErrorClass = 'permanent';

    for (let attempt = 0; attempt <= (retryEnabled ? maxRetries : 0); attempt++) {
        try {
            // On timeout retry, double the timeout
            const timeout = (attempt > 0 && lastErrorClass === 'timeout') ? baseTimeout * 2 : baseTimeout;

            const result = await Promise.race([
                handler.execute(args),
                new Promise<string>((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool "${handler.name}" timed out after ${timeout}ms`)), timeout)
                ),
            ]);

            const durationMs = Date.now() - startTime;
            if (attempt > 0) {
                logger.info(COMPONENT, `Tool ${handler.name} succeeded on retry ${attempt} in ${durationMs}ms`);
            } else {
                logger.info(COMPONENT, `Tool ${handler.name} completed in ${durationMs}ms`);
            }

            // Smart truncation — keep head + tail for large results (Claude Code pattern)
            let finalContent = result;
            if (result.length > 30000) {
                const head = result.slice(0, 20000);
                const tail = result.slice(-5000);
                finalContent = head + '\n\n[... ' + (result.length - 25000) + ' chars omitted ...]\n\n' + tail;
                logger.info(COMPONENT, `Tool \${handler.name} output truncated: \${result.length} → \${finalContent.length} chars`);
            }

            // Post-tool hooks — plugins can modify result
            if (toolHookPlugins.length > 0) {
                const hookResult = await runPostTool(toolHookPlugins, handler.name, args, { content: finalContent, success: true, durationMs });
                if (hookResult.modifiedContent !== undefined) finalContent = hookResult.modifiedContent;
            }

            return {
                toolCallId: toolCall.id,
                name: handler.name,
                content: finalContent,
                success: true,
                durationMs,
                retryCount: attempt,
            };
        } catch (error) {
            lastError = error as Error;
            lastErrorClass = classifyError(lastError, handler.name);

            // Don't retry permanent errors
            if (lastErrorClass === 'permanent') {
                break;
            }

            // Don't retry if this was the last attempt
            if (attempt >= maxRetries || !retryEnabled) {
                break;
            }

            // Exponential backoff: 1s, 2s, 4s (capped at 8s)
            const delay = Math.min(backoffBase * Math.pow(2, attempt), 8000);
            logger.warn(COMPONENT, `Tool ${handler.name} failed (${lastErrorClass}, attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message} — retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    // All retries exhausted or permanent error
    const durationMs = Date.now() - startTime;
    const errorMsg = lastError?.message || 'Unknown error';
    const retryCount = retryEnabled ? Math.min(maxRetries, lastErrorClass === 'permanent' ? 0 : maxRetries) : 0;
    logger.error(COMPONENT, `Tool ${handler.name} failed (${lastErrorClass}${retryCount > 0 ? `, ${retryCount} retries` : ''}): ${errorMsg}`);

    return {
        toolCallId: toolCall.id,
        name: handler.name,
        content: `Error: ${errorMsg}`,
        success: false,
        durationMs,
        retryCount,
        errorClass: lastErrorClass,
    };
}

/** Execute multiple tool calls (in parallel where possible, with write-conflict detection) */
export async function executeTools(toolCalls: ToolCall[], channel?: string): Promise<ToolResult[]> {
    // Single tool — fast path
    if (toolCalls.length <= 1) {
        return Promise.all(toolCalls.map(tc => executeTool(tc, channel)));
    }

    // Multiple tools — use parallelTools engine with write-conflict detection
    const parallelCalls = toolCalls.map(tc => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* use empty */ }
        return { id: tc.id, name: tc.function.name, args };
    });

    const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
        // Build a synthetic ToolCall for executeTool
        const syntheticTc: ToolCall = {
            id: '',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        };
        const result = await executeTool(syntheticTc, channel);
        return result.content;
    };

    const parallelResults = await executeToolsParallel(parallelCalls, executor);

    // Map back to ToolResult format with full metadata
    return parallelResults.map(pr => ({
        toolCallId: pr.toolCallId,
        name: pr.name,
        content: pr.content,
        success: !pr.content.startsWith('Error:'),
        durationMs: 0,
    }));
}
