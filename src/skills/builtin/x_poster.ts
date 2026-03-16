/**
 * TITAN — X/Twitter Poster Skill (Built-in)
 * Post, reply, search, and read timeline on X using the v2 API.
 * Includes a human review gate — posts are queued for approval before publishing.
 *
 * Required env vars: X_BEARER_TOKEN, X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';
import crypto from 'crypto';

const COMPONENT = 'XPoster';
const REVIEW_QUEUE_PATH = join(TITAN_HOME, 'x-review-queue.json');

interface QueuedPost {
    id: string;
    type: 'post' | 'reply';
    content: string;
    replyToId?: string;
    status: 'pending' | 'approved' | 'rejected' | 'posted';
    createdAt: string;
    postedAt?: string;
    tweetId?: string;
}

interface ReviewQueue {
    posts: QueuedPost[];
}

// ─── OAuth 1.0a Signing ──────────────────────────────────────────

function percentEncode(str: string): string {
    return encodeURIComponent(str)
        .replace(/!/g, '%21')
        .replace(/\*/g, '%2A')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
}

function generateOAuthSignature(
    method: string,
    url: string,
    params: Record<string, string>,
    consumerSecret: string,
    tokenSecret: string,
): string {
    const sortedKeys = Object.keys(params).sort();
    const paramString = sortedKeys.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
    const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
    const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
    return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function buildOAuthHeader(
    method: string,
    url: string,
    body?: Record<string, string>,
): string {
    const apiKey = process.env.X_API_KEY || '';
    const apiSecret = process.env.X_API_SECRET || '';
    const accessToken = process.env.X_ACCESS_TOKEN || '';
    const accessSecret = process.env.X_ACCESS_SECRET || '';

    const oauthParams: Record<string, string> = {
        oauth_consumer_key: apiKey,
        oauth_nonce: uuid().replace(/-/g, ''),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: accessToken,
        oauth_version: '1.0',
    };

    const allParams = { ...oauthParams, ...(body || {}) };
    const signature = generateOAuthSignature(method, url, allParams, apiSecret, accessSecret);
    oauthParams.oauth_signature = signature;

    const headerParts = Object.keys(oauthParams)
        .sort()
        .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
        .join(', ');

    return `OAuth ${headerParts}`;
}

// ─── Review Queue ─────────────────────────────────────────────────

function loadQueue(): ReviewQueue {
    if (!existsSync(REVIEW_QUEUE_PATH)) return { posts: [] };
    try {
        return JSON.parse(readFileSync(REVIEW_QUEUE_PATH, 'utf-8')) as ReviewQueue;
    } catch {
        return { posts: [] };
    }
}

function saveQueue(queue: ReviewQueue): void {
    try {
        mkdirSync(dirname(REVIEW_QUEUE_PATH), { recursive: true });
        writeFileSync(REVIEW_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save review queue: ${(e as Error).message}`);
    }
}

function addToQueue(post: QueuedPost): void {
    const queue = loadQueue();
    queue.posts.push(post);
    saveQueue(queue);
}

// ─── X API v2 Calls ───────────────────────────────────────────────

async function postTweet(content: string, replyToId?: string): Promise<{ id: string; text: string } | string> {
    const url = 'https://api.twitter.com/2/tweets';
    const body: Record<string, unknown> = { text: content };
    if (replyToId) {
        body.reply = { in_reply_to_tweet_id: replyToId };
    }

    const authHeader = buildOAuthHeader('POST', url);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            return `X API error (${response.status}): ${error}`;
        }

        const data = await response.json() as { data: { id: string; text: string } };
        return data.data;
    } catch (e) {
        return `X API error: ${(e as Error).message}`;
    }
}

async function searchTweets(query: string, maxResults: number = 10): Promise<string> {
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) return 'Error: X_BEARER_TOKEN environment variable not set.';

    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${Math.min(maxResults, 100)}&tweet.fields=author_id,created_at,public_metrics`;

    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${bearerToken}` },
        });

        if (!response.ok) {
            const error = await response.text();
            return `X Search error (${response.status}): ${error}`;
        }

        const data = await response.json() as {
            data?: Array<{
                id: string;
                text: string;
                author_id: string;
                created_at: string;
                public_metrics: { like_count: number; retweet_count: number; reply_count: number };
            }>;
            meta: { result_count: number };
        };

        if (!data.data || data.data.length === 0) {
            return `No tweets found for "${query}"`;
        }

        const lines: string[] = [`X Search: "${query}" (${data.meta.result_count} results)`, ''];
        for (const tweet of data.data) {
            const metrics = tweet.public_metrics;
            lines.push(`[${tweet.id}] ${tweet.text.slice(0, 200)}`);
            lines.push(`  By: ${tweet.author_id} | ${tweet.created_at} | ❤️ ${metrics.like_count} 🔁 ${metrics.retweet_count} 💬 ${metrics.reply_count}`);
            lines.push('');
        }

        return lines.join('\n');
    } catch (e) {
        return `X Search error: ${(e as Error).message}`;
    }
}

// ─── Skill Registration ──────────────────────────────────────────

export function registerXPosterSkill(): void {
    // Tool 1: x_post
    registerSkill(
        {
            name: 'x_poster',
            description: 'Use this skill when Tony says "tweet this", "post to X", "post to Twitter", "schedule a tweet", "reply to that tweet", or "search Twitter for X". CRITICAL SAFETY RULE: ALWAYS show Tony the exact tweet text before posting and wait for explicit confirmation ("yes", "go ahead", "post it"). Never post to X/Twitter without Tony\'s explicit approval — queue it for review if unsure.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'x_post',
            description: 'Post a tweet to X/Twitter. Use when Tony says "tweet this", "post this to X", or "send this tweet". ALWAYS show Tony the exact tweet text first and wait for explicit approval before posting. By default queues for review — never bypasses unless Tony explicitly says to skip review.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'Tweet text (max 280 characters)',
                    },
                    skipReview: {
                        type: 'boolean',
                        description: 'Skip review queue and post immediately (requires autonomous mode)',
                    },
                },
                required: ['content'],
            },
            execute: async (args) => {
                const content = (args.content as string).slice(0, 280);
                const skipReview = args.skipReview as boolean;

                if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) {
                    return 'Error: X API credentials not configured. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET env vars.';
                }

                // Queue for review by default
                if (!skipReview) {
                    const post: QueuedPost = {
                        id: uuid().slice(0, 8),
                        type: 'post',
                        content,
                        status: 'pending',
                        createdAt: new Date().toISOString(),
                    };
                    addToQueue(post);
                    return `Tweet queued for review (ID: ${post.id}): "${content}"\nApprove via dashboard or x_review tool.`;
                }

                // Direct post
                const result = await postTweet(content);
                if (typeof result === 'string') return result;
                return `Tweet posted! ID: ${result.id}\nContent: ${result.text}`;
            },
        },
    );

    // Tool 2: x_reply
    registerSkill(
        {
            name: 'x_poster',
            description: 'Use this skill when Tony says "tweet this", "post to X", "post to Twitter", "schedule a tweet", "reply to that tweet", or "search Twitter for X". CRITICAL SAFETY RULE: ALWAYS show Tony the exact tweet text before posting and wait for explicit confirmation ("yes", "go ahead", "post it"). Never post to X/Twitter without Tony\'s explicit approval — queue it for review if unsure.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'x_reply',
            description: 'Reply to a specific tweet on X/Twitter. Use when Tony says "reply to that tweet", "respond to [tweet ID]", or "write a reply to [tweet]". ALWAYS show Tony the exact reply text and confirm before posting. Queue for review by default.',
            parameters: {
                type: 'object',
                properties: {
                    tweetId: {
                        type: 'string',
                        description: 'ID of the tweet to reply to',
                    },
                    content: {
                        type: 'string',
                        description: 'Reply text (max 280 characters)',
                    },
                    skipReview: {
                        type: 'boolean',
                        description: 'Skip review queue and reply immediately',
                    },
                },
                required: ['tweetId', 'content'],
            },
            execute: async (args) => {
                const tweetId = args.tweetId as string;
                const content = (args.content as string).slice(0, 280);
                const skipReview = args.skipReview as boolean;

                if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) {
                    return 'Error: X API credentials not configured.';
                }

                if (!skipReview) {
                    const post: QueuedPost = {
                        id: uuid().slice(0, 8),
                        type: 'reply',
                        content,
                        replyToId: tweetId,
                        status: 'pending',
                        createdAt: new Date().toISOString(),
                    };
                    addToQueue(post);
                    return `Reply queued for review (ID: ${post.id}): "${content}" → reply to ${tweetId}`;
                }

                const result = await postTweet(content, tweetId);
                if (typeof result === 'string') return result;
                return `Reply posted! ID: ${result.id}\nContent: ${result.text}\nIn reply to: ${tweetId}`;
            },
        },
    );

    // Tool 3: x_search
    registerSkill(
        {
            name: 'x_poster',
            description: 'Use this skill when Tony says "tweet this", "post to X", "post to Twitter", "schedule a tweet", "reply to that tweet", or "search Twitter for X". CRITICAL SAFETY RULE: ALWAYS show Tony the exact tweet text before posting and wait for explicit confirmation ("yes", "go ahead", "post it"). Never post to X/Twitter without Tony\'s explicit approval — queue it for review if unsure.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'x_search',
            description: 'Search recent tweets on X/Twitter. Use when Tony asks "search Twitter for X", "what\'s being said about [topic] on X?", or "find tweets about [query]". Read-only — no confirmation needed.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (supports X search operators)',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum results to return (default: 10, max: 100)',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                return searchTweets(
                    args.query as string,
                    (args.maxResults as number) || 10,
                );
            },
        },
    );

    // Tool 4: x_review
    registerSkill(
        {
            name: 'x_poster',
            description: 'Use this skill when Tony says "tweet this", "post to X", "post to Twitter", "schedule a tweet", "reply to that tweet", or "search Twitter for X". CRITICAL SAFETY RULE: ALWAYS show Tony the exact tweet text before posting and wait for explicit confirmation ("yes", "go ahead", "post it"). Never post to X/Twitter without Tony\'s explicit approval — queue it for review if unsure.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'x_review',
            description: 'Review, approve, or reject queued X/Twitter posts waiting for Tony\'s approval. Use when Tony says "show my tweet queue", "what tweets are pending?", "approve that tweet", or "reject that tweet".',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: '"list" to see queue, "approve" to approve a post, "reject" to reject',
                    },
                    postId: {
                        type: 'string',
                        description: 'Post ID to approve or reject (required for approve/reject)',
                    },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const postId = args.postId as string;
                const queue = loadQueue();

                if (action === 'list') {
                    const pending = queue.posts.filter(p => p.status === 'pending');
                    if (pending.length === 0) return 'Review queue is empty.';

                    const lines = ['Pending X posts for review:', ''];
                    for (const p of pending) {
                        lines.push(`[${p.id}] ${p.type}: "${p.content}"`);
                        if (p.replyToId) lines.push(`  Reply to: ${p.replyToId}`);
                        lines.push(`  Created: ${p.createdAt}`);
                        lines.push('');
                    }
                    return lines.join('\n');
                }

                if (action === 'approve' && postId) {
                    const post = queue.posts.find(p => p.id === postId);
                    if (!post) return `Post "${postId}" not found in queue.`;
                    if (post.status !== 'pending') return `Post "${postId}" is already ${post.status}.`;

                    const result = await postTweet(post.content, post.replyToId);
                    if (typeof result === 'string') return result;

                    post.status = 'posted';
                    post.postedAt = new Date().toISOString();
                    post.tweetId = result.id;
                    saveQueue(queue);

                    return `Approved and posted! Tweet ID: ${result.id}`;
                }

                if (action === 'reject' && postId) {
                    const post = queue.posts.find(p => p.id === postId);
                    if (!post) return `Post "${postId}" not found in queue.`;

                    post.status = 'rejected';
                    saveQueue(queue);
                    return `Post "${postId}" rejected.`;
                }

                return 'Usage: action="list" | action="approve" postId="..." | action="reject" postId="..."';
            },
        },
    );
}
