/**
 * TITAN — Content Calendar Skill (Built-in)
 * Plan, schedule, and track content across blogs, tutorials, social, docs, and more.
 * Storage: ~/.titan/content-calendar.json (JSON array)
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'ContentCalendar';
const CALENDAR_PATH = join(TITAN_HOME, 'content-calendar.json');

interface CalendarEntry {
    id: string;
    title: string;
    type: 'blog' | 'tutorial' | 'code-sample' | 'docs' | 'social' | 'case-study';
    publishDate: string;
    status: 'idea' | 'draft' | 'review' | 'published' | 'cancelled';
    notes?: string;
    targetUrl?: string;
    createdAt: string;
    updatedAt: string;
}

// ─── Storage Helpers ─────────────────────────────────────────────

function loadCalendar(): CalendarEntry[] {
    if (!existsSync(CALENDAR_PATH)) return [];
    try {
        return JSON.parse(readFileSync(CALENDAR_PATH, 'utf-8')) as CalendarEntry[];
    } catch {
        return [];
    }
}

function saveCalendar(entries: CalendarEntry[]): void {
    try {
        mkdirSync(dirname(CALENDAR_PATH), { recursive: true });
        writeFileSync(CALENDAR_PATH, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save content calendar: ${(e as Error).message}`);
    }
}

function getWeekKey(dateStr: string): string {
    const d = new Date(dateStr);
    // Get Monday of the week
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d);
    monday.setDate(diff);
    return monday.toISOString().slice(0, 10);
}

// ─── Skill Registration ──────────────────────────────────────────

const SKILL_META = {
    name: 'content_calendar',
    description: 'Use this skill when Tony says things like "plan my content", "what should I post this week?", "schedule posts for next week", "content ideas for X", "show me my content calendar", or "what content do I have coming up?". This skill manages the full content planning pipeline — add ideas, view the calendar grouped by week, update status, and get suggestions. Always show a calendar view when asked about upcoming content.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerContentCalendarSkill(): void {
    // Tool 1: calendar_add
    registerSkill(
        { ...SKILL_META },
        {
            name: 'calendar_add',
            description: 'Add a new content idea or scheduled post to the content calendar. Use when Tony says "add this to the calendar", "schedule a post about X", or "I want to publish X on [date]".',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Content title',
                    },
                    type: {
                        type: 'string',
                        description: 'Content type: blog, tutorial, code-sample, docs, social, case-study',
                    },
                    publishDate: {
                        type: 'string',
                        description: 'Target publish date (ISO format, e.g., 2026-03-20)',
                    },
                    status: {
                        type: 'string',
                        description: 'Initial status: idea, draft, review, published, cancelled (default: draft)',
                    },
                    notes: {
                        type: 'string',
                        description: 'Additional notes (optional)',
                    },
                    targetUrl: {
                        type: 'string',
                        description: 'Target URL where content will be published (optional)',
                    },
                },
                required: ['title', 'type', 'publishDate'],
            },
            execute: async (args) => {
                try {
                    const entries = loadCalendar();
                    const now = new Date().toISOString();

                    const entry: CalendarEntry = {
                        id: uuid().slice(0, 8),
                        title: args.title as string,
                        type: args.type as CalendarEntry['type'],
                        publishDate: args.publishDate as string,
                        status: (args.status as CalendarEntry['status']) || 'draft',
                        notes: args.notes as string | undefined,
                        targetUrl: args.targetUrl as string | undefined,
                        createdAt: now,
                        updatedAt: now,
                    };

                    entries.push(entry);
                    saveCalendar(entries);
                    logger.info(COMPONENT, `Content added: ${entry.id} "${entry.title}" for ${entry.publishDate}`);

                    return `Content added to calendar (ID: ${entry.id})\nTitle: ${entry.title}\nType: ${entry.type} | Date: ${entry.publishDate} | Status: ${entry.status}`;
                } catch (e) {
                    return `Error adding content: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: calendar_view
    registerSkill(
        { ...SKILL_META },
        {
            name: 'calendar_view',
            description: 'Show the content calendar grouped by week. Use when Tony asks "what do I have scheduled?", "show my content plan", "what am I posting this week?", or "do I have enough content lined up?". Flags weeks that fall below the 2/week publishing target.',
            parameters: {
                type: 'object',
                properties: {
                    weeks: {
                        type: 'number',
                        description: 'Number of weeks to show (default: 2)',
                    },
                    status: {
                        type: 'string',
                        description: 'Filter by status (optional)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                try {
                    const weeksToShow = (args.weeks as number) || 2;
                    const statusFilter = args.status as string | undefined;

                    let entries = loadCalendar();
                    if (statusFilter) entries = entries.filter(e => e.status === statusFilter);

                    // Build week boundaries
                    const now = new Date();
                    const today = now.toISOString().slice(0, 10);
                    const weekStarts: string[] = [];
                    for (let i = -1; i < weeksToShow; i++) {
                        const d = new Date(now);
                        d.setDate(d.getDate() + (i * 7));
                        weekStarts.push(getWeekKey(d.toISOString()));
                    }
                    // Deduplicate and sort
                    const uniqueWeeks = [...new Set(weekStarts)].sort();

                    // Group entries by week
                    const byWeek: Record<string, CalendarEntry[]> = {};
                    for (const week of uniqueWeeks) {
                        byWeek[week] = [];
                    }
                    for (const entry of entries) {
                        const week = getWeekKey(entry.publishDate);
                        if (week in byWeek) {
                            byWeek[week].push(entry);
                        }
                    }

                    const lines: string[] = [
                        `Content Calendar (${weeksToShow} weeks from ${today})`,
                        '═══════════════════════════════════════════════════════',
                    ];

                    for (const week of uniqueWeeks) {
                        const weekEntries = byWeek[week];
                        const weekEnd = new Date(new Date(week).getTime() + 6 * 24 * 60 * 60 * 1000)
                            .toISOString().slice(0, 10);
                        const publishedCount = weekEntries.filter(e => e.status === 'published').length;
                        const totalCount = weekEntries.length;
                        const isUpcoming = week >= today;

                        lines.push('');
                        lines.push(`Week of ${week} → ${weekEnd} (${totalCount} items, ${publishedCount} published)`);

                        if (isUpcoming && totalCount < 2) {
                            lines.push(`  ⚠️ Below 2/week target`);
                        }

                        lines.push('  ─────────────────────────────────────────');

                        if (weekEntries.length === 0) {
                            lines.push('  (no content scheduled)');
                        } else {
                            for (const e of weekEntries.sort((a, b) => a.publishDate.localeCompare(b.publishDate))) {
                                const statusIcon = e.status === 'published' ? '✅' :
                                    e.status === 'review' ? '👀' :
                                    e.status === 'draft' ? '📝' :
                                    e.status === 'idea' ? '💡' : '🚫';
                                lines.push(`  ${statusIcon} [${e.id}] ${e.publishDate} | ${e.type} | ${e.title}`);
                                if (e.targetUrl) lines.push(`     URL: ${e.targetUrl}`);
                                if (e.notes) lines.push(`     Notes: ${e.notes}`);
                            }
                        }
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error viewing calendar: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: calendar_update
    registerSkill(
        { ...SKILL_META },
        {
            name: 'calendar_update',
            description: 'Update an existing content calendar entry — change its status, reschedule it, add notes, or set the target URL. Use when Tony says "mark that as published", "move that post to next week", or "update the notes on [entry]".',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Content entry ID',
                    },
                    status: {
                        type: 'string',
                        description: 'New status: idea, draft, review, published, cancelled (optional)',
                    },
                    publishDate: {
                        type: 'string',
                        description: 'New publish date in ISO format (optional)',
                    },
                    notes: {
                        type: 'string',
                        description: 'Updated notes (optional)',
                    },
                    targetUrl: {
                        type: 'string',
                        description: 'Updated target URL (optional)',
                    },
                },
                required: ['id'],
            },
            execute: async (args) => {
                try {
                    const entries = loadCalendar();
                    const id = args.id as string;
                    const entry = entries.find(e => e.id === id);

                    if (!entry) {
                        return `Content entry "${id}" not found.`;
                    }

                    const updates: string[] = [];

                    if (args.status !== undefined) {
                        const oldStatus = entry.status;
                        entry.status = args.status as CalendarEntry['status'];
                        updates.push(`status: ${oldStatus} → ${entry.status}`);
                    }
                    if (args.publishDate !== undefined) {
                        const oldDate = entry.publishDate;
                        entry.publishDate = args.publishDate as string;
                        updates.push(`date: ${oldDate} → ${entry.publishDate}`);
                    }
                    if (args.notes !== undefined) {
                        entry.notes = args.notes as string;
                        updates.push(`notes updated`);
                    }
                    if (args.targetUrl !== undefined) {
                        entry.targetUrl = args.targetUrl as string;
                        updates.push(`URL: ${entry.targetUrl}`);
                    }

                    entry.updatedAt = new Date().toISOString();
                    saveCalendar(entries);
                    logger.info(COMPONENT, `Content ${id} updated: ${updates.join(', ')}`);

                    return `Content "${entry.title}" (${id}) updated:\n${updates.map(u => `  • ${u}`).join('\n')}`;
                } catch (e) {
                    return `Error updating content: ${(e as Error).message}`;
                }
            },
        },
    );
}
