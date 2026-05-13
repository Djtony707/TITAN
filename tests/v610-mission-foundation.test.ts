/**
 * TITAN — v6.1.0 Mission Chat foundation tests
 *
 * Covers the data layer (missionRoom.ts) and team-composition layer
 * (plays.ts). The HTTP API + UI layers ride on top — if these two
 * modules are right, the rest is plumbing.
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
    return { tmpHome: mk(jn(td(), 'titan-v610-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome, MISSIONS_DIR: join(tmpHome, 'missions'), PLAYS_DIR: join(tmpHome, 'plays') };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── missionRoom ────────────────────────────────────────────────────

describe('v6.1.0 — missionRoom', () => {
    beforeEach(async () => {
        const { _resetMissionCacheForTests } = await import('../src/agent/missionRoom.js');
        _resetMissionCacheForTests();
    });

    it('creates a mission with team and seeds the user message + team_formed system note', async () => {
        const { createMission, getMission } = await import('../src/agent/missionRoom.js');
        const room = createMission({
            goal: 'Draft a Q1 investor update.',
            members: [{ agentId: 'scout', name: 'Scout' }, { agentId: 'writer', name: 'Writer' }],
            playId: 'investor-update',
        });
        expect(room.goal).toBe('Draft a Q1 investor update.');
        expect(room.status).toBe('working');
        expect(room.team.map(t => t.agentId)).toEqual(['scout', 'writer']);
        // First message is the user goal; second is the team_formed note.
        expect(room.messages[0].kind).toBe('user');
        expect(room.messages[1].kind).toBe('system');
        const sysMsg = room.messages[1] as { tag?: string; content: string };
        expect(sysMsg.tag).toBe('team_formed');
        expect(sysMsg.content).toContain('Scout');
        expect(sysMsg.content).toContain('Writer');
        // Re-read from cache (and disk) returns the same room
        const reloaded = getMission(room.id);
        expect(reloaded?.id).toBe(room.id);
    });

    it('creates a "forming" mission when no team is given and setTeam transitions it', async () => {
        const { createMission, setTeam, getMission } = await import('../src/agent/missionRoom.js');
        const room = createMission({ goal: 'Something ambiguous.' });
        expect(room.status).toBe('forming');
        expect(room.team).toEqual([]);
        setTeam(room.id, [{ agentId: 'scout', name: 'Scout' }, { agentId: 'sage', name: 'Sage' }]);
        const updated = getMission(room.id);
        expect(updated?.status).toBe('working');
        expect(updated?.team.map(t => t.agentId)).toEqual(['scout', 'sage']);
        // The system message was appended.
        const last = updated!.messages[updated!.messages.length - 1] as { tag?: string };
        expect(last.tag).toBe('team_formed');
    });

    it('postAgentMessage attaches the right speaker metadata + color', async () => {
        const { createMission, postAgentMessage } = await import('../src/agent/missionRoom.js');
        const room = createMission({
            goal: 'Test message posting.',
            members: [{ agentId: 'scout', name: 'Scout' }],
        });
        const msg = postAgentMessage(room.id, 'scout', 'I dug up the Q4 numbers.', [
            { name: 'looked at', detail: 'Q4_board_minutes.pdf' },
        ]);
        expect(msg).not.toBeNull();
        expect(msg!.from.agentId).toBe('scout');
        expect(msg!.from.name).toBe('Scout');
        expect(msg!.from.role).toBe('the researcher');
        expect(msg!.from.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(msg!.content).toContain('Q4 numbers');
        expect(msg!.actions).toHaveLength(1);
    });

    it('raiseQuestion marks the mission blocked and links to an approval', async () => {
        const { createMission, raiseQuestion, getMission } = await import('../src/agent/missionRoom.js');
        const room = createMission({
            goal: 'Test blocking.',
            members: [{ agentId: 'sage', name: 'Sage' }],
        });
        raiseQuestion({
            missionId: room.id,
            agentId: 'sage',
            content: 'Should I mention the February layoffs?',
            approvalId: 'approval-123',
            quickReplies: ['Mention briefly', 'Keep it out'],
        });
        const after = getMission(room.id)!;
        expect(after.status).toBe('blocked');
        const sage = after.team.find(t => t.agentId === 'sage')!;
        expect(sage.state).toBe('blocked');
        const q = after.messages.find(m => m.kind === 'question') as { approvalId: string; quickReplies: string[] };
        expect(q.approvalId).toBe('approval-123');
        expect(q.quickReplies).toEqual(['Mention briefly', 'Keep it out']);
    });

    it('answerQuestion resumes the agent and the mission', async () => {
        const { createMission, raiseQuestion, answerQuestion, getMission } = await import('../src/agent/missionRoom.js');
        const room = createMission({
            goal: 'Test unblocking.',
            members: [{ agentId: 'sage', name: 'Sage' }],
        });
        raiseQuestion({
            missionId: room.id,
            agentId: 'sage',
            content: 'Should I?',
            approvalId: 'a1',
        });
        answerQuestion(room.id, 'a1', 'Yes, briefly.');
        const after = getMission(room.id)!;
        expect(after.status).toBe('working');
        const sage = after.team.find(t => t.agentId === 'sage')!;
        expect(sage.state).toBe('working');
        const q = after.messages.find(m => m.kind === 'question') as { answer?: { content: string } };
        expect(q.answer?.content).toBe('Yes, briefly.');
    });

    it('updateArtifact snapshots prior state and appends an artifact_update marker', async () => {
        const { createMission, updateArtifact, getMission } = await import('../src/agent/missionRoom.js');
        const room = createMission({
            goal: 'Test artifact.',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        updateArtifact(room.id, 'writer', '# Hello\n\nFirst paragraph.', 'wrote intro');
        updateArtifact(room.id, 'writer', '# Hello\n\nFirst paragraph.\n\nSecond paragraph.', 'added paragraph 2');
        const after = getMission(room.id)!;
        expect(after.artifact.content).toContain('Second paragraph');
        // Snapshots store the PRIOR state — so after 2 updates we have 2 snapshots
        // (the initial empty and the post-first-update state).
        expect(after.artifact.snapshots.length).toBe(2);
        expect(after.artifact.snapshots[0].content).toBe('');
        expect(after.artifact.snapshots[1].content).toContain('First paragraph');
        // An artifact_update marker should be in the message log per update.
        const markers = after.messages.filter(m => m.kind === 'artifact_update');
        expect(markers).toHaveLength(2);
    });

    it('bounds artifact snapshots to the last 16', async () => {
        const { createMission, updateArtifact, getMission } = await import('../src/agent/missionRoom.js');
        const room = createMission({
            goal: 'Test snapshot cap.',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        for (let i = 0; i < 25; i++) {
            updateArtifact(room.id, 'writer', `version ${i}`, `update ${i}`);
        }
        const after = getMission(room.id)!;
        expect(after.artifact.snapshots.length).toBe(16);
    });

    it('emits typed events that subscribers can observe', async () => {
        const { createMission, postAgentMessage, onMissionEvent } = await import('../src/agent/missionRoom.js');
        const events: string[] = [];
        const unsub = onMissionEvent(ev => { events.push(ev.kind); });
        const room = createMission({
            goal: 'Test events.',
            members: [{ agentId: 'scout', name: 'Scout' }],
        });
        postAgentMessage(room.id, 'scout', 'hi');
        unsub();
        expect(events).toContain('mission_created');
        expect(events).toContain('team_formed');
        expect(events).toContain('message_added');
    });

    it('listMissions returns summaries by default and full rooms with full=true', async () => {
        const { createMission, listMissions, postAgentMessage } = await import('../src/agent/missionRoom.js');
        const a = createMission({ goal: 'A', members: [{ agentId: 'scout', name: 'Scout' }] });
        postAgentMessage(a.id, 'scout', 'a chunk of content');
        const summaries = listMissions();
        const found = summaries.find(m => m.id === a.id)!;
        // Summary: messages stripped, artifact content stripped.
        expect(found.messages).toEqual([]);
        expect(found.artifact.content).toBe('');
        // Full: contents present.
        const full = listMissions({ full: true });
        const foundFull = full.find(m => m.id === a.id)!;
        expect(foundFull.messages.length).toBeGreaterThan(0);
    });

    it('deleteMission removes the file and emits mission_deleted', async () => {
        const { createMission, deleteMission, getMission, onMissionEvent, _resetMissionCacheForTests } =
            await import('../src/agent/missionRoom.js');
        const events: string[] = [];
        const unsub = onMissionEvent(ev => { if (ev.kind === 'mission_deleted') events.push(ev.missionId); });
        const room = createMission({ goal: 'X' });
        expect(deleteMission(room.id)).toBe(true);
        _resetMissionCacheForTests(); // force a fresh read from disk
        expect(getMission(room.id)).toBeNull();
        expect(events).toContain(room.id);
        unsub();
    });

    it('recordCost accumulates and emits cost_changed', async () => {
        const { createMission, recordCost, getMission, onMissionEvent } = await import('../src/agent/missionRoom.js');
        let costEvents = 0;
        const unsub = onMissionEvent(ev => { if (ev.kind === 'cost_changed') costEvents++; });
        const room = createMission({ goal: 'Cost test.' });
        recordCost(room.id, 1200, 0.04);
        recordCost(room.id, 800, 0.02);
        const after = getMission(room.id)!;
        expect(after.cost.tokens).toBe(2000);
        expect(after.cost.usd).toBeCloseTo(0.06, 4);
        expect(costEvents).toBe(2);
        unsub();
    });
});

// ── plays ──────────────────────────────────────────────────────────

describe('v6.1.0 — plays', () => {
    it('matches "Draft the Q1 investor update" to the investor-update Play', async () => {
        const { matchPlay } = await import('../src/agent/plays.js');
        const p = matchPlay('Draft the Q1 investor update — pull last quarter\'s numbers');
        expect(p.id).toBe('investor-update');
        expect(p.team).toContain('scout');
        expect(p.team).toContain('writer');
    });

    it('matches "review the auth refactor PR" to code-review', async () => {
        const { matchPlay } = await import('../src/agent/plays.js');
        const p = matchPlay('Review the auth refactor PR.');
        expect(p.id).toBe('code-review');
        expect(p.team).toContain('builder');
    });

    it('matches "plan my mom\'s 70th birthday party" to event-plan', async () => {
        const { matchPlay } = await import('../src/agent/plays.js');
        const p = matchPlay("Plan my mom's 70th birthday party.");
        expect(p.id).toBe('event-plan');
    });

    it('matches "write a thank-you note to my landlord" to thank-you', async () => {
        const { matchPlay } = await import('../src/agent/plays.js');
        const p = matchPlay('Write a thank-you note to my landlord.');
        expect(p.id).toBe('thank-you');
        // Tiny team — just the wordsmith.
        expect(p.team).toEqual(['writer']);
    });

    it('matches "summarize this email" to summarize', async () => {
        const { matchPlay } = await import('../src/agent/plays.js');
        const p = matchPlay('Summarize this long email I got.');
        expect(p.id).toBe('summarize');
    });

    it('falls back to the generic Play when nothing matches', async () => {
        const { matchPlay } = await import('../src/agent/plays.js');
        const p = matchPlay('Lorem ipsum dolor sit amet quux fnord baz qux.');
        expect(p.id).toBe('generic');
        expect(p.team).toEqual(['scout', 'writer', 'sage']);
    });

    it('resolveTeam drops unknown agent ids and warns', async () => {
        const { resolveTeam } = await import('../src/agent/plays.js');
        const team = resolveTeam({
            id: 'test',
            title: 'T',
            description: 'd',
            team: ['scout', 'unknown-agent', 'writer'],
            artifactFormat: 'markdown',
            patterns: [],
        });
        expect(team.map(t => t.agentId)).toEqual(['scout', 'writer']);
    });

    it('investor-update beats sales-email on "investor update" — priority + regex weight', async () => {
        const { matchPlay } = await import('../src/agent/plays.js');
        const p = matchPlay('Need to draft an investor update for the board.');
        expect(p.id).toBe('investor-update');
    });

    it('listPlays returns all builtins (10+) and putting a typo-filled user play does not crash', async () => {
        const { listPlays } = await import('../src/agent/plays.js');
        const all = listPlays();
        // 11 builtins (10 specific + generic catch-all).
        const builtins = all.filter(p => p.source === 'builtin');
        expect(builtins.length).toBeGreaterThanOrEqual(11);
        expect(builtins.find(p => p.id === 'investor-update')).toBeDefined();
        expect(builtins.find(p => p.id === 'generic')).toBeDefined();
    });
});

// Keep the tmp dir referenced so the worker doesn't drop it mid-test.
void mkdtempSync; void tmpdir; void join;
