import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const {
    mockExistsSync,
    mockReaddirSync,
    mockReadFileSync,
    mockEnsureDir,
    mockRegisterTool,
    mockRunInNewContext,
} = vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockEnsureDir: vi.fn(),
    mockRegisterTool: vi.fn(),
    mockRunInNewContext: vi.fn(),
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
}));

vi.mock('path', async (importOriginal) => {
    const actual = await importOriginal<typeof import('path')>();
    return { ...actual };
});

vi.mock('vm', () => ({
    default: { runInNewContext: mockRunInNewContext },
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/mock/home/.titan',
    TITAN_SKILLS_DIR: '/mock/home/.titan/workspace/skills',
    TITAN_CREDENTIALS_DIR: '/mock/home/.titan/credentials',
    INCOME_LEDGER_PATH: '/mock/home/.titan/income-ledger.jsonl',
    DEFAULT_GATEWAY_HOST: '0.0.0.0',
    DEFAULT_GATEWAY_PORT: 48420,
    DEFAULT_WEB_PORT: 48421,
    DEFAULT_MODEL: 'anthropic/claude-sonnet-4-20250514',
    DEFAULT_MAX_TOKENS: 200000,
    DEFAULT_TEMPERATURE: 0.7,
    DEFAULT_SANDBOX_MODE: 'host',
    ALLOWED_TOOLS_DEFAULT: [],
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: mockRegisterTool,
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: mockEnsureDir,
    mkdirIfNotExists: mockEnsureDir,
}));

// ── Import module under test ─────────────────────────────────────────────

import {
    registerSkill,
    getSkills,
    getSkill,
    discoverWorkspaceSkills,
} from '../src/skills/registry.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSkillFile(name: string, content: string) {
    return { name, content };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Skills Registry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('registerSkill / getSkills / getSkill', () => {
        it('should register a skill and retrieve it', () => {
            const skill = {
                name: 'test_skill',
                description: 'A test skill',
                source: 'test',
            };
            const handler = { name: 'test_tool', description: 'Test tool', parameters: {}, handler: vi.fn() };
            registerSkill(skill as any, handler as any);
            expect(getSkills()).toContainEqual(expect.objectContaining({ name: 'test_skill' }));
            expect(getSkill('test_skill')).toMatchObject({ name: 'test_skill' });
        });

        it('should return undefined for unknown skill', () => {
            expect(getSkill('nonexistent')).toBeUndefined();
        });
    });

    describe('discoverWorkspaceSkills', () => {
        it('should discover skills from workspace directory', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 'test_skill', isDirectory: () => true, isFile: () => false }
            ] as any);
            mockReadFileSync.mockReturnValue(`---
name: test_skill
description: Test description
---
# Test Skill

This is a test skill.
`);

            const skills = discoverWorkspaceSkills();
            expect(skills).toHaveLength(1);
            expect(skills[0]).toMatchObject({
                name: 'test_skill',
                description: 'Test description',
            });
        });

        it('should handle missing workspace directory', () => {
            mockExistsSync.mockReturnValue(false);
            const skills = discoverWorkspaceSkills();
            expect(skills).toEqual([]);
        });

        it('should log discovered skill count', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 'skill1', isDirectory: () => true, isFile: () => false },
                { name: 'skill2', isDirectory: () => true, isFile: () => false }
            ] as any);
            mockReadFileSync.mockReturnValue(`---
name: skill1
description: Skill 1
---
# Skill 1
`);

            const skills = discoverWorkspaceSkills();
            expect(skills.length).toBe(2);
        });
    });
});
