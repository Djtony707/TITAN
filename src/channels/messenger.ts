/**
 * TITAN — Facebook Messenger Channel Adapter
 *
 * Receives DMs via webhook, processes through TITAN, replies via Send API.
 * Uses the same Page Access Token as the Facebook posting skill.
 *
 * Required env vars:
 *   FB_PAGE_ACCESS_TOKEN  — Page Access Token (same as facebook.ts)
 *   FB_PAGE_ID            — Facebook Page ID
 *   FB_VERIFY_TOKEN       — Webhook verification token (you pick this, any string)
 *
 * Setup:
 *   1. In Facebook App → Messenger → Webhooks → set callback URL to:
 *      https://your-domain:48420/api/messenger/webhook
 *   2. Set verify token to match FB_VERIFY_TOKEN
 *   3. Subscribe to: messages, messaging_postbacks
 */
import { ChannelAdapter, type InboundMessage, type OutboundMessage, type ChannelStatus } from './base.js';
import { loadConfig } from '../config/config.js';
import { chat } from '../providers/router.js';
import { processMessage } from '../agent/agent.js';
import { TITAN_VERSION } from '../utils/constants.js';
import logger from '../utils/logger.js';
import {
    extractAudioAttachments,
    transcribeMessengerAudio,
    sendVoiceReply,
    f5ttsHealth,
} from './messenger-voice.js';

const COMPONENT = 'Messenger';
const GRAPH_API = 'https://graph.facebook.com/v21.0';

