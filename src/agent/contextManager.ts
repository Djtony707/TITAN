/**
 * TITAN — Smart Context Manager
 * Intelligent context window management that none of the competitors do well.
 *
 * Problems this solves:
 * - Auto-GPT wastes tokens on irrelevant history (high cost)
 * - CrewAI has prompt sprawl across agents (unpredictable cost)
 * - Open Interpreter has no context management at all
 *
 * TITAN's approach:
 * - Automatic summarization of old conversation history
 * - Priority-based context allocation (recent > relevant > old)
 * - Token budget tracking and enforcement
 * - Smart truncation that preserves tool call context
 */
import logger from '../utils/logger.js';
import type { ChatMessage } from '../providers/base.js';
import { estimateTokens } from '../utils/tokens.js';
export { estimateTokens };
import { flushMemoryBeforeCompaction } from '../memory/graph.js';
import { getRagContext } from '../memory/vectors.js';
import { getPlugins } from '../plugins/registry.js';
import { runAssemble, runCompact } from '../plugins/contextEngine.js';
import { compressContext, type StructuredSummary } from './contextCompressor.js';

const COMPONENT = 'Context';

interface ContextBudget {
    maxTokens: number;
    systemPromptTokens: number;
    toolDefinitionTokens: number;
    remainingForHistory: number;
}



/** Calculate the context budget */
export function calculateBudget(
    maxContextTokens: number,
    systemPrompt: string,
    toolDefinitionsCount: number,
): ContextBudget {
    const systemTokens = estimateTokens(systemPrompt);
    const toolTokens = toolDefinitionsCount * 120; // ~120 tokens per tool definition
    const reserveForResponse = 2000; // Reserve for completion

    return {
        maxTokens: maxContextTokens,
        systemPromptTokens: systemTokens,
        toolDefinitionTokens: toolTokens,
        remainingForHistory: Math.max(0, maxContextTokens - systemTokens - toolTokens - reserveForResponse),
    };
}

/** Summarize a batch of messages into a single summary message */
export function summarizeMessages(messages: ChatMessage[]): ChatMessage {
    const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content).filter(Boolean);
    const assistantMessages = messages.filter((m) => m.role === 'assistant').map((m) => m.content).filter(Boolean);
    const toolMessages = messages.filter((m) => m.role === 'tool').length;

    const summary = [
        `[Earlier conversation summary — ${messages.length} messages, ${toolMessages} tool calls]`,
        userMessages.length > 0 ? `User discussed: ${userMessages.slice(-3).map((m) => m.slice(0, 80)).join('; ')}` : '',
        assistantMessages.length > 0 ? `Assistant actions: ${assistantMessages.slice(-2).map((m) => m.slice(0, 80)).join('; ')}` : '',
    ].filter(Boolean).join('\n');

    return { role: 'system', content: summary };
}

/**
 * Compress verbose tool results to save context window space.
 * Keeps the last 5 tool results at full fidelity, summarizes older ones.
 */
function compressToolResults(messages: ChatMessage[]): ChatMessage[] {
    // Count tool messages from the end to find the cutoff
    let toolCount = 0;
    const toolIndices: number[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'tool') {
            toolCount++;
            toolIndices.push(i);
        }
    }

    // If 5 or fewer tool results, nothing to compress
    if (toolCount <= 5) return messages;

    // Indices of tool messages to keep at full fidelity (last 5)
    const keepFullSet = new Set(toolIndices.slice(0, 5));

    return messages.map((msg, i) => {
        if (msg.role !== 'tool' || keepFullSet.has(i)) return msg;
        const content = msg.content || '';
        if (content.length <= 500) return msg;

        // Compress: keep first 150 chars + success/error status
        const isError = content.toLowerCase().includes('error:');
        const summary = `[${msg.name || 'tool'}: ${isError ? 'FAILED' : 'OK'}] ${content.slice(0, 150)}... [${content.length} chars compressed]`;
        return { ...msg, content: summary };
    });
}

/** Persistent structured summary for iterative context compression */
let currentSummary: StructuredSummary | null = null;

/**
 * TITAN pattern: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
 * Disables compaction after 3 consecutive failures per session to prevent
 * wasted API calls (This class of bug can waste 250K+ API calls/day).
 */
let consecutiveCompactFailures = 0;
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

/** Reset compact failure counter (call on new session) */
export function resetCompactFailures(): void {
    consecutiveCompactFailures = 0;
}

/** Get the current structured summary (for external access) */
export function getStructuredSummary(): StructuredSummary | null {
    return currentSummary;
}

/** Set the structured summary (e.g., from agent loop state) */
export function setStructuredSummary(summary: StructuredSummary | null): void {
    currentSummary = summary;
}

/**
 * Smart context builder — fits messages within token budget.
 * Uses the 5-phase compression pipeline (Hermes-inspired):
 * 1. Tool output pruning (no LLM call)
 * 2. Head protection (system + first 3 messages)
 * 3. Tail protection (last N messages, 5% of budget)
 * 4. Structured middle summary
 * 5. Iterative summary updates
 */
