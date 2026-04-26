/**
 * TITAN — Content Publisher Skill Tests
 * Tests for src/skills/builtin/content_publisher.ts
 * Covers all 4 tool handlers: content_research, content_outline, content_publish, content_schedule
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Global mocks ──────────────────────────────────────────────────

const handlers = new Map<string, any>();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
        handlers.set(handler.name, handler);
    }),
}));

vi.mock('../src/agent/goals.js', () => ({
    createGoal: vi.fn((def: any) => ({ ...def, id: 'goal-test-123', subtasks: def.subtasks || [] })),
    listGoals: vi.fn(() => []),
    updateGoal: vi.fn(),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(async () => {
    handlers.clear();
    mockFetch.mockReset();

    const { registerSkill } = await import('../src/skills/registry.js');
    vi.mocked(registerSkill).mockClear();

    const { registerContentPublisherSkill } = await import('../src/skills/builtin/content_publisher.js');
    registerContentPublisherSkill();
});

// ════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════

describe('Content Publisher Skill — Registration', () => {
    it('should register all 4 tool handlers', () => {
        expect(handlers.size).toBe(4);
        expect(handlers.has('content_research')).toBe(true);
        expect(handlers.has('content_outline')).toBe(true);
        expect(handlers.has('content_publish')).toBe(true);
        expect(handlers.has('content_schedule')).toBe(true);
    });

    it('should have niche as required parameter for content_research', () => {
        const handler = handlers.get('content_research');
        expect(handler.parameters.required).toContain('niche');
    });

    it('should have repo as required parameter for content_publish', () => {
        const handler = handlers.get('content_publish');
        expect(handler.parameters.required).toContain('repo');
    });
});

// ════════════════════════════════════════════════════════════════════
// content_research
// ════════════════════════════════════════════════════════════════════

describe('Content Publisher — content_research', () => {
    it('should research trending topics', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => `
                <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fai-agents">AI Agents in 2026</a>
                <a class="result__snippet">The latest trends in AI agent development</a>
            `,
        });

        const handler = handlers.get('content_research');
        const result = await handler.execute({ niche: 'AI agents', type: 'trends' });

        expect(result).toContain('Content Research');
        expect(result).toContain('AI agents');
    });

    it('should handle no results', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => '<html></html>',
        });

        const handler = handlers.get('content_research');
        const result = await handler.execute({ niche: 'xyznonexistent' });

        expect(result).toContain('No research results');
    });

    it('should handle search failure', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });

        const handler = handlers.get('content_research');
        const result = await handler.execute({ niche: 'test' });

        expect(result).toContain('Research failed');
    });
});

// ════════════════════════════════════════════════════════════════════
// content_outline
// ════════════════════════════════════════════════════════════════════

describe('Content Publisher — content_outline', () => {
    it('should generate article outline', async () => {
        const handler = handlers.get('content_outline');
        const result = await handler.execute({
            title: 'How to Build AI Agents',
            topic: 'AI agent development',
        });

        expect(result).toContain('# How to Build AI Agents');
        expect(result).toContain('Introduction');
        expect(result).toContain('Conclusion');
        expect(result).toContain('Section');
    });

    it('should adjust sections based on target length', async () => {
        const handler = handlers.get('content_outline');

        const shortResult = await handler.execute({
            title: 'Short Article',
            topic: 'test',
            targetLength: 'short',
        });

        const longResult = await handler.execute({
            title: 'Long Article',
            topic: 'test',
            targetLength: 'long',
        });

        const shortSections = (shortResult.match(/## Section/g) || []).length;
        const longSections = (longResult.match(/## Section/g) || []).length;

        expect(longSections).toBeGreaterThan(shortSections);
    });

    it('should include keywords', async () => {
        const handler = handlers.get('content_outline');
        const result = await handler.execute({
            title: 'Test',
            topic: 'test',
            keywords: 'AI,automation,agents',
        });

        expect(result).toContain('AI');
        expect(result).toContain('automation');
    });
});

// ════════════════════════════════════════════════════════════════════
// content_publish
// ════════════════════════════════════════════════════════════════════

describe('Content Publisher — content_publish', () => {
    it('should require GITHUB_TOKEN', async () => {
        const originalToken = process.env.GITHUB_TOKEN;
        const originalGhToken = process.env.GH_TOKEN;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;

        const handler = handlers.get('content_publish');
        const result = await handler.execute({
            repo: 'user/repo',
            title: 'Test Article',
            content: '# Hello',
        });

        expect(result).toContain('GITHUB_TOKEN');

        if (originalToken) process.env.GITHUB_TOKEN = originalToken;
        if (originalGhToken) process.env.GH_TOKEN = originalGhToken;
    });

    it('should publish article when token exists', async () => {
        const originalToken = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'test-token';

        // Mock file check (404 = new file)
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // Mock file creation
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ content: { html_url: 'https://github.com/user/repo/blob/main/_posts/test.md' } }),
        });

        const handler = handlers.get('content_publish');
        const result = await handler.execute({
            repo: 'user/repo',
            title: 'Test Article',
            content: 'Hello world',
        });

        expect(result).toContain('Published');
        expect(result).toContain('Test Article');

        if (originalToken) process.env.GITHUB_TOKEN = originalToken;
        else delete process.env.GITHUB_TOKEN;
    });

    it('should handle publish failure', async () => {
        const originalToken = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'test-token';

        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            text: async () => 'Forbidden',
        });

        const handler = handlers.get('content_publish');
        const result = await handler.execute({
            repo: 'user/repo',
            title: 'Test',
            content: 'Hello',
        });

        expect(result).toContain('Publish failed');

        if (originalToken) process.env.GITHUB_TOKEN = originalToken;
        else delete process.env.GITHUB_TOKEN;
    });
});

// ════════════════════════════════════════════════════════════════════
// content_schedule
// ════════════════════════════════════════════════════════════════════

describe('Content Publisher — content_schedule', () => {
    it('should create a content schedule', async () => {
        const handler = handlers.get('content_schedule');
        const result = await handler.execute({
            niche: 'AI agents',
            repo: 'user/blog',
            frequency: 'daily',
        });

        expect(result).toContain('Content Schedule Created');
        expect(result).toContain('AI agents');
        expect(result).toContain('user/blog');
    });

    it('should support weekly frequency', async () => {
        const handler = handlers.get('content_schedule');
        const result = await handler.execute({
            niche: 'tech',
            repo: 'user/blog',
            frequency: 'weekly',
        });

        expect(result).toContain('Monday');
    });
});
