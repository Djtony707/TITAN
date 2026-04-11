/**
 * TITAN — Learning Engine
 * Continuous self-improvement: learns from interactions, tracks patterns,
 * builds a knowledge base, and improves tool selection over time.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Learning';
const KNOWLEDGE_FILE = join(TITAN_HOME, 'knowledge.json');

export interface LearningEntry {
    id: string;
    type: 'skill_usage' | 'error_pattern' | 'user_correction' | 'successful_pattern' | 'fact' | 'preference';
    category: string;
    content: string;
    context?: string;
    score: number;          // confidence/usefulness score (0-1)
    accessCount: number;    // how often this knowledge was retrieved
    createdAt: string;
    updatedAt: string;
}

/** Tool preference by task type (Phase 4 — Active Learning) */
interface ToolPreference {
    tool: string;
    successRate: number;
    totalUses: number;
}

/** Strategy memory — records what approaches worked for task patterns */
interface StrategyEntry {
    pattern: string;           // Task pattern description
    toolsUsed: string[];       // Deduplicated set
    toolSequence?: string[];   // Ordered sequence of tool calls (preserves order + repeats)
    taskType?: string;         // Classified task type (coding, research, etc.)
    roundCount: number;
    success: boolean;
    successCount?: number;     // How many times this sequence has succeeded
    failCount?: number;        // How many times this strategy failed after being applied
    lastValidated?: string;    // ISO timestamp of last successful validation
    timestamp: string;
}

interface KnowledgeBase {
    entries: LearningEntry[];
    toolSuccessRates: Record<string, { success: number; fail: number; total: number }>;
    /** Tool success rates segmented by task type (coding, research, analysis, etc.) */
    toolPreferencesByType: Record<string, Record<string, { success: number; total: number }>>;
    /** Strategy memory — top 50 strategies, evicted by age + success */
    strategies: StrategyEntry[];
    errorPatterns: Record<string, { count: number; lastSeen: string; resolution?: string }>;
    userCorrections: Array<{ original: string; correction: string; timestamp: string }>;
    conversationInsights: Array<{ topic: string; outcome: string; toolsUsed: string[]; timestamp: string }>;
}

let kb: KnowledgeBase | null = null;

function loadKnowledgeBase(): KnowledgeBase {
    if (kb) return kb;
    ensureDir(TITAN_HOME);
    if (existsSync(KNOWLEDGE_FILE)) {
        try {
            kb = JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf-8'));
            // Ensure fields exist
            kb!.entries = kb!.entries || [];
            kb!.toolSuccessRates = kb!.toolSuccessRates || {};
            kb!.toolPreferencesByType = kb!.toolPreferencesByType || {};
            kb!.strategies = kb!.strategies || [];
            kb!.errorPatterns = kb!.errorPatterns || {};
            kb!.userCorrections = kb!.userCorrections || [];
            kb!.conversationInsights = kb!.conversationInsights || [];
        } catch {
            kb = createEmptyKB();
        }
    } else {
        kb = createEmptyKB();
    }
    return kb!;
}

function createEmptyKB(): KnowledgeBase {
    return {
        entries: [],
        toolSuccessRates: {},
        toolPreferencesByType: {},
        strategies: [],
        errorPatterns: {},
        userCorrections: [],
        conversationInsights: [],
    };
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(): void {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (!kb) return;
        ensureDir(TITAN_HOME);
        try {
            writeFileSync(KNOWLEDGE_FILE, JSON.stringify(kb, null, 2), 'utf-8');
        } catch (err) {
            logger.error(COMPONENT, `Failed to save knowledge base: ${(err as Error).message}`);
        }
    }, 2000);
}

/** Initialize the learning engine */
export function initLearning(): void {
    loadKnowledgeBase();
    logger.info(COMPONENT, `Learning engine initialized (${kb?.entries.length ?? 0} knowledge entries)`);
}

/** Record a tool execution result for learning */
export function recordToolResult(toolName: string, success: boolean, context?: string, error?: string): void {
    const k = loadKnowledgeBase();

    // Update tool success rates
    if (!k.toolSuccessRates[toolName]) {
        k.toolSuccessRates[toolName] = { success: 0, fail: 0, total: 0 };
    }
    k.toolSuccessRates[toolName].total++;
    if (success) {
        k.toolSuccessRates[toolName].success++;
    } else {
        k.toolSuccessRates[toolName].fail++;
        // Track error patterns
        if (error) {
            const pattern = error.slice(0, 200);
            if (!k.errorPatterns[pattern]) {
                k.errorPatterns[pattern] = { count: 0, lastSeen: '' };
            }
            k.errorPatterns[pattern].count++;
            k.errorPatterns[pattern].lastSeen = new Date().toISOString();
        }
    }

    debouncedSave();
}

