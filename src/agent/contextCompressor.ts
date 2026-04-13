/**
 * TITAN — 5-Phase Context Compression Pipeline
 *
 * Dramatically better than naive truncation. Inspired by Hermes context_compressor.py.
 *
 * Phases:
 * 1. Tool output pruning — replace old tool results with summaries (no LLM call)
 * 2. Head protection — system + first 3 user messages never compressed
 * 3. Tail protection — last N messages never compressed (5% of budget, cap 12K tokens)
 * 4. Middle summarization — structured summary template
 * 5. Iterative updates — update existing summary instead of regenerating
 */
import { estimateTokens } from './contextManager.js';
import logger from '../utils/logger.js';
import type { ChatMessage } from '../providers/base.js';

const COMPONENT = 'ContextCompressor';

// ── Structured Summary ────────────────────────────────────────────
export interface StructuredSummary {
    goal: string;
    progress: string[];
    keyDecisions: string[];
    filesModified: string[];
    nextSteps: string[];
    criticalContext: string[];
    toolsUsed: string[];
}

export interface CompressionResult {
    messages: ChatMessage[];
    summary: StructuredSummary | null;
    savedTokens: number;
    phasesApplied: string[];
}

// ── Summary marker for detection ──────────────────────────────────
const SUMMARY_MARKER = '## Conversation Summary';

// ── Phase 1: Tool Output Pruning ──────────────────────────────────
function pruneToolOutputs(messages: ChatMessage[], keepLastN: number = 2): ChatMessage[] {
    // Find indices of tool messages from the end
    const toolIndices: number[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'tool') {
            toolIndices.push(i);
        }
    }

    if (toolIndices.length <= keepLastN) return messages;

    const keepSet = new Set(toolIndices.slice(0, keepLastN));

    return messages.map((msg, i) => {
        if (msg.role !== 'tool' || keepSet.has(i)) return msg;
        const content = msg.content || '';
        if (content.length <= 300) return msg; // Short results are fine

        const isError = content.toLowerCase().includes('error');
        const status = isError ? 'FAILED' : 'OK';
        const preview = content.slice(0, 120).replace(/\n/g, ' ');
        return {
            ...msg,
            content: `[Tool result for ${msg.name || 'tool'}: ${status}] ${preview}...`,
        };
    });
}

// ── Phase 2: Head Protection ──────────────────────────────────────
function extractHead(messages: ChatMessage[]): { head: ChatMessage[]; rest: ChatMessage[] } {
    const head: ChatMessage[] = [];
    let nonSystemCount = 0;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'system') {
            head.push(msg);
        } else {
            nonSystemCount++;
            head.push(msg);
            if (nonSystemCount >= 3) {
                return { head, rest: messages.slice(i + 1) };
            }
        }
    }

    // All messages fit in head
    return { head, rest: [] };
}

// ── Phase 3: Tail Protection ──────────────────────────────────────
function extractTail(
    messages: ChatMessage[],
    tokenBudget: number,
): { tail: ChatMessage[]; middle: ChatMessage[] } {
    // 5% of total budget, capped at 12K tokens
    const tailBudget = Math.min(Math.floor(tokenBudget * 0.05), 12000);

    let tailTokens = 0;
    let tailStart = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
        const tokens = estimateTokens(messages[i].content || '') +
            (messages[i].toolCalls ? messages[i].toolCalls!.length * 100 : 0);
        if (tailTokens + tokens > tailBudget) break;
        tailTokens += tokens;
        tailStart = i;
    }

    return {
        tail: messages.slice(tailStart),
        middle: messages.slice(0, tailStart),
    };
}

