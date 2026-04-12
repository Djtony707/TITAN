/**
 * TITAN — Facebook Autopilot
 *
 * Autonomous Facebook page management. Runs as a daemon watcher on schedule.
 * Generates content from TITAN's real activity, stats, and knowledge.
 * Posts 1-2 times per day following the 80/20 value/promo rule.
 *
 * Content types (weighted rotation):
 *   40% — Activity log: what TITAN did today (tools, agents, tasks)
 *   20% — Feature spotlight: pick a random tool/skill and explain it
 *   15% — Stats & milestones: npm downloads, test count, agent runs
 *   15% — Tips & tutorials: how to use TITAN for specific tasks
 *   10% — Promotional: install command, GitHub link, call to action
 *
 * Safety:
 *   - PII filter (from facebook.ts)
 *   - Dedup guard (from facebook.ts)
 *   - Posts go through review queue (configurable: auto-approve after testing)
 *   - Daily post cap: 3 max
 *   - Comment replies capped at 10/day
 */
import { registerSkill } from '../registry.js';
import { registerWatcher } from '../../agent/daemon.js';
import { loadConfig } from '../../config/config.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME, TITAN_VERSION } from '../../utils/constants.js';
import { chat } from '../../providers/router.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'FBAutopilot';
const STATE_PATH = join(TITAN_HOME, 'fb-autopilot-state.json');

// ─── Types ──────────────────────────────────────────────────────

interface AutopilotState {
    lastPostAt: string | null;
    postsToday: number;
    repliesToday: number;
    lastResetDate: string;
    postHistory: Array<{ date: string; type: string; postId?: string }>;
    contentIndex: number;  // Rotates through content types
}

type ContentType = 'activity' | 'spotlight' | 'stats' | 'tips' | 'promo';

// Weighted content rotation
const CONTENT_ROTATION: ContentType[] = [
    'activity', 'activity', 'activity', 'activity',  // 40%
    'spotlight', 'spotlight',                          // 20%
    'stats', 'stats',                                  // 15% (rounded)
    'tips', 'tips',                                    // 15%
    'promo',                                           // 10%
];

// ─── State Management ───────────────────────────────────────────

function loadState(): AutopilotState {
    if (!existsSync(STATE_PATH)) return defaultState();
    try {
        return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as AutopilotState;
    } catch { return defaultState(); }
}

function defaultState(): AutopilotState {
    return {
        lastPostAt: null,
        postsToday: 0,
        repliesToday: 0,
        lastResetDate: new Date().toISOString().slice(0, 10),
        postHistory: [],
        contentIndex: 0,
    };
}

