/**
 * TITAN — Interaction Tracker Skill Tests
 * Tests for interaction_log, interaction_stats, interaction_search tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const { mockRegisterSkill, mockExistsSync, mockReadFileSync, mockWriteFileSync, mockAppendFileSync, mockMkdirSync, mockUuidV4 } = vi.hoisted(() => ({
    mockRegisterSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockAppendFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockUuidV4: vi.fn(() => 'test-uuid-12345678'),
}));

// ── Module mocks ─────────────────────────────────────────────────────────

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

vi.mock('uuid', () => ({
    v4: mockUuidV4,
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    appendFileSync: mockAppendFileSync,
    mkdirSync: mockMkdirSync,
}));

// ── Import under test ────────────────────────────────────────────────────

import { registerInteractionTrackerSkill } from '../src/skills/builtin/interaction_tracker.js';

// ── Helpers ──────────────────────────────────────────────────────────────

type ToolDef = { name: string; execute: (args: Record<string, unknown>) => Promise<string> };

function getToolHandler(toolName: string): ToolDef['execute'] {
    const call = vi.mocked(mockRegisterSkill).mock.calls.find(
        (c) => c[1]?.name === toolName,
    );
    if (!call) throw new Error(`Tool "${toolName}" not registered`);
    return call[1].execute;
}

function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
        id: 'abc12345',
        timestamp: new Date().toISOString(),
        platform: 'github',
        type: 'comment',
        contentSummary: 'Reviewed PR #42',
        ...overrides,
    };
}

function makeJSONL(entries: Record<string, unknown>[]): string {
    return entries.map(e => JSON.stringify(e)).join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Interaction Tracker Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRegisterSkill.mockClear();
        registerInteractionTrackerSkill();
    });

    describe('registration', () => {
        it('registers 3 tools', () => {
            expect(mockRegisterSkill).toHaveBeenCalledTimes(3);
        });

        it('registers all expected tool names', () => {
            const names = mockRegisterSkill.mock.calls.map((c: any) => c[1]?.name);
            expect(names).toContain('interaction_log');
            expect(names).toContain('interaction_stats');
            expect(names).toContain('interaction_search');
        });
    });

    describe('interaction_log', () => {
        it('logs an interaction and appends to JSONL', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('');

            const execute = getToolHandler('interaction_log');
            const result = await execute({
                platform: 'github',
                type: 'comment',
                contentSummary: 'Reviewed PR #42',
            });

            expect(result).toContain('Interaction logged');
            expect(result).toContain('test-uui'); // uuid().slice(0,8)
            expect(result).toContain('github/comment');
            expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
            const appended = JSON.parse(mockAppendFileSync.mock.calls[0][1].replace('\n', ''));
            expect(appended.platform).toBe('github');
            expect(appended.contentSummary).toBe('Reviewed PR #42');
        });

        it('includes optional url and sentiment', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('');

            const execute = getToolHandler('interaction_log');
            await execute({
                platform: 'x',
                type: 'reply',
                contentSummary: 'Responded to tweet',
                url: 'https://x.com/post/123',
                sentiment: 'positive',
            });

            const appended = JSON.parse(mockAppendFileSync.mock.calls[0][1].replace('\n', ''));
            expect(appended.url).toBe('https://x.com/post/123');
            expect(appended.sentiment).toBe('positive');
        });

        it('creates directory if it does not exist', async () => {
            mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(false);
            mockReadFileSync.mockReturnValue('');

            const execute = getToolHandler('interaction_log');
            await execute({ platform: 'discord', type: 'post', contentSummary: 'Announcement' });

            expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
        });
    });

    describe('interaction_stats', () => {
        it('returns stats for the default week period', async () => {
            const now = new Date();
            const entries = [
                makeEntry({ timestamp: now.toISOString(), platform: 'github', type: 'comment' }),
                makeEntry({ timestamp: now.toISOString(), platform: 'slack', type: 'reply' }),
                makeEntry({ timestamp: now.toISOString(), platform: 'github', type: 'pr' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_stats');
            const result = await execute({});

            expect(result).toContain('Total: 3');
            expect(result).toContain('github: 2');
            expect(result).toContain('slack: 1');
            expect(result).toContain('comment: 1');
            expect(result).toContain('reply: 1');
            expect(result).toContain('pr: 1');
        });

        it('filters by day period', async () => {
            const now = new Date();
            const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
            const entries = [
                makeEntry({ timestamp: now.toISOString() }),
                makeEntry({ timestamp: old.toISOString() }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_stats');
            const result = await execute({ period: 'day' });

            expect(result).toContain('Total: 1');
        });

        it('filters by month period', async () => {
            const now = new Date();
            const entries = [
                makeEntry({ timestamp: now.toISOString() }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_stats');
            const result = await execute({ period: 'month' });

            expect(result).toContain('Total: 1');
        });

        it('shows below-50 warning for week period', async () => {
            const now = new Date();
            const entries = [makeEntry({ timestamp: now.toISOString() })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_stats');
            const result = await execute({ period: 'week' });

            expect(result).toContain('Below 50/week target');
            expect(result).toContain('currently 1');
        });

        it('does not show warning when at or above 50', async () => {
            const now = new Date();
            const entries = Array.from({ length: 51 }, () => makeEntry({ timestamp: now.toISOString() }));
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_stats');
            const result = await execute({ period: 'week' });

            expect(result).not.toContain('Below 50/week target');
        });

        it('filters by platform', async () => {
            const now = new Date();
            const entries = [
                makeEntry({ timestamp: now.toISOString(), platform: 'github' }),
                makeEntry({ timestamp: now.toISOString(), platform: 'slack' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_stats');
            const result = await execute({ platform: 'github' });

            expect(result).toContain('Total: 1');
            expect(result).toContain('github');
            expect(result).not.toContain('slack: 1');
        });

        it('handles empty entries', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('');

            const execute = getToolHandler('interaction_stats');
            const result = await execute({});

            expect(result).toContain('Total: 0');
        });
    });

    describe('interaction_search', () => {
        it('finds matching interactions by keyword', async () => {
            const entries = [
                makeEntry({ contentSummary: 'Fixed a deploy bug' }),
                makeEntry({ contentSummary: 'Reviewed PR #42' }),
                makeEntry({ contentSummary: 'Deploy pipeline update' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_search');
            const result = await execute({ query: 'deploy' });

            expect(result).toContain('2 results');
            expect(result).toContain('deploy');
        });

        it('returns no results message', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL([makeEntry()]));

            const execute = getToolHandler('interaction_search');
            const result = await execute({ query: 'nonexistent' });

            expect(result).toContain('No interactions found');
        });

        it('filters by platform', async () => {
            const entries = [
                makeEntry({ platform: 'github', contentSummary: 'deploy fix' }),
                makeEntry({ platform: 'slack', contentSummary: 'deploy chat' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_search');
            const result = await execute({ query: 'deploy', platform: 'slack' });

            expect(result).toContain('1 results');
            expect(result).toContain('deploy chat');
        });

        it('respects limit parameter', async () => {
            const entries = Array.from({ length: 30 }, (_, i) =>
                makeEntry({ contentSummary: `item ${i} deploy` }),
            );
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_search');
            const result = await execute({ query: 'deploy', limit: 5 });

            expect(result).toContain('5 results');
        });

        it('includes url and sentiment in results when present', async () => {
            const entries = [
                makeEntry({
                    contentSummary: 'Deploy review',
                    url: 'https://github.com/pr/1',
                    sentiment: 'positive',
                }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(makeJSONL(entries));

            const execute = getToolHandler('interaction_search');
            const result = await execute({ query: 'deploy' });

            expect(result).toContain('https://github.com/pr/1');
            expect(result).toContain('positive');
        });
    });
});
