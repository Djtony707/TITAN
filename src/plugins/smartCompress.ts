/**
 * TITAN — SmartCompress ContextEngine Plugin
 * Task-type-aware context compression inspired by SimpleMem (30x reduction)
 * and ReMe (81% context reduction, 90% quality retention).
 *
 * Strategies per task type:
 *   coding:   Keep full code outputs for last 3 tools, truncate older
 *   research: Keep search queries + counts, summarize fetched content
 *   analysis: Keep data shapes + stats, drop raw data
 *   general:  Keep last 8 turns, summarize rest
 */
import type { ContextEnginePlugin } from './contextEngine.js';
import type { ChatMessage } from '../providers/base.js';
import { classifyTaskType } from '../memory/learning.js';
import logger from '../utils/logger.js';

const COMPONENT = 'SmartCompress';

// ─── Configuration ─────���────────────────────────────────────────────────────

type Aggressiveness = 'conservative' | 'balanced' | 'aggressive';

interface SmartCompressConfig {
    aggressiveness: Aggressiveness;
}

const RELEVANCE_THRESHOLDS: Record<Aggressiveness, number> = {
    conservative: 0.1,
    balanced: 0.2,
    aggressive: 0.3,
};

const RECENCY_HALF_LIFE = 6; // messages

// ─── Relevance Scoring ────────���─────────────────────────────────────────────

