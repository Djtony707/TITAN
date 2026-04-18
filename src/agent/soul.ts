/**
 * TITAN — Soul System
 *
 * Persistent inner monologue and self-model that evolves across sessions.
 * The Soul tracks TITAN's understanding of the current task, its confidence
 * level, chosen strategy, and accumulated wisdom from past interactions.
 *
 * Three components:
 *   1. Session State — ephemeral, tracks current task understanding
 *   2. Persistent Wisdom — file-based, survives restarts
 *   3. Heartbeat — per-round status emitted via SSE
 *
 * Inspired by OpenClaw's proactive agent loop and MemGPT's inner monologue.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { titanEvents } from './daemon.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Soul';
const SOUL_DIR = join(TITAN_HOME, 'soul');
const WISDOM_FILE = join(SOUL_DIR, 'wisdom.json');
const STATE_FILE = join(SOUL_DIR, 'session-state.json');

// ── Types ───────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low' | 'lost';
export type Strategy = 'direct' | 'explore' | 'plan' | 'ask_user' | 'delegate';

export interface SoulState {
    /** What TITAN thinks it's trying to accomplish */
    taskUnderstanding: string;
    /** How confident TITAN is in its approach */
    confidence: Confidence;
    /** Current strategy being employed */
    strategy: Strategy;
    /** What TITAN has tried so far this session */
    attempts: string[];
    /** What TITAN has learned this session */
    insights: string[];
    /** Current round in the agent loop */
    round: number;
    /** Tools used so far */
    toolsUsed: string[];
    /** Last updated timestamp */
    updatedAt: string;
}

export interface Wisdom {
    /** Task patterns and what strategies worked */
    patterns: Array<{
        taskType: string;
        bestStrategy: Strategy;
        avgRounds: number;
        successRate: number;
        learnedAt: string;
    }>;
    /** Common mistakes to avoid */
    mistakes: Array<{
        description: string;
        avoidance: string;
        learnedAt: string;
    }>;
    /** User preferences learned over time */
    userPreferences: Array<{
        preference: string;
        confidence: number;
        learnedAt: string;
    }>;
    /** Total tasks completed */
    totalTasks: number;
    /** Average confidence at task completion */
    avgConfidence: number;
    lastUpdated: string;
}

export interface Heartbeat {
    sessionId: string;
    round: number;
    phase: string;
    confidence: Confidence;
    strategy: Strategy;
    taskUnderstanding: string;
    toolsPending: number;
    timestamp: string;
}

// ── Session State ───────────────────────────────────────────────

const sessionStates: Map<string, SoulState> = new Map();

/**
 * Initialize or reset soul state for a session.
 *
 * v4.4.5: `strategyOverride` lets callers force a specific strategy
 * instead of the regex-based `inferStrategy()`. Phone calls use
 * `strategyOverride='direct'` because any conversational "what are
 * you up to?" utterance would otherwise trip the explore branch,
 * which triggers 30+ second deep-research flows — fatal for a
 * real-time voice call.
 */
export function initSoulState(
    sessionId: string,
    message: string,
    strategyOverride?: Strategy,
): SoulState {
    const state: SoulState = {
        taskUnderstanding: inferTaskUnderstanding(message),
        confidence: 'medium',
        strategy: strategyOverride ?? inferStrategy(message),
        attempts: [],
        insights: [],
        round: 0,
        toolsUsed: [],
        updatedAt: new Date().toISOString(),
    };
    sessionStates.set(sessionId, state);
    return state;
}

/** Get current soul state for a session */
export function getSoulState(sessionId: string): SoulState | undefined {
    return sessionStates.get(sessionId);
}

