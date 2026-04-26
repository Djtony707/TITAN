/**
 * TITAN — Content Publisher Skill (Built-in)
 * Orchestrates SEO content pipeline: research, outline, publish to GitHub, schedule.
 * Uses existing web_search and github tools under the hood.
 */
import { registerSkill } from '../registry.js';

export function registerContentPublisherSkill(): void {
    // Tool 1: content_research
    registerSkill(
        {
            name: 'content_publisher',
            description: 'Use this skill when Tony says "publish this post", "schedule this tweet/post", "post to social media", "write and publish content about X", or "set up automated content publishing". Handles the full SEO content pipeline: research topics, create outlines, publish to GitHub, and schedule recurring content. ALWAYS show Tony exactly what will be posted/published and wait for explicit approval before executing. Never publish without confirmation.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'content_research',
            description: 'Research trending topics for content creation. Use when Tony asks "what should I write about?", "what\'s trending in X?", or "find content ideas for my niche". Uses web search to find trending subjects, competitor articles, and keyword opportunities.',
            parameters: {
                type: 'object',
                properties: {
                    niche: {
                        type: 'string',
                        description: 'Content niche or topic area (e.g., "AI agents", "SaaS automation")',
                    },
                    type: {
                        type: 'string',
                        description: 'Research type: "trends", "competitors", "keywords", "gaps" (default: "trends")',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum results (default: 10)',
                    },
                },
                required: ['niche'],
            },
            execute: async (args) => {
                try {
                    const niche = args.niche as string;
                    const type = (args.type as string) || 'trends';
                    const maxResults = Math.min((args.maxResults as number) || 10, 20);

                    const queries: Record<string, string> = {
                        trends: `${niche} trends 2026`,
                        competitors: `best ${niche} articles blog posts`,
                        keywords: `${niche} "how to" OR "guide" OR "tutorial"`,
                        gaps: `${niche} questions unanswered reddit OR forum`,
                    };

                    const searchQuery = queries[type] || queries.trends;
                    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
                    const response = await fetch(url, {
                        headers: { 'User-Agent': 'TITAN/1.0 (Autonomous AI Agent)' },
                    });

                    if (!response.ok) {
                        return `Research failed: HTTP ${response.status}`;
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

                    if (results.length === 0) {
                        return `No research results found for "${niche}" (${type})`;
                    }

                    const lines: string[] = [];
                    lines.push(`Content Research: ${niche} (${type})`);
                    lines.push('='.repeat(50));
                    lines.push('');

                    for (const [i, r] of results.entries()) {
                        lines.push(`${i + 1}. ${r.title}`);
                        lines.push(`   ${r.url}`);
                        lines.push(`   ${r.snippet}`);
                        lines.push('');
                    }

                    lines.push('Suggested article angles:');
                    for (const r of results.slice(0, 3)) {
                        lines.push(`  - "Why ${r.title.split(' ').slice(0, 6).join(' ')}..." (expand on this topic)`);
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Research error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: content_outline
    registerSkill(
        {
            name: 'content_publisher',
            description: 'Use this skill when Tony says "publish this post", "schedule this tweet/post", "post to social media", "write and publish content about X", or "set up automated content publishing". Handles the full SEO content pipeline: research topics, create outlines, publish to GitHub, and schedule recurring content. ALWAYS show Tony exactly what will be posted/published and wait for explicit approval before executing. Never publish without confirmation.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'content_outline',
            description: 'Generate a structured article outline from a topic and research notes. Use when Tony says "outline an article about X", "give me a structure for a post on X", or after content_research to turn findings into a ready-to-write plan.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Article title',
                    },
                    topic: {
                        type: 'string',
                        description: 'Topic or subject area',
                    },
                    targetLength: {
                        type: 'string',
                        description: 'Target length: "short" (500w), "medium" (1000w), "long" (2000w) (default: "medium")',
                    },
                    keywords: {
                        type: 'string',
                        description: 'Comma-separated SEO keywords to include',
                    },
                    notes: {
                        type: 'string',
                        description: 'Research notes or key points to cover',
                    },
                },
                required: ['title', 'topic'],
            },
            execute: async (args) => {
                try {
                    const title = args.title as string;
                    const topic = args.topic as string;
                    const targetLength = (args.targetLength as string) || 'medium';
                    const keywords = ((args.keywords as string) || '').split(',').map(s => s.trim()).filter(Boolean);
                    const notes = (args.notes as string) || '';

                    const sectionCounts: Record<string, number> = {
                        short: 3,
                        medium: 5,
                        long: 8,
                    };
                    const numSections = sectionCounts[targetLength] || 5;

                    const lines: string[] = [];
                    lines.push(`# ${title}`);
                    lines.push('');
                    lines.push(`**Topic:** ${topic}`);
                    lines.push(`**Target Length:** ${targetLength}`);
                    if (keywords.length > 0) {
                        lines.push(`**Keywords:** ${keywords.join(', ')}`);
                    }
                    lines.push('');
                    lines.push('---');
                    lines.push('');
                    lines.push('## Introduction');
                    lines.push('- Hook: Open with a compelling statistic or question');
                    lines.push(`- Context: Why ${topic} matters now`);
                    lines.push('- Thesis: What the reader will learn');
                    lines.push('');

                    for (let i = 1; i <= numSections; i++) {
                        lines.push(`## Section ${i}: [Subheading]`);
                        lines.push('- Key point');
                        lines.push('- Supporting evidence or example');
                        if (i <= keywords.length) {
                            lines.push(`- Include keyword: "${keywords[i - 1]}"`);
                        }
                        lines.push('');
                    }

                    lines.push('## Conclusion');
                    lines.push('- Summarize key takeaways');
                    lines.push('- Call to action');
                    lines.push('');

                    if (notes) {
                        lines.push('---');
                        lines.push('## Research Notes');
                        lines.push(notes);
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Outline error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: content_publish
    registerSkill(
        {
            name: 'content_publisher',
            description: 'Use this skill when Tony says "publish this post", "schedule this tweet/post", "post to social media", "write and publish content about X", or "set up automated content publishing". Handles the full SEO content pipeline: research topics, create outlines, publish to GitHub, and schedule recurring content. ALWAYS show Tony exactly what will be posted/published and wait for explicit approval before executing. Never publish without confirmation.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'content_publish',
            description: 'Publish a completed markdown article to a GitHub repository (GitHub Pages, Hugo, Jekyll). Use when Tony says "publish this article", "push this post to my site", or "commit this to my blog repo". ALWAYS show Tony the full content and target path and wait for explicit confirmation before committing. Never publish without approval.',
            parameters: {
                type: 'object',
                properties: {
                    repo: {
                        type: 'string',
                        description: 'GitHub repo in "owner/repo" format',
                    },
                    title: {
                        type: 'string',
                        description: 'Article title (used in filename and frontmatter)',
                    },
                    content: {
                        type: 'string',
                        description: 'Full markdown content of the article',
                    },
                    path: {
                        type: 'string',
                        description: 'File path within repo (default: "_posts/YYYY-MM-DD-slug.md")',
                    },
                    branch: {
                        type: 'string',
                        description: 'Branch to commit to (default: "main")',
                    },
                    commitMessage: {
                        type: 'string',
                        description: 'Commit message (default: "Publish: {title}")',
                    },
                },
                required: ['repo', 'title', 'content'],
            },
            execute: async (args) => {
                try {
                    const repo = args.repo as string;
                    const title = args.title as string;
                    const content = args.content as string;
                    const branch = (args.branch as string) || 'main';
                    const commitMessage = (args.commitMessage as string) || `Publish: ${title}`;

                    // Generate Jekyll-compatible filename
                    const now = new Date();
                    const dateStr = now.toISOString().split('T')[0];
                    const slug = title
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '');
                    const defaultPath = `_posts/${dateStr}-${slug}.md`;
                    const filePath = (args.path as string) || defaultPath;

                    // Build Jekyll frontmatter
                    const frontmatter = [
                        '---',
                        `title: "${title}"`,
                        `date: ${now.toISOString()}`,
                        `layout: post`,
                        '---',
                        '',
                    ].join('\n');

                    const fullContent = frontmatter + content;
                    const base64Content = Buffer.from(fullContent).toString('base64');

                    // Use GitHub API to create/update file
                    const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
                    if (!ghToken) {
                        return 'Error: GITHUB_TOKEN or GH_TOKEN environment variable is required for publishing.';
                    }

                    // Check if file exists (for update)
                    let sha: string | undefined;
                    try {
                        const checkResponse = await fetch(
                            `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`,
                            { headers: { Authorization: `Bearer ${ghToken}`, 'User-Agent': 'TITAN' } },
                        );
                        if (checkResponse.ok) {
                            const existing = await checkResponse.json() as { sha: string };
                            sha = existing.sha;
                        }
                    } catch {
                        // File doesn't exist, that's fine
                    }

                    const body: Record<string, unknown> = {
                        message: commitMessage,
                        content: base64Content,
                        branch,
                    };
                    if (sha) body.sha = sha;

                    const response = await fetch(
                        `https://api.github.com/repos/${repo}/contents/${filePath}`,
                        {
                            method: 'PUT',
                            headers: {
                                Authorization: `Bearer ${ghToken}`,
                                'Content-Type': 'application/json',
                                'User-Agent': 'TITAN',
                            },
                            body: JSON.stringify(body),
                        },
                    );

                    if (!response.ok) {
                        const error = await response.text();
                        return `Publish failed (${response.status}): ${error}`;
                    }

                    const result = await response.json() as { content: { html_url: string } };
                    return `Published: "${title}"\nPath: ${filePath}\nURL: ${result.content.html_url}\nBranch: ${branch}`;
                } catch (e) {
                    return `Publish error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 4: content_schedule
    registerSkill(
        {
            name: 'content_publisher',
            description: 'Use this skill when Tony says "publish this post", "schedule this tweet/post", "post to social media", "write and publish content about X", or "set up automated content publishing". Handles the full SEO content pipeline: research topics, create outlines, publish to GitHub, and schedule recurring content. ALWAYS show Tony exactly what will be posted/published and wait for explicit approval before executing. Never publish without confirmation.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'content_schedule',
            description: 'Set up an automated content publishing schedule. Use when Tony says "publish content automatically", "schedule weekly posts about X", or "automate my content pipeline for [niche]". Creates a recurring goal with subtasks that run on cron.',
            parameters: {
                type: 'object',
                properties: {
                    frequency: {
                        type: 'string',
                        description: 'Publishing frequency: "daily", "twice-weekly", "weekly" (default: "daily")',
                    },
                    niche: {
                        type: 'string',
                        description: 'Content niche for the scheduled publications',
                    },
                    repo: {
                        type: 'string',
                        description: 'Target GitHub repo (owner/repo)',
                    },
                },
                required: ['niche', 'repo'],
            },
            execute: async (args) => {
                try {
                    const frequency = (args.frequency as string) || 'daily';
                    const niche = args.niche as string;
                    const repo = args.repo as string;

                    const cronExpressions: Record<string, string> = {
                        daily: '0 9 * * *',
                        'twice-weekly': '0 9 * * 2,5',
                        weekly: '0 9 * * 1',
                    };
                    const scheduleLabels: Record<string, string> = {
                        daily: 'every day at 9:00 AM',
                        'twice-weekly': 'every Tuesday and Friday at 9:00 AM',
                        weekly: 'every Monday at 9:00 AM',
                    };

                    const cronExpr = cronExpressions[frequency] || cronExpressions.daily;
                    const scheduleLabel = scheduleLabels[frequency] || scheduleLabels.daily;

                    // v5.0.0: Check for existing scheduled content goals for this niche
                    // before creating a duplicate. Update schedule if found.
                    const { createGoal, listGoals, updateGoal } = await import('../../agent/goals.js');
                    const existing = listGoals().find(g =>
                        g.title.trim().toLowerCase() === `publish content: ${niche}`.toLowerCase()
                    );
                    if (existing) {
                        if (existing.schedule !== cronExpr) {
                            updateGoal(existing.id, { schedule: cronExpr });
                            return `Updated existing content schedule for "${niche}" (Goal ${existing.id}) to ${scheduleLabel}.`;
                        }
                        return `Content schedule for "${niche}" already exists (Goal ${existing.id}, ${existing.schedule}). No duplicate created.`;
                    }

                    const goal = createGoal({
                        title: `Publish content: ${niche}`,
                        description: `Automated content pipeline for "${niche}" niche, publishing to ${repo}`,
                        schedule: cronExpr,
                        subtasks: [
                            { title: `Research trending topics in "${niche}"`, description: `Use content_research tool to find trending topics in "${niche}"` },
                            { title: 'Generate article outline', description: 'Use content_outline tool to create a structured outline from research' },
                            { title: 'Write full article', description: 'Write the complete article based on the outline' },
                            { title: `Publish to ${repo}`, description: `Use content_publish tool to commit the article to ${repo}` },
                        ],
                    });

                    const lines: string[] = [];
                    lines.push(`Content Schedule Created (Goal ID: ${goal.id})`);
                    lines.push(`Frequency: ${scheduleLabel}`);
                    lines.push(`Cron: ${cronExpr}`);
                    lines.push(`Niche: ${niche}`);
                    lines.push(`Repo: ${repo}`);
                    lines.push(`Subtasks: ${goal.subtasks.length}`);
                    lines.push('');
                    lines.push('Goal created with subtasks. Enable autopilot in goals mode to auto-execute on schedule.');

                    return lines.join('\n');
                } catch (e) {
                    return `Schedule error: ${(e as Error).message}`;
                }
            },
        },
    );
}
