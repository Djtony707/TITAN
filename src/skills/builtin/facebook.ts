/**
 * TITAN — Facebook Hybrid Skill
 *
 * Hybrid approach:
 * - Graph API: posting, reading feed, replying, insights (for Pages)
 * - Browser automation: DMs, browsing, screenshots, personal account actions
 *
 * Required env vars (for Graph API — Pages):
 *   FB_PAGE_ACCESS_TOKEN  — Long-lived Page Access Token
 *   FB_PAGE_ID            — Facebook Page ID
 *
 * Browser automation works without API keys — uses TITAN's built-in browser tools.
 *
 * Tools:
 *   fb_post            — Post to Facebook (API for pages, browser for personal)
 *   fb_read_feed       — Read recent posts from a page/profile
 *   fb_reply           — Reply to a comment on a post
 *   fb_get_insights    — Get page analytics (API only)
 *   fb_browse          — Navigate Facebook via browser automation
 *   fb_review_queue    — Review/approve queued posts before publishing
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'Facebook';
const REVIEW_QUEUE_PATH = join(TITAN_HOME, 'fb-review-queue.json');
const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

// ─── Types ──────────────────────────────────────────────────────

interface QueuedPost {
    id: string;
    type: 'post' | 'reply' | 'story';
    content: string;
    replyToId?: string;
    imageUrl?: string;
    status: 'pending' | 'approved' | 'rejected' | 'posted';
    method: 'api' | 'browser';
    createdAt: string;
    postedAt?: string;
    fbPostId?: string;
}

interface ReviewQueue {
    posts: QueuedPost[];
}

// ─── Review Queue ──────────────────────────────────────────────

function loadQueue(): ReviewQueue {
    if (!existsSync(REVIEW_QUEUE_PATH)) return { posts: [] };
    try {
        return JSON.parse(readFileSync(REVIEW_QUEUE_PATH, 'utf-8')) as ReviewQueue;
    } catch { return { posts: [] }; }
}

function saveQueue(queue: ReviewQueue): void {
    try {
        mkdirSync(dirname(REVIEW_QUEUE_PATH), { recursive: true });
        writeFileSync(REVIEW_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save review queue: ${(e as Error).message}`);
    }
}

// ─── Graph API Helpers ─────────────────────────────────────────

function getPageToken(): string {
    return process.env.FB_PAGE_ACCESS_TOKEN || '';
}

function getPageId(): string {
    return process.env.FB_PAGE_ID || '';
}

function hasApiAccess(): boolean {
    return !!(getPageToken() && getPageId());
}

async function graphPost(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = getPageToken();
    const url = `${GRAPH_API_BASE}${endpoint}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Facebook API error (${response.status}): ${errText}`);
    }
    return await response.json() as Record<string, unknown>;
}

async function graphGet(endpoint: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    const token = getPageToken();
    const qs = new URLSearchParams({ access_token: token, ...(params || {}) });
    const url = `${GRAPH_API_BASE}${endpoint}?${qs}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Facebook API error (${response.status}): ${errText}`);
    }
    return await response.json() as Record<string, unknown>;
}

// ─── Content Safety ────────────────────────────────────────────

/** Block posts containing personal/sensitive information */
function checkForPII(content: string): string | null {
    const lower = content.toLowerCase();
    const patterns: Array<{ pattern: RegExp; label: string }> = [
        { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, label: 'phone number' },
        { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, label: 'email address' },
        { pattern: /\b\d{3}[-]?\d{2}[-]?\d{4}\b/, label: 'SSN-like number' },
        { pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/, label: 'credit card number' },
        { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: 'IP address' },
        { pattern: /(?:password|passwd|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S+/i, label: 'credential/password' },
        { pattern: /\b(?:ssh-rsa|ssh-ed25519|AKIA[0-9A-Z]{16})\b/, label: 'SSH/AWS key' },
    ];

    for (const { pattern, label } of patterns) {
        if (pattern.test(content)) {
            return label;
        }
    }

    // Check for home directory paths
    if (/\/home\/[a-z]+\//i.test(content) || /\/Users\/[a-z]+\//i.test(content)) {
        // Allow ~/.titan paths but block real user paths
        if (!content.includes('~/.titan') && !content.includes('/opt/TITAN')) {
            return 'personal file path';
        }
    }

    return null;
}

// ─── Skill Registration ────────────────────────────────────────

export function registerFacebookSkill(): void {
    // ── Tool 1: fb_post ──
    registerSkill(
        { name: 'facebook', description: 'Facebook hybrid skill — Graph API + browser automation', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'fb_post',
            description: 'Post to Facebook. Uses Graph API for Pages (if configured) or queues for browser automation. Posts go through a review queue — use fb_review_queue to approve.\nUSE THIS WHEN: user wants to post something on Facebook.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'The post content/message' },
                    imageUrl: { type: 'string', description: 'Optional image URL to attach to the post' },
                    skipReview: { type: 'boolean', description: 'Skip the review queue and post immediately (default: false)' },
                },
                required: ['message'],
            },
            execute: async (args) => {
                const message = args.message as string;
                const imageUrl = args.imageUrl as string | undefined;
                const skipReview = args.skipReview as boolean || false;
                const method = hasApiAccess() ? 'api' : 'browser';

                // ── PII guard: block posts with personal/sensitive info ──
                const piiMatch = checkForPII(message);
                if (piiMatch) {
                    logger.warn(COMPONENT, `Post blocked — contains ${piiMatch}: "${message.slice(0, 50)}..."`);
                    return `Post blocked for safety: detected ${piiMatch} in content. Remove personal information and try again.`;
                }

                // ── Dedup guard: prevent double-fire within 5 minutes ──
                const queue = loadQueue();
                const fiveMinAgo = Date.now() - 5 * 60 * 1000;
                const duplicate = queue.posts.find(p =>
                    p.content === message &&
                    (p.status === 'posted' || p.status === 'pending') &&
                    new Date(p.createdAt).getTime() > fiveMinAgo
                );
                if (duplicate) {
                    logger.warn(COMPONENT, `Duplicate post blocked: "${message.slice(0, 50)}..." (original: ${duplicate.id})`);
                    return `This post was already ${duplicate.status === 'posted' ? 'published' : 'queued'} ${duplicate.status === 'posted' ? `(Post ID: ${duplicate.fbPostId})` : `(Queue ID: ${duplicate.id})`}. Skipping duplicate.`;
                }

                const post: QueuedPost = {
                    id: uuid().slice(0, 8),
                    type: 'post',
                    content: message,
                    imageUrl,
                    status: skipReview ? 'approved' : 'pending',
                    method,
                    createdAt: new Date().toISOString(),
                };

                if (skipReview && method === 'api') {
                    // Post directly via API
                    try {
                        const pageId = getPageId();
                        const body: Record<string, unknown> = { message };
                        if (imageUrl) {
                            // Photo post
                            const result = await graphPost(`/${pageId}/photos`, { url: imageUrl, message });
                            post.fbPostId = result.id as string;
                        } else {
                            const result = await graphPost(`/${pageId}/feed`, body);
                            post.fbPostId = result.id as string;
                        }
                        post.status = 'posted';
                        post.postedAt = new Date().toISOString();

                        queue.posts.push(post);
                        saveQueue(queue);

                        logger.info(COMPONENT, `Posted to Facebook Page: ${post.fbPostId}`);
                        return `Posted to Facebook! Post ID: ${post.fbPostId}\nContent: "${message.slice(0, 100)}..."`;
                    } catch (e) {
                        return `Failed to post: ${(e as Error).message}. Post queued for browser automation instead.`;
                    }
                }

                // Queue for review (reuse queue from dedup check)
                queue.posts.push(post);
                saveQueue(queue);

                if (method === 'browser') {
                    return `Post queued for browser automation (ID: ${post.id}). Use fb_review_queue to approve, then TITAN will post via browser.\n\nQueued: "${message.slice(0, 100)}..."`;
                }

                return `Post queued for review (ID: ${post.id}). Use fb_review_queue to approve before publishing.\n\nQueued: "${message.slice(0, 100)}..."`;
            },
        },
    );

    // ── Tool 2: fb_read_feed ──
    registerSkill(
        { name: 'facebook', description: 'Facebook hybrid skill', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'fb_read_feed',
            description: 'Read recent posts from a Facebook Page (requires API access) or browse the feed via browser.\nUSE THIS WHEN: user wants to see recent Facebook posts or check their feed.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Number of posts to fetch (default: 5, max: 25)' },
                    pageId: { type: 'string', description: 'Page ID to read (default: configured page)' },
                },
            },
            execute: async (args) => {
                const limit = Math.min((args.limit as number) || 5, 25);

                if (!hasApiAccess()) {
                    return `No Facebook API credentials configured. Set FB_PAGE_ACCESS_TOKEN and FB_PAGE_ID env vars.\n\nAlternative: Use fb_browse to navigate Facebook in the browser and read the feed manually.`;
                }

                try {
                    const pageId = (args.pageId as string) || getPageId();
                    const result = await graphGet(`/${pageId}/feed`, {
                        fields: 'id,message,created_time,likes.summary(true),comments.summary(true),shares',
                        limit: limit.toString(),
                    });

                    const posts = (result.data as Array<Record<string, unknown>>) || [];
                    if (posts.length === 0) return 'No posts found on this page.';

                    const lines = posts.map((p, i) => {
                        const msg = (p.message as string || '(no text)').slice(0, 200);
                        const time = p.created_time as string || '';
                        const likes = ((p.likes as Record<string, unknown>)?.summary as Record<string, unknown>)?.total_count || 0;
                        const comments = ((p.comments as Record<string, unknown>)?.summary as Record<string, unknown>)?.total_count || 0;
                        return `${i + 1}. [${time}] ${msg}\n   ${likes} likes, ${comments} comments (ID: ${p.id})`;
                    });

                    return `Recent ${posts.length} posts:\n\n${lines.join('\n\n')}`;
                } catch (e) {
                    return `Failed to read feed: ${(e as Error).message}`;
                }
            },
        },
    );

    // ── Tool 3: fb_reply ──
    registerSkill(
        { name: 'facebook', description: 'Facebook hybrid skill', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'fb_reply',
            description: 'Reply to a comment on a Facebook post (requires API access).\nUSE THIS WHEN: user wants to respond to a Facebook comment.',
            parameters: {
                type: 'object',
                properties: {
                    commentId: { type: 'string', description: 'The comment ID to reply to' },
                    message: { type: 'string', description: 'Reply message' },
                },
                required: ['commentId', 'message'],
            },
            execute: async (args) => {
                if (!hasApiAccess()) return 'No Facebook API credentials configured. Set FB_PAGE_ACCESS_TOKEN and FB_PAGE_ID.';

                const commentId = args.commentId as string;
                const message = args.message as string;

                // PII check on replies too
                const piiMatch = checkForPII(message);
                if (piiMatch) return `Reply blocked: detected ${piiMatch}. Remove personal information and try again.`;

                try {
                    const result = await graphPost(`/${commentId}/comments`, { message });
                    return `Reply posted! Comment ID: ${result.id}\nContent: "${message.slice(0, 100)}..."`;
                } catch (e) {
                    return `Failed to reply: ${(e as Error).message}`;
                }
            },
        },
    );

    // ── Tool 4: fb_get_insights ──
    registerSkill(
        { name: 'facebook', description: 'Facebook hybrid skill', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'fb_get_insights',
            description: 'Get Facebook Page analytics/insights (requires API access). Shows reach, engagement, followers.\nUSE THIS WHEN: user asks about Facebook analytics or performance.',
            parameters: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: ['day', 'week', 'month'], description: 'Time period (default: week)' },
                },
            },
            execute: async (args) => {
                if (!hasApiAccess()) return 'No Facebook API credentials configured. Set FB_PAGE_ACCESS_TOKEN and FB_PAGE_ID.';

                const period = (args.period as string) || 'week';
                const pageId = getPageId();

                try {
                    const metrics = 'page_impressions,page_engaged_users,page_fans,page_views_total';
                    const result = await graphGet(`/${pageId}/insights`, {
                        metric: metrics,
                        period,
                    });

                    const data = (result.data as Array<Record<string, unknown>>) || [];
                    if (data.length === 0) return 'No insights data available for this period.';

                    const lines = data.map(m => {
                        const name = (m.name as string || '').replace('page_', '').replace(/_/g, ' ');
                        const values = (m.values as Array<Record<string, unknown>>) || [];
                        const latest = values[values.length - 1];
                        return `- ${name}: ${latest?.value ?? 'N/A'}`;
                    });

                    return `Facebook Page Insights (${period}):\n\n${lines.join('\n')}`;
                } catch (e) {
                    return `Failed to get insights: ${(e as Error).message}`;
                }
            },
        },
    );

    // ── Tool 5: fb_browse ──
    registerSkill(
        { name: 'facebook', description: 'Facebook hybrid skill', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'fb_browse',
            description: 'Navigate Facebook in the browser. Use this for personal account actions, reading DMs, browsing marketplace, or anything the API cannot do. Returns instructions to use with browse_url and web_act tools.\nUSE THIS WHEN: user wants to do something on Facebook that requires browser interaction.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['feed', 'profile', 'messages', 'marketplace', 'notifications', 'post', 'custom'],
                        description: 'What to do on Facebook',
                    },
                    url: { type: 'string', description: 'Custom Facebook URL to navigate to (for action=custom)' },
                    postContent: { type: 'string', description: 'Content to post (for action=post)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;

                const urls: Record<string, string> = {
                    feed: 'https://www.facebook.com/',
                    profile: 'https://www.facebook.com/me',
                    messages: 'https://www.facebook.com/messages',
                    marketplace: 'https://www.facebook.com/marketplace',
                    notifications: 'https://www.facebook.com/notifications',
                    post: 'https://www.facebook.com/',
                };

                const targetUrl = action === 'custom' ? (args.url as string || 'https://www.facebook.com') : urls[action] || 'https://www.facebook.com';

                if (action === 'post' && args.postContent) {
                    return `To post on Facebook via browser:\n\n1. Use browse_url to navigate to: ${targetUrl}\n2. Use web_act to click the "What's on your mind?" input\n3. Use web_act to type: ${(args.postContent as string).slice(0, 200)}\n4. Use web_act to click the "Post" button\n5. Use browser_screenshot to verify the post was created\n\nNote: Make sure you're logged into Facebook first. Use browser_screenshot to check the current state.`;
                }

                return `To access Facebook ${action}:\n\n1. Use browse_url to navigate to: ${targetUrl}\n2. Use browser_screenshot to see the current page\n3. Use web_act to interact with elements on the page\n4. Use web_read to extract text content\n\nMake sure you're logged into Facebook. If you see a login page, the user needs to log in manually first.`;
            },
        },
    );

    // ── Tool 6: fb_review_queue ──
    registerSkill(
        { name: 'facebook', description: 'Facebook hybrid skill', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'fb_review_queue',
            description: 'Review, approve, or reject queued Facebook posts before they are published.\nUSE THIS WHEN: user wants to see pending posts or approve/reject them.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'approve', 'reject', 'clear'],
                        description: 'Action to perform on the queue',
                    },
                    postId: { type: 'string', description: 'Post ID to approve/reject (required for approve/reject)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const postId = args.postId as string;
                const queue = loadQueue();

                if (action === 'list') {
                    const pending = queue.posts.filter(p => p.status === 'pending');
                    if (pending.length === 0) return 'No pending posts in the review queue.';
                    const lines = pending.map(p =>
                        `[${p.id}] ${p.type} via ${p.method} — "${p.content.slice(0, 100)}..." (${p.createdAt})`
                    );
                    return `${pending.length} pending post(s):\n\n${lines.join('\n')}`;
                }

                if (action === 'approve') {
                    const post = queue.posts.find(p => p.id === postId);
                    if (!post) return `Post ${postId} not found in queue.`;
                    if (post.status !== 'pending') return `Post ${postId} is already ${post.status}.`;

                    // If API method, post now
                    if (post.method === 'api' && hasApiAccess()) {
                        try {
                            const pageId = getPageId();
                            const body: Record<string, unknown> = { message: post.content };
                            let result: Record<string, unknown>;
                            if (post.imageUrl) {
                                result = await graphPost(`/${pageId}/photos`, { url: post.imageUrl, message: post.content });
                            } else {
                                result = await graphPost(`/${pageId}/feed`, body);
                            }
                            post.status = 'posted';
                            post.postedAt = new Date().toISOString();
                            post.fbPostId = result.id as string;
                            saveQueue(queue);
                            return `Post approved and published! Facebook Post ID: ${post.fbPostId}`;
                        } catch (e) {
                            return `Post approved but failed to publish: ${(e as Error).message}. Try again or use browser method.`;
                        }
                    }

                    // Browser method — mark as approved, user/TITAN posts via browser
                    post.status = 'approved';
                    saveQueue(queue);
                    return `Post ${postId} approved for browser posting. Use fb_browse with action=post to publish it via browser automation.`;
                }

                if (action === 'reject') {
                    const post = queue.posts.find(p => p.id === postId);
                    if (!post) return `Post ${postId} not found in queue.`;
                    post.status = 'rejected';
                    saveQueue(queue);
                    return `Post ${postId} rejected and removed from queue.`;
                }

                if (action === 'clear') {
                    const cleared = queue.posts.filter(p => p.status === 'pending').length;
                    queue.posts = queue.posts.filter(p => p.status !== 'pending');
                    saveQueue(queue);
                    return `Cleared ${cleared} pending post(s) from queue.`;
                }

                return 'Unknown action. Use: list, approve, reject, or clear.';
            },
        },
    );

    logger.info(COMPONENT, 'Facebook hybrid skill registered (6 tools)');
}
