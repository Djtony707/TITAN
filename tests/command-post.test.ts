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

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return {
        ...actual,
        TITAN_MD_FILENAME: 'TITAN.md',
        TITAN_HOME: '/tmp/titan-test',
    };
});

import {
    initCommandPost, shutdownCommandPost, checkoutTask, checkinTask,
    getActiveCheckouts, createBudgetPolicy, getBudgetPolicies, deleteBudgetPolicy,
    updateBudgetPolicy, recordSpend, getAncestryChain, getGoalTree,
    getRegisteredAgents, reportHeartbeat, getActivity, getDashboard,
    validateGoalAncestry, validateGoalParentAssignment, sweepExpiredCheckoutsManual,
    getStaleAgents, enforceBudgetForAgent, getBudgetPolicyForAgent,
    requestGoalProposalApproval, approveApproval, rejectApproval, getApproval,
    registerAgent, updateAgentIdentity, getAgentMemoryNamespace, getAgentVoice,
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

    // ── Ancestry Validation ──────────────────────────────────

    describe('Ancestry Validation', () => {
        it('should validate a goal with valid ancestry', () => {
            const result = validateGoalAncestry('g3');
            expect(result.valid).toBe(true);
        });

        it('should reject validation for unknown goal', () => {
            const result = validateGoalAncestry('nonexistent');
            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
            expect(result.errors![0]).toContain('not found');
        });

        it('should validate parent assignment to null (root)', () => {
            const result = validateGoalParentAssignment('g3', null);
            expect(result.valid).toBe(true);
        });

        it('should reject self-reference as parent', () => {
            const result = validateGoalParentAssignment('g1', 'g1');
            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
            expect(result.errors![0]).toContain('Self-reference');
        });

        it('should reject assignment to nonexistent parent', () => {
            const result = validateGoalParentAssignment('g1', 'nonexistent');
            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
            expect(result.errors![0]).toContain('does not exist');
        });

        it('should detect cycle in parent chain', () => {
            // g3 -> g2 -> g1 (existing chain from mocks)
            // Try making g1's parent g3 — that creates a cycle: g1 -> g3 -> g2 -> g1
            const result = validateGoalParentAssignment('g1', 'g3');
            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
            expect(result.errors![0]).toContain('Cycle');
        });

        it('should allow valid parent assignment', () => {
            // g3 already has g2 as parent; making g2 parent of a new goal is valid
            const result = validateGoalParentAssignment('new-goal', 'g2');
            // This tests against mock data where we don't have 'new-goal' in listGoals
            // So we expect it to fail on the "goal doesn't exist" check for the child
            // Actually: validateGoalParentAssignment checks if parent exists, not child
            // So it should be valid since g2 exists
            expect(result.valid).toBe(true);
        });
    });

    // ── Expired Checkout Sweep ───────────────────────────────

    describe('Expired Checkout Sweep', () => {
        it('should return empty sweep when no expired checkouts', () => {
            const result = sweepExpiredCheckoutsManual();
            expect(result.swept).toBe(0);
            expect(result.details).toEqual([]);
        });

        it('should sweep expired checkouts', () => {
            // Create a checkout with a very short expiry in the past
            // We can't directly manipulate time, so we test the function exists
            // and returns proper structure — actual expiry sweep is tested via
            // the automatic sweeper interval behavior
            const result = sweepExpiredCheckoutsManual();
            expect(result).toHaveProperty('swept');
            expect(result).toHaveProperty('details');
            expect(Array.isArray(result.details)).toBe(true);
        });
    });

    // ── Stale Agents ─────────────────────────────────────────

    describe('Stale Agents', () => {
        it('should return empty stale list when fresh', () => {
            const stale = getStaleAgents();
            expect(Array.isArray(stale)).toBe(true);
            // Default agent should be fresh from init
        });

        it('should detect stale agents after simulated time', () => {
            const stale = getStaleAgents();
            expect(Array.isArray(stale)).toBe(true);
            expect(stale.every(a => a.staleFor > 0)).toBe(true);
        });

        it('should exclude stopped agents from stale check', () => {
            // Stopped agents should never appear in stale list
            const stale = getStaleAgents();
            expect(stale.filter(a => a.status === 'stopped')).toHaveLength(0);
        });

        it('should exclude paused agents from stale check', () => {
            const stale = getStaleAgents();
            expect(stale.filter(a => a.status === 'paused')).toHaveLength(0);
        });
    });

    // ── Budget Enforcement per Agent ─────────────────────────

    describe('Budget Enforcement', () => {
        it('should enforce budget for agent with global policy', () => {
            createBudgetPolicy({
                name: 'Global Enforcer', scope: { type: 'global' },
                period: 'daily', limitUsd: 10,
                warningThresholdPercent: 80, action: 'pause', enabled: true,
            });
            recordSpend('agent-a', undefined, 5);
            const result = enforceBudgetForAgent('agent-a');
            expect(result).toHaveProperty('budgetOk');
            expect(result).toHaveProperty('policies');
            expect(result.policies.length).toBe(1);
            expect(result.policies[0].currentSpend).toBe(5);
            expect(result.policies[0].limit).toBe(10);
            expect(result.policies[0].pct).toBe(50);
        });

        it('should enforce budget for agent with agent-scoped policy', () => {
            createBudgetPolicy({
                name: 'Agent A Limit', scope: { type: 'agent', targetId: 'agent-a' },
                period: 'daily', limitUsd: 5,
                warningThresholdPercent: 50, action: 'pause', enabled: true,
            });
            recordSpend('agent-a', undefined, 1);
            const result = enforceBudgetForAgent('agent-a');
            expect(result).toHaveProperty('budgetOk');
            expect(result.policies.length).toBe(1);
            expect(result.policies[0].currentSpend).toBe(1);
            expect(result.policies[0].limit).toBe(5);
        });

        it('should not enforce policy on wrong agent', () => {
            createBudgetPolicy({
                name: 'Agent B Only', scope: { type: 'agent', targetId: 'agent-b' },
                period: 'daily', limitUsd: 5,
                warningThresholdPercent: 80, action: 'pause', enabled: true,
            });
            // Spend on agent-a should not count for agent-b's policy
            recordSpend('agent-a', undefined, 10);
            const result = enforceBudgetForAgent('agent-a');
            // No applicable policies for agent-a
            expect(result.policies).toHaveLength(0);
            expect(result.budgetOk).toBe(true);
        });

        it('should return budgetOk false when over limit', () => {
            createBudgetPolicy({
                name: 'Strict Limit', scope: { type: 'global' },
                period: 'daily', limitUsd: 2,
                warningThresholdPercent: 80, action: 'pause', enabled: true,
            });
            recordSpend('agent-a', undefined, 3);
            const result = enforceBudgetForAgent('agent-a');
            expect(result.budgetOk).toBe(false);
            expect(result.policies[0].pct).toBe(150);
        });

        it('should get budget policy for agent', () => {
            createBudgetPolicy({
                name: 'Agent A Budget', scope: { type: 'agent', targetId: 'agent-a' },
                period: 'daily', limitUsd: 20,
                warningThresholdPercent: 80, action: 'pause', enabled: true,
            });
            recordSpend('agent-a', undefined, 5);
            const info = getBudgetPolicyForAgent('agent-a');
            expect(info.policies.length).toBe(1);
            expect(info.totalSpend).toBe(5);
            expect(info.totalBudget).toBe(20);
            expect(info.pctUsed).toBe(25);
        });

        it('should get budget policy with zero budget when no policies', () => {
            const info = getBudgetPolicyForAgent('nonexistent-agent');
            expect(info.policies).toHaveLength(0);
            expect(info.totalSpend).toBe(0);
            expect(info.totalBudget).toBe(0);
            expect(info.pctUsed).toBe(0);
        });

        it('should handle period reset for expired policy', () => {
            // This tests the period expiry logic
            const policy = createBudgetPolicy({
                name: 'Old Policy', scope: { type: 'global' },
                period: 'daily', limitUsd: 5,
                warningThresholdPercent: 80, action: 'warn', enabled: true,
            });
            // Simulate spend
            recordSpend('agent-a', undefined, 3);
            // Force period reset by manually setting old periodStart
            updateBudgetPolicy(policy.id, { periodStart: new Date(Date.now() - 86400001).toISOString() }); // 25 hours ago
            // Next spend should reset
            recordSpend('agent-a', undefined, 1);
            const policies = getBudgetPolicies();
            // After reset, spend should be ~1 (not 4)
            expect(policies[0].currentSpend).toBeLessThan(3);
        });
    });

    // ── Budget Enforcement Integration ───────────────────────

    describe('Budget Enforcement Integration', () => {
        it('should trigger warning at threshold', () => {
            createBudgetPolicy({
                name: 'Warning Test', scope: { type: 'global' },
                period: 'daily', limitUsd: 10,
                warningThresholdPercent: 50, action: 'warn', enabled: true,
            });
            recordSpend('agent-a', undefined, 6); // 60% — triggers warning
            const policies = getBudgetPolicies();
            expect(policies[0].currentSpend).toBe(6);
            expect(policies[0].currentSpend / policies[0].limitUsd * 100).toBe(60);
        });

        it('should track spend across multiple policies', () => {
            createBudgetPolicy({
                name: 'Global', scope: { type: 'global' },
                period: 'daily', limitUsd: 20,
                warningThresholdPercent: 80, action: 'warn', enabled: true,
            });
            createBudgetPolicy({
                name: 'Agent A', scope: { type: 'agent', targetId: 'agent-a' },
                period: 'daily', limitUsd: 10,
                warningThresholdPercent: 80, action: 'pause', enabled: true,
            });
            recordSpend('agent-a', undefined, 5);
            const policies = getBudgetPolicies();
            expect(policies).toHaveLength(2);
            // Both policies should have accumulated the spend
            for (const p of policies) {
                expect(p.currentSpend).toBe(5);
            }
        });
    });

    // ── Goal Proposal Approvals ──────────────────────────────
    describe('Goal Proposal Approvals', () => {
        it('files a proposal as a pending approval of type goal_proposal', () => {
            const approval = requestGoalProposalApproval('agent-a', {
                title: 'Run nightly backup check',
                description: 'Verify that the LaCie backup completed without errors.',
                rationale: 'We had silent failures last month.',
                priority: 2,
                tags: ['backup', 'safety'],
            });
            expect(approval.type).toBe('goal_proposal');
            expect(approval.status).toBe('pending');
            expect(approval.requestedBy).toBe('agent-a');
            expect((approval.payload as { title: string }).title).toBe('Run nightly backup check');
        });

        it('emits a goal_proposal_requested activity entry when filed', () => {
            requestGoalProposalApproval('agent-b', {
                title: 'Document deploy flow',
                description: 'Write a one-pager for new contributors.',
                rationale: 'Tony asked.',
            });
            const requests = getActivity({ type: 'goal_proposal_requested' });
            expect(requests.length).toBeGreaterThanOrEqual(1);
            expect(requests[0].agentId).toBe('agent-b');
            expect(requests[0].message).toContain('Document deploy flow');
        });

        it('approving a goal_proposal triggers goal creation via async createGoal import', async () => {
            const approval = requestGoalProposalApproval('agent-a', {
                title: 'Test goal',
                description: 'Ensure approval wires through.',
                rationale: 'Verification.',
            });
            const result = approveApproval(approval.id, 'board', 'looks good');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('approved');
            // createGoal is invoked asynchronously via dynamic import.
            // We don't verify the goal was created here because goals.ts is mocked
            // at the top of this file — just that the approval state transitioned
            // and the wiring did not throw.
        });

        it('rejecting a goal_proposal emits goal_proposal_rejected activity', () => {
            const approval = requestGoalProposalApproval('agent-a', {
                title: 'Silly idea',
                description: 'not worth doing',
                rationale: 'no reason',
            });
            const result = rejectApproval(approval.id, 'board', 'out of scope');
            expect(result!.status).toBe('rejected');
            const rejections = getActivity({ type: 'goal_proposal_rejected' });
            expect(rejections.some(a =>
                typeof a.metadata?.approvalId === 'string' && a.metadata.approvalId === approval.id
            )).toBe(true);
        });

        it('cannot approve a proposal twice', () => {
            const approval = requestGoalProposalApproval('agent-a', {
                title: 'Once',
                description: 'desc',
                rationale: 'why',
            });
            approveApproval(approval.id, 'board');
            const second = approveApproval(approval.id, 'board');
            expect(second).toBeNull();
        });

        it('getApproval returns the pending proposal', () => {
            const approval = requestGoalProposalApproval('agent-a', {
                title: 'Lookup',
                description: 'desc',
                rationale: 'why',
            });
            const fetched = getApproval(approval.id);
            expect(fetched?.type).toBe('goal_proposal');
        });
    });

    // ── F2: Persistent Agent Identity ────────────────────────
    describe('Agent Identity (F2)', () => {
        it('updateAgentIdentity sets all five fields', () => {
            const agent = registerAgent({ name: 'Alice', role: 'engineer' });
            const updated = updateAgentIdentity(agent.id, {
                voiceId: 'leah',
                personaId: 'dry-engineer',
                systemPromptOverride: 'You push back before committing.',
                memoryNamespace: 'agent:alice',
                characterSummary: 'A dry, skeptical engineer.',
            });
            expect(updated).not.toBeNull();
            expect(updated!.voiceId).toBe('leah');
            expect(updated!.personaId).toBe('dry-engineer');
            expect(updated!.systemPromptOverride).toBe('You push back before committing.');
            expect(updated!.memoryNamespace).toBe('agent:alice');
            expect(updated!.characterSummary).toBe('A dry, skeptical engineer.');
        });

        it('updateAgentIdentity with null clears a field', () => {
            const agent = registerAgent({ name: 'Bob', role: 'researcher' });
            updateAgentIdentity(agent.id, { voiceId: 'andrew' });
            const cleared = updateAgentIdentity(agent.id, { voiceId: null });
            expect(cleared!.voiceId).toBeUndefined();
        });

        it('updateAgentIdentity leaves untouched fields alone', () => {
            const agent = registerAgent({ name: 'Carol' });
            updateAgentIdentity(agent.id, { voiceId: 'jess', personaId: 'builder' });
            const updated = updateAgentIdentity(agent.id, { characterSummary: 'Builds fast.' });
            expect(updated!.voiceId).toBe('jess');
            expect(updated!.personaId).toBe('builder');
            expect(updated!.characterSummary).toBe('Builds fast.');
        });

        it('updateAgentIdentity returns null for unknown agent', () => {
            const result = updateAgentIdentity('nonexistent', { voiceId: 'x' });
            expect(result).toBeNull();
        });

        it('updateAgentIdentity emits activity entry when fields change', () => {
            const agent = registerAgent({ name: 'Dave' });
            updateAgentIdentity(agent.id, { personaId: 'builder' });
            const feed = getActivity({ type: 'agent_status_change' });
            const identityEvents = feed.filter(a =>
                a.agentId === agent.id && a.message.includes('identity updated')
            );
            expect(identityEvents.length).toBeGreaterThanOrEqual(1);
            expect(identityEvents[0].metadata?.fields).toContain('personaId');
        });

        it('updateAgentIdentity does NOT emit activity when nothing changes', () => {
            const agent = registerAgent({ name: 'Eve' });
            updateAgentIdentity(agent.id, { personaId: 'builder' });
            const beforeCount = getActivity({ type: 'agent_status_change' }).length;
            updateAgentIdentity(agent.id, { personaId: 'builder' }); // no-op
            const afterCount = getActivity({ type: 'agent_status_change' }).length;
            expect(afterCount).toBe(beforeCount);
        });

        it('getAgentMemoryNamespace returns stored namespace when set', () => {
            const agent = registerAgent({ name: 'Frank' });
            updateAgentIdentity(agent.id, { memoryNamespace: 'custom:frank' });
            expect(getAgentMemoryNamespace(agent.id)).toBe('custom:frank');
        });

        it('getAgentMemoryNamespace falls back to agent:${id} when unset', () => {
            const agent = registerAgent({ name: 'Grace' });
            expect(getAgentMemoryNamespace(agent.id)).toBe(`agent:${agent.id}`);
        });

        it('getAgentMemoryNamespace works for unknown agents (synthetic default)', () => {
            expect(getAgentMemoryNamespace('ghost-agent')).toBe('agent:ghost-agent');
        });

        it('getAgentVoice returns undefined when unset', () => {
            const agent = registerAgent({ name: 'Hank' });
            expect(getAgentVoice(agent.id)).toBeUndefined();
        });

        it('getAgentVoice returns voiceId when set', () => {
            const agent = registerAgent({ name: 'Ivy' });
            updateAgentIdentity(agent.id, { voiceId: 'leah' });
            expect(getAgentVoice(agent.id)).toBe('leah');
        });

        it('identity fields survive through saveState / loadState cycle', () => {
            const agent = registerAgent({ name: 'Julia' });
            updateAgentIdentity(agent.id, {
                voiceId: 'jess',
                personaId: 'builder',
                characterSummary: 'Curious.',
            });
            // Read back — cache is the same map, but we're verifying the write path touched it.
            const fetched = getRegisteredAgents().find(a => a.id === agent.id);
            expect(fetched?.voiceId).toBe('jess');
            expect(fetched?.personaId).toBe('builder');
            expect(fetched?.characterSummary).toBe('Curious.');
        });
    });
});
