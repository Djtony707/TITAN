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
import { TITAN_VERSION } from '../utils/constants.js';
import logger from '../utils/logger.js';

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

async function generateMessengerReply(userMessage: string): Promise<string> {
    const config = loadConfig();
    const model = config.agent?.model || 'ollama/glm-5.1:cloud';

    try {
        const response = await chat({
            model,
            messages: [
                { role: 'system', content: TITAN_MESSENGER_PROMPT },
                { role: 'user', content: userMessage },
            ],
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

        this.connected = true;
        logger.info(COMPONENT, `Messenger channel ready (Page ID: ${this.pageId}). Webhook: /api/messenger/webhook`);
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        logger.info(COMPONENT, 'Disconnected');
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

                // Skip if no text
                const text = message?.text as string;
                if (!text || !senderId) continue;

                // Skip messages from the page itself
                if (senderId === this.pageId) continue;

                logger.info(COMPONENT, `Incoming DM from ${senderId}: "${text.slice(0, 60)}..."`);

                // Respond directly with TITAN-only content — do NOT route through agent system
                this.handleDirectReply(senderId, text).catch(e =>
                    logger.error(COMPONENT, `Direct reply failed: ${(e as Error).message}`),
                );
            }
        }
    }

    /** Tony's Facebook user ID — receives notifications about all conversations */
    private readonly ownerId = '10233541366698333';

    /** Handle DM directly — generate TITAN-only reply and send via Messenger API */
    private async handleDirectReply(senderId: string, userMessage: string): Promise<void> {
        const reply = await generateMessengerReply(userMessage);
        await this.send({ channel: 'messenger', userId: senderId, content: reply });

        // Notify Tony about the conversation (skip if Tony is the sender)
        if (senderId !== this.ownerId) {
            const notification = `📩 New DM on TITAN AI page\nFrom: ${senderId}\nThey said: "${userMessage.slice(0, 200)}"\nI replied: "${reply.slice(0, 200)}"`;
            await this.send({ channel: 'messenger', userId: this.ownerId, content: notification }).catch(e =>
                logger.debug(COMPONENT, `Owner notification failed: ${(e as Error).message}`),
            );
        }
    }

    /** Get the verify token for webhook setup */
    getVerifyToken(): string {
        return this.verifyToken;
    }
}