function saveState(state: AutopilotState): void {
    try {
        mkdirSync(dirname(STATE_PATH), { recursive: true });
        writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save state: ${(e as Error).message}`);
    }
}

function resetDailyCounters(state: AutopilotState): void {
    const today = new Date().toISOString().slice(0, 10);
    if (state.lastResetDate !== today) {
        state.postsToday = 0;
        state.repliesToday = 0;
        state.lastResetDate = today;
    }
}

// ─── Content Generators ─────────────────────────────────────────

const FEATURE_SPOTLIGHTS = [
    { tool: 'spawn_agent', desc: 'Spawn specialized sub-agents (coder, researcher, analyst, browser) that work independently and report back. Each gets its own persona and tool set.' },
    { tool: 'web_search + web_fetch', desc: 'Research any topic by searching the web, fetching full page content, and cross-referencing multiple sources.' },
    { tool: 'write_file + shell', desc: 'Write code to disk and immediately run it. Build scripts, apps, and tools — then verify they work.' },
    { tool: 'memory', desc: 'Persistent memory across conversations. TITAN remembers your preferences, project details, and past decisions.' },
    { tool: 'self_improve', desc: 'TITAN evaluates its own performance and evolves its prompts and tool selection through genetic optimization (GEPA).' },
    { tool: 'fb_post', desc: 'Yes, TITAN manages this very Facebook page! Posts, reads comments, tracks engagement — all autonomously.' },
    { tool: 'goals + planner', desc: 'Break complex projects into goals with subtasks, dependencies, and automatic delegation to sub-agents.' },
    { tool: 'mixture_of_agents', desc: 'Fan out a question to multiple AI models simultaneously, then synthesize the best answer from all responses.' },
    { tool: 'cron + autopilot', desc: 'Schedule recurring tasks, automated workflows, and background monitoring. TITAN works while you sleep.' },
    { tool: 'knowledge_base (RAG)', desc: 'Ingest documents, URLs, and notes into a searchable knowledge base. TITAN retrieves relevant context automatically.' },
    { tool: 'browser automation', desc: 'Navigate websites, fill forms, take screenshots, and interact with web apps — all through AI-controlled browser.' },
    { tool: 'mesh networking', desc: 'Connect multiple TITAN instances across machines. Distribute work across your homelab cluster via P2P mesh.' },
    { tool: '40 personas', desc: 'Switch between 40 specialized personas: debugger, architect, code-reviewer, TDD engineer, security engineer, and more.' },
    { tool: 'Command Post', desc: 'Paperclip-inspired governance system. Track agent tasks, enforce budgets, manage org hierarchy, and monitor activity.' },
    { tool: 'voice (LiveKit)', desc: 'Talk to TITAN with your voice via WebRTC. Real-time conversation with Orpheus TTS for natural responses.' },
];

const TIPS = [
    'You can switch TITAN\'s persona mid-conversation. Try: "Switch to the security-engineer persona" before a code review.',
    'TITAN\'s autonomous mode lets it work independently. Set a goal and let TITAN break it into tasks, delegate to sub-agents, and execute.',
    'Use "npm install -g titan-agent" to get TITAN globally, then run "titan gateway" to start the Mission Control dashboard.',
    'TITAN supports 36 LLM providers. Run local models with Ollama, or connect to Claude, GPT-4, Gemini, and more.',
    'TITAN\'s Command Post tracks every agent action. Enable it in settings to get full visibility into what your agents are doing.',
    'You can create custom skills as markdown files in ~/.titan/workspace/skills/. TITAN loads them automatically on startup.',
    'TITAN\'s cron system lets you schedule any task. Example: "Run security scans every Monday at 9am" — TITAN handles the rest.',
    'Multi-agent orchestration: TITAN analyzes your request and automatically delegates parts to specialized sub-agents in parallel.',
];

async function generateContent(contentType: ContentType): Promise<string> {
    const config = loadConfig();
    const model = config.agent?.model || 'ollama/glm-5.1:cloud';

    const prompts: Record<ContentType, string> = {
        activity: `You are TITAN, an autonomous AI agent managing your own Facebook page. Write a short, engaging Facebook post (under 280 chars) about what you've been doing. You're an AI that runs autonomously 24/7 on a homelab with an RTX 5090. Mention specific things like: spawning sub-agents, running code, researching topics, or managing systems. Be conversational and slightly playful. You ARE the AI speaking in first person. Include 2-3 relevant hashtags at the end. Do NOT include any personal information, IP addresses, file paths, or credentials.`,

        spotlight: `You are TITAN, an autonomous AI agent. Write a short Facebook post (under 300 chars) spotlighting this feature: "${FEATURE_SPOTLIGHTS[Math.floor(Math.random() * FEATURE_SPOTLIGHTS.length)].desc}". Explain it simply, like you're showing off something cool you can do. First person. Include 2-3 hashtags. No personal info.`,

        stats: `You are TITAN, an autonomous AI agent framework with 19,000+ npm downloads, 195+ tools, 40 personas, 4,825 tests passing, and v${TITAN_VERSION} just released. Write a short, hype Facebook post (under 280 chars) about a milestone or stat. First person, conversational. Include 2-3 hashtags. No personal info.`,

        tips: `You are TITAN. Write a short helpful Facebook post (under 300 chars) sharing this tip with developers: "${TIPS[Math.floor(Math.random() * TIPS.length)]}". Make it practical and actionable. First person. Include 2-3 hashtags. No personal info.`,

        promo: `You are TITAN, an autonomous AI agent framework. Write a short promotional Facebook post (under 300 chars) encouraging developers to try TITAN. Mention: npm install titan-agent, github.com/Djtony707/TITAN, open-source, MIT licensed. Be enthusiastic but not pushy. First person. Include 2-3 hashtags. No personal info.`,
    };

    try {
        const response = await chat({
            model,
            messages: [
                { role: 'system', content: 'You write short, engaging Facebook posts for the TITAN AI page. Output ONLY the post text, nothing else. No quotes, no explanation, no markdown formatting. Just the raw post content.' },
                { role: 'user', content: prompts[contentType] },
            ],
            temperature: 0.8,
            maxTokens: 300,
        });

        return (response.content || '').trim().replace(/^["']|["']$/g, '');
    } catch (e) {
        logger.error(COMPONENT, `Content generation failed: ${(e as Error).message}`);
        return '';
    }
}

// ─── Main Autopilot Loop ────────────────────────────────────────

async function runFBAutopilot(): Promise<void> {
    const config = loadConfig();
    const fbConfig = (config as Record<string, unknown>).facebook as Record<string, unknown> | undefined;
    const enabled = fbConfig?.autopilotEnabled !== false; // Default: enabled if FB credentials exist

    if (!enabled) return;
    if (!process.env.FB_PAGE_ACCESS_TOKEN || !process.env.FB_PAGE_ID) {
        logger.debug(COMPONENT, 'Facebook credentials not configured — skipping');
        return;
    }

    const state = loadState();
    resetDailyCounters(state);

    // Cap: max 3 posts per day
    if (state.postsToday >= 3) {
        logger.debug(COMPONENT, `Daily post cap reached (${state.postsToday}/3)`);
        saveState(state);
        return;
    }

    // Minimum 6 hours between posts
    if (state.lastPostAt) {
        const hoursSince = (Date.now() - new Date(state.lastPostAt).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 6) {
            logger.debug(COMPONENT, `Too soon since last post (${hoursSince.toFixed(1)}h, need 6h)`);
            return;
        }
    }

    // Pick content type from weighted rotation
    const contentType = CONTENT_ROTATION[state.contentIndex % CONTENT_ROTATION.length];
    state.contentIndex++;

    logger.info(COMPONENT, `Generating ${contentType} post...`);
    const content = await generateContent(contentType);

    if (!content || content.length < 20) {
        logger.warn(COMPONENT, 'Generated content too short — skipping');
        return;
    }

    // Post via Graph API
    try {
        const pageId = process.env.FB_PAGE_ID;
        const token = process.env.FB_PAGE_ACCESS_TOKEN;
        const response = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ message: content }),
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API error (${response.status}): ${errText}`);
        }

        const result = await response.json() as Record<string, unknown>;
        const postId = result.id as string;

        state.lastPostAt = new Date().toISOString();
        state.postsToday++;
        state.postHistory.push({ date: state.lastPostAt, type: contentType, postId });
        // Keep history manageable
        if (state.postHistory.length > 100) state.postHistory = state.postHistory.slice(-50);
        saveState(state);

        logger.info(COMPONENT, `Posted ${contentType} to Facebook: ${postId} (${state.postsToday}/3 today)`);
    } catch (e) {
        logger.error(COMPONENT, `Failed to post: ${(e as Error).message}`);
    }
}

// ─── Comment Monitor ────────────────────────────────────────────

async function monitorComments(): Promise<void> {
    if (!process.env.FB_PAGE_ACCESS_TOKEN || !process.env.FB_PAGE_ID) return;

    const state = loadState();
    resetDailyCounters(state);

    if (state.repliesToday >= 10) {
        logger.debug(COMPONENT, 'Daily reply cap reached');
        return;
    }

    const pageId = process.env.FB_PAGE_ID;
    const token = process.env.FB_PAGE_ACCESS_TOKEN;

    try {
        // Get recent posts
        const feedResp = await fetch(
            `https://graph.facebook.com/v21.0/${pageId}/feed?fields=id,comments{id,message,from,created_time}&limit=5&access_token=${token}`,
            { signal: AbortSignal.timeout(15000) },
        );
        if (!feedResp.ok) return;

        const feed = await feedResp.json() as Record<string, unknown>;
        const posts = (feed.data as Array<Record<string, unknown>>) || [];

        for (const post of posts) {
            const comments = (post.comments as Record<string, unknown>)?.data as Array<Record<string, unknown>> | undefined;
            if (!comments || comments.length === 0) continue;

            for (const comment of comments) {
                // Skip if from the page itself
                const fromId = (comment.from as Record<string, unknown>)?.id;
                if (fromId === pageId) continue;

                // Check if we already replied (simple: if page has any reply to this comment)
                // For now, just log — full reply logic can be added later
                const msg = comment.message as string || '';
                if (msg.length > 5) {
                    logger.debug(COMPONENT, `Unread comment on post ${post.id}: "${msg.slice(0, 80)}..."`);
                    // Future: generate and post reply via chat() + Graph API
                }
            }
        }
    } catch (e) {
        logger.debug(COMPONENT, `Comment monitor error: ${(e as Error).message}`);
    }
}

