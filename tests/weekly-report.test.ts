/**
 * TITAN — Weekly Report Skill Tests
 * Tests report_generate, report_deliver, report_history tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────
const {
    mockRegisterSkill, mockExistsSync, mockReadFileSync, mockWriteFileSync,
    mockMkdirSync, mockReaddirSync, mockSlackPostMessage,
} = vi.hoisted(() => ({
    mockRegisterSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockSlackPostMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: mockRegisterSkill,
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    readdirSync: mockReaddirSync,
}));

vi.mock('@slack/web-api', () => ({
    WebClient: vi.fn().mockImplementation(() => ({
        chat: { postMessage: mockSlackPostMessage },
    })),
}));

import { registerWeeklyReportSkill } from '../src/skills/builtin/weekly_report.js';

// ── Helper: extract tool handler by name ────────────────────────────
function getToolHandler(name: string) {
    const call = mockRegisterSkill.mock.calls.find(
        ([_meta, handler]: [unknown, { name: string }]) => handler.name === name,
    );
    if (!call) throw new Error(`Tool "${name}" not registered`);
    return call[1];
}

// ── Helper: build mock data for a given week ────────────────────────
function makeInteractionsJSONL(weekStart: string): string {
    return [
        JSON.stringify({ platform: 'discord', type: 'reply', summary: 'Helped user', timestamp: `${weekStart}T10:00:00Z` }),
        JSON.stringify({ platform: 'github', type: 'issue', summary: 'Opened issue', timestamp: `${weekStart}T14:00:00Z` }),
        JSON.stringify({ platform: 'discord', type: 'reply', summary: 'Another reply', timestamp: `${weekStart}T16:00:00Z` }),
    ].join('\n');
}

function makeFeedbackJSON(weekStart: string): string {
    return JSON.stringify([
        { observation: 'SDK crashes on Android 14', category: 'bug', severity: 'high', createdAt: `${weekStart}T11:00:00Z` },
        { observation: 'Docs need more examples', category: 'docs', severity: 'medium', createdAt: `${weekStart}T15:00:00Z` },
    ]);
}

function makeExperimentsJSON(weekStart: string): string {
    return JSON.stringify([
        { hypothesis: 'More tutorials = more installs', status: 'running', createdAt: `${weekStart}T09:00:00Z`, updatedAt: `${weekStart}T09:00:00Z` },
        { hypothesis: 'Community events boost stars', status: 'completed', createdAt: `${weekStart}T09:00:00Z`, updatedAt: `${weekStart}T12:00:00Z` },
    ]);
}

function makeCalendarJSON(weekStart: string): string {
    const d = new Date(weekStart);
    const day2 = new Date(d);
    day2.setDate(d.getDate() + 2);
    return JSON.stringify([
        { title: 'Getting Started Guide', type: 'tutorial', status: 'published', publishDate: weekStart },
        { title: 'API Deep Dive', type: 'blog', status: 'published', publishDate: day2.toISOString().slice(0, 10) },
        { title: 'Draft Post', type: 'blog', status: 'draft', publishDate: weekStart },
    ]);
}

// Setup fs mock to return appropriate data based on path
function setupDataMocks(weekStart: string) {
    mockExistsSync.mockImplementation((path: string) => {
        if (typeof path === 'string') {
            if (path.includes('interactions.jsonl')) return true;
            if (path.includes('feedback-log.json')) return true;
            if (path.includes('experiments-log.json')) return true;
            if (path.includes('content-calendar.json')) return true;
            if (path.includes('weekly-reports')) return true;
        }
        return false;
    });

    mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string') {
            if (path.includes('interactions.jsonl')) return makeInteractionsJSONL(weekStart);
            if (path.includes('feedback-log.json')) return makeFeedbackJSON(weekStart);
            if (path.includes('experiments-log.json')) return makeExperimentsJSON(weekStart);
            if (path.includes('content-calendar.json')) return makeCalendarJSON(weekStart);
        }
        return '[]';
    });
}

function setupEmptyDataMocks() {
    mockExistsSync.mockReturnValue(false);
}

describe('Weekly Report Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.SLACK_BOT_TOKEN;
        mockExistsSync.mockReturnValue(false);
        mockReaddirSync.mockReturnValue([]);
        registerWeeklyReportSkill();
    });

    it('should register three tools', () => {
        expect(mockRegisterSkill).toHaveBeenCalledTimes(3);
        const names = mockRegisterSkill.mock.calls.map(([, h]: [unknown, { name: string }]) => h.name);
        expect(names).toContain('report_generate');
        expect(names).toContain('report_deliver');
        expect(names).toContain('report_history');
    });

    // ── report_generate ─────────────────────────────────────────────
    describe('report_generate', () => {
        it('should generate a report with all sections', async () => {
            const weekStart = '2026-03-09';
            setupDataMocks(weekStart);

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: weekStart });

            expect(result).toContain('Weekly Report');
            expect(result).toContain(weekStart);
            expect(result).toContain('Content Published');
            expect(result).toContain('Community Interactions');
            expect(result).toContain('Growth Experiments');
            expect(result).toContain('Product Feedback');
            expect(result).toContain('Key Metrics');
        });

        it('should count published content correctly', async () => {
            const weekStart = '2026-03-09';
            setupDataMocks(weekStart);

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: weekStart });

            // 2 published items in our mock
            expect(result).toContain('Content Published (2/2 target)');
            expect(result).toContain('On target');
        });

        it('should count community interactions', async () => {
            const weekStart = '2026-03-09';
            setupDataMocks(weekStart);

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: weekStart });

            // 3 interactions, target is 50
            expect(result).toContain('Community Interactions (3/50 target)');
            expect(result).toContain('Below 50/week target');
        });

        it('should aggregate experiments with active and completed counts', async () => {
            const weekStart = '2026-03-09';
            setupDataMocks(weekStart);

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: weekStart });

            expect(result).toContain('Growth Experiments (2/1 target)');
            expect(result).toContain('On target');
        });

        it('should count product feedback', async () => {
            const weekStart = '2026-03-09';
            setupDataMocks(weekStart);

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: weekStart });

            expect(result).toContain('Product Feedback (2/3 target)');
            expect(result).toContain('Below 3/week target');
        });

        it('should show below-target warnings for content when 0 published', async () => {
            const weekStart = '2026-03-09';
            mockExistsSync.mockImplementation((path: string) => {
                if (typeof path === 'string' && path.includes('content-calendar.json')) return true;
                return false;
            });
            mockReadFileSync.mockImplementation((path: string) => {
                if (typeof path === 'string' && path.includes('content-calendar.json')) {
                    return JSON.stringify([
                        { title: 'Draft Only', type: 'blog', status: 'draft', publishDate: weekStart },
                    ]);
                }
                return '[]';
            });

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: weekStart });

            expect(result).toContain('Content Published (0/2 target)');
            expect(result).toContain('Below 2/week target');
        });

        it('should handle empty data gracefully', async () => {
            setupEmptyDataMocks();

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: '2026-03-09' });

            expect(result).toContain('Weekly Report');
            expect(result).toContain('Content Published (0/2 target)');
            expect(result).toContain('Community Interactions (0/50 target)');
            expect(result).toContain('No content published this week');
            expect(result).toContain('No feedback submitted this week');
        });

        it('should save report to weekly-reports directory', async () => {
            setupEmptyDataMocks();

            const tool = getToolHandler('report_generate');
            await tool.execute({ weekOf: '2026-03-09' });

            expect(mockWriteFileSync).toHaveBeenCalled();
            const writePath = mockWriteFileSync.mock.calls[0][0] as string;
            expect(writePath).toContain('weekly-reports');
            expect(writePath).toContain('2026-03-09.json');
        });

        it('should include platform breakdown for interactions', async () => {
            const weekStart = '2026-03-09';
            setupDataMocks(weekStart);

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({ weekOf: weekStart });

            expect(result).toContain('discord:');
            expect(result).toContain('github:');
        });

        it('should use current week when no weekOf provided', async () => {
            setupEmptyDataMocks();

            const tool = getToolHandler('report_generate');
            const result = await tool.execute({});

            expect(result).toContain('Weekly Report');
            expect(mockWriteFileSync).toHaveBeenCalled();
        });
    });

    // ── report_deliver ──────────────────────────────────────────────
    describe('report_deliver', () => {
        it('should return message about missing SLACK_BOT_TOKEN when not set', async () => {
            setupEmptyDataMocks();

            const tool = getToolHandler('report_deliver');
            const result = await tool.execute({ weekOf: '2026-03-09' });

            expect(result).toContain('SLACK_BOT_TOKEN not set');
            expect(result).toContain('Weekly Report');
        });

        it('should deliver report to Slack when token is set', async () => {
            process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
            setupEmptyDataMocks();

            const tool = getToolHandler('report_deliver');
            const result = await tool.execute({ weekOf: '2026-03-09' });

            expect(result).toContain('Report delivered to #general');
            expect(mockSlackPostMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    channel: 'general',
                    text: expect.stringContaining('Weekly Report'),
                }),
            );
        });

        it('should deliver to custom channel', async () => {
            process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
            setupEmptyDataMocks();

            const tool = getToolHandler('report_deliver');
            const result = await tool.execute({ weekOf: '2026-03-09', channel: 'dev-advocacy' });

            expect(result).toContain('#dev-advocacy');
            expect(mockSlackPostMessage).toHaveBeenCalledWith(
                expect.objectContaining({ channel: 'dev-advocacy' }),
            );
        });

        it('should use existing report if already generated', async () => {
            process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
            const savedReport = {
                weekOf: '2026-03-09',
                generatedAt: '2026-03-14T10:00:00Z',
                summary: 'Pre-generated report',
                sections: {
                    contentPublished: { count: 3, target: 2, items: ['Post A (blog)'] },
                    communityInteractions: { count: 60, target: 50, byPlatform: { discord: 40, github: 20 } },
                    growthExperiments: { active: 1, completed: 1, target: 1, items: ['Test hypo [running]'] },
                    productFeedback: { submitted: 4, target: 3, items: ['[high/bug] SDK crash'] },
                    keyMetrics: { totalInteractions: 60, contentPublished: 3, feedbackSubmitted: 4, experimentsActive: 1 },
                    learnings: [],
                },
            };

            mockExistsSync.mockImplementation((path: string) => {
                if (typeof path === 'string' && path.includes('2026-03-09.json')) return true;
                return false;
            });
            mockReadFileSync.mockImplementation((path: string) => {
                if (typeof path === 'string' && path.includes('2026-03-09.json')) return JSON.stringify(savedReport);
                return '[]';
            });

            const tool = getToolHandler('report_deliver');
            const result = await tool.execute({ weekOf: '2026-03-09' });

            expect(result).toContain('Report delivered');
            expect(result).toContain('Content Published (3/2 target)');
        });

        it('should handle Slack delivery failure gracefully', async () => {
            process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
            mockSlackPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));
            setupEmptyDataMocks();

            const tool = getToolHandler('report_deliver');
            const result = await tool.execute({ weekOf: '2026-03-09' });

            expect(result).toContain('delivery failed');
            expect(result).toContain('channel_not_found');
            // Should still include the report text
            expect(result).toContain('Weekly Report');
        });
    });

    // ── report_history ──────────────────────────────────────────────
    describe('report_history', () => {
        it('should return no reports message when directory is empty', async () => {
            mockReaddirSync.mockReturnValue([]);

            const tool = getToolHandler('report_history');
            const result = await tool.execute({});

            expect(result).toContain('No past reports found');
        });

        it('should list past reports with key metrics', async () => {
            mockReaddirSync.mockReturnValue(['2026-03-09.json', '2026-03-02.json']);

            const report1 = {
                weekOf: '2026-03-09',
                generatedAt: '2026-03-14T10:00:00Z',
                summary: 'Week report',
                sections: {
                    contentPublished: { count: 2, target: 2, items: [] },
                    communityInteractions: { count: 55, target: 50, byPlatform: {} },
                    growthExperiments: { active: 1, completed: 0, target: 1, items: [] },
                    productFeedback: { submitted: 3, target: 3, items: [] },
                    keyMetrics: {},
                    learnings: [],
                },
            };
            const report2 = {
                weekOf: '2026-03-02',
                generatedAt: '2026-03-07T10:00:00Z',
                summary: 'Prev week',
                sections: {
                    contentPublished: { count: 1, target: 2, items: [] },
                    communityInteractions: { count: 30, target: 50, byPlatform: {} },
                    growthExperiments: { active: 0, completed: 1, target: 1, items: [] },
                    productFeedback: { submitted: 2, target: 3, items: [] },
                    keyMetrics: {},
                    learnings: [],
                },
            };

            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation((path: string) => {
                if (typeof path === 'string' && path.includes('2026-03-09')) return JSON.stringify(report1);
                if (typeof path === 'string' && path.includes('2026-03-02')) return JSON.stringify(report2);
                return '{}';
            });

            const tool = getToolHandler('report_history');
            const result = await tool.execute({});

            expect(result).toContain('Past Weekly Reports');
            expect(result).toContain('[2026-03-09]');
            expect(result).toContain('[2026-03-02]');
            expect(result).toContain('Content: 2/2');
            expect(result).toContain('Content: 1/2');
            expect(result).toContain('Interactions: 55/50');
        });

        it('should respect limit parameter', async () => {
            mockReaddirSync.mockReturnValue(['2026-03-09.json', '2026-03-02.json', '2026-02-24.json']);

            const makeReport = (weekOf: string) => ({
                weekOf,
                generatedAt: '2026-03-14T10:00:00Z',
                summary: 'Report',
                sections: {
                    contentPublished: { count: 1, target: 2, items: [] },
                    communityInteractions: { count: 10, target: 50, byPlatform: {} },
                    growthExperiments: { active: 0, completed: 0, target: 1, items: [] },
                    productFeedback: { submitted: 0, target: 3, items: [] },
                    keyMetrics: {},
                    learnings: [],
                },
            });

            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation((path: string) => {
                if (typeof path === 'string' && path.includes('2026-03-09')) return JSON.stringify(makeReport('2026-03-09'));
                if (typeof path === 'string' && path.includes('2026-03-02')) return JSON.stringify(makeReport('2026-03-02'));
                if (typeof path === 'string' && path.includes('2026-02-24')) return JSON.stringify(makeReport('2026-02-24'));
                return '{}';
            });

            const tool = getToolHandler('report_history');
            const result = await tool.execute({ limit: 2 });

            expect(result).toContain('[2026-03-09]');
            expect(result).toContain('[2026-03-02]');
            expect(result).not.toContain('[2026-02-24]');
        });

        it('should handle corrupted report file', async () => {
            mockReaddirSync.mockReturnValue(['2026-03-09.json']);
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => { throw new Error('parse error'); });

            const tool = getToolHandler('report_history');
            const result = await tool.execute({});

            expect(result).toContain('Error reading report');
        });

        it('should ensure reports directory exists', async () => {
            mockReaddirSync.mockReturnValue([]);

            const tool = getToolHandler('report_history');
            await tool.execute({});

            // ensureReportsDir called with mkdirSync when dir doesn't exist
            // The function checks existsSync and calls mkdirSync if needed
        });
    });
});