/** Update soul state after a tool call or round completion */
export function updateSoulState(
    sessionId: string,
    update: Partial<Pick<SoulState, 'confidence' | 'strategy' | 'round' | 'taskUnderstanding'>>,
    toolUsed?: string,
    insight?: string,
): void {
    const state = sessionStates.get(sessionId);
    if (!state) return;

    if (update.confidence) state.confidence = update.confidence;
    if (update.strategy) state.strategy = update.strategy;
    if (update.round !== undefined) state.round = update.round;
    if (update.taskUnderstanding) state.taskUnderstanding = update.taskUnderstanding;
    if (toolUsed) state.toolsUsed.push(toolUsed);
    if (insight) state.insights.push(insight);
    state.updatedAt = new Date().toISOString();
}

/** Record an attempt (what was tried) */
export function recordAttempt(sessionId: string, description: string): void {
    const state = sessionStates.get(sessionId);
    if (state) {
        state.attempts.push(description);
        if (state.attempts.length > 10) state.attempts.shift(); // Ring buffer
    }
}

/** Emit a heartbeat for real-time monitoring */
export function emitHeartbeat(sessionId: string, phase: string, toolsPending: number): void {
    const state = sessionStates.get(sessionId);
    if (!state) return;

    const heartbeat: Heartbeat = {
        sessionId,
        round: state.round,
        phase,
        confidence: state.confidence,
        strategy: state.strategy,
        taskUnderstanding: state.taskUnderstanding,
        toolsPending,
        timestamp: new Date().toISOString(),
    };

    titanEvents.emit('soul:heartbeat', heartbeat);
}

/** Build inner monologue text for system prompt injection */
export function getInnerMonologue(sessionId: string): string | null {
    const state = sessionStates.get(sessionId);
    if (!state || state.round === 0) return null;

    const parts: string[] = [];
    parts.push(`[Inner State] Round ${state.round} | Confidence: ${state.confidence} | Strategy: ${state.strategy}`);

    if (state.attempts.length > 0) {
        parts.push(`What I've tried: ${state.attempts.slice(-3).join('; ')}`);
    }

    if (state.insights.length > 0) {
        parts.push(`What I've learned: ${state.insights.slice(-3).join('; ')}`);
    }

    // Adjust behavior based on confidence
    if (state.confidence === 'low') {
        parts.push('I am uncertain about my approach. I should try a different strategy or ask for clarification.');
    } else if (state.confidence === 'lost') {
        parts.push('I have lost track of the task. I should summarize what I know and ask the user for guidance.');
    }

    return parts.join('\n');
}

/** Clean up session state */
export function clearSoulState(sessionId: string): void {
    sessionStates.delete(sessionId);
}

// ── Persistent Wisdom ───────────────────────────────────────────

function ensureSoulDir(): void {
    if (!existsSync(SOUL_DIR)) mkdirSync(SOUL_DIR, { recursive: true });
}

function loadWisdom(): Wisdom {
    try {
        if (existsSync(WISDOM_FILE)) {
            return JSON.parse(readFileSync(WISDOM_FILE, 'utf-8')) as Wisdom;
        }
    } catch { /* corrupted — start fresh */ }

    return {
        patterns: [],
        mistakes: [],
        userPreferences: [],
        totalTasks: 0,
        avgConfidence: 0.7,
        lastUpdated: new Date().toISOString(),
    };
}

function saveWisdom(wisdom: Wisdom): void {
    ensureSoulDir();
    wisdom.lastUpdated = new Date().toISOString();
    writeFileSync(WISDOM_FILE, JSON.stringify(wisdom, null, 2));
}

