/**
 * Gap 3 (plan-this-logical-ocean) — Stale-lock adoption tests.
 *
 * Verifies the new behavior: a registered agent whose heartbeat is older
 * than the adoption threshold gets its lock stolen by a second agent
 * instead of blocking it forever (up to checkoutTimeoutMs). Unknown
 * agents (never heartbeat) still block, to avoid regressions in the
 * existing double-checkout safety invariant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'events';

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/agent/daemon.js', () => {
    const ee = new EventEmitter();
    ee.setMaxListeners(100);
    return { titanEvents: ee };
});

vi.mock('../src/agent/goals.js', () => ({
    listGoals: vi.fn(() => []),
}));

vi.mock('../src/agent/multiAgent.js', () => ({
    listAgents: vi.fn(() => []),
}));

vi.mock('fs', () => ({
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: vi.fn(),
}));

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return {
        ...actual,
        TITAN_MD_FILENAME: 'TITAN.md',
        TITAN_HOME: '/tmp/titan-stale-adopt-test',
    };
});

import {
    initCommandPost, shutdownCommandPost, checkoutTask,
    registerAgent, reportHeartbeat, getActivity,
} from '../src/agent/commandPost.js';

const defaultConfig = {
    enabled: true,
    heartbeatIntervalMs: 60000,
    maxConcurrentAgents: 5,
    checkoutTimeoutMs: 1800000, // 30 min
    activityBufferSize: 100,
};

describe('commandPost — stale-lock adoption (Gap 3)', () => {
    beforeEach(() => {
        shutdownCommandPost();
        initCommandPost(defaultConfig);
    });

    afterEach(() => {
        shutdownCommandPost();
    });

    it('blocks a different-agent checkout when holder is not in registry (safety preserved)', () => {
        // agent-a has never heartbeated — treat as unknown, not stale.
        // This preserves the original "prevent double checkout by different agent" invariant.
        checkoutTask('g1', 'st-1', 'agent-a');
        const second = checkoutTask('g1', 'st-1', 'agent-b');
        expect(second).toBeNull();
    });

    it('blocks a different-agent checkout when holder heartbeat is fresh', () => {
        const a = registerAgent({ name: 'agent-a', role: 'scout', title: 'A', status: 'active' });
        reportHeartbeat(a.id);
        checkoutTask('g1', 'st-1', a.id);
        const second = checkoutTask('g1', 'st-1', 'agent-b');
        expect(second).toBeNull();
    });

    it('allows adoption when holder heartbeat is stale', () => {
        const a = registerAgent({ name: 'agent-a', role: 'scout', title: 'A', status: 'active' });
        // Force the heartbeat to an old timestamp (10 min ago)
        reportHeartbeat(a.id);
        // Reach into the registry and backdate the heartbeat. We don't expose
        // a setter, so simulate by sleeping would be too slow; instead use fake
        // timers.
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now + 10 * 60 * 1000); // +10 min, > 5 min threshold

        checkoutTask('g1', 'st-1', a.id);
        // Advance clock further so the checkout itself is also "stale" from
        // agent-a's perspective
        vi.setSystemTime(now + 20 * 60 * 1000);

        const second = checkoutTask('g1', 'st-1', 'agent-b');
        vi.useRealTimers();

        expect(second).not.toBeNull();
        expect(second!.agentId).toBe('agent-b');
        // Fresh runId, not agent-a's
        expect(second!.status).toBe('locked');
    });

    it('logs an adoption activity entry', () => {
        const a = registerAgent({ name: 'agent-a', role: 'scout', title: 'A', status: 'active' });
        reportHeartbeat(a.id);
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now + 10 * 60 * 1000);
        checkoutTask('g1', 'st-2', a.id);
        vi.setSystemTime(now + 20 * 60 * 1000);
        const adopted = checkoutTask('g1', 'st-2', 'agent-b');
        vi.useRealTimers();

        expect(adopted).not.toBeNull();
        const activity = getActivity({ type: 'task_checkout', limit: 20 });
        const adoption = activity.find(e => e.message.includes('adopted stale lock'));
        expect(adoption).toBeDefined();
        expect(adoption!.agentId).toBe('agent-b');
    });

    it('same-agent re-adopt still works (no regression)', () => {
        const a = registerAgent({ name: 'agent-a', role: 'scout', title: 'A', status: 'active' });
        reportHeartbeat(a.id);
        const first = checkoutTask('g1', 'st-3', a.id);
        const second = checkoutTask('g1', 'st-3', a.id);
        expect(second).not.toBeNull();
        expect(second!.agentId).toBe(a.id);
        expect(second!.runId).toBe(first!.runId);
    });
});
