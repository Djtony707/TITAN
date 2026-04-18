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
import { getCachedToolResult, cacheToolResult } from './trajectoryCompressor.js';
import { classifyProviderError, FailoverReason } from '../providers/errorTaxonomy.js';
import { snapshotBeforeWrite } from './shadowGit.js';
import { captureWrite, shouldCapture } from './selfProposals.js';
import { getSessionGoal } from './autonomyContext.js';

const COMPONENT = 'ToolRunner';

/**
 * G1: Sanitize base64 image data from tool results (OpenClaw pattern).
 * Prevents token explosion when vision/screenshot tools return raw base64.
 * Replaces data URIs with a compact placeholder showing byte count.
 */
function sanitizeBase64(content: string): string {
    return content.replace(
        /data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g,
        (match) => {
            const bytes = Math.ceil((match.length - match.indexOf(',') - 1) * 0.75);
            return `[image: ${(bytes / 1024).toFixed(1)}KB omitted]`;
        },
    );
}

/** Error classification for retry decisions */
export type ErrorClass = 'transient' | 'permanent' | 'timeout' | 'rate_limit';

/** Classify an error to determine if retry is appropriate.
 * Delegates to the centralized error taxonomy, then maps back to ErrorClass
 * for backward compatibility with tool execution retry logic.
 */
