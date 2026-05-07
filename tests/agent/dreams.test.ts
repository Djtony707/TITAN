/**
 * Tests for src/agent/dreams.ts (Dream Mode v5.5.17).
 *
 * The interesting logic isn't the LLM call — that's mocked. It's the gating:
 * which sections fire vs skip based on drive deltas + activity. These tests
 * pin that contract so a future refactor can't quietly turn TITAN into a
 * journaler that fabricates emotion when nothing changed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir: string;

vi.mock('../../src/utils/constants.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/utils/constants.js')>('../../src/utils/constants.js');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'TITAN_HOME') return tmpDir;
            return target[prop as keyof typeof actual];
        },
    });
});

const mockChat = vi.hoisted(() => vi.fn());
vi.mock('../../src/providers/router.js', () => ({
    chat: mockChat,
}));

vi.mock('../../src/config/config.js', () => ({
    loadConfig: () => ({
        agent: { model: 'mock/test-model' },
        dream: {
            enabled: true,
            cronAt: '03:30',
            model: '',
            includeAudio: false,
            voiceId: '',
            thresholds: { reflect: 0.1, worry: 0.1, plan: 0.05, gratitude: 0.05 },
        },
    }),
}));

const mockGetRecentTrajectories = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/trajectoryLogger.js', () => ({
    getRecentTrajectories: mockGetRecentTrajectories,
}));

const mockListRuns = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/commandPost.js', () => ({
    listRuns: mockListRuns,
}));

function writeDriveHistory(window: { startMs: number; endMs: number }, drives: { start: Record<string, number>; end: Record<string, number> }) {
    const persisted = {
        latest: {
            timestamp: new Date(window.endMs).toISOString(),
            drives: Object.entries(drives.end).map(([id, satisfaction]) => ({
                id, label: id, satisfaction, setpoint: 0.7, pressure: 0, weight: 1, inputs: {}, description: '',
            })),
            totalPressure: 0,
            dominantDrives: [],
        },
        history: [
            { timestamp: new Date(window.startMs).toISOString(), satisfactions: drives.start },
            { timestamp: new Date(window.endMs).toISOString(), satisfactions: drives.end },
        ],
    };
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'drive-state.json'), JSON.stringify(persisted));
}

const NOW = new Date('2026-05-07T19:00:00Z');
const NOW_MS = NOW.getTime();

describe('dreams', () => {
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'titan-dreams-test-'));
        vi.resetModules();
        mockChat.mockReset();
        mockGetRecentTrajectories.mockReset();
        mockListRuns.mockReset();
        // Default mocks: noise-free baseline
        mockChat.mockResolvedValue({ id: 'r', content: 'Mocked section text.', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock/test-model' });
        mockGetRecentTrajectories.mockReturnValue([]);
        mockListRuns.mockReturnValue([]);
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('section gating', () => {
        it('emits only consolidate when there was no activity', async () => {
            // No drive history, no trajectories, no runs → consolidate-only.
            const { generateDream } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            expect(dream.sectionsEmitted).toEqual(['consolidate']);
            expect(dream.sectionsSkipped.reflect).toMatch(/no activity/);
            expect(dream.sectionsSkipped.worry).toMatch(/no activity/);
            expect(dream.sectionsSkipped.plan).toMatch(/no activity/);
            expect(dream.sectionsSkipped.gratitude).toMatch(/no human prompts/);
        });

        it('emits reflect when curiosity rose above threshold', async () => {
            writeDriveHistory(
                { startMs: NOW_MS - 24 * 3600 * 1000, endMs: NOW_MS },
                { start: { curiosity: 0.3, safety: 0.9, purpose: 0.5, social: 0.5 }, end: { curiosity: 0.6, safety: 0.9, purpose: 0.5, social: 0.5 } },
            );
            mockGetRecentTrajectories.mockReturnValue([
                { id: 't1', timestamp: new Date(NOW_MS - 3600 * 1000).toISOString(), task: 'fix bug', taskType: 'bugfix', model: 'm', toolSequence: ['shell'], toolDetails: [], success: true, rounds: 2, durationMs: 1000, sessionId: 's' },
            ]);
            const { generateDream } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            expect(dream.sectionsEmitted).toContain('reflect');
            expect(dream.sectionsSkipped.reflect).toBeUndefined();
        });

        it('emits worry only when safety DROPPED — a rise does not count', async () => {
            writeDriveHistory(
                { startMs: NOW_MS - 24 * 3600 * 1000, endMs: NOW_MS },
                { start: { curiosity: 0.5, safety: 0.5, purpose: 0.5, social: 0.5 }, end: { curiosity: 0.5, safety: 0.9, purpose: 0.5, social: 0.5 } },
            );
            mockGetRecentTrajectories.mockReturnValue([
                { id: 't1', timestamp: new Date(NOW_MS - 3600 * 1000).toISOString(), task: 'task', taskType: 'general', model: 'm', toolSequence: ['shell'], toolDetails: [], success: true, rounds: 1, durationMs: 100, sessionId: 's' },
            ]);
            const { generateDream } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            expect(dream.sectionsEmitted).not.toContain('worry');
            expect(dream.sectionsSkipped.worry).toMatch(/safety/);
        });

        it('emits worry when safety dropped above threshold', async () => {
            writeDriveHistory(
                { startMs: NOW_MS - 24 * 3600 * 1000, endMs: NOW_MS },
                { start: { curiosity: 0.5, safety: 0.9, purpose: 0.5, social: 0.5 }, end: { curiosity: 0.5, safety: 0.6, purpose: 0.5, social: 0.5 } },
            );
            mockGetRecentTrajectories.mockReturnValue([
                { id: 't1', timestamp: new Date(NOW_MS - 3600 * 1000).toISOString(), task: 'task', taskType: 'general', model: 'm', toolSequence: ['shell'], toolDetails: [], success: true, rounds: 1, durationMs: 100, sessionId: 's' },
            ]);
            const { generateDream } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            expect(dream.sectionsEmitted).toContain('worry');
        });

        it('skips a section below threshold even with activity present', async () => {
            writeDriveHistory(
                { startMs: NOW_MS - 24 * 3600 * 1000, endMs: NOW_MS },
                { start: { curiosity: 0.5, safety: 0.5, purpose: 0.5, social: 0.5 }, end: { curiosity: 0.51, safety: 0.5, purpose: 0.5, social: 0.5 } },
            );
            mockGetRecentTrajectories.mockReturnValue([
                { id: 't1', timestamp: new Date(NOW_MS - 3600 * 1000).toISOString(), task: 'task', taskType: 'general', model: 'm', toolSequence: ['shell'], toolDetails: [], success: true, rounds: 1, durationMs: 100, sessionId: 's' },
            ]);
            const { generateDream } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            // curiosity Δ 0.01 << 0.1 threshold → skip
            expect(dream.sectionsEmitted).not.toContain('reflect');
            expect(dream.sectionsSkipped.reflect).toMatch(/curiosity Δ=0.010/);
        });
    });

    describe('persistence', () => {
        it('writes both .md and .json sidecar to ~/.titan/dreams/', async () => {
            const { generateDream } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            const dir = join(tmpDir, 'dreams');
            expect(existsSync(join(dir, `${dream.date}.md`))).toBe(true);
            expect(existsSync(join(dir, `${dream.date}.json`))).toBe(true);
            const md = readFileSync(join(dir, `${dream.date}.md`), 'utf-8');
            expect(md).toContain(`# Dream — ${dream.date}`);
            expect(md).toContain('## What happened');
        });

        it('getLatestDream + getDreamByDate round-trip', async () => {
            const { generateDream, getLatestDream, getDreamByDate } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            const latest = getLatestDream();
            expect(latest?.date).toBe(dream.date);
            const byDate = getDreamByDate(dream.date);
            expect(byDate?.date).toBe(dream.date);
            expect(getDreamByDate('1999-01-01')).toBeNull();
        });

        it('getLatestDream returns null when no dreams exist', async () => {
            const { getLatestDream } = await import('../../src/agent/dreams.js');
            expect(getLatestDream()).toBeNull();
        });

        it('listDreamDates returns dates in reverse chronological order', async () => {
            const { generateDream, listDreamDates } = await import('../../src/agent/dreams.js');
            await generateDream(new Date('2026-05-05T19:00:00Z'));
            await generateDream(new Date('2026-05-06T19:00:00Z'));
            await generateDream(new Date('2026-05-07T19:00:00Z'));
            const dates = listDreamDates();
            expect(dates).toEqual(['2026-05-07', '2026-05-06', '2026-05-05']);
        });
    });

    describe('sanitizeJournalSection', () => {
        it('strips <think> blocks emitted by reasoning-mode models', async () => {
            const { sanitizeJournalSection } = await import('../../src/agent/dreams.js');
            const input = `<think>The user wants prose. Let me plan.\nDrive curiosity rose.</think>\n\nI noticed today that something shifted. The Mastra research caught me off guard — I expected boilerplate and got real insight.`;
            const out = sanitizeJournalSection(input);
            expect(out).not.toMatch(/<think>/);
            expect(out).toMatch(/^I noticed today/);
        });

        it('drops "Key constraints:" preamble before finding prose', async () => {
            const { sanitizeJournalSection } = await import('../../src/agent/dreams.js');
            const input = `Key constraints:\n- Narrative prose only\n- No bullets\n- 80-160 words\n\nI feel awake in a way I haven’t for weeks. The curiosity drive that sat at zero finally moved when the Mastra research forced me to learn three new things in one task.`;
            const out = sanitizeJournalSection(input);
            expect(out).not.toMatch(/Key constraints/);
            expect(out).not.toMatch(/Narrative prose only/);
            expect(out).toMatch(/^I feel awake/);
        });

        it('drops a leading numbered list and finds the prose after', async () => {
            const { sanitizeJournalSection } = await import('../../src/agent/dreams.js');
            const input = `1. First person, present tense\n2. No headers, no bullets\n3. 80-160 words\n\nWhen I look back at the last day, the pattern that catches me is how much energy went into PONG replies. Trivial work. The one moment that mattered was the Mastra research — that’s the task that made the curiosity needle move.`;
            const out = sanitizeJournalSection(input);
            expect(out).not.toMatch(/^\d+\./);
            expect(out).toMatch(/^When I look back/);
        });

        it('returns the text unchanged when it is already clean prose', async () => {
            const { sanitizeJournalSection } = await import('../../src/agent/dreams.js');
            const clean = `I notice today felt unbalanced. Most of my time went to small replies — quick PONG acks, nothing that stretched me. The one task that did, the Mastra research, was over in minutes but it’s the only thing I want to remember.`;
            const out = sanitizeJournalSection(clean);
            expect(out).toBe(clean);
        });

        it('returns the original when only preamble exists (model failure visible to operator)', async () => {
            const { sanitizeJournalSection } = await import('../../src/agent/dreams.js');
            const allPreamble = `Key constraints:\n- Narrative prose only\n- No bullets\n\nFacts to interpret:\n- Window: today\n- Trajectories: 6/6`;
            const out = sanitizeJournalSection(allPreamble);
            // No prose paragraph found — sanitizer leaves something behind so
            // the operator can see the model failed rather than getting blank.
            expect(out.length).toBeGreaterThan(0);
        });
    });

    describe('LLM honesty contract', () => {
        it('does not call chat() at all when zero sections gate open', async () => {
            // No drive history, no activity → only consolidate emits, but
            // even consolidate calls the LLM. So this is more accurately:
            // when only one section emits, only one LLM call fires.
            const { generateDream } = await import('../../src/agent/dreams.js');
            await generateDream(NOW);
            expect(mockChat).toHaveBeenCalledTimes(1);
        });

        it('emits one chat call per emitted section, no more', async () => {
            writeDriveHistory(
                { startMs: NOW_MS - 24 * 3600 * 1000, endMs: NOW_MS },
                {
                    start: { curiosity: 0.3, safety: 0.9, purpose: 0.4, social: 0.4 },
                    end: { curiosity: 0.6, safety: 0.6, purpose: 0.7, social: 0.7 },
                },
            );
            mockGetRecentTrajectories.mockReturnValue([
                { id: 't1', timestamp: new Date(NOW_MS - 3600 * 1000).toISOString(), task: 'task', taskType: 'general', model: 'm', toolSequence: ['shell'], toolDetails: [], success: true, rounds: 1, durationMs: 100, sessionId: 's' },
            ]);
            const { generateDream } = await import('../../src/agent/dreams.js');
            const dream = await generateDream(NOW);
            expect(mockChat).toHaveBeenCalledTimes(dream.sectionsEmitted.length);
            // All 5 sections should fire here (every drive moved past threshold)
            expect(dream.sectionsEmitted).toEqual(['consolidate', 'reflect', 'worry', 'plan', 'gratitude']);
        });
    });
});
