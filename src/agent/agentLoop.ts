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
import { recordTokenUsage, routeModel, type TurnContext } from './costOptimizer.js';
import { maybeCompressContext } from './costOptimizer.js';
import type { TitanConfig } from '../config/schema.js';
import { buildSmartContext } from './contextManager.js';
import { getCachedResponse, setCachedResponse } from './responseCache.js';
import { shouldReflect, reflect, resetProgress, recordProgress, setProgressSession } from './reflection.js';
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

/**
 * Validate tool call / tool result pairing (LangGraph pattern).
 * Every assistant message with toolCalls must have a matching tool result for each call.
 * Orphaned pairs cause API rejections from all providers.
 *
 * Hunt Finding #14 (2026-04-14): previously this function DROPPED assistant
 * messages with orphaned tool calls, destroying the model's work history and
 * causing it to redo tool calls or get confused about its state. The 5-phase
 * context compressor can legitimately drop tool RESULT messages while keeping
 * the assistant tool_call messages (or vice versa), creating orphans.
 *
 * New behavior: when an orphaned tool_call is detected, SYNTHESIZE a placeholder
 * tool result message with `[Earlier tool result cleared]` content. This keeps
 * the conversation shape valid for providers AND preserves the model's history.
 * The model still sees that the tool was called and knows not to call it again.
 */
function validateToolPairs(messages: ChatMessage[]): ChatMessage[] {
    const toolResultIds = new Set(
        messages.filter(m => m.role === 'tool' && m.toolCallId).map(m => m.toolCallId)
    );
    const out: ChatMessage[] = [];
    for (const m of messages) {
        out.push(m);
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            const orphaned = m.toolCalls.filter(tc => !toolResultIds.has(tc.id));
            if (orphaned.length > 0) {
                logger.warn(COMPONENT, `[ToolPairValidation] Synthesizing ${orphaned.length} missing tool result(s) for orphaned tool call(s): ${orphaned.map(tc => tc.function.name).join(', ')}`);
                // Insert a synthetic tool result immediately after the assistant message.
                // This preserves the model's work history while keeping the pairing valid.
                for (const tc of orphaned) {
                    out.push({
                        role: 'tool',
                        // v4.10.0-local: MUST include `name` — Gemini's
                        // Ollama-compat adapter maps it to
                        // `function_response.name`, which it rejects
                        // when empty. Fix for recurring HTTP 400s
                        // "Name cannot be empty" on gemini-3-flash-preview:cloud.
                        name: tc.function.name,
                        content: `[Earlier tool result cleared — ${tc.function.name} was called previously but its result was pruned from context.]`,
                        toolCallId: tc.id,
                    });
                    toolResultIds.add(tc.id);
                }
            }
        }
    }
    return out;
}

/**
 * Hunt Finding #09 (2026-04-14): pair-aware context trim.
 *
 * Previously the agent loop trimmed with `.slice(-8)` on non-system messages,
 * which cut right through tool_call/tool_result pairs. Then validateToolPairs
 * dropped the assistant-with-orphan-toolcall messages, losing the work history.
 * The model would see no prior tool calls and redo them, causing ping-pong loops.
 *
 * This trim walks backwards and keeps tool_call+tool_result PAIRS together. When
 * we hit a tool_result, we also keep its parent assistant-with-tool_calls message.
 * When we hit an assistant-with-tool_calls, we also keep ALL its tool_results.
 */
function trimPairAware(messages: ChatMessage[], maxTotal: number): ChatMessage[] {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const maxNonSystem = Math.max(1, maxTotal - systemMsgs.length);

    if (nonSystem.length <= maxNonSystem) return messages;

    // Walk backwards, keeping pairs together. Tool result messages belong to the
    // nearest preceding assistant message with tool_calls; assistant messages with
    // tool_calls own all immediately-following tool result messages.
    const kept: ChatMessage[] = [];
    let i = nonSystem.length - 1;

    // First pass: collect indices to keep, preserving pair integrity
    const keepIdx = new Set<number>();
    while (i >= 0 && keepIdx.size < maxNonSystem) {
        const msg = nonSystem[i];
        if (msg.role === 'tool' && msg.toolCallId) {
            // Find its parent assistant message
            let parentIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
                const cand = nonSystem[j];
                if (cand.role === 'assistant' && cand.toolCalls?.some(tc => tc.id === msg.toolCallId)) {
                    parentIdx = j;
                    break;
                }
                if (cand.role !== 'tool') break; // only walk through tool siblings
            }
            keepIdx.add(i);
            if (parentIdx >= 0) {
                keepIdx.add(parentIdx);
                // Also keep any sibling tool results for the same assistant
                for (let j = parentIdx + 1; j < nonSystem.length; j++) {
                    const sib = nonSystem[j];
                    if (sib.role !== 'tool') break;
                    keepIdx.add(j);
                }
            }
            i = parentIdx >= 0 ? parentIdx - 1 : i - 1;
        } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
            // Keep this assistant + all its tool results
            keepIdx.add(i);
            for (let j = i + 1; j < nonSystem.length; j++) {
                const sib = nonSystem[j];
                if (sib.role !== 'tool') break;
                keepIdx.add(j);
            }
            i--;
        } else {
            keepIdx.add(i);
            i--;
        }
    }

    // Emit in original order
    for (let k = 0; k < nonSystem.length; k++) {
        if (keepIdx.has(k)) kept.push(nonSystem[k]);
    }

    return [...systemMsgs, ...kept];
}

/** Sanitize reflection reasoning before injecting into message stream */
function sanitizeReflection(text: string): string {
    return text
        .slice(0, 200)
        .replace(/\[SYSTEM\].*$/gm, '')
        .replace(/^(You are|IMPORTANT:|CRITICAL:|IGNORE).*$/gim, '')
        .trim() || 'approach not working';
}

/**
 * Hunt Finding #05 (2026-04-14): detect explicit tool-use intent in the user message.
 *
 * Symptom: User says "use the shell tool to run uptime" but the model returns
 * plausible but FABRICATED output (hallucinated uptime text) without actually
 * calling the shell tool. The text looks like real tool output but isn't.
 *
 * Previously `forceToolUse` only fired in autonomous mode. Regular API calls
 * let the model ignore tools, so any model with weak tool calling could
 * hallucinate output.
 *
 * Fix: if the user message explicitly requests a tool, we force
 * `tool_choice: required` on the first call, even in non-autonomous mode.
 * This doesn't eliminate hallucination entirely but stops the most common
 * pattern where the model chooses to not call a tool at all.
 */
