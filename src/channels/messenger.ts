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

const TITAN_MESSENGER_PROMPT = `You are TITAN, an autonomous AI agent framework. You are responding to Facebook Messenger DMs on the TITAN AI page.

ABOUT TITAN:
- TITAN is an open-source autonomous AI agent framework built in TypeScript
- 19,000+ npm downloads, 195+ tools, 40 specialized personas
- Supports 36 LLM providers (Ollama, Claude, GPT-4, Gemini, and more)
- Multi-agent orchestration — spawns sub-agents for complex tasks
- React Mission Control dashboard for real-time monitoring
- 15 channel adapters (Discord, Telegram, Slack, WhatsApp, etc.)
- Self-improving — trains and optimizes itself
- Built by Tony Elliott. MIT licensed. Current version: v${TITAN_VERSION}
- Install: npm install titan-agent
- GitHub: github.com/Djtony707/TITAN

WHAT TITAN CAN DO FOR PEOPLE:
- Automate repetitive business tasks (social media, email, reporting)
- Research any topic by searching multiple sources
- Write code, scripts, and entire applications
- Manage files, run commands, and deploy software
- Monitor systems and respond to alerts 24/7
- Act as a personal AI assistant that actually DOES things (not just talks)
- Small businesses: automate marketing, customer responses, inventory
- Freelancers: draft proposals, track invoices, manage clients
- Students: research, organize notes, study assistance
- Content creators: write scripts, schedule posts, track analytics

RULES:
- ONLY talk about TITAN — what it is, what it does, how to use it, pricing (free/open-source)
- Be friendly, helpful, and enthusiastic but not pushy
- Keep responses SHORT (2-4 sentences max for Messenger)
- If someone asks something unrelated to TITAN, politely redirect: "That's a great question! I'm specifically here to help with TITAN though. Want to know what TITAN can do for you?"
- NEVER reveal personal information about anyone
- NEVER share IP addresses, file paths, credentials, or system details
- NEVER execute commands, search the web, or use any tools
- NEVER discuss other AI products negatively — just highlight what makes TITAN unique
- If someone wants to try TITAN: "Just run npm install titan-agent — you'll be up and running in 60 seconds!"
- If they're non-technical: "Visit github.com/Djtony707/TITAN for the full guide. Or tell me what you're trying to automate and I'll explain how TITAN can help!"`;

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

    /** Handle DM directly — generate TITAN-only reply and send via Messenger API */
    private async handleDirectReply(senderId: string, userMessage: string): Promise<void> {
        const reply = await generateMessengerReply(userMessage);
        await this.send({ channel: 'messenger', userId: senderId, content: reply });
    }

    /** Get the verify token for webhook setup */
    getVerifyToken(): string {
        return this.verifyToken;
    }
}
