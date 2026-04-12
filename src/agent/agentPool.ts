/**
 * TITAN — Agent Pool
 *
 * Maintains warm agent instances for reuse across multiple tasks.
 * Keyed by template + model. Preserves conversation history between tasks.
 * LRU eviction when pool is full. Idle timeout for cleanup.
 */
import type { ChatMessage } from '../providers/base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'AgentPool';

// ── Types ─────────────────────────────────────────────────────────
export interface PooledAgent {
    id: string;
    template: string;
    model: string;
    messages: ChatMessage[];
    toolsUsed: string[];
    roundsCompleted: number;
    lastUsedAt: number;
    status: 'idle' | 'busy';
    taskCount: number;
}

export interface PoolConfig {
    maxSize: number;
    idleTimeoutMs: number;
    maxMessagesPerAgent: number;
}

export interface PoolStats {
    total: number;
    idle: number;
    busy: number;
    hits: number;
    misses: number;
    hitRate: number;
}

// ── State ─────────────────────────────────────────────────────────
const pool = new Map<string, PooledAgent>();
let hits = 0;
let misses = 0;
let idCounter = 0;
let evictionTimer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_CONFIG: PoolConfig = {
    maxSize: 5,
    idleTimeoutMs: 300_000, // 5 minutes
    maxMessagesPerAgent: 50,
};

let config = { ...DEFAULT_CONFIG };

// ── Pool Key ──────────────────────────────────────────────────────
function poolKey(template: string, model: string): string {
    return `${template}:${model}`;
}

// ── Core Functions ────────────────────────────────────────────────

/**
 * Initialize the pool with optional config overrides.
 * Starts the idle eviction timer.
 */
export function initPool(overrides?: Partial<PoolConfig>): void {
    if (overrides) config = { ...DEFAULT_CONFIG, ...overrides };

    // Start eviction timer
    if (evictionTimer) clearInterval(evictionTimer);
    evictionTimer = setInterval(evictIdle, 60_000);
    evictionTimer.unref();

    logger.info(COMPONENT, `Pool initialized: maxSize=${config.maxSize}, idleTimeout=${config.idleTimeoutMs}ms`);
}

/**
 * Acquire an idle agent matching the template and model.
 * Returns the pooled agent or null if no match available.
 */
export function acquireAgent(template: string, model: string): PooledAgent | null {
    const key = poolKey(template, model);

    // Look for an idle agent with matching key
    for (const [, agent] of pool) {
        if (agent.template === template && agent.model === model && agent.status === 'idle') {
            agent.status = 'busy';
            agent.lastUsedAt = Date.now();
            hits++;
            logger.info(COMPONENT, `Pool HIT: reusing ${agent.id} (${template}/${model}, ${agent.taskCount} prior tasks)`);
            return agent;
        }
    }

    misses++;
    logger.debug(COMPONENT, `Pool MISS: no idle agent for ${key}`);
    return null;
}

/**
 * Release an agent back to the pool after task completion.
 * Trims message history and marks as idle.
 */
export function releaseAgent(
    agentId: string,
    messages: ChatMessage[],
    toolsUsed: string[],
    roundsCompleted: number,
): void {
    const agent = pool.get(agentId);
    if (!agent) {
        // New agent — create pool entry
        if (pool.size >= config.maxSize) {
            evictLRU();
        }
        // Don't pool if still at capacity after eviction
        if (pool.size >= config.maxSize) {
            logger.debug(COMPONENT, `Pool full, discarding agent ${agentId}`);
            return;
        }
    }

    // Trim messages to max
    const trimmed = trimMessages(messages, config.maxMessagesPerAgent);

    if (agent) {
        agent.messages = trimmed;
        agent.toolsUsed = [...new Set([...agent.toolsUsed, ...toolsUsed])];
        agent.roundsCompleted += roundsCompleted;
        agent.lastUsedAt = Date.now();
        agent.status = 'idle';
        agent.taskCount++;
    } else {
        pool.set(agentId, {
            id: agentId,
            template: '', // Will be set by caller
            model: '',
            messages: trimmed,
            toolsUsed,
            roundsCompleted,
            lastUsedAt: Date.now(),
            status: 'idle',
            taskCount: 1,
        });
    }

    logger.debug(COMPONENT, `Agent ${agentId} released to pool (${trimmed.length} messages, ${toolsUsed.length} tools)`);
}

/**
 * Create a new pooled agent entry.
 */
export function createPooledAgent(template: string, model: string): PooledAgent {
    const id = `pool-${template}-${++idCounter}`;

    if (pool.size >= config.maxSize) {
        evictLRU();
    }

    const agent: PooledAgent = {
        id,
        template,
        model,
        messages: [],
        toolsUsed: [],
        roundsCompleted: 0,
        lastUsedAt: Date.now(),
        status: 'busy',
        taskCount: 0,
    };

    pool.set(id, agent);
    logger.info(COMPONENT, `Created pooled agent: ${id} (${template}/${model})`);
    return agent;
}

/**
 * Get pool statistics.
 */
export function getPoolStats(): PoolStats {
    let idle = 0;
    let busy = 0;
    for (const agent of pool.values()) {
        if (agent.status === 'idle') idle++;
        else busy++;
    }

    const total = hits + misses;
    return {
        total: pool.size,
        idle,
        busy,
        hits,
        misses,
        hitRate: total > 0 ? Math.round((hits / total) * 100) : 0,
    };
}

// ── Internal ──────────────────────────────────────────────────────

/** Evict the least recently used idle agent */
function evictLRU(): void {
    let oldest: PooledAgent | null = null;
    let oldestKey = '';

    for (const [key, agent] of pool) {
        if (agent.status !== 'idle') continue;
        if (!oldest || agent.lastUsedAt < oldest.lastUsedAt) {
            oldest = agent;
            oldestKey = key;
        }
    }

    if (oldest) {
        pool.delete(oldestKey);
        logger.info(COMPONENT, `Evicted LRU agent: ${oldest.id} (idle for ${Math.round((Date.now() - oldest.lastUsedAt) / 1000)}s)`);
    }
}

/** Evict all agents idle longer than the timeout */
function evictIdle(): void {
    const now = Date.now();
    for (const [key, agent] of pool) {
        if (agent.status === 'idle' && now - agent.lastUsedAt > config.idleTimeoutMs) {
            pool.delete(key);
            logger.info(COMPONENT, `Evicted idle agent: ${agent.id} (timeout)`);
        }
    }
}

/** Trim message history, keeping system messages and most recent */
function trimMessages(messages: ChatMessage[], maxCount: number): ChatMessage[] {
    if (messages.length <= maxCount) return [...messages];

    // Keep system messages + last N non-system messages
    const system = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const kept = nonSystem.slice(-Math.max(maxCount - system.length, 10));

    return [...system, ...kept];
}

/** Clear the entire pool (for testing/shutdown) */
export function clearPool(): void {
    pool.clear();
    hits = 0;
    misses = 0;
    if (evictionTimer) {
        clearInterval(evictionTimer);
        evictionTimer = null;
    }
}
