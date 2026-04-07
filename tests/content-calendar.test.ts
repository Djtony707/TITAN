/**
 * TITAN — Content Calendar Skill Tests
 * Tests calendar_add, calendar_view, calendar_update tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockRegisterSkill, mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
    mockRegisterSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
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

import { registerContentCalendarSkill } from '../src/skills/builtin/content_calendar.js';

// ── Helper: extract tool handler by name ────────────────────────────
function getToolHandler(name: string) {
    const call = mockRegisterSkill.mock.calls.find(
        ([_meta, handler]: [unknown, { name: string }]) => handler.name === name,
    );
    if (!call) throw new Error(`Tool "${name}" not registered`);
    return call[1];
}

describe('Content Calendar Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        registerContentCalendarSkill();
    });

    it('should register three tools', () => {
        expect(mockRegisterSkill).toHaveBeenCalledTimes(3);
        const names = mockRegisterSkill.mock.calls.map(([, h]: [unknown, { name: string }]) => h.name);
        expect(names).toContain('calendar_add');
        expect(names).toContain('calendar_view');
        expect(names).toContain('calendar_update');
    });

    // ── calendar_add ────────────────────────────────────────────────
    describe('calendar_add', () => {
        it('should add a content item with default draft status', async () => {
            const tool = getToolHandler('calendar_add');
            const result = await tool.execute({
                title: 'Getting Started with TITAN',
                type: 'tutorial',
                publishDate: '2026-03-20',
            });

            expect(result).toContain('Content added to calendar');
            expect(result).toContain('Getting Started with TITAN');
            expect(result).toContain('tutorial');
            expect(result).toContain('Status: draft');
            expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
        });

        it('should add a content item with custom status', async () => {
            const tool = getToolHandler('calendar_add');
            const result = await tool.execute({
                title: 'API Reference',
                type: 'docs',
                publishDate: '2026-03-22',
                status: 'review',
            });

            expect(result).toContain('Status: review');
        });

        it('should include notes and targetUrl when provided', async () => {
            const tool = getToolHandler('calendar_add');
            await tool.execute({
                title: 'Blog Post',
                type: 'blog',
                publishDate: '2026-03-25',
                notes: 'Include benchmarks',
                targetUrl: 'https://blog.example.com/titan',
            });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written[0].notes).toBe('Include benchmarks');
            expect(written[0].targetUrl).toBe('https://blog.example.com/titan');
        });

        it('should append to existing calendar entries', async () => {
            const existing = [{ id: 'old1', title: 'Old Post', type: 'blog', publishDate: '2026-03-10', status: 'published', createdAt: '2026-03-01', updatedAt: '2026-03-01' }];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(existing));

            const tool = getToolHandler('calendar_add');
            await tool.execute({ title: 'New Post', type: 'blog', publishDate: '2026-03-20' });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written).toHaveLength(2);
        });
    });

    // ── calendar_view ───────────────────────────────────────────────
    describe('calendar_view', () => {
        it('should display content grouped by week', async () => {
            const entries = [
                { id: 'c1', title: 'Tutorial A', type: 'tutorial', publishDate: '2026-03-16', status: 'draft', createdAt: '2026-03-01', updatedAt: '2026-03-01' },
                { id: 'c2', title: 'Blog B', type: 'blog', publishDate: '2026-03-17', status: 'published', createdAt: '2026-03-01', updatedAt: '2026-03-01' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const tool = getToolHandler('calendar_view');
            const result = await tool.execute({ weeks: 4 });

            expect(result).toContain('Content Calendar');
        });

        it('should show below-target warning for weeks with less than 2 items', async () => {
            // Create a single item for a future week
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 14);
            const dateStr = futureDate.toISOString().slice(0, 10);

            const entries = [
                { id: 'c1', title: 'Only One', type: 'blog', publishDate: dateStr, status: 'draft', createdAt: '2026-03-01', updatedAt: '2026-03-01' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const tool = getToolHandler('calendar_view');
            const result = await tool.execute({ weeks: 4 });

            expect(result).toContain('Below 2/week target');
        });

        it('should show (no content scheduled) for empty weeks', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify([]));

            const tool = getToolHandler('calendar_view');
            const result = await tool.execute({ weeks: 1 });

            expect(result).toContain('no content scheduled');
        });

        it('should filter by status', async () => {
            const entries = [
                { id: 'c1', title: 'Draft One', type: 'blog', publishDate: '2026-03-16', status: 'draft', createdAt: '2026-03-01', updatedAt: '2026-03-01' },
                { id: 'c2', title: 'Published One', type: 'blog', publishDate: '2026-03-16', status: 'published', createdAt: '2026-03-01', updatedAt: '2026-03-01' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const tool = getToolHandler('calendar_view');
            const result = await tool.execute({ status: 'published', weeks: 4 });

            // Only published items should appear; draft should be filtered out
            expect(result).not.toContain('Draft One');
        });
    });

    // ── calendar_update ─────────────────────────────────────────────
    describe('calendar_update', () => {
        const existingEntries = [
            { id: 'upd1', title: 'My Blog Post', type: 'blog', publishDate: '2026-03-18', status: 'draft', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
        ];

        beforeEach(() => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(existingEntries));
        });

        it('should update status with transition display', async () => {
            const tool = getToolHandler('calendar_update');
            const result = await tool.execute({ id: 'upd1', status: 'published' });

            expect(result).toContain('My Blog Post');
            expect(result).toContain('status: draft → published');
        });

        it('should update publish date', async () => {
            const tool = getToolHandler('calendar_update');
            const result = await tool.execute({ id: 'upd1', publishDate: '2026-03-25' });

            expect(result).toContain('date: 2026-03-18 → 2026-03-25');
        });

        it('should update notes', async () => {
            const tool = getToolHandler('calendar_update');
            const result = await tool.execute({ id: 'upd1', notes: 'Add code examples' });

            expect(result).toContain('notes updated');
        });

        it('should update target URL', async () => {
            const tool = getToolHandler('calendar_update');
            const result = await tool.execute({ id: 'upd1', targetUrl: 'https://dev.to/titan-post' });

            expect(result).toContain('URL: https://dev.to/titan-post');
        });

        it('should return not found for unknown ID', async () => {
            const tool = getToolHandler('calendar_update');
            const result = await tool.execute({ id: 'nope' });

            expect(result).toContain('not found');
        });
    });
});
