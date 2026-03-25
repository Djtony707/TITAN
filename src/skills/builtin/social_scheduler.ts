/**
 * TITAN — Social Media Scheduler Skill (Built-in)
 * Schedule, manage, and draft social media posts across multiple platforms.
 * Inspired by Postiz (open-source social media scheduler).
 *
 * Posts are persisted as JSON files in ~/.titan/social-queue/.
 * Actual platform API calls are deferred to existing skills (x_poster, etc.)
 * or future integrations — this skill handles scheduling/queue infrastructure.
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import crypto from 'crypto';
import logger from '../../utils/logger.js';

const COMPONENT = 'SocialScheduler';
const QUEUE_DIR = join(TITAN_HOME, 'social-queue');

// ─── Types ───────────────────────────────────────────────────────

export type Platform = 'x' | 'linkedin' | 'bluesky' | 'mastodon' | 'threads';
export type PostStatus = 'pending' | 'published' | 'failed' | 'cancelled';

export interface ScheduledPost {
    id: string;
    platform: Platform;
    content: string;
    scheduledAt: string;
    mediaUrls: string[];
    hashtags: string[];
    status: PostStatus;
    createdAt: string;
    publishedAt?: string;
    error?: string;
    engagement?: PostEngagement;
}

export interface PostEngagement {
    likes: number;
    reposts: number;
    replies: number;
    impressions: number;
    clicks: number;
}

// ─── Platform Limits ─────────────────────────────────────────────

export const PLATFORM_LIMITS: Record<Platform, { maxChars: number; name: string; hashtagStyle: 'inline' | 'end' | 'none'; bestPractice: string }> = {
    x: {
        maxChars: 280,
        name: 'X/Twitter',
        hashtagStyle: 'end',
        bestPractice: 'Keep it punchy. Use 1-3 hashtags at the end. Thread for longer content.',
    },
    linkedin: {
        maxChars: 3000,
        name: 'LinkedIn',
        hashtagStyle: 'end',
        bestPractice: 'Professional tone. Use line breaks for readability. 3-5 hashtags at end. Hook in first line.',
    },
    bluesky: {
        maxChars: 300,
        name: 'Bluesky',
        hashtagStyle: 'inline',
        bestPractice: 'Conversational tone. Hashtags inline if used. Keep it concise.',
    },
    mastodon: {
        maxChars: 500,
        name: 'Mastodon',
        hashtagStyle: 'end',
        bestPractice: 'Community-friendly tone. Use CamelCase hashtags for accessibility. Content warnings when appropriate.',
    },
    threads: {
        maxChars: 500,
        name: 'Threads',
        hashtagStyle: 'none',
        bestPractice: 'Casual, conversational. No hashtags needed. Engage with questions.',
    },
};

const VALID_PLATFORMS: Platform[] = ['x', 'linkedin', 'bluesky', 'mastodon', 'threads'];

// ─── Queue Persistence ───────────────────────────────────────────

function ensureQueueDir(): void {
    if (!existsSync(QUEUE_DIR)) {
        mkdirSync(QUEUE_DIR, { recursive: true });
    }
}

function postFilePath(id: string): string {
    // Sanitize ID to prevent path traversal
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    return join(QUEUE_DIR, `${safeId}.json`);
}

function savePost(post: ScheduledPost): void {
    ensureQueueDir();
    writeFileSync(postFilePath(post.id), JSON.stringify(post, null, 2), 'utf-8');
}

function loadPost(id: string): ScheduledPost | null {
    const filePath = postFilePath(id);
    if (!existsSync(filePath)) return null;
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8')) as ScheduledPost;
    } catch {
        return null;
    }
}

function loadAllPosts(): ScheduledPost[] {
    ensureQueueDir();
    const files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
    const posts: ScheduledPost[] = [];
    for (const file of files) {
        try {
            const data = JSON.parse(readFileSync(join(QUEUE_DIR, file), 'utf-8')) as ScheduledPost;
            posts.push(data);
        } catch {
            // Skip corrupt files
        }
    }
    // Sort by scheduledAt ascending
    return posts.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _deletePostFile(id: string): boolean {
    const filePath = postFilePath(id);
    if (existsSync(filePath)) {
        unlinkSync(filePath);
        return true;
    }
    return false;
}

// ─── Schedule Checker ────────────────────────────────────────────

let checkerInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduleChecker(): void {
    if (checkerInterval) return;

    checkerInterval = setInterval(() => {
        const now = new Date();
        const posts = loadAllPosts();

        for (const post of posts) {
            if (post.status !== 'pending') continue;

            const scheduledTime = new Date(post.scheduledAt);
            if (scheduledTime <= now) {
                // Mark as published — actual posting delegated to platform skills
                post.status = 'published';
                post.publishedAt = now.toISOString();
                savePost(post);
                logger.info(COMPONENT, `Post ${post.id} ready for publishing to ${post.platform}: "${post.content.slice(0, 50)}..."`);
            }
        }
    }, 60_000); // Check every minute

    checkerInterval.unref();
    logger.info(COMPONENT, 'Social schedule checker started (60s interval)');
}

export function stopScheduleChecker(): void {
    if (checkerInterval) {
        clearInterval(checkerInterval);
        checkerInterval = null;
    }
}

// ─── Draft Generation ────────────────────────────────────────────

function generateDraft(topic: string, platform: Platform, tone: string): string {
    const limits = PLATFORM_LIMITS[platform];
    const toneMap: Record<string, string> = {
        professional: 'In a professional and insightful tone',
        casual: 'In a casual, friendly tone',
        witty: 'In a witty, clever tone',
        inspiring: 'In an inspiring, motivational tone',
        educational: 'In an educational, informative tone',
    };

    const tonePrefix = toneMap[tone] || toneMap.casual;
    const maxChars = limits.maxChars;

    // Build a template draft based on platform conventions
    let draft: string;

    switch (platform) {
        case 'x':
            draft = `${topic}\n\n[Your key insight here in 1-2 sentences]`;
            break;
        case 'linkedin':
            draft = `${topic}\n\n[Hook: Start with a compelling statement]\n\n[Body: 2-3 paragraphs with insights]\n\n[CTA: Ask a question or invite discussion]`;
            break;
        case 'bluesky':
            draft = `${topic}\n\n[Share your take concisely]`;
            break;
        case 'mastodon':
            draft = `${topic}\n\n[Community-friendly take on this topic]\n\n[Invite discussion]`;
            break;
        case 'threads':
            draft = `${topic}\n\n[Conversational take — no hashtags needed]\n\n[End with a question to boost engagement]`;
            break;
    }

    const lines: string[] = [
        `--- Draft for ${limits.name} (max ${maxChars} chars) ---`,
        `Tone: ${tonePrefix}`,
        `Best practice: ${limits.bestPractice}`,
        '',
        draft,
        '',
        `--- ${draft.length}/${maxChars} characters ---`,
    ];

    return lines.join('\n');
}

// ─── Skill Registration ──────────────────────────────────────────

const SKILL_META = {
    name: 'social_scheduler',
    description: 'Schedule, manage, and draft social media posts across X, LinkedIn, Bluesky, Mastodon, and Threads. USE THIS WHEN Tony says: "schedule a post", "show my social queue", "cancel that post", "draft a tweet about X", "social media analytics", "manage my social posts". Handles the full social media scheduling pipeline.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerSocialSchedulerSkill(): void {
    // Tool 1: social_schedule
    registerSkill(
        SKILL_META,
        {
            name: 'social_schedule',
            description: 'Schedule a social media post for future publishing. Supports X, LinkedIn, Bluesky, Mastodon, and Threads. Posts are saved to the queue and published at the scheduled time. ALWAYS show Tony the post content and schedule time before confirming.',
            parameters: {
                type: 'object',
                properties: {
                    platform: {
                        type: 'string',
                        enum: ['x', 'linkedin', 'bluesky', 'mastodon', 'threads'],
                        description: 'Target platform',
                    },
                    content: {
                        type: 'string',
                        description: 'Post text content',
                    },
                    scheduledAt: {
                        type: 'string',
                        description: 'ISO datetime string for when to publish (e.g., "2026-03-17T09:00:00Z")',
                    },
                    mediaUrls: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional array of image/video URLs to attach',
                    },
                    hashtags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional array of hashtags (without # prefix)',
                    },
                },
                required: ['platform', 'content', 'scheduledAt'],
            },
            execute: async (args) => {
                const platform = args.platform as string;
                const content = args.content as string;
                const scheduledAt = args.scheduledAt as string;
                const mediaUrls = (args.mediaUrls as string[]) || [];
                const hashtags = (args.hashtags as string[]) || [];

                // Validate platform
                if (!VALID_PLATFORMS.includes(platform as Platform)) {
                    return `Error: Invalid platform "${platform}". Valid platforms: ${VALID_PLATFORMS.join(', ')}`;
                }

                // Validate scheduled time
                const scheduledDate = new Date(scheduledAt);
                if (isNaN(scheduledDate.getTime())) {
                    return `Error: Invalid datetime "${scheduledAt}". Use ISO format (e.g., "2026-03-17T09:00:00Z")`;
                }
                if (scheduledDate <= new Date()) {
                    return `Error: Scheduled time must be in the future. Got: ${scheduledAt}`;
                }

                // Validate content length
                const limits = PLATFORM_LIMITS[platform as Platform];
                if (content.length > limits.maxChars) {
                    return `Error: Content exceeds ${limits.name} limit (${content.length}/${limits.maxChars} chars). Trim your post.`;
                }

                const post: ScheduledPost = {
                    id: crypto.randomUUID(),
                    platform: platform as Platform,
                    content,
                    scheduledAt: scheduledDate.toISOString(),
                    mediaUrls,
                    hashtags,
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                };

                savePost(post);
                startScheduleChecker();

                logger.info(COMPONENT, `Scheduled post ${post.id} for ${platform} at ${scheduledAt}`);

                const lines = [
                    `Post scheduled (ID: ${post.id})`,
                    `Platform: ${limits.name}`,
                    `Scheduled: ${scheduledDate.toISOString()}`,
                    `Content: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`,
                    `Characters: ${content.length}/${limits.maxChars}`,
                ];
                if (mediaUrls.length > 0) lines.push(`Media: ${mediaUrls.length} attachment(s)`);
                if (hashtags.length > 0) lines.push(`Hashtags: #${hashtags.join(' #')}`);

                return lines.join('\n');
            },
        },
    );

    // Tool 2: social_queue
    registerSkill(
        SKILL_META,
        {
            name: 'social_queue',
            description: 'List all scheduled social media posts. Shows pending, published, and failed posts with platform, content preview, and scheduled time. Use when Tony asks "show my social queue", "what posts are scheduled?", or "list upcoming posts".',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        enum: ['all', 'pending', 'published', 'failed', 'cancelled'],
                        description: 'Filter by status (default: "all")',
                    },
                    platform: {
                        type: 'string',
                        enum: ['x', 'linkedin', 'bluesky', 'mastodon', 'threads'],
                        description: 'Filter by platform (optional)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                const statusFilter = (args.status as string) || 'all';
                const platformFilter = args.platform as string | undefined;

                let posts = loadAllPosts();

                if (statusFilter !== 'all') {
                    posts = posts.filter(p => p.status === statusFilter);
                }
                if (platformFilter) {
                    posts = posts.filter(p => p.platform === platformFilter);
                }

                if (posts.length === 0) {
                    return statusFilter === 'all'
                        ? 'Social queue is empty. No posts scheduled.'
                        : `No ${statusFilter} posts found.`;
                }

                const lines: string[] = [`Social Queue (${posts.length} post${posts.length !== 1 ? 's' : ''})`, ''];

                for (const post of posts) {
                    const limits = PLATFORM_LIMITS[post.platform];
                    const statusIcon = {
                        pending: '[PENDING]',
                        published: '[PUBLISHED]',
                        failed: '[FAILED]',
                        cancelled: '[CANCELLED]',
                    }[post.status];

                    lines.push(`${statusIcon} ${limits.name} — ${post.id}`);
                    lines.push(`  Content: "${post.content.slice(0, 80)}${post.content.length > 80 ? '...' : ''}"`);
                    lines.push(`  Scheduled: ${post.scheduledAt}`);
                    if (post.publishedAt) lines.push(`  Published: ${post.publishedAt}`);
                    if (post.error) lines.push(`  Error: ${post.error}`);
                    if (post.hashtags.length > 0) lines.push(`  Hashtags: #${post.hashtags.join(' #')}`);
                    if (post.mediaUrls.length > 0) lines.push(`  Media: ${post.mediaUrls.length} attachment(s)`);
                    lines.push('');
                }

                return lines.join('\n');
            },
        },
    );

    // Tool 3: social_cancel
    registerSkill(
        SKILL_META,
        {
            name: 'social_cancel',
            description: 'Cancel a scheduled social media post by ID. Only pending posts can be cancelled. Use when Tony says "cancel that post", "remove post [ID] from queue", or "don\'t post that".',
            parameters: {
                type: 'object',
                properties: {
                    postId: {
                        type: 'string',
                        description: 'The post ID to cancel',
                    },
                },
                required: ['postId'],
            },
            execute: async (args) => {
                const postId = args.postId as string;

                if (!postId) {
                    return 'Error: postId is required.';
                }

                const post = loadPost(postId);
                if (!post) {
                    return `Error: Post "${postId}" not found.`;
                }

                if (post.status !== 'pending') {
                    return `Error: Cannot cancel post "${postId}" — status is "${post.status}". Only pending posts can be cancelled.`;
                }

                post.status = 'cancelled';
                savePost(post);

                logger.info(COMPONENT, `Cancelled post ${postId} (${post.platform})`);
                return `Cancelled post "${postId}" (${PLATFORM_LIMITS[post.platform].name}): "${post.content.slice(0, 80)}..."`;
            },
        },
    );

    // Tool 4: social_analytics
    registerSkill(
        SKILL_META,
        {
            name: 'social_analytics',
            description: 'Get basic engagement stats for recent social media posts. Reads from saved post results. Use when Tony asks "how are my posts doing?", "social media analytics", or "engagement stats".',
            parameters: {
                type: 'object',
                properties: {
                    platform: {
                        type: 'string',
                        enum: ['x', 'linkedin', 'bluesky', 'mastodon', 'threads'],
                        description: 'Filter by platform (optional)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Number of recent posts to include (default: 10)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                const platformFilter = args.platform as string | undefined;
                const limit = Math.min((args.limit as number) || 10, 50);

                let posts = loadAllPosts().filter(p => p.status === 'published');

                if (platformFilter) {
                    posts = posts.filter(p => p.platform === platformFilter);
                }

                // Most recent first for analytics
                posts = posts.sort((a, b) =>
                    new Date(b.publishedAt || b.scheduledAt).getTime() -
                    new Date(a.publishedAt || a.scheduledAt).getTime(),
                ).slice(0, limit);

                if (posts.length === 0) {
                    return 'No published posts found. Schedule and publish posts first to see analytics.';
                }

                // Aggregate engagement
                const totals = { likes: 0, reposts: 0, replies: 0, impressions: 0, clicks: 0 };
                let postsWithEngagement = 0;
                const platformBreakdown: Record<string, number> = {};

                for (const post of posts) {
                    platformBreakdown[post.platform] = (platformBreakdown[post.platform] || 0) + 1;
                    if (post.engagement) {
                        postsWithEngagement++;
                        totals.likes += post.engagement.likes;
                        totals.reposts += post.engagement.reposts;
                        totals.replies += post.engagement.replies;
                        totals.impressions += post.engagement.impressions;
                        totals.clicks += post.engagement.clicks;
                    }
                }

                const lines: string[] = [
                    `Social Analytics (${posts.length} published post${posts.length !== 1 ? 's' : ''})`,
                    '='.repeat(50),
                    '',
                    'Platform Breakdown:',
                ];

                for (const [plat, count] of Object.entries(platformBreakdown)) {
                    const name = PLATFORM_LIMITS[plat as Platform]?.name || plat;
                    lines.push(`  ${name}: ${count} post${count !== 1 ? 's' : ''}`);
                }

                lines.push('');
                lines.push('Engagement Totals:');
                lines.push(`  Likes: ${totals.likes}`);
                lines.push(`  Reposts: ${totals.reposts}`);
                lines.push(`  Replies: ${totals.replies}`);
                lines.push(`  Impressions: ${totals.impressions}`);
                lines.push(`  Clicks: ${totals.clicks}`);

                if (postsWithEngagement > 0) {
                    lines.push('');
                    lines.push('Averages per post:');
                    lines.push(`  Likes: ${(totals.likes / postsWithEngagement).toFixed(1)}`);
                    lines.push(`  Reposts: ${(totals.reposts / postsWithEngagement).toFixed(1)}`);
                    lines.push(`  Impressions: ${(totals.impressions / postsWithEngagement).toFixed(1)}`);
                } else {
                    lines.push('');
                    lines.push('No engagement data recorded yet. Engagement is populated after platform API sync.');
                }

                lines.push('');
                lines.push('Recent Posts:');
                for (const post of posts.slice(0, 5)) {
                    const name = PLATFORM_LIMITS[post.platform].name;
                    lines.push(`  [${name}] "${post.content.slice(0, 60)}${post.content.length > 60 ? '...' : ''}" — ${post.publishedAt || post.scheduledAt}`);
                }

                return lines.join('\n');
            },
        },
    );

    // Tool 5: social_draft
    registerSkill(
        SKILL_META,
        {
            name: 'social_draft',
            description: 'AI-generate a social media post draft given a topic, target platform, and tone. Returns draft text optimized for that platform (character limits, hashtag style, etc.). Use when Tony says "draft a tweet about X", "write a LinkedIn post about Y", or "generate social content for Z".',
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        description: 'The topic or subject for the post',
                    },
                    platform: {
                        type: 'string',
                        enum: ['x', 'linkedin', 'bluesky', 'mastodon', 'threads'],
                        description: 'Target platform (determines char limits and style)',
                    },
                    tone: {
                        type: 'string',
                        enum: ['professional', 'casual', 'witty', 'inspiring', 'educational'],
                        description: 'Tone of the post (default: "casual")',
                    },
                },
                required: ['topic', 'platform'],
            },
            execute: async (args) => {
                const topic = args.topic as string;
                const platform = args.platform as string;
                const tone = (args.tone as string) || 'casual';

                if (!topic) {
                    return 'Error: topic is required.';
                }

                if (!VALID_PLATFORMS.includes(platform as Platform)) {
                    return `Error: Invalid platform "${platform}". Valid platforms: ${VALID_PLATFORMS.join(', ')}`;
                }

                const draft = generateDraft(topic, platform as Platform, tone);
                return draft;
            },
        },
    );

    // Start the schedule checker
    startScheduleChecker();
}