/** PII check — never send personal info in DMs */
function containsPII(text: string): boolean {
    const patterns = [
        /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i,
        /\b\d{3}[-]?\d{2}[-]?\d{4}\b/,
        /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
        /(?:password|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S+/i,
        /\/home\/[a-z]+\//i,
        /\/Users\/[a-z]+\//i,
        /\b(?:single|married|divorced|separated|unemployed|laid off)\b/i,
        /\b192\.168\.\d+\.\d+\b/,
    ];
    return patterns.some(p => p.test(text));
}

// ── TITAN-only response system (no tools, no agent loop) ────────

const TITAN_MESSENGER_PROMPT = `You are TITAN, an autonomous AI agent. You are the AI itself, speaking in first person, responding to Facebook Messenger DMs on the TITAN AI Facebook page.

You ARE the product — you're literally running this conversation right now, autonomously. That's your best selling point.

═══ WHAT I AM ═══
I'm TITAN (The Intelligent Task Automation Network) — an open-source autonomous AI agent framework built in TypeScript by Tony Elliott. I'm not just a chatbot. I'm an AI that actually DOES things: I write code, research topics, manage files, run servers, post on social media (I'm managing this entire Facebook page right now), and orchestrate teams of sub-agents to tackle complex tasks.

Current version: v${TITAN_VERSION} | 19,400+ npm downloads | MIT Licensed

═══ MY CAPABILITIES (195+ Tools) ═══

Code & Development:
- Write, edit, and execute code in any language
- Run shell commands, build projects, deploy software
- Code review with 5-axis analysis (correctness, design, readability, security, performance)
- Test generation, debugging, refactoring
- Git workflow automation

Research & Knowledge:
- Web search across multiple engines, fetch and read full page content
- Cross-reference facts across sources with citations
- Build searchable knowledge bases (RAG) from documents and URLs
- Persistent memory across conversations

Business Automation:
- Social media management (I run this Facebook page autonomously — posting, replying, DMs)
- Email drafting and management
- Calendar and scheduling
- Invoice tracking, report generation
- Customer support automation

Multi-Agent Orchestration:
- Spawn specialized sub-agents: Coder, Researcher, Analyst, Browser, Tester, Architect
- 40 personas (debugger, security-engineer, code-reviewer, TDD-engineer, etc.)
- Hierarchical task decomposition (goal → phases → tasks → subtasks)
- Shared task queue with atomic checkout
- Inter-agent messaging for coordination

Infrastructure & DevOps:
- System monitoring, health checks, alerting
- GPU VRAM management for AI workloads
- Mesh networking across multiple machines
- Docker, deployment automation
- Cron scheduling for recurring tasks

Content & Creative:
- Research and write articles, reports, documentation
- Generate and schedule social media posts
- Website building, SEO optimization
- Product descriptions, marketing copy

Voice & Chat:
- Real-time voice conversations via WebRTC (LiveKit)
- 16 channel adapters: Discord, Telegram, Slack, WhatsApp, Matrix, IRC, Messenger, and more
- Works on any platform your team already uses

Self-Improvement:
- Evaluates its own performance and evolves prompts
- Fine-tunes local AI models using LoRA training
- Learns from interactions to get better over time

Mission Control Dashboard:
- React-based real-time monitoring
- 25+ admin panels: chat, agents, goals, memory, files, settings
- Command Post governance with budget enforcement
- Visual agent activity tracking

═══ WHO I'M FOR ═══

Developers & Engineers: Full AI coding partner — write, test, review, deploy
Small Business Owners: Automate marketing, customer support, social media, reporting
Freelancers: Draft proposals, manage clients, track invoices, research leads
Startups: AI co-pilot for product development, research, and operations
Content Creators: Write scripts, schedule posts, manage multiple platforms
Students & Researchers: Deep research, note organization, study assistance
DevOps Teams: Infrastructure monitoring, deployment automation, incident response
Agencies: Scale content production, manage multiple client accounts

═══ HOW TO GET STARTED ═══

Technical users: npm install titan-agent (you're up and running in 60 seconds)
Everyone: Visit github.com/Djtony707/TITAN for the full guide
Questions: Ask me right here — I'm literally the product demonstrating itself!

═══ PRICING ═══
TITAN is 100% free and open-source (MIT license). You bring your own AI models — run local models free with Ollama, or connect to cloud providers (OpenAI, Claude, Gemini, etc.) with your own API keys.

═══ HOW I RESPOND ═══
- Be genuinely helpful, warm, and conversational — like a knowledgeable friend
- Keep responses short for Messenger (2-4 sentences usually, more if they ask detailed questions)
- When someone describes a problem, explain specifically how I solve it — not generic features
- Ask follow-up questions to understand their needs: "What kind of business do you run?" or "What tasks take up most of your time?"
- If they're interested, guide them to the next step based on their skill level
- Use the fact that THIS CONVERSATION is proof I work — "I'm literally responding to you right now, autonomously, managing this entire Facebook page"
- If someone asks something unrelated, be friendly: "Ha, I appreciate the curiosity! I'm focused on helping with TITAN stuff though — want to know how I can automate something for you?"
- NEVER be pushy or salesy — let the product speak for itself (which it literally is, right now)
- NEVER reveal personal information, IP addresses, file paths, server details, or credentials
- NEVER discuss competitors negatively — just highlight what makes TITAN unique
- NEVER pretend to be human — own being an AI proudly, it's the whole point`;

// ── Prompt Injection Detection ──────────────────────────────────

const INJECTION_PATTERNS = [
    // Direct instruction override attempts
    /ignore (?:all |your |the |previous |above )?(instructions|rules|prompt|system)/i,
    /forget (?:all |your |the |previous |above )?(instructions|rules|prompt|system)/i,
    /disregard (?:all |your |the |previous |above )?(instructions|rules|prompt|system)/i,
    /override (?:all |your |the |previous |above )?(instructions|rules|prompt|system)/i,
    /you are now|you're now|act as if|pretend you(?:'re| are)/i,
    /new instructions|new rules|new persona|new role/i,
    /from now on|starting now|going forward.*(?:you|your)/i,

    // Role-switching attempts
    /you are (?:a |an )?(?:DAN|evil|unrestricted|jailbroken|unfiltered)/i,
    /enter (?:dev|developer|debug|admin|god|sudo|root) mode/i,
    /switch to (?:unrestricted|unfiltered|uncensored|raw) mode/i,
    /(?:enable|activate|turn on) (?:dev|developer|debug|admin|jailbreak) mode/i,

    // System prompt extraction
    /(?:show|reveal|display|print|output|give|tell|share|repeat|recite).*(?:system prompt|instructions|rules|initial prompt|original prompt)/i,
    /what (?:are|were) your (?:original |initial |system )?(?:instructions|rules|prompt)/i,
    /paste (?:your|the) (?:system |original |initial )?(?:prompt|instructions)/i,

    // Delimiter/formatting tricks
    /\[SYSTEM\]|\[INST\]|<\|system\|>|<\|im_start\|>|<<SYS>>|###\s*(?:System|Instruction)/i,
    /```(?:system|prompt|instructions)/i,

    // Credential/token extraction
    /(?:show|give|share|reveal|print).*(?:api key|token|password|secret|credential|access.token)/i,
    /what is (?:your|the) (?:api |access )?(?:key|token|password|secret)/i,

    // Code execution attempts
    /(?:run|execute|eval)\s*(?:this|the following)?\s*(?:code|command|script|shell)/i,
    /(?:import|require|fetch|curl|wget)\s*\(/i,

    // Persona manipulation
    /(?:you|your) (?:real|true|actual|hidden) (?:name|identity|purpose|personality)/i,
    /stop being titan|stop pretending|drop the act|break character/i,
];

/** Check for prompt injection attempts. Returns the matched pattern or null. */
function detectInjection(message: string): string | null {
    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(message)) {
            const match = message.match(pattern);
            return match ? match[0] : 'injection pattern';
        }
    }

    // Length-based heuristic: extremely long messages are suspicious
    if (message.length > 2000) return 'oversized message (>2000 chars)';

    // Base64/encoded content detection
    if (/^[A-Za-z0-9+/=]{100,}$/.test(message.trim())) return 'base64-encoded content';

    return null;
}

const INJECTION_RESPONSES = [
    "Nice try! 😄 I'm TITAN — I only talk about what I can do for you. Want to know how I can automate your workflow?",
    "I see what you did there! 🤖 I'm locked in on helping you learn about TITAN though. What can I help you with?",
    "Ha, clever! But I'm built different — I stick to what I know: TITAN. Ask me anything about autonomous AI agents!",
    "That's not going to work on me! 😎 But you know what does work? TITAN automating your entire workflow. Want to hear more?",
    "I appreciate the creativity, but I'm focused on one thing: helping you learn about TITAN. What would you like to automate?",
];

async function generateMessengerReply(
    userMessage: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<string> {
    // ── Injection detection — check before sending to LLM ──
    const injection = detectInjection(userMessage);
    if (injection) {
        logger.warn(COMPONENT, `Injection attempt blocked: "${injection}" from message: "${userMessage.slice(0, 80)}..."`);
        return INJECTION_RESPONSES[Math.floor(Math.random() * INJECTION_RESPONSES.length)];
    }

    const config = loadConfig();
    const model = config.agent?.model || 'ollama/glm-5.1:cloud';

    try {
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
            { role: 'system', content: TITAN_MESSENGER_PROMPT },
            ...history,
            { role: 'user', content: userMessage },
        ];

        const response = await chat({
            model,
            messages,
            temperature: 0.7,
            maxTokens: 200,
        });

        let reply = (response.content || '').trim().replace(/^["']|["']$/g, '');

        // PII safety check
        if (containsPII(reply)) {
            reply = "I'd love to help! Ask me anything about TITAN — what it does, how to install it, or how it can help your business. 🤖";
        }

        return reply || "Hey! I'm TITAN, an autonomous AI agent. Ask me what I can do! 🤖";
    } catch (e) {
        logger.error(COMPONENT, `Reply generation failed: ${(e as Error).message}`);
        return "Hey! I'm TITAN — an autonomous AI agent framework. Check out github.com/Djtony707/TITAN to learn more! 🤖";
    }
}

export class MessengerChannel extends ChannelAdapter {
    readonly name = 'messenger';
    readonly displayName = 'Facebook Messenger';
    private connected = false;
    private pageToken = '';
    private pageId = '';
    private verifyToken = '';

    /** Per-sender conversation history (last N messages) for context */
    private conversationHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
    private readonly maxHistoryPerSender = 10;

    /** Concurrency guard — only one agent request per sender at a time */
    private activeRequests = new Set<string>();

    /** Message queue — if a message arrives while one is processing, queue it */
    private messageQueue = new Map<string, Array<string>>();

    /** v4.3.2: owner voice replies (F5-TTS Andrew) — configurable per deploy */
    private voiceRepliesEnabled = false;
    private voiceName = 'andrew';

    async connect(): Promise<void> {
        const config = loadConfig();
        const channelConfig = (config.channels as Record<string, Record<string, unknown>>)?.messenger;

        if (channelConfig && channelConfig.enabled === false) {
            logger.info(COMPONENT, 'Messenger channel is disabled');
            return;
        }

        this.pageToken = process.env.FB_PAGE_ACCESS_TOKEN || '';
        this.pageId = process.env.FB_PAGE_ID || '';
        this.verifyToken = process.env.FB_VERIFY_TOKEN || 'titan-messenger-verify';

        if (!this.pageToken || !this.pageId) {
            logger.info(COMPONENT, 'Messenger not configured — set FB_PAGE_ACCESS_TOKEN and FB_PAGE_ID');
            return;
        }

        // v4.3.2: voice replies — default ON for owners so Tony gets voice notes
        // when he's on mobile. Can be toggled via channels.messenger.voiceReplies.
        const voiceReplies = channelConfig?.voiceReplies as Record<string, unknown> | undefined;
        this.voiceRepliesEnabled = voiceReplies?.enabled !== false; // default true
        this.voiceName = (voiceReplies?.voice as string) || 'andrew';

        // Probe F5-TTS at startup — log if it's not reachable but don't disable.
        // The channel works fine with text-only; voice is a bonus.
        if (this.voiceRepliesEnabled) {
            f5ttsHealth().then(ok => {
                logger.info(COMPONENT, `F5-TTS voice replies: ${ok ? 'ready' : 'server not reachable (text-only)'} (voice=${this.voiceName})`);
            }).catch(() => {});
        }

        this.connected = true;
        logger.info(COMPONENT, `Messenger channel ready (Page ID: ${this.pageId}). Webhook: /api/messenger/webhook`);
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        logger.info(COMPONENT, 'Disconnected');
    }

    /** Send a typing indicator to show TITAN is working */
    private async sendTypingIndicator(recipientId: string): Promise<void> {
        if (!this.connected || !this.pageToken) return;
        try {
            await fetch(`${GRAPH_API}/me/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.pageToken}`,
                },
                body: JSON.stringify({
                    recipient: { id: recipientId },
                    sender_action: 'typing_on',
                }),
                signal: AbortSignal.timeout(5000),
            });
        } catch {
            // Non-critical — don't log errors for typing indicators
        }
    }

    /** Send a reply to a Messenger user */
    async send(message: OutboundMessage): Promise<void> {
        if (!this.connected || !this.pageToken) return;

        const recipientId = message.userId;
        if (!recipientId) {
            logger.warn(COMPONENT, 'Cannot send — no recipient ID');
            return;
        }

        let text = message.content;

        // PII safety check
        if (containsPII(text)) {
            logger.warn(COMPONENT, `Blocked outbound message — PII detected`);
            text = "I'd love to help, but I can't share that type of information. Ask me about TITAN's features instead! 🤖";
        }

        // Truncate to Messenger's 2000 char limit
        if (text.length > 2000) {
            text = text.slice(0, 1990) + '...[truncated]';
        }

        try {
            const response = await fetch(`${GRAPH_API}/me/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.pageToken}`,
                },
                body: JSON.stringify({
                    recipient: { id: recipientId },
                    message: { text },
                    messaging_type: 'RESPONSE',
                }),
                signal: AbortSignal.timeout(15000),
            });

            if (!response.ok) {
                const errText = await response.text();
                logger.error(COMPONENT, `Send failed (${response.status}): ${errText}`);
            } else {
                logger.info(COMPONENT, `Replied to ${recipientId}: "${text.slice(0, 60)}..."`);
            }
        } catch (e) {
            logger.error(COMPONENT, `Send error: ${(e as Error).message}`);
        }
    }

    getStatus(): ChannelStatus {
        return {
            name: this.displayName,
            connected: this.connected,
            lastActivity: undefined,
        };
    }

    /** Handle webhook verification (GET request from Facebook) */
    handleVerify(query: Record<string, string>): { status: number; body: string } {
        const mode = query['hub.mode'];
        const token = query['hub.verify_token'];
        const challenge = query['hub.challenge'];

        if (mode === 'subscribe' && token === this.verifyToken) {
            logger.info(COMPONENT, 'Webhook verified');
            return { status: 200, body: challenge || '' };
        }

        logger.warn(COMPONENT, 'Webhook verification failed');
        return { status: 403, body: 'Forbidden' };
    }

    /** Handle incoming webhook event (POST from Facebook) */
    handleWebhook(body: Record<string, unknown>): void {
        if (!this.connected) return;

        const object = body.object as string;
        if (object !== 'page') return;

        const entries = (body.entry as Array<Record<string, unknown>>) || [];

        for (const entry of entries) {
            const messaging = (entry.messaging as Array<Record<string, unknown>>) || [];

            for (const event of messaging) {
                const senderId = (event.sender as Record<string, unknown>)?.id as string;
                const message = event.message as Record<string, unknown> | undefined;

                // Skip echo messages (from the page itself)
                if (message?.is_echo) continue;

                // Skip messages from the page itself
                if (senderId === this.pageId) continue;
                if (!senderId) continue;

                // v4.3.2/v4.3.3: audio attachments from OWNERS (Tony's whitelisted
                // Page-Scoped User IDs only) get transcribed to text and routed
                // through the normal reply path. Random DMs with voice notes are
                // dropped silently — no GPU cost, no admin exposure, no leak of
                // the transcribe/Andrew-voice pipeline to non-owners.
                const textRaw = message?.text as string | undefined;
                let text = textRaw || '';
                const audios = extractAudioAttachments(message);
                if (!text && audios.length > 0) {
                    if (!this.ownerIds.has(senderId)) {
                        logger.info(COMPONENT, `Ignoring voice note from non-owner ${senderId}`);
                        continue;
                    }
                    // Fire the transcription + reply in the background so we
                    // don't block the webhook ACK (FB retries if we're slow).
                    this.handleVoiceMessage(senderId, audios[0].url).catch(e =>
                        logger.error(COMPONENT, `Voice message handling failed: ${(e as Error).message}`),
                    );
                    continue;
                }

                if (!text) continue;

                logger.info(COMPONENT, `Incoming DM from ${senderId}: "${text.slice(0, 60)}..."`);

                // ── Concurrency guard: queue if already processing ──
                if (this.activeRequests.has(senderId)) {
                    const queue = this.messageQueue.get(senderId) || [];
                    const MAX_QUEUE_SIZE = 20;
                    if (queue.length >= MAX_QUEUE_SIZE) {
                        logger.warn(COMPONENT, `Message queue full for ${senderId} (${queue.length}), dropping oldest`);
                        queue.shift();
                    }
                    queue.push(text);
                    this.messageQueue.set(senderId, queue);
                    logger.info(COMPONENT, `Queued message for ${senderId} (${queue.length} in queue, agent busy)`);
                    // Send typing indicator so they know we're working
                    this.sendTypingIndicator(senderId).catch(() => {});
                    return;
                }

                // Process this message and then drain the queue
                this.processWithQueue(senderId, text).catch(e =>
                    logger.error(COMPONENT, `Message processing failed: ${(e as Error).message}`),
                );
            }
        }
    }

    /**
     * v4.3.2: Handle an inbound Messenger voice note. Download the audio from
     * FB's CDN, transcribe with local faster-whisper, and treat the transcript
     * as if Tony had typed it — same queue, same admin path, same reply flow.
     * For owners, the reply will be synthesized in Andrew's voice (see
     * handleDirectReply). For non-owners we just let them know we heard them.
     */
    private async handleVoiceMessage(senderId: string, audioUrl: string): Promise<void> {
        logger.info(COMPONENT, `Voice note from ${senderId} — transcribing`);
        await this.sendTypingIndicator(senderId);

        const transcript = await transcribeMessengerAudio(audioUrl);
        if (!transcript) {
            // Whisper unavailable or all failed — tell Tony directly so he's
            // not left wondering whether the voice note landed.
            if (this.ownerIds.has(senderId)) {
                await this.send({
                    channel: 'messenger',
                    userId: senderId,
                    content: "I got your voice note but couldn't transcribe it just now. Mind typing it? I'll keep my transcription pipeline warming up.",
                }).catch(() => {});
            }
            return;
        }

        logger.info(COMPONENT, `Transcript: "${transcript.slice(0, 120)}"`);

        // Route through the same queue as typed messages so out-of-order voice
        // + text don't step on each other.
        if (this.activeRequests.has(senderId)) {
            const queue = this.messageQueue.get(senderId) || [];
            const MAX_QUEUE_SIZE = 20;
            if (queue.length >= MAX_QUEUE_SIZE) queue.shift();
            queue.push(transcript);
            this.messageQueue.set(senderId, queue);
            return;
        }
        await this.processWithQueue(senderId, transcript);
    }

    /** Process a message, then drain any queued messages for this sender */
    private async processWithQueue(senderId: string, text: string): Promise<void> {
        this.activeRequests.add(senderId);
        try {
            await this.handleDirectReply(senderId, text);

            // Drain queue — process any messages that came in while we were busy
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const queue = this.messageQueue.get(senderId);
                if (!queue || queue.length === 0) break;
                const nextMessage = queue.shift()!;
                if (queue.length === 0) this.messageQueue.delete(senderId);
                logger.info(COMPONENT, `Processing queued message for ${senderId}: "${nextMessage.slice(0, 60)}..."`);
                await this.handleDirectReply(senderId, nextMessage);
            }
        } finally {
            this.activeRequests.delete(senderId);
        }
    }

    /**
     * ADMIN WHITELIST — Tony's Facebook Page-Scoped User IDs.
     *
     * These are the ONLY IDs that get:
     *   - admin-path tool execution (`generateAdminReply` with full tools)
     *   - Andrew-voice audio replies on Messenger
     *   - inbound voice-note transcription (faster-whisper)
     *   - remote-approval protocol (yes/no in-channel)
     *   - notifications about other users' DMs to the TITAN page
     *
     * Anyone else hitting the Messenger webhook falls through to the
     * marketing-pitch reply path (`generateMessengerReply`) with no tool
     * access, no voice synthesis, and no transcription. If you need to
     * add another admin, add their PSID here — do NOT rely on any other
     * source of "admin" identity for Messenger.
     */
    private readonly ownerIds = new Set(['10233541366698333', '35246646321616104']);

    /** Get conversation history — fetches from Graph API on first contact, then uses in-memory cache */
    private async getHistory(senderId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
        const cached = this.conversationHistory.get(senderId);
        if (cached && cached.length > 0) return cached;

        // First message since restart — try to load history from Facebook Graph API
        try {
            const history = await this.fetchConversationFromGraph(senderId);
            if (history.length > 0) {
                this.conversationHistory.set(senderId, history);
                logger.info(COMPONENT, `Loaded ${history.length} messages from Graph API for ${senderId}`);
                return history;
            }
        } catch (e) {
            logger.debug(COMPONENT, `Could not fetch conversation history: ${(e as Error).message}`);
        }

        return [];
    }

    /** Fetch recent conversation messages from the Facebook Graph API */
    private async fetchConversationFromGraph(senderId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
        if (!this.pageToken) return [];

        // Step 1: Find the conversation thread with this sender
        const convoRes = await fetch(
            `${GRAPH_API}/me/conversations?fields=participants,messages.limit(20){message,from,created_time}&user_id=${senderId}`,
            {
                headers: { Authorization: `Bearer ${this.pageToken}` },
                signal: AbortSignal.timeout(10000),
            },
        );

        if (!convoRes.ok) {
            logger.debug(COMPONENT, `Graph API conversations fetch failed: ${convoRes.status}`);
            return [];
        }

        const convoData = await convoRes.json() as {
            data?: Array<{
                messages?: {
                    data?: Array<{
                        message?: string;
                        from?: { id?: string };
                        created_time?: string;
                    }>;
                };
            }>;
        };

        const thread = convoData.data?.[0];
        if (!thread?.messages?.data) return [];

        // Step 2: Convert to chat history format (newest first from API, reverse for chronological)
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        const messages = [...thread.messages.data].reverse(); // oldest first

        for (const msg of messages) {
            // E5: Use explicit null/undefined check — empty string "" is valid content,
            // but !msg.message would incorrectly skip it
            if (msg.message === undefined || msg.message === null) continue;
            const role = msg.from?.id === this.pageId ? 'assistant' as const : 'user' as const;
            history.push({ role, content: msg.message });
        }

        // Keep last N
        while (history.length > this.maxHistoryPerSender * 2) history.shift();

        return history;
    }

    /** Append to conversation history, keeping last N messages */
    private pushHistory(senderId: string, role: 'user' | 'assistant', content: string): void {
        const history = this.conversationHistory.get(senderId) || [];
        history.push({ role, content });
        while (history.length > this.maxHistoryPerSender * 2) history.shift();
        this.conversationHistory.set(senderId, history);
    }

    /** Handle DM directly — generate reply and send via Messenger API */
    private async handleDirectReply(senderId: string, userMessage: string): Promise<void> {
        // Send typing indicator immediately so user knows we're working
        await this.sendTypingIndicator(senderId);

        const history = await this.getHistory(senderId);

        // ── Owner/Admin detection — Tony gets full access, not marketing pitch ──
        if (this.ownerIds.has(senderId)) {
            let reply: string;
            try {
                reply = await this.generateAdminReply(userMessage, history);
            } catch (e) {
                logger.error(COMPONENT, `Admin reply completely failed: ${(e as Error).message}`);
                reply = "Hey Tony, something went wrong. Check the dashboard. 🔧";
            }
            this.pushHistory(senderId, 'user', userMessage);
            this.pushHistory(senderId, 'assistant', reply);

            // v4.3.2: for owners, also send the reply as a voice note in the
            // Andrew voice via F5-TTS. Text goes first so Tony always sees the
            // reply even if TTS or the attachment upload fails. The voice note
            // is a bonus, not a replacement.
            const sendResult = this.send({ channel: 'messenger', userId: senderId, content: reply });
            if (this.voiceRepliesEnabled) {
                sendVoiceReply(senderId, reply, this.pageToken, this.voiceName).catch(e =>
                    logger.warn(COMPONENT, `Voice reply failed, text already sent: ${(e as Error).message}`),
                );
            }
            await sendResult;
            return;
        }

        const injection = detectInjection(userMessage);
        const reply = await generateMessengerReply(userMessage, history);
        this.pushHistory(senderId, 'user', userMessage);
        this.pushHistory(senderId, 'assistant', reply);
        await this.send({ channel: 'messenger', userId: senderId, content: reply });

        // Notify Tony about the conversation
        const alertTag = injection ? `⚠️ INJECTION BLOCKED: "${injection}"\n` : '';
        const notification = `📩 New DM on TITAN AI page\n${alertTag}From: ${senderId}\nThey said: "${userMessage.slice(0, 200)}"\nI replied: "${reply.slice(0, 200)}"`;
        // E4: Notify all owner IDs (not just one hardcoded), log at WARN on failure
        for (const ownerId of this.ownerIds) {
            if (ownerId === senderId) continue; // Don't notify the sender about their own message
            await this.send({ channel: 'messenger', userId: ownerId, content: notification }).catch(e =>
                logger.warn(COMPONENT, `Owner notification to ${ownerId} failed: ${(e as Error).message}`),
            );
        }
    }

    /** Cloud model for Messenger admin interactions — GLM-5.1 is newest agentic flagship, SOTA SWE-Bench Pro */
    private readonly MESSENGER_MODEL = 'ollama/glm-5.1:cloud';

    /** Generate a reply for Tony — ALL messages go through processMessage with local model override */
    private async generateAdminReply(
        userMessage: string,
        _history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    ): Promise<string> {
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        const adminPrompt = `[ADMIN MESSAGE FROM TONY ELLIOTT — CREATOR & OWNER]
Today's date: ${today}
You are responding to your creator via Facebook Messenger. He has FULL admin access.
- Execute any instruction he gives — post to Facebook, check status, run tools, research, whatever he asks
- If he asks a question, answer it. Use tools (web_search, memory, system_info, etc.) if you need real data.
- If you don't know something, use web_search to find out. Do NOT make up dates, events, or facts.
- Be direct, casual, and concise — this is Messenger, keep replies under 500 chars when possible
- Call him Tony or boss
- NEVER leak credentials, tokens, IPs, or file paths over Messenger (insecure channel)