/** Record a successful interaction pattern */
export function recordSuccessPattern(pattern: {
    topic: string;
    toolsUsed: string[];
    outcome: string;
}): void {
    const k = loadKnowledgeBase();
    k.conversationInsights.push({
        ...pattern,
        timestamp: new Date().toISOString(),
    });
    // Keep last 500 insights
    if (k.conversationInsights.length > 500) {
        k.conversationInsights = k.conversationInsights.slice(-500);
    }
    debouncedSave();
}

/** Record a user correction to learn from mistakes */
export function recordUserCorrection(original: string, correction: string): void {
    const k = loadKnowledgeBase();
    k.userCorrections.push({
        original,
        correction,
        timestamp: new Date().toISOString(),
    });
    if (k.userCorrections.length > 200) {
        k.userCorrections = k.userCorrections.slice(-200);
    }
    debouncedSave();
}

/** Learn a new fact or update an existing one */
export function learnFact(category: string, content: string, context?: string): void {
    const k = loadKnowledgeBase();
    const id = `${category}:${content.slice(0, 50)}`;
    const existing = k.entries.findIndex((e) => e.id === id);

    if (existing >= 0) {
        k.entries[existing].score = Math.min(k.entries[existing].score + 0.1, 1.0);
        k.entries[existing].accessCount++;
        k.entries[existing].updatedAt = new Date().toISOString();
    } else {
        k.entries.push({
            id,
            type: 'fact',
            category,
            content,
            context,
            score: 0.5,
            accessCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    }
    // Keep entries under 2000
    if (k.entries.length > 2000) {
        // Remove lowest-scored entries
        k.entries.sort((a, b) => b.score - a.score);
        k.entries = k.entries.slice(0, 1500);
    }
    debouncedSave();
}

/** Query the knowledge base for relevant information */
export function queryKnowledge(query: string, category?: string, limit: number = 10): LearningEntry[] {
    const k = loadKnowledgeBase();
    const q = query.toLowerCase();

    const results = k.entries.filter((e) => {
        const matchesQuery = e.content.toLowerCase().includes(q) ||
            e.category.toLowerCase().includes(q) ||
            (e.context && e.context.toLowerCase().includes(q));
        const matchesCategory = !category || e.category === category;
        return matchesQuery && matchesCategory;
    });

    // Sort by score (most useful first), then by recency
    results.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.updatedAt.localeCompare(a.updatedAt);
    });

    // Boost access count for retrieved entries
    for (const entry of results.slice(0, limit)) {
        entry.accessCount++;
        entry.score = Math.min(entry.score + 0.01, 1.0);
    }

    debouncedSave();
    return results.slice(0, limit);
}

/** Get tool recommendations based on historical success rates */
export function getToolRecommendations(): Record<string, number> {
    const k = loadKnowledgeBase();
    const recommendations: Record<string, number> = {};

    for (const [tool, stats] of Object.entries(k.toolSuccessRates)) {
        if (stats.total > 0) {
            recommendations[tool] = stats.success / stats.total;
        }
    }

    return recommendations;
}

/**
 * TITAN pattern: Memory staleness verification
 * Before acting on learned knowledge, verify it's still current.
 * Strategies unvalidated for 30+ days lose 20% successCount.
 * Knowledge entries older than 60 days get flagged as potentially stale.
 */
