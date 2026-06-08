/**
 * TITAN — Calendar Skill Tests
 * Tests skills/builtin/calendar.ts: registerCalendarSkill, list/create/delete actions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        security: { deniedTools: [], allowedTools: [] },
    }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Calendar Skill', () => {
    let calendarHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mockFetch);

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));

        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                calendarHandler = handler;
            }),
        }));

        const { registerCalendarSkill } = await import('../src/skills/builtin/calendar.js');
        registerCalendarSkill();
    });

    afterEach(() => {
        delete process.env.GOOGLE_CALENDAR_API_KEY;
        delete process.env.GOOGLE_CALENDAR_ID;
    });

    it('should register the calendar handler', () => {
        expect(calendarHandler).toBeDefined();
        expect(calendarHandler.name).toBe('calendar');
    });

    it('should return setup instructions when API key is not set', async () => {
        delete process.env.GOOGLE_CALENDAR_API_KEY;
        const result = await calendarHandler.execute({ action: 'list' });
        expect(result).toContain('GOOGLE_CALENDAR_API_KEY not configured');
        expect(result).toContain('Setup instructions');
    });

    describe('with API key configured', () => {
        beforeEach(() => {
            process.env.GOOGLE_CALENDAR_API_KEY = 'test-api-key';
        });

        describe('list action', () => {
            it('should list upcoming events', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        items: [
                            {
                                id: 'event-1',
                                summary: 'Team Meeting',
                                start: { dateTime: '2026-03-15T10:00:00Z' },
                                end: { dateTime: '2026-03-15T11:00:00Z' },
                                location: 'Conference Room A',
                            },
                            {
                                id: 'event-2',
                                summary: 'Lunch',
                                start: { date: '2026-03-16' },
                                end: { date: '2026-03-16' },
                            },
                        ],
                    }),
                });

                const result = await calendarHandler.execute({ action: 'list', days: 7 });
                expect(result).toContain('Team Meeting');
                expect(result).toContain('Lunch');
                expect(result).toContain('Conference Room A');
            });

            it('should handle no events', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ items: [] }),
                });

                const result = await calendarHandler.execute({ action: 'list' });
                expect(result).toContain('No events found');
            });

            it('should handle null items', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({}),
                });

                const result = await calendarHandler.execute({ action: 'list' });
                expect(result).toContain('No events found');
            });

            it('should handle API errors', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: false,
                    status: 403,
                    text: () => Promise.resolve('Forbidden'),
                });

                const result = await calendarHandler.execute({ action: 'list' });
                expect(result).toContain('Error');
            });

            it('should cap days at 365', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ items: [] }),
                });

                await calendarHandler.execute({ action: 'list', days: 9999 });
                // Should not throw, capped internally
                expect(mockFetch).toHaveBeenCalled();
            });

            it('should use default calendar ID when not set', async () => {
                delete process.env.GOOGLE_CALENDAR_ID;
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ items: [] }),
                });

                await calendarHandler.execute({ action: 'list' });
                const url = mockFetch.mock.calls[0][0] as string;
                expect(url).toContain('primary');
            });

            it('should use custom calendar ID when set', async () => {
                process.env.GOOGLE_CALENDAR_ID = 'my-calendar@gmail.com';
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ items: [] }),
                });

                await calendarHandler.execute({ action: 'list' });
                const url = mockFetch.mock.calls[0][0] as string;
                expect(url).toContain('my-calendar');
            });

            it('should handle event with description', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        items: [
                            {
                                id: 'event-desc',
                                summary: 'Design Review',
                                start: { dateTime: '2026-03-15T14:00:00Z' },
                                end: { dateTime: '2026-03-15T15:00:00Z' },
                                description: 'Review the new dashboard design',
                            },
                        ],
                    }),
                });

                const result = await calendarHandler.execute({ action: 'list' });
                expect(result).toContain('Review the new dashboard design');
            });
        });

        // v6.5 — create/delete disabled pending Google OAuth (API key only does
        // public reads). Granular tests below cover handler logic retained for the
        // eventual re-enable; they are skipped while the dispatch short-circuits.
        describe.skip('create action — disabled v6.5 pending Google OAuth (handler logic retained)', () => {
            it('should create an event', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        id: 'new-event-1',
                        htmlLink: 'https://calendar.google.com/event/new-event-1',
                    }),
                });

                const result = await calendarHandler.execute({
                    action: 'create',
                    title: 'Sprint Planning',
                    startTime: '2026-03-20T09:00:00Z',
                    endTime: '2026-03-20T10:00:00Z',
                    description: 'Plan the next sprint',
                    location: 'Room B',
                });
                expect(result).toContain('Created event');
                expect(result).toContain('Sprint Planning');
                expect(result).toContain('new-event-1');
            });

            it('should require title, startTime, endTime', async () => {
                let result = await calendarHandler.execute({ action: 'create' });
                expect(result).toContain('Error');
                expect(result).toContain('required');

                result = await calendarHandler.execute({ action: 'create', title: 'Test' });
                expect(result).toContain('Error');

                result = await calendarHandler.execute({ action: 'create', title: 'Test', startTime: '2026-03-20T09:00:00Z' });
                expect(result).toContain('Error');
            });

            it('should validate ISO date formats', async () => {
                const result = await calendarHandler.execute({
                    action: 'create',
                    title: 'Bad Date',
                    startTime: 'not-a-date',
                    endTime: 'also-not-a-date',
                });
                expect(result).toContain('Error');
                expect(result).toContain('valid ISO');
            });

            it('should reject startTime after endTime', async () => {
                const result = await calendarHandler.execute({
                    action: 'create',
                    title: 'Backwards Event',
                    startTime: '2026-03-20T10:00:00Z',
                    endTime: '2026-03-20T09:00:00Z',
                });
                expect(result).toContain('Error');
                expect(result).toContain('before');
            });

            it('should handle API errors on create', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: false,
                    status: 401,
                    text: () => Promise.resolve('Unauthorized'),
                });

                const result = await calendarHandler.execute({
                    action: 'create',
                    title: 'Test',
                    startTime: '2026-03-20T09:00:00Z',
                    endTime: '2026-03-20T10:00:00Z',
                });
                expect(result).toContain('Error');
            });
        });

        describe.skip('delete action — disabled v6.5 pending Google OAuth (handler logic retained)', () => {
            it('should delete an event', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 204,
                });

                const result = await calendarHandler.execute({
                    action: 'delete',
                    eventId: 'event-to-delete',
                });
                expect(result).toContain('Deleted event');
                expect(result).toContain('event-to-delete');
            });

            it('should require eventId', async () => {
                const result = await calendarHandler.execute({ action: 'delete' });
                expect(result).toContain('Error');
                expect(result).toContain('eventId');
            });

            it('should handle 404 for missing event', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: false,
                    status: 404,
                    text: () => Promise.resolve('Not Found'),
                });

                const result = await calendarHandler.execute({
                    action: 'delete',
                    eventId: 'nonexistent',
                });
                expect(result).toContain('not found');
            });

            it('should handle API errors on delete', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    text: () => Promise.resolve('Server Error'),
                });

                const result = await calendarHandler.execute({
                    action: 'delete',
                    eventId: 'bad-delete',
                });
                expect(result).toContain('Error');
            });
        });

        // v6.5 — assert the honest-disable is actually in place (not faking writes).
        describe('create/delete disabled pending OAuth (v6.5)', () => {
            it('create returns an honest OAuth error instead of faking a write', async () => {
                const result = await calendarHandler.execute({
                    action: 'create', title: 'X', startTime: '2026-03-20T09:00:00Z', endTime: '2026-03-20T10:00:00Z',
                });
                expect(result).toContain('OAuth');
                expect(result).not.toContain('Created event');
            });
            it('delete returns an honest OAuth error instead of faking a delete', async () => {
                const result = await calendarHandler.execute({ action: 'delete', eventId: 'e1' });
                expect(result).toContain('OAuth');
                expect(result).not.toContain('Deleted event');
            });
        });

        describe('unknown action', () => {
            it('should handle unknown action gracefully', async () => {
                const result = await calendarHandler.execute({ action: 'unknown_action' });
                expect(result).toContain('Unknown action');
            });
        });
    });
});