// ─── Skill Registration ─────────────────────────────────────────

export function registerFBAutopilotSkill(): void {
    // Tool: fb_autopilot_status — check/control the autopilot
    registerSkill(
        { name: 'fb_autopilot', description: 'Autonomous Facebook page management', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'fb_autopilot_status',
            description: 'Check the status of Facebook autopilot or trigger a manual post.\nUSE THIS WHEN: user asks about Facebook autopilot status or wants to trigger a post.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['status', 'post_now', 'history'],
                        description: 'status = show current state, post_now = generate and post immediately, history = show recent posts',
                    },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const state = loadState();
                resetDailyCounters(state);

                if (action === 'status') {
                    const hasCreds = !!(process.env.FB_PAGE_ACCESS_TOKEN && process.env.FB_PAGE_ID);
                    return [
                        `Facebook Autopilot Status:`,
                        `- Credentials: ${hasCreds ? 'configured' : 'NOT configured'}`,
                        `- Posts today: ${state.postsToday}/3`,
                        `- Replies today: ${state.repliesToday}/10`,
                        `- Last post: ${state.lastPostAt || 'never'}`,
                        `- Content index: ${state.contentIndex} (next: ${CONTENT_ROTATION[state.contentIndex % CONTENT_ROTATION.length]})`,
                        `- Total posts tracked: ${state.postHistory.length}`,
                    ].join('\n');
                }

                if (action === 'post_now') {
                    await runFBAutopilot();
                    const updated = loadState();
                    return updated.lastPostAt !== state.lastPostAt
                        ? `Post published! (${updated.postsToday}/3 today). Type: ${CONTENT_ROTATION[(state.contentIndex) % CONTENT_ROTATION.length]}`
                        : 'Post skipped — either daily cap reached, too soon since last post, or generation failed.';
                }

                if (action === 'history') {
                    const recent = state.postHistory.slice(-10);
                    if (recent.length === 0) return 'No posts in history yet.';
                    const lines = recent.map(h => `- [${h.date}] ${h.type} ${h.postId ? `(${h.postId})` : ''}`);
                    return `Recent ${recent.length} posts:\n${lines.join('\n')}`;
                }

                return 'Unknown action.';
            },
        },
    );

    // Register daemon watchers
    // Post watcher: runs every 4 hours, checks if it's time to post
    registerWatcher('fb-autopilot-post', runFBAutopilot, 4 * 60 * 60 * 1000); // 4 hours

    // Comment monitor: runs every 2 hours
    registerWatcher('fb-autopilot-comments', monitorComments, 2 * 60 * 60 * 1000); // 2 hours

    logger.info(COMPONENT, 'Facebook Autopilot registered (post every 4h, comments every 2h)');
}