// ── Phase 4: Heuristic Summary Extraction ─────────────────────────
function extractSummaryFromMessages(messages: ChatMessage[]): StructuredSummary {
    const goal = extractGoal(messages);
    const progress: string[] = [];
    const keyDecisions: string[] = [];
    const filesModified: string[] = [];
    const toolsUsed: string[] = [];
    const criticalContext: string[] = [];

    const filePathPattern = /(?:\/[\w./-]+\.\w+|[\w./-]+\.(?:ts|js|py|rs|go|tsx|jsx|json|md|yaml|yml|toml|sh|css|html))/g;
    const seenFiles = new Set<string>();
    const seenTools = new Set<string>();

    for (const msg of messages) {
        const content = msg.content || '';

        // Extract file paths
        const filePaths = content.match(filePathPattern);
        if (filePaths) {
            for (const fp of filePaths) {
                if (!seenFiles.has(fp)) {
                    seenFiles.add(fp);
                    filesModified.push(fp);
                }
            }
        }

        // Extract tool names
        if (msg.role === 'tool' && msg.name && !seenTools.has(msg.name)) {
            seenTools.add(msg.name);
            toolsUsed.push(msg.name);
        }
        if (msg.toolCalls) {
            for (const tc of msg.toolCalls) {
                const name = tc.function?.name || '';
                if (name && !seenTools.has(name)) {
                    seenTools.add(name);
                    toolsUsed.push(name);
                }
            }
        }

        // Extract progress from tool results
        if (msg.role === 'tool') {
            const isError = content.toLowerCase().includes('error');
            const preview = content.slice(0, 80).replace(/\n/g, ' ');
            progress.push(`${msg.name || 'tool'}: ${isError ? 'FAILED' : 'OK'} — ${preview}`);
        }

        // Extract decisions from assistant messages
        if (msg.role === 'assistant' && content.length > 50) {
            const decisionMatch = content.match(/(?:I'll|Let me|Going to|decided to|choosing|using)\s+(.{10,80})/i);
            if (decisionMatch) {
                keyDecisions.push(decisionMatch[1].replace(/\n/g, ' ').trim());
            }
        }
    }

    return {
        goal,
        progress: progress.slice(-10), // Last 10 progress items
        keyDecisions: keyDecisions.slice(-5),
        filesModified: filesModified.slice(0, 20),
        nextSteps: [], // Can't determine from messages alone
        criticalContext,
        toolsUsed,
    };
}

function extractGoal(messages: ChatMessage[]): string {
    // First user message typically contains the goal
    const firstUser = messages.find(m => m.role === 'user');
    if (firstUser?.content) {
        return firstUser.content.slice(0, 200).replace(/\n/g, ' ');
    }
    return 'Unknown';
}

// ── Phase 5: Iterative Summary Update ─────────────────────────────
function mergeSummaries(existing: StructuredSummary, update: StructuredSummary): StructuredSummary {
    const mergeUnique = (a: string[], b: string[]) => {
        const set = new Set(a);
        for (const item of b) {
            if (!set.has(item)) {
                set.add(item);
            }
        }
        return [...set];
    };

    return {
        goal: update.goal || existing.goal,
        progress: mergeUnique(existing.progress, update.progress).slice(-15),
        keyDecisions: mergeUnique(existing.keyDecisions, update.keyDecisions).slice(-8),
        filesModified: mergeUnique(existing.filesModified, update.filesModified).slice(0, 30),
        nextSteps: update.nextSteps.length > 0 ? update.nextSteps : existing.nextSteps,
        criticalContext: mergeUnique(existing.criticalContext, update.criticalContext).slice(-5),
        toolsUsed: mergeUnique(existing.toolsUsed, update.toolsUsed),
    };
}

function formatSummary(summary: StructuredSummary): string {
    const sections: string[] = [SUMMARY_MARKER];

    sections.push(`**Goal:** ${summary.goal}`);

    if (summary.progress.length > 0) {
        sections.push(`**Progress:**\n${summary.progress.map(p => `- ${p}`).join('\n')}`);
    }

    if (summary.keyDecisions.length > 0) {
        sections.push(`**Key Decisions:**\n${summary.keyDecisions.map(d => `- ${d}`).join('\n')}`);
    }

    if (summary.filesModified.length > 0) {
        sections.push(`**Relevant Files:** ${summary.filesModified.join(', ')}`);
    }

    if (summary.toolsUsed.length > 0) {
        sections.push(`**Tools Used:** ${summary.toolsUsed.join(', ')}`);
    }

    if (summary.nextSteps.length > 0) {
        sections.push(`**Next Steps:**\n${summary.nextSteps.map(s => `- ${s}`).join('\n')}`);
    }

    if (summary.criticalContext.length > 0) {
        sections.push(`**Critical Context:**\n${summary.criticalContext.map(c => `- ${c}`).join('\n')}`);
    }

    return sections.join('\n\n');
}

// ── Find existing summary in messages ─────────────────────────────
function findExistingSummary(messages: ChatMessage[]): StructuredSummary | null {
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content?.includes(SUMMARY_MARKER)) {
            return parseSummary(msg.content);
        }
    }
    return null;
}

