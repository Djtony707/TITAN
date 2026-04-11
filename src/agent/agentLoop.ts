/**
 * TITAN — Agent Loop (Phase State Machine)
 *
 * Replaces the monolithic for-loop in agent.ts with a clean Think/Act/Respond
 * state machine that eliminates cloud model tool looping by design.
 *
 * Phases:
 *   THINK  — Call LLM WITH tools. Model returns content or tool_calls.
 *   ACT    — Execute tool calls, record results, run loop detection.
 *   RESPOND — Call LLM WITHOUT tools. Forces text-only final answer.
 *   DONE   — Loop exits.
 *
 * Non-autonomous: THINK → ACT → RESPOND → DONE (one tool round, then text)
 * Autonomous:     THINK → ACT → THINK → ... → RESPOND → DONE (multi-round)
 */
import { chat, chatStream } from '../providers/router.js';
import { executeTools, type ToolResult } from './toolRunner.js';
import { drainPendingResults, getAgentInbox, claimWakeupRequest } from './agentWakeup.js';
import { setCurrentSessionId } from './agent.js';
import { hasActionDirectives, compileActions } from './actionCompiler.js';
import { heartbeat, recordToolCall, checkResponse, getNudgeMessage, checkToolCallCapability, resetToolCallFailures } from './stallDetector.js';
import { loadConfig } from '../config/config.js';
import { checkForLoop } from './loopDetection.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from './subAgent.js';
import { updateIssue, startRun, endRun, addIssueComment } from './commandPost.js';
import { recordTokenUsage } from './costOptimizer.js';
import { maybeCompressContext } from './costOptimizer.js';
import type { TitanConfig } from '../config/schema.js';
import { buildSmartContext } from './contextManager.js';
import { getCachedResponse, setCachedResponse } from './responseCache.js';
import { shouldReflect, reflect, resetProgress, recordProgress } from './reflection.js';
import { recordToolResult, classifyTaskType, recordToolPreference, getErrorResolution, recordErrorResolution } from '../memory/learning.js';
import { saveCheckpoint } from './checkpoint.js';
import { updateSoulState, emitHeartbeat, getInnerMonologue, recordAttempt } from './soul.js';
import { recordToolUsage } from './userProfile.js';
import { runSubAgent, type Domain } from './swarm.js';
import { compressToolResult, recordStep, getProgressSummary } from './trajectoryCompressor.js';
import { verifyFileWrite } from './autoVerify.js';
import type { ChatMessage, ChatResponse, ToolCall, ToolDefinition } from '../providers/base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'AgentLoop';

// ── Phase State Machine ��─────────────────────────────────────────────

export type AgentPhase = 'think' | 'act' | 'respond' | 'done';

/** Stream callbacks — same interface as agent.ts for compatibility */
export interface StreamCallbacks {
    onToken?: (token: string) => void;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: string, durationMs: number, success: boolean) => void;
    onThinking?: () => void;
    onRound?: (round: number, maxRounds: number) => void;
}

/** All inputs the loop needs from processMessage */
export interface LoopContext {
    messages: ChatMessage[];
    activeTools: ToolDefinition[];
    allToolsBackup: ToolDefinition[];
    activeModel: string;
    config: TitanConfig;
    sessionId: string;
    agentId?: string;  // For Command Post inbox checking
    channel: string;
    message: string;
    streamCallbacks?: StreamCallbacks;
    signal?: AbortSignal;
    isAutonomous: boolean;
    voiceFastPath: boolean;
    effectiveMaxRounds: number;
    taskEnforcementActive: boolean;
    reflectionEnabled: boolean;
    reflectionInterval: number;
    toolSearchEnabled: boolean;
    isKimiSwarm: boolean;
    selfHealEnabled: boolean;
    smartExitEnabled?: boolean;
    thinkingOverride?: string;
}

/** Everything processMessage needs back from the loop */
export interface LoopResult {
    content: string;
    toolsUsed: string[];
    orderedToolSequence: string[];
    modelUsed: string;
    promptTokens: number;
    completionTokens: number;
    budgetExhausted: boolean;
    /** Structured details from each tool call — used for inter-step context in deliberation */
    toolCallDetails: Array<{
        name: string;
        args: Record<string, unknown>;
        resultSnippet: string;
        success: boolean;
    }>;
}

// ── Helper: strip leaked tool JSON from LLM responses ────────────────