export function classifyError(error: Error, _toolName: string): ErrorClass {
    const classified = classifyProviderError(error);
    switch (classified.reason) {
        case FailoverReason.TIMEOUT:
            return 'timeout';
        case FailoverReason.RATE_LIMIT:
            return 'rate_limit';
        case FailoverReason.SERVER_ERROR:
        case FailoverReason.NETWORK_ERROR:
        case FailoverReason.OVERLOADED:
        case FailoverReason.EMPTY_RESPONSE:
            return 'transient';
        default:
            return classified.retryable ? 'transient' : 'permanent';
    }
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
        // LangGraph pattern: tell the LLM which tools actually exist so it can self-correct
        const available = Array.from(toolRegistry.keys()).sort();
        const suggestions = available.filter(t => {
            const name = toolCall.function.name.toLowerCase();
            return t.toLowerCase().includes(name.slice(0, 4)) || name.includes(t.slice(0, 4));
        }).slice(0, 5);
        const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : `\nAvailable tools include: ${available.slice(0, 20).join(', ')}${available.length > 20 ? ` (and ${available.length - 20} more)` : ''}`;
        return {
            toolCallId: toolCall.id,
            name: toolCall.function.name,
            content: `Error: "${toolCall.function.name}" is not a valid tool.${hint}\nPlease use one of the available tools.`,
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
    } catch (parseErr) {
        logger.warn('ToolRunner', `Malformed JSON args for ${handler.name}: ${(parseErr as Error).message} — raw: ${(toolCall.function.arguments || '').slice(0, 200)}`);
        // Try to salvage: if it looks like a truncated JSON, extract what we can
        const salvageMatch = (toolCall.function.arguments || '').match(/\{[\s\S]*/);
        if (salvageMatch) {
            try {
                // Attempt to close the JSON and parse
                const fixed = salvageMatch[0].replace(/,?\s*$/, '}');
                args = JSON.parse(fixed);
                logger.info('ToolRunner', `Salvaged partial JSON args for ${handler.name}`);
            } catch {
                // A5: Return error instead of executing with empty args (LangGraph pattern)
                return {
                    toolCallId: toolCall.id,
                    name: handler.name,
                    content: `Error: Could not parse arguments for "${handler.name}". Raw: ${(toolCall.function.arguments || '').slice(0, 200)}. Please provide valid JSON arguments.`,
                    success: false,
                    durationMs: Date.now() - startTime,
                };
            }
        }
    }

    // Schema validation: check required parameters before execution (LangGraph pattern)
    if (handler.parameters && typeof handler.parameters === 'object') {
        const schema = handler.parameters as { required?: string[]; properties?: Record<string, unknown> };
        if (schema.required && Array.isArray(schema.required)) {
            const missing = schema.required.filter(key => args[key] === undefined || args[key] === null);
            if (missing.length > 0) {
                const available = schema.properties ? Object.keys(schema.properties) : [];
                logger.warn('ToolRunner', `[SchemaValidation] ${handler.name}: missing required params: ${missing.join(', ')}`);
                return {
                    toolCallId: toolCall.id,
                    name: handler.name,
                    content: `Error: Missing required parameter(s): ${missing.join(', ')}. ` +
                        `Expected parameters: ${available.join(', ')}. Please provide all required arguments.`,
                    success: false,
                    durationMs: Date.now() - startTime,
                };
            }
        }
    }

    // Guardrails: validate tool call before execution
    try {
        const { guardToolCall } = await import('./guardrails.js');
        const guardResult = guardToolCall(handler.name, args);
        if (!guardResult.allowed) {
            logger.warn('ToolRunner', `[Guardrails] Blocked ${handler.name}: ${guardResult.reason}`);
            return {
                toolCallId: toolCall.id,
                name: handler.name,
                content: `Error: Tool call blocked by guardrails — ${guardResult.reason}`,
                success: false,
                durationMs: Date.now() - startTime,
            };
        }
    } catch { /* guardrails unavailable — continue */ }

    // Read-only tool result cache (60s TTL, helper self-gates to read-only allowlist)
    const cacheArgKey = toolCall.function.arguments || '{}';
    const cachedResult = getCachedToolResult(handler.name, cacheArgKey);
    if (cachedResult !== null) {
        logger.info(COMPONENT, `[Cache HIT] ${handler.name}`);
        return {
            toolCallId: toolCall.id,
            name: handler.name,
            content: cachedResult,
            success: true,
            durationMs: Date.now() - startTime,
        };
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

    // Shadow git checkpoint — snapshot files before mutation (fire-and-forget)
    const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'apply_patch']);
    if (MUTATING_TOOLS.has(handler.name)) {
        const filePath = (args.path || args.file_path || args.filePath) as string;
        if (filePath) {
            snapshotBeforeWrite(handler.name, filePath).catch(err =>
                logger.debug(COMPONENT, `Shadow checkpoint skipped: ${(err as Error).message}`),
            );
        }
        // v4.8.0: self-proposal capture — if this write is happening inside
        // an autonomous Soma-driven session, stash a copy for specialist
        // review. Fire-and-forget — never blocks tool execution.
        captureSelfProposalIfApplicable(handler.name, args).catch(err =>
            logger.debug(COMPONENT, `Self-proposal capture skipped: ${(err as Error).message}`),
        );
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
    let attempt = 0;

    for (; attempt <= (retryEnabled ? maxRetries : 0); attempt++) {
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

            // G1: Strip base64 image data before size check (prevents token explosion)
            let finalContent = sanitizeBase64(result);

            // Smart truncation — keep head + tail for large results (TITAN pattern)
            if (finalContent.length > 30000) {
                const head = finalContent.slice(0, 20000);
                const tail = finalContent.slice(-5000);
                finalContent = head + '\n\n[... ' + (finalContent.length - 25000) + ' chars omitted ...]\n\n' + tail;
                logger.info(COMPONENT, `Tool ${handler.name} output truncated: ${result.length} → ${finalContent.length} chars`);
            }

            // Post-tool hooks — plugins can modify result
            if (toolHookPlugins.length > 0) {
                const hookResult = await runPostTool(toolHookPlugins, handler.name, args, { content: finalContent, success: true, durationMs });
                if (hookResult.modifiedContent !== undefined) finalContent = hookResult.modifiedContent;
            }

            // Cache the result for read-only tools (helper self-gates)
            cacheToolResult(handler.name, cacheArgKey, finalContent);

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
    const retryCount = attempt; // actual number of retries performed (matches success path)
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

// ── Self-proposal capture helper (v4.8.0) ────────────────────────────────

/**
 * If the current write is happening in an autonomous, Soma-driven session,
 * stash a copy of the written content for specialist review. Silent no-op
 * in all other cases (user-driven edits, non-autonomous mode, or when
 * selfMod.enabled is false in config).
 */
async function captureSelfProposalIfApplicable(
    toolName: string,
    args: Record<string, unknown>,
): Promise<void> {
    // Resolve what we can from the current autonomous context
    const { getCurrentSessionId } = await import('./agent.js').catch(() => ({ getCurrentSessionId: () => null }));
    const sessionId: string | null = typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : null;
    const sessionGoal = getSessionGoal(sessionId);
    const config = loadConfig();
    const autonomous = (config.autonomy?.mode === 'autonomous');
    const goalProposedBy = sessionGoal?.proposedBy ?? null;

    if (!shouldCapture({ toolName, autonomous, goalProposedBy })) return;

    const filePath = (args.path || args.file_path || args.filePath) as string | undefined;
    const content = (args.content || args.new_text || args.data) as string | undefined;
    if (!filePath || !content) return;

    captureWrite({
        toolName,
        filePath,
        content,
        sessionId,
        agentId: null, // filled by downstream if needed
        goalId: sessionGoal?.goalId ?? null,
        goalTitle: sessionGoal?.goalTitle ?? null,
        goalProposedBy,
    });
}
