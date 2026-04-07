/**
 * Tests for src/skills/builtin/x_poster.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
        mkdirSync: mockMkdirSync,
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

import { registerXPosterSkill } from '../src/skills/builtin/x_poster.js';

describe('X Poster Skill', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
        handlers.clear();
        mockExistsSync.mockReturnValue(false);
        process.env.X_API_KEY = 'test-key';
        process.env.X_API_SECRET = 'test-secret';
        process.env.X_ACCESS_TOKEN = 'test-token';
        process.env.X_ACCESS_SECRET = 'test-access-secret';
        process.env.X_BEARER_TOKEN = 'test-bearer';
        registerXPosterSkill();
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('registers all 4 tool handlers', () => {
        expect(handlers.has('x_post')).toBe(true);
        expect(handlers.has('x_reply')).toBe(true);
        expect(handlers.has('x_search')).toBe(true);
        expect(handlers.has('x_review')).toBe(true);
    });

    describe('x_post', () => {
        it('queues post for review by default', async () => {
            const handler = handlers.get('x_post');
            const result = await handler.execute({ content: 'Hello world!' });

            expect(result).toContain('queued for review');
            expect(result).toContain('Hello world!');
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it('posts directly when skipReview is true', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ data: { id: '123', text: 'Hello world!' } }),
            });

            const handler = handlers.get('x_post');
            const result = await handler.execute({ content: 'Hello world!', skipReview: true });

            expect(result).toContain('Tweet posted');
            expect(result).toContain('123');
        });

        it('returns error when credentials missing', async () => {
            delete process.env.X_API_KEY;
            const handler = handlers.get('x_post');
            const result = await handler.execute({ content: 'test' });

            expect(result).toContain('Error');
            expect(result).toContain('credentials');
        });

        it('truncates content to 280 characters', async () => {
            const longContent = 'A'.repeat(300);

            const handler = handlers.get('x_post');
            const result = await handler.execute({ content: longContent });

            // Should queue the truncated version
            expect(result).toContain('queued');
            const writeCall = mockWriteFileSync.mock.calls[0];
            const queued = JSON.parse(writeCall[1]);
            expect(queued.posts[0].content.length).toBeLessThanOrEqual(280);
        });
    });

    describe('x_reply', () => {
        it('queues reply for review by default', async () => {
            const handler = handlers.get('x_reply');
            const result = await handler.execute({
                tweetId: '456',
                content: 'Great thread!',
            });

            expect(result).toContain('queued for review');
            expect(result).toContain('reply to 456');
        });

        it('posts reply directly when skipReview is true', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ data: { id: '789', text: 'Great thread!' } }),
            });

            const handler = handlers.get('x_reply');
            const result = await handler.execute({
                tweetId: '456',
                content: 'Great thread!',
                skipReview: true,
            });

            expect(result).toContain('Reply posted');
        });
    });

    describe('x_search', () => {
        it('searches tweets and returns results', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    data: [{
                        id: '111',
                        text: 'AI is amazing',
                        author_id: 'user1',
                        created_at: '2026-01-01',
                        public_metrics: { like_count: 10, retweet_count: 5, reply_count: 2 },
                    }],
                    meta: { result_count: 1 },
                }),
            });

            const handler = handlers.get('x_search');
            const result = await handler.execute({ query: 'AI agents' });

            expect(result).toContain('AI is amazing');
            expect(result).toContain('AI agents');
        });

        it('returns error when bearer token missing', async () => {
            delete process.env.X_BEARER_TOKEN;

            const handler = handlers.get('x_search');
            const result = await handler.execute({ query: 'test' });

            expect(result).toContain('X_BEARER_TOKEN');
        });

        it('handles no results', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ data: null, meta: { result_count: 0 } }),
            });

            const handler = handlers.get('x_search');
            const result = await handler.execute({ query: 'obscure query' });

            expect(result).toContain('No tweets found');
        });
    });

    describe('x_review', () => {
        it('lists pending posts', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                posts: [
                    { id: 'p1', type: 'post', content: 'Hello', status: 'pending', createdAt: '2026-01-01' },
                    { id: 'p2', type: 'post', content: 'World', status: 'posted', createdAt: '2026-01-01' },
                ],
            }));

            const handler = handlers.get('x_review');
            const result = await handler.execute({ action: 'list' });

            expect(result).toContain('Hello');
            expect(result).not.toContain('World'); // already posted
        });

        it('returns empty queue message', async () => {
            const handler = handlers.get('x_review');
            const result = await handler.execute({ action: 'list' });

            expect(result).toContain('empty');
        });

        it('approves and posts a queued tweet', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                posts: [
                    { id: 'p1', type: 'post', content: 'Approve me', status: 'pending', createdAt: '2026-01-01' },
                ],
            }));
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ data: { id: 'tweet-999', text: 'Approve me' } }),
            });

            const handler = handlers.get('x_review');
            const result = await handler.execute({ action: 'approve', postId: 'p1' });

            expect(result).toContain('Approved');
            expect(result).toContain('tweet-999');
        });

        it('rejects a queued post', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                posts: [
                    { id: 'p1', type: 'post', content: 'Reject me', status: 'pending', createdAt: '2026-01-01' },
                ],
            }));

            const handler = handlers.get('x_review');
            const result = await handler.execute({ action: 'reject', postId: 'p1' });

            expect(result).toContain('rejected');
        });
    });
});
