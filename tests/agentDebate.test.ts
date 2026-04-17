/**
 * TITAN — Agent Debate Tests (F3)
 *
 * Covers orchestration (N rounds, parallel turns), guardrail application,
 * all three resolution modes, transcript persistence, and JSON-parsing
 * robustness for the judge verdict.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockEnsureDir = vi.hoisted(() => vi.fn());
const mockEmit = vi.hoisted(() => vi.fn());

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
        readdirSync: mockReaddirSync,
    };
});
vi.mock('../src/utils/helpers.js', () => ({ ensureDir: mockEnsureDir }));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/utils/constants.js', () => ({
    TITAN_HOME: '/tmp/titan-test-debate',
}));
vi.mock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));
vi.mock('../src/skills/registry.js', () => ({ registerSkill: vi.fn() }));
vi.mock('../src/agent/daemon.js', () => ({
    titanEvents: { emit: mockEmit },
}));
vi.mock('uuid', () => ({ v4: () => 'uuid1234' }));

let debateModule: typeof import('../src/skills/builtin/agent_debate.js');

const defaultConfig = {
    agent: {
        model: 'openai/gpt-4o-mini',
        modelAliases: { smart: 'anthropic/claude-sonnet-4-20250514', fast: 'openai/gpt-4o-mini' },
    },
};

describe('AgentDebate', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue('{}');
        mockReaddirSync.mockReturnValue([]);
        mockLoadConfig.mockReturnValue(defaultConfig);
        vi.resetModules();
        debateModule = await import('../src/skills/builtin/agent_debate.js');
    });

    describe('orchestration', () => {
        it('runs opening + N rebuttal rounds, calling each participant per round', async () => {
            let callCount = 0;
            mockChat.mockImplementation(() => {
                callCount++;
                return Promise.resolve({ content: `turn ${callCount} position` });
            });

            const t = await debateModule.runDebate({
                question: 'Cache probes 7 days or 30 days?',
                participants: [
                    { role: 'pragmatist' },
                    { role: 'cautious' },
                ],
                rounds: 2,
                resolution: 'vote',
            });

            // 2 participants × 2 rounds = 4 debate turns.
            expect(t.turns).toHaveLength(4);
            expect(t.turns.filter(x => x.round === 1)).toHaveLength(2);
            expect(t.turns.filter(x => x.round === 2)).toHaveLength(2);
            // No judge call for vote resolution, so chat was called exactly 4 times.
            expect(mockChat).toHaveBeenCalledTimes(4);
        });

        it('uses per-participant model override, falls back to config.agent.model', async () => {
            mockChat.mockResolvedValue({ content: 'x' });

            await debateModule.runDebate({
                question: 'q',
                participants: [
                    { role: 'a', model: 'anthropic/claude-haiku-4-5-20251001' },
                    { role: 'b' },
                ],
                rounds: 1,
                resolution: 'vote',
            });

            const usedModels = mockChat.mock.calls.map(c => c[0].model);
            expect(usedModels).toContain('anthropic/claude-haiku-4-5-20251001');
            expect(usedModels).toContain('openai/gpt-4o-mini');
        });

        it('uniquifies duplicate role names', async () => {
            mockChat.mockResolvedValue({ content: 'x' });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [
                    { role: 'skeptic' },
                    { role: 'skeptic' },
                    { role: 'skeptic' },
                ],
                rounds: 1,
                resolution: 'vote',
            });
            const roles = t.participants.map(p => p.role);
            expect(new Set(roles).size).toBe(3);
            expect(roles[0]).toBe('skeptic');
            expect(roles[1]).toBe('skeptic-2');
            expect(roles[2]).toBe('skeptic-3');
        });

        it('survives a single participant failure and continues the debate', async () => {
            let n = 0;
            mockChat.mockImplementation(() => {
                n++;
                if (n === 2) return Promise.reject(new Error('simulated failure'));
                return Promise.resolve({ content: `turn ${n}` });
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'vote',
            });
            expect(t.turns).toHaveLength(2);
            const failed = t.turns.find(x => x.content.includes('[b failed'));
            expect(failed).toBeDefined();
        });
    });

    describe('guardrails', () => {
        it('strips <think> blocks from participant output', async () => {
            mockChat.mockResolvedValue({
                content: '<think>let me reason...</think>\nMy position is X.',
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'vote',
            });
            for (const turn of t.turns) {
                expect(turn.content).not.toContain('<think>');
                expect(turn.content).toContain('My position is X.');
            }
        });
    });

    describe('resolution: vote', () => {
        it('picks the position with highest word-overlap consensus', async () => {
            const texts = [
                'We must prioritize safety and correctness above speed because errors compound over time', // A
                'Safety and correctness above speed compounding errors over time is wise priority', // B — overlaps heavily with A
                'Move fast and break things, iteration velocity wins', // C — disjoint
            ];
            let i = 0;
            mockChat.mockImplementation(() => Promise.resolve({ content: texts[i++ % texts.length] }));
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'A' }, { role: 'B' }, { role: 'C' }],
                rounds: 1,
                resolution: 'vote',
            });
            expect(t.winner).toBeDefined();
            expect(['A', 'B']).toContain(t.winner!.role);
            expect(t.winner!.role).not.toBe('C');
        });
    });

    describe('resolution: synthesize', () => {
        it('calls an extra LLM turn for synthesis', async () => {
            let turn = 0;
            mockChat.mockImplementation(() => {
                turn++;
                if (turn <= 2) return Promise.resolve({ content: `position ${turn}` });
                return Promise.resolve({ content: 'synthesized answer combining both.' });
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'synthesize',
            });
            expect(mockChat).toHaveBeenCalledTimes(3); // 2 openings + 1 synth
            expect(t.winner!.role).toBe('synthesis');
            expect(t.winner!.content).toBe('synthesized answer combining both.');
        });

        it('falls back to vote when synthesis LLM fails', async () => {
            let turn = 0;
            mockChat.mockImplementation(() => {
                turn++;
                if (turn <= 2) return Promise.resolve({ content: `position ${turn}` });
                return Promise.reject(new Error('synth provider down'));
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'synthesize',
            });
            expect(t.winner).toBeDefined();
            expect(t.winner!.justification).toContain('synthesis failed');
        });
    });

    describe('resolution: judge', () => {
        it('parses clean JSON verdict and picks winner by role', async () => {
            let turn = 0;
            mockChat.mockImplementation(() => {
                turn++;
                if (turn <= 2) return Promise.resolve({ content: `position ${turn}` });
                return Promise.resolve({
                    content: JSON.stringify({
                        winnerRole: 'b',
                        justification: 'b made the tighter point',
                        finalAnswer: 'The answer is B.',
                    }),
                });
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'judge',
            });
            expect(t.winner!.role).toBe('b');
            expect(t.winner!.content).toBe('The answer is B.');
        });

        it('parses JSON wrapped in code fences', async () => {
            let turn = 0;
            mockChat.mockImplementation(() => {
                turn++;
                if (turn <= 2) return Promise.resolve({ content: `position ${turn}` });
                return Promise.resolve({
                    content: '```json\n{"winnerRole":"a","justification":"clear","finalAnswer":"A wins"}\n```',
                });
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'judge',
            });
            expect(t.winner!.role).toBe('a');
            expect(t.winner!.content).toBe('A wins');
        });

        it('falls back to vote when judge verdict is malformed', async () => {
            let turn = 0;
            mockChat.mockImplementation(() => {
                turn++;
                if (turn <= 2) return Promise.resolve({ content: `position ${turn}` });
                return Promise.resolve({ content: 'Sorry, I cannot judge this.' });
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'judge',
            });
            expect(t.winner).toBeDefined();
            expect(t.winner!.justification).toContain('malformed');
        });

        it('falls back to vote when judge LLM throws', async () => {
            let turn = 0;
            mockChat.mockImplementation(() => {
                turn++;
                if (turn <= 2) return Promise.resolve({ content: `pos ${turn}` });
                return Promise.reject(new Error('judge down'));
            });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'judge',
            });
            expect(t.winner!.justification).toContain('judge unavailable');
        });
    });

    describe('persistence', () => {
        it('writes transcript to disk after completion', async () => {
            mockChat.mockResolvedValue({ content: 'x' });
            const t = await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'vote',
            });
            const writeCall = mockWriteFileSync.mock.calls.find(c =>
                typeof c[0] === 'string' && c[0].includes(t.id)
            );
            expect(writeCall).toBeDefined();
        });

        it('emits a debate_resolved activity event', async () => {
            mockChat.mockResolvedValue({ content: 'x' });
            await debateModule.runDebate({
                question: 'q',
                participants: [{ role: 'a' }, { role: 'b' }],
                rounds: 1,
                resolution: 'vote',
            });
            // Give the async emit a tick to land.
            await new Promise(r => setTimeout(r, 10));
            const event = mockEmit.mock.calls.find(c => c[0] === 'commandpost:activity');
            expect(event).toBeDefined();
            expect(event![1].type).toBe('debate_resolved');
        });
    });

    describe('read-side helpers', () => {
        it('listDebates returns empty when directory missing', () => {
            mockExistsSync.mockReturnValue(false);
            expect(debateModule.listDebates()).toEqual([]);
        });

        it('listDebates parses JSON files and sorts newest-first', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['dbt-2.json', 'dbt-1.json', 'not-a-debate.txt']);
            mockReadFileSync.mockImplementation((p: string) => {
                if (p.includes('dbt-1.json')) return JSON.stringify({
                    id: 'dbt-1', question: 'q1', resolution: 'vote', rounds: 1,
                    startedAt: '2026-04-16T10:00:00Z', completedAt: '2026-04-16T10:00:05Z',
                    durationMs: 5000, winner: { role: 'a', content: '' }, turns: [], participants: [],
                });
                if (p.includes('dbt-2.json')) return JSON.stringify({
                    id: 'dbt-2', question: 'q2', resolution: 'judge', rounds: 2,
                    startedAt: '2026-04-16T12:00:00Z', completedAt: '2026-04-16T12:00:10Z',
                    durationMs: 10000, winner: { role: 'b', content: '' }, turns: [], participants: [],
                });
                return '';
            });
            const list = debateModule.listDebates();
            expect(list).toHaveLength(2);
            expect(list[0].id).toBe('dbt-2');
            expect(list[1].id).toBe('dbt-1');
        });

        it('getDebate returns null for missing id', () => {
            mockExistsSync.mockReturnValue(false);
            expect(debateModule.getDebate('missing')).toBeNull();
        });

        it('getDebate returns parsed transcript when present', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                id: 'dbt-abc', question: 'q', resolution: 'vote', rounds: 1,
                turns: [], participants: [], startedAt: 't', completedAt: 't', durationMs: 0,
            }));
            const d = debateModule.getDebate('dbt-abc');
            expect(d).not.toBeNull();
            expect(d!.id).toBe('dbt-abc');
        });
    });
});
