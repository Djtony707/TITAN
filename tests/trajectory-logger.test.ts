/**
 * TITAN — Trajectory Logger + Auto-Skill Generation Tests
 * Tests P1 from Hermes integration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = vi.hoisted(() => {
    const os = require('os');
    const path = require('path');
    return path.join(os.tmpdir(), 'titan-test-traj-' + Date.now());
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, homedir: () => testDir };
});

vi.mock('../src/memory/learning.js', () => ({
    classifyTaskType: vi.fn().mockReturnValue('coding'),
}));

// Mock config + LLM router so autoSkillGen's LLM-enhanced generation falls
// back to template mode (no real API call in tests)
vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({ agent: { modelAliases: { fast: 'test/model' } } }),
}));

vi.mock('../src/providers/router.js', () => ({
    chat: vi.fn().mockRejectedValue(new Error('LLM mocked — fallback to template')),
}));

import { logTrajectory, getRecentTrajectories, getSequenceSignature, countMatchingTrajectories, type TaskTrajectory } from '../src/agent/trajectoryLogger.js';
import { shouldGenerateSkill, generateSkillContent, saveGeneratedSkill, findMatchingSkills, getSkillGuidance, processTrajectoryForSkills, resolveSkillGenerationModel } from '../src/agent/autoSkillGen.js';
import {
    applyLearningPatternTransitions,
    ingestTrajectoryLearningSignal,
    loadLearningCuratorState,
    runLearningReview,
    saveLearningCuratorState,
    shouldRunLearningReview,
} from '../src/agent/learningCurator.js';
import { readLessonsMarkdown } from '../src/agent/agentLessons.js';
import { loadConfig } from '../src/config/config.js';
import { chat } from '../src/providers/router.js';

function makeTrajectory(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
    return {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        task: 'Test task',
        taskType: 'coding',
        model: 'anthropic/claude-sonnet-4-20250514',
        toolSequence: ['read_file', 'write_file'],
        toolDetails: [
            { name: 'read_file', args: { path: '/tmp/test.ts' }, success: true, resultSnippet: 'file contents' },
            { name: 'write_file', args: { path: '/tmp/test.ts', content: 'new' }, success: true, resultSnippet: 'OK' },
        ],
        success: true,
        rounds: 3,
        durationMs: 5000,
        sessionId: 'test-session',
        ...overrides,
    };
}

beforeEach(() => {
    mkdirSync(join(testDir, '.titan', 'trajectories'), { recursive: true });
    mkdirSync(join(testDir, '.titan', 'workspace', 'skills'), { recursive: true });
});

afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('TrajectoryLogger', () => {
    it('logs a trajectory to JSONL file', () => {
        const t = makeTrajectory();
        logTrajectory(t);

        const recent = getRecentTrajectories(10);
        expect(recent.length).toBe(1);
        expect(recent[0].task).toBe('Test task');
        expect(recent[0].toolSequence).toEqual(['read_file', 'write_file']);
    });

    it('logs multiple trajectories', () => {
        logTrajectory(makeTrajectory({ task: 'Task 1' }));
        logTrajectory(makeTrajectory({ task: 'Task 2' }));
        logTrajectory(makeTrajectory({ task: 'Task 3' }));

        const recent = getRecentTrajectories(10);
        expect(recent.length).toBe(3);
    });

    it('filters by taskType', () => {
        logTrajectory(makeTrajectory({ taskType: 'coding' }));
        logTrajectory(makeTrajectory({ taskType: 'research' }));

        const coding = getRecentTrajectories(10, { taskType: 'coding' });
        expect(coding.length).toBe(1);
        expect(coding[0].taskType).toBe('coding');
    });

    it('filters by success', () => {
        logTrajectory(makeTrajectory({ success: true }));
        logTrajectory(makeTrajectory({ success: false }));

        const successful = getRecentTrajectories(10, { success: true });
        expect(successful.length).toBe(1);
    });

    it('respects limit', () => {
        for (let i = 0; i < 10; i++) {
            logTrajectory(makeTrajectory({ task: `Task ${i}` }));
        }
        const recent = getRecentTrajectories(3);
        expect(recent.length).toBe(3);
    });

    it('returns empty array when no file exists', () => {
        const recent = getRecentTrajectories(10);
        // File was just created in beforeEach but may not have data yet
        expect(recent.length).toBe(0);
    });
});

describe('getSequenceSignature', () => {
    it('joins tool names with arrow', () => {
        expect(getSequenceSignature(['read_file', 'write_file'])).toBe('read_file → write_file');
    });

    it('handles single tool', () => {
        expect(getSequenceSignature(['shell'])).toBe('shell');
    });
});

describe('countMatchingTrajectories', () => {
    it('counts matching successful trajectories', () => {
        // Log 3 identical successful trajectories
        for (let i = 0; i < 3; i++) {
            logTrajectory(makeTrajectory());
        }
        const count = countMatchingTrajectories('coding', ['read_file', 'write_file']);
        expect(count).toBe(3);
    });

    it('does not count failed trajectories', () => {
        logTrajectory(makeTrajectory({ success: true }));
        logTrajectory(makeTrajectory({ success: false }));
        const count = countMatchingTrajectories('coding', ['read_file', 'write_file']);
        expect(count).toBe(1);
    });

    it('does not count different tool sequences', () => {
        logTrajectory(makeTrajectory({ toolSequence: ['read_file', 'write_file'] }));
        logTrajectory(makeTrajectory({ toolSequence: ['shell', 'write_file'] }));
        const count = countMatchingTrajectories('coding', ['read_file', 'write_file']);
        expect(count).toBe(1);
    });
});

describe('AutoSkillGen', () => {
    describe('shouldGenerateSkill', () => {
        it('returns false for failed trajectories', () => {
            expect(shouldGenerateSkill(makeTrajectory({ success: false }))).toBe(false);
        });

        it('returns false for single-tool trajectories', () => {
            expect(shouldGenerateSkill(makeTrajectory({ toolSequence: ['shell'] }))).toBe(false);
        });

        it('returns false when fewer than 3 matching trajectories', () => {
            logTrajectory(makeTrajectory());
            logTrajectory(makeTrajectory());
            // Only 2 matching trajectories
            expect(shouldGenerateSkill(makeTrajectory())).toBe(false);
        });

        it('returns true when 3+ matching trajectories exist', () => {
            for (let i = 0; i < 3; i++) {
                logTrajectory(makeTrajectory());
            }
            expect(shouldGenerateSkill(makeTrajectory())).toBe(true);
        });

        it('returns false when skill already exists', async () => {
            for (let i = 0; i < 3; i++) {
                logTrajectory(makeTrajectory());
            }
            // Generate the skill first (now async — LLM mock falls back to template)
            await saveGeneratedSkill(makeTrajectory());
            // Now it should return false
            expect(shouldGenerateSkill(makeTrajectory())).toBe(false);
        });
    });

    describe('generateSkillContent', () => {
        it('produces valid SKILL.md with frontmatter', async () => {
            const content = await generateSkillContent(makeTrajectory());
            expect(content).toContain('---');
            expect(content).toContain('name: auto-coding-');
            expect(content).toContain('version: 1.0.0');
            expect(content).toContain('author: TITAN AutoSkill');
            expect(content).toContain('taskType: coding');
            expect(content).toContain('toolSequence: ["read_file", "write_file"]');
            expect(content).toContain('read_file');
            expect(content).toContain('write_file');
        });

        it('includes statistics', async () => {
            const content = await generateSkillContent(makeTrajectory());
            expect(content).toContain('successful runs');
            expect(content).toContain('Average rounds');
        });

        it('resolves the skill generation model from configured aliases without provider lock-in', () => {
            vi.mocked(loadConfig).mockReturnValueOnce({
                agent: {
                    model: 'openai/gpt-4o',
                    modelAliases: { reasoning: 'google/gemini-2.5-pro' },
                },
            } as ReturnType<typeof loadConfig>);

            expect(resolveSkillGenerationModel()).toBe('google/gemini-2.5-pro');
        });

        it('falls back to the configured active model when no tier alias is set', () => {
            vi.mocked(loadConfig).mockReturnValueOnce({
                agent: {
                    model: 'openrouter/anthropic/claude-sonnet-4',
                    modelAliases: {},
                },
            } as ReturnType<typeof loadConfig>);

            expect(resolveSkillGenerationModel()).toBe('openrouter/anthropic/claude-sonnet-4');
        });
    });

    describe('saveGeneratedSkill', () => {
        it('creates SKILL.md in workspace skills directory', async () => {
            const skill = await saveGeneratedSkill(makeTrajectory());
            expect(skill).not.toBeNull();
            expect(skill!.name).toContain('auto-coding-');
            expect(skill!.toolSequence).toEqual(['read_file', 'write_file']);

            // Verify file exists
            const skillDir = join(testDir, '.titan', 'workspace', 'skills', skill!.name);
            expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
        });
    });

    describe('findMatchingSkills', () => {
        it('finds auto-generated skills by task type', async () => {
            await saveGeneratedSkill(makeTrajectory());
            const skills = findMatchingSkills('write some code', 'coding');
            expect(skills.length).toBeGreaterThan(0);
            expect(skills[0].taskType).toBe('coding');
        });

        it('returns empty array when no skills match', () => {
            const skills = findMatchingSkills('cook a meal', 'cooking');
            expect(skills.length).toBe(0);
        });

        it('recalls LLM-generated skills from structured frontmatter even without legacy bold tool markers', async () => {
            vi.mocked(chat).mockResolvedValueOnce({
                content: `---
name: auto-coding-test
description: Rich LLM skill for coding tasks
version: 1.0.0
author: TITAN AutoSkill
category: auto-generated
taskType: coding
toolSequence: ["read_file", "write_file"]
successCount: 3
avgRounds: 2
generatedAt: 2026-05-21T00:00:00.000Z
---

# Rich Skill

Use the saved read/write flow for this coding task.
Validate with the focused test before broad verification.
This paragraph is intentionally long enough to pass the LLM-enhanced content length gate without requiring legacy bold tool markers in the skill body.`,
            } as Awaited<ReturnType<typeof chat>>);

            await saveGeneratedSkill(makeTrajectory());
            const skills = findMatchingSkills('write some code', 'coding');

            expect(skills.length).toBe(1);
            expect(skills[0].toolSequence).toEqual(['read_file', 'write_file']);
            expect(skills[0].successCount).toBe(3);
            expect(skills[0].avgRounds).toBe(2);
        });
    });

    describe('getSkillGuidance', () => {
        it('returns guidance string when matching skill exists', async () => {
            await saveGeneratedSkill(makeTrajectory());
            const guidance = getSkillGuidance('write some code');
            expect(guidance).not.toBeNull();
            expect(guidance).toContain('read_file');
            expect(guidance).toContain('write_file');
            expect(guidance).toContain('proven approach');
        });

        it('returns null when no matching skill exists', () => {
            const guidance = getSkillGuidance('cook a meal');
            expect(guidance).toBeNull();
        });

        it('returns continuous learning guidance even before an auto-skill exists', () => {
            saveLearningCuratorState({
                lastRunAt: '2026-05-21T00:00:00.000Z',
                lastRunSummary: null,
                runCount: 0,
                paused: false,
                patterns: {},
            });
            ingestTrajectoryLearningSignal(makeTrajectory({
                timestamp: '2026-05-21T00:01:00.000Z',
            }));
            ingestTrajectoryLearningSignal(makeTrajectory({
                id: crypto.randomUUID(),
                timestamp: '2026-05-21T00:02:00.000Z',
            }));

            const guidance = getSkillGuidance('write some code');

            expect(guidance).not.toBeNull();
            expect(guidance).toContain('Continuous learning');
            expect(guidance).toContain('read_file → write_file');
        });
    });

    describe('processTrajectoryForSkills', () => {
        it('generates skill when threshold is met', async () => {
            for (let i = 0; i < 3; i++) {
                logTrajectory(makeTrajectory());
            }
            processTrajectoryForSkills(makeTrajectory());
            // processTrajectoryForSkills is fire-and-forget async — wait for it
            await new Promise(r => setTimeout(r, 100));

            // Verify skill was created
            const skills = findMatchingSkills('code', 'coding');
            expect(skills.length).toBeGreaterThan(0);
        });

        it('does not generate skill below threshold', () => {
            logTrajectory(makeTrajectory());
            processTrajectoryForSkills(makeTrajectory());

            const skills = findMatchingSkills('code', 'coding');
            expect(skills.length).toBe(0);
        });
    });
});

describe('LearningCurator', () => {
    it('defers the first automatic review and seeds state like Hermes curator', () => {
        const shouldRun = shouldRunLearningReview(new Date('2026-05-21T00:00:00.000Z'));
        const state = loadLearningCuratorState();

        expect(shouldRun).toBe(false);
        expect(state.lastRunAt).toBe('2026-05-21T00:00:00.000Z');
        expect(state.lastRunSummary).toContain('deferred');
    });

    it('records a durable win lesson from repeated successful trajectories', () => {
        saveLearningCuratorState({
            lastRunAt: '2026-05-19T00:00:00.000Z',
            lastRunSummary: null,
            runCount: 0,
            paused: false,
            patterns: {},
        });

        for (let i = 0; i < 3; i++) {
            logTrajectory(makeTrajectory({ timestamp: `2026-05-20T00:0${i}:00.000Z` }));
        }

        const result = runLearningReview(
            makeTrajectory({ timestamp: '2026-05-21T00:00:00.000Z' }),
            new Date('2026-05-21T00:00:00.000Z'),
        );
        const lessons = readLessonsMarkdown('default');
        const state = loadLearningCuratorState();

        expect(result.shouldRun).toBe(true);
        expect(result.lessonsRecorded).toBeGreaterThanOrEqual(1);
        expect(result.reportPath).toMatch(/REPORT\.md$/);
        expect(existsSync(result.reportPath || '')).toBe(true);
        expect(state.lastReportPath).toBe(result.reportPath);
        expect(state.lastRunDurationMs).toEqual(expect.any(Number));
        expect(lessons).toContain('For coding tasks');
        expect(lessons).toContain('read_file → write_file');
    });

    it('writes a readable curator report for each review pass', () => {
        saveLearningCuratorState({
            lastRunAt: '2026-05-19T00:00:00.000Z',
            lastRunDurationMs: null,
            lastRunSummary: null,
            lastReportPath: null,
            runCount: 0,
            paused: false,
            patterns: {},
        });

        for (let i = 0; i < 3; i++) {
            logTrajectory(makeTrajectory({ timestamp: `2026-05-20T00:0${i}:00.000Z` }));
        }

        const result = runLearningReview(
            makeTrajectory({ timestamp: '2026-05-21T00:00:00.000Z' }),
            new Date('2026-05-21T00:00:00.000Z'),
        );
        const report = readFileSync(result.reportPath || '', 'utf-8');

        expect(report).toContain('TITAN Learning Curator Report');
        expect(report).toContain('Recent trajectories checked: 3');
        expect(report).toContain('Pattern Transitions');
        expect(report).toContain('Lessons');
    });

    it('records a failure lesson when the same tool sequence fails repeatedly', () => {
        saveLearningCuratorState({
            lastRunAt: '2026-05-19T00:00:00.000Z',
            lastRunSummary: null,
            runCount: 0,
            paused: false,
            patterns: {},
        });

        for (let i = 0; i < 2; i++) {
            logTrajectory(makeTrajectory({
                success: false,
                timestamp: `2026-05-20T00:0${i}:00.000Z`,
                toolDetails: [
                    { name: 'read_file', args: { path: '/tmp/test.ts' }, success: true, resultSnippet: 'file contents' },
                    { name: 'write_file', args: { path: '/tmp/test.ts' }, success: false, resultSnippet: 'permission denied' },
                ],
            }));
        }
        logTrajectory(makeTrajectory({ timestamp: '2026-05-20T00:03:00.000Z' }));

        const result = runLearningReview(
            makeTrajectory({ success: false, timestamp: '2026-05-21T00:00:00.000Z' }),
            new Date('2026-05-21T00:00:00.000Z'),
        );
        const lessons = readLessonsMarkdown('default');

        expect(result.shouldRun).toBe(true);
        expect(lessons).toContain('repeated failures');
        expect(lessons).toContain('write_file');
    });

    it('updates continuous per-pattern learning state without waiting for the review interval', () => {
        saveLearningCuratorState({
            lastRunAt: '2026-05-21T00:00:00.000Z',
            lastRunSummary: null,
            runCount: 0,
            paused: false,
            patterns: {},
        });

        const pattern = ingestTrajectoryLearningSignal(makeTrajectory({
            timestamp: '2026-05-21T00:05:00.000Z',
        }));
        const state = loadLearningCuratorState();

        expect(pattern.successes).toBe(1);
        expect(pattern.failures).toBe(0);
        expect(pattern.state).toBe('active');
        expect(Object.values(state.patterns)[0].signature).toBe('read_file → write_file');
    });

    it('does not turn transient setup failures into durable failure lessons', () => {
        saveLearningCuratorState({
            lastRunAt: '2026-05-19T00:00:00.000Z',
            lastRunSummary: null,
            runCount: 0,
            paused: false,
            patterns: {},
        });

        for (let i = 0; i < 2; i++) {
            logTrajectory(makeTrajectory({
                success: false,
                timestamp: `2026-05-20T00:0${i}:00.000Z`,
                toolDetails: [
                    { name: 'shell', args: { cmd: 'pnpm test' }, success: false, resultSnippet: 'pnpm: command not found' },
                ],
                toolSequence: ['shell'],
            }));
        }

        const result = runLearningReview(
            makeTrajectory({
                success: false,
                timestamp: '2026-05-21T00:00:00.000Z',
                toolSequence: ['shell'],
                toolDetails: [
                    { name: 'shell', args: { cmd: 'pnpm test' }, success: false, resultSnippet: 'pnpm: command not found' },
                ],
            }),
            new Date('2026-05-21T00:00:00.000Z'),
            2,
        );
        const lessons = readLessonsMarkdown('default');

        expect(result.shouldRun).toBe(true);
        expect(result.lessonsRecorded).toBe(0);
        expect(lessons).not.toContain('command not found');
        expect(lessons).not.toContain('repeated failures');
    });

    it('moves a repeated durable failure pattern into watch state', () => {
        saveLearningCuratorState({
            lastRunAt: '2026-05-21T00:00:00.000Z',
            lastRunSummary: null,
            runCount: 0,
            paused: false,
            patterns: {},
        });

        const failed = makeTrajectory({
            success: false,
            timestamp: '2026-05-21T00:05:00.000Z',
            toolDetails: [
                { name: 'read_file', args: { path: '/tmp/test.ts' }, success: true, resultSnippet: 'file contents' },
                { name: 'write_file', args: { path: '/tmp/test.ts' }, success: false, resultSnippet: 'permission denied' },
            ],
        });

        ingestTrajectoryLearningSignal(failed);
        const pattern = ingestTrajectoryLearningSignal({
            ...failed,
            id: crypto.randomUUID(),
            timestamp: '2026-05-21T00:06:00.000Z',
        });

        expect(pattern.failures).toBe(2);
        expect(pattern.transientFailures).toBe(0);
        expect(pattern.state).toBe('watch');
        expect(pattern.commonFailureTool).toBe('write_file');
    });

    it('ages inactive learning patterns through stale and archived lifecycle states', () => {
        saveLearningCuratorState({
            lastRunAt: '2026-05-21T00:00:00.000Z',
            lastRunSummary: null,
            runCount: 0,
            paused: false,
            patterns: {
                stale: {
                    taskType: 'coding',
                    signature: 'read_file → write_file',
                    toolSequence: ['read_file', 'write_file'],
                    successes: 3,
                    failures: 0,
                    transientFailures: 0,
                    state: 'active',
                    firstSeenAt: '2026-04-01T00:00:00.000Z',
                    lastSeenAt: '2026-04-20T00:00:00.000Z',
                    lastSuccessAt: '2026-04-20T00:00:00.000Z',
                    lastFailureAt: null,
                    commonFailureTool: null,
                },
                archive: {
                    taskType: 'coding',
                    signature: 'shell',
                    toolSequence: ['shell'],
                    successes: 1,
                    failures: 0,
                    transientFailures: 0,
                    state: 'active',
                    firstSeenAt: '2026-01-01T00:00:00.000Z',
                    lastSeenAt: '2026-01-15T00:00:00.000Z',
                    lastSuccessAt: '2026-01-15T00:00:00.000Z',
                    lastFailureAt: null,
                    commonFailureTool: null,
                },
            },
        });

        const counts = applyLearningPatternTransitions(new Date('2026-05-21T00:00:00.000Z'));
        const state = loadLearningCuratorState();

        expect(counts.markedStale).toBe(1);
        expect(counts.archived).toBe(1);
        expect(state.patterns.stale.state).toBe('stale');
        expect(state.patterns.archive.state).toBe('archived');
    });
});
