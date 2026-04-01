/**
 * TITAN — Command Post Tests
 * Agent governance layer: task checkout, budget policies, goal ancestry, agent registry, activity feed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'events';

// Mock dependencies before importing the module
vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/agent/daemon.js', () => {
    const ee = new EventEmitter();
    ee.setMaxListeners(100);
    return { titanEvents: ee };
});

vi.mock('../src/agent/goals.js', () => ({
    listGoals: vi.fn(() => [
        { id: 'g1', title: 'Mission Alpha', status: 'active', progress: 50, subtasks: [], parentGoalId: undefined },
        { id: 'g2', title: 'Project Beta', status: 'active', progress: 25, subtasks: [], parentGoalId: 'g1' },
        { id: 'g3', title: 'Task Gamma', status: 'active', progress: 0, subtasks: [], parentGoalId: 'g2' },
    ]),
}));

vi.mock('../src/agent/multiAgent.js', () => ({
    listAgents: vi.fn(() => [
        { id: 'default', name: 'TITAN Primary', model: 'anthropic/claude-sonnet-4-20250514', status: 'running', channelBindings: [], messageCount: 0, createdAt: new Date().toISOString(), lastActive: new Date().toISOString() },
    ]),
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

vi.mock('../src/utils/constants.js', () => ({
    TITAN_HOME: '/tmp/titan-test',
}));

import {
    initCommandPost, shutdownCommandPost, checkoutTask, checkinTask,
    getActiveCheckouts, createBudgetPolicy, getBudgetPolicies, deleteBudgetPolicy,
    updateBudgetPolicy, recordSpend, getAncestryChain, getGoalTree,
    getRegisteredAgents, reportHeartbeat, getActivity, getDashboard,
} from '../src/agent/commandPost.js';

const defaultConfig = {
    enabled: true,
    heartbeatIntervalMs: 60000,
    maxConcurrentAgents: 5,
    checkoutTimeoutMs: 1800000,
    activityBufferSize: 100,
};

describe('Command Post', () => {
    beforeEach(() => {
        shutdownCommandPost();
        initCommandPost(defaultConfig);
    });

    afterEach(() => {
        shutdownCommandPost();
    });

    // ── Task Checkout ────────────────────────────────────────

    describe('Task Checkout', () => {
        it('should checkout a task successfully', () => {
            const lock = checkoutTask('g1', 'st-1', 'agent-a');
            expect(lock).not.toBeNull();
            expect(lock!.status).toBe('locked');
            expect(lock!.agentId).toBe('agent-a');
            expect(lock!.subtaskId).toBe('st-1');
        });

        it('should prevent double checkout by different agent', () => {
            checkoutTask('g1', 'st-1', 'agent-a');
            const second = checkoutTask('g1', 'st-1', 'agent-b');
            expect(second).toBeNull();
        });

        it('should allow same agent to re-checkout (adopt)', () => {
            checkoutTask('g1', 'st-1', 'agent-a');
            const readopt = checkoutTask('g1', 'st-1', 'agent-a');
            expect(readopt).not.toBeNull();
            expect(readopt!.agentId).toBe('agent-a');
        });

        it('should checkin and release lock', () => {
            const lock = checkoutTask('g1', 'st-1', 'agent-a')!;
            const ok = checkinTask('st-1', lock.runId);
            expect(ok).toBe(true);
            expect(getActiveCheckouts()).toHaveLength(0);
        });

        it('should reject checkin with wrong runId', () => {
            checkoutTask('g1', 'st-1', 'agent-a');
            const ok = checkinTask('st-1', 'wrong-run-id');
            expect(ok).toBe(false);
        });

        it('should allow checkout after release', () => {
            const lock = checkoutTask('g1', 'st-1', 'agent-a')!;
            checkinTask('st-1', lock.runId);
            const newLock = checkoutTask('g1', 'st-1', 'agent-b');
            expect(newLock).not.toBeNull();
            expect(newLock!.agentId).toBe('agent-b');
        });

        it('should list active checkouts', () => {
            checkoutTask('g1', 'st-1', 'agent-a');
            checkoutTask('g2', 'st-2', 'agent-b');
            expect(getActiveCheckouts()).toHaveLength(2);
        });
    });

    // ── Budget Policies ──────────────────────────────────────

    describe('Budget Policies', () => {
        it('should create a budget policy', () => {
            const policy = createBudgetPolicy({
                name: 'Daily Global', scope: { type: 'global' },
                period: 'daily', limitUsd: 10,
                warningThresholdPercent: 80, action: 'pause', enabled: true,
            });
            expect(policy.id).toBeDefined();
            expect(policy.name).toBe('Daily Global');
            expect(policy.currentSpend).toBe(0);
        });

        it('should list budget policies', () => {
            createBudgetPolicy({ name: 'P1', scope: { type: 'global' }, period: 'daily', limitUsd: 5, warningThresholdPercent: 80, action: 'warn', enabled: true });
            createBudgetPolicy({ name: 'P2', scope: { type: 'agent', targetId: 'a1' }, period: 'monthly', limitUsd: 50, warningThresholdPercent: 80, action: 'pause', enabled: true });
            expect(getBudgetPolicies()).toHaveLength(2);
        });

        it('should delete a budget policy', () => {
            const p = createBudgetPolicy({ name: 'Delete Me', scope: { type: 'global' }, period: 'daily', limitUsd: 1, warningThresholdPercent: 80, action: 'warn', enabled: true });
            expect(deleteBudgetPolicy(p.id)).toBe(true);
            expect(getBudgetPolicies()).toHaveLength(0);
        });

        it('should update a budget policy', () => {
            const p = createBudgetPolicy({ name: 'Update Me', scope: { type: 'global' }, period: 'daily', limitUsd: 10, warningThresholdPercent: 80, action: 'warn', enabled: true });
            const updated = updateBudgetPolicy(p.id, { limitUsd: 20 });
            expect(updated).not.toBeNull();
            expect(updated!.limitUsd).toBe(20);
        });

        it('should track spend against global policy', () => {
            createBudgetPolicy({ name: 'Global', scope: { type: 'global' }, period: 'daily', limitUsd: 1, warningThresholdPercent: 50, action: 'warn', enabled: true });
            recordSpend('agent-a', undefined, 0.6);
            const policies = getBudgetPolicies();
            expect(policies[0].currentSpend).toBe(0.6);
        });

        it('should track spend against agent-scoped policy', () => {
            createBudgetPolicy({ name: 'Agent A', scope: { type: 'agent', targetId: 'agent-a' }, period: 'daily', limitUsd: 5, warningThresholdPercent: 80, action: 'pause', enabled: true });
            recordSpend('agent-a', undefined, 1.5);
            recordSpend('agent-b', undefined, 2.0); // should not count
            const policies = getBudgetPolicies();
            expect(policies[0].currentSpend).toBe(1.5);
        });
    });

    // ── Goal Ancestry ────────────────────────────────────────

    describe('Goal Ancestry', () => {
        it('should return ancestry chain from root to leaf', () => {
            const chain = getAncestryChain('g3');
            expect(chain).toHaveLength(3);
            expect(chain[0].id).toBe('g1'); // root
            expect(chain[1].id).toBe('g2');
            expect(chain[2].id).toBe('g3'); // leaf
        });

        it('should return single goal for root', () => {
            const chain = getAncestryChain('g1');
            expect(chain).toHaveLength(1);
            expect(chain[0].title).toBe('Mission Alpha');
        });

        it('should return empty for unknown goal', () => {
            const chain = getAncestryChain('nonexistent');
            expect(chain).toHaveLength(0);
        });

        it('should build goal tree', () => {
            const tree = getGoalTree();
            expect(tree).toHaveLength(1); // only g1 has no parent
            expect(tree[0].goal.id).toBe('g1');
            expect(tree[0].children).toHaveLength(1);
            expect(tree[0].children[0].goal.id).toBe('g2');
            expect(tree[0].children[0].children).toHaveLength(1);
            expect(tree[0].children[0].children[0].goal.id).toBe('g3');
        });
    });

    // ── Agent Registry ───────────────────────────────────────

    describe('Agent Registry', () => {
        it('should sync agents from multiAgent on init', () => {
            const agents = getRegisteredAgents();
            expect(agents.length).toBeGreaterThanOrEqual(1);
            expect(agents.find(a => a.id === 'default')).toBeDefined();
        });

        it('should accept heartbeat', () => {
            const ok = reportHeartbeat('default');
            expect(ok).toBe(true);
        });

        it('should reject heartbeat for unknown agent', () => {
            const ok = reportHeartbeat('nonexistent');
            expect(ok).toBe(false);
        });
    });

    // ── Activity Feed ────────────────────────────────────────

    describe('Activity Feed', () => {
        it('should record activity from checkouts', () => {
            checkoutTask('g1', 'st-1', 'agent-a');
            const activity = getActivity();
            expect(activity.length).toBeGreaterThanOrEqual(1);
            expect(activity.find(a => a.type === 'task_checkout')).toBeDefined();
        });

        it('should respect limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                checkoutTask(`g${i}`, `st-${i}`, `agent-${i}`);
            }
            const limited = getActivity({ limit: 3 });
            expect(limited).toHaveLength(3);
        });

        it('should filter by type', () => {
            checkoutTask('g1', 'st-1', 'agent-a');
            const lock = checkoutTask('g2', 'st-2', 'agent-b')!;
            checkinTask('st-2', lock.runId);
            const checkins = getActivity({ type: 'task_checkin' });
            expect(checkins.length).toBeGreaterThanOrEqual(1);
            expect(checkins.every(a => a.type === 'task_checkin')).toBe(true);
        });
    });

    // ── Dashboard ────────────────────────────────────────────

    describe('Dashboard', () => {
        it('should return aggregated dashboard data', () => {
            const dash = getDashboard();
            expect(dash).toHaveProperty('activeAgents');
            expect(dash).toHaveProperty('totalAgents');
            expect(dash).toHaveProperty('activeCheckouts');
            expect(dash).toHaveProperty('budgetUtilization');
            expect(dash).toHaveProperty('recentActivity');
            expect(dash).toHaveProperty('agents');
            expect(dash).toHaveProperty('checkouts');
            expect(dash).toHaveProperty('budgets');
            expect(dash).toHaveProperty('goalTree');
        });
    });
});