function parseSummary(text: string): StructuredSummary {
    const getSection = (label: string): string[] => {
        const regex = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\n\\*\\*|$)`, 'i');
        const match = text.match(regex);
        if (!match) return [];
        const content = match[1].trim();
        // Check if it's a bullet list
        if (content.includes('\n-')) {
            return content.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
        }
        return content ? [content] : [];
    };

    const goalMatch = text.match(/\*\*Goal:\*\*\s*(.+)/);

    return {
        goal: goalMatch?.[1]?.trim() || 'Unknown',
        progress: getSection('Progress'),
        keyDecisions: getSection('Key Decisions'),
        filesModified: getSection('Relevant Files')[0]?.split(', ') || [],
        nextSteps: getSection('Next Steps'),
        criticalContext: getSection('Critical Context'),
        toolsUsed: getSection('Tools Used')[0]?.split(', ') || [],
    };
}

// ── Main Pipeline ─────────────────────────────────────────────────
/**
 * 5-phase context compression pipeline.
 *
 * @param messages - Full conversation messages
 * @param tokenBudget - Maximum tokens for the compressed output
 * @param existingSummary - Previous summary to update iteratively (Phase 5)
 */
export function compressContext(
    messages: ChatMessage[],
    tokenBudget: number,
    existingSummary?: StructuredSummary | null,
): CompressionResult {
    if (messages.length <= 6) {
        return { messages, summary: null, savedTokens: 0, phasesApplied: [] };
    }

    const beforeTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
    if (beforeTokens <= tokenBudget) {
        return { messages, summary: null, savedTokens: 0, phasesApplied: [] };
    }

    const phasesApplied: string[] = [];

    // Phase 1: Tool output pruning (no LLM call)
    const working = pruneToolOutputs(messages, 2);
    phasesApplied.push('tool_pruning');

    // Check if pruning was enough
    const afterPruneTokens = working.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
    if (afterPruneTokens <= tokenBudget) {
        return {
            messages: working,
            summary: null,
            savedTokens: beforeTokens - afterPruneTokens,
            phasesApplied,
        };
    }

    // Phase 2: Head protection
    const { head, rest } = extractHead(working);
    phasesApplied.push('head_protection');

    if (rest.length === 0) {
        return { messages: working, summary: null, savedTokens: 0, phasesApplied };
    }

    // Phase 3: Tail protection
    const headTokens = head.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
    const { tail, middle } = extractTail(rest, tokenBudget - headTokens);
    phasesApplied.push('tail_protection');

    if (middle.length === 0) {
        // No middle to summarize — just head + tail
        const result = [...head, ...tail];
        const afterTokens = result.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
        return { messages: result, summary: null, savedTokens: beforeTokens - afterTokens, phasesApplied };
    }

    // Phase 4: Structured summary of middle messages
    const newSummary = extractSummaryFromMessages(middle);
    phasesApplied.push('structured_summary');

    // Phase 5: Iterative update if we have an existing summary
    let finalSummary: StructuredSummary;
    const prevSummary = existingSummary || findExistingSummary(head);
    if (prevSummary) {
        finalSummary = mergeSummaries(prevSummary, newSummary);
        phasesApplied.push('iterative_update');
    } else {
        finalSummary = newSummary;
    }

    // Build the summary message
    const summaryText = formatSummary(finalSummary);
    const summaryMessage: ChatMessage = { role: 'system', content: summaryText };

    // Remove any old summary from head (it's now merged into finalSummary)
    const cleanHead = head.filter(m =>
        !(m.role === 'system' && m.content?.includes(SUMMARY_MARKER)),
    );

    // Reassemble: head + summary + tail
    const result = [...cleanHead, summaryMessage, ...tail];
    const afterTokens = result.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);

    logger.info(COMPONENT, `5-phase compression: ${messages.length} → ${result.length} messages, ` +
        `${beforeTokens} → ${afterTokens} tokens (saved ${beforeTokens - afterTokens}), ` +
        `phases: ${phasesApplied.join(', ')}`);

    return {
        messages: result,
        summary: finalSummary,
        savedTokens: Math.max(0, beforeTokens - afterTokens),
        phasesApplied,
    };
}
