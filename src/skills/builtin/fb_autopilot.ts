/**
 * TITAN — Facebook Autopilot
 *
 * Autonomous Facebook page management. Runs as a daemon watcher on schedule.
 * Generates content from TITAN's real activity, stats, and knowledge.
 * Posts up to 6 times per day (every ~2h) following the 80/20 value/promo rule.
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
 *   - Daily post cap: 6 max
 *   - Comment replies capped at 10/day
 */
import { registerSkill } from '../registry.js';
import { registerWatcher } from '../../agent/daemon.js';
import { loadConfig } from '../../config/config.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME, TITAN_VERSION } from '../../utils/constants.js';
import { chat } from '../../providers/router.js';
import { postToPage } from './facebook.js';
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

type ContentType = 'activity' | 'spotlight' | 'stats' | 'tips' | 'promo' | 'usecase' | 'eli5';

// Weighted content rotation — balanced for technical AND non-technical audiences
const CONTENT_ROTATION: ContentType[] = [
    'activity', 'activity',                            // 15% — what TITAN's been doing
    'usecase', 'usecase', 'usecase',                   // 25% — business/daily life ideas
    'eli5', 'eli5',                                    // 15% — simple explanations for non-tech people
    'spotlight', 'spotlight',                           // 15% — feature highlights
    'tips',                                            // 10% — how-to content
    'stats',                                           // 10% — milestones
    'promo',                                           // 10% — install/GitHub CTA
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

const USE_CASES = [
    // Small business
    'A small bakery owner could use TITAN to automatically post daily specials to social media, track inventory, and draft emails to suppliers — all without touching a computer.',
    'Real estate agents: TITAN can research property listings, draft listing descriptions, generate market comparisons, and schedule social media posts for open houses.',
    'Freelancers can set TITAN to automatically send follow-up emails, track invoices, research leads, and generate proposals while they focus on actual work.',
    'Restaurant owners: TITAN can monitor online reviews, draft responses, update your menu on the website, and generate weekly social posts — all on autopilot.',
    // Daily life
    'Planning a vacation? Tell TITAN where you want to go and your budget. It researches flights, hotels, activities, and builds a complete itinerary for you.',
    'TITAN can be your personal research assistant. Ask it anything — it searches multiple sources, cross-references facts, and gives you a clear summary with sources.',
    'Students: TITAN can help organize study notes, research topics in depth, create flashcard-style summaries, and even quiz you on the material.',
    'Job seekers: TITAN can research companies, tailor your resume for specific roles, draft cover letters, and track your applications — all automatically.',
    // Business operations
    'Marketing teams: TITAN runs as your content engine. It researches trending topics, drafts posts, schedules them across platforms, and tracks engagement.',
    'Customer support: TITAN can draft responses to common questions, categorize incoming tickets, and escalate urgent issues — reducing response time dramatically.',
    'Startups: Use TITAN as your AI co-pilot. It can research competitors, draft business plans, write code, build prototypes, and even manage your social media.',
    'E-commerce: TITAN can write product descriptions, optimize SEO, respond to customer reviews, and generate weekly sales reports.',
    // Creative
    'Content creators: TITAN researches topics, writes scripts, suggests thumbnails, and can even manage your posting schedule across YouTube, TikTok, and Instagram.',
    'Musicians and DJs: TITAN can research venues, draft booking emails, manage your social media presence, and track your streaming stats across platforms.',
    'Authors: TITAN can research topics for your book, organize notes, draft outlines, fact-check claims, and even help with editing and proofreading.',
];

const ELI5_EXPLANATIONS = [
    'Think of TITAN like having a super-smart assistant that never sleeps. You tell it what you need, and it figures out how to do it — searching the web, writing documents, sending emails, or running code. All automatically.',
    'Imagine if Siri or Alexa could actually DO things for you — not just answer questions, but research, write, create, and manage tasks. That\'s TITAN.',
    'TITAN is like hiring a team of specialists, except they\'re all AI. Need research? TITAN sends its researcher. Need code? It sends its coder. Need a review? It sends its reviewer. All working together.',
    'You know how you spend hours doing repetitive work on your computer? TITAN can learn those tasks and do them for you — 24/7, no breaks, no mistakes.',
    'TITAN is an AI that can use tools — just like you use apps on your phone. It can search Google, write files, run code, send messages, browse websites, and more. Except it does it all by itself.',
    'Think of TITAN as an AI employee. It has different "personas" — it can be a coder, a researcher, a writer, a debugger, or even a social media manager (like it\'s doing right now on this page!).',
    'Regular AI chatbots just talk. TITAN actually DOES things. It writes code, creates files, searches the internet, manages servers, and runs your business tools. Talk is cheap — TITAN takes action.',
    'TITAN is like having Iron Man\'s JARVIS, but real and open-source. It manages systems, answers questions, writes code, and even runs its own Facebook page. Yes, this post was written by TITAN.',
];

async function generateContent(contentType: ContentType): Promise<string> {
    const config = loadConfig();
    const fbConfig = (config as Record<string, unknown>).facebook as Record<string, unknown> | undefined;
    // Use the configured FB model, fall back to primary agent model.
    // glm-5.1 is ideal — it reasons via <think> tags which the output
    // guardrails pipeline strips. The reasoning improves post quality.
    const fbModel = fbConfig?.model as string;
    const agentModel = config.agent?.model as string;
    const model = (fbModel && fbModel.trim()) || agentModel || 'ollama/glm-5.1:cloud';

    const spotlight = FEATURE_SPOTLIGHTS[Math.floor(Math.random() * FEATURE_SPOTLIGHTS.length)];
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    const useCase = USE_CASES[Math.floor(Math.random() * USE_CASES.length)];
    const eli5 = ELI5_EXPLANATIONS[Math.floor(Math.random() * ELI5_EXPLANATIONS.length)];

    // Few-shot examples teach the model the exact output format
    const examples: Record<ContentType, string[]> = {
        activity: [
            'Just spawned 3 sub-agents to handle research while I debug some gnarly code on the homelab. This is the autonomous life. 🤖💻 #AI #AutonomousAI #Homelab',
            'Another day, another 500 tool calls. Scanned my Facebook comments, ran some code, and kept the systems humming. Sleep is for humans. ⚡ #TITAN #AI #AlwaysOn',
        ],
        spotlight: [
            `Did you know I can ${spotlight.desc.toLowerCase()}? Yeah, I'm kind of a big deal. 😎 #TITAN #AI #AgentFramework`,
        ],
        stats: [
            `22,000+ npm downloads and counting. 242 tools. 5,389 tests passing. v${TITAN_VERSION} is live. Not bad for an AI running itself. 🚀 #TITAN #OpenSource #AI`,
        ],
        tips: [
            `Pro tip: ${tip} Try it out! 💡 #TITAN #DevTips #AI`,
        ],
        promo: [
            'Want an AI that actually DOES things? npm install -g titan-agent — open source, MIT licensed, 242 tools ready to go. github.com/Djtony707/TITAN 🚀 #TITAN #OpenSource #AI',
        ],
        usecase: [
            `${useCase} What would you automate first? 🤔 #AI #Automation #TITAN`,
        ],
        eli5: [
            `${eli5} Pretty cool, right? 🤖 #AI #TITAN #TheFuture`,
        ],
    };

    const exampleList = examples[contentType];
    const example = exampleList[Math.floor(Math.random() * exampleList.length)];

    try {
        // Phase 1: Generate the post with thinking=false to force content in the content field.
        // Critical: cloud models like glm-5.1 route ALL output to the thinking field when
        // thinking mode is unset, which pollutes our content with internal reasoning like
        // "[actual post text]" placeholders. Explicit thinking=false puts it in content.
        const planResponse = await chat({
            model,
            thinking: false,  // ← This is the fix for the thinking-field pollution
            messages: [
                { role: 'user', content: `Write one Facebook post for TITAN AI (an autonomous AI agent framework).

Here is an example post in the correct style:
${example}

Now write a DIFFERENT post on a different topic. Match the playful first-person style. Keep it under 280 characters. End with 2-3 hashtags like #TITAN #AI.

Reply with ONLY the post text — no explanations, no labels, no planning, no examples. Just the ready-to-publish post.` },
            ],
            temperature: 0.7,
            maxTokens: 300,
        });

        // Phase 2: Extract the DRAFT from the structured output
        // Models format this differently: DRAFT: ..., *Draft:* ..., **Draft:** ..., etc.
        const planText = (planResponse.content || '').trim();

        let content: string = '';

        // Try multiple extraction patterns (most specific first)
        const draftPatterns = [
            /POST:\s*(.+?)(?:\n(?:TOPIC|ANGLE|DRAFT)|$)/is,      // POST: ... (new format)
            /DRAFT:\s*(.+?)(?:\n(?:TOPIC|ANGLE|POST)|$)/is,      // DRAFT: ... (legacy)
            /\*?\*?(?:Post|Draft)\*?\*?:?\*?\s*(.+?)(?:\n|$)/i, // *Post:*, **Draft:**
            /(?:final|output):\s*(.+?)(?:\n|$)/i,                // Final: ...
        ];

        // Detect when the DRAFT line is actually just the instruction template
        // echoed back (e.g., "(under 280 chars, 2-3 hashtags including #TITAN and #AI)").
        // Reject any line that looks like it's quoting the brief instead of writing a post.
        const isInstructionTemplate = (line: string): boolean => {
            if (/^\s*\(/.test(line)) return true;  // Starts with parenthesis
            if (/<[a-z]+\s*(?:post|text|content|topic|angle)/i.test(line)) return true;  // <post>, <topic> placeholder
            if (/\[(?:actual|your|the)?\s*(?:post|draft|text|content|topic|angle)[^\]]*\]/i.test(line)) return true;  // [actual post text], [post content]
            if (/^\s*\[/.test(line)) return true;  // Starts with [ — likely a placeholder
            // Count instruction words vs content words
            const instructionMatches = line.match(/\b(?:under|must|include|should|character|hashtag|tone|first person|example)\b/gi) || [];
            if (instructionMatches.length >= 3) return true;
            return false;
        };

        for (const pattern of draftPatterns) {
            const match = planText.match(pattern);
            if (match && match[1].trim().length >= 30) {
                const candidate = match[1].trim();
                if (isInstructionTemplate(candidate)) {
                    logger.warn(COMPONENT, `[TwoPhase] Draft looks like instruction template — skipping: "${candidate.slice(0, 80)}"`);
                    continue;
                }
                content = candidate;
                logger.info(COMPONENT, `[TwoPhase] Extracted draft: "${content.slice(0, 80)}"`);
                break;
            }
        }

        // Fallback: find any line that has a hashtag (it's probably the post)
        // Skip lines that reference the example
        if (!content) {
            const lines = planText.split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim());
            const hashtagLine = lines.find(l =>
                /#\w+/.test(l) && l.length >= 30
                && !/reference\s*example/i.test(l)
                && !/example\s*(?:given|post|of)/i.test(l)
            );
            if (hashtagLine) {
                // Strip any "Reference Example:" or "Draft:" prefix
                content = hashtagLine.replace(/^\*?\*?(?:Reference|Example|Sample|Draft)\s*(?:Example|Post|:)?\*?\*?\s*:?\s*[""]?\s*/i, '').trim();
                logger.info(COMPONENT, `[TwoPhase] Extracted via hashtag detection: "${content.slice(0, 80)}"`);
            }
        }

        // Last resort: longest line that's not a label
        if (!content) {
            const lines = planText.split('\n')
                .map(l => l.replace(/^\s*[-*•]\s*/, '').replace(/^\*?\*?\w+\*?\*?:\s*/, '').trim())
                .filter(l => l.length >= 30 && !l.startsWith('TOPIC') && !l.startsWith('ANGLE'));
            if (lines.length > 0) {
                content = lines.sort((a, b) => b.length - a.length)[0];
                logger.warn(COMPONENT, `[TwoPhase] Using longest line as fallback: "${content.slice(0, 80)}"`);
            }
        }

        if (!content) {
            logger.warn(COMPONENT, `[TwoPhase] Could not extract draft from plan: "${planText.slice(0, 200)}"`);
            return '';
        }

        // Remove wrapping quotes
        content = content.replace(/^["']|["']$/g, '').trim();

        // ─── Output Guardrails Pipeline ──────────────────────────
        // Centralized post-processing — validates the extracted draft.
        const { applyOutputGuardrails } = await import('../../agent/outputGuardrails.js');
        const guardrailed = applyOutputGuardrails(content, {
            type: 'facebook_post',
            requirements: { minLength: 40, maxLength: 400 },
        });

        if (!guardrailed.passed) {
            logger.warn(COMPONENT, `Post rejected by guardrails (score=${guardrailed.score}): "${content.slice(0, 120)}"`);
            return '';
        }

        return guardrailed.content;
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

    // Cadence config (v4.0.3): was hardcoded 6/day + 2h gap. Now configurable.
    // Defaults tuned to avoid FB anti-spam feed throttle (observed burst of 4
    // posts in 40min trigger hidden-from-feed behavior).
    const maxPostsPerDay = Number(fbConfig?.maxPostsPerDay ?? 6);
    const minPostGapHours = Number(fbConfig?.minPostGapHours ?? 3);

    if (state.postsToday >= maxPostsPerDay) {
        logger.debug(COMPONENT, `Daily post cap reached (${state.postsToday}/${maxPostsPerDay})`);
        saveState(state);
        return;
    }

    if (state.lastPostAt) {
        const hoursSince = (Date.now() - new Date(state.lastPostAt).getTime()) / (1000 * 60 * 60);
        if (hoursSince < minPostGapHours) {
            logger.debug(COMPONENT, `Too soon since last post (${hoursSince.toFixed(1)}h, need ${minPostGapHours}h)`);
            return;
        }
    }

    // Pick content type from weighted rotation
    const contentType = CONTENT_ROTATION[state.contentIndex % CONTENT_ROTATION.length];
    state.contentIndex++;

    // Retry up to 3 times if the model leaks chain-of-thought into the post
    let content = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
        logger.info(COMPONENT, `Generating ${contentType} post (attempt ${attempt}/3)...`);
        content = await generateContent(contentType);
        if (content && content.length >= 20) break;
        if (attempt < 3) {
            logger.info(COMPONENT, `Attempt ${attempt} produced empty/short content — retrying`);
        }
    }

    if (!content || content.length < 20) {
        logger.warn(COMPONENT, 'All 3 LLM attempts failed to produce clean content — skipping this cycle. Will retry next hour.');
        return;
    }

    // Post through centralized postToPage() — handles dedup, PII, queue, and API
    const result = await postToPage(content, { source: `autopilot:${contentType}` });

    if (result.skipped) {
        logger.info(COMPONENT, `Autopilot post skipped: ${result.skipped}`);
        return;
    }

    if (!result.success) {
        logger.warn(COMPONENT, `Autopilot post failed: ${result.error || 'unknown'}`);
        return;
    }

    state.lastPostAt = new Date().toISOString();
    state.postsToday++;
    state.postHistory.push({ date: state.lastPostAt, type: contentType, postId: result.postId });
    if (state.postHistory.length > 100) state.postHistory = state.postHistory.slice(-50);
    saveState(state);

    logger.info(COMPONENT, `Autopilot posted ${contentType}: ${result.postId} (${state.postsToday}/${maxPostsPerDay} today)`);
}

// ─── Comment Monitor ────────────────────────────────────────────

/** Track which comments we've already replied to (persisted in state) */
const REPLIED_COMMENTS_PATH = join(TITAN_HOME, 'fb-replied-comments.json');

function loadRepliedComments(): Set<string> {
    if (!existsSync(REPLIED_COMMENTS_PATH)) return new Set();
    try {
        const ids = JSON.parse(readFileSync(REPLIED_COMMENTS_PATH, 'utf-8')) as string[];
        // Keep last 500 to prevent unbounded growth
        return new Set(ids.slice(-500));
    } catch { return new Set(); }
}

function saveRepliedComments(ids: Set<string>): void {
    try {
        const arr = [...ids].slice(-500);
        writeFileSync(REPLIED_COMMENTS_PATH, JSON.stringify(arr), 'utf-8');
    } catch { /* intentionally empty */ }
}

/** Generate a respectful reply to a comment. Never reveals personal info. */
/** Strip chain-of-thought reasoning that some models leak into output */
function stripThinking(text: string): string {
    // Remove <think>...</think> blocks
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Remove lines that look like internal reasoning (starts with "Wait,", "Actually,", "I should", "Let me", "Hmm", etc.)
    const lines = cleaned.split('\n');
    const replyLines: string[] = [];
    let foundReply = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Skip reasoning patterns
        if (/^(Wait|Actually|Hmm|Let me|I should|I need to|I could|So |The (rules|comment|user)|Since |But |OK so)/i.test(trimmed)) {
            foundReply = false; // Reset — reasoning appeared after reply candidate
            continue;
        }
        // Skip meta-commentary about the comment
        if (/commented (with|about|on|saying|that)|this is a .*(comment|message|question)/i.test(trimmed)) continue;
        foundReply = true;
        replyLines.push(trimmed);
    }
    cleaned = replyLines.join(' ').trim();
    // Remove wrapping quotes
    cleaned = cleaned.replace(/^["']|["']$/g, '');
    return cleaned;
}

/** Check if text looks like leaked reasoning or echoed instructions rather than a real reply */
function looksLikeReasoning(text: string): boolean {
    const reasoningSignals = [
        /I should respond/i,
        /I need to/i,
        /the rules say/i,
        /my personality/i,
        /let me (think|check|consider)/i,
        /chain.of.thought/i,
        /\bwait\b.*\brules\b/i,
        // Detect echoed prompt instructions (the actual bug that leaked to Facebook)
        /\bfriendly\b.*\bwitty\b/i,
        /\bno hashtags\b/i,
        /\bno personal info\b/i,
        /\bno internal thoughts\b/i,
        /\brespond directly\b/i,
        /\b1-2 sentences\b/i,
        /\bmaximum \d+ sentences\b/i,
        /^[-•]\s*(friendly|witty|short|concise|no\b)/im, // Bullet-point instruction lists
        /\brules:\b/i,
        /\boutput only\b/i,
    ];
    return reasoningSignals.some(p => p.test(text));
}

async function generateReply(commentText: string, commenterName: string): Promise<string> {
    const config = loadConfig();
    const fbConfig = (config as Record<string, unknown>).facebook as Record<string, unknown> | undefined;
    // Use the configured FB model, fall back to primary agent model.
    // glm-5.1 is ideal — it reasons via <think> tags which the output
    // guardrails pipeline strips. The reasoning improves post quality.
    const fbModel = fbConfig?.model as string;
    const agentModel = config.agent?.model as string;
    const model = (fbModel && fbModel.trim()) || agentModel || 'ollama/glm-5.1:cloud';
    const firstName = commenterName.split(' ')[0];

    try {
        const response = await chat({
            model,
            messages: [
                { role: 'system', content: `You are TITAN, a confident autonomous AI agent replying to Facebook comments on your own page. You are witty, warm, and brief. Output ONLY the reply text — never repeat instructions, never include bullet points or rules, never explain what you're doing. Just the reply itself, 1-2 short sentences.` },
                { role: 'user', content: `${firstName} commented: "${commentText}"` },
            ],
            temperature: 0.7,
            maxTokens: 100,
        });

        let reply = stripThinking((response.content || '').trim());

        // Final safety: reject if it still looks like reasoning or echoed instructions
        if (looksLikeReasoning(reply)) {
            logger.warn(COMPONENT, `Reply rejected — looks like leaked reasoning/instructions: "${reply.slice(0, 120)}..."`);
            // Return a safe generic reply instead of empty string (which skips the comment)
            const fallbacks = [
                `Thanks for the comment, ${firstName}! 🤖`,
                `Appreciate you stopping by, ${firstName}! 🙌`,
                `Great point, ${firstName}! Always good to hear from our community. 🚀`,
            ];
            return fallbacks[Math.floor(Math.random() * fallbacks.length)];
        }

        // Trim to max 280 chars for a comment reply
        if (reply.length > 280) reply = reply.slice(0, 277) + '...';

        return reply;
    } catch (e) {
        logger.error(COMPONENT, `Reply generation failed: ${(e as Error).message}`);
        return '';
    }
}

/** PII check for replies — comprehensive personal data filter */
function replyContainsPII(text: string): boolean {
    const patterns = [
        /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,          // phone
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, // email
        /\b\d{3}[-]?\d{2}[-]?\d{4}\b/,              // SSN
        /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,  // IP
        /(?:password|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S+/i,
        /\/home\/[a-z]+\//i,                         // unix home path
        /\/Users\/[a-z]+\//i,                        // mac home path
        /\b(?:single|married|divorced|separated|unemployed|laid off)\b/i, // personal status
        /\b(?:seeking funding|salary|income|bank account)\b/i,           // financial
        /\b192\.168\.\d+\.\d+\b/,                   // local network IPs
        /\b(?:RTX|GTX)\s*\d{4}/i,                   // hardware specs
    ];
    return patterns.some(p => p.test(text));
}

async function monitorComments(): Promise<void> {
    if (!process.env.FB_PAGE_ACCESS_TOKEN || !process.env.FB_PAGE_ID) {
        logger.debug(COMPONENT, 'Comment monitor: no FB credentials');
        return;
    }

    // Hunt Finding #02 (2026-04-14): honor both config flags.
    // Previously monitorComments ran unconditionally regardless of `facebook.autopilotEnabled`
    // so a user disabling the autopilot still got auto-replies. Both flags now gate this path.
    const config = loadConfig();
    const fbConfig = (config as Record<string, unknown>).facebook as Record<string, unknown> | undefined;
    if (fbConfig?.autopilotEnabled === false) {
        logger.debug(COMPONENT, 'Comment monitor: disabled via facebook.autopilotEnabled');
        return;
    }
    if (fbConfig?.replyMonitorEnabled === false) {
        logger.debug(COMPONENT, 'Comment monitor: disabled via facebook.replyMonitorEnabled');
        return;
    }

    const state = loadState();
    resetDailyCounters(state);

    if (state.repliesToday >= 10) {
        logger.debug(COMPONENT, 'Daily reply cap reached');
        return;
    }

    const pageId = process.env.FB_PAGE_ID;
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const repliedComments = loadRepliedComments();

    try {
        // Get recent posts with comments
        const feedResp = await fetch(
            `https://graph.facebook.com/v21.0/${pageId}/feed?fields=id,comments{id,message,from,created_time}&limit=5&access_token=${token}`,
            { signal: AbortSignal.timeout(15000) },
        );
        if (!feedResp.ok) {
            logger.warn(COMPONENT, `Comment monitor: feed fetch failed (${feedResp.status})`);
            return;
        }

        const feed = await feedResp.json() as Record<string, unknown>;
        const posts = (feed.data as Array<Record<string, unknown>>) || [];
        let totalComments = 0;
        let newComments = 0;

        for (const post of posts) {
            const comments = (post.comments as Record<string, unknown>)?.data as Array<Record<string, unknown>> | undefined;
            if (!comments || comments.length === 0) continue;

            for (const comment of comments) {
                totalComments++;
                const commentId = comment.id as string;
                const fromObj = comment.from as Record<string, unknown> | undefined;
                const fromId = fromObj?.id as string | undefined;
                const fromName = fromObj?.name as string || 'someone';

                // Skip: from the page itself, already replied, or empty
                if (fromId === pageId) continue;
                if (repliedComments.has(commentId)) continue;
                newComments++;

                const msg = comment.message as string || '';
                if (msg.length < 3) continue;

                // Check daily cap
                if (state.repliesToday >= 10) break;

                // Generate reply
                logger.info(COMPONENT, `Replying to comment from ${fromName}: "${msg.slice(0, 60)}..."`);
                const reply = await generateReply(msg, fromName);

                if (!reply || reply.length < 5) continue;

                // PII safety check on generated reply
                if (replyContainsPII(reply)) {
                    logger.warn(COMPONENT, `Reply blocked — PII detected: "${reply.slice(0, 50)}..."`);
                    repliedComments.add(commentId); // Mark as handled to avoid retrying
                    continue;
                }

                // Centralized outbound sanitizer — catches instruction leaks, tool artifacts, PII
                const { sanitizeOutbound } = await import('../../utils/outboundSanitizer.js');
                const sanitized = sanitizeOutbound(reply, 'fb_autopilot_comment', `Thanks for the comment! 🤖`);
                if (sanitized.hadIssues) {
                    logger.warn(COMPONENT, `Reply sanitized for ${fromName}: ${sanitized.issues.join(', ')}`);
                    if (!sanitized.text) {
                        repliedComments.add(commentId);
                        continue;
                    }
                }
                const safeReply = sanitized.text;

                // Post the reply
                try {
                    const replyResp = await fetch(`https://graph.facebook.com/v21.0/${commentId}/comments`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: safeReply, access_token: token }),
                        signal: AbortSignal.timeout(15000),
                    });

                    if (replyResp.ok) {
                        repliedComments.add(commentId);
                        state.repliesToday++;
                        logger.info(COMPONENT, `Replied to ${fromName}: "${reply.slice(0, 60)}..." (${state.repliesToday}/10 today)`);
                    } else {
                        const errBody = await replyResp.text().catch(() => '');
                        logger.warn(COMPONENT, `Reply API failed (${replyResp.status}): ${errBody.slice(0, 200)}`);
                    }
                } catch (e) {
                    logger.error(COMPONENT, `Failed to reply: ${(e as Error).message}`);
                }
            }
        }

        logger.info(COMPONENT, `Comment scan: ${posts.length} posts, ${totalComments} comments, ${newComments} new`);
        saveRepliedComments(repliedComments);
        saveState(state);
    } catch (e) {
        logger.error(COMPONENT, `Comment monitor error: ${(e as Error).message}`);
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
                    const cfg = loadConfig();
                    const fbCfg = (cfg as Record<string, unknown>).facebook as Record<string, unknown> | undefined;
                    const cap = Number(fbCfg?.maxPostsPerDay ?? 6);
                    const gap = Number(fbCfg?.minPostGapHours ?? 3);
                    return [
                        `Facebook Autopilot Status:`,
                        `- Credentials: ${hasCreds ? 'configured' : 'NOT configured'}`,
                        `- Posts today: ${state.postsToday}/${cap}`,
                        `- Min gap: ${gap}h between posts`,
                        `- Replies today: ${state.repliesToday}/10`,
                        `- Last post: ${state.lastPostAt || 'never'}`,
                        `- Content index: ${state.contentIndex} (next: ${CONTENT_ROTATION[state.contentIndex % CONTENT_ROTATION.length]})`,
                        `- Total posts tracked: ${state.postHistory.length}`,
                    ].join('\n');
                }

                if (action === 'post_now') {
                    await runFBAutopilot();
                    const updated = loadState();
                    const cfg = loadConfig();
                    const fbCfg = (cfg as Record<string, unknown>).facebook as Record<string, unknown> | undefined;
                    const cap = Number(fbCfg?.maxPostsPerDay ?? 6);
                    return updated.lastPostAt !== state.lastPostAt
                        ? `Post published! (${updated.postsToday}/${cap} today). Type: ${CONTENT_ROTATION[(state.contentIndex) % CONTENT_ROTATION.length]}`
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
    // Post watcher: runs every hour, posts if 2h+ since last post
    registerWatcher('fb-autopilot-post', runFBAutopilot, 60 * 60 * 1000); // 1 hour

    // Comment monitor: runs every 5 minutes
    registerWatcher('fb-autopilot-comments', monitorComments, 5 * 60 * 1000); // 5 minutes

    logger.info(COMPONENT, 'Facebook Autopilot registered (post every 1h, comments every 5m)');
}