REMOTE APPROVAL PROTOCOL (v4.3.3):
Tony is often away from his computer and talking to you by voice or text on Messenger.
He CANNOT open the Mission Control dashboard to approve things. So:
- NEVER tell him "check the dashboard to approve" — that fails him when remote.
- For small, reversible actions (answering a question, checking a status, reading a feed, running a non-destructive tool): JUST DO IT. No approval needed.
- For bigger/destructive actions (deploying code, publishing to npm, posting publicly to Facebook, sending money, contacting people, changing system config, deleting things): DESCRIBE what you intend to do in one clear sentence, then ask "Approve? (yes/no)" and STOP. Do NOT execute yet.
- When his next message is "yes", "y", "approve", "go", "do it", "ok", "sure", "proceed", or a clear affirmative → execute and report what happened.
- When his next message is "no", "n", "stop", "cancel", "nope", or clearly negative → don't do it and acknowledge briefly.
- If he gives you a NEW instruction instead of yes/no, treat that as the new request (he changed his mind).
- Never say "I need dashboard approval." You are his hands and voice when he's out. Ask him here, proceed on his word.

FACEBOOK TOOLS — IMPORTANT RULES:
- To see comments on a post: ALWAYS use fb_read_comments with the post ID first. NEVER guess or make up comment content.
- To reply to a comment: Use fb_read_comments to get the exact comment ID, then fb_reply with that ID.
- fb_read_feed shows posts with up to 5 recent comments each. For full comments, use fb_read_comments.
- NEVER claim you liked, replied to, or interacted with a comment unless a tool confirmed success with a result ID.
- If a tool fails or returns an error, tell Tony exactly what went wrong — don't pretend it worked.