function extractKeywords(text: string): Set<string> {
    return new Set(
        text.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 3)
            .map(w => w.replace(/[^a-z0-9]/g, ''))
            .filter(Boolean),
    );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const w of a) {
        if (b.has(w)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

interface ScoredMessage {
    message: ChatMessage;
    index: number;
    relevance: number;
}

function scoreMessages(
    messages: ChatMessage[],
    latestUserMessage: string,
    taskType: string,
): ScoredMessage[] {
    const latestKeywords = extractKeywords(latestUserMessage);
    const totalMessages = messages.length;

    return messages.map((msg, index) => {
        // System messages are always max relevance
        if (msg.role === 'system') {
            return { message: msg, index, relevance: 1.0 };
        }

        // Recency: exponential decay from the end
        const distanceFromEnd = totalMessages - 1 - index;
        const recency = Math.pow(0.5, distanceFromEnd / RECENCY_HALF_LIFE);

        // Keyword overlap with latest user message
        const msgKeywords = extractKeywords(typeof msg.content === 'string' ? msg.content : '');
        const keywordScore = jaccardSimilarity(latestKeywords, msgKeywords);

        // Tool results that contain errors score higher (preserve error context)
        const content = typeof msg.content === 'string' ? msg.content : '';
        const isError = msg.role === 'tool' && /error:|failed|exception|traceback/i.test(content);
        const errorBonus = isError ? 0.15 : 0;

        // Task type bonus: coding messages in coding context, etc.
        const taskBonus = detectMessageTaskType(content) === taskType ? 0.1 : 0;

        const relevance = Math.min(1.0, recency * 0.5 + keywordScore * 0.3 + errorBonus + taskBonus);

        return { message: msg, index, relevance };
    });
}

function detectMessageTaskType(content: string): string {
    if (/```|function |class |const |import |export |def |return /.test(content)) return 'coding';
    if (/search|found|results?|http|url|fetch/i.test(content)) return 'research';
    if (/data|column|row|average|count|statistics/i.test(content)) return 'analysis';
    return 'general';
}

// ─── Task-Specific Compression ──────────────────────────────────────────────

function compressToolResult(content: string, taskType: string, isRecent: boolean): string {
    if (isRecent) return content; // Keep recent results intact

    const lines = content.split('\n');

    switch (taskType) {
        case 'coding': {
            // Keep first and last 20 lines of code output
            if (lines.length <= 40) return content;
            const head = lines.slice(0, 20).join('\n');
            const tail = lines.slice(-20).join('\n');
            return `${head}\n... [${lines.length - 40} lines compressed] ...\n${tail}`;
        }
        case 'research': {
            // Keep first 200 chars + result summary
            if (content.length <= 300) return content;
            const summary = content.slice(0, 200);
            const urlCount = (content.match(/https?:\/\//g) || []).length;
            return `${summary}... [compressed, ${urlCount} URLs found, ${content.length} chars total]`;
        }
        case 'analysis': {
            // Keep data shapes, drop raw data
            if (content.length <= 300) return content;
            // Try to preserve header/column info
            const headerLines = lines.slice(0, 5).join('\n');
            const statLines = lines.filter(l => /total|average|mean|count|sum|min|max/i.test(l)).join('\n');
            return `${headerLines}\n${statLines}\n[compressed: ${lines.length} rows, ${content.length} chars]`;
        }
        default: {
            // General: keep first 150 chars
            if (content.length <= 200) return content;
            return `${content.slice(0, 150)}... [${content.length} chars compressed]`;
        }
    }
}

function compressMessage(msg: ChatMessage, taskType: string, isRecent: boolean): ChatMessage {
    const content = typeof msg.content === 'string' ? msg.content : '';

    if (msg.role === 'tool') {
        return { ...msg, content: compressToolResult(content, taskType, isRecent) };
    }

    if (msg.role === 'assistant' && content.length > 300 && !isRecent) {
        // Truncate long assistant responses, keep start + end
        const head = content.slice(0, 150);
        const tail = content.slice(-100);
        return { ...msg, content: `${head}... [compressed] ...${tail}` };
    }

    // User messages: keep intact (they contain intent)
    return msg;
}

// ─── Estimate Tokens ──────────��─────────────────────────────────────────────

function estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + Math.ceil(content.length / 4);
    }, 0);
}

// ─── Plugin Factory ─────────────��───────────────────────────────────────────

export function createSmartCompressPlugin(): ContextEnginePlugin {
    let config: SmartCompressConfig = { aggressiveness: 'balanced' };

    return {
        name: 'smartCompress',
        version: '1.0.0',

        async bootstrap(opts: Record<string, unknown>) {
            if (opts.aggressiveness && ['conservative', 'balanced', 'aggressive'].includes(opts.aggressiveness as string)) {
                config.aggressiveness = opts.aggressiveness as Aggressiveness;
            }
            logger.info(COMPONENT, `Initialized with aggressiveness=${config.aggressiveness}`);
        },

        async compact(context: ChatMessage[], maxTokens: number): Promise<ChatMessage[]> {
            const currentTokens = estimateTokens(context);
            if (currentTokens <= maxTokens) {
                return context; // Already within budget, no compression needed
            }

            // Find latest user message for relevance scoring
            const latestUser = [...context]
                .reverse()
                .find(m => m.role === 'user');
            const latestUserContent = latestUser && typeof latestUser.content === 'string'
                ? latestUser.content
                : '';

            const taskType = classifyTaskType(latestUserContent);
            const threshold = RELEVANCE_THRESHOLDS[config.aggressiveness];

            // Score all messages
            const scored = scoreMessages(context, latestUserContent, taskType);

            // Determine "recent" boundary: last 3 tool results kept intact, or last 4 messages if no tools
            const toolIndices = scored
                .filter(s => s.message.role === 'tool')
                .map(s => s.index);
            const recentToolCutoff = toolIndices.length >= 3
                ? toolIndices[toolIndices.length - 3]
                : Math.max(0, context.length - 4); // Fallback: last 4 messages are "recent"

            // Build compressed context
            const result: ChatMessage[] = [];
            let compressedCount = 0;

            for (const { message, index, relevance } of scored) {
                // System messages always pass through
                if (message.role === 'system') {
                    result.push(message);
                    continue;
                }

                const isRecent = index >= recentToolCutoff;

                if (relevance < threshold && !isRecent) {
                    // Aggressively compress low-relevance old messages
                    const content = typeof message.content === 'string' ? message.content : '';
                    if (content.length > 50) {
                        result.push({
                            ...message,
                            content: `${content.slice(0, 50)}... [compressed]`,
                        });
                        compressedCount++;
                    } else {
                        result.push(message);
                    }
                } else {
                    // Apply task-specific compression for medium-relevance messages
                    result.push(compressMessage(message, taskType, isRecent));
                    if (message !== compressMessage(message, taskType, isRecent)) {
                        compressedCount++;
                    }
                }
            }

            const newTokens = estimateTokens(result);
            if (compressedCount > 0) {
                logger.info(COMPONENT, `Compressed ${compressedCount} messages (${taskType} mode): ${currentTokens} → ${newTokens} tokens`);
            }

            return result;
        },
    };
}
