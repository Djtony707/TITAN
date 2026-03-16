/**
 * TITAN — Lead Scorer Skill (Built-in)
 * Reddit/forum monitoring with intent signal detection and lead scoring.
 * No API keys needed — uses DuckDuckGo for discovery.
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { LEADS_PATH } from '../../utils/constants.js';

interface Lead {
    id: string;
    timestamp: string;
    platform: string;
    title: string;
    url: string;
    snippet: string;
    score: number;
    signals: string[];
    status: 'new' | 'contacted' | 'qualified' | 'converted' | 'dismissed';
    notes: string;
}

function ensureDir(path: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function readLeads(): Lead[] {
    if (!existsSync(LEADS_PATH)) return [];
    const content = readFileSync(LEADS_PATH, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line) as Lead);
}

function appendLead(lead: Lead): void {
    ensureDir(LEADS_PATH);
    appendFileSync(LEADS_PATH, JSON.stringify(lead) + '\n', 'utf-8');
}

const INTENT_SIGNALS = [
    'looking for',
    'need help with',
    'anyone know',
    'recommend',
    'suggestion',
    'alternative to',
    'how do i',
    'best way to',
    'struggling with',
    'hiring',
    'need someone',
    'budget',
    'willing to pay',
    'freelancer',
    'contractor',
    'agency',
];

function detectSignals(text: string): string[] {
    const lower = text.toLowerCase();
    return INTENT_SIGNALS.filter(signal => lower.includes(signal));
}

function scoreLead(title: string, snippet: string, recencyDays: number): { score: number; signals: string[] } {
    const fullText = `${title} ${snippet}`;
    const signals = detectSignals(fullText);

    let score = 0;

    // Intent signal score (up to 4 points)
    score += Math.min(signals.length * 2, 4);

    // Recency score (up to 3 points)
    if (recencyDays <= 1) score += 3;
    else if (recencyDays <= 3) score += 2;
    else if (recencyDays <= 7) score += 1;

    // Engagement indicators (up to 3 points)
    const lower = fullText.toLowerCase();
    if (lower.includes('budget') || lower.includes('pay') || lower.includes('$')) score += 2;
    if (lower.includes('urgent') || lower.includes('asap') || lower.includes('immediately')) score += 1;

    return { score: Math.min(score, 10), signals };
}

export function registerLeadScorerSkill(): void {
    // Tool 1: lead_scan
    registerSkill(
        {
            name: 'lead_scorer',
            description: 'Use this skill when Tony says "score this lead", "rank these prospects", "which leads are hottest?", "scan Reddit for leads", "find people looking for [service]", or "show me my lead pipeline". Monitors Reddit and HackerNews for buying intent signals, scores leads 1-10, and manages the lead queue.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'lead_scan',
            description: 'Scan Reddit and HackerNews for posts with buying intent signals like "looking for", "need help with", "hiring", or "willing to pay". Use when Tony says "scan for leads", "find people who need [service]", or "what\'s on Reddit about [topic]?". Returns results scored by intent strength.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query related to your service (e.g., "automation bot developer")',
                    },
                    platform: {
                        type: 'string',
                        description: 'Platform to scan: "reddit", "hackernews", "all" (default: "all")',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum results (default: 10)',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                try {
                    const query = args.query as string;
                    const platform = (args.platform as string) || 'all';
                    const maxResults = Math.min((args.maxResults as number) || 10, 20);

                    const platformQueries: Record<string, string> = {
                        reddit: `site:reddit.com "${query}" ("looking for" OR "need help" OR "recommend" OR "hiring")`,
                        hackernews: `site:news.ycombinator.com "${query}" ("looking for" OR "need" OR "hiring")`,
                    };

                    const searchPlatforms = platform === 'all'
                        ? Object.entries(platformQueries)
                        : [[platform, platformQueries[platform] || `site:${platform}.com "${query}"`]];

                    const allResults: Array<{ platform: string; title: string; url: string; snippet: string; score: number; signals: string[] }> = [];

                    for (const [name, searchQuery] of searchPlatforms) {
                        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
                        const response = await fetch(url, {
                            headers: { 'User-Agent': 'TITAN/1.0 (Autonomous AI Agent)' },
                        });

                        if (!response.ok) continue;

                        const html = await response.text();
                        const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;
                        let match;

                        while ((match = resultRegex.exec(html)) !== null && allResults.length < maxResults) {
                            const rawUrl = match[1];
                            const title = match[2].replace(/<[^>]*>/g, '').trim();
                            const snippet = match[3].replace(/<[^>]*>/g, '').trim();
                            const urlMatch = rawUrl.match(/uddg=([^&]*)/);
                            const decodedUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : rawUrl;

                            if (title && decodedUrl) {
                                const { score, signals } = scoreLead(title, snippet, 3); // Assume ~3 days for search results
                                allResults.push({ platform: name, title, url: decodedUrl, snippet, score, signals });
                            }
                        }
                    }

                    // Sort by score descending
                    allResults.sort((a, b) => b.score - a.score);

                    if (allResults.length === 0) {
                        return `No leads found for "${query}". Try broadening your search.`;
                    }

                    const lines: string[] = [];
                    lines.push(`Lead Scan Results: ${allResults.length} leads found`);
                    lines.push('='.repeat(50));
                    lines.push('');

                    for (const [i, r] of allResults.entries()) {
                        lines.push(`${i + 1}. [Score: ${r.score}/10] ${r.title}`);
                        lines.push(`   Platform: ${r.platform}`);
                        lines.push(`   URL: ${r.url}`);
                        lines.push(`   Signals: ${r.signals.length > 0 ? r.signals.join(', ') : 'none detected'}`);
                        lines.push(`   ${r.snippet}`);
                        lines.push('');
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Scan error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: lead_score
    registerSkill(
        {
            name: 'lead_scorer',
            description: 'Use this skill when Tony says "score this lead", "rank these prospects", "which leads are hottest?", "scan Reddit for leads", "find people looking for [service]", or "show me my lead pipeline". Monitors Reddit and HackerNews for buying intent signals, scores leads 1-10, and manages the lead queue.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'lead_score',
            description: 'Score a specific lead 1-10 based on intent signals, recency, and engagement indicators. Use when Tony says "score this lead", "how good is this prospect?", or "rate this post as a lead". Returns priority level (HIGH/MEDIUM/LOW) with reasoning.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Post/listing title',
                    },
                    content: {
                        type: 'string',
                        description: 'Post content or description',
                    },
                    daysOld: {
                        type: 'number',
                        description: 'How many days old the post is (default: 1)',
                    },
                },
                required: ['title', 'content'],
            },
            execute: async (args) => {
                try {
                    const title = args.title as string;
                    const content = args.content as string;
                    const daysOld = (args.daysOld as number) || 1;

                    const { score, signals } = scoreLead(title, content, daysOld);

                    const lines: string[] = [];
                    lines.push(`Lead Score: ${score}/10`);
                    lines.push('');
                    lines.push(`Title: ${title}`);
                    lines.push(`Age: ${daysOld} day(s)`);
                    lines.push(`Intent Signals: ${signals.length > 0 ? signals.join(', ') : 'none detected'}`);
                    lines.push('');

                    if (score >= 7) {
                        lines.push('Priority: HIGH — Strong buying intent detected. Act quickly.');
                    } else if (score >= 4) {
                        lines.push('Priority: MEDIUM — Some intent signals. Worth investigating.');
                    } else {
                        lines.push('Priority: LOW — Weak signals. Monitor but don\'t prioritize.');
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Score error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: lead_queue
    registerSkill(
        {
            name: 'lead_scorer',
            description: 'Use this skill when Tony says "score this lead", "rank these prospects", "which leads are hottest?", "scan Reddit for leads", "find people looking for [service]", or "show me my lead pipeline". Monitors Reddit and HackerNews for buying intent signals, scores leads 1-10, and manages the lead queue.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'lead_queue',
            description: 'Save, update, and manage leads in the lead queue. Use when Tony says "add this lead", "I contacted that prospect", "mark lead as qualified/converted", "show me my hottest leads", or "what\'s in my lead pipeline?".',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: '"add" to save a lead, "update" to change status, "list" to view queue (default: "list")',
                    },
                    platform: {
                        type: 'string',
                        description: 'Source platform',
                    },
                    title: {
                        type: 'string',
                        description: 'Lead title/subject',
                    },
                    url: {
                        type: 'string',
                        description: 'URL of the lead',
                    },
                    snippet: {
                        type: 'string',
                        description: 'Relevant text snippet',
                    },
                    score: {
                        type: 'number',
                        description: 'Lead score 1-10',
                    },
                    id: {
                        type: 'string',
                        description: 'Lead ID (for update action)',
                    },
                    status: {
                        type: 'string',
                        description: 'Lead status: new, contacted, qualified, converted, dismissed',
                    },
                    notes: {
                        type: 'string',
                        description: 'Additional notes',
                    },
                    limit: {
                        type: 'number',
                        description: 'Number of leads to show (default: 20)',
                    },
                },
            },
            execute: async (args) => {
                try {
                    const action = (args.action as string) || 'list';

                    if (action === 'add') {
                        const lead: Lead = {
                            id: `lead-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            timestamp: new Date().toISOString(),
                            platform: (args.platform as string) || 'unknown',
                            title: (args.title as string) || 'Untitled',
                            url: (args.url as string) || '',
                            snippet: (args.snippet as string) || '',
                            score: (args.score as number) || 0,
                            signals: detectSignals(`${args.title || ''} ${args.snippet || ''}`),
                            status: 'new',
                            notes: (args.notes as string) || '',
                        };

                        appendLead(lead);
                        return `Lead saved: "${lead.title}" (Score: ${lead.score}/10, ID: ${lead.id})`;
                    }

                    if (action === 'update') {
                        const id = args.id as string;
                        if (!id) return 'Error: id is required for update';

                        const leads = readLeads();
                        const lead = leads.find(l => l.id === id);
                        if (!lead) return `Lead not found: ${id}`;

                        if (args.status) lead.status = args.status as Lead['status'];
                        if (args.notes) lead.notes = args.notes as string;
                        if (args.score) lead.score = args.score as number;

                        ensureDir(LEADS_PATH);
                        const updated = leads.map(l => l.id === id ? lead : l);
                        writeFileSync(LEADS_PATH, updated.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

                        return `Lead updated: "${lead.title}" -> ${lead.status}`;
                    }

                    // List leads
                    const leads = readLeads();
                    if (leads.length === 0) {
                        return 'No leads in queue. Use lead_scan to find leads, then lead_queue with action="add" to save them.';
                    }

                    const limit = Math.min((args.limit as number) || 20, 50);
                    const statusFilter = args.status as string | undefined;
                    let filtered = leads;
                    if (statusFilter) {
                        filtered = leads.filter(l => l.status === statusFilter);
                    }

                    // Sort by score descending
                    filtered.sort((a, b) => b.score - a.score);
                    const display = filtered.slice(0, limit);

                    const lines = display.map(l => {
                        const date = new Date(l.timestamp).toLocaleDateString();
                        return `[${l.status.toUpperCase()}] Score: ${l.score}/10 | ${l.title}\n  ${l.platform} | ${date}\n  ID: ${l.id}${l.url ? `\n  ${l.url}` : ''}${l.notes ? `\n  Notes: ${l.notes}` : ''}`;
                    });

                    // Summary
                    const statusCounts: Record<string, number> = {};
                    for (const l of leads) {
                        statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
                    }
                    const summary = Object.entries(statusCounts).map(([s, c]) => `${s}: ${c}`).join(', ');

                    return `Lead Queue (${filtered.length} leads — ${summary}):\n\n${lines.join('\n\n')}`;
                } catch (e) {
                    return `Queue error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 4: lead_report
    registerSkill(
        {
            name: 'lead_scorer',
            description: 'Use this skill when Tony says "score this lead", "rank these prospects", "which leads are hottest?", "scan Reddit for leads", "find people looking for [service]", or "show me my lead pipeline". Monitors Reddit and HackerNews for buying intent signals, scores leads 1-10, and manages the lead queue.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'lead_report',
            description: 'Generate a lead summary report for a given period. Use when Tony asks "give me a lead report", "how many leads this week?", "what\'s my lead conversion rate?", or "daily lead digest".',
            parameters: {
                type: 'object',
                properties: {
                    period: {
                        type: 'string',
                        description: 'Report period: "day", "week", "month", "all" (default: "week")',
                    },
                },
            },
            execute: async (args) => {
                try {
                    const period = (args.period as string) || 'week';
                    const leads = readLeads();

                    if (leads.length === 0) {
                        return 'No leads to report on.';
                    }

                    const now = new Date();
                    let cutoff: Date;
                    switch (period) {
                        case 'day':
                            cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                            break;
                        case 'week':
                            cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                            break;
                        case 'month':
                            cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                            break;
                        case 'all':
                            cutoff = new Date(0);
                            break;
                        default:
                            cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    }

                    const filtered = leads.filter(l => new Date(l.timestamp) >= cutoff);

                    const statusCounts: Record<string, number> = {};
                    const platformCounts: Record<string, number> = {};
                    let totalScore = 0;
                    const highPriority: Lead[] = [];

                    for (const l of filtered) {
                        statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
                        platformCounts[l.platform] = (platformCounts[l.platform] || 0) + 1;
                        totalScore += l.score;
                        if (l.score >= 7 && l.status === 'new') {
                            highPriority.push(l);
                        }
                    }

                    const avgScore = filtered.length > 0 ? (totalScore / filtered.length).toFixed(1) : '0';

                    const lines: string[] = [];
                    lines.push(`Lead Report (${period})`);
                    lines.push('='.repeat(40));
                    lines.push('');
                    lines.push(`Total Leads: ${filtered.length}`);
                    lines.push(`Average Score: ${avgScore}/10`);
                    lines.push(`High Priority (new, score >= 7): ${highPriority.length}`);
                    lines.push('');

                    lines.push('By Status:');
                    for (const [status, count] of Object.entries(statusCounts)) {
                        lines.push(`  ${status}: ${count}`);
                    }
                    lines.push('');

                    lines.push('By Platform:');
                    for (const [platform, count] of Object.entries(platformCounts)) {
                        lines.push(`  ${platform}: ${count}`);
                    }

                    if (highPriority.length > 0) {
                        lines.push('');
                        lines.push('High Priority Leads (action needed):');
                        for (const l of highPriority.slice(0, 5)) {
                            lines.push(`  - [${l.score}/10] ${l.title} (${l.platform})`);
                            if (l.url) lines.push(`    ${l.url}`);
                        }
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Report error: ${(e as Error).message}`;
                }
            },
        },
    );
}