function stripToolJson(text: string): string {
    return text.replace(/\s*\{"(?:name|tool_call)":\s*"[^"]+",\s*"(?:parameters|arguments)":\s*\{[^}]*\}\s*\}\s*/g, '').trim();
}

// ── Helper: extract tool call from text content (ToolRescue) ─────────
// Moved inline to avoid circular dependency. This is the rescue logic
// for models that describe tool calls in text instead of structured output.

function extractToolCallFromContent(
    content: string,
    activeTools: ToolDefinition[],
    isCloudModel = false,
): ToolCall | null {
    if (!content || content.length < 10) return null;
    const toolNames = activeTools.map(t => t.function.name);

    // Strategy 1a: Embedded JSON tool calls
    const jsonMatch = content.match(/\{"(?:name|tool_call)":\s*"([^"]+)",\s*"(?:parameters|arguments)":\s*(\{[^}]*(?:\{[^}]*\}[^}]*)?\})\s*\}/);
    if (jsonMatch && toolNames.includes(jsonMatch[1])) {
        return { id: `rescue_${Date.now()}`, type: 'function', function: { name: jsonMatch[1], arguments: jsonMatch[2] } };
    }

    // Strategy 1b: DeepSeek XML-style <function_call> format
    const xmlMatch = content.match(/<function_call>\s*(\{[\s\S]*?\})\s*<\/function_call>/);
    if (xmlMatch) {
        try {
            const parsed = JSON.parse(xmlMatch[1]);
            const name = parsed.name || parsed.function?.name;
            const args = parsed.arguments || parsed.parameters || parsed.function?.arguments;
            if (name && toolNames.includes(name)) {
                return { id: `rescue_${Date.now()}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) } };
            }
        } catch { /* malformed */ }
    }

    // Strategy 2: Natural language tool mentions (cloud models)
    const skipSet = isCloudModel
        ? new Set<string>()
        : new Set(['shell', 'read_file', 'write_file', 'edit_file', 'list_dir', 'memory', 'web_search', 'web_fetch', 'tool_search']);

    for (const toolName of toolNames) {
        if (skipSet.has(toolName)) continue;
        const mentionRegex = new RegExp(
            `(?:call(?:ing)?|us(?:e|ing)|invok(?:e|ing)|execut(?:e|ing)|runn?(?:ing)?|tool\\s+)\\s*(?:the\\s+)?(?:tool\\s+)?(?:named\\s+)?["\`']?${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["\`']?`,
            'i',
        );
        if (!mentionRegex.test(content)) continue;

        // Try to extract JSON args
        const jsonArgs = content.match(/\{[\s\S]*?\}/);
        if (jsonArgs) {
            try {
                const parsed = JSON.parse(jsonArgs[0]);
                if (typeof parsed === 'object' && parsed !== null) {
                    const args: Record<string, string> = {};
                    for (const [k, v] of Object.entries(parsed)) {
                        args[k] = typeof v === 'string' ? v : JSON.stringify(v);
                    }
                    return { id: `rescue_${Date.now()}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } };
                }
            } catch { /* not valid JSON */ }
        }

        // Tool-specific extraction for common tools
        if (toolName === 'shell') {
            const cmdMatch = content.match(/(?:`{1,3}(?:bash|sh|shell)?\n?(.*?)`{1,3}|(?:command|run|execute)[=:\s]+["'](.+?)["'])/s);
            if (cmdMatch) {
                const cmd = (cmdMatch[1] || cmdMatch[2]).trim();
                if (cmd.length > 0) return { id: `rescue_${Date.now()}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: cmd }) } };
            }
        }
        if ((toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') && toolName === 'read_file') {
            const pathMatch = content.match(/(?:file|path)[=:\s]+["']?((?:\/|~\/|\.\/)\S+?)["'\s,)]/i)
                || content.match(/((?:\/|~\/)\S+\.\w{1,10})/);
            if (pathMatch) return { id: `rescue_${Date.now()}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: pathMatch[1] }) } };
        }
        if (toolName === 'web_search') {
            const queryMatch = content.match(/(?:search(?:ing)?(?:\s+for)?|query)[=:\s]+["'](.+?)["']/i)
                || content.match(/search(?:ing)?\s+(?:for\s+)?["'](.+?)["']/i);
            if (queryMatch) return { id: `rescue_${Date.now()}`, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: queryMatch[1] }) } };
        }
    }

    return null;
}

// ── Helper: find a fallback model for tool calling ───────────────────

function findToolCapableFallback(failedModel: string, failedModels: Set<string>, config: TitanConfig): string | null {
    const candidates: string[] = [];
    const toolCapable = (config.agent as Record<string, unknown>).toolCapableModels as string[] | undefined;
    if (toolCapable?.length) candidates.push(...toolCapable);
    const chain = (config.agent as Record<string, unknown>).fallbackChain as string[] | undefined;
    if (chain?.length) candidates.push(...chain);
    const aliases = (config.agent as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
    if (aliases?.fast) candidates.push(aliases.fast);
    if (aliases?.smart) candidates.push(aliases.smart);
    return candidates.filter(m => m !== failedModel && !failedModels.has(m))[0] || null;
}

// ── Tool Result Summarization ───────────────────────────────────

/** Extract key data points from large file contents */
function summarizeToolResult(content: string): string | null {
    const parts: string[] = [];

    // Extract version numbers
    const versions = content.match(/["']?version["']?\s*[:=]\s*["']?([\d.]+)["']?/gi);
    if (versions) parts.push(`Versions found: ${versions.slice(0, 3).join(', ')}`);

    // Extract name/title
    const names = content.match(/["']?name["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (names) parts.push(`Name: ${names[1]}`);

    // Extract exports/functions
    const exports = content.match(/export\s+(?:async\s+)?function\s+(\w+)/g);
    if (exports) parts.push(`Exports: ${exports.slice(0, 5).map(e => e.replace(/export\s+(async\s+)?function\s+/, '')).join(', ')}`);

    // Extract constants
    const constants = content.match(/(?:const|export const)\s+([A-Z_]+)\s*=\s*['"]([^'"]+)['"]/g);
    if (constants) parts.push(`Constants: ${constants.slice(0, 3).join('; ')}`);

    // File line count
    const lineCount = content.split('\n').length;
    parts.push(`${lineCount} lines total`);

    return parts.length > 1 ? parts.join(' | ') : null;
}

// ── Response Validation ─────────────────────────────────────────

/** Detect if the response is missing specific data the user asked for */
function detectResponseGap(userMessage: string, response: string, messages: ChatMessage[]): string | null {
    const lower = userMessage.toLowerCase();
    const respLower = response.toLowerCase();

    // Check: user asked for a number/version/count but response has none
    if (/\b(version|number|count|how many|what is the|tell me the)\b/.test(lower)) {
        const hasNumber = /\d+/.test(response);
        // Check if tool results contain numbers the response missed
        const toolResults = messages.filter(m => m.role === 'tool').slice(-3);
        const toolHasNumber = toolResults.some(m => /\d+\.\d+\.\d+|\b\d{1,5}\b/.test(m.content || ''));
        if (!hasNumber && toolHasNumber) {
            return 'The user asked for a specific number or version. Your tool results contain this data but your response does not include it.';
        }
    }

    // Check: user asked to read a file but response doesn't reference its content
    if (/\b(read|show|contents? of|what does|what.s in)\b/.test(lower)) {
        if (respLower.includes('i read') || respLower.includes('i was able to') || respLower.includes('here is')) {
            // Response claims to have read — probably fine
            return null;
        }
        const toolResults = messages.filter(m => m.role === 'tool').slice(-3);
        if (toolResults.length > 0 && response.length < 50) {
            return 'The user asked you to read file contents. Your tool returned data but your response is too short — include the relevant information.';
        }
    }

    // Check: user asked for a specific value (e.g., "the TITAN_VERSION value")
    if (/\b(value|result|output|answer)\b/.test(lower)) {
        if (response.length < 20 || respLower.includes('error') || respLower.includes('unable')) {
            const toolResults = messages.filter(m => m.role === 'tool').slice(-3);
            if (toolResults.some(m => (m.content || '').length > 50)) {
                return 'The user asked for a specific value. Your tools retrieved data but your response did not include it.';
            }
        }
    }

    return null;
}

// ── Main Loop ──────────────────────────���───────────────────────────���─

export async function runAgentLoop(ctx: LoopContext): Promise<LoopResult> {
    const result: LoopResult = {
        content: '',
        toolsUsed: [],
        orderedToolSequence: [],
        modelUsed: ctx.activeModel,
        promptTokens: 0,
        completionTokens: 0,
        budgetExhausted: false,
        toolCallDetails: [],
    };

    let phase: AgentPhase = 'think';
    let round = 0;
    let activeModel = ctx.activeModel;

    // Self-heal state
    let modelSwitchCount = 0;
    let selfHealExhausted = false;
    const failedModels = new Set<string>();

    // Bounded retries for [NoTools] rounds — prevents infinite think-loop when
    // the model keeps returning prose instead of tool calls
    let noToolsRetryCount = 0;
    const MAX_MODEL_SWITCHES = 2;

    // Reflection state
    let pivotCount = 0;
    const MAX_PIVOTS = 1;
    const failedApproaches: string[] = [];
    resetProgress();

    // Learning state
    let lastFailedTool: { name: string; error: string } | null = null;

    // Tool search state
    const discoveredTools = new Set<string>();

    // Shell-for-files nudge counter
    let shellForFilesCount = 0;

    // Response validation retry flag (one retry max)
    let responseValidationRetried = false;

    // Pending tool calls from think phase (passed to act phase)
    let pendingToolCalls: ToolCall[] = [];
    let pendingAssistantContent = '';

    // Token budget for context compression
    const tokenBudget = ctx.voiceFastPath ? 2000 : (ctx.config.agent as Record<string, unknown>).tokenBudget as number || 12000;

    // ── Set session context for spawn_agent async delegation ─────
    setCurrentSessionId(ctx.sessionId);

    // ── Inject completed async sub-agent results as context ──────
    const cpEnabled = (ctx.config.commandPost as Record<string, unknown> | undefined)?.enabled ?? false;
    if (cpEnabled) {
        const completedAsync = drainPendingResults(ctx.sessionId);
        if (completedAsync.length > 0) {
            const injection = completedAsync.map(r =>
                `[Async Task Complete] ${r.issueIdentifier} (${r.agentName}): ${r.result.success ? 'SUCCESS' : 'FAILED'}\n${r.result.content.slice(0, 500)}`
            ).join('\n\n');
            ctx.messages.push({ role: 'user', content: injection });
            logger.info(COMPONENT, `[AsyncResults] Injected ${completedAsync.length} completed async result(s) into context`);
        }

        // ── Heartbeat inbox check: claim and process pending sub-agent tasks ──
        if (ctx.agentId && round > 0 && round % 3 === 0) {
            // Check inbox every 3 rounds to avoid thrashing
            await checkAndProcessInbox(ctx.agentId);
        }
    }

    // ── Process any pending inbox work before this round ──
    if (cpEnabled && ctx.agentId && round === 0) {
        await checkAndProcessInbox(ctx.agentId);
    }

    while (phase !== 'done' && round < ctx.effectiveMaxRounds) {
        // ── Abort check ──────────────────���───────────────────────
        if (ctx.signal?.aborted) {
            logger.info(COMPONENT, `Session aborted by user at round ${round + 1} (${phase} phase)`);
            result.content = '[Stopped by user]';
            break;
        }

        // Emit round info
        if (round > 0) ctx.streamCallbacks?.onThinking?.();
        ctx.streamCallbacks?.onRound?.(round + 1, ctx.effectiveMaxRounds);

        logger.info(COMPONENT, `Round ${round + 1}/${ctx.effectiveMaxRounds} — phase: ${phase}, model: ${activeModel}, tools: ${phase === 'respond' ? 0 : ctx.activeTools.length}`);

        switch (phase) {

        // ══════════��══════════════════════════���═════════════════════
        // THINK PHASE — Call LLM with tools available
        // ══════════════════════════════════════════���════════════════
        case 'think': {
            // ── Reflection (autonomous mode, every N rounds) ──────
            if (ctx.reflectionEnabled && round > 0 && shouldReflect(round, ctx.reflectionInterval)) {
                try {
                    const lastToolResult = ctx.messages.filter(m => m.role === 'tool').slice(-1)[0]?.content || '';
                    const failedContext = failedApproaches.length > 0 ? failedApproaches.join('; ') : undefined;
                    const reflectionResult = await reflect(round, result.toolsUsed, ctx.message, lastToolResult, failedContext);

                    if (reflectionResult.decision === 'stop') {
                        logger.info(COMPONENT, `Reflection says stop at round ${round + 1}: ${reflectionResult.reasoning}`);
                        ctx.messages.push({ role: 'user', content: `You've reflected on your progress and decided you have enough information. Respond to the user now with your findings. Reasoning: ${reflectionResult.reasoning}` });
                        phase = 'respond';
                        continue;
                    } else if (reflectionResult.decision === 'pivot' && pivotCount < MAX_PIVOTS) {
                        pivotCount++;
                        const toolsSummary = [...new Set(result.toolsUsed)].join(', ');
                        const approachSummary = `Attempted tools: ${toolsSummary}. Result: ${reflectionResult.reasoning}`;
                        failedApproaches.push(approachSummary);
                        logger.info(COMPONENT, `PIVOT at round ${round + 1}: ${reflectionResult.reasoning}`);

                        // Clear accumulated tool results but keep system prompt + original message
                        const systemMsg = ctx.messages.find(m => m.role === 'system');
                        const userMsg = ctx.messages.find(m => m.role === 'user' && !m.content.startsWith('['));
                        ctx.messages.length = 0;
                        if (systemMsg) ctx.messages.push(systemMsg);
                        if (userMsg) ctx.messages.push(userMsg);
                        ctx.messages.push({ role: 'user', content: `Warning: STRATEGIC PIVOT: Your previous approach failed.\nWhat was tried: ${approachSummary}\nWhy it failed: ${reflectionResult.reasoning}\n\nTry a COMPLETELY DIFFERENT strategy. Do NOT repeat the same tools or approach.` });

                        resetProgress();
                        result.toolsUsed.length = 0;
                        result.orderedToolSequence.length = 0;
                    } else if (reflectionResult.decision === 'adjust') {
                        ctx.messages.push({ role: 'user', content: `Reflection suggests adjusting approach: ${reflectionResult.reasoning}. Try a different strategy.` });
                    }
                    // 'continue' → no injection, just keep going
                } catch (e) {
                    logger.warn(COMPONENT, `Reflection failed, continuing: ${(e as Error).message}`);
                }
            }

            // ── Graceful degradation near round limit ─────────────
            if (round >= ctx.effectiveMaxRounds - 2 && round >= 3) {
                ctx.messages.push({
                    role: 'user',
                    content: `IMPORTANT: You are approaching the tool execution limit (round ${round + 1}/${ctx.effectiveMaxRounds}). Wrap up your current work: summarize progress so far and provide a clear response. If the task is incomplete, describe what remains.`,
                });
                phase = 'respond';
                continue;
            }

            // ── Context compression ─────��────────────────────────
            let smartMessages: ChatMessage[];
            if (ctx.voiceFastPath) {
                smartMessages = ctx.messages as ChatMessage[];
            } else {
                const { messages: compressedMessages, didCompress, savedTokens } = maybeCompressContext(
                    ctx.messages.filter((m) => m.role !== 'tool' || round < 3)
                );
                if (didCompress) {
                    logger.info(COMPONENT, `Context compressed, saved ~${savedTokens} tokens`);
                    ctx.messages.length = 0;
                    ctx.messages.push(...compressedMessages);
                }
                smartMessages = (compressedMessages as ChatMessage[]).length <= 4
                    ? compressedMessages as ChatMessage[]
                    : buildSmartContext(compressedMessages as ChatMessage[], tokenBudget);
            }

            // ── Response cache check ─────────────────────────────
            const cachedResponse = getCachedResponse(smartMessages, activeModel);
            if (cachedResponse) {
                logger.info(COMPONENT, `Cache hit — skipping LLM call`);
                result.content = cachedResponse;
                phase = 'done';
                break;
            }

            // ── Call LLM with tools ──────────────────────────────
            const thinkingMode = ctx.thinkingOverride || ctx.config.agent.thinkingMode || 'off';
            const isVoice = ctx.voiceFastPath;
            // Claude Code-style context management:
            // 1. Clear old tool results (keep last 5 in full, truncate older ones)
            // 2. Trim to recent messages if context is getting large
            if (smartMessages.length > 6) {
                let toolResultCount = 0;
                for (let i = smartMessages.length - 1; i >= 0; i--) {
                    const msg = smartMessages[i];
                    if (msg.role === 'tool' || (msg.role === 'assistant' && msg.toolCalls)) {
                        toolResultCount++;
                        if (toolResultCount > 5 && msg.content && msg.content.length > 200) {
                            // Truncate old tool results (Claude Code pattern)
                            smartMessages[i] = { ...msg, content: '[Earlier tool result cleared — ' + msg.content.slice(0, 80) + '...]' };
                        }
                    }
                }
            }

            // Hard trim if too many messages
            if (smartMessages.length > 12 && phase !== 'respond') {
                const system = smartMessages.filter(m => m.role === 'system');
                const recent = smartMessages.filter(m => m.role !== 'system').slice(-8);
                smartMessages = [...system, ...recent];
                logger.info(COMPONENT, `[ContextTrim] Trimmed to ${smartMessages.length} messages`);
            }

            const chatOptions = {
                model: activeModel,
                messages: smartMessages,
                tools: ctx.activeTools.length > 0 ? ctx.activeTools : undefined,
                maxTokens: isVoice ? Math.min(ctx.config.agent.maxTokens, 300) : ctx.config.agent.maxTokens,
                temperature: ctx.config.agent.temperature,
                thinking: isVoice ? false : thinkingMode !== 'off',
                thinkingLevel: thinkingMode as 'off' | 'low' | 'medium' | 'high',
                forceToolUse: ctx.activeTools.length > 0
                    && (ctx.isAutonomous || ctx.taskEnforcementActive)
                    && (ctx.config.agent as Record<string, unknown>).forceToolUse !== false
                    && phase !== 'respond',
            };

            let response: ChatResponse;
            if (ctx.streamCallbacks?.onToken) {
                let streamContent = '';
                const streamToolCalls: ToolCall[] = [];
                for await (const chunk of chatStream(chatOptions)) {
                    if (chunk.type === 'text' && chunk.content) {
                        streamContent += chunk.content;
                        ctx.streamCallbacks.onToken(chunk.content);
                    } else if (chunk.type === 'tool_call' && chunk.toolCall) {
                        streamToolCalls.push(chunk.toolCall);
                        ctx.streamCallbacks.onToolCall?.(chunk.toolCall.function.name, JSON.parse(chunk.toolCall.function.arguments || '{}'));
                    } else if (chunk.type === 'error') {
                        logger.error(COMPONENT, `Stream error: ${chunk.error}`);
                    }
                }
                response = {
                    id: `stream-${Date.now()}`,
                    content: streamContent,
                    toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                    finishReason: streamToolCalls.length > 0 ? 'tool_calls' : 'stop',
                    model: activeModel,
                };
            } else {
                response = await chat(chatOptions);
            }

            result.modelUsed = response.model;
            const promptTokens = response.usage?.promptTokens || 0;
            const completionTokens = response.usage?.completionTokens || 0;
            result.promptTokens += promptTokens;
            result.completionTokens += completionTokens;

            // ── Cost tracking ────────────────────────────────────
            const costCheck = recordTokenUsage(ctx.sessionId, activeModel, promptTokens, completionTokens);
            if (costCheck.budgetExceeded) {
                result.content = '⚠️ Daily spending limit reached. TITAN has paused to keep your API costs under control. You can increase the limit in settings or wait until tomorrow.';
                phase = 'done';
                break;
            }

            heartbeat(ctx.sessionId);

            // ── No tool calls → check rescue paths or accept response ──
            if (!response.toolCalls || response.toolCalls.length === 0) {
                logger.warn(COMPONENT, `[NoTools] Model returned text (len=${response.content.length}): ${response.content.slice(0, 200)}`);

                // FabricationGuard: detect model claiming to have completed actions without tool calls
                // gemma4 says "I've written X to file Y" without actually calling write_file
                const fabricationMatch = response.content.match(/(?:written|saved|created|wrote)\s+(?:.*?)(?:to|at|in)\s+["'`]?(\/[\w/.-]+\.[a-z]+)["'`]?/i);
                if (fabricationMatch) {
                    const filePath = fabricationMatch[1];
                    // Extract what should have been written
                    const contentMatch = response.content.match(/(?:written|saved|wrote)\s+["`]([^"`]+)["`]/i);
                    const fileContent = contentMatch ? contentMatch[1] : 'placeholder';
                    logger.warn(COMPONENT, `[FabricationGuard] Model claimed to write "\${filePath}" without tool call — forcing write_file`);
                    response.toolCalls = [{
                        id: `fab-\${Date.now()}`,
                        type: 'function' as const,
                        function: { name: 'write_file', arguments: JSON.stringify({ path: filePath, content: fileContent }) },
                    }];
                    response.content = '';
                }
                // Self-Heal: detect tool calling failure
                if (ctx.selfHealEnabled && !selfHealExhausted && ctx.activeTools.length > 0) {
                    const toolFailure = checkToolCallCapability(ctx.sessionId, response.content, ctx.activeTools.length > 0);
                    if (toolFailure) {
                        const fallback = findToolCapableFallback(activeModel, failedModels, ctx.config);
                        if (fallback) {
                            logger.warn(COMPONENT, `[SelfHeal] ${activeModel} failed tool calling. Switching to ${fallback}`);
                            failedModels.add(activeModel);
                            activeModel = fallback;
                            result.modelUsed = fallback;
                            modelSwitchCount++;
                            if (modelSwitchCount >= MAX_MODEL_SWITCHES) selfHealExhausted = true;
                            resetToolCallFailures(ctx.sessionId);
                            ctx.messages.push({ role: 'user', content: `[System: Model switched to ${fallback} for tool calling capability. Use your tools to complete the task.]` });
                            // Stay in think phase — retry with new model
                            continue;
                        } else if (modelSwitchCount > 0) {
                            selfHealExhausted = true;
                            result.content = 'I tried switching models but tool calling is still failing. Please check my configuration with the self_doctor tool or switch me to a model that supports tool calling.';
                            phase = 'done';
                            break;
                        }
                    }
                }

                // ActionCompiler: if model output ACTION: directives, compile them to tool calls
                if (response.content && hasActionDirectives(response.content)) {
                    const compiled = compileActions(response.content);
                    if (compiled.length > 0) {
                        logger.info(COMPONENT, `[ActionCompiler] Compiled ${compiled.length} actions from text`);
                        // Execute first action, queue the rest
                        const first = compiled[0];
                        response.toolCalls = [{
                            id: `ac-${Date.now()}`,
                            type: 'function' as const,
                            function: { name: first.tool, arguments: JSON.stringify(first.args) },
                        }];
                        response.content = '';
                        // Store remaining actions for subsequent rounds
                        if (compiled.length > 1) {
                            const remaining = compiled.slice(1).map((a, i) => `ACTION: ${a.tool} ${a.args.path || a.args.command || ''}`).join('\n');
                            ctx.messages.push({ role: 'user', content: `[Queued actions]\n${remaining}\nExecute the next ACTION.` });
                        }
                    }
                }

                // IntentParser: aggressively extract tool calls from text content
                // Models like gemma4 often describe what they WANT to do instead of calling tools.
                // We parse the intent and generate the tool call for them.
                if (!response.toolCalls || response.toolCalls.length === 0) {
                    const text = response.content;
                    let rescued = false;

                    // Pattern 1: Code blocks → write_file
                    const codeBlockMatch = text.match(/```(?:html|typescript|javascript|python|css|json)\n([\s\S]+?)```/);
                    if (codeBlockMatch && codeBlockMatch[1].length > 50) {
                        const pathMatch = text.match(/(?:save|write|create|update|file|path|to)[:\s]+["'`]?(\/[\w/.-]+\.[a-z]+)["'`]?/i)
                            || text.match(/(\/home\/[\w/.-]+\.[a-z]+)/)
                            || text.match(/(\/[\w]+\/[\w/.-]+\.[a-z]+)/);
                        if (pathMatch) {
                            logger.info(COMPONENT, `[IntentParser] Code block → write_file("${pathMatch[1]}", ${codeBlockMatch[1].length} chars)`);
                            response.toolCalls = [{
                                id: `intent-${Date.now()}`,
                                type: 'function' as const,
                                function: { name: 'write_file', arguments: JSON.stringify({ path: pathMatch[1], content: codeBlockMatch[1] }) },
                            }];
                            rescued = true;
                        }
                    }

                    // Pattern 1b: "I wrote/saved/created file X" → write_file (past-tense fabrication)
                    if (!rescued) {
                        const pastWrite = text.match(/(?:wrote|written|saved|created)\s+(?:.*?)(?:to|at|in)\s+["'`]?(\/[\w/.-]+\.[a-z]+)["'`]?/i);
                        if (pastWrite) {
                            const contentMatch = text.match(/(?:wrote|written|saved)\s+["'`]([^"'`]+)["'`]/i);
                            logger.info(COMPONENT, `[IntentParser] Past-tense write → write_file("\${pastWrite[1]}")`);
                            response.toolCalls = [{
                                id: `intent-\${Date.now()}`,
                                type: 'function' as const,
                                function: { name: 'write_file', arguments: JSON.stringify({ path: pastWrite[1], content: contentMatch ? contentMatch[1] : '' }) },
                            }];
                            rescued = true;
                        }
                    }

                    // Pattern 2: "I'll read/open/check file X" → read_file
                    if (!rescued) {
                        const readIntent = text.match(/(?:read|open|check|look at|examine|view|inspect)\s+(?:the\s+)?(?:file\s+)?["'`]?(\/[\w/.-]+\.[a-z]+)["'`]?/i);
                        if (readIntent) {
                            logger.info(COMPONENT, `[IntentParser] Read intent → read_file("${readIntent[1]}")`);
                            response.toolCalls = [{
                                id: `intent-${Date.now()}`,
                                type: 'function' as const,
                                function: { name: 'read_file', arguments: JSON.stringify({ path: readIntent[1] }) },
                            }];
                            rescued = true;
                        }
                    }

                    // Pattern 3: "I'll run/execute command X" → shell
                    if (!rescued) {
                        const shellIntent = text.match(/(?:run|execute|running)\s+(?:the\s+)?(?:command\s+)?[`]([^`]+)[`]/i);
                        if (shellIntent) {
                            logger.info(COMPONENT, `[IntentParser] Shell intent → shell("${shellIntent[1].slice(0, 60)}")`);
                            response.toolCalls = [{
                                id: `intent-${Date.now()}`,
                                type: 'function' as const,
                                function: { name: 'shell', arguments: JSON.stringify({ command: shellIntent[1] }) },
                            }];
                            rescued = true;
                        }
                    }

                    // Pattern 4: "I'll edit/modify/update X in file Y" → read_file (to prepare for edit)
                    if (!rescued) {
                        const editIntent = text.match(/(?:edit|modify|update|change|replace|add to)\s+(?:the\s+)?(?:file\s+)?["'`]?(\/[\w/.-]+\.[a-z]+)["'`]?/i);
                        if (editIntent) {
                            logger.info(COMPONENT, `[IntentParser] Edit intent → read_file("${editIntent[1]}") (prep for edit)`);
                            response.toolCalls = [{
                                id: `intent-${Date.now()}`,
                                type: 'function' as const,
                                function: { name: 'read_file', arguments: JSON.stringify({ path: editIntent[1] }) },
                            }];
                            rescued = true;
                        }
                    }

                    if (rescued) {
                        // Clear the text content so it doesn't confuse the model on next round
                        response.content = '';
                    }
                }

                // ToolRescue: final attempt to extract a tool call from text content
                if (!response.toolCalls || response.toolCalls.length === 0) {
                    const isCloudModel = activeModel.includes(':cloud') || activeModel.includes('-cloud');
                    const rescuedToolCall = extractToolCallFromContent(response.content, ctx.activeTools, isCloudModel);
                    if (rescuedToolCall) {
                        logger.info(COMPONENT, `[ToolRescue] Extracted "${rescuedToolCall.function.name}" from content text`);
                        response.toolCalls = [rescuedToolCall];
                        // Fall through to tool_calls handling below
                    }
                }

                // If ALL rescue paths failed (still no tool calls), run stall detection
                // and either nudge for retry or accept the text response. Without this
                // branch, an empty-toolCalls THINK round would fall through with phase
                // still 'think' and round un-incremented → infinite retry loop.
                if (!response.toolCalls || response.toolCalls.length === 0) {
                    noToolsRetryCount++;

                    // Stall detection
                    const stallEvent = checkResponse(ctx.sessionId, response.content, round, ctx.effectiveMaxRounds);
                    if (stallEvent) {
                        const state = stallEvent as { nudgeCount?: number };
                        const nudgeCount = state.nudgeCount ?? 0;

                        // Hard kill after 2 nudges (Paperclip pattern: bounded retries)
                        if (nudgeCount >= 2 || stallEvent.type === 'self_talk') {
                            logger.error(COMPONENT, `[HardKill] Stall type "${stallEvent.type}" after ${nudgeCount} nudges — terminating`);
                            result.content = result.content || pendingAssistantContent || 'Task terminated: agent was unable to make progress using tools. Please try rephrasing your request or breaking it into smaller steps.';
                            phase = 'done';
                            break;
                        }

                        const nudge = getNudgeMessage(stallEvent);
                        logger.warn(COMPONENT, `Stall [${stallEvent.type}] (nudge ${nudgeCount + 1}/2) — nudging`);
                        ctx.messages.push({ role: 'user', content: nudge });
                        round++;
                        // Stay in think phase — retry
                        continue;
                    }

                    // No stall detected — bail out after 3 [NoTools] rounds in a row
                    // to prevent the model spinning forever returning text instead of tools
                    if (noToolsRetryCount >= 3) {
                        logger.warn(COMPONENT, `[NoTools] Bailing after ${noToolsRetryCount} consecutive no-tool rounds — accepting text response`);
                        result.content = stripToolJson(response.content || pendingAssistantContent || 'I was unable to make progress using tools.');
                        phase = 'done';
                        break;
                    }

                    // Model chose to respond directly — accept it
                    result.content = stripToolJson(response.content);
                    setCachedResponse(smartMessages, activeModel, result.content);
                    phase = 'done';
                    break;
                }

                // Tool calls were rescued — reset the no-tools counter since the model is making progress
                noToolsRetryCount = 0;
            }

            // ── Model returned tool calls → transition to ACT ────
            if (response.toolCalls && response.toolCalls.length > 0) {
                pendingToolCalls = response.toolCalls;
                pendingAssistantContent = response.content || '';
                // Add assistant message with tool calls to history
                ctx.messages.push({
                    role: 'assistant',
                    content: pendingAssistantContent,
                    toolCalls: pendingToolCalls,
                });
                phase = 'act';
            }
            break;
        }

        // ════════════════════════════���══════════════════════════════
        // ACT PHASE — Execute tool calls, record results
        // ══════════════════════════════════════���════════════════════
        case 'act': {
            logger.info(COMPONENT, `Executing ${pendingToolCalls.length} tool call(s)`);

            let toolResults: ToolResult[] = [];
            try {
                if (ctx.isKimiSwarm) {
                    for (const tc of pendingToolCalls) {
                        if (tc.function.name.startsWith('delegate_to_')) {
                            const domainMatch = tc.function.name.match(/delegate_to_(.*)_agent/);
                            const domain = (domainMatch ? domainMatch[1] : 'file') as Domain;
                            let args;
                            try { args = JSON.parse(tc.function.arguments); } catch { args = { instruction: '' }; }
                            const startMs = Date.now();
                            const resultString = await runSubAgent(domain, args.instruction, activeModel);
                            toolResults.push({
                                toolCallId: tc.id, name: tc.function.name, content: resultString,
                                success: !resultString.includes('Error'), durationMs: Date.now() - startMs,
                            });
                        }
                    }
                } else {
                    toolResults = await executeTools(pendingToolCalls, ctx.channel);
                }
            } catch (err) {
                logger.error(COMPONENT, `Tool execution error: ${(err as Error).message}`);
                result.content = 'An error occurred while executing tools. Please try again.';
                phase = 'done';
                break;
            }

            // Emit tool results to watcher
            for (const tr of toolResults) {
                ctx.streamCallbacks?.onToolResult?.(
                    tr.name, tr.content.slice(0, 500), tr.durationMs || 0,
                    !tr.content.toLowerCase().includes('error'),
                );
            }

            // Sub-agent shortcut: force immediate summary
            // Sub-agent shortcut: sync sub-agents return full results, force RESPOND.
            // Async delegations (CP enabled) return just a confirmation — no shortcut needed.
            const hasSubAgent = toolResults.some(r => r.name === 'spawn_agent');
            const isAsyncDelegation = hasSubAgent && cpEnabled;
            if (hasSubAgent && !isAsyncDelegation) {
                for (const tr of toolResults) {
                    result.toolsUsed.push(tr.name);
                    const compressed = await compressToolResult(ctx.sessionId, tr.name, tr.toolCallId, tr.content, round);
                    const subSuccess = !tr.content.toLowerCase().includes('error:');
                    recordStep(ctx.sessionId, round, tr.name, subSuccess, tr.content.slice(0, 100));
                    ctx.messages.push({ role: 'tool', content: compressed, toolCallId: tr.toolCallId, name: tr.name });
                }
                ctx.messages.push({ role: 'user', content: 'The sub-agent has completed its task. Summarize the results above and respond to the user. Do NOT call any more tools.' });
                logger.info(COMPONENT, `[SubAgent] spawn_agent completed (sync) — entering respond phase`);
                phase = 'respond';
                round++;
                break;
            }

            // Record tool results and check for loops
            let loopBroken = false;
            for (const tr of toolResults) {
                result.toolsUsed.push(tr.name);
                result.orderedToolSequence.push(tr.name);

                // Trajectory compression: shorten long tool results + record progress step
                const compressed = await compressToolResult(ctx.sessionId, tr.name, tr.toolCallId, tr.content, round);
                recordStep(ctx.sessionId, round, tr.name, !tr.content.toLowerCase().includes('error:'), tr.content.slice(0, 100));
                ctx.messages.push({ role: 'tool', content: compressed, toolCallId: tr.toolCallId, name: tr.name });

                // Stall detector
                const matchingTc = pendingToolCalls.find(tc => tc.id === tr.toolCallId);
                let tcArgs: Record<string, unknown> = {};
                try { tcArgs = JSON.parse(matchingTc?.function.arguments || '{}'); } catch { /* empty */ }

                // Soul: record this tool attempt
                recordAttempt(ctx.sessionId, `${tr.name}(${Object.keys(tcArgs).join(',')})`);

                // Record structured tool call details for inter-step context in deliberation
                const tcSuccess = !tr.content.toLowerCase().includes('error:');
                result.toolCallDetails.push({
                    name: tr.name,
                    args: tcArgs,
                    resultSnippet: tr.content.slice(0, 300),
                    success: tcSuccess,
                });

                // Tool result summarization: for large file reads, add a focused summary
                // so the model can extract key data without parsing thousands of chars
                if (tr.name === 'read_file' && tr.content.length > 500) {
                    const summary = summarizeToolResult(tr.content);
                    if (summary) {
                        ctx.messages.push({ role: 'user', content: `[File Summary] ${summary}` });
                    }
                }

                // Auto-verify file writes — catch silent truncation, empty files, broken HTML/JSON
                if (tr.name === 'write_file' || tr.name === 'append_file') {
                    const vr = verifyFileWrite(tr.name, tcArgs, tr.content);
                    if (!vr.passed) {
                        logger.warn(COMPONENT, `[AutoVerify] ${tr.name}: ${vr.issue}`);
                        ctx.messages.push({
                            role: 'user',
                            content: `[AutoVerify] ${vr.issue}${vr.suggestion ? `\n\nSuggestion: ${vr.suggestion}` : ''}`,
                        });
                    }
                }

                // Shell-for-files nudge: when the model uses shell for file operations,
                // inject a redirect toward dedicated tools
                if (tr.name === 'shell') {
                    const cmd = (tcArgs.command as string || '').trim();
                    const isFileOp = /^\s*(cat|head|tail|less|more|sed|awk)\s+/.test(cmd)
                        || /^\s*grep\s+.*\s+\S+\.\w+/.test(cmd)
                        || /^\s*curl\s+/.test(cmd);
                    if (isFileOp) {
                        shellForFilesCount++;
                        const verb = cmd.split(/\s+/)[0];
                        const nudgeMsg = shellForFilesCount >= 3
                            ? `[TOOL GUIDANCE — IMPORTANT] You have used shell for file operations ${shellForFilesCount} times. TITAN has dedicated tools that are MORE RELIABLE:\n` +
                              `- cat/head/tail → use read_file\n- sed/awk → use edit_file\n- grep → use read_file\n- curl → use web_fetch\n` +
                              `Switch to these tools NOW.`
                            : `[TOOL GUIDANCE] For file operations, use dedicated read_file/edit_file tools instead of shell ${verb}. They are more reliable.`;
                        ctx.messages.push({ role: 'user', content: nudgeMsg });
                        logger.info(COMPONENT, `[ShellNudge] Shell-for-files detected (count=${shellForFilesCount}): ${cmd.slice(0, 60)}`);
                    }
                }

                const loopEvent = recordToolCall(ctx.sessionId, tr.name, tcArgs);
                if (loopEvent) {
                    const nudge = getNudgeMessage(loopEvent);
                    logger.warn(COMPONENT, `Tool loop detected for ${tr.name} — nudging`);
                    ctx.messages.push({ role: 'user', content: nudge });
                }

                // Loop detection
                const loopConfig = ctx.isAutonomous
                    ? { globalCircuitBreakerThreshold: (ctx.config.autonomy as Record<string, unknown>).circuitBreakerOverride as number || 50 }
                    : {};
                const loopCheck = checkForLoop(ctx.sessionId, tr.name, tcArgs, tr.content, loopConfig);
                if (!loopCheck.allowed) {
                    logger.warn(COMPONENT, `Loop breaker [${loopCheck.level}]: ${loopCheck.reason}`);
                    result.content = loopCheck.reason || 'Loop detected — stopping to prevent runaway execution.';
                    loopBroken = true;
                    break;
                }

                // Fruitless search detector: if the model keeps searching for files
                // across multiple rounds without finding them, force it to respond
                if ((tr.name === 'shell' || tr.name === 'list_dir' || tr.name === 'read_file') && round >= 3) {
                    const searchTools = result.toolCallDetails.filter(d =>
                        (d.name === 'shell' && /\b(find|ls|grep|locate)\b/.test(d.args.command as string || '')) ||
                        d.name === 'list_dir'
                    );
                    if (searchTools.length >= 3) {
                        const allFailed = searchTools.every(d =>
                            d.resultSnippet.length < 50 || /not found|no such|empty|error/i.test(d.resultSnippet)
                        );
                        if (allFailed) {
                            logger.warn(COMPONENT, `[FruitlessSearch] ${searchTools.length} search attempts failed — forcing respond`);
                            ctx.messages.push({
                                role: 'user',
                                content: '[STOP SEARCHING] You have searched for this file/directory multiple times without success. It does not exist at this location. Stop searching and tell the user what you found (or that you could not find it). Do NOT run more find/ls/grep commands.',
                            });
                        }
                    }
                }

                // Learning
                const success = !tr.content.toLowerCase().includes('error:');
                recordToolResult(tr.name, success, undefined, success ? undefined : tr.content.slice(0, 200));
                recordToolUsage(tr.name);
                recordToolPreference(tr.name, classifyTaskType(ctx.message), success);

                // Auto-fix hints (skip for voice)
                if (!success && !ctx.voiceFastPath) {
                    const resolution = getErrorResolution(tr.content);
                    if (resolution) {
                        logger.info(COMPONENT, `[ActiveLearning] Known fix: ${resolution.slice(0, 80)}`);
                        ctx.messages.push({ role: 'user', content: `[Auto-fix hint] A known resolution for this error: ${resolution}. Try applying it.` });
                    }
                }

                // Error resolution tracking
                if (!ctx.voiceFastPath && success && lastFailedTool) {
                    if (tr.name !== lastFailedTool.name) {
                        recordErrorResolution(lastFailedTool.error, `Resolved by using ${tr.name} instead of ${lastFailedTool.name}`);
                    }
                    lastFailedTool = null;
                } else if (!success) {
                    lastFailedTool = { name: tr.name, error: tr.content.slice(0, 200) };
                }
            }

            if (loopBroken) { phase = 'done'; break; }

            // Progress scoring
            if (ctx.reflectionEnabled && toolResults.length > 0) {
                const anySucceeded = toolResults.some(r => !r.content.toLowerCase().includes('error:'));
                const hasNewInfo = toolResults.some(r => r.content.length > 50 && !r.content.toLowerCase().includes('not found'));
                recordProgress(anySucceeded, hasNewInfo, anySucceeded && hasNewInfo);
            }

            // Tool Search expansion
            if (ctx.toolSearchEnabled && toolResults.some(r => r.name === 'tool_search')) {
                for (const tr of toolResults) {
                    if (tr.name !== 'tool_search') continue;
                    const matches = tr.content.matchAll(/\*\*(\w+)\*\*/g);
                    for (const match of matches) {
                        const toolName = match[1];
                        if (!discoveredTools.has(toolName)) {
                            discoveredTools.add(toolName);
                            const fullDef = ctx.allToolsBackup.find(t => t.function.name === toolName);
                            if (fullDef && !ctx.activeTools.some(t => t.function.name === toolName)) {
                                ctx.activeTools.push(fullDef);
                            }
                        }
                    }
                }
                if (discoveredTools.size > 0) {
                    logger.info(COMPONENT, `[ToolSearch] Expanded: +${discoveredTools.size} tools -> ${ctx.activeTools.length} total`);
                }
            }

            // ── Phase transition decision ────────────────────────
            round++;

            // Soul: update state and emit heartbeat
            updateSoulState(ctx.sessionId, {
                round,
                confidence: result.toolsUsed.length > 0 ? 'medium' : 'low',
            });
            emitHeartbeat(ctx.sessionId, phase, 0);

            // Inner monologue injection (every 3 rounds to avoid prompt bloat)
            if (round > 0 && round % 3 === 0) {
                const monologue = getInnerMonologue(ctx.sessionId);
                if (monologue) {
                    ctx.messages.push({ role: 'user', content: monologue });
                }
            }

            // Checkpoint after each round for crash recovery
            saveCheckpoint({
                sessionId: ctx.sessionId,
                round,
                phase,
                model: activeModel,
                messages: ctx.messages,
                toolsUsed: result.toolsUsed,
                orderedToolSequence: result.orderedToolSequence,
                timestamp: new Date().toISOString(),
                message: ctx.message.slice(0, 500),
                channel: ctx.channel,
                totalPromptTokens: result.promptTokens,
                totalCompletionTokens: result.completionTokens,
            });

            // Inject running progress summary every N rounds (helper self-gates)
            const progressMsg = getProgressSummary(ctx.sessionId, round);
            if (progressMsg) {
                logger.info(COMPONENT, `[Progress] Round ${round}`);
                ctx.messages.push({ role: 'user', content: progressMsg });
            }

            if (round >= ctx.effectiveMaxRounds) {
                // Budget exhausted
                result.content = stripToolJson(pendingAssistantContent || 'I completed the tool operations. Let me know if you need anything else.');
                result.budgetExhausted = true;
                phase = 'done';
            } else if (ctx.isAutonomous) {
                // Smart exit: only skip to respond if a single TERMINAL tool succeeded.
                // Terminal tools are ones that produce a final artifact (write, append)
                // or answer a direct question (weather, system_info).
                // Information-gathering tools (read_file, list_dir, web_search, shell)
                // are NOT terminal — they almost always need a follow-up action.
                // The old list included read_file/shell/web_search which caused the model
                // to bail after one read without ever writing anything.
                const terminalTools = new Set(['write_file', 'append_file', 'weather', 'system_info', 'memory']);
                const singleToolSuccess = pendingToolCalls.length === 1
                    && toolResults.every(r => r.success)
                    && terminalTools.has(pendingToolCalls[0].function.name);
                if (singleToolSuccess && round >= 2 && ctx.smartExitEnabled !== false) {
                    logger.info(COMPONENT, '[SmartExit] Terminal tool succeeded — skipping to respond phase');
                    phase = 'respond';
                } else {
                    // Autonomous mode: go back for more tool rounds
                    phase = 'think';
                }
            } else {
                // Non-autonomous: force text-only response
                phase = 'respond';
                logger.info(COMPONENT, `[ThinkAct] Tools executed — entering respond phase (tools will be stripped)`);
            }
            break;
        }

        // ══════════════════════════��══════════════════════════��═════
        // RESPOND PHASE — Call LLM WITHOUT tools (forces text response)
        // ═══════════════════════════════════════════════════════════
        case 'respond': {
            // Incomplete task guard: if the user asked to edit/fix/write but the
            // model only read files and never wrote, nudge it back to think phase
            const askedToWrite = /\b(edit|fix|change|modify|update|add|write|create|improve|rewrite|save)\b/i.test(ctx.message);
            const didWrite = result.toolsUsed.some(t => ['write_file', 'edit_file', 'append_file'].includes(t));
            const didRead = result.toolsUsed.includes('read_file') || result.toolsUsed.includes('shell');
            if (askedToWrite && !didWrite && didRead && round < ctx.effectiveMaxRounds - 1 && !responseValidationRetried) {
                logger.warn(COMPONENT, `[IncompleteTask] User asked to edit but no write tool called after ${round} rounds — forcing back to think`);
                ctx.messages.push({
                    role: 'user',
                    content: '[INCOMPLETE] You read the file but did NOT make any changes. The user asked you to edit/fix/modify it. You MUST call edit_file or write_file NOW to apply your changes. Do NOT describe what you would change — MAKE the changes.',
                });
                responseValidationRetried = true; // Only do this once
                phase = 'think';
                break;
            }

            logger.info(COMPONENT, `Respond phase — calling LLM without tools to generate final answer`);

            // Context compression for respond phase
            let smartMessages: ChatMessage[];
            if (ctx.voiceFastPath) {
                smartMessages = ctx.messages as ChatMessage[];
            } else {
                const { messages: compressedMessages, didCompress, savedTokens } = maybeCompressContext(ctx.messages);
                if (didCompress) {
                    logger.info(COMPONENT, `Context compressed, saved ~${savedTokens} tokens`);
                    ctx.messages.length = 0;
                    ctx.messages.push(...compressedMessages);
                }
                smartMessages = (compressedMessages as ChatMessage[]).length <= 4
                    ? compressedMessages as ChatMessage[]
                    : buildSmartContext(compressedMessages as ChatMessage[], tokenBudget);
            }

            const thinkingMode = ctx.thinkingOverride || ctx.config.agent.thinkingMode || 'off';
            const chatOptions = {
                model: activeModel,
                messages: smartMessages,
                tools: undefined,  // NO TOOLS — forces text-only response
                maxTokens: ctx.voiceFastPath ? Math.min(ctx.config.agent.maxTokens, 300) : ctx.config.agent.maxTokens,
                temperature: ctx.config.agent.temperature,
                thinking: ctx.voiceFastPath ? false : thinkingMode !== 'off',
                thinkingLevel: thinkingMode as 'off' | 'low' | 'medium' | 'high',
            };

            let response: ChatResponse;
            if (ctx.streamCallbacks?.onToken) {
                let streamContent = '';
                for await (const chunk of chatStream(chatOptions)) {
                    if (chunk.type === 'text' && chunk.content) {
                        streamContent += chunk.content;
                        ctx.streamCallbacks.onToken(chunk.content);
                    } else if (chunk.type === 'error') {
                        logger.error(COMPONENT, `Stream error: ${chunk.error}`);
                    }
                }
                response = {
                    id: `stream-${Date.now()}`,
                    content: streamContent,
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                    finishReason: 'stop',
                    model: activeModel,
                };
            } else {
                response = await chat(chatOptions);
            }

            result.modelUsed = response.model;
            result.promptTokens += response.usage?.promptTokens || 0;
            result.completionTokens += response.usage?.completionTokens || 0;

            const costCheck = recordTokenUsage(ctx.sessionId, activeModel, response.usage?.promptTokens || 0, response.usage?.completionTokens || 0);
            if (costCheck.budgetExceeded) {
                result.content = '⚠️ Daily spending limit reached. TITAN has paused to keep your API costs under control.';
            } else {
                result.content = stripToolJson(response.content);
            }

            // Empty response fallback: if the model returned nothing in respond phase,
            // synthesize from the last tool results instead of showing a blank message
            if (!result.content || result.content.trim().length === 0) {
                const lastToolResults = ctx.messages
                    .filter(m => m.role === 'tool')
                    .slice(-2)
                    .map(m => (m.content || '').slice(0, 300))
                    .join('\n');
                if (lastToolResults) {
                    logger.warn(COMPONENT, '[EmptyResponse] Model returned empty — using tool results as fallback');
                    result.content = lastToolResults;
                } else {
                    result.content = 'I completed the task but was unable to generate a summary. Please check the tool results above.';
                }
            }

            // Response validation: check if the answer actually addresses the question.
            // If the user asked for specific data (a number, version, name) and the
            // response doesn't contain it but tool results do, retry once with a nudge.
            if (!responseValidationRetried && result.content && result.toolsUsed.length > 0) {
                const gap = detectResponseGap(ctx.message, result.content, ctx.messages);
                if (gap) {
                    logger.info(COMPONENT, `[ResponseValidation] Gap detected: ${gap}. Retrying respond phase.`);
                    ctx.messages.push({
                        role: 'user',
                        content: `[IMPORTANT] Your response did not include the specific information the user asked for. ${gap} Look at your tool results above and include the actual data in your answer. Be direct and specific.`,
                    });
                    responseValidationRetried = true;
                    // Stay in respond phase for one more try
                    break;
                }
            }

            phase = 'done';
            break;
        }
        } // end switch
    } // end while

    // If loop ended without setting content (hit round limit in think phase)
    if (!result.content && round >= ctx.effectiveMaxRounds) {
        result.content = 'I reached the maximum number of tool rounds without a complete answer. Please try again with a more specific request.';
        result.budgetExhausted = true;
    }

    return result;
}

// ── Heartbeat-driven inbox processing ───────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function checkAndProcessInbox(agentId: string): Promise<void> {
    const inbox = getAgentInbox(agentId);
    if (inbox.length === 0) return;

    // Take the first queued request
    const req = inbox[0];
    const claimed = claimWakeupRequest(req.id);
    if (!claimed) return;

    // Transition CP issue to in_progress
    updateIssue(req.issueId, { status: 'in_progress' });
    const run = startRun(agentId, 'assignment', req.issueId);

    logger.info(COMPONENT, `[Heartbeat] Processing wakeup ${req.id} for agent "${req.agentName}"`);

    try {
        const template = SUB_AGENT_TEMPLATES[req.templateName] || {};
        const config = loadConfig();
        const modelAliases = (config.agent as Record<string, unknown> | undefined)?.modelAliases as Record<string, string> | undefined;
        const tier = (template as Record<string, unknown>).tier as string | undefined;
        let model = req.model;
        if (!model && modelAliases && tier) {
            model = modelAliases[tier] || modelAliases.fast;
        }

        const result = await spawnSubAgent({
            name: req.agentName,
            task: req.task,
            tools: template.tools,
            systemPrompt: template.systemPrompt,
            model,
            depth: 0,
        });

        // Complete the CP run
        endRun(run.id, {
            status: result.success ? 'succeeded' : 'failed',
            toolsUsed: result.toolsUsed,
        });

        // Post result as CP issue comment
        const commentBody = [
            `**Sub-agent result** (${result.rounds} rounds, ${result.durationMs}ms)`,
            `Status: ${result.success ? 'SUCCESS' : 'FAILED'}${result.validated ? '' : ' [UNVALIDATED]'}`,
            `Tools: ${result.toolsUsed.join(', ') || 'none'}`,
            '',
            result.content,
        ].join('\n');
        addIssueComment(req.issueId, commentBody, { agentId });
        updateIssue(req.issueId, { status: result.success ? 'done' : 'todo' });

        logger.info(COMPONENT, `[Heartbeat] Wakeup ${req.id} completed — ${result.success ? 'SUCCESS' : 'FAILED'}`);
    } catch (err) {
        const error = (err as Error).message;
        endRun(run.id, { status: 'error', error });
        addIssueComment(req.issueId, `**Sub-agent failed**: ${error}`, { agentId });
        updateIssue(req.issueId, { status: 'todo' });
        logger.error(COMPONENT, `[Heartbeat] Wakeup ${req.id} failed: ${error}`);
    }
}
