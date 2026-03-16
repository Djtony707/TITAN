/**
 * TITAN — Interaction Tracker Skill (Built-in)
 * Log, search, and analyze community interactions across platforms.
 * Storage: ~/.titan/interactions.jsonl (append-only JSONL)
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'InteractionTracker';
const INTERACTIONS_PATH = join(TITAN_HOME, 'interactions.jsonl');

interface InteractionEntry {
    id: string;
    timestamp: string;
    platform: 'x' | 'github' | 'discord' | 'slack' | 'forum' | 'other';
    type: 'reply' | 'comment' | 'post' | 'issue' | 'pr' | 'review';
    contentSummary: string;
    url?: string;
    sentiment?: 'positive' | 'neutral' | 'negative';
}

// ─── Storage Helpers ─────────────────────────────────────────────

function ensureFile(): void {
    const dir = dirname(INTERACTIONS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(INTERACTIONS_PATH)) writeFileSync(INTERACTIONS_PATH, '', 'utf-8');
}

function appendEntry(entry: InteractionEntry): void {
    ensureFile();
    appendFileSync(INTERACTIONS_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}

function loadEntries(): InteractionEntry[] {
    ensureFile();
    const raw = readFileSync(INTERACTIONS_PATH, 'utf-8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const entries: InteractionEntry[] = [];
    for (const line of lines) {
        try {
            entries.push(JSON.parse(line) as InteractionEntry);
        } catch {
            logger.warn(COMPONENT, `Skipping corrupt JSONL line`);
        }
    }
    return entries;
}

function filterByPeriod(entries: InteractionEntry[], period: string): InteractionEntry[] {
    const now = Date.now();
    let cutoff: number;
    switch (period) {
        case 'day':
            cutoff = now - 24 * 60 * 60 * 1000;
            break;
        case 'month':
            cutoff = now - 30 * 24 * 60 * 60 * 1000;
            break;
        case 'week':
        default:
            cutoff = now - 7 * 24 * 60 * 60 * 1000;
            break;
    }
    return entries.filter(e => new Date(e.timestamp).getTime() >= cutoff);
}

// ─── Skill Registration ──────────────────────────────────────────

const SKILL_META = {
    name: 'interaction_tracker',
    description: 'Use this skill when Tony says "log this interaction", "track that I talked to X", "note this reply I made", "I commented on [post]", "how many interactions have I had this week?", or "find interactions where I mentioned X". Tracks community engagement across X, GitHub, Discord, Slack, and forums with stats and trends.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerInteractionTrackerSkill(): void {
    // Tool 1: interaction_log
    registerSkill(
        { ...SKILL_META },
        {
            name: 'interaction_log',
            description: 'Log a community interaction — reply, comment, post, GitHub issue/PR, or review. Use when Tony says "log this interaction", "track that I replied to [person]", "note this comment I made", or "record this engagement on [platform]".',
            parameters: {
                type: 'object',
                properties: {
                    platform: {
                        type: 'string',
                        description: 'Platform: x, github, discord, slack, forum, other',
                    },
                    type: {
                        type: 'string',
                        description: 'Interaction type: reply, comment, post, issue, pr, review',
                    },
                    contentSummary: {
                        type: 'string',
                        description: 'Brief summary of the interaction content',
                    },
                    url: {
                        type: 'string',
                        description: 'URL of the interaction (optional)',
                    },
                    sentiment: {
                        type: 'string',
                        description: 'Sentiment: positive, neutral, negative (optional)',
                    },
                },
                required: ['platform', 'type', 'contentSummary'],
            },
            execute: async (args) => {
                const entry: InteractionEntry = {
                    id: uuid().slice(0, 8),
                    timestamp: new Date().toISOString(),
                    platform: args.platform as InteractionEntry['platform'],
                    type: args.type as InteractionEntry['type'],
                    contentSummary: args.contentSummary as string,
                    url: args.url as string | undefined,
                    sentiment: args.sentiment as InteractionEntry['sentiment'] | undefined,
                };

                try {
                    appendEntry(entry);
                    logger.info(COMPONENT, `Logged interaction ${entry.id} on ${entry.platform}`);
                    return `Interaction logged (ID: ${entry.id}) — ${entry.platform}/${entry.type}: "${entry.contentSummary}"`;
                } catch (e) {
                    return `Error logging interaction: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: interaction_stats
    registerSkill(
        { ...SKILL_META },
        {
            name: 'interaction_stats',
            description: 'Get interaction statistics — totals, breakdowns by platform and type, and daily trend charts. Use when Tony asks "how many interactions have I had this week?", "am I on track with my engagement goals?", or "show me a breakdown of my community activity".',
            parameters: {
                type: 'object',
                properties: {
                    period: {
                        type: 'string',
                        description: 'Time period: day, week (default), month',
                    },
                    platform: {
                        type: 'string',
                        description: 'Filter by platform (optional)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                try {
                    const period = (args.period as string) || 'week';
                    const platformFilter = args.platform as string | undefined;

                    const all = loadEntries();
                    let filtered = filterByPeriod(all, period);
                    if (platformFilter) {
                        filtered = filtered.filter(e => e.platform === platformFilter);
                    }

                    const total = filtered.length;

                    // Breakdown by platform
                    const byPlatform: Record<string, number> = {};
                    for (const e of filtered) {
                        byPlatform[e.platform] = (byPlatform[e.platform] || 0) + 1;
                    }

                    // Breakdown by type
                    const byType: Record<string, number> = {};
                    for (const e of filtered) {
                        byType[e.type] = (byType[e.type] || 0) + 1;
                    }

                    // Daily trend (last 7 days)
                    const dailyTrend: Record<string, number> = {};
                    for (let i = 6; i >= 0; i--) {
                        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
                        const key = d.toISOString().slice(0, 10);
                        dailyTrend[key] = 0;
                    }
                    for (const e of filtered) {
                        const day = e.timestamp.slice(0, 10);
                        if (day in dailyTrend) {
                            dailyTrend[day]++;
                        }
                    }

                    const lines: string[] = [
                        `Interaction Stats (${period}${platformFilter ? ` — ${platformFilter}` : ''})`,
                        `═══════════════════════════════════`,
                        `Total: ${total}`,
                        '',
                        'By Platform:',
                        ...Object.entries(byPlatform).map(([k, v]) => `  ${k}: ${v}`),
                        '',
                        'By Type:',
                        ...Object.entries(byType).map(([k, v]) => `  ${k}: ${v}`),
                        '',
                        'Daily Trend (last 7 days):',
                        ...Object.entries(dailyTrend).map(([day, count]) => `  ${day}: ${'█'.repeat(count)} (${count})`),
                    ];

                    if (period === 'week' && total < 50) {
                        lines.push('');
                        lines.push(`⚠️ Below 50/week target (currently ${total})`);
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error getting stats: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: interaction_search
    registerSkill(
        { ...SKILL_META },
        {
            name: 'interaction_search',
            description: 'Search past interactions by keyword. Use when Tony asks "find interactions where I mentioned X", "did I talk to someone about Y?", or "search my interaction history for [topic]".',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (case-insensitive)',
                    },
                    platform: {
                        type: 'string',
                        description: 'Filter by platform (optional)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results to return (default: 20)',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                try {
                    const query = (args.query as string).toLowerCase();
                    const platformFilter = args.platform as string | undefined;
                    const limit = (args.limit as number) || 20;

                    let entries = loadEntries();
                    if (platformFilter) {
                        entries = entries.filter(e => e.platform === platformFilter);
                    }

                    const matches = entries
                        .filter(e => e.contentSummary.toLowerCase().includes(query))
                        .slice(-limit)
                        .reverse();

                    if (matches.length === 0) {
                        return `No interactions found matching "${args.query as string}"`;
                    }

                    const lines: string[] = [`Search: "${args.query as string}" (${matches.length} results)`, ''];
                    for (const m of matches) {
                        lines.push(`[${m.id}] ${m.timestamp.slice(0, 10)} ${m.platform}/${m.type}`);
                        lines.push(`  ${m.contentSummary}`);
                        if (m.url) lines.push(`  URL: ${m.url}`);
                        if (m.sentiment) lines.push(`  Sentiment: ${m.sentiment}`);
                        lines.push('');
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error searching interactions: ${(e as Error).message}`;
                }
            },
        },
    );
}
