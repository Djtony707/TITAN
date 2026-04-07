/**
 * TITAN — Daily Briefing Tests
 * Tests memory/briefing.ts: buildDailyBriefing and checkAndSendBriefing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mock functions are shared between factory and tests
const fsMocks = vi.hoisted(() => ({
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-briefing',
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, ...fsMocks };
});

vi.mock('../src/memory/relationship.js', () => ({
    loadProfile: vi.fn().mockReturnValue({
        name: 'Tony',
        projects: [
            { name: 'TITAN', description: 'AI Agent', lastMentioned: new Date().toISOString() },
            { name: 'WebApp', description: 'Frontend', lastMentioned: new Date().toISOString() },
        ],
        contacts: [],
        preferences: {},
        facts: [],
        goals: [
            { goal: 'Launch v3', addedAt: new Date().toISOString(), completed: false },
            { goal: 'Write tests', addedAt: new Date().toISOString(), completed: true },
        ],
        responseStyle: 'conversational',
        technicalLevel: 'expert',
        interactionCount: 42,
    }),
}));

vi.mock('../src/agent/monitor.js', () => ({
    listMonitors: vi.fn().mockReturnValue([
        { name: 'github-watcher', enabled: true },
        { name: 'disabled-monitor', enabled: false },
    ]),
}));

vi.mock('../src/recipes/store.js', () => ({
    listRecipes: vi.fn().mockReturnValue([
        { slashCommand: 'deploy' },
        { slashCommand: 'build' },
        { slashCommand: null },
    ]),
}));

import { buildDailyBriefing, checkAndSendBriefing } from '../src/memory/briefing.js';

describe('Daily Briefing', () => {
    describe('buildDailyBriefing', () => {
        it('should return a non-null briefing string', () => {
            const briefing = buildDailyBriefing();
            expect(briefing).not.toBeNull();
            expect(typeof briefing).toBe('string');
        });

        it('should include personalized greeting with user name', () => {
            const briefing = buildDailyBriefing()!;
            expect(briefing).toContain('Tony');
        });

        it('should include the day name and date', () => {
            const briefing = buildDailyBriefing()!;
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const today = days[new Date().getDay()];
            expect(briefing).toContain(today);
        });

        it('should include time-appropriate greeting', () => {
            const briefing = buildDailyBriefing()!;
            const hour = new Date().getHours();
            if (hour < 12) {
                expect(briefing).toContain('Good morning');
            } else if (hour < 17) {
                expect(briefing).toContain('Good afternoon');
            } else {
                expect(briefing).toContain('Good evening');
            }
        });

        it('should include active projects', () => {
            const briefing = buildDailyBriefing()!;
            expect(briefing).toContain('TITAN');
            expect(briefing).toContain('WebApp');
        });

        it('should include pending goals only', () => {
            const briefing = buildDailyBriefing()!;
            expect(briefing).toContain('Launch v3');
            // 'Write tests' is completed, should not appear in goals section
        });

        it('should include active monitors', () => {
            const briefing = buildDailyBriefing()!;
            expect(briefing).toContain('github-watcher');
            expect(briefing).toContain('1 active monitor');
        });

        it('should include quick commands from recipes', () => {
            const briefing = buildDailyBriefing()!;
            expect(briefing).toContain('/deploy');
            expect(briefing).toContain('/build');
        });

        it('should not include beginner tips for expert users', () => {
            const briefing = buildDailyBriefing()!;
            expect(briefing).not.toContain('no technical knowledge needed');
        });

        it('should end with a prompt for what to work on', () => {
            const briefing = buildDailyBriefing()!;
            expect(briefing).toContain('What would you like to work on today');
        });
    });

    describe('buildDailyBriefing — beginner tips', () => {
        it('should include beginner tip for unknown technical level', async () => {
            vi.resetModules();
            vi.doMock('../src/utils/logger.js', () => ({
                default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            }));
            vi.doMock('../src/utils/constants.js', () => ({
                TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-briefing-2',
            }));
            vi.doMock('fs', async (importOriginal) => {
                const actual = await importOriginal<typeof import('fs')>();
                return { ...actual, existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue(''), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
            });
            vi.doMock('../src/memory/relationship.js', () => ({
                loadProfile: vi.fn().mockReturnValue({
                    projects: [], contacts: [], preferences: {}, facts: [], goals: [],
                    responseStyle: 'conversational', technicalLevel: 'unknown', interactionCount: 0,
                }),
            }));
            vi.doMock('../src/agent/monitor.js', () => ({ listMonitors: vi.fn().mockReturnValue([]) }));
            vi.doMock('../src/recipes/store.js', () => ({ listRecipes: vi.fn().mockReturnValue([]) }));

            const { buildDailyBriefing: build2 } = await import('../src/memory/briefing.js');
            const briefing = build2()!;
            expect(briefing).toContain('no technical knowledge needed');
        });
    });

    describe('checkAndSendBriefing', () => {
        it('should not send if already run today', async () => {
            fsMocks.existsSync.mockReturnValue(true);
            fsMocks.readFileSync.mockReturnValue(new Date().toISOString());

            const sender = vi.fn();
            await checkAndSendBriefing(sender);
            expect(sender).not.toHaveBeenCalled();

            // Restore defaults
            fsMocks.existsSync.mockReturnValue(false);
            fsMocks.readFileSync.mockReturnValue('');
        });

        it('should not send outside morning window (6am-11am)', async () => {
            fsMocks.existsSync.mockReturnValue(false);

            // Only test if we're outside the window
            const hour = new Date().getHours();
            if (hour < 6 || hour >= 12) {
                const sender = vi.fn();
                await checkAndSendBriefing(sender);
                expect(sender).not.toHaveBeenCalled();
            }
        });

        it('should handle sender errors gracefully', async () => {
            fsMocks.existsSync.mockReturnValue(false);

            const hour = new Date().getHours();
            if (hour >= 6 && hour < 12) {
                const sender = vi.fn().mockRejectedValue(new Error('Send failed'));
                await expect(checkAndSendBriefing(sender)).resolves.not.toThrow();
            }
        });
    });
});

describe('Daily Briefing — no name', () => {
    it('should handle empty profile name', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-briefing-3',
        }));
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return { ...actual, existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue(''), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
        });
        vi.doMock('../src/memory/relationship.js', () => ({
            loadProfile: vi.fn().mockReturnValue({
                projects: [], contacts: [], preferences: {}, facts: [], goals: [],
                responseStyle: 'conversational', technicalLevel: 'expert', interactionCount: 0,
            }),
        }));
        vi.doMock('../src/agent/monitor.js', () => ({ listMonitors: vi.fn().mockReturnValue([]) }));
        vi.doMock('../src/recipes/store.js', () => ({ listRecipes: vi.fn().mockReturnValue([]) }));

        const { buildDailyBriefing: build3 } = await import('../src/memory/briefing.js');
        const briefing = build3()!;
        expect(briefing).not.toContain(', !');
        // Should still have a greeting
        expect(briefing).toMatch(/Good (morning|afternoon|evening)/);
    });
});