export function detectToolUseIntent(userMessage: string): boolean {
    if (!userMessage || userMessage.length < 5) return false;
    const msg = userMessage.toLowerCase();

    const intentPatterns = [
        // Explicit "use the X tool" or "use X tool"
        /\buse (?:the )?(\w+) tool\b/,
        /\buse (?:the )?(shell|web_search|web_fetch|read_file|write_file|edit_file|list_dir|memory|weather|fb_post|fb_reply|fb_read_feed|github|email|calendar)\b/,
        // "run X" / "execute X" / "call X"
        /\brun (?:the )?(?:shell|command|tool|script)\b/,
        /\bexecute (?:the )?(?:shell|command|tool|script|this)\b/,
        /\bcall (?:the )?(?:\w+ )?tool\b/,
        /\binvoke (?:the )?(\w+)\b/,
        // Action verbs that require tool execution
        /\b(?:search the web|search for|web search)\b/,
        /\bfetch (?:the )?(url|page|content|https?:)/,
        /\bread (?:the )?(?:file|contents? of|lines from)\b/,
        /\bwrite (?:this |the )?(?:to (?:the )?file|file)\b/,
        /\blist (?:the )?(?:files?|contents?) (?:in|of|at)\b/,
        // Requests to check real system state that REQUIRES a tool
        /\b(?:what is|what's|show me|get) (?:the )?(?:current|actual) (?:uptime|hostname|ip|path|directory|pwd|time|date|memory|disk)\b/,
        // Hunt Finding #17 (2026-04-14): added `[\s:]+` so "run: ls" matches too.
        /\brun[\s:]+['"`]?(?:echo|ls|pwd|uptime|whoami|date|uname|cat|grep|find|node|npm|git|which|ps|df|free)\b/,
    ];

    return intentPatterns.some(p => p.test(msg));
}

/**
 * Hunt Finding #17 (2026-04-14): Extract a tool call from the USER MESSAGE directly.
 *
 * Runs as a last-resort rescue path in the NoTools handler. Triggered when the model
 * ignored `tool_choice=required` and all model-response-based rescue paths failed.
 *
 * The key insight: when the user's request explicitly names a command or file, we
 * don't need the model's cooperation to figure out what tool to call — we can parse
 * the intent from the user message itself.
 *
 * This defends against weak models (like minimax-m2.7:cloud) that fabricate
 * plausible-sounding tool output ("Permission denied", "command returned null",
 * "Node.js is not installed") instead of actually calling the tool.
 *
 * Returns a synthetic tool call or null if no clear intent can be extracted.
 */
export function extractToolCallFromUserMessage(
    userMessage: string,
    activeTools: ToolDefinition[],
): ToolCall | null {
    if (!userMessage || userMessage.length < 5) return null;
    const msg = userMessage.trim();
    const lower = msg.toLowerCase();
    const availableNames = new Set(activeTools.map(t => t.function.name));
    const mkCall = (name: string, args: Record<string, unknown>): ToolCall => ({
        id: `uir-${Date.now()}`,
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args) },
    });

    // Shell: "run X", "run: X", "execute X", "please run X", "can you run X"
    // X starts with a known shell command.
    if (availableNames.has('shell')) {
        const shellMatch = msg.match(
            /(?:please\s+)?(?:can you\s+)?(?:run|execute)[\s:]+[`'"]?((?:ls|cat|grep|find|echo|pwd|uname|node|npm|git|which|ps|df|free|uptime|whoami|date|hostname|ip|head|tail|wc|sort|uniq|awk|sed|curl|wget|ping|du|stat|file|env|printenv|history)\s[^\n`'"]*?)[`'"]?(?:\s+and|\s+then|\.|\?|\s*$)/i,
        );
        if (shellMatch && shellMatch[1]) {
            return mkCall('shell', { command: shellMatch[1].trim() });
        }
        // Bare "run: ls /path" without other clauses
        const bareMatch = msg.match(
            /^(?:please\s+)?(?:run|execute)[\s:]+[`'"]?((?:ls|cat|grep|find|echo|pwd|uname|node|npm|git|which|ps|df|free|uptime|whoami|date|hostname)\s[^\n`'"]+?)[`'"]?\s*$/i,
        );
        if (bareMatch && bareMatch[1]) {
            return mkCall('shell', { command: bareMatch[1].trim() });
        }
    }

    // read_file: "read the file X", "read /path/to/file", "show me the contents of X"
    if (availableNames.has('read_file')) {
        const readMatch = msg.match(
            /(?:read|open|show me|display|view)\s+(?:the\s+)?(?:file\s+|contents of\s+)?[`'"]?(\/[a-zA-Z0-9/._-]+)[`'"]?/i,
        );
        if (readMatch && readMatch[1]) {
            return mkCall('read_file', { path: readMatch[1] });
        }
    }

    // list_dir: "list files in X", "list X", "what's in X"
    if (availableNames.has('list_dir')) {
        const listMatch = msg.match(
            /(?:list|show)\s+(?:the\s+)?(?:files?|contents?|directory)\s+(?:in|of|at)\s+[`'"]?(\/[a-zA-Z0-9/._-]+)[`'"]?/i,
        );
        if (listMatch && listMatch[1]) {
            return mkCall('list_dir', { path: listMatch[1] });
        }
    }

    // web_search: "search the web for X", "google X", "search for X"
    if (availableNames.has('web_search')) {
        const searchMatch = msg.match(/(?:search\s+(?:the\s+)?web\s+for|google|web\s+search\s+for|search\s+for)\s+(.+?)(?:\.|\?|$)/i);
        if (searchMatch && searchMatch[1]) {
            return mkCall('web_search', { query: searchMatch[1].trim() });
        }
    }

    // web_fetch: "fetch https://...", "open URL https://..."
    if (availableNames.has('web_fetch')) {
        const fetchMatch = msg.match(/(?:fetch|open|load|get)\s+(https?:\/\/[^\s]+)/i);
        if (fetchMatch && fetchMatch[1]) {
            return mkCall('web_fetch', { url: fetchMatch[1] });
        }
    }

    // weather: "weather for X", "what's the weather in X"
    if (availableNames.has('weather')) {
        const weatherMatch = lower.match(/weather\s+(?:for|in|at)\s+([a-zA-Z][a-zA-Z\s,]+?)(?:\.|\?|$)/i);
        if (weatherMatch && weatherMatch[1]) {
            return mkCall('weather', { location: weatherMatch[1].trim() });
        }
    }

    return null;
}

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
    /** Pipeline-specific terminal tools for SmartExit */
    pipelineTerminalTools?: string[];
    /** Pipeline-specific completion detection strategy */
    completionStrategy?: 'smart-exit' | 'no-tools' | 'terminal-tool' | 'single-round';
    /** Pipeline type for logging */
    pipelineType?: string;
    /** Minimum rounds before allowing SmartExit (pipeline-enforced) */
    minRounds?: number;
    /** F1: Pre-model hook (LangGraph pattern) — modify messages for LLM without changing
     *  persisted history. Use for RAG injection, summarization, dynamic token budgeting.
     *  Receives a COPY of messages; return modified copy for the LLM call. */
    beforeModelCall?: (messages: ChatMessage[], round: number) => ChatMessage[];
    /** Provider-specific opt-ins forwarded to ChatOptions.providerOptions. */
    providerOptions?: Record<string, unknown>;
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

/**
 * Hunt Finding #38b (2026-04-15): strip narrator preamble from chat
 * responses. Weak models (minimax-m2.7:cloud, glm-5.1) love to prefix
 * their answer with internal monologue like:
 *   "The user wants a joke. I can respond directly without needing any
 *    tools. Why don't scientists trust atoms? Because they make up
 *    everything."
 *
 * We can't prevent this reliably via a system directive because the
 * model ignores it 30-50% of the time. Instead, we detect and strip
 * the preamble server-side after the model has finished generating,
 * keeping only the actual answer.
 *
 * Strategy: the preamble is a sequence of sentences that start with
 * narrator openers ("The user wants", "I can/should/will respond",
 * "Let me", "Actually", "Looking at", "I'll"). We strip those
 * sentences off the front until we hit content that doesn't start
 * with a narrator opener. That's the real answer.
 */
export function stripNarratorPreamble(text: string): string {
    if (!text || text.length < 10) return text;
    const NARRATOR_OPENERS = [
        /^\s*the user (?:wants|asked|said|is asking|is requesting|needs|wrote|mentioned|told me)/i,
        /^\s*(?:the\s+)?user (?:wants|asked|said|is asking)/i,
        /^\s*I (?:should|need to|can|will|must|could|'ll|'m going to) (?:respond|reply|answer|provide|give|explain|tell|just|simply)/i,
        /^\s*I['']m (?:going to|about to) (?:respond|reply|answer)/i,
        /^\s*(?:let me|let's)\b/i,
        /^\s*(?:actually|okay|alright|hmm|well|so|right),?\s+(?:I|let|the)/i,
        /^\s*looking at (?:this|the|what)/i,
        /^\s*(?:this is|that['']s) (?:a|an) (?:casual|simple|direct|basic|friendly|quick)/i,
        /^\s*no tools? (?:needed|required)/i,
        /^\s*(?:i can|i['']ll) (?:respond|reply|answer) (?:directly|simply|without|naturally)/i,
    ];

    // Split into sentences, attempt to strip leading narrator sentences.
    // Use a conservative split that respects common sentence terminators.
    const sentences: string[] = [];
    let buffer = '';
    for (let i = 0; i < text.length; i++) {
        buffer += text[i];
        if (/[.!?]/.test(text[i])) {
            // Lookahead for end of sentence — next char should be whitespace or newline
            const next = text[i + 1];
            if (!next || /\s/.test(next)) {
                sentences.push(buffer);
                buffer = '';
            }
        }
    }
    if (buffer) sentences.push(buffer);

    let stripCount = 0;
    for (const sentence of sentences) {
        if (NARRATOR_OPENERS.some(p => p.test(sentence))) {
            stripCount++;
        } else {
            break;
        }
    }

    if (stripCount === 0) return text;
    // Limit: never strip more than 75% of the content, or 3 sentences.
    // If the whole thing looks like narrator, leave it for the sanitizer
    // to catch as a hard fail (the sanitizer will fallback to a safe msg).
    if (stripCount >= sentences.length || stripCount > 3) return text;
    const remaining = sentences.slice(stripCount).join('').trim();
    if (remaining.length < 5) return text;
    return remaining;
}

// ── Helper: strip leaked tool JSON from LLM responses ────────────────

function stripToolJson(text: string): string {
    let cleaned = text.replace(/\s*\{"(?:name|tool_call)":\s*"[^"]+",\s*"(?:parameters|arguments)":\s*\{[^}]*\}\s*\}\s*/g, '').trim();
    // Hunt Finding #21 (2026-04-14): also strip minimax:tool_call XML blocks
    // and bare <invoke>/<parameter> tags that models sometimes emit as text
    // when they want to call a tool but shouldn't (e.g., in the respond phase
    // which runs with tools: undefined). Without this, the raw XML reaches
    // result.content, which bypasses the empty-response retry and forces the
    // gateway-level sanitizer to strip + fallback, losing task confirmation.
    cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
    cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*$/g, '').trim(); // unclosed
    cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*?<\/invoke>/g, '').trim();
    cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*$/g, '').trim(); // unclosed
    cleaned = cleaned.replace(/<parameter\s+name=["'][^"']*["']>[\s\S]*?<\/parameter>/g, '').trim();
    cleaned = cleaned.replace(/<\/?(?:invoke|parameter|minimax:tool_call)[^>]*>/g, '').trim();
    return cleaned;
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

    // Strategy 2: Natural language tool mentions
    // Cloud models often describe tool calls in text → empty skipSet to rescue all tools.
    // Local models handle structured tool calls fine → skip common tools to avoid false rescues.
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
        if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
            const pathMatch = content.match(/(?:file|path)[=:\s]+["']?((?:\/|~\/|\.\/)\S+?)["'\s,)]/i)
                || content.match(/((?:\/|~\/)\S+\.\w{1,10})/);
            if (pathMatch) {
                if (toolName === 'write_file') {
                    // Try to extract content to write from code blocks
                    const codeBlock = content.match(/```[\w]*\n([\s\S]*?)```/);
                    const writeContent = codeBlock ? codeBlock[1] : '';
                    return { id: `rescue_${Date.now()}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: pathMatch[1], content: writeContent }) } };
                } else if (toolName === 'edit_file') {
                    // edit_file needs target+replacement — rescue as read_file first so the agent can see the file
                    return { id: `rescue_${Date.now()}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: pathMatch[1] }) } };
                } else {
                    return { id: `rescue_${Date.now()}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: pathMatch[1] }) } };
                }
            }
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
    setProgressSession(ctx.sessionId);
    resetProgress(ctx.sessionId);

    // Learning state
    let lastFailedTool: { name: string; error: string } | null = null;

    // Tool search state
    const discoveredTools = new Set<string>();

    // Shell-for-files nudge counter
    let shellForFilesCount = 0;

    // Response validation retry flag (one retry max)
    let responseValidationRetried = false;
    // Empty response retry flag (one retry max)
    let emptyResponseRetried = false;

    // Force tool_choice=required on next think phase (set by incomplete task guard)
    let forceWriteOnNextThink = false;

    // F5: Budget soft warning — only inject once per loop
    let budgetWarningSent = false;

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
                        ctx.messages.push({ role: 'user', content: `You've reflected on your progress and decided you have enough information. Respond to the user now with your findings. Reasoning: ${sanitizeReflection(reflectionResult.reasoning)}` });
                        phase = 'respond';
                        continue;
                    } else if (reflectionResult.decision === 'pivot' && pivotCount < MAX_PIVOTS) {
                        pivotCount++;
                        const toolsSummary = [...new Set(result.toolsUsed)].join(', ');
                        const approachSummary = `Attempted tools: ${toolsSummary}. Result: ${sanitizeReflection(reflectionResult.reasoning)}`;
                        failedApproaches.push(approachSummary);
                        logger.info(COMPONENT, `PIVOT at round ${round + 1}: ${reflectionResult.reasoning}`);

                        // Clear accumulated tool results but keep system prompt + original message
                        const systemMsg = ctx.messages.find(m => m.role === 'system');
                        const userMsg = ctx.messages.find(m => m.role === 'user' && !m.content.startsWith('['));
                        ctx.messages.length = 0;
                        if (systemMsg) ctx.messages.push(systemMsg);
                        if (userMsg) ctx.messages.push(userMsg);
                        ctx.messages.push({ role: 'user', content: `Warning: STRATEGIC PIVOT: Your previous approach failed.\nWhat was tried: ${approachSummary}\nWhy it failed: ${sanitizeReflection(reflectionResult.reasoning)}\n\nTry a COMPLETELY DIFFERENT strategy. Do NOT repeat the same tools or approach.` });

                        resetProgress();
                        result.toolsUsed.length = 0;
                        result.orderedToolSequence.length = 0;
                    } else if (reflectionResult.decision === 'pivot' && pivotCount >= MAX_PIVOTS) {
                        // Pivot limit reached — inject guidance instead of silently ignoring
                        logger.warn(COMPONENT, `Pivot limit reached (${MAX_PIVOTS}), injecting adjustment instead`);
                        ctx.messages.push({ role: 'user', content: `Your approach isn't working but you've already pivoted ${MAX_PIVOTS} time(s). Instead of starting over, try a SMALL adjustment: ${sanitizeReflection(reflectionResult.reasoning)}. Focus on what's most likely to succeed with the tools you have.` });
                    } else if (reflectionResult.decision === 'adjust') {
                        ctx.messages.push({ role: 'user', content: `Reflection suggests adjusting approach: ${sanitizeReflection(reflectionResult.reasoning)}. Try a different strategy.` });
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
                // Hunt Finding #14 (2026-04-14): previously this filter dropped ALL tool
                // messages on round 3+, leaving their parent assistant-with-tool_calls
                // messages orphaned. validateToolPairs would then either synthesize
                // placeholders (history preserved but content lost) or drop assistants
                // (history destroyed). Either way, the model lost data and made bad
                // decisions (e.g., writing empty files).
                //
                // Fix: pass ALL messages through. trimPairAware + pruneToolOutputs in the
                // compressor already handle context size, and they do it atomically
                // (keeping pairs together) so no orphans are created.
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

            // ── Response cache check ─────────────────────────────
            const cachedResponse = getCachedResponse(smartMessages, activeModel);
            if (cachedResponse) {
                logger.info(COMPONENT, `Cache hit — skipping LLM call`);
                result.content = cachedResponse;
                phase = 'done';
                break;
            }

            // ── Per-turn model routing ───────────────────────────
            const lastUserContent = ctx.message || '';
            const recentAssistant = smartMessages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
            const turnCtx: TurnContext = {
                round,
                messageLength: lastUserContent.length,
                hasCode: /```|\bfunction\b|\bclass\b|\bconst\b|\bdef\b/.test(recentAssistant),
                hasUrls: /https?:\/\//.test(recentAssistant),
            };
            const routeResult = routeModel(lastUserContent, activeModel, undefined, turnCtx);
            if (routeResult.model !== activeModel && routeResult.willSaveMoney) {
                logger.info(COMPONENT, `[PerTurnRoute] Round ${round}: ${activeModel} → ${routeResult.model} (${routeResult.reason})`);
                activeModel = routeResult.model;
            }

            // ── Call LLM with tools ──────────────────────────────
            const thinkingMode = ctx.thinkingOverride || ctx.config.agent.thinkingMode || 'off';
            const isVoice = ctx.voiceFastPath;
            // Claude Code-style context management:
            // 1. Clear old tool results (keep last 5 in full, truncate older ones)
            // 2. Trim to recent messages if context is getting large
            if (smartMessages.length > 6) {
                // Collapse deliberation messages to prevent plan markdown from polluting context
                for (let i = smartMessages.length - 1; i >= 0; i--) {
                    const msg = smartMessages[i];
                    if (msg.role === 'assistant' && msg.content?.startsWith('[DELIBERATION]')) {
                        smartMessages[i] = { ...msg, content: '[Prior deliberation plan — details omitted for brevity]' };
                        continue; // don't count as tool result
                    }
                }
                let toolResultCount = 0;
                for (let i = smartMessages.length - 1; i >= 0; i--) {
                    const msg = smartMessages[i];
                    if (msg.role === 'tool' || (msg.role === 'assistant' && msg.toolCalls)) {
                        toolResultCount++;
                        if (toolResultCount > 5 && msg.content) {
                            // Truncate ALL old tool results outside keep-5 window (regardless of length)
                            smartMessages[i] = { ...msg, content: '[Earlier tool result cleared — ' + msg.content.slice(0, 80) + '...]' };
                        }
                    }
                }
            }

            // Hard trim if too many messages — Hunt Finding #09: pair-aware trim
            // preserves tool_call/tool_result pairs so validateToolPairs doesn't
            // then drop assistant messages with orphaned tool calls.
            if (smartMessages.length > 12 && phase !== 'respond') {
                const before = smartMessages.length;
                smartMessages = trimPairAware(smartMessages, 12);
                // A11: Sanitize any remaining orphans (safety net, should be zero)
                smartMessages = validateToolPairs(smartMessages);
                if (smartMessages.length !== before) {
                    logger.info(COMPONENT, `[ContextTrim] Pair-aware trim: ${before} → ${smartMessages.length} messages`);
                }
            }

            // A1: Validate tool call/result pairing before sending to LLM (LangGraph pattern)
            smartMessages = validateToolPairs(smartMessages);

            // F1: Pre-model hook — let plugins modify messages for LLM without changing ctx.messages
            if (ctx.beforeModelCall) {
                try {
                    smartMessages = ctx.beforeModelCall([...smartMessages], round);
                } catch (e) {
                    logger.warn(COMPONENT, `[PreModelHook] Hook threw: ${(e as Error).message} — using unmodified messages`);
                }
            }

            // Hunt Finding #38 (2026-04-15): for chat-pipeline messages that
            // complete in a single think-phase round, the respond-phase
            // directive (Finding #21) never fires — the model's raw think
            // output goes directly to the user (streaming, so the tokens are
            // already on screen) and the sanitizer catches narrator leaks at
            // the END by which point it's too late. Inject the directive
            // into the context BEFORE the first think call for chat pipelines
            // so the model's FIRST token is already post-directive.
            if (round === 0 && phase === 'think' && ctx.completionStrategy === 'single-round') {
                smartMessages = [
                    ...smartMessages,
                    {
                        role: 'user' as const,
                        content: '[System directive for this reply only] Respond directly to the user. RULES: (1) Do NOT narrate what the user asked — they already know. (2) Do NOT describe your reasoning, thinking, or what you\'re about to do. (3) Do NOT start with "The user asked", "Let me", "I should", "I\'ll", "Actually", "Looking at" — start with the actual answer. (4) Be brief and friendly. 1-3 sentences is usually enough. (5) No meta-commentary. Just the answer.',
                    },
                ];
            }

            const chatOptions = {
                model: activeModel,
                messages: smartMessages,
                tools: ctx.activeTools.length > 0 ? ctx.activeTools : undefined,
                maxTokens: isVoice ? Math.min(ctx.config.agent.maxTokens, 300) : ctx.config.agent.maxTokens,
                temperature: ctx.config.agent.temperature,
                thinking: isVoice ? false : thinkingMode !== 'off',
                thinkingLevel: thinkingMode as 'off' | 'low' | 'medium' | 'high',
                forceToolUse: (
                    // Hunt Finding #08 (2026-04-14): Only force tool_choice=required
                    // on ROUND 0. After round 0, the model has tool results in context
                    // and should be free to generate text OR call more tools as needed.
                    // Previously, autonomous mode forced tools on every round, causing
                    // ping-pong loops: model reads file → forced to call another tool →
                    // calls shell → forced again → calls memory → loop detector kills it.
                    // Only force when we haven't given the model a chance to finish.
                    round === 0
                    && ctx.activeTools.length > 0
                    && (ctx.isAutonomous || ctx.taskEnforcementActive)
                    && (ctx.config.agent as Record<string, unknown>).forceToolUse !== false
                    && phase !== 'respond'
                    // Hunt Finding #07: don't force tools on chat-pipeline messages
                    && ctx.completionStrategy !== 'single-round'
                    && ctx.pipelineType !== 'chat')
                    || forceWriteOnNextThink  // Incomplete task guard — specific retry
                    // Hunt Finding #05: user explicitly asked to use a tool → force round 0
                    || (round === 0
                        && phase === 'think'
                        && ctx.activeTools.length > 0
                        && detectToolUseIntent(ctx.message || '')),
                providerOptions: ctx.providerOptions,
            };
            if (forceWriteOnNextThink) {
                forceWriteOnNextThink = false; // Reset after use
                logger.info(COMPONENT, '[IncompleteTask] Forcing tool_choice=required for write retry');
            }
            // Hunt Finding #05: log when explicit-intent is forcing tool use
            if (round === 0 && phase === 'think' && !ctx.isAutonomous && !ctx.taskEnforcementActive
                && ctx.activeTools.length > 0 && detectToolUseIntent(ctx.message || '')) {
                logger.info(COMPONENT, '[ExplicitIntent] User explicitly requested tool use — forcing tool_choice=required for round 1');
            }

            let response: ChatResponse;
            // Hunt Finding #38b (2026-04-15): for single-round chat pipelines,
            // the model's round-0 think output IS the user-facing answer (no
            // respond phase ever runs). With live SSE streaming, the raw
            // narrator tokens from a weak model hit the UI before the
            // sanitizer can run at the end — the user sees "The user wants a
            // joke. I can respond directly without needing any tools. Why
            // don't scientists trust atoms?..." on screen. Fix: DO NOT stream
            // chat-pipeline round-0 think output. Collect the full response,
            // run it through the sanitizer, THEN emit as a single block.
            // The client shows a typing indicator during the short wait
            // instead of streaming raw narrator tokens.
            const isChatRound0Think =
                round === 0
                && phase === 'think'
                && ctx.completionStrategy === 'single-round';

            if (ctx.streamCallbacks?.onToken && !isChatRound0Think) {
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
                // Estimate token counts for streaming (servers don't report usage in stream mode)
                // ~4 chars per token is a reasonable approximation for English text
                const estCompletionTokens = Math.ceil((streamContent.length + JSON.stringify(streamToolCalls).length) / 4);
                const estPromptTokens = Math.ceil(JSON.stringify(smartMessages).length / 4);
                response = {
                    id: `stream-${Date.now()}`,
                    content: streamContent,
                    toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
                    usage: { promptTokens: estPromptTokens, completionTokens: estCompletionTokens, totalTokens: estPromptTokens + estCompletionTokens },
                    finishReason: streamToolCalls.length > 0 ? 'tool_calls' : 'stop',
                    model: activeModel,
                };
            } else {
                // Non-streaming path. For chat-pipeline round-0 think we
                // deliberately come here so the sanitizer gets to see the
                // full response before the client does. We also strip any
                // leading narrator preamble that the model emitted despite
                // our respond directive (Hunt Finding #38b).
                response = await chat(chatOptions);
                if (isChatRound0Think && response.content) {
                    const stripped = stripNarratorPreamble(response.content);
                    if (stripped !== response.content) {
                        logger.info(COMPONENT, `[NarratorStrip] Removed ${response.content.length - stripped.length} chars of narrator preamble from chat response`);
                        response.content = stripped;
                    }
                }
            }

            result.modelUsed = response.model;
            const promptTokens = response.usage?.promptTokens || 0;
            const completionTokens = response.usage?.completionTokens || 0;
            result.promptTokens += promptTokens;
            result.completionTokens += completionTokens;

            // ── Cost tracking (F5: two-tier budget enforcement) ──
            const costCheck = recordTokenUsage(ctx.sessionId, activeModel, promptTokens, completionTokens);
            if (costCheck.budgetExceeded) {
                result.content = '⚠️ Daily spending limit reached. TITAN has paused to keep your API costs under control. You can increase the limit in settings or wait until tomorrow.';
                phase = 'done';
                break;
            }
            // F5: Soft warning at 80% — tell the LLM to wrap up efficiently
            if (costCheck.budgetWarning && !budgetWarningSent) {
                budgetWarningSent = true;
                ctx.messages.push({
                    role: 'user',
                    content: `[System: ⚠️ Budget notice — you've used 80%+ of today's spending limit ($${costCheck.dailyTotal.toFixed(4)}). Be efficient: avoid unnecessary tool calls, summarize when possible, and wrap up soon.]`,
                });
                logger.info(COMPONENT, `[BudgetSoftWarning] Injected 80% budget warning into conversation`);
            }

            heartbeat(ctx.sessionId);

            // ── No tool calls → check rescue paths or accept response ──
            if (!response.toolCalls || response.toolCalls.length === 0) {
                logger.warn(COMPONENT, `[NoTools] Model returned text (len=${response.content.length}): ${response.content.slice(0, 200)}`);

                // FabricationGuard: detect model claiming to have completed actions without tool calls
                // gemma4 says "I've written X to file Y" without actually calling write_file
                //
                // Hunt Finding #47 (2026-04-15): this guard was DESTROYING correctly
                // written files. When the model summarized "all results were written
                // to /tmp/foo.txt", the regex matched, content extraction failed, and
                // the file was overwritten with "placeholder" — nuking the real 198-byte
                // output. Fix: skip if the file already exists with >0 bytes (the write
                // already succeeded in a prior round). Also require an explicit content
                // extract — never fall back to "placeholder".
                const fabricationMatch = response.content.match(/(?:written|saved|created|wrote)\s+(?:.*?)(?:to|at|in)\s+["'`]?(\/[\w/.-]+\.[a-z]+)["'`]?/i);
                if (fabricationMatch) {
                    const filePath = fabricationMatch[1];
                    // Check if the file already exists — if so, the write already
                    // succeeded in a previous round and this is just the model
                    // summarizing what it did. Don't overwrite.
                    let fileAlreadyExists = false;
                    try {
                        const { existsSync, statSync } = await import('fs');
                        fileAlreadyExists = existsSync(filePath) && statSync(filePath).size > 0;
                    } catch { /* can't check, assume not */ }

                    if (fileAlreadyExists) {
                        logger.info(COMPONENT, `[FabricationGuard] File "${filePath}" already exists (${fileAlreadyExists ? 'has content' : 'empty'}) — skipping forced write (Hunt #47)`);
                    } else {
                        // Extract what should have been written — require explicit content
                        const contentMatch = response.content.match(/(?:written|saved|wrote)\s+["`]([^"`]+)["`]/i);
                        if (contentMatch) {
                            const fileContent = contentMatch[1];
                            logger.warn(COMPONENT, `[FabricationGuard] Model claimed to write "${filePath}" without tool call — forcing write_file`);
                            response.toolCalls = [{
                                id: `fab-${Date.now()}`,
                                type: 'function' as const,
                                function: { name: 'write_file', arguments: JSON.stringify({ path: filePath, content: fileContent }) },
                            }];
                            response.content = '';
                        } else {
                            logger.warn(COMPONENT, `[FabricationGuard] Model claimed to write "${filePath}" but no extractable content — skipping forced write to avoid placeholder damage (Hunt #47)`);
                        }
                    }
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
                            logger.info(COMPONENT, `[IntentParser] Past-tense write → write_file("${pastWrite[1]}")`);
                            response.toolCalls = [{
                                id: `intent-${Date.now()}`,
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

                // Hunt Finding #17 (2026-04-14): UserIntentRescue — when the model
                // ignores tool_choice=required AND all model-response-based rescue
                // paths fail, extract the intended tool call from the USER MESSAGE
                // directly. This catches the case where a weak model fabricates
                // plausible-sounding tool output (e.g. "Permission denied",
                // "command returned null") instead of actually running the tool.
                if (!response.toolCalls || response.toolCalls.length === 0) {
                    const userIntent = extractToolCallFromUserMessage(ctx.message || '', ctx.activeTools);
                    if (userIntent) {
                        logger.warn(COMPONENT, `[UserIntentRescue] Model ignored tool_choice=required; extracting "${userIntent.function.name}" from user message`);
                        response.toolCalls = [userIntent];
                        response.content = '';
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
                        // Gap 2 (plan-this-logical-ocean): if this run DID execute
                        // tools earlier and is now stuck in no-tools land, check
                        // the bounded continuation counter before bailing. This
                        // is the "empty_after_tools" signal — the model forgot
                        // what it was doing mid-task. One continuation nudge is
                        // cheap; the counter persists across process restarts so
                        // we can't loop forever.
                        const didUseTools = result.toolsUsed.length > 0;
                        if (didUseTools) {
                            const { shouldContinue } = await import('./runContinuations.js');
                            if (shouldContinue(ctx.sessionId, 'empty_after_tools')) {
                                logger.warn(COMPONENT, `[Continuation] empty_after_tools — nudging once more (session ${ctx.sessionId})`);
                                ctx.messages.push({
                                    role: 'user',
                                    content: '[SYSTEM] You started calling tools but stopped before finishing. Continue the work you started — call the next tool you need, or if you genuinely are done, write the final answer in plain text now.',
                                });
                                noToolsRetryCount = 0; // fresh window after the continuation
                                round++;
                                continue;
                            }
                        }
                        logger.warn(COMPONENT, `[NoTools] Bailing after ${noToolsRetryCount} consecutive no-tool rounds — accepting text response`);
                        result.content = stripToolJson(response.content || pendingAssistantContent || 'I was unable to make progress using tools.');
                        phase = 'done';
                        break;
                    }

                    // In autonomous mode: if the model describes work instead of doing it,
                    // push it back to use tools. This is the key behavioral pattern that
                    // makes autonomous execution reliable — don't accept "I would do X"
                    // when the model should be calling tools to actually do X.
                    if (ctx.isAutonomous && round < ctx.effectiveMaxRounds - 2) {
                        // Hunt Finding #10 (2026-04-14): the previous regexes over-matched.
                        // `|The` with no word boundary matched "These"/"This"/"Then"/"There"/
                        // "They" — all common ways to start valid descriptive answers. And
                        // describesWork only needed one weak indicator. Result: a correct
                        // answer starting with "These represent two classic attack categories..."
                        // got nudged to "call a tool", then the model emitted meta-commentary
                        // that was accepted as the final answer.
                        //
                        // New rules (tight):
                        //   1. futureIntentOpener requires an EXPLICIT future-action phrase
                        //      with a following verb ("Let me VERB", "I'll VERB", "I will VERB",
                        //      "I need to VERB"). Common openers like "The"/"These"/"This"/
                        //      "Based on"/"Here's" no longer trigger.
                        //   2. describesWork also requires "I'll/I will/I need to/Let me"
                        //      followed by an actual work verb nearby.
                        //   3. BOTH must match to fire — one weak match isn't enough.
                        const futureIntentOpener = /^(let me\s+\w+|I['']?ll\s+(?:start|begin|check|look|read|run|edit|write|create|try|go|investigate|verify|test|install|build|fix|update|change|set)|I\s+(?:will|need to|should|can|am going to|plan to)\s+\w+|first,?\s+I|now\s+I|to\s+(?:fix|resolve|complete|edit|write|create|update|change|run))\b/i.test(response.content.trim());
                        const describesWork = /\b(?:I['']?ll|I (?:will|need to|should|plan to|am going to)|let me)\b[^.]{0,80}\b(?:fix|edit|change|update|create|write|modify|run|install|build|start|restart|read|open|debug|set up|check|look at|examine|investigate|verify|confirm|test)\b/i.test(response.content);

                        // BOTH must match to fire — prevents false positives on valid
                        // descriptive answers that don't actually describe future work.
                        if (futureIntentOpener && describesWork && noToolsRetryCount < 3) {
                            noToolsRetryCount++;
                            logger.info(COMPONENT, `[AutoPush] Model described intent to act without acting (${noToolsRetryCount}/3): "${response.content.slice(0, 80)}..."`);
                            ctx.messages.push({ role: 'assistant', content: response.content });
                            ctx.messages.push({ role: 'user', content: 'STOP describing. Call a tool RIGHT NOW. Use edit_file to fix code, write_file to create files, or shell to run commands. Your next response MUST be a tool call, not text.' });
                            round++;
                            continue;
                        }
                    }

                    // Hunt Finding #05 (continuation): before accepting a text-only
                    // response as final, check if it looks like fabricated tool output.
                    // If the user requested verbatim/exact tool output AND we have
                    // real tool results in this turn, prefer the real result.
                    const finalText = stripToolJson(response.content || '');
                    const lastToolResult = result.toolCallDetails.length > 0
                        ? result.toolCallDetails[result.toolCallDetails.length - 1]
                        : null;
                    const userMsgLower = (ctx.message || '').toLowerCase();
                    const wantsVerbatim = /\b(?:verbatim|exactly|precise|literal|as(?: |-)is|raw output|just the output)\b/.test(userMsgLower);

                    if (lastToolResult && lastToolResult.success && wantsVerbatim && finalText.length < 300) {
                        // Check if the text appears in the actual tool output — if NOT,
                        // it's likely a hallucinated echo of what the model thinks the
                        // tool should have returned. Replace with the real output.
                        const realOutput = lastToolResult.resultSnippet || '';
                        const textAppearsInResult = realOutput.length > 10 && realOutput.toLowerCase().includes(finalText.toLowerCase().slice(0, 40));
                        if (!textAppearsInResult && realOutput.length > 0) {
                            logger.warn(COMPONENT, `[HallucinationGuard] Text response "${finalText.slice(0, 60)}..." does NOT match real tool output "${realOutput.slice(0, 60)}..." — user asked for verbatim, using real tool output instead`);
                            result.content = realOutput.length < 1500 ? realOutput : realOutput.slice(0, 1500) + '...[truncated]';
                            setCachedResponse(smartMessages, activeModel, result.content);
                            phase = 'done';
                            break;
                        }
                    }

                    // Model chose to respond directly — accept it
                    result.content = finalText;
                    setCachedResponse(smartMessages, activeModel, result.content);
                    phase = 'done';
                    break;
                }

                // Tool calls were rescued — reset the no-tools counter since the model is making progress
                noToolsRetryCount = 0;
            }

            // A7: Remaining steps guard (LangGraph pattern) — suppress tool calls near budget limit
            const remainingRounds = ctx.effectiveMaxRounds - round;
            if (ctx.isAutonomous && remainingRounds <= 1 && response.toolCalls && response.toolCalls.length > 0) {
                logger.warn(COMPONENT, `[BudgetGuard] Only ${remainingRounds} round(s) left — suppressing ${response.toolCalls.length} tool call(s), forcing text response`);
                response.toolCalls = undefined;
                result.budgetExhausted = true;
                if (!response.content || response.content.trim().length === 0) {
                    response.content = pendingAssistantContent || 'I\'ve used all available rounds. Here is what I accomplished so far.';
                }
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

            // v4.13 ancestor-extraction (Hermes subdirectory_hints): for each
            // tool call that touched a new directory, append any AGENTS.md /
            // CLAUDE.md / .cursorrules from that directory + its ancestors to
            // the tool RESULT (not the system prompt — we keep prompt cache
            // stable). Guarded by try/catch so hint discovery can never break
            // tool execution.
            try {
                const { getSubdirTracker } = await import('./subdirHints.js');
                const tracker = getSubdirTracker(ctx.sessionId);
                for (let i = 0; i < toolResults.length; i++) {
                    const tr = toolResults[i];
                    const tc = pendingToolCalls[i];
                    if (!tc) continue;
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* non-fatal */ }
                    const hints = tracker.checkToolCall(tr.name, args);
                    if (hints) {
                        tr.content = `${tr.content}\n\n${hints}`;
                    }
                }
            } catch (err) {
                logger.debug(COMPONENT, `[SubdirHints] skipped: ${(err as Error).message}`);
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
                // Hunt Finding #40: AutoVerify needs to flip tcSuccess/tr.success
                // when a write verify fails, so SmartExit doesn't treat the write
                // as terminal-success. Must be `let` for that mutation.
                let tcSuccess = !tr.content.toLowerCase().includes('error:');
                result.toolCallDetails.push({
                    name: tr.name,
                    args: tcArgs,
                    resultSnippet: tr.content.slice(0, 300),
                    success: tcSuccess,
                });

                // Tool result summarization disabled — was confusing models into
                // treating the summary as the final answer instead of continuing to act.
                // TODO: Re-enable when models handle injected context better.

                // Auto-verify file writes — catch silent truncation, empty files, broken HTML/JSON
                // Hunt Finding #40 (2026-04-15): previously AutoVerify only logged
                // a warning and pushed a suggestion. When glm-5.1 wrote to the
                // wrong path (/home/titan/... on a machine where user=dj), the
                // write was silently rejected by validatePath, AutoVerify warned
                // but tr.success stayed TRUE, SmartExit saw "terminal tool
                // succeeded" and transitioned to respond — dropping the file
                // entirely. Fix: flip tr.success=false on verify failure, and
                // mark the result with a clear [AutoVerify FAILED] banner so
                // the next think round sees it and retries.
                if (tr.name === 'write_file' || tr.name === 'append_file') {
                    const vr = verifyFileWrite(tr.name, tcArgs, tr.content);
                    if (!vr.passed) {
                        logger.warn(COMPONENT, `[AutoVerify] ${tr.name}: ${vr.issue} — forcing retry (Hunt #40)`);
                        // Flip success false so SmartExit doesn't treat this as
                        // a terminal-tool success.
                        tr.success = false;
                        tcSuccess = false;
                        // Mutate tr.content so the assistant sees the failure
                        // in the tool_result message on the next think round.
                        tr.content = `[AutoVerify FAILED] ${vr.issue}. Original tool output: ${tr.content}`;
                        ctx.messages.push({
                            role: 'user',
                            content: `[AutoVerify] ${vr.issue}${vr.suggestion ? `\n\nSuggestion: ${vr.suggestion}` : ''}\n\nCall the tool again with the corrected arguments. Do NOT proceed until the verify passes.`,
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
                    // Hunt Finding #24 (2026-04-14): instead of returning the
                    // raw breaker debug message to the user ("Ping-pong pattern
                    // detected: weather ↔ memory repeated 3+ times"), route
                    // into the respond phase with a directive to summarize
                    // what was actually collected from successful tools.
                    // The breaker reason stays in logs but never in the reply.
                    ctx.messages.push({
                        role: 'user',
                        content: '[SYSTEM] You were stuck in a tool loop and it has been broken. Now produce a DIRECT final answer to the user based on the tool results you already have above. Do NOT call any more tools. Do NOT mention the loop, the breaker, or any internal process. Just answer the user\'s original question using the data you collected.',
                    });
                    phase = 'respond';
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

                // Persistent audit — Paperclip competitive gap fix
                // Tracks per-agent, per-run, per-tool cost attribution
                try {
                    const { logAuditEvent } = await import('./auditStore.js');
                    logAuditEvent({
                        agentId: ctx.agentId || 'default',
                        runId: undefined, // TODO: pipe runId through LoopContext
                        sessionId: ctx.sessionId,
                        type: 'tool_execution',
                        toolName: tr.name,
                        durationMs: tr.durationMs,
                        promptTokens: result.promptTokens,
                        completionTokens: result.completionTokens,
                        success,
                    });
                } catch { /* audit store not critical */ }

                // A6: Error classification feedback to LLM (Hermes ClassifiedError pattern)
                if (!success && tr.errorClass && !ctx.voiceFastPath) {
                    const isTransient = tr.errorClass === 'transient' || tr.errorClass === 'timeout' || tr.errorClass === 'rate_limit';
                    const hint = isTransient
                        ? `[Error Classification: TEMPORARY (${tr.errorClass}). Retrying this tool may succeed. Consider waiting briefly if rate-limited.]`
                        : `[Error Classification: PERMANENT. This approach won't work — try a different tool or different arguments.]`;
                    ctx.messages.push({ role: 'user', content: hint });
                }

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

            // Hunt Finding #24 (2026-04-14): previously `loopBroken` forced
            // phase='done' here, bypassing the respond phase. Now the loop
            // breaker sets phase='respond' directly so the user gets a real
            // answer from the tool data, not the raw breaker message. Keep
            // the `break` to exit the act loop but fall through to respond.
            if (loopBroken) { break; }

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

            // ── Read-only round detection ─────────────────────────
            // If in autonomous mode and all tools this round were read-only
            // (no writes, no edits), inject a directive to ACT on what was read.
            // This prevents the "read → describe → stop" pattern.
            if (ctx.isAutonomous && toolResults.length > 0) {
                const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'web_search', 'web_fetch', 'tool_search', 'memory', 'system_info', 'goal_list', 'weather']);
                const allReadOnly = toolResults.every(tr =>
                    READ_ONLY_TOOLS.has(tr.name) ||
                    (tr.name === 'shell' && /^\s*(cat|head|tail|less|ls|find|grep|wc|echo|date|whoami|hostname|uname|df|du|ps|ss|curl.*GET|pwd|which|type|file|stat)\b/i.test((pendingToolCalls.find(tc => tc.id === tr.toolCallId)?.function.arguments || '{}').replace(/.*"command"\s*:\s*"/, '').replace(/".*/, '')))
                );
                const hasWrites = toolResults.some(tr =>
                    tr.name === 'write_file' || tr.name === 'edit_file' || tr.name === 'append_file'
                );
                if (allReadOnly && !hasWrites && round >= 2) {
                    logger.info(COMPONENT, `[ReadOnlyNudge] Round ${round}: all tools were read-only — nudging to write`);
                    ctx.messages.push({
                        role: 'user',
                        content: 'You just read files and ran diagnostic commands. Now ACT on what you found. Call edit_file or write_file to make the changes. Do NOT describe what needs to change — make the change NOW.',
                    });
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
                // A8: Budget grace call (Hermes pattern) — give model one final chance to summarize
                // instead of hard-cutting with a generic message
                result.budgetExhausted = true;
                if (pendingAssistantContent && pendingAssistantContent.trim().length > 20) {
                    // Model already said something useful — use it
                    result.content = stripToolJson(pendingAssistantContent);
                } else {
                    // Force one final toolless call to summarize
                    phase = 'respond';
                    logger.info(COMPONENT, `[BudgetGrace] Round limit reached — giving model one final respond call`);
                    continue; // skip to respond phase
                }
                phase = 'done';
            } else if (ctx.isAutonomous) {
                // Smart exit: only skip to respond if a single TERMINAL tool succeeded.
                // Terminal tools are ones that produce a final artifact (write, append)
                // or answer a direct question (weather, system_info).
                // Information-gathering tools (read_file, list_dir, web_search, shell, memory)
                // are NOT terminal — they almost always need a follow-up action.
                const completionStrategy = ctx.completionStrategy || 'smart-exit';

                // Pipeline-aware completion detection
                if (completionStrategy === 'no-tools') {
                    // Research/browser: keep going until model stops requesting tools
                    // (This path always continues — SmartExit is effectively disabled)
                    phase = 'think';
                } else if (completionStrategy === 'single-round') {
                    // Chat: one tool round then respond
                    if (round >= 1) {
                        logger.info(COMPONENT, `[SmartExit:${ctx.pipelineType || 'chat'}] Single-round completion — skipping to respond`);
                        phase = 'respond';
                    } else {
                        phase = 'think';
                    }
                } else {
                    // smart-exit or terminal-tool: exit when a terminal tool succeeds
                    const defaultTerminals = ['write_file', 'append_file', 'weather', 'system_info', 'fb_post', 'fb_reply', 'content_publish'];
                    const terminalTools = new Set(ctx.pipelineTerminalTools || defaultTerminals);
                    const singleToolSuccess = pendingToolCalls.length === 1
                        && toolResults.every(r => r.success)
                        && terminalTools.has(pendingToolCalls[0].function.name);
                    // Respect minRounds — don't allow early exit before the pipeline's minimum
                    const minRoundsMet = round >= (ctx.minRounds ?? 2);
                    if (singleToolSuccess && minRoundsMet && ctx.smartExitEnabled !== false) {
                        logger.info(COMPONENT, `[SmartExit:${ctx.pipelineType || 'general'}] Terminal tool "${pendingToolCalls[0].function.name}" succeeded — skipping to respond`);
                        phase = 'respond';
                    } else {
                        // Autonomous mode: go back for more tool rounds
                        phase = 'think';
                    }
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
                logger.warn(COMPONENT, `[IncompleteTask] User asked to edit but no write tool called after ${round} rounds — forcing back to think with tool_choice=required`);
                ctx.messages.push({
                    role: 'user',
                    content: '[INCOMPLETE] You read the file but did NOT make changes. Call edit_file NOW.\n\nedit_file arguments:\n- path: (the file you read)\n- target: (exact string from the file to replace — copy a small section)\n- replacement: (the new version of that section)\n\nDo NOT use write_file for large files. Use edit_file for surgical changes. CALL IT NOW.',
                });
                responseValidationRetried = true; // Only do this once
                forceWriteOnNextThink = true;     // Force tool_choice=required on next think
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

            // F1: Pre-model hook for respond phase too
            if (ctx.beforeModelCall) {
                try {
                    smartMessages = ctx.beforeModelCall([...smartMessages], round);
                } catch (e) {
                    logger.warn(COMPONENT, `[PreModelHook:respond] Hook threw: ${(e as Error).message}`);
                }
            }

            // Hunt Finding #21 (2026-04-14): inject a directive message at the
            // tail of the context for the respond phase. Without this, weak
            // models (minimax-m2.7:cloud) produce internal-monologue text like
            // "The user asked me to run X... Actually, looking at the results..."
            // which is raw chain-of-thought leaking into the final answer.
            // This directive is appended only to the respond-phase request —
            // not persisted to the session history.
            const respondDirective: ChatMessage = {
                role: 'user',
                content: '[System directive for this reply only] Write the final answer for the user. RULES: (1) Do NOT narrate what the user asked — they already know. (2) Do NOT describe your reasoning, thinking, or past tool attempts. (3) Do NOT start with "The user asked", "Let me", "Actually", "Looking at", "Wait" — start with the result. (4) Report outcomes as facts in 1-3 sentences. (5) No XML, no tool call blocks, no meta-commentary. Just the answer.',
            };
            smartMessages = [...smartMessages, respondDirective];

            const thinkingMode = ctx.thinkingOverride || ctx.config.agent.thinkingMode || 'off';
            const chatOptions = {
                model: activeModel,
                messages: smartMessages,
                tools: undefined,  // NO TOOLS — forces text-only response
                maxTokens: ctx.voiceFastPath ? Math.min(ctx.config.agent.maxTokens, 300) : ctx.config.agent.maxTokens,
                temperature: ctx.config.agent.temperature,
                thinking: ctx.voiceFastPath ? false : thinkingMode !== 'off',
                thinkingLevel: thinkingMode as 'off' | 'low' | 'medium' | 'high',
                providerOptions: ctx.providerOptions,
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

            // Hunt Finding #39 (2026-04-15): if the model emits tool calls in
            // the respond phase (despite tools being undefined), those calls
            // are the model's attempt to RECOVER from an earlier failure. A
            // real captured example: model wrote to /home/titan/docs/foo.md
            // (wrong user), the write was rejected, then in the respond phase
            // it emitted a corrected write_file to /tmp/readme-b1-comparison.md.
            // Previously we dropped that tool call silently. Now we route
            // back to the think phase so the recovery actually executes.
            if (response.toolCalls && response.toolCalls.length > 0) {
                logger.warn(
                    COMPONENT,
                    `[RespondPhaseToolCall] Model emitted ${response.toolCalls.length} tool call(s) in respond phase — routing back to think phase to execute (Hunt #39)`,
                );
                // Inject the tool call as an assistant message so the next
                // think round sees it and the agent loop executes it.
                ctx.messages.push({
                    role: 'assistant',
                    content: response.content || '',
                    toolCalls: response.toolCalls,
                });
                // Synthesize a placeholder tool message so the next think
                // iteration doesn't orphan the tool_calls.
                // Actually — leave it. The act-phase handler runs tool calls
                // from the most recent assistant. Transition phase=act and
                // let the existing execution path handle it.
                phase = 'act';
                // Seed pendingToolCalls so the act handler picks them up
                pendingToolCalls = response.toolCalls;
                pendingAssistantContent = response.content || '';
                break; // exit respond case; re-enter the while loop at act
            }

            const costCheck = recordTokenUsage(ctx.sessionId, activeModel, response.usage?.promptTokens || 0, response.usage?.completionTokens || 0);
            if (costCheck.budgetExceeded) {
                result.content = '⚠️ Daily spending limit reached. TITAN has paused to keep your API costs under control.';
            } else {
                // Output guardrails pipeline — centralized post-processing
                // Strips thinking blocks, narrator preamble, instruction echoes,
                // and validates structure before delivering to user.
                const { applyOutputGuardrails } = await import('./outputGuardrails.js');
                const guardrailed = applyOutputGuardrails(response.content, {
                    type: 'chat_response',
                    originalMessage: ctx.message,
                    model: activeModel,
                });
                result.content = guardrailed.content;
            }

            // Empty response fallback: if the model returned nothing in respond phase,
            // retry once with explicit instruction, then use a clean fallback
            if (!emptyResponseRetried && (!result.content || result.content.trim().length === 0)) {
                emptyResponseRetried = true;
                // Try one more LLM call with a strong nudge to summarize
                try {
                    const retryMessages = [
                        ...ctx.messages.slice(-6),
                        { role: 'user' as const, content: '[SYSTEM] You MUST respond to the user\'s original question now. Summarize what you found from your tool calls in 2-3 sentences. Do NOT call any tools. Just answer directly.' },
                    ];
                    const retryResponse = await chat({
                        model: activeModel,
                        messages: retryMessages,
                        temperature: 0.7,
                        maxTokens: 300,
                        providerOptions: ctx.providerOptions,
                    });
                    const retryContent = (retryResponse.content || '').trim();
                    if (retryContent && retryContent.length > 10) {
                        logger.info(COMPONENT, '[EmptyResponse] Recovery retry succeeded');
                        result.content = stripToolJson(retryContent);
                    }
                } catch (retryErr) {
                    logger.debug(COMPONENT, `[EmptyResponse] Recovery retry failed: ${(retryErr as Error).message}`);
                }

                // If retry also failed, use a clean message (never dump raw tool results)
                if (!result.content || result.content.trim().length === 0) {
                    logger.warn(COMPONENT, '[EmptyResponse] Model returned empty after retry — using clean fallback');
                    result.content = 'I looked into that but couldn\'t generate a clear summary. Could you try asking again?';
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

    // v4.13 ancestor-extraction (Hermes trajectory): append this run's full
    // ChatML transcript to disk for future retrospective / fine-tuning. Guarded
    // try/catch — trajectory I/O failures never affect the user response.
    try {
        const { saveTrajectory } = await import('./trajectory.js');
        const completed = !result.budgetExhausted && !!result.content && result.content.length > 0;
        saveTrajectory({
            conversations: ctx.messages,
            model: activeModel,
            completed,
            sessionId: ctx.sessionId,
            toolsUsed: result.toolsUsed,
            reason: result.budgetExhausted ? 'budget_exhausted' : (completed ? 'done' : 'empty'),
            metrics: {
                rounds: round,
                promptTokens: result.promptTokens ?? 0,
                completionTokens: result.completionTokens ?? 0,
            },
        });
    } catch { /* trajectory save is best-effort */ }

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