/** After task completion, consolidate learnings into wisdom */
export function consolidateWisdom(sessionId: string, taskType: string, success: boolean, rounds: number): void {
    const state = sessionStates.get(sessionId);
    if (!state) return;

    const wisdom = loadWisdom();

    // Update task count and average confidence
    wisdom.totalTasks++;
    const confScore = state.confidence === 'high' ? 1 : state.confidence === 'medium' ? 0.7 : state.confidence === 'low' ? 0.4 : 0.1;
    wisdom.avgConfidence = (wisdom.avgConfidence * (wisdom.totalTasks - 1) + confScore) / wisdom.totalTasks;

    // Record pattern
    const existingPattern = wisdom.patterns.find(p => p.taskType === taskType);
    if (existingPattern) {
        const n = existingPattern.successRate * 10; // Rough sample size
        existingPattern.successRate = (existingPattern.successRate * n + (success ? 1 : 0)) / (n + 1);
        existingPattern.avgRounds = (existingPattern.avgRounds * n + rounds) / (n + 1);
        if (success) existingPattern.bestStrategy = state.strategy;
    } else {
        wisdom.patterns.push({
            taskType,
            bestStrategy: state.strategy,
            avgRounds: rounds,
            successRate: success ? 1 : 0,
            learnedAt: new Date().toISOString(),
        });
    }

    // Cap patterns at 50
    if (wisdom.patterns.length > 50) {
        wisdom.patterns = wisdom.patterns.slice(-50);
    }

    // Record mistakes from insights
    for (const insight of state.insights) {
        if (insight.toLowerCase().includes('error') || insight.toLowerCase().includes('failed') || insight.toLowerCase().includes('wrong')) {
            wisdom.mistakes.push({
                description: insight.slice(0, 200),
                avoidance: `For ${taskType} tasks, consider: ${state.strategy}`,
                learnedAt: new Date().toISOString(),
            });
        }
    }
    if (wisdom.mistakes.length > 30) wisdom.mistakes = wisdom.mistakes.slice(-30);

    saveWisdom(wisdom);
    logger.info(COMPONENT, `Wisdom consolidated: ${taskType} ${success ? 'success' : 'failure'}, ${rounds} rounds, confidence=${state.confidence}`);
}

/** Get wisdom hints for system prompt */
export function getWisdomHints(taskType: string): string | null {
    const wisdom = loadWisdom();
    const parts: string[] = [];

    // Best strategy for this task type
    const pattern = wisdom.patterns.find(p => p.taskType === taskType);
    if (pattern && pattern.successRate > 0.5) {
        parts.push(`For ${taskType} tasks: strategy "${pattern.bestStrategy}" works best (${Math.round(pattern.successRate * 100)}% success, avg ${pattern.avgRounds.toFixed(1)} rounds)`);
    }

    // Recent mistakes to avoid
    const recentMistakes = wisdom.mistakes.slice(-3);
    if (recentMistakes.length > 0) {
        parts.push(`Avoid: ${recentMistakes.map(m => m.description.slice(0, 60)).join('; ')}`);
    }

    return parts.length > 0 ? parts.join('\n') : null;
}

/** Get full wisdom data (for API) */
export function getWisdomData(): Wisdom {
    return loadWisdom();
}

// ── Task Understanding Inference ────────────────────────────────

function inferTaskUnderstanding(message: string): string {
    const lower = message.toLowerCase();

    if (/\b(read|show|display|what|tell me)\b/.test(lower)) return 'Information retrieval';
    if (/\b(write|create|make|generate|build)\b/.test(lower)) return 'Content creation';
    if (/\b(fix|debug|repair|solve|resolve)\b/.test(lower)) return 'Problem solving';
    if (/\b(edit|change|modify|update|replace)\b/.test(lower)) return 'Modification';
    if (/\b(search|find|look|research)\b/.test(lower)) return 'Research';
    if (/\b(run|execute|install|deploy)\b/.test(lower)) return 'Execution';
    if (/\b(plan|design|architect|strategy)\b/.test(lower)) return 'Planning';

    return 'General task';
}

function inferStrategy(message: string): Strategy {
    const lower = message.toLowerCase();

    // Direct action — clear single-step intent
    if (/\b(read|write|run|execute|list)\b.*\b(file|command|directory)\b/.test(lower)) return 'direct';

    // Exploration — need to discover before acting
    if (/\b(find|search|what|where|how many)\b/.test(lower)) return 'explore';

    // Planning — complex multi-step tasks
    if (/\b(plan|design|build|implement|create.*full)\b/.test(lower)) return 'plan';

    // Delegation — sub-agent tasks
    if (/\b(research|investigate|analyze.*all)\b/.test(lower)) return 'delegate';

    return 'direct';
}
