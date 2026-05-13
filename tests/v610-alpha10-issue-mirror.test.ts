/**
 * TITAN — v6.1.0-alpha.10 Missions ↔ Command Post Issues mirror
 *
 * Borrowed from awesome-agent-harness (Symphony pattern): treat the
 * issue tracker as the agent control plane. TITAN already has Command
 * Post issues — this links them to missions so the issue becomes the
 * durable audit trail without breaking the existing Issues UI.
 *
 * What's mirrored:
 *   - Mission start → creates a new issue (status='in_progress') with
 *     an initial "Mission opened with team: …" comment
 *   - Question raised → comment "<agent> asked: <q>" + status='blocked'
 *   - Question answered → comment 'User answered: "<a>"' + status='in_progress'
 *   - Mission complete → comment "Mission complete in Xs …" + status='done'
 *   - Mission failed → comment "Couldn't finish this one …" + status='cancelled'
 *
 * Individual agent chat messages do NOT mirror (would be noise).
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
    return { tmpHome: mk(jn(td(), 'titan-v610a10-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome, MISSIONS_DIR: join(tmpHome, 'missions'), PLAYS_DIR: join(tmpHome, 'plays') };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('v6.1.0-alpha.10 — Missions ↔ Issues mirror', () => {
    beforeEach(async () => {
        const { _resetMissionCacheForTests } = await import('../src/agent/missionRoom.js');
        _resetMissionCacheForTests();
    });

    it('startMissionWork creates a Command Post issue linked to the mission', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const { getIssue, getIssueComments } = await import('../src/agent/commandPost.js');

        const room = createMission({
            goal: 'Test issue auto-create.',
            members: [{ agentId: 'scout', name: 'Scout' }, { agentId: 'writer', name: 'Writer' }],
        });
        await startMissionWork(room);

        const linked = getMission(room.id)!;
        expect(linked.issueId).toBeDefined();
        expect(linked.issueId).toMatch(/^[a-f0-9]{8}$/);

        const issue = getIssue(linked.issueId!);
        expect(issue).not.toBeNull();
        expect(issue!.title).toBe('Test issue auto-create.');
        expect(issue!.status).toBe('in_progress');
        expect(issue!.goalId).toBe(linked.goalId);

        // Initial "Mission opened" comment.
        const comments = getIssueComments(linked.issueId!);
        const opening = comments.find(c => /Mission opened/.test(c.body));
        expect(opening).toBeDefined();
        expect(opening!.body).toMatch(/Scout, Writer/);
    });

    it('raising a question mirrors as an issue comment + status=blocked', async () => {
        const { createMission, getMission, raiseQuestion } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const { titanEvents } = await import('../src/agent/daemon.js');
        const { getIssue, getIssueComments } = await import('../src/agent/commandPost.js');

        const room = createMission({
            goal: 'Question mirror test.',
            members: [{ agentId: 'sage', name: 'Sage' }],
        });
        await startMissionWork(room);
        const issueId = getMission(room.id)!.issueId!;
        const goalId = getMission(room.id)!.goalId!;

        // Approval-bridge path: fire the same titanEvents event the
        // commandPost bridge would emit, with a payload tied to our goal.
        titanEvents.emit('commandpost:approval:created', {
            id: 'a-mirror-1',
            type: 'custom',
            requestedBy: 'goal-driver',
            payload: {
                kind: 'driver_blocked',
                goalId,
                question: 'Should I include the layoff section?',
                specialist: 'sage',
            },
        });

        // raiseQuestion itself is called by the bridge handler; verify the
        // mirror landed.
        void raiseQuestion;
        const issue = getIssue(issueId)!;
        expect(issue.status).toBe('blocked');
        const comments = getIssueComments(issueId);
        const askComment = comments.find(c => /asked.*layoff/i.test(c.body));
        expect(askComment).toBeDefined();
    });

    it('mission completion mirrors as a "Mission complete" comment + status=done', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const { titanEvents } = await import('../src/agent/daemon.js');
        const { getIssue, getIssueComments } = await import('../src/agent/commandPost.js');

        const room = createMission({
            goal: 'Completion mirror test.',
            members: [{ agentId: 'analyst', name: 'Analyst' }],
        });
        await startMissionWork(room);
        const issueId = getMission(room.id)!.issueId!;
        const goalId = getMission(room.id)!.goalId!;

        titanEvents.emit('goal:completed', {
            goalId,
            title: 'Completion mirror test.',
            durationMs: 8500,
            tokensUsed: 1200,
            costUsd: 0.03,
            specialistsUsed: ['analyst'],
            subtaskCount: 1,
        });
        await new Promise(resolve => setImmediate(resolve));

        const issue = getIssue(issueId)!;
        expect(issue.status).toBe('done');
        const comments = getIssueComments(issueId);
        const closingComment = comments.find(c => /Mission complete/.test(c.body));
        expect(closingComment).toBeDefined();
        expect(closingComment!.body).toMatch(/analyst/i);
    });

    it('mission failure mirrors as a comment + status=cancelled', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const { titanEvents } = await import('../src/agent/daemon.js');
        const { getIssue, getIssueComments } = await import('../src/agent/commandPost.js');

        const room = createMission({
            goal: 'Failure mirror test.',
            members: [{ agentId: 'sage', name: 'Sage' }],
        });
        await startMissionWork(room);
        const issueId = getMission(room.id)!.issueId!;
        const goalId = getMission(room.id)!.goalId!;

        titanEvents.emit('goal:failed', {
            goalId,
            title: 'Failure mirror test.',
            durationMs: 12000,
            retries: 3,
        });
        await new Promise(resolve => setImmediate(resolve));

        const issue = getIssue(issueId)!;
        expect(issue.status).toBe('cancelled');
        const comments = getIssueComments(issueId);
        expect(comments.some(c => /Couldn't finish/.test(c.body))).toBe(true);
    });

    it('agent chat messages do NOT mirror as comments (would be noise)', async () => {
        const { createMission, getMission, postAgentMessage } = await import('../src/agent/missionRoom.js');
        const { startMissionWork } = await import('../src/agent/missionLifecycle.js');
        const { getIssueComments } = await import('../src/agent/commandPost.js');

        const room = createMission({
            goal: 'Chat noise test.',
            members: [{ agentId: 'scout', name: 'Scout' }],
        });
        await startMissionWork(room);
        const issueId = getMission(room.id)!.issueId!;

        const beforeCount = getIssueComments(issueId).length;
        // 5 ordinary agent messages — should NOT inflate the issue thread.
        for (let i = 0; i < 5; i++) {
            postAgentMessage(room.id, 'scout', `Update ${i}: still looking.`);
        }
        const afterCount = getIssueComments(issueId).length;
        expect(afterCount).toBe(beforeCount);
    });
});

void mkdtempSync; void tmpdir; void join;