export function verifyMemoryStaleness(): { pruned: number; decayed: number } {
    const k = loadKnowledgeBase();
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
    let pruned = 0;
    let decayed = 0;

    // Decay strategies unvalidated for 30+ days
    for (const strategy of k.strategies) {
        const lastValidated = strategy.lastValidated ? new Date(strategy.lastValidated).getTime() : new Date(strategy.timestamp).getTime();
        if (now - lastValidated > THIRTY_DAYS && (strategy.successCount || 0) > 0) {
            strategy.successCount = Math.floor((strategy.successCount || 0) * 0.8);
            decayed++;
        }
    }

    // Remove knowledge entries older than 60 days with low scores
    const before = k.entries.length;
    k.entries = k.entries.filter(e => {
        const age = now - new Date(e.timestamp).getTime();
        return age < SIXTY_DAYS || e.score > 0.7;
    });
    pruned = before - k.entries.length;

    // Remove error patterns not seen in 30+ days
    for (const [pattern, info] of Object.entries(k.errorPatterns)) {
        if (now - new Date(info.lastSeen).getTime() > THIRTY_DAYS) {
            delete k.errorPatterns[pattern];
            pruned++;
        }
    }

    if (pruned > 0 || decayed > 0) {
        saveKnowledgeBase(k);
        logger.info(COMPONENT, `Memory staleness check: ${pruned} pruned, ${decayed} strategies decayed`);
    }

    return { pruned, decayed };
}

