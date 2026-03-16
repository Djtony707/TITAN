/**
 * TITAN — Freelance Monitor Skill (Built-in)
 * Search freelance platforms, match jobs to profile, draft proposals, track leads.
 * Thin wrapper around existing web_search + web_read tools.
 * No API keys needed — uses DuckDuckGo + web scraping.
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { FREELANCE_LEADS_PATH, FREELANCE_PROFILE_PATH } from '../../utils/constants.js';

interface FreelanceLead {
    id: string;
    timestamp: string;
    platform: string;
    title: string;
    url: string;
    budget: string;
    skills: string[];
    matchScore: number;
    status: 'new' | 'reviewing' | 'applied' | 'rejected' | 'won' | 'lost';
    notes: string;
}

interface FreelanceProfile {
    name: string;
    title: string;
    skills: string[];
    hourlyRate: number;
    bio: string;
    experience: string[];
    portfolio: string[];
}

function ensureDir(path: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function readLeads(): FreelanceLead[] {
    if (!existsSync(FREELANCE_LEADS_PATH)) return [];
    const content = readFileSync(FREELANCE_LEADS_PATH, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line) as FreelanceLead);
}

function appendLead(lead: FreelanceLead): void {
    ensureDir(FREELANCE_LEADS_PATH);
    appendFileSync(FREELANCE_LEADS_PATH, JSON.stringify(lead) + '\n', 'utf-8');
}

function readProfile(): FreelanceProfile | null {
    if (!existsSync(FREELANCE_PROFILE_PATH)) return null;
    try {
        return JSON.parse(readFileSync(FREELANCE_PROFILE_PATH, 'utf-8')) as FreelanceProfile;
    } catch {
        return null;
    }
}

export function registerFreelanceMonitorSkill(): void {
    // Tool 1: freelance_search
    registerSkill(
        {
            name: 'freelance_monitor',
            description: 'Use this skill when Tony says "check my freelance projects", "any new jobs on Upwork?", "monitor freelance platforms", "find freelance work for X skills", "draft a proposal for this job", or "track this freelance lead". Searches Upwork, Fiverr, and Toptal for matching jobs, scores them against Tony\'s profile, and manages the lead pipeline.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'freelance_search',
            description: 'Search Upwork, Fiverr, and Toptal for job listings matching keywords. Use when Tony says "find freelance jobs for X", "any new jobs on Upwork?", "search for [skill] gigs", or "what\'s available on freelance platforms?".',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search keywords (e.g., "node.js api development")',
                    },
                    platform: {
                        type: 'string',
                        description: 'Platform to search: "upwork", "fiverr", "toptal", or "all" (default: "all")',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum results per platform (default: 5)',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                try {
                    const query = args.query as string;
                    const platform = (args.platform as string) || 'all';
                    const maxResults = Math.min((args.maxResults as number) || 5, 10);

                    const platforms: Record<string, string> = {
                        upwork: 'site:upwork.com/freelance-jobs',
                        fiverr: 'site:fiverr.com/categories',
                        toptal: 'site:toptal.com/projects',
                    };

                    const searchPlatforms = platform === 'all'
                        ? Object.entries(platforms)
                        : [[platform, platforms[platform] || `site:${platform}.com`]];

                    const allResults: string[] = [];

                    for (const [name, siteFilter] of searchPlatforms) {
                        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${siteFilter} ${query}`)}`;
                        const response = await fetch(searchUrl, {
                            headers: { 'User-Agent': 'TITAN/1.0 (Autonomous AI Agent)' },
                        });

                        if (!response.ok) {
                            allResults.push(`${name}: Search failed (${response.status})`);
                            continue;
                        }

                        const html = await response.text();
                        const results: Array<{ title: string; url: string; snippet: string }> = [];
                        const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;
                        let match;

                        while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
                            const rawUrl = match[1];
                            const title = match[2].replace(/<[^>]*>/g, '').trim();
                            const snippet = match[3].replace(/<[^>]*>/g, '').trim();

                            const urlMatch = rawUrl.match(/uddg=([^&]*)/);
                            const decodedUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : rawUrl;

                            if (title && decodedUrl) {
                                results.push({ title, url: decodedUrl, snippet });
                            }
                        }

                        if (results.length > 0) {
                            allResults.push(`\n${name.toUpperCase()} (${results.length} results):`);
                            for (const [i, r] of results.entries()) {
                                allResults.push(`  ${i + 1}. ${r.title}\n     ${r.url}\n     ${r.snippet}`);
                            }
                        } else {
                            allResults.push(`${name}: No results found`);
                        }
                    }

                    return allResults.join('\n');
                } catch (e) {
                    return `Error searching freelance platforms: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: freelance_match
    registerSkill(
        {
            name: 'freelance_monitor',
            description: 'Use this skill when Tony says "check my freelance projects", "any new jobs on Upwork?", "monitor freelance platforms", "find freelance work for X skills", "draft a proposal for this job", or "track this freelance lead". Searches Upwork, Fiverr, and Toptal for matching jobs, scores them against Tony\'s profile, and manages the lead pipeline.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'freelance_match',
            description: 'Score a job listing against Tony\'s stored freelance profile to determine fit. Use when Tony says "is this job a good match for me?", "how well do I fit this listing?", or "should I apply to this job?".',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Job title',
                    },
                    description: {
                        type: 'string',
                        description: 'Job description text',
                    },
                    requiredSkills: {
                        type: 'string',
                        description: 'Comma-separated required skills',
                    },
                    budget: {
                        type: 'string',
                        description: 'Budget range or hourly rate',
                    },
                },
                required: ['title', 'description'],
            },
            execute: async (args) => {
                try {
                    const title = args.title as string;
                    const description = args.description as string;
                    const requiredSkills = ((args.requiredSkills as string) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                    const budget = (args.budget as string) || 'not specified';

                    const profile = readProfile();
                    if (!profile) {
                        return `No freelance profile found. Create one at ${FREELANCE_PROFILE_PATH} with fields: name, title, skills (array), hourlyRate, bio, experience (array), portfolio (array).`;
                    }

                    const profileSkills = profile.skills.map(s => s.toLowerCase());
                    const jobText = `${title} ${description}`.toLowerCase();

                    // Score based on skill overlap
                    let skillScore = 0;
                    const matchedSkills: string[] = [];
                    const missingSkills: string[] = [];

                    const skillsToCheck = requiredSkills.length > 0 ? requiredSkills : profileSkills;
                    for (const skill of skillsToCheck) {
                        if (profileSkills.includes(skill) || jobText.includes(skill)) {
                            matchedSkills.push(skill);
                            skillScore++;
                        } else if (requiredSkills.includes(skill)) {
                            missingSkills.push(skill);
                        }
                    }

                    const maxSkills = Math.max(skillsToCheck.length, 1);
                    const normalizedScore = Math.min(10, Math.round((skillScore / maxSkills) * 10));

                    const lines: string[] = [];
                    lines.push(`Match Score: ${normalizedScore}/10`);
                    lines.push(`Job: ${title}`);
                    lines.push(`Budget: ${budget}`);
                    lines.push(`Matched Skills: ${matchedSkills.join(', ') || 'none'}`);
                    if (missingSkills.length > 0) {
                        lines.push(`Missing Skills: ${missingSkills.join(', ')}`);
                    }
                    lines.push('');
                    if (normalizedScore >= 7) {
                        lines.push('Recommendation: Strong match — consider applying.');
                    } else if (normalizedScore >= 4) {
                        lines.push('Recommendation: Partial match — review carefully.');
                    } else {
                        lines.push('Recommendation: Weak match — likely not worth pursuing.');
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error matching job: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: freelance_draft
    registerSkill(
        {
            name: 'freelance_monitor',
            description: 'Use this skill when Tony says "check my freelance projects", "any new jobs on Upwork?", "monitor freelance platforms", "find freelance work for X skills", "draft a proposal for this job", or "track this freelance lead". Searches Upwork, Fiverr, and Toptal for matching jobs, scores them against Tony\'s profile, and manages the lead pipeline.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'freelance_draft',
            description: 'Generate a proposal outline for a freelance job listing. Use when Tony says "draft a proposal for this job", "help me write a pitch for X", or "create a proposal outline for [job title]". Pulls from Tony\'s stored profile to personalize the structure.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Job title',
                    },
                    description: {
                        type: 'string',
                        description: 'Job description',
                    },
                    keyPoints: {
                        type: 'string',
                        description: 'Key points to address (comma-separated)',
                    },
                },
                required: ['title'],
            },
            execute: async (args) => {
                try {
                    const title = args.title as string;
                    const description = (args.description as string) || '';
                    const keyPoints = ((args.keyPoints as string) || '').split(',').map(s => s.trim()).filter(Boolean);

                    const profile = readProfile();

                    const lines: string[] = [];
                    lines.push(`PROPOSAL OUTLINE for: ${title}`);
                    lines.push('='.repeat(50));
                    lines.push('');
                    lines.push('1. OPENING HOOK');
                    lines.push('   - Reference specific problem from job description');
                    lines.push('   - Show you understand their needs');
                    lines.push('');
                    lines.push('2. RELEVANT EXPERIENCE');
                    if (profile) {
                        lines.push(`   - Title: ${profile.title}`);
                        lines.push(`   - Key skills: ${profile.skills.slice(0, 5).join(', ')}`);
                        if (profile.experience.length > 0) {
                            lines.push(`   - Experience: ${profile.experience[0]}`);
                        }
                    } else {
                        lines.push('   - [Add relevant experience]');
                    }
                    lines.push('');
                    lines.push('3. PROPOSED APPROACH');
                    if (keyPoints.length > 0) {
                        for (const point of keyPoints) {
                            lines.push(`   - ${point}`);
                        }
                    } else {
                        lines.push('   - [Outline your approach to the project]');
                    }
                    lines.push('');
                    lines.push('4. TIMELINE & DELIVERABLES');
                    lines.push('   - [Estimated timeline]');
                    lines.push('   - [Key milestones]');
                    lines.push('');
                    lines.push('5. PRICING');
                    if (profile) {
                        lines.push(`   - Hourly rate: $${profile.hourlyRate}/hr`);
                    }
                    lines.push('   - [Fixed price or hourly estimate]');
                    lines.push('');
                    lines.push('6. CALL TO ACTION');
                    lines.push('   - Offer a free consultation or quick call');
                    lines.push('');

                    if (description) {
                        lines.push('JOB CONTEXT:');
                        lines.push(description.substring(0, 500));
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error drafting proposal: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 4: freelance_track
    registerSkill(
        {
            name: 'freelance_monitor',
            description: 'Use this skill when Tony says "check my freelance projects", "any new jobs on Upwork?", "monitor freelance platforms", "find freelance work for X skills", "draft a proposal for this job", or "track this freelance lead". Searches Upwork, Fiverr, and Toptal for matching jobs, scores them against Tony\'s profile, and manages the lead pipeline.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'freelance_track',
            description: 'Track freelance leads — save new opportunities, update their status, or view the pipeline. Use when Tony says "track this freelance lead", "I applied to that job", "mark that lead as won/lost", or "show me my freelance pipeline".',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: '"add" to save a new lead, "update" to change status, "list" to view leads (default: "list")',
                    },
                    platform: {
                        type: 'string',
                        description: 'Platform name (e.g., "upwork", "fiverr")',
                    },
                    title: {
                        type: 'string',
                        description: 'Job title',
                    },
                    url: {
                        type: 'string',
                        description: 'URL of the job listing',
                    },
                    budget: {
                        type: 'string',
                        description: 'Budget or rate',
                    },
                    skills: {
                        type: 'string',
                        description: 'Comma-separated skills',
                    },
                    matchScore: {
                        type: 'number',
                        description: 'Match score 1-10',
                    },
                    status: {
                        type: 'string',
                        description: 'Lead status: new, reviewing, applied, rejected, won, lost',
                    },
                    id: {
                        type: 'string',
                        description: 'Lead ID (for update action)',
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
                        const lead: FreelanceLead = {
                            id: `lead-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            timestamp: new Date().toISOString(),
                            platform: (args.platform as string) || 'unknown',
                            title: (args.title as string) || 'Untitled',
                            url: (args.url as string) || '',
                            budget: (args.budget as string) || 'not specified',
                            skills: ((args.skills as string) || '').split(',').map(s => s.trim()).filter(Boolean),
                            matchScore: (args.matchScore as number) || 0,
                            status: 'new',
                            notes: (args.notes as string) || '',
                        };

                        appendLead(lead);
                        return `Lead saved: "${lead.title}" on ${lead.platform} (ID: ${lead.id})`;
                    }

                    if (action === 'update') {
                        const id = args.id as string;
                        const newStatus = args.status as FreelanceLead['status'];
                        if (!id) return 'Error: id is required for update';

                        const leads = readLeads();
                        const lead = leads.find(l => l.id === id);
                        if (!lead) return `Lead not found: ${id}`;

                        if (newStatus) lead.status = newStatus;
                        if (args.notes) lead.notes = args.notes as string;

                        // Rewrite the file
                        ensureDir(FREELANCE_LEADS_PATH);
                        const updated = leads.map(l => l.id === id ? lead : l);
                        writeFileSync(FREELANCE_LEADS_PATH, updated.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

                        return `Lead updated: "${lead.title}" → status: ${lead.status}`;
                    }

                    // List leads
                    const leads = readLeads();
                    if (leads.length === 0) {
                        return 'No leads tracked yet. Use freelance_track with action="add" to save a lead.';
                    }

                    const limit = Math.min((args.limit as number) || 20, 50);
                    const statusFilter = args.status as string | undefined;
                    let filtered = leads;
                    if (statusFilter) {
                        filtered = leads.filter(l => l.status === statusFilter);
                    }

                    const recent = filtered.slice(-limit).reverse();
                    const lines = recent.map(l => {
                        const date = new Date(l.timestamp).toLocaleDateString();
                        return `[${l.status.toUpperCase()}] ${l.title} | ${l.platform} | Score: ${l.matchScore}/10 | ${l.budget} | ${date}\n  ID: ${l.id}${l.url ? `\n  ${l.url}` : ''}`;
                    });

                    // Summary
                    const statusCounts: Record<string, number> = {};
                    for (const l of leads) {
                        statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
                    }
                    const summary = Object.entries(statusCounts).map(([s, c]) => `${s}: ${c}`).join(', ');

                    return `Freelance Leads (${filtered.length} total — ${summary}):\n\n${lines.join('\n\n')}`;
                } catch (e) {
                    return `Error tracking leads: ${(e as Error).message}`;
                }
            },
        },
    );
}
