import { describe, it, expect } from 'vitest';
import { mineCandidates, draftFallback, medianOf, isExamSafe, type MinedCandidate } from '../src/agent/muscleMemory.js';
import type { TaskTrajectory } from '../src/agent/trajectoryLogger.js';

function traj(over: Partial<TaskTrajectory>): TaskTrajectory {
    return {
        id: `t-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        task: 'check the weather in Kelseyville and summarize',
        taskType: 'research',
        model: 'test/model',
        toolSequence: ['web_search', 'browse_url'],
        toolDetails: [
            { name: 'web_search', args: { query: 'weather kelseyville' }, success: true, resultSnippet: 'sunny' },
            { name: 'browse_url', args: { url: 'https://weather.example' }, success: true, resultSnippet: '72F' },
        ],
        success: true,
        rounds: 3,
        durationMs: 12000,
        sessionId: 's1',
        ...over,
    };
}

describe('muscle memory mining', () => {
    it('finds a workflow repeated >= minOccurrences with identical sequence', () => {
        const ts = [traj({}), traj({}), traj({}), traj({ toolSequence: ['shell'], toolDetails: [] })];
        const found = mineCandidates(ts, new Set(), 3);
        expect(found).toHaveLength(1);
        expect(found[0].occurrences).toHaveLength(3);
        expect(found[0].toolSequence).toEqual(['web_search', 'browse_url']);
    });

    it('ignores failures, single-tool sequences, and known signatures', () => {
        const failed = [traj({ success: false }), traj({ success: false }), traj({ success: false })];
        expect(mineCandidates(failed, new Set(), 3)).toHaveLength(0);

        const short = [traj({ toolSequence: ['shell'] }), traj({ toolSequence: ['shell'] }), traj({ toolSequence: ['shell'] })];
        expect(mineCandidates(short, new Set(), 3)).toHaveLength(0);

        const ts = [traj({}), traj({}), traj({})];
        const first = mineCandidates(ts, new Set(), 3);
        const known = new Set([first[0].signature]);
        expect(mineCandidates(ts, known, 3)).toHaveLength(0);
    });

    it('separates same tools under different task types', () => {
        const ts = [traj({}), traj({}), traj({ taskType: 'coding' }), traj({ taskType: 'coding' })];
        const found = mineCandidates(ts, new Set(), 2);
        expect(found).toHaveLength(2);
        expect(new Set(found.map(f => f.taskType))).toEqual(new Set(['research', 'coding']));
    });

    it('ranks the most-repeated workflow first', () => {
        const ts = [
            traj({}), traj({}), traj({}),
            traj({ taskType: 'coding' }), traj({ taskType: 'coding' }), traj({ taskType: 'coding' }), traj({ taskType: 'coding' }),
        ];
        const found = mineCandidates(ts, new Set(), 3);
        expect(found[0].taskType).toBe('coding');
    });
});

describe('draft fallback', () => {
    it('produces a runnable recipe shape without an LLM', () => {
        const c: MinedCandidate = {
            taskType: 'research',
            signature: 'research::web_search→browse_url',
            toolSequence: ['web_search', 'browse_url'],
            occurrences: [traj({})],
        };
        const d = draftFallback(c);
        // bare (slash-less) — the recipe store convention; '/' is display-only
        expect(d.slashCommand).toMatch(/^[a-z0-9-]+$/);
        expect(d.stepPrompt).toContain('web_search');
        expect(d.stepPrompt).toContain('{{request}}');
        expect(d.parameters.request).toBeDefined();
    });
});

describe('medianOf', () => {
    it('handles odd, even, and empty', () => {
        expect(medianOf([5, 1, 3])).toBe(3);
        expect(medianOf([1, 2, 3, 4])).toBe(3); // rounded (2+3)/2 = 2.5 → 3
        expect(medianOf([])).toBe(0);
    });
});

describe('exam safety gate', () => {
    it('blocks TITAN\'s REAL verb-last side-effect tool names (review finding)', () => {
        // These are actual registered tool names — the exam replays for real,
        // so every one of these must be un-minable.
        const realDangerous = [
            'email_send', 'x_post', 'fb_post', 'slack_post', 'fb_delete_post',
            'content_publish', 'train_deploy', 'goal_delete', 'kb_delete',
            'rag_delete', 'trigger_delete', 'workflow_delete', 'a2a_send_task',
            'send_agent_message', 'sessions_send', 'shell', 'ha_control',
            'create_widget', 'cron_create', 'config_set',
        ];
        for (const tool of realDangerous) {
            expect(isExamSafe(['web_search', tool]), `${tool} must be exam-unsafe`).toBe(false);
        }
    });

    it('keeps read-only workflows learnable', () => {
        for (const tool of ['web_search', 'browse_url', 'kb_search', 'gallery_get', 'memory_recall', 'weather_current']) {
            expect(isExamSafe([tool]), `${tool} should be learnable`).toBe(true);
        }
    });

    it('never mines side-effectful sequences end to end', () => {
        const risky = [
            traj({ toolSequence: ['web_search', 'email_send'], toolDetails: [] }),
            traj({ toolSequence: ['web_search', 'email_send'], toolDetails: [] }),
            traj({ toolSequence: ['web_search', 'email_send'], toolDetails: [] }),
        ];
        expect(mineCandidates(risky, new Set(), 3)).toHaveLength(0);
    });
});
