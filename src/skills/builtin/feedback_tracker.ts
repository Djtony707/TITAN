/**
 * TITAN — Feedback Tracker Skill (Built-in)
 * Submit, list, and update structured product feedback with dedup detection.
 * Storage: ~/.titan/feedback-log.json (JSON array)
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'FeedbackTracker';
const FEEDBACK_PATH = join(TITAN_HOME, 'feedback-log.json');

interface FeedbackEntry {
    id: string;
    timestamp: string;
    observation: string;
    impact: string;
    recommendation: string;
    evidence?: string;
    category: 'bug' | 'ux' | 'feature' | 'docs' | 'sdk';
    severity: 'low' | 'medium' | 'high' | 'critical';
    status: 'submitted' | 'acknowledged' | 'planned' | 'resolved' | 'wontfix';
    notes?: string;
}

// ─── Storage Helpers ─────────────────────────────────────────────

function loadFeedback(): FeedbackEntry[] {
    if (!existsSync(FEEDBACK_PATH)) return [];
    try {
        return JSON.parse(readFileSync(FEEDBACK_PATH, 'utf-8')) as FeedbackEntry[];
    } catch {
        return [];
    }
}

function saveFeedback(entries: FeedbackEntry[]): void {
    try {
        mkdirSync(dirname(FEEDBACK_PATH), { recursive: true });
        writeFileSync(FEEDBACK_PATH, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save feedback: ${(e as Error).message}`);
    }
}

function wordOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let overlap = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) overlap++;
    }
    return overlap / Math.max(wordsA.size, wordsB.size);
}

// ─── Skill Registration ──────────────────────────────────────────

const SKILL_META = {
    name: 'feedback_tracker',
    description: 'Use this skill when Tony says "log this feedback", "track this user complaint", "someone said X about the product", "what feedback do we have?", "note this bug report", or "track this feature request". Stores structured product feedback with dedup detection and status tracking.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerFeedbackTrackerSkill(): void {
    // Tool 1: feedback_submit
    registerSkill(
        { ...SKILL_META },
        {
            name: 'feedback_submit',
            description: 'Log new structured product feedback. Use when Tony says "log this feedback", "someone reported a bug with X", "user said Y about the product", "track this feature request", or "note this complaint". Checks for duplicates before saving.',
            parameters: {
                type: 'object',
                properties: {
                    observation: {
                        type: 'string',
                        description: 'What was observed (the issue or insight)',
                    },
                    impact: {
                        type: 'string',
                        description: 'What impact does this have on users or the product',
                    },
                    recommendation: {
                        type: 'string',
                        description: 'Recommended action or fix',
                    },
                    evidence: {
                        type: 'string',
                        description: 'Supporting evidence — URLs, screenshots, logs (optional)',
                    },
                    category: {
                        type: 'string',
                        description: 'Category: bug, ux, feature, docs, sdk',
                    },
                    severity: {
                        type: 'string',
                        description: 'Severity: low, medium, high, critical',
                    },
                },
                required: ['observation', 'impact', 'recommendation', 'category', 'severity'],
            },
            execute: async (args) => {
                try {
                    const entries = loadFeedback();
                    const observation = args.observation as string;

                    // Simple dedup: check >50% word overlap
                    for (const existing of entries) {
                        if (wordOverlap(observation, existing.observation) > 0.5) {
                            return `⚠️ Possible duplicate detected — existing feedback ID: ${existing.id}\nExisting observation: "${existing.observation}"\nUse feedback_list to review before resubmitting.`;
                        }
                    }

                    const entry: FeedbackEntry = {
                        id: uuid().slice(0, 8),
                        timestamp: new Date().toISOString(),
                        observation,
                        impact: args.impact as string,
                        recommendation: args.recommendation as string,
                        evidence: args.evidence as string | undefined,
                        category: args.category as FeedbackEntry['category'],
                        severity: args.severity as FeedbackEntry['severity'],
                        status: 'submitted',
                    };

                    entries.push(entry);
                    saveFeedback(entries);
                    logger.info(COMPONENT, `Feedback submitted: ${entry.id} (${entry.category}/${entry.severity})`);
                    return `Feedback submitted (ID: ${entry.id})\nCategory: ${entry.category} | Severity: ${entry.severity}\nObservation: "${entry.observation}"`;
                } catch (e) {
                    return `Error submitting feedback: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: feedback_list
    registerSkill(
        { ...SKILL_META },
        {
            name: 'feedback_list',
            description: 'Show all tracked product feedback, optionally filtered by status or category. Use when Tony asks "what feedback do we have?", "show me open bugs", "what feature requests are pending?", or "list all critical feedback".',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        description: 'Filter by status: submitted, acknowledged, planned, resolved, wontfix (optional)',
                    },
                    category: {
                        type: 'string',
                        description: 'Filter by category: bug, ux, feature, docs, sdk (optional)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results to return (default: 10)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                try {
                    const statusFilter = args.status as string | undefined;
                    const categoryFilter = args.category as string | undefined;
                    const limit = (args.limit as number) || 10;

                    let entries = loadFeedback();
                    if (statusFilter) entries = entries.filter(e => e.status === statusFilter);
                    if (categoryFilter) entries = entries.filter(e => e.category === categoryFilter);

                    const subset = entries.slice(-limit).reverse();

                    if (subset.length === 0) {
                        return 'No feedback entries found matching the criteria.';
                    }

                    const lines: string[] = [
                        `Feedback Log (${subset.length} of ${entries.length} entries)`,
                        '═══════════════════════════════════════════════════════',
                        `${'ID'.padEnd(10)}${'Category'.padEnd(10)}${'Severity'.padEnd(10)}${'Status'.padEnd(14)}Observation`,
                        '─'.repeat(70),
                    ];

                    for (const e of subset) {
                        lines.push(
                            `${e.id.padEnd(10)}${e.category.padEnd(10)}${e.severity.padEnd(10)}${e.status.padEnd(14)}${e.observation.slice(0, 50)}`,
                        );
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error listing feedback: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: feedback_update
    registerSkill(
        { ...SKILL_META },
        {
            name: 'feedback_update',
            description: 'Update the status of a feedback entry and optionally add a note. Use when Tony says "mark that feedback as resolved", "acknowledge this bug", "that feature is now planned", or "add a note to feedback [ID]".',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Feedback entry ID',
                    },
                    status: {
                        type: 'string',
                        description: 'New status: submitted, acknowledged, planned, resolved, wontfix',
                    },
                    note: {
                        type: 'string',
                        description: 'Optional note to append',
                    },
                },
                required: ['id', 'status'],
            },
            execute: async (args) => {
                try {
                    const entries = loadFeedback();
                    const id = args.id as string;
                    const entry = entries.find(e => e.id === id);

                    if (!entry) {
                        return `Feedback entry "${id}" not found.`;
                    }

                    const oldStatus = entry.status;
                    entry.status = args.status as FeedbackEntry['status'];

                    if (args.note) {
                        const noteText = args.note as string;
                        entry.notes = entry.notes
                            ? `${entry.notes}\n[${new Date().toISOString().slice(0, 10)}] ${noteText}`
                            : `[${new Date().toISOString().slice(0, 10)}] ${noteText}`;
                    }

                    saveFeedback(entries);
                    logger.info(COMPONENT, `Feedback ${id} updated: ${oldStatus} → ${entry.status}`);
                    return `Feedback ${id} updated: ${oldStatus} → ${entry.status}${args.note ? `\nNote added: "${args.note as string}"` : ''}`;
                } catch (e) {
                    return `Error updating feedback: ${(e as Error).message}`;
                }
            },
        },
    );
}
