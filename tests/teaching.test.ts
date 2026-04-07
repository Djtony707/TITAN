/**
 * TITAN — Teaching & User Profile Tests
 * Tests user profile management, teaching engine, and adaptive behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
    TITAN_NAME: 'TITAN',
    TITAN_VERSION: '2026.6.8',
}));

const mockProfileData: Record<string, unknown> = {};
let mockFileExists = false;

vi.mock('fs', () => ({
    existsSync: () => mockFileExists,
    readFileSync: () => JSON.stringify(mockProfileData),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

vi.mock('../src/utils/helpers.js', () => ({
    readJsonFile: () => mockFileExists ? mockProfileData : null,
    writeJsonFile: vi.fn(),
    ensureDir: vi.fn(),
}));

const mockLoadConfig = vi.fn().mockReturnValue({
    teaching: {
        enabled: true,
        revealThreshold: 5,
        showHints: true,
        firstRunWizard: true,
    },
});

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => mockLoadConfig(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import {
    deriveSkillLevel,
    type UserProfile,
} from '../src/agent/userProfile.js';

import {
    isTeachRequest,
    isCorrection,
    getFirstRunMessage,
    mapUseCaseDefaults,
    getToolSuggestions,
    getRecommendedTools,
    getTeachingContext,
} from '../src/agent/teaching.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
    return {
        toolUsage: {},
        skillLevel: 'beginner',
        preferences: {},
        corrections: [],
        firstRunCompleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('UserProfile', () => {
    describe('deriveSkillLevel', () => {
        it('returns beginner for empty profile', () => {
            const profile = makeProfile();
            expect(deriveSkillLevel(profile)).toBe('beginner');
        });

        it('returns beginner for low usage', () => {
            const profile = makeProfile({
                toolUsage: { shell: 10, read_file: 5 },
            });
            expect(deriveSkillLevel(profile)).toBe('beginner');
        });

        it('returns intermediate for moderate usage', () => {
            const usage: Record<string, number> = {};
            for (let i = 0; i < 8; i++) {
                usage[`tool_${i}`] = 7;
            }
            const profile = makeProfile({ toolUsage: usage });
            expect(deriveSkillLevel(profile)).toBe('intermediate');
        });

        it('returns advanced for heavy usage', () => {
            const usage: Record<string, number> = {};
            for (let i = 0; i < 16; i++) {
                usage[`tool_${i}`] = 15;
            }
            const profile = makeProfile({ toolUsage: usage });
            expect(deriveSkillLevel(profile)).toBe('advanced');
        });
    });
});

describe('Teaching Engine', () => {
    beforeEach(() => {
        mockLoadConfig.mockReturnValue({
            teaching: {
                enabled: true,
                revealThreshold: 5,
                showHints: true,
                firstRunWizard: true,
            },
        });
    });

    describe('isTeachRequest', () => {
        it('detects "how do I" questions', () => {
            expect(isTeachRequest('how do I use the shell tool?')).toBe(true);
        });

        it('detects "what is" questions', () => {
            expect(isTeachRequest('what is the memory tool?')).toBe(true);
        });

        it('detects "explain" requests', () => {
            expect(isTeachRequest('explain how sandboxing works')).toBe(true);
        });

        it('detects "show me how" requests', () => {
            expect(isTeachRequest('show me how to create a cron job')).toBe(true);
        });

        it('does not match regular commands', () => {
            expect(isTeachRequest('list the files in /tmp')).toBe(false);
        });

        it('does not match simple statements', () => {
            expect(isTeachRequest('run npm install')).toBe(false);
        });
    });

    describe('isCorrection', () => {
        it('detects "no, do X" corrections', () => {
            expect(isCorrection('no, use python instead')).toBe(true);
        });

        it('detects "actually" corrections', () => {
            expect(isCorrection('actually, I wanted JSON format')).toBe(true);
        });

        it('detects "that\'s not" corrections', () => {
            expect(isCorrection("that's not what I meant")).toBe(true);
        });

        it('detects "I meant" corrections', () => {
            expect(isCorrection('I meant the other directory')).toBe(true);
        });

        it('does not match regular messages', () => {
            expect(isCorrection('please search for recent news')).toBe(false);
        });
    });

    describe('getFirstRunMessage', () => {
        it('returns a non-empty welcome message', () => {
            const msg = getFirstRunMessage();
            expect(msg).toContain('Welcome to TITAN');
            expect(msg).toContain('Developer');
            expect(msg).toContain('Homelab');
            expect(msg).toContain('Business');
            expect(msg).toContain('Creative');
        });
    });

    describe('mapUseCaseDefaults', () => {
        it('maps "1" to developer', () => {
            expect(mapUseCaseDefaults('1')).toEqual(expect.objectContaining({ useCase: 'developer' }));
        });

        it('maps "developer" to developer', () => {
            expect(mapUseCaseDefaults('developer')).toEqual(expect.objectContaining({ useCase: 'developer' }));
        });

        it('maps "2" to homelab', () => {
            expect(mapUseCaseDefaults('2')).toEqual(expect.objectContaining({ useCase: 'homelab' }));
        });

        it('maps "business" to business', () => {
            expect(mapUseCaseDefaults('business')).toEqual(expect.objectContaining({ useCase: 'business' }));
        });

        it('maps "music" to creative', () => {
            expect(mapUseCaseDefaults('music')).toEqual(expect.objectContaining({ useCase: 'creative' }));
        });

        it('falls back to general for unknown', () => {
            expect(mapUseCaseDefaults('xyz')).toEqual(expect.objectContaining({ useCase: 'general' }));
        });
    });

    describe('getToolSuggestions', () => {
        it('returns empty for new profile', () => {
            const profile = makeProfile();
            expect(getToolSuggestions(profile, 5)).toEqual([]);
        });

        it('suggests code_exec after heavy shell usage', () => {
            const profile = makeProfile({ toolUsage: { shell: 15 } });
            const suggestions = getToolSuggestions(profile, 5);
            expect(suggestions.length).toBeGreaterThan(0);
            expect(suggestions[0]).toContain('code_exec');
        });

        it('does not suggest already-used tools', () => {
            const profile = makeProfile({ toolUsage: { shell: 15, code_exec: 3 } });
            const suggestions = getToolSuggestions(profile, 5);
            const codeExecSuggestions = suggestions.filter(s => s.includes('code_exec'));
            expect(codeExecSuggestions.length).toBe(0);
        });

        it('respects revealThreshold', () => {
            const profile = makeProfile({ toolUsage: { web_search: 4 } });
            expect(getToolSuggestions(profile, 5)).toEqual([]);
        });

        it('suggests web_fetch after enough web_search usage', () => {
            const profile = makeProfile({ toolUsage: { web_search: 6 } });
            const suggestions = getToolSuggestions(profile, 5);
            expect(suggestions.length).toBeGreaterThan(0);
            expect(suggestions[0]).toContain('web_fetch');
        });
    });

    describe('getRecommendedTools', () => {
        it('returns beginner tools for beginners', () => {
            const profile = makeProfile({ skillLevel: 'beginner' });
            const tools = getRecommendedTools(profile);
            expect(tools).toContain('shell');
            expect(tools).toContain('read_file');
            expect(tools).toContain('memory');
            expect(tools.length).toBe(7);
        });

        it('includes used tools for intermediate', () => {
            const profile = makeProfile({
                skillLevel: 'intermediate',
                toolUsage: { cron: 5, email: 3 },
            });
            const tools = getRecommendedTools(profile);
            expect(tools).toContain('shell');
            expect(tools).toContain('cron');
            expect(tools).toContain('email');
        });

        it('returns empty array for advanced (no filtering)', () => {
            const profile = makeProfile({ skillLevel: 'advanced' });
            const tools = getRecommendedTools(profile);
            expect(tools).toEqual([]);
        });
    });
});
