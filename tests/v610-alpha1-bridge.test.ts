/**
 * TITAN — v6.1.0-alpha.1 bridge regression tests
 *
 * alpha.0 shipped with a silently-broken bridge: it assumed an
 * onSubAgentEvent API on subAgent.ts that doesn't exist, so zero
 * specialist activity ever flowed into the chat thread. alpha.1
 * wires through the real agentEvents bus and adds dynamic team
 * membership (auto-add specialists the goal driver routes to but
 * Plays didn't predict). These tests pin both behaviors so we
 * don't regress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-v610a1-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome, MISSIONS_DIR: join(tmpHome, 'missions'), PLAYS_DIR: join(tmpHome, 'plays') };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('v6.1.0-alpha.1 — goalDriver event → mission room bridge', () => {
    beforeEach(async () => {
        const { _resetMissionCacheForTests } = await import('../src/agent/missionRoom.js');
        _resetMissionCacheForTests();
    });

    it('ensureGlobalBusBridge: an agent_done event on a linked goal posts a chat message', async () => {
        const { createMission, setLinkedGoal, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork: _ignored } = await import('../src/agent/missionLifecycle.js');
        void _ignored; // importing the lifecycle module attaches the global bridge

        const room = createMission({
            goal: 'Test bridge.',
            members: [{ agentId: 'scout', name: 'Scout' }],
        });
        // We simulate the goal-driver linking — no real driver in unit tests.
        setLinkedGoal(room.id, 'goal-xyz');
        // Force the global bridge to attach (it normally attaches in
        // startMissionWork; without a real goal we wire it explicitly).
        const lifecycle = await import('../src/agent/missionLifecycle.js') as unknown as {
            ensureGlobalBusBridge?: () => void;
        };
        // ensureGlobalBusBridge is module-private; we trigger it by calling
        // any function that calls it — startMissionWork attaches it. We
        // already imported the module, but the bridge only attaches on
        // first startMissionWork. For this test, do it indirectly by
        // emitting an event after a brief async tick — the lifecycle
        // module's top-level imports include the bus, so subscribing
        // happens deterministically here.
        // The cleanest path: actually call startMissionWork. createGoal is
        // unmocked but writes to TITAN_HOME/.titan which we redirected.
        void lifecycle;
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        await startMissionWork(room);

        // Now emit a fake agent_done as if the goal driver completed a spawn.
        // We need to override goalId in the event to the one our bridge sees.
        const room2 = getMission(room.id)!;
        const realGoalId = room2.goalId!;
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        emitAgentEvent({
            type: 'agent_done',
            agentId: 'scout',
            agentName: 'scout',
            timestamp: Date.now(),
            data: {
                goalId: realGoalId,
                subtaskTitle: 'find Q4 numbers',
                status: 'done',
                reasoning: 'I found the numbers — MRR $1.4M, +28% QoQ.',
                toolsUsed: ['web_search', 'web_fetch'],
                tokensUsed: 1234,
                costUsd: 0.05,
            },
        });

        // Bus events are synchronous in our EventEmitter setup.
        const after = getMission(room.id)!;
        const agentMessages = after.messages.filter(m => m.kind === 'agent');
        expect(agentMessages.length).toBeGreaterThan(0);
        const last = agentMessages[agentMessages.length - 1] as { content: string; from: { agentId: string }; actions?: { detail?: string }[] };
        expect(last.content).toContain('MRR $1.4M');
        expect(last.from.agentId).toBe('scout');
        // Tools used should appear as action chips.
        expect(last.actions?.some(a => a.detail === 'web_search')).toBe(true);
        // Cost should have been recorded.
        expect(after.cost.tokens).toBe(1234);
        expect(after.cost.usd).toBeCloseTo(0.05, 4);
    });

    it('dynamic team membership: agent_done from an UNKNOWN specialist auto-adds them', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        // Mission was formed with Scout+Writer+Sage (generic play composition).
        const room = createMission({
            goal: 'Some research thing.',
            members: [
                { agentId: 'scout', name: 'Scout' },
                { agentId: 'writer', name: 'Writer' },
                { agentId: 'sage', name: 'Sage' },
            ],
        });
        await startMissionWork(room);
        const realGoalId = getMission(room.id)!.goalId!;

        // The goal driver routes the first subtask to ANALYST (not on the
        // predicted team). The bridge should add them dynamically.
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        emitAgentEvent({
            type: 'agent_done',
            agentId: 'analyst',
            agentName: 'analyst',
            timestamp: Date.now(),
            data: {
                goalId: realGoalId,
                subtaskTitle: 'crunch the numbers',
                status: 'done',
                reasoning: 'MoM growth: +9.2%, +11.4%, +7.8% — strong quarter.',
                toolsUsed: ['memory'],
                tokensUsed: 600,
                costUsd: 0.02,
            },
        });

        const after = getMission(room.id)!;
        // Analyst is now on the team.
        expect(after.team.map(t => t.agentId)).toContain('analyst');
        // A "joined the team" system note was posted.
        const sys = after.messages.find(m => m.kind === 'system' && (m as { tag?: string }).tag === 'team_expanded');
        expect(sys).toBeDefined();
        // Analyst's chat message landed.
        const analystMsg = after.messages.find(m => m.kind === 'agent' && (m as { from: { agentId: string } }).from.agentId === 'analyst');
        expect(analystMsg).toBeDefined();
    });

    it('agent_spawn event updates the team member state to working', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const room = createMission({
            goal: 'Spawn-state test.',
            members: [{ agentId: 'scout', name: 'Scout' }],
        });
        await startMissionWork(room);
        const realGoalId = getMission(room.id)!.goalId!;
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        emitAgentEvent({
            type: 'agent_spawn',
            agentId: 'scout',
            agentName: 'scout',
            timestamp: Date.now(),
            data: { goalId: realGoalId, subtaskTitle: 'reading Q4 minutes' },
        });
        const after = getMission(room.id)!;
        const scout = after.team.find(t => t.agentId === 'scout')!;
        expect(scout.state).toBe('working');
        expect(scout.currentActivity).toContain('reading Q4 minutes');
    });

    it('events for a goal NOT linked to any mission are silently ignored', async () => {
        const { createMission, getMission, _resetMissionCacheForTests } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const room = createMission({ goal: 'A mission.', members: [{ agentId: 'scout', name: 'Scout' }] });
        await startMissionWork(room);
        _resetMissionCacheForTests();
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        // Event for a goal that no mission is linked to.
        emitAgentEvent({
            type: 'agent_done',
            agentId: 'scout',
            timestamp: Date.now(),
            data: {
                goalId: 'goal-not-linked-to-anything',
                status: 'done',
                reasoning: 'should not appear',
            },
        });
        const after = getMission(room.id)!;
        // No agent messages on this mission.
        expect(after.messages.filter(m => m.kind === 'agent')).toHaveLength(0);
    });

    it('agent_done with status=failed posts a graceful fallback message', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const room = createMission({ goal: 'Failed spawn test.', members: [{ agentId: 'sage', name: 'Sage' }] });
        await startMissionWork(room);
        const realGoalId = getMission(room.id)!.goalId!;
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        emitAgentEvent({
            type: 'agent_done',
            agentId: 'sage',
            timestamp: Date.now(),
            data: { goalId: realGoalId, status: 'failed', reasoning: '' /* empty */ },
        });
        const after = getMission(room.id)!;
        const last = after.messages.find(m => m.kind === 'agent') as { content: string } | undefined;
        expect(last?.content).toMatch(/trouble.*couldn't finish/i);
    });

    it('agent_done with empty reasoning + status=done posts a graceful "Done." summary using tools used', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const room = createMission({ goal: 'Empty reasoning test.', members: [{ agentId: 'analyst', name: 'Analyst' }] });
        await startMissionWork(room);
        const realGoalId = getMission(room.id)!.goalId!;
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        emitAgentEvent({
            type: 'agent_done',
            agentId: 'analyst',
            timestamp: Date.now(),
            data: {
                goalId: realGoalId,
                status: 'done',
                reasoning: '', // empty
                toolsUsed: ['memory', 'web_search'],
            },
        });
        const after = getMission(room.id)!;
        const msg = after.messages.find(m => m.kind === 'agent') as { content: string } | undefined;
        expect(msg).toBeDefined();
        expect(msg!.content).toMatch(/Done.*memory|memory.*Done/i);
    });

    it('agent_done with empty reasoning + status=needs_info posts "I have a quick question" message', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const room = createMission({ goal: 'Needs-info empty-reasoning test.', members: [{ agentId: 'analyst', name: 'Analyst' }] });
        await startMissionWork(room);
        const realGoalId = getMission(room.id)!.goalId!;
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        emitAgentEvent({
            type: 'agent_done',
            agentId: 'analyst',
            timestamp: Date.now(),
            data: { goalId: realGoalId, status: 'needs_info', reasoning: '' },
        });
        const after = getMission(room.id)!;
        const msg = after.messages.find(m => m.kind === 'agent') as { content: string } | undefined;
        expect(msg).toBeDefined();
        expect(msg!.content).toMatch(/quick question/i);
    });

    it('approval bridge: commandpost:approval:created event for a linked goal raises a question message', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const room = createMission({ goal: 'Approval bridge test.', members: [{ agentId: 'sage', name: 'Sage' }] });
        await startMissionWork(room);
        const realGoalId = getMission(room.id)!.goalId!;
        const { titanEvents } = await import('../src/agent/daemon.js');
        titanEvents.emit('commandpost:approval:created', {
            id: 'approval-bridge-1',
            type: 'custom',
            title: 'Quick decision needed',
            requestedBy: 'goal-driver',
            payload: {
                kind: 'driver_blocked',
                goalId: realGoalId,
                question: 'Should I include the layoff numbers or keep them out?',
                specialist: 'sage',
            },
        });
        const after = getMission(room.id)!;
        const q = after.messages.find(m => m.kind === 'question') as { content: string; approvalId: string; quickReplies: string[] } | undefined;
        expect(q).toBeDefined();
        expect(q!.content).toContain('layoff');
        expect(q!.approvalId).toBe('approval-bridge-1');
        // Default quick-replies for driver_blocked kind.
        expect(q!.quickReplies.length).toBeGreaterThan(0);
        // Mission should be blocked since Sage raised a question.
        expect(after.status).toBe('blocked');
    });

    it('tool_call events update currentActivity without flooding the chat thread', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const room = createMission({ goal: 'Tool stream test.', members: [{ agentId: 'scout', name: 'Scout' }] });
        await startMissionWork(room);
        const realGoalId = getMission(room.id)!.goalId!;
        const before = getMission(room.id)!.messages.length;
        const { emitAgentEvent } = await import('../src/agent/agentEvents.js');
        // Five tool calls in rapid succession — should update state, NOT
        // add five chat messages.
        for (let i = 0; i < 5; i++) {
            emitAgentEvent({
                type: 'tool_call',
                agentId: 'scout',
                timestamp: Date.now(),
                data: { goalId: realGoalId, name: i % 2 === 0 ? 'web_search' : 'web_fetch' },
            });
        }
        const after = getMission(room.id)!;
        expect(after.messages.length).toBe(before);
        const scout = after.team.find(t => t.agentId === 'scout')!;
        expect(scout.state).toBe('working');
        // Most recent tool call wins. With i%2==0 → web_search, i=0..4 ends at web_search.
        expect(scout.currentActivity).toContain('web_search');
    });
});

void mkdtempSync; void tmpdir; void join;
