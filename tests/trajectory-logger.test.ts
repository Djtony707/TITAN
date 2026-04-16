/**
 * TITAN — Trajectory Logger + Auto-Skill Generation Tests
 * Tests P1 from Hermes integration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
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
import { shouldGenerateSkill, generateSkillContent, saveGeneratedSkill, findMatchingSkills, getSkillGuidance, processTrajectoryForSkills } from '../src/agent/autoSkillGen.js';

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
            expect(content).toContain('read_file');
            expect(content).toContain('write_file');
        });

        it('includes statistics', async () => {
            const content = await generateSkillContent(makeTrajectory());
            expect(content).toContain('successful runs');
            expect(content).toContain('Average rounds');
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
