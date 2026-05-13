/**
 * TITAN — v6.1.0 Mission Chat REST + SSE coverage
 *
 * Mounts the missions router on a real express app and exercises every
 * endpoint end-to-end (no LLM, no real goal driver — we pass a stub
 * lifecycle adapter so the data plane is the only thing under test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
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
    return { tmpHome: mk(jn(td(), 'titan-v610-api-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome, MISSIONS_DIR: join(tmpHome, 'missions'), PLAYS_DIR: join(tmpHome, 'plays') };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function buildApp(adapterOverrides: Partial<import('../src/gateway/routes/missions.js').MissionLifecycleAdapter> = {}) {
    const { createMissionsRouter } = await import('../src/gateway/routes/missions.js');
    const app = express();
    app.use(express.json());
    app.use('/api/missions', createMissionsRouter({
        onMissionCreated: () => 'goal-stub-123',
        ...adapterOverrides,
    }));
    return app;
}

function listen(app: express.Express): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (typeof addr === 'object' && addr) {
                resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
            }
        });
    });
}

describe('v6.1.0 — missions REST', () => {
    beforeEach(async () => {
        const { _resetMissionCacheForTests } = await import('../src/agent/missionRoom.js');
        _resetMissionCacheForTests();
    });

    it('POST /api/missions creates a mission, matches a Play, returns the room', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const r = await fetch(`${url}/api/missions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'Draft a Q1 investor update.' }),
            });
            expect(r.status).toBe(201);
            const body = await r.json() as { mission: { id: string; playId: string; team: { agentId: string }[]; goalId?: string } };
            expect(body.mission.playId).toBe('investor-update');
            expect(body.mission.team.map(t => t.agentId)).toContain('scout');
            expect(body.mission.team.map(t => t.agentId)).toContain('writer');
            // Lifecycle adapter returned 'goal-stub-123' so the mission should
            // be linked.
            expect(body.mission.goalId).toBe('goal-stub-123');
        } finally { close(); }
    });

    it('POST /api/missions rejects missing goal', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const r = await fetch(`${url}/api/missions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(r.status).toBe(400);
        } finally { close(); }
    });

    it('GET /api/missions lists summaries (no message content)', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'Plan my mom\'s 70th birthday party.' }),
            });
            const r = await fetch(`${url}/api/missions`);
            const body = await r.json() as { missions: Array<{ messages: unknown[]; artifact: { content: string } }> };
            expect(body.missions.length).toBeGreaterThan(0);
            expect(body.missions[0].messages).toEqual([]);
            expect(body.missions[0].artifact.content).toBe('');
        } finally { close(); }
    });

    it('GET /api/missions/:id returns the full room', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const create = await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'Write a thank-you note to my landlord.' }),
            });
            const { mission } = await create.json() as { mission: { id: string } };
            const r = await fetch(`${url}/api/missions/${mission.id}`);
            const body = await r.json() as { mission: { messages: unknown[]; playId: string } };
            expect(body.mission.playId).toBe('thank-you');
            expect(body.mission.messages.length).toBeGreaterThan(0);
        } finally { close(); }
    });

    it('POST /api/missions/:id/message appends to the thread', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const create = await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'Generic test goal.' }),
            });
            const { mission } = await create.json() as { mission: { id: string } };
            const r = await fetch(`${url}/api/missions/${mission.id}/message`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content: 'Actually keep this short, please.' }),
            });
            expect(r.status).toBe(200);
            // Re-read the room — the new user message should be in there.
            const fresh = await fetch(`${url}/api/missions/${mission.id}`).then(x => x.json()) as {
                mission: { messages: Array<{ kind: string; content: string }> };
            };
            const last = fresh.mission.messages[fresh.mission.messages.length - 1];
            expect(last.kind).toBe('user');
            expect(last.content).toContain('keep this short');
        } finally { close(); }
    });

    it('POST /api/missions/:id/answer propagates to commandPost.approveApproval (not just replyToApproval) — v6.1.0-alpha.5 stuck-mission fix', async () => {
        // Verifies the v6.1.0-alpha.5 fix: the previous code called only
        // replyToApproval (which adds a comment but doesn't flip status),
        // so the goal driver's auto-unblock path (which watches for
        // status==='approved') never fired and missions sat blocked for
        // the full 10-minute stale-sweep.
        vi.resetModules();
        // Spy on the commandPost module — we want to check which functions
        // the route handler actually calls.
        const approveCalls: Array<{ id: string; by: string; note?: string }> = [];
        const replyCalls: Array<{ id: string; author: string; body: string }> = [];
        vi.doMock('../src/agent/commandPost.js', () => ({
            approveApproval: vi.fn(async (id: string, by: string, note?: string) => {
                approveCalls.push({ id, by, note });
                return { id, status: 'approved', decidedBy: by };
            }),
            replyToApproval: vi.fn((id: string, author: string, body: string) => {
                replyCalls.push({ id, author, body });
                return { id, thread: [{ body }] };
            }),
        }));
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const create = await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'Answer propagation test.' }),
            });
            const { mission } = await create.json() as { mission: { id: string } };
            const { raiseQuestion } = await import('../src/agent/missionRoom.js');
            raiseQuestion({
                missionId: mission.id,
                agentId: 'sage',
                content: 'A question?',
                approvalId: 'a-prop-1',
                quickReplies: ['Yes', 'No'],
            });
            const r = await fetch(`${url}/api/missions/${mission.id}/answer`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ approvalId: 'a-prop-1', answer: 'Yes go ahead' }),
            });
            expect(r.status).toBe(200);
            // The handler does the side-effects fire-and-forget — give the
            // microtask queue a tick to flush.
            await new Promise(resolve => setImmediate(resolve));
            // CRITICAL: approveApproval must be called (status flip + driver wakeup).
            expect(approveCalls.length).toBeGreaterThanOrEqual(1);
            expect(approveCalls[0].id).toBe('a-prop-1');
            expect(approveCalls[0].by).toBe('user');
            expect(approveCalls[0].note).toBe('Yes go ahead');
            // replyToApproval also called for audit trail.
            expect(replyCalls.length).toBeGreaterThanOrEqual(1);
            expect(replyCalls[0].body).toBe('Yes go ahead');
        } finally { close(); }
    });

    it('POST /api/missions/:id/answer resolves a pending question', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const create = await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'A goal.' }),
            });
            const { mission } = await create.json() as { mission: { id: string } };
            // Raise a question via the mission room module directly
            // (simulating what a lifecycle bridge does).
            const { raiseQuestion } = await import('../src/agent/missionRoom.js');
            raiseQuestion({
                missionId: mission.id,
                agentId: 'sage',
                content: 'Should we?',
                approvalId: 'a1',
                quickReplies: ['Yes', 'No'],
            });
            // Answer via the API.
            const r = await fetch(`${url}/api/missions/${mission.id}/answer`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ approvalId: 'a1', answer: 'Yes, briefly.' }),
            });
            expect(r.status).toBe(200);
            const fresh = await fetch(`${url}/api/missions/${mission.id}`).then(x => x.json()) as {
                mission: { status: string; messages: Array<{ kind: string; answer?: { content: string } }> };
            };
            const q = fresh.mission.messages.find(m => m.kind === 'question');
            expect(q?.answer?.content).toBe('Yes, briefly.');
            expect(fresh.mission.status).toBe('working');
        } finally { close(); }
    });

    it('POST /api/missions/:id/status pauses + resumes', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const create = await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'Status toggle test.' }),
            });
            const { mission } = await create.json() as { mission: { id: string } };
            await fetch(`${url}/api/missions/${mission.id}/status`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: 'paused' }),
            });
            const after1 = await fetch(`${url}/api/missions/${mission.id}`).then(x => x.json()) as { mission: { status: string } };
            expect(after1.mission.status).toBe('paused');
            await fetch(`${url}/api/missions/${mission.id}/status`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: 'working' }),
            });
            const after2 = await fetch(`${url}/api/missions/${mission.id}`).then(x => x.json()) as { mission: { status: string } };
            expect(after2.mission.status).toBe('working');
        } finally { close(); }
    });

    it('DELETE /api/missions/:id removes the mission', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const create = await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'Delete me.' }),
            });
            const { mission } = await create.json() as { mission: { id: string } };
            const r = await fetch(`${url}/api/missions/${mission.id}`, { method: 'DELETE' });
            expect(r.status).toBe(200);
            const { _resetMissionCacheForTests } = await import('../src/agent/missionRoom.js');
            _resetMissionCacheForTests();
            const after = await fetch(`${url}/api/missions/${mission.id}`);
            expect(after.status).toBe(404);
        } finally { close(); }
    });

    it('GET /api/missions/plays returns the Plays library', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const r = await fetch(`${url}/api/missions/plays`);
            const body = await r.json() as { plays: Array<{ id: string }> };
            expect(body.plays.some(p => p.id === 'investor-update')).toBe(true);
            expect(body.plays.some(p => p.id === 'code-review')).toBe(true);
            expect(body.plays.some(p => p.id === 'generic')).toBe(true);
        } finally { close(); }
    });

    it('GET /api/missions/match-play previews team for a goal', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const r = await fetch(`${url}/api/missions/match-play?goal=` + encodeURIComponent('Draft an investor update'));
            const body = await r.json() as { play: { id: string }; team: Array<{ agentId: string }> };
            expect(body.play.id).toBe('investor-update');
            expect(body.team.length).toBeGreaterThan(0);
        } finally { close(); }
    });
});

describe('v6.1.0 — missions SSE', () => {
    beforeEach(async () => {
        const { _resetMissionCacheForTests } = await import('../src/agent/missionRoom.js');
        _resetMissionCacheForTests();
    });

    it('streams typed events for a single mission', async () => {
        const app = await buildApp();
        const { url, close } = await listen(app);
        try {
            const create = await fetch(`${url}/api/missions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ goal: 'SSE test mission.' }),
            });
            const { mission } = await create.json() as { mission: { id: string } };

            // Open the stream and capture frames as they arrive.
            const events: string[] = [];
            const done = new Promise<void>((resolve, reject) => {
                const controller = new AbortController();
                const timeout = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`Did not see expected events in time. Got: ${events.join(',')}`));
                }, 4000);
                fetch(`${url}/api/missions/${mission.id}/stream`, { signal: controller.signal })
                    .then(async (resp) => {
                        const reader = resp.body!.getReader();
                        const decoder = new TextDecoder();
                        let buf = '';
                        while (true) {
                            const { value, done: streamDone } = await reader.read();
                            if (streamDone) break;
                            buf += decoder.decode(value, { stream: true });
                            for (const line of buf.split('\n')) {
                                const m = line.match(/^event:\s*(\S+)/);
                                if (m) events.push(m[1]);
                            }
                            buf = buf.slice(buf.lastIndexOf('\n') + 1);
                            // Once we've seen hello + at least one mutation event we're done.
                            if (events.includes('hello') && events.some(e => e !== 'hello')) {
                                clearTimeout(timeout);
                                controller.abort();
                                resolve();
                                return;
                            }
                        }
                    })
                    .catch(err => {
                        if ((err as Error).name === 'AbortError') return;
                        clearTimeout(timeout);
                        reject(err);
                    });

                // Drive a mutation so the stream has something to emit.
                setTimeout(async () => {
                    const { postAgentMessage } = await import('../src/agent/missionRoom.js');
                    postAgentMessage(mission.id, 'scout', 'Hello from the SSE bridge test.');
                }, 200);
            });

            await done;
            expect(events).toContain('hello');
            expect(events.some(e => e === 'message_added')).toBe(true);
        } finally { close(); }
    }, 6000);
});

void mkdtempSync; void tmpdir; void join;