export function buildSmartContext(
    messages: ChatMessage[],
    tokenBudget: number,
): ChatMessage[] {
    if (messages.length === 0) return [];

    // TITAN pattern: skip compaction after consecutive failures
    if (consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
        logger.warn(COMPONENT, `Compaction disabled after ${consecutiveCompactFailures} consecutive failures — returning raw messages`);
        return messages;
    }

    let result;
    try {
        result = compressContext(messages, tokenBudget, currentSummary);
        consecutiveCompactFailures = 0; // Reset on success
    } catch (err) {
        consecutiveCompactFailures++;
        logger.warn(COMPONENT, `Compaction failed (${consecutiveCompactFailures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}): ${(err as Error).message}`);
        return messages; // Return uncompressed on failure
    }

    // Store summary for iterative updates on next compression
    if (result.summary) {
        currentSummary = result.summary;
    }

    if (result.savedTokens > 0) {
        logger.debug(COMPONENT, `Smart context: ${messages.length} → ${result.messages.length} messages, saved ~${result.savedTokens} tokens`);
    }

    return result.messages;
}

/**
 * Force context compaction (used by /compact command).
 * Uses the 5-phase pipeline with an aggressive budget to maximize compression.
 */
export function forceCompactContext(
    messages: ChatMessage[],
): { messages: ChatMessage[]; savedTokens: number } {
    if (messages.length <= 4) {
        return { messages, savedTokens: 0 };
    }

    // Flush important context to graph memory before discarding (fire-and-forget)
    const toFlush = messages.filter(m => m.role !== 'system');
    flushMemoryBeforeCompaction(toFlush).catch((err) =>
        logger.warn(COMPONENT, `Memory flush before compaction failed: ${(err as Error).message}`),
    );

    // Aggressive budget: 4000 tokens forces maximum compression
    const result = compressContext(messages, 4000, currentSummary);

    if (result.summary) {
        currentSummary = result.summary;
    }

    logger.info(COMPONENT, `Force compacted: ${messages.length} → ${result.messages.length} messages, saved ~${result.savedTokens} tokens`);
    return { messages: result.messages, savedTokens: result.savedTokens };
}

/** Get context window stats */
export function getContextStats(messages: ChatMessage[]): {
    messageCount: number;
    estimatedTokens: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
} {
    let tokens = 0;
    let userMsgs = 0;
    let assistantMsgs = 0;
    let toolCalls = 0;

    for (const m of messages) {
        tokens += estimateTokens(m.content || '');
        if (m.role === 'user') userMsgs++;
        if (m.role === 'assistant') assistantMsgs++;
        if (m.toolCalls) toolCalls += m.toolCalls.length;
    }

    return {
        messageCount: messages.length,
        estimatedTokens: tokens,
        userMessages: userMsgs,
        assistantMessages: assistantMsgs,
        toolCalls,
    };
}

/**
 * Inject RAG context into messages before the agent turn.
 * Queries the RAG vector store with the latest user message and prepends
 * relevant chunks as a system message.
 */
export async function injectRagContext(
    messages: ChatMessage[],
    topK: number = 3,
): Promise<ChatMessage[]> {
    // Find the last user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg?.content) return messages;

    try {
        const ragContext = await getRagContext(lastUserMsg.content, topK);
        if (!ragContext) return messages;

        logger.debug(COMPONENT, `Injecting RAG context (${ragContext.length} chars) for query: "${lastUserMsg.content.slice(0, 80)}"`);

        const ragMessage: ChatMessage = {
            role: 'system',
            content: `[Relevant knowledge from ingested documents]\n${ragContext}`,
        };

        // Insert RAG context before the last user message
        const result = [...messages];
        const lastUserIndex = result.lastIndexOf(lastUserMsg);
        if (lastUserIndex >= 0) {
            result.splice(lastUserIndex, 0, ragMessage);
        } else {
            result.push(ragMessage);
        }
        return result;
    } catch (e) {
        logger.debug(COMPONENT, `RAG context injection failed: ${(e as Error).message}`);
        return messages;
    }
}

/**
 * Assemble context with plugin hooks.
 * Runs RAG injection first (built-in), then all registered plugins.
 */
export async function assembleContextWithPlugins(
    messages: ChatMessage[],
    userMessage: string,
    ragTopK: number = 3,
): Promise<ChatMessage[]> {
    // Built-in RAG injection as first step
    let result = await injectRagContext(messages, ragTopK);

    // Run registered plugin assemble hooks
    const plugins = getPlugins();
    if (plugins.length > 0) {
        result = await runAssemble(plugins, result, userMessage);
    }

    return result;
}

/**
 * Compact context with plugin hooks.
 * Runs built-in smart context first, then all registered plugins.
 */
export async function compactContextWithPlugins(
    messages: ChatMessage[],
    maxTokens: number,
): Promise<ChatMessage[]> {
    // Built-in smart context compaction
    let result = buildSmartContext(messages, maxTokens);

    // Run registered plugin compact hooks
    const plugins = getPlugins();
    if (plugins.length > 0) {
        result = await runCompact(plugins, result, maxTokens);
    }

    return result;
}