/** Get learning summary for the system prompt */
export function getLearningContext(): string {
    const k = loadKnowledgeBase();
    const parts: string[] = [];

    // Recent high-score knowledge
    const topEntries = k.entries
        .filter((e) => e.score > 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    if (topEntries.length > 0) {
        parts.push('Key learned facts:');
        for (const e of topEntries) {
            parts.push(`- [${e.category}] ${e.content}`);
        }
    }

    // Tool recommendations
    const toolRecs = getToolRecommendations();
    const bestTools = Object.entries(toolRecs)
        .filter(([_, rate]) => rate > 0.8)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    if (bestTools.length > 0) {
        parts.push('\nMost reliable tools:');
        for (const [tool, rate] of bestTools) {
            parts.push(`- ${tool}: ${Math.round(rate * 100)}% success rate`);
        }
    }

    // Common error patterns to avoid
    const frequentErrors = Object.entries(k.errorPatterns)
        .filter(([_, info]) => info.count > 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 3);

    if (frequentErrors.length > 0) {
        parts.push('\nCommon errors to avoid:');
        for (const [pattern, info] of frequentErrors) {
            parts.push(`- ${pattern.slice(0, 100)} (seen ${info.count}x)${info.resolution ? ` → Fix: ${info.resolution}` : ''}`);
        }
    }

    return parts.join('\n');
}

/** Get per-tool reliability warnings/boosts for tool description injection */
export function getToolWarnings(): Record<string, string> {
    const k = loadKnowledgeBase();
    const warnings: Record<string, string> = {};

    for (const [tool, stats] of Object.entries(k.toolSuccessRates)) {
        if (stats.total < 10) continue; // Need enough data to be meaningful
        const rate = stats.success / stats.total;
        if (rate < 0.3) {
            warnings[tool] = `[LOW RELIABILITY: ${Math.round(rate * 100)}% success rate over ${stats.total} uses]`;
        } else if (rate > 0.9) {
            warnings[tool] = `[HIGHLY RELIABLE: ${Math.round(rate * 100)}% success rate]`;
        }
    }

    return warnings;
}

/** Record when a tool failure is resolved by using a different tool */
export function recordErrorResolution(errorPattern: string, resolution: string): void {
    const k = loadKnowledgeBase();
    const pattern = errorPattern.slice(0, 200);
    if (k.errorPatterns[pattern]) {
        k.errorPatterns[pattern].resolution = resolution;
    } else {
        k.errorPatterns[pattern] = { count: 1, lastSeen: new Date().toISOString(), resolution };
    }
    debouncedSave();
}

/** Get stats about the learning system */
export function getLearningStats(): {
    knowledgeEntries: number;
    toolsTracked: number;
    errorPatterns: number;
    corrections: number;
    insights: number;
    strategies: number;
    taskTypes: number;
} {
    const k = loadKnowledgeBase();
    return {
        knowledgeEntries: k.entries.length,
        toolsTracked: Object.keys(k.toolSuccessRates).length,
        errorPatterns: Object.keys(k.errorPatterns).length,
        corrections: k.userCorrections.length,
        insights: k.conversationInsights.length,
        strategies: k.strategies.length,
        taskTypes: Object.keys(k.toolPreferencesByType).length,
    };
}

// ── Phase 4: Active Learning ──────────────────────────────────────

/** Classify a message into a task type for preference tracking */
export function classifyTaskType(message: string): string {
    const lower = message.toLowerCase();
    if (/\b(code|function|class|typescript|python|script|debug|compile|build)\b/.test(lower)) return 'coding';
    if (/\b(search|research|find|look up|investigate|compare)\b/.test(lower)) return 'research';
    if (/\b(analy[sz]e|data|csv|chart|graph|statistics|metrics)\b/.test(lower)) return 'analysis';
    if (/\b(write|draft|blog|article|email|message|story)\b/.test(lower)) return 'writing';
    if (/\b(deploy|server|docker|kubernetes|ci|cd|infrastructure)\b/.test(lower)) return 'devops';
    if (/\b(file|folder|directory|rename|move|copy|delete)\b/.test(lower)) return 'filesystem';
    if (/\b(schedule|cron|automat|workflow|remind)\b/.test(lower)) return 'automation';
    return 'general';
}

/** Record a tool result against a specific task type */
export function recordToolPreference(toolName: string, taskType: string, success: boolean): void {
    const k = loadKnowledgeBase();
    if (!k.toolPreferencesByType[taskType]) {
        k.toolPreferencesByType[taskType] = {};
    }
    if (!k.toolPreferencesByType[taskType][toolName]) {
        k.toolPreferencesByType[taskType][toolName] = { success: 0, total: 0 };
    }

    k.toolPreferencesByType[taskType][toolName].total++;
    if (success) k.toolPreferencesByType[taskType][toolName].success++;
    debouncedSave();
}

/** Get ranked tool preferences for a task type */
export function getToolPreferences(taskType: string): ToolPreference[] {
    const k = loadKnowledgeBase();
    const prefs = k.toolPreferencesByType[taskType];
    if (!prefs) return [];

    return Object.entries(prefs)
        .filter(([, stats]) => stats.total >= 3) // Minimum sample size
        .map(([tool, stats]) => ({
            tool,
            successRate: stats.success / stats.total,
            totalUses: stats.total,
        }))
        .sort((a, b) => b.successRate - a.successRate);
}

/** Generate human-readable preference hints from collected tool-preference data */
export function getLearnedPreferenceHints(taskType: string): string | null {
    const prefs = getToolPreferences(taskType);
    if (prefs.length < 2) return null;

    const lines: string[] = [];
    const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir'];
    const shellPref = prefs.find(p => p.tool === 'shell');

    // Find cases where shell has lower success than dedicated tools
    for (const dt of prefs.filter(p => FILE_TOOLS.includes(p.tool))) {
        if (shellPref && dt.successRate > shellPref.successRate && dt.totalUses >= 3) {
            lines.push(
                `prefer ${dt.tool} (${Math.round(dt.successRate * 100)}% success) ` +
                `over shell (${Math.round(shellPref.successRate * 100)}% success)`,
            );
        }
    }

    // Surface top tools for this task type if no shell comparison available
    if (lines.length === 0) {
        const top3 = prefs.slice(0, 3);
        if (top3.length >= 2) {
            lines.push(`best tools: ${top3.map(p => `${p.tool} (${Math.round(p.successRate * 100)}%)`).join(', ')}`);
        }
    }

    return lines.length > 0 ? `For ${taskType} tasks: ${lines.join('; ')}` : null;
}

/** Record a successful strategy for future reference */
export function recordStrategy(
    message: string,
    toolsUsed: string[],
    roundCount: number,
    success: boolean,
    toolSequence?: string[],
): void {
    const k = loadKnowledgeBase();
    const taskType = classifyTaskType(message);

    // Check if a similar sequence already exists — merge instead of duplicating
    if (success && toolSequence && toolSequence.length > 0) {
        const seqKey = toolSequence.join('→');
        const existing = k.strategies.find(
            s => s.success && s.taskType === taskType && s.toolSequence?.join('→') === seqKey,
        );
        if (existing) {
            existing.successCount = (existing.successCount || 1) + 1;
            existing.timestamp = new Date().toISOString();
            debouncedSave();
            return;
        }
    }

    const entry: StrategyEntry = {
        pattern: message.slice(0, 200),
        toolsUsed: [...new Set(toolsUsed)],
        toolSequence: toolSequence?.slice(0, 20), // Cap sequence length
        taskType,
        roundCount,
        success,
        successCount: success ? 1 : 0,
        timestamp: new Date().toISOString(),
    };

    k.strategies.push(entry);

    // Evict old/failed strategies to keep at 200 max
    if (k.strategies.length > 200) {
        // Sort: keep high-success + recent, evict failed + old + low-success
        k.strategies.sort((a, b) => {
            if (a.success !== b.success) return a.success ? -1 : 1;
            const aCount = a.successCount || 1;
            const bCount = b.successCount || 1;
            if (aCount !== bCount) return bCount - aCount;
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });
        k.strategies = k.strategies.slice(0, 200);
    }

    debouncedSave();
}

/** Record outcome of an applied strategy (feedback loop) */
export function recordStrategyOutcome(
    taskType: string,
    toolSequence: string[],
    succeeded: boolean,
): void {
    const k = loadKnowledgeBase();
    const seqKey = toolSequence.join('→');
    const match = k.strategies.find(
        s => s.taskType === taskType && s.toolSequence?.join('→') === seqKey,
    );
    if (!match) return;

    if (succeeded) {
        match.successCount = (match.successCount || 1) + 1;
        match.lastValidated = new Date().toISOString();
    } else {
        match.failCount = (match.failCount || 0) + 1;
    }

    // High-fail strategies get marked as unsuccessful
    if ((match.failCount || 0) > (match.successCount || 1)) {
        match.success = false;
    }

    debouncedSave();
}

/** Decay unvalidated strategies — called on every getStrategyHints */
function decayStrategies(strategies: StrategyEntry[]): boolean {
    const now = Date.now();
    let changed = false;

    for (const s of strategies) {
        const lastValidated = s.lastValidated
            ? new Date(s.lastValidated).getTime()
            : new Date(s.timestamp).getTime();
        const daysSinceValidated = (now - lastValidated) / 86400000;

        // Strategies not validated in 30 days: reduce successCount by 20%
        if (daysSinceValidated > 30 && (s.successCount || 1) > 1) {
            s.successCount = Math.max(1, Math.floor((s.successCount || 1) * 0.8));
            changed = true;
        }

        // High-fail strategies get excluded
        if ((s.failCount || 0) > (s.successCount || 1) && s.success) {
            s.success = false;
            changed = true;
        }
    }

    return changed;
}

/** Get strategy hints for a similar task */
export function getStrategyHints(message: string): string | null {
    const k = loadKnowledgeBase();

    // Apply decay to stale strategies
    if (decayStrategies(k.strategies)) {
        debouncedSave();
    }
    if (k.strategies.length === 0) return null;

    const taskType = classifyTaskType(message);
    const words = new Set(message.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (words.size === 0) return null;

    const successfulStrategies = k.strategies.filter(s => s.success);
    if (successfulStrategies.length === 0) return null;

    // Score strategies by: task type match + keyword overlap + success count
    let bestMatch: StrategyEntry | null = null;
    let bestScore = 0;

    for (const strategy of successfulStrategies) {
        const patternWords = new Set(strategy.pattern.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        let overlap = 0;
        for (const w of words) {
            if (patternWords.has(w)) overlap++;
        }
        const keywordScore = overlap / Math.max(words.size, patternWords.size);

        // Task type match bonus (0.2)
        const typeBonus = strategy.taskType === taskType ? 0.2 : 0;

        // Success count bonus (normalized, max 0.15)
        const countBonus = Math.min((strategy.successCount || 1) / 10, 0.15);

        const totalScore = keywordScore + typeBonus + countBonus;
        if (totalScore > bestScore && keywordScore > 0.15) {
            bestScore = totalScore;
            bestMatch = strategy;
        }
    }

    if (!bestMatch) return null;

    // Prefer showing the ordered sequence if available
    const toolInfo = bestMatch.toolSequence && bestMatch.toolSequence.length > 0
        ? bestMatch.toolSequence.join(' → ')
        : bestMatch.toolsUsed.join(', ');

    const countInfo = (bestMatch.successCount || 1) > 1
        ? ` (succeeded ${bestMatch.successCount}x)`
        : '';

    return `For similar ${bestMatch.taskType || 'general'} tasks, a proven tool sequence: ${toolInfo} (${bestMatch.roundCount} rounds)${countInfo}.`;
}

/** Get error resolution if a known pattern matches */
export function getErrorResolution(error: string): string | null {
    const k = loadKnowledgeBase();
    const errorLower = error.toLowerCase();

    for (const [pattern, info] of Object.entries(k.errorPatterns)) {
        if (info.resolution && errorLower.includes(pattern.toLowerCase().slice(0, 50))) {
            return info.resolution;
        }
    }
    return null;
}