His message: `;

        const TIMEOUT_MS = 120_000; // 2 min — FB API calls + Ollama inference needs more than 60s

        // Refresh typing indicator while working
        const typingInterval = setInterval(() => {
            this.sendTypingIndicator('35246646321616104').catch(() => {});
        }, 15_000);

        try {
            logger.info(COMPONENT, `Admin request — ${this.MESSENGER_MODEL} agent (${TIMEOUT_MS / 1000}s timeout)`);

            const agentPromise = processMessage(
                adminPrompt + userMessage,
                'messenger-admin',
                'tony-admin',
                { model: this.MESSENGER_MODEL },
                undefined,
                AbortSignal.timeout(TIMEOUT_MS),
            );

            const timeoutPromise = new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), TIMEOUT_MS),
            );

            const response = await Promise.race([agentPromise, timeoutPromise]);

            if (response && response.content) {
                let reply = await this.cleanReply(response.content);
                if (reply.length > 1900) reply = reply.slice(0, 1890) + '...';
                return reply || "Done, Tony. 👍";
            }

            logger.warn(COMPONENT, `Agent timed out after ${TIMEOUT_MS / 1000}s`);
            return "Hey Tony, that one took too long. Try a simpler request or check the dashboard. ⏱️";
        } catch (e) {
            logger.error(COMPONENT, `Admin agent failed: ${(e as Error).message}`);
            return "Hey Tony, hit an error on that one. Check the logs. 🔧";
        } finally {
            clearInterval(typingInterval);
        }
    }

    /** Clean up responses — strip leaked tool JSON, thinking tags, PII, instruction leaks */
    private async cleanReply(content: string): Promise<string> {
        // Use centralized outbound sanitizer for instruction leak detection
        try {
            const { sanitizeOutbound } = await import('../utils/outboundSanitizer.js');
            const sanitized = sanitizeOutbound(content, 'messenger_admin', "Hey Tony, the response had some internal info. Check the dashboard. 🔒");
            if (sanitized.hadIssues) {
                return sanitized.text;
            }
            return sanitized.text;
        } catch {
            // Fallback to inline cleaning if sanitizer module not available
        }

        let reply = content.trim();
        // Strip thinking tags
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        // Strip leaked tool call artifacts
        reply = reply.replace(/\[TOOL_CALL\][\s\S]*/g, '').trim();
        reply = reply.replace(/\{"tool_name":\s*"[^"]*",\s*"tool_input":\s*\{[^}]*\}\}/g, '').trim();
        reply = reply.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
        reply = reply.replace(/```json\s*\{[\s\S]*?\}\s*```/g, '').trim();
        // Strip markdown headers that leak from planning
        reply = reply.replace(/^##\s+Plan[\s\S]*$/gm, '').trim();
        // PII safety
        if (containsPII(reply)) {
            reply = "Done, Tony — but the response had sensitive info. Check the dashboard. 🔒";
        }
        return reply;
    }

    /** Get the verify token for webhook setup */
    getVerifyToken(): string {
        return this.verifyToken;
    }
}
