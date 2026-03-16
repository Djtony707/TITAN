/**
 * TITAN — Weekly Report Generator Skill (Built-in)
 * Generates structured weekly async check-in reports for Dev Advocacy + Growth teams.
 * Aggregates data from interaction tracker, feedback tracker, growth experiments, and content calendar.
 *
 * Storage: ~/.titan/weekly-reports/ (one JSON per week)
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'WeeklyReport';
const REPORTS_DIR = join(TITAN_HOME, 'weekly-reports');
const INTERACTIONS_PATH = join(TITAN_HOME, 'interactions.jsonl');
const FEEDBACK_PATH = join(TITAN_HOME, 'feedback-log.json');
const EXPERIMENTS_PATH = join(TITAN_HOME, 'experiments-log.json');
const CALENDAR_PATH = join(TITAN_HOME, 'content-calendar.json');

interface WeeklyReport {
    weekOf: string;
    generatedAt: string;
    summary: string;
    sections: {
        contentPublished: { count: number; target: number; items: string[] };
        communityInteractions: { count: number; target: number; byPlatform: Record<string, number> };
        growthExperiments: { active: number; completed: number; target: number; items: string[] };
        productFeedback: { submitted: number; target: number; items: string[] };
        keyMetrics: Record<string, string | number>;
        learnings: string[];
    };
}

function getWeekStart(date?: string): string {
    const d = date ? new Date(date) : new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    const monday = new Date(d.setDate(diff));
    return monday.toISOString().split('T')[0];
}

function getWeekEnd(weekStart: string): string {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 6);
    return d.toISOString().split('T')[0];
}

function ensureReportsDir(): void {
    if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
}

function loadInteractionsForWeek(weekStart: string, weekEnd: string): Array<{ platform: string; type: string; summary: string }> {
    if (!existsSync(INTERACTIONS_PATH)) return [];
    try {
        const lines = readFileSync(INTERACTIONS_PATH, 'utf-8').split('\n').filter(Boolean);
        const startDate = new Date(weekStart);
        const endDate = new Date(weekEnd + 'T23:59:59');
        return lines
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean)
            .filter((i: { timestamp?: string }) => {
                if (!i.timestamp) return false;
                const t = new Date(i.timestamp);
                return t >= startDate && t <= endDate;
            });
    } catch { return []; }
}

function loadFeedbackForWeek(weekStart: string, weekEnd: string): Array<{ observation: string; category: string; severity: string }> {
    if (!existsSync(FEEDBACK_PATH)) return [];
    try {
        const data = JSON.parse(readFileSync(FEEDBACK_PATH, 'utf-8'));
        const items = data.feedback || data || [];
        const startDate = new Date(weekStart);
        const endDate = new Date(weekEnd + 'T23:59:59');
        return items.filter((f: { createdAt?: string }) => {
            if (!f.createdAt) return false;
            const t = new Date(f.createdAt);
            return t >= startDate && t <= endDate;
        });
    } catch { return []; }
}

function loadExperimentsForWeek(weekStart: string, weekEnd: string): Array<{ hypothesis: string; status: string }> {
    if (!existsSync(EXPERIMENTS_PATH)) return [];
    try {
        const data = JSON.parse(readFileSync(EXPERIMENTS_PATH, 'utf-8'));
        const items = data.experiments || data || [];
        const startDate = new Date(weekStart);
        const endDate = new Date(weekEnd + 'T23:59:59');
        return items.filter((e: { createdAt?: string; updatedAt?: string }) => {
            const t = new Date(e.updatedAt || e.createdAt || '');
            return t >= startDate && t <= endDate;
        });
    } catch { return []; }
}

function loadCalendarForWeek(weekStart: string, weekEnd: string): Array<{ title: string; type: string; status: string; publishDate: string }> {
    if (!existsSync(CALENDAR_PATH)) return [];
    try {
        const data = JSON.parse(readFileSync(CALENDAR_PATH, 'utf-8'));
        const items = data.items || data || [];
        return items.filter((c: { publishDate?: string }) => {
            if (!c.publishDate) return false;
            return c.publishDate >= weekStart && c.publishDate <= weekEnd;
        });
    } catch { return []; }
}

function generateReport(weekOf?: string): WeeklyReport {
    const weekStart = weekOf || getWeekStart();
    const weekEnd = getWeekEnd(weekStart);

    const interactions = loadInteractionsForWeek(weekStart, weekEnd);
    const feedback = loadFeedbackForWeek(weekStart, weekEnd);
    const experiments = loadExperimentsForWeek(weekStart, weekEnd);
    const calendar = loadCalendarForWeek(weekStart, weekEnd);

    const byPlatform: Record<string, number> = {};
    for (const i of interactions) {
        byPlatform[i.platform] = (byPlatform[i.platform] || 0) + 1;
    }

    const published = calendar.filter(c => c.status === 'published');
    const activeExperiments = experiments.filter(e => e.status === 'active' || e.status === 'running');
    const completedExperiments = experiments.filter(e => e.status === 'completed');

    const report: WeeklyReport = {
        weekOf: weekStart,
        generatedAt: new Date().toISOString(),
        summary: `Week of ${weekStart}: ${published.length} content pieces published, ${interactions.length} community interactions, ${feedback.length} feedback items, ${activeExperiments.length + completedExperiments.length} experiments`,
        sections: {
            contentPublished: {
                count: published.length,
                target: 2,
                items: published.map(c => `${c.title} (${c.type})`),
            },
            communityInteractions: {
                count: interactions.length,
                target: 50,
                byPlatform,
            },
            growthExperiments: {
                active: activeExperiments.length,
                completed: completedExperiments.length,
                target: 1,
                items: experiments.map(e => `${e.hypothesis} [${e.status}]`),
            },
            productFeedback: {
                submitted: feedback.length,
                target: 3,
                items: feedback.map(f => `[${f.severity}/${f.category}] ${f.observation}`),
            },
            keyMetrics: {
                totalInteractions: interactions.length,
                contentPublished: published.length,
                feedbackSubmitted: feedback.length,
                experimentsActive: activeExperiments.length,
            },
            learnings: [],
        },
    };

    // Save report
    ensureReportsDir();
    const reportPath = join(REPORTS_DIR, `${weekStart}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    return report;
}

function formatReport(report: WeeklyReport): string {
    const s = report.sections;
    const lines: string[] = [
        `# Weekly Report — ${report.weekOf}`,
        '',
        `## Summary`,
        report.summary,
        '',
        `## Content Published (${s.contentPublished.count}/${s.contentPublished.target} target)`,
        ...(s.contentPublished.count === 0
            ? ['  No content published this week.']
            : s.contentPublished.items.map(i => `  - ${i}`)),
        s.contentPublished.count < s.contentPublished.target ? '  ⚠️ Below 2/week target' : '  ✅ On target',
        '',
        `## Community Interactions (${s.communityInteractions.count}/${s.communityInteractions.target} target)`,
        ...Object.entries(s.communityInteractions.byPlatform).map(([p, c]) => `  - ${p}: ${c}`),
        s.communityInteractions.count < s.communityInteractions.target ? '  ⚠️ Below 50/week target' : '  ✅ On target',
        '',
        `## Growth Experiments (${s.growthExperiments.active + s.growthExperiments.completed}/${s.growthExperiments.target} target)`,
        ...(s.growthExperiments.items.length === 0
            ? ['  No experiments this week.']
            : s.growthExperiments.items.map(i => `  - ${i}`)),
        (s.growthExperiments.active + s.growthExperiments.completed) < s.growthExperiments.target ? '  ⚠️ Below 1/week target' : '  ✅ On target',
        '',
        `## Product Feedback (${s.productFeedback.submitted}/${s.productFeedback.target} target)`,
        ...(s.productFeedback.items.length === 0
            ? ['  No feedback submitted this week.']
            : s.productFeedback.items.map(i => `  - ${i}`)),
        s.productFeedback.submitted < s.productFeedback.target ? '  ⚠️ Below 3/week target' : '  ✅ On target',
        '',
        `## Key Metrics`,
        ...Object.entries(s.keyMetrics).map(([k, v]) => `  - ${k}: ${v}`),
        '',
        `Generated: ${report.generatedAt}`,
    ];
    return lines.join('\n');
}

const SKILL_META = {
    name: 'weekly_report',
    description: 'Use this when the user says "generate my weekly report", "what did I accomplish this week", "summarize the week", "send the weekly update", or "how did we do this week". Aggregates content published, community interactions, experiments, and feedback into a structured report.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerWeeklyReportSkill(): void {
    // Tool 1: report_generate
    registerSkill(SKILL_META, {
        name: 'report_generate',
        description: 'Generate the weekly report. Use when asked "generate my weekly report", "what did I accomplish this week?", "summarize the week", "give me the weekly numbers", or "how did we do this week?". Pulls together content published, community interactions, growth experiments, and product feedback into a formatted markdown report.',
        parameters: {
            type: 'object',
            properties: {
                weekOf: {
                    type: 'string',
                    description: 'ISO date (YYYY-MM-DD) for the Monday of the target week (default: current week)',
                },
            },
            required: [],
        },
        execute: async (args) => {
            try {
                const report = generateReport(args.weekOf as string | undefined);
                return formatReport(report);
            } catch (e) {
                logger.error(COMPONENT, `Failed to generate report: ${(e as Error).message}`);
                return `Error generating report: ${(e as Error).message}`;
            }
        },
    });

    // Tool 2: report_deliver
    registerSkill(SKILL_META, {
        name: 'report_deliver',
        description: 'Post the weekly report to Slack. Use when asked to "send the weekly report", "post the weekly update to Slack", or "deliver the check-in". Generates the report first if it hasn\'t been generated yet, then posts it to the specified channel.',
        parameters: {
            type: 'object',
            properties: {
                weekOf: {
                    type: 'string',
                    description: 'ISO date (YYYY-MM-DD) for the Monday of the target week (default: current week)',
                },
                channel: {
                    type: 'string',
                    description: 'Slack channel to post to (default: configured default channel)',
                },
            },
            required: [],
        },
        execute: async (args) => {
            const weekStart = (args.weekOf as string) || getWeekStart();
            const reportPath = join(REPORTS_DIR, `${weekStart}.json`);

            let report: WeeklyReport;
            if (existsSync(reportPath)) {
                report = JSON.parse(readFileSync(reportPath, 'utf-8'));
            } else {
                report = generateReport(weekStart);
            }

            const formatted = formatReport(report);

            // Try to post via Slack skill's WebClient
            const token = process.env.SLACK_BOT_TOKEN;
            if (!token) {
                return `Report generated but cannot deliver: SLACK_BOT_TOKEN not set.\n\n${formatted}`;
            }

            const channel = (args.channel as string) || 'general';
            try {
                // @ts-expect-error optional peer dependency — install with: npm install @slack/web-api
                const { WebClient } = await import('@slack/web-api');
                const client = new WebClient(token);
                await client.chat.postMessage({ channel, text: formatted });
                return `Report delivered to #${channel}.\n\n${formatted}`;
            } catch (e) {
                return `Report generated but delivery failed: ${(e as Error).message}\n\n${formatted}`;
            }
        },
    });

    // Tool 3: report_history
    registerSkill(SKILL_META, {
        name: 'report_history',
        description: 'Show past weekly reports with key metrics. Use when asked "show me previous weekly reports", "how have we been trending?", or "compare this week to last week".',
        parameters: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Number of past reports to show (default: 4)',
                },
            },
            required: [],
        },
        execute: async (args) => {
            ensureReportsDir();
            const limit = (args.limit as number) || 4;

            const files = readdirSync(REPORTS_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .reverse()
                .slice(0, limit);

            if (files.length === 0) return 'No past reports found. Generate one with report_generate.';

            const lines: string[] = ['Past Weekly Reports:', ''];
            for (const file of files) {
                try {
                    const report: WeeklyReport = JSON.parse(readFileSync(join(REPORTS_DIR, file), 'utf-8'));
                    const s = report.sections;
                    lines.push(`[${report.weekOf}] Content: ${s.contentPublished.count}/${s.contentPublished.target} | Interactions: ${s.communityInteractions.count}/${s.communityInteractions.target} | Feedback: ${s.productFeedback.submitted}/${s.productFeedback.target} | Experiments: ${s.growthExperiments.active + s.growthExperiments.completed}/${s.growthExperiments.target}`);
                } catch {
                    lines.push(`[${file.replace('.json', '')}] Error reading report`);
                }
            }

            return lines.join('\n');
        },
    });
}
