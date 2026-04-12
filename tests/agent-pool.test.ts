import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    acquireAgent, releaseAgent, createPooledAgent,
    getPoolStats, clearPool, initPool,
} from '../src/agent/agentPool.js';

beforeEach(() => {
    vi.useFakeTimers();
    clearPool();
    initPool({ maxSize: 3, idleTimeoutMs: 5000, maxMessagesPerAgent: 10 });
});

afterEach(() => { vi.useRealTimers(); clearPool(); });

describe('Agent Pool', () => {
    it('returns null on empty pool', () => {
        expect(acquireAgent('coder', 'model-a')).toBeNull();
        expect(getPoolStats().misses).toBe(1);
    });

    it('creates and acquires pooled agents', () => {
        const agent = createPooledAgent('coder', 'model-a');
        expect(agent.template).toBe('coder');
        releaseAgent(agent.id, [{ role: 'user', content: 'test' }], ['shell'], 3);

        const acquired = acquireAgent('coder', 'model-a');
        expect(acquired).not.toBeNull();
        expect(acquired!.id).toBe(agent.id);
        expect(acquired!.status).toBe('busy');
        expect(getPoolStats().hits).toBe(1);
    });

    it('does not match different template', () => {
        const agent = createPooledAgent('coder', 'model-a');
        releaseAgent(agent.id, [], [], 0);
        expect(acquireAgent('explorer', 'model-a')).toBeNull();
    });

    it('does not match different model', () => {
        const agent = createPooledAgent('coder', 'model-a');
        releaseAgent(agent.id, [], [], 0);
        expect(acquireAgent('coder', 'model-b')).toBeNull();
    });

    it('evicts LRU when pool is full', () => {
        const a1 = createPooledAgent('coder', 'm1');
        releaseAgent(a1.id, [], [], 0);
        vi.advanceTimersByTime(100);

        const a2 = createPooledAgent('explorer', 'm1');
        releaseAgent(a2.id, [], [], 0);
        vi.advanceTimersByTime(100);

        const a3 = createPooledAgent('analyst', 'm1');
        releaseAgent(a3.id, [], [], 0);

        // Pool is full (3). Creating a 4th should evict a1 (oldest)
        createPooledAgent('browser', 'm1');
        expect(getPoolStats().total).toBeLessThanOrEqual(3);
    });

    it('trims messages on release', () => {
        const agent = createPooledAgent('coder', 'model-a');
        const messages = Array.from({ length: 20 }, (_, i) => ({
            role: 'user' as const,
            content: `msg ${i}`,
        }));
        releaseAgent(agent.id, messages, [], 5);

        const acquired = acquireAgent('coder', 'model-a');
        expect(acquired!.messages.length).toBeLessThanOrEqual(10);
    });

    it('tracks pool stats', () => {
        const agent = createPooledAgent('coder', 'model-a');
        releaseAgent(agent.id, [], [], 0);

        acquireAgent('coder', 'model-a'); // hit
        acquireAgent('explorer', 'model-a'); // miss

        const stats = getPoolStats();
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(1);
        expect(stats.hitRate).toBe(50);
    });
});
