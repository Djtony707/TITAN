/**
 * Tests for src/skills/builtin/social_scheduler.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
        mkdirSync: mockMkdirSync,
        readdirSync: mockReaddirSync,
        unlinkSync: mockUnlinkSync,
    };
});

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const handlers = new Map<string, any>();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
        handlers.set(handler.name, handler);
    }),
}));

// Mock crypto.randomUUID
const MOCK_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
vi.mock('crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('crypto')>();
    return {
        ...actual,
        default: {
            ...actual,
            randomUUID: () => MOCK_UUID,
        },
    };
});

import { registerSocialSchedulerSkill, PLATFORM_LIMITS, stopScheduleChecker } from '../src/skills/builtin/social_scheduler.js';

// ─── Tests ───────────────────────────────────────────────────────

describe('Social Scheduler Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        handlers.clear();
        mockExistsSync.mockReturnValue(false);
        mockReaddirSync.mockReturnValue([]);
        registerSocialSchedulerSkill();
    });

    afterEach(() => {
        stopScheduleChecker();
    });

    // ── Registration ─────────────────────────────────────────────

    it('registers all 5 tool handlers', () => {
        expect(handlers.has('social_schedule')).toBe(true);
        expect(handlers.has('social_queue')).toBe(true);
        expect(handlers.has('social_cancel')).toBe(true);
        expect(handlers.has('social_analytics')).toBe(true);
        expect(handlers.has('social_draft')).toBe(true);
    });

    it('each handler has name, description, parameters, and execute', () => {
        for (const [, handler] of handlers) {
            expect(handler.name).toBeTruthy();
            expect(handler.description).toBeTruthy();
            expect(handler.parameters).toBeTruthy();
            expect(typeof handler.execute).toBe('function');
        }
    });

    // ── social_schedule ──────────────────────────────────────────

    describe('social_schedule', () => {
        const futureDate = new Date(Date.now() + 86400000).toISOString(); // +1 day

        it('schedules a post successfully', async () => {
            const handler = handlers.get('social_schedule');
            const result = await handler.execute({
                platform: 'x',
                content: 'Hello from TITAN!',
                scheduledAt: futureDate,
            });

            expect(result).toContain('Post scheduled');
            expect(result).toContain(MOCK_UUID);
            expect(result).toContain('X/Twitter');
            expect(result).toContain('Hello from TITAN!');
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it('rejects invalid platform', async () => {
            const handler = handlers.get('social_schedule');
            const result = await handler.execute({
                platform: 'facebook',
                content: 'Test',
                scheduledAt: futureDate,
            });

            expect(result).toContain('Error');
            expect(result).toContain('Invalid platform');
        });

        it('rejects invalid datetime', async () => {
            const handler = handlers.get('social_schedule');
            const result = await handler.execute({
                platform: 'x',
                content: 'Test',
                scheduledAt: 'not-a-date',
            });

            expect(result).toContain('Error');
            expect(result).toContain('Invalid datetime');
        });

        it('rejects past datetime', async () => {
            const handler = handlers.get('social_schedule');
            const result = await handler.execute({
                platform: 'x',
                content: 'Test',
                scheduledAt: '2020-01-01T00:00:00Z',
            });

            expect(result).toContain('Error');
            expect(result).toContain('future');
        });

        it('rejects content exceeding platform character limit', async () => {
            const handler = handlers.get('social_schedule');
            const longContent = 'A'.repeat(281); // X limit is 280

            const result = await handler.execute({
                platform: 'x',
                content: longContent,
                scheduledAt: futureDate,
            });

            expect(result).toContain('Error');
            expect(result).toContain('exceeds');
            expect(result).toContain('280');
        });

        it('accepts content within LinkedIn limit (3000 chars)', async () => {
            const handler = handlers.get('social_schedule');
            const content = 'A'.repeat(2999);

            const result = await handler.execute({
                platform: 'linkedin',
                content,
                scheduledAt: futureDate,
            });

            expect(result).toContain('Post scheduled');
            expect(result).toContain('LinkedIn');
        });

        it('includes hashtags and media in output', async () => {
            const handler = handlers.get('social_schedule');
            const result = await handler.execute({
                platform: 'mastodon',
                content: 'Test post',
                scheduledAt: futureDate,
                hashtags: ['AI', 'automation'],
                mediaUrls: ['https://example.com/image.png'],
            });

            expect(result).toContain('#AI #automation');
            expect(result).toContain('1 attachment(s)');
        });
    });

    // ── social_queue ─────────────────────────────────────────────

    describe('social_queue', () => {
        it('returns empty queue message', async () => {
            const handler = handlers.get('social_queue');
            const result = await handler.execute({});

            expect(result).toContain('empty');
        });

        it('lists posts from queue files', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['post1.json', 'post2.json']);
            mockReadFileSync
                .mockReturnValueOnce(JSON.stringify({
                    id: 'post1',
                    platform: 'x',
                    content: 'First post',
                    scheduledAt: '2026-04-01T09:00:00Z',
                    status: 'pending',
                    createdAt: '2026-03-16T00:00:00Z',
                    mediaUrls: [],
                    hashtags: [],
                }))
                .mockReturnValueOnce(JSON.stringify({
                    id: 'post2',
                    platform: 'linkedin',
                    content: 'Second post',
                    scheduledAt: '2026-04-02T09:00:00Z',
                    status: 'published',
                    publishedAt: '2026-04-02T09:00:00Z',
                    createdAt: '2026-03-16T00:00:00Z',
                    mediaUrls: [],
                    hashtags: [],
                }));

            const handler = handlers.get('social_queue');
            const result = await handler.execute({});

            expect(result).toContain('2 posts');
            expect(result).toContain('First post');
            expect(result).toContain('Second post');
            expect(result).toContain('[PENDING]');
            expect(result).toContain('[PUBLISHED]');
        });

        it('filters by status', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['post1.json']);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                id: 'post1',
                platform: 'x',
                content: 'Pending post',
                scheduledAt: '2026-04-01T09:00:00Z',
                status: 'pending',
                createdAt: '2026-03-16T00:00:00Z',
                mediaUrls: [],
                hashtags: [],
            }));

            const handler = handlers.get('social_queue');
            const result = await handler.execute({ status: 'published' });

            expect(result).toContain('No published posts found');
        });
    });

    // ── social_cancel ────────────────────────────────────────────

    describe('social_cancel', () => {
        it('cancels a pending post', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                id: 'post1',
                platform: 'x',
                content: 'Cancel me',
                scheduledAt: '2026-04-01T09:00:00Z',
                status: 'pending',
                createdAt: '2026-03-16T00:00:00Z',
                mediaUrls: [],
                hashtags: [],
            }));

            const handler = handlers.get('social_cancel');
            const result = await handler.execute({ postId: 'post1' });

            expect(result).toContain('Cancelled');
            expect(result).toContain('post1');
            expect(mockWriteFileSync).toHaveBeenCalled();
            // Verify status was set to cancelled
            const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
            expect(writtenData.status).toBe('cancelled');
        });

        it('rejects cancelling non-existent post', async () => {
            mockExistsSync.mockReturnValue(false);

            const handler = handlers.get('social_cancel');
            const result = await handler.execute({ postId: 'no-such-id' });

            expect(result).toContain('Error');
            expect(result).toContain('not found');
        });

        it('rejects cancelling already published post', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                id: 'post1',
                platform: 'x',
                content: 'Already posted',
                scheduledAt: '2026-04-01T09:00:00Z',
                status: 'published',
                createdAt: '2026-03-16T00:00:00Z',
                mediaUrls: [],
                hashtags: [],
            }));

            const handler = handlers.get('social_cancel');
            const result = await handler.execute({ postId: 'post1' });

            expect(result).toContain('Error');
            expect(result).toContain('published');
        });

        it('returns error when no postId provided', async () => {
            const handler = handlers.get('social_cancel');
            const result = await handler.execute({});

            expect(result).toContain('Error');
            expect(result).toContain('required');
        });
    });

    // ── social_analytics ─────────────────────────────────────────

    describe('social_analytics', () => {
        it('returns no-data message when no published posts', async () => {
            const handler = handlers.get('social_analytics');
            const result = await handler.execute({});

            expect(result).toContain('No published posts found');
        });

        it('shows analytics with engagement data', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['post1.json']);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                id: 'post1',
                platform: 'x',
                content: 'Analytics test',
                scheduledAt: '2026-04-01T09:00:00Z',
                status: 'published',
                publishedAt: '2026-04-01T09:00:00Z',
                createdAt: '2026-03-16T00:00:00Z',
                mediaUrls: [],
                hashtags: [],
                engagement: {
                    likes: 42,
                    reposts: 10,
                    replies: 5,
                    impressions: 1000,
                    clicks: 50,
                },
            }));

            const handler = handlers.get('social_analytics');
            const result = await handler.execute({});

            expect(result).toContain('Social Analytics');
            expect(result).toContain('Likes: 42');
            expect(result).toContain('Reposts: 10');
            expect(result).toContain('Impressions: 1000');
            expect(result).toContain('X/Twitter');
        });

        it('shows correct structure even without engagement data', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['post1.json']);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                id: 'post1',
                platform: 'linkedin',
                content: 'No engagement yet',
                scheduledAt: '2026-04-01T09:00:00Z',
                status: 'published',
                publishedAt: '2026-04-01T09:00:00Z',
                createdAt: '2026-03-16T00:00:00Z',
                mediaUrls: [],
                hashtags: [],
            }));

            const handler = handlers.get('social_analytics');
            const result = await handler.execute({});

            expect(result).toContain('Social Analytics');
            expect(result).toContain('LinkedIn');
            expect(result).toContain('No engagement data recorded yet');
        });
    });

    // ── social_draft ─────────────────────────────────────────────

    describe('social_draft', () => {
        it('generates draft for X with correct char limit', async () => {
            const handler = handlers.get('social_draft');
            const result = await handler.execute({
                topic: 'AI agents',
                platform: 'x',
                tone: 'professional',
            });

            expect(result).toContain('X/Twitter');
            expect(result).toContain('max 280 chars');
            expect(result).toContain('AI agents');
        });

        it('generates draft for LinkedIn with correct char limit', async () => {
            const handler = handlers.get('social_draft');
            const result = await handler.execute({
                topic: 'Building in public',
                platform: 'linkedin',
            });

            expect(result).toContain('LinkedIn');
            expect(result).toContain('max 3000 chars');
        });

        it('rejects invalid platform', async () => {
            const handler = handlers.get('social_draft');
            const result = await handler.execute({
                topic: 'test',
                platform: 'tiktok',
            });

            expect(result).toContain('Error');
            expect(result).toContain('Invalid platform');
        });

        it('rejects empty topic', async () => {
            const handler = handlers.get('social_draft');
            const result = await handler.execute({
                topic: '',
                platform: 'x',
            });

            expect(result).toContain('Error');
            expect(result).toContain('required');
        });

        it('includes platform best practice in draft', async () => {
            const handler = handlers.get('social_draft');
            const result = await handler.execute({
                topic: 'Open source',
                platform: 'mastodon',
                tone: 'casual',
            });

            expect(result).toContain('CamelCase');
        });
    });

    // ── Platform limits ──────────────────────────────────────────

    describe('platform limits', () => {
        it('has correct character limits for all platforms', () => {
            expect(PLATFORM_LIMITS.x.maxChars).toBe(280);
            expect(PLATFORM_LIMITS.linkedin.maxChars).toBe(3000);
            expect(PLATFORM_LIMITS.bluesky.maxChars).toBe(300);
            expect(PLATFORM_LIMITS.mastodon.maxChars).toBe(500);
            expect(PLATFORM_LIMITS.threads.maxChars).toBe(500);
        });

        it('has hashtag style for all platforms', () => {
            expect(PLATFORM_LIMITS.x.hashtagStyle).toBe('end');
            expect(PLATFORM_LIMITS.linkedin.hashtagStyle).toBe('end');
            expect(PLATFORM_LIMITS.bluesky.hashtagStyle).toBe('inline');
            expect(PLATFORM_LIMITS.mastodon.hashtagStyle).toBe('end');
            expect(PLATFORM_LIMITS.threads.hashtagStyle).toBe('none');
        });
    });
});
