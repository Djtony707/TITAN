/**
 * TITAN — RevenueCat Knowledge Base Skill Tests
 * Tests rc_ingest, rc_search tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockRegisterSkill, mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockFetch } = vi.hoisted(() => ({
    mockRegisterSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockFetch: vi.fn(),
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

vi.mock('uuid', () => ({
    v4: vi.fn(() => 'test-uuid-12345678'),
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
}));

// Mock global fetch
vi.stubGlobal('fetch', mockFetch);

import { registerRevenueCatKBSkill } from '../src/skills/builtin/revenuecat_kb.js';

// ── Helper: extract tool handler by name ────────────────────────────
function getToolHandler(name: string) {
    const call = mockRegisterSkill.mock.calls.find(
        ([_meta, handler]: [unknown, { name: string }]) => handler.name === name,
    );
    if (!call) throw new Error(`Tool "${name}" not registered`);
    return call[1];
}

function makeHtmlResponse(title: string, bodyText: string): Response {
    const html = `<html><head><title>${title}</title></head><body><p>${bodyText}</p></body></html>`;
    return {
        ok: true,
        status: 200,
        text: async () => html,
    } as unknown as Response;
}

describe('RevenueCat KB Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        registerRevenueCatKBSkill();
    });

    it('should register two tools', () => {
        expect(mockRegisterSkill).toHaveBeenCalledTimes(2);
        const names = mockRegisterSkill.mock.calls.map(([, h]: [unknown, { name: string }]) => h.name);
        expect(names).toContain('rc_ingest');
        expect(names).toContain('rc_search');
    });

    // ── rc_ingest ───────────────────────────────────────────────────
    describe('rc_ingest', () => {
        it('should ingest URLs and save chunks', async () => {
            const longContent = 'RevenueCat SDK integration guide. '.repeat(50); // > 50 chars
            mockFetch.mockResolvedValue(makeHtmlResponse('RC Quickstart', longContent));

            const tool = getToolHandler('rc_ingest');
            const result = await tool.execute({ sources: 'https://revenuecat.com/docs/quickstart' });

            expect(result).toContain('Ingested');
            expect(result).toContain('1/1 sources');
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it('should use default sources when none provided', async () => {
            const longContent = 'Default docs content for RevenueCat platform. '.repeat(50);
            mockFetch.mockResolvedValue(makeHtmlResponse('RC Docs', longContent));

            const tool = getToolHandler('rc_ingest');
            const result = await tool.execute({});

            // Default sources has 3 URLs
            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(result).toContain('3/3 sources');
        });

        it('should handle HTTP errors gracefully', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => '' } as unknown as Response);

            const tool = getToolHandler('rc_ingest');
            const result = await tool.execute({ sources: 'https://revenuecat.com/bad-url' });

            expect(result).toContain('0/1 sources');
            expect(result).toContain('HTTP 404');
        });

        it('should handle fetch exceptions', async () => {
            mockFetch.mockRejectedValue(new Error('Network timeout'));

            const tool = getToolHandler('rc_ingest');
            const result = await tool.execute({ sources: 'https://revenuecat.com/docs/test' });

            expect(result).toContain('Network timeout');
            expect(result).toContain('0/1 sources');
        });

        it('should skip content that is too short', async () => {
            mockFetch.mockResolvedValue(makeHtmlResponse('Short', 'Hi'));

            const tool = getToolHandler('rc_ingest');
            const result = await tool.execute({ sources: 'https://revenuecat.com/tiny' });

            expect(result).toContain('Content too short');
        });

        it('should remove old chunks from the same URL before re-ingesting', async () => {
            const oldDocs = [
                { id: 'old1', text: 'old data', source: 'revenuecat', url: 'https://revenuecat.com/docs/quickstart', title: 'Old', ingestedAt: '2026-01-01' },
                { id: 'keep1', text: 'other data', source: 'revenuecat', url: 'https://revenuecat.com/docs/other', title: 'Other', ingestedAt: '2026-01-01' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(oldDocs));

            const longContent = 'Fresh RevenueCat documentation content here. '.repeat(50);
            mockFetch.mockResolvedValue(makeHtmlResponse('RC Quickstart', longContent));

            const tool = getToolHandler('rc_ingest');
            await tool.execute({ sources: 'https://revenuecat.com/docs/quickstart' });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            // Old chunk from same URL should be removed, other URL's chunk preserved
            const urls = written.map((d: { url: string }) => d.url);
            expect(urls.filter((u: string) => u === 'https://revenuecat.com/docs/other')).toHaveLength(1);
        });
    });

    // ── rc_search ───────────────────────────────────────────────────
    describe('rc_search', () => {
        it('should return empty KB message when no docs exist', async () => {
            const tool = getToolHandler('rc_search');
            const result = await tool.execute({ query: 'subscriptions' });

            expect(result).toContain('knowledge base is empty');
        });

        it('should reject short query words', async () => {
            const docs = [{ id: 'x', text: 'Some text', source: 'revenuecat', url: 'https://rc.com', title: 'T', ingestedAt: '2026-01-01' }];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(docs));

            const tool = getToolHandler('rc_search');
            const result = await tool.execute({ query: 'ab cd' });

            expect(result).toContain('Query too short');
        });

        it('should return scored results by keyword relevance', async () => {
            const docs = [
                { id: 'd1', text: 'RevenueCat subscription management for mobile apps subscription handling', source: 'revenuecat', url: 'https://rc.com/subs', title: 'Subscriptions', ingestedAt: '2026-01-01' },
                { id: 'd2', text: 'Webhook configuration for server notifications', source: 'revenuecat', url: 'https://rc.com/webhooks', title: 'Webhooks', ingestedAt: '2026-01-01' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(docs));

            const tool = getToolHandler('rc_search');
            const result = await tool.execute({ query: 'subscription management' });

            expect(result).toContain('Subscriptions');
            expect(result).toContain('score:');
        });

        it('should return no results message for unmatched query', async () => {
            const docs = [
                { id: 'd1', text: 'RevenueCat webhook configuration', source: 'revenuecat', url: 'https://rc.com', title: 'Docs', ingestedAt: '2026-01-01' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(docs));

            const tool = getToolHandler('rc_search');
            const result = await tool.execute({ query: 'kubernetes deployment' });

            expect(result).toContain('No results found');
        });
    });
});
