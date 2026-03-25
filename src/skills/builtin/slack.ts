/**
 * TITAN — Slack Skill (Built-in)
 * Proactive Slack tools: post, read, search, react, thread reply, list channels.
 * Includes a human review gate — messages are queued for approval before sending.
 *
 * Required env var: SLACK_BOT_TOKEN
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'Slack';
const REVIEW_QUEUE_PATH = join(TITAN_HOME, 'slack-review-queue.json');

// ─── Slack WebClient (lazy-loaded) ───────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let webClient: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getClient(): Promise<any> {
    if (webClient) return webClient;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('SLACK_BOT_TOKEN not configured. Set the SLACK_BOT_TOKEN environment variable.');
    try {
        // @ts-expect-error optional peer dependency — install with: npm install @slack/web-api
        const { WebClient } = await import('@slack/web-api');
        webClient = new WebClient(token);
        return webClient;
    } catch {
        throw new Error('Slack Web API not available. Install with: npm install @slack/web-api');
    }
}

// ─── Review Queue ────────────────────────────────────────────────

interface QueuedSlackMessage {
    id: string;
    channel: string;
    text: string;
    threadTs?: string;
    status: 'pending' | 'approved' | 'rejected' | 'sent';
    createdAt: string;
    sentAt?: string;
}

interface ReviewQueue {
    messages: QueuedSlackMessage[];
}

function loadQueue(): ReviewQueue {
    if (!existsSync(REVIEW_QUEUE_PATH)) return { messages: [] };
    try {
        return JSON.parse(readFileSync(REVIEW_QUEUE_PATH, 'utf-8')) as ReviewQueue;
    } catch {
        return { messages: [] };
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

function addToQueue(msg: QueuedSlackMessage): void {
    const queue = loadQueue();
    queue.messages.push(msg);
    saveQueue(queue);
}

// ─── Helpers ─────────────────────────────────────────────────────

const userCache = new Map<string, string>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveUserName(client: any, userId: string): Promise<string> {
    if (userCache.has(userId)) return userCache.get(userId)!;
    try {
        const res = await client.users.info({ user: userId });
        const name = res.user?.real_name || res.user?.name || userId;
        userCache.set(userId, name);
        return name;
    } catch {
        return userId;
    }
}

async function sendSlackMessage(channel: string, text: string, threadTs?: string): Promise<{ ok: boolean; ts?: string; error?: string }> {
    const client = await getClient();
    try {
        const payload: Record<string, unknown> = { channel, text };
        if (threadTs) payload.thread_ts = threadTs;
        const res = await client.chat.postMessage(payload);
        return { ok: res.ok, ts: res.ts };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

// ─── Skill Meta ──────────────────────────────────────────────────

const SKILL_META = {
    name: 'slack',
    description: 'Slack tools for posting, reading, searching, reacting, and managing channels. USE THIS WHEN Tony says: "send to Slack", "post in #channel", "DM X on Slack", "read Slack messages", "search Slack for X", "react to that message", "reply in thread". RULES: Requires SLACK_BOT_TOKEN. Messages are queued for review before sending unless skipReview=true.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

// ─── Skill Registration ──────────────────────────────────────────

export function registerSlackSkill(): void {
    // Tool 1: slack_post
    registerSkill(
        { ...SKILL_META },
        {
            name: 'slack_post',
            description: 'Posts a message to a Slack channel. USE THIS WHEN Tony says: "send to Slack", "post in #channel", "message the team on Slack", "post X to #general". WORKFLOW: Call slack_post with channel and text. Message is queued for review — Tony must approve via slack_review unless skipReview=true. RULES: Use channel ID or name with #. Messages are held for review by default.',
            parameters: {
                type: 'object',
                properties: {
                    channel: {
                        type: 'string',
                        description: 'Slack channel ID or name (e.g., C01234567 or #general)',
                    },
                    text: {
                        type: 'string',
                        description: 'Message text to post',
                    },
                    threadTs: {
                        type: 'string',
                        description: 'Thread timestamp to reply in a thread (optional)',
                    },
                    skipReview: {
                        type: 'boolean',
                        description: 'Skip review queue and post immediately (default: false)',
                    },
                },
                required: ['channel', 'text'],
            },
            execute: async (args) => {
                const channel = args.channel as string;
                const text = args.text as string;
                const threadTs = args.threadTs as string | undefined;
                const skipReview = args.skipReview as boolean;

                if (!skipReview) {
                    const msg: QueuedSlackMessage = {
                        id: uuid().slice(0, 8),
                        channel,
                        text,
                        threadTs,
                        status: 'pending',
                        createdAt: new Date().toISOString(),
                    };
                    addToQueue(msg);
                    return `Slack message queued for review (ID: ${msg.id}): "${text}" → ${channel}\nApprove via slack_review tool.`;
                }

                const result = await sendSlackMessage(channel, text, threadTs);
                if (!result.ok) return `Slack API error: ${result.error}`;
                return `Message posted to ${channel}! Timestamp: ${result.ts}`;
            },
        },
    );

    // Tool 2: slack_read
    registerSkill(
        { ...SKILL_META },
        {
            name: 'slack_read',
            description: 'Reads recent messages from a Slack channel. USE THIS WHEN Tony says: "read Slack messages", "what\'s in #channel", "show recent Slack messages", "what did people say in #general".',
            parameters: {
                type: 'object',
                properties: {
                    channel: {
                        type: 'string',
                        description: 'Slack channel ID (e.g., C01234567)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Number of messages to fetch (default: 20)',
                    },
                    oldest: {
                        type: 'string',
                        description: 'Only messages after this Unix timestamp (optional)',
                    },
                },
                required: ['channel'],
            },
            execute: async (args) => {
                const channel = args.channel as string;
                const limit = (args.limit as number) || 20;
                const oldest = args.oldest as string | undefined;

                const client = await getClient();

                try {
                    const payload: Record<string, unknown> = { channel, limit };
                    if (oldest) payload.oldest = oldest;
                    const res = await client.conversations.history(payload);

                    if (!res.ok || !res.messages || res.messages.length === 0) {
                        return `No messages found in ${channel}.`;
                    }

                    const lines: string[] = [`Messages from ${channel} (${res.messages.length}):`, ''];
                    for (const msg of res.messages) {
                        const userName = msg.user ? await resolveUserName(client, msg.user) : 'unknown';
                        const ts = msg.ts || '';
                        const text = (msg.text || '').slice(0, 500);
                        lines.push(`[${ts}] @${userName}: ${text}`);
                    }
                    return lines.join('\n');
                } catch (e) {
                    return `Slack API error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: slack_search
    registerSkill(
        { ...SKILL_META },
        {
            name: 'slack_search',
            description: 'Searches Slack messages using a query string. USE THIS WHEN Tony says: "search Slack for X", "find messages about Y in Slack", "who mentioned X in Slack". NOTE: Requires a user token with search:read scope — bot tokens cannot search.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query string',
                    },
                    count: {
                        type: 'number',
                        description: 'Number of results to return (default: 20)',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                const query = args.query as string;
                const count = (args.count as number) || 20;

                const client = await getClient();

                try {
                    const res = await client.search.messages({ query, count });

                    if (!res.ok) {
                        return `Slack search error: ${res.error || 'Unknown error'}`;
                    }

                    const matches = res.messages?.matches;
                    if (!matches || matches.length === 0) {
                        return `No results found for "${query}".`;
                    }

                    const lines: string[] = [`Slack search: "${query}" (${matches.length} results)`, ''];
                    for (const match of matches) {
                        const channel = match.channel?.name || 'unknown';
                        const user = match.username || match.user || 'unknown';
                        const ts = match.ts || '';
                        const text = (match.text || '').slice(0, 300);
                        lines.push(`[#${channel}] [${ts}] @${user}: ${text}`);
                        lines.push('');
                    }
                    return lines.join('\n');
                } catch (e) {
                    const errMsg = (e as Error).message;
                    if (errMsg.includes('missing_scope') || errMsg.includes('not_allowed_token_type')) {
                        return `Slack search requires a user token with search:read scope. Bot tokens cannot use the search API. Error: ${errMsg}`;
                    }
                    return `Slack search error: ${errMsg}`;
                }
            },
        },
    );

    // Tool 4: slack_react
    registerSkill(
        { ...SKILL_META },
        {
            name: 'slack_react',
            description: 'Adds an emoji reaction to a Slack message. USE THIS WHEN Tony says: "react to that Slack message", "add a thumbsup to message X", "react with rocket emoji".',
            parameters: {
                type: 'object',
                properties: {
                    channel: {
                        type: 'string',
                        description: 'Slack channel ID containing the message',
                    },
                    timestamp: {
                        type: 'string',
                        description: 'Message timestamp to react to (e.g., 1234567890.123456)',
                    },
                    emoji: {
                        type: 'string',
                        description: 'Emoji name without colons (e.g., thumbsup, rocket, white_check_mark)',
                    },
                },
                required: ['channel', 'timestamp', 'emoji'],
            },
            execute: async (args) => {
                const channel = args.channel as string;
                const timestamp = args.timestamp as string;
                const emoji = args.emoji as string;

                const client = await getClient();

                try {
                    const res = await client.reactions.add({ channel, timestamp, name: emoji });
                    if (!res.ok) return `Slack reaction error: ${res.error || 'Unknown error'}`;
                    return `Reaction :${emoji}: added to message ${timestamp} in ${channel}.`;
                } catch (e) {
                    return `Slack reaction error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 5: slack_thread_reply
    registerSkill(
        { ...SKILL_META },
        {
            name: 'slack_thread_reply',
            description: 'Replies to a specific Slack thread. USE THIS WHEN Tony says: "reply in that Slack thread", "respond to the thread", "DM reply in thread X". WORKFLOW: Provide channel, threadTs, and text. Message is queued for review unless skipReview=true.',
            parameters: {
                type: 'object',
                properties: {
                    channel: {
                        type: 'string',
                        description: 'Slack channel ID containing the thread',
                    },
                    threadTs: {
                        type: 'string',
                        description: 'Thread parent timestamp to reply to',
                    },
                    text: {
                        type: 'string',
                        description: 'Reply text',
                    },
                    skipReview: {
                        type: 'boolean',
                        description: 'Skip review queue and reply immediately (default: false)',
                    },
                },
                required: ['channel', 'threadTs', 'text'],
            },
            execute: async (args) => {
                const channel = args.channel as string;
                const threadTs = args.threadTs as string;
                const text = args.text as string;
                const skipReview = args.skipReview as boolean;

                if (!skipReview) {
                    const msg: QueuedSlackMessage = {
                        id: uuid().slice(0, 8),
                        channel,
                        text,
                        threadTs,
                        status: 'pending',
                        createdAt: new Date().toISOString(),
                    };
                    addToQueue(msg);
                    return `Thread reply queued for review (ID: ${msg.id}): "${text}" → ${channel} thread ${threadTs}\nApprove via slack_review tool.`;
                }

                const result = await sendSlackMessage(channel, text, threadTs);
                if (!result.ok) return `Slack API error: ${result.error}`;
                return `Thread reply posted to ${channel} (thread ${threadTs})! Timestamp: ${result.ts}`;
            },
        },
    );

    // Tool 6: slack_channels
    registerSkill(
        { ...SKILL_META },
        {
            name: 'slack_channels',
            description: 'Lists available Slack channels the bot has access to. USE THIS WHEN Tony says: "list Slack channels", "what channels am I in", "show Slack channels", "what channels does the bot have access to".',
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: 'Maximum channels to return (default: 100)',
                    },
                    types: {
                        type: 'string',
                        description: 'Comma-separated channel types (default: "public_channel,private_channel")',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                const limit = (args.limit as number) || 100;
                const types = (args.types as string) || 'public_channel,private_channel';

                const client = await getClient();

                try {
                    const res = await client.conversations.list({ limit, types });

                    if (!res.ok || !res.channels || res.channels.length === 0) {
                        return 'No channels found or no access.';
                    }

                    const lines: string[] = [`Slack channels (${res.channels.length}):`, ''];
                    for (const ch of res.channels) {
                        const name = ch.name || 'unnamed';
                        const id = ch.id || '';
                        const members = ch.num_members || 0;
                        const topic = ch.topic?.value ? ` — ${ch.topic.value.slice(0, 80)}` : '';
                        lines.push(`#${name} (ID: ${id}) — ${members} members${topic}`);
                    }
                    return lines.join('\n');
                } catch (e) {
                    return `Slack API error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 7: slack_review
    registerSkill(
        { ...SKILL_META },
        {
            name: 'slack_review',
            description: 'Reviews and approves or rejects queued Slack messages. USE THIS WHEN Tony says: "show pending Slack messages", "approve that Slack message", "reject the queued message", "what Slack messages are waiting". WORKFLOW: action=list to see queue, action=approve with messageId to send, action=reject to discard.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: '"list" to see queue, "approve" to send a message, "reject" to reject',
                    },
                    messageId: {
                        type: 'string',
                        description: 'Message ID to approve or reject (required for approve/reject)',
                    },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const messageId = args.messageId as string;
                const queue = loadQueue();

                if (action === 'list') {
                    const pending = queue.messages.filter(m => m.status === 'pending');
                    if (pending.length === 0) return 'Slack review queue is empty.';

                    const lines: string[] = ['Pending Slack messages for review:', ''];
                    for (const m of pending) {
                        lines.push(`[${m.id}] → ${m.channel}: "${m.text}"`);
                        if (m.threadTs) lines.push(`  Thread: ${m.threadTs}`);
                        lines.push(`  Created: ${m.createdAt}`);
                        lines.push('');
                    }
                    return lines.join('\n');
                }

                if (action === 'approve' && messageId) {
                    const msg = queue.messages.find(m => m.id === messageId);
                    if (!msg) return `Message "${messageId}" not found in queue.`;
                    if (msg.status !== 'pending') return `Message "${messageId}" is already ${msg.status}.`;

                    const result = await sendSlackMessage(msg.channel, msg.text, msg.threadTs);
                    if (!result.ok) return `Failed to send: ${result.error}`;

                    msg.status = 'sent';
                    msg.sentAt = new Date().toISOString();
                    saveQueue(queue);

                    return `Approved and sent! Message delivered to ${msg.channel} (ts: ${result.ts}).`;
                }

                if (action === 'reject' && messageId) {
                    const msg = queue.messages.find(m => m.id === messageId);
                    if (!msg) return `Message "${messageId}" not found in queue.`;

                    msg.status = 'rejected';
                    saveQueue(queue);
                    return `Message "${messageId}" rejected.`;
                }

                return 'Usage: action="list" | action="approve" messageId="..." | action="reject" messageId="..."';
            },
        },
    );
}
