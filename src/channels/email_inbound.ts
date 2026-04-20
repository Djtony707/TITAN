/**
 * TITAN — Email Inbound Channel Adapter
 * Polls an IMAP mailbox for incoming emails and emits them as messages.
 * Requires an IMAP client library (e.g. imapflow).
 */
import { ChannelAdapter, type InboundMessage, type OutboundMessage, type ChannelStatus } from './base.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'EmailInbound';

export class EmailInboundChannel extends ChannelAdapter {
    readonly name = 'email_inbound';
    readonly displayName = 'Email (Inbound)';
    private connected = false;
    private client: unknown = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    async connect(): Promise<void> {
        const config = loadConfig();
        const channelConfig = config.channels.email_inbound;

        if (!channelConfig.enabled) {
            logger.info(COMPONENT, 'Email Inbound channel is disabled');
            return;
        }

        // token = IMAP connection string: user:pass@host:port (or host:port with apiKey as password)
        // apiKey = password (if not embedded in token)
        const token = channelConfig.token;
        if (!token) {
            logger.warn(COMPONENT, 'Email IMAP config not set (token = user@host:port, apiKey = password)');
            return;
        }

        try {
            // Parse connection string: user@host:port
            const atIdx = token.lastIndexOf('@');
            if (atIdx === -1) throw new Error('Invalid IMAP token format. Expected: user@host:port');
            const user = token.substring(0, atIdx);
            const hostPort = token.substring(atIdx + 1);
            const [host, portStr] = hostPort.split(':');
            const port = parseInt(portStr || '993', 10);
            const pass = channelConfig.apiKey;
            if (!pass) throw new Error('IMAP password not configured (set channels.email_inbound.apiKey)');

            // imapflow is an optional dependency — resolved dynamically at runtime
            const { ImapFlow } = await import('imapflow');
            const client = new ImapFlow({
                host,
                port,
                secure: port === 993,
                auth: { user, pass },
                logger: false,
            });

            await client.connect();
            this.client = client;
            this.connected = true;
            logger.info(COMPONENT, `Connected to IMAP ${host}:${port} as ${user}`);

            // Start polling for new messages
            await this.pollMessages();
            this.pollTimer = setInterval(() => {
                this.pollMessages().catch((e) =>
                    logger.error(COMPONENT, `Poll error: ${(e as Error).message}`)
                );
            }, 30_000); // Poll every 30 seconds
        } catch (error) {
            logger.error(COMPONENT, `Failed to connect: ${(error as Error).message}`);
            logger.info(COMPONENT, 'Install imapflow with: npm install imapflow');
        }
    }

    private async pollMessages(): Promise<void> {
        if (!this.client) return;
        const imap = this.client as {
            getMailboxLock(mailbox: string): Promise<{ release(): void }>;
            fetch(query: { seen: boolean }, opts: { source: boolean; envelope: boolean; uid: boolean }): AsyncIterable<{
                uid: number;
                envelope: { from?: Array<{ address: string; name?: string }>; subject?: string; date?: Date; messageId?: string };
                source: Buffer;
            }>;
            messageFlagsAdd(query: { uid: number }, flags: string[]): Promise<void>;
        };

        const lock = await imap.getMailboxLock('INBOX');
        try {
            for await (const msg of imap.fetch({ seen: false }, { source: true, envelope: true, uid: true })) {
                const from = msg.envelope.from?.[0];
                const inbound: InboundMessage = {
                    id: msg.envelope.messageId || String(msg.uid),
                    channel: 'email_inbound',
                    userId: from?.address || 'unknown',
                    userName: from?.name || from?.address,
                    content: `Subject: ${msg.envelope.subject || '(no subject)'}\n\n${msg.source.toString('utf-8').substring(0, 4000)}`,
                    timestamp: msg.envelope.date || new Date(),
                    raw: msg,
                };
                this.emit('message', inbound);
                // Mark as seen after processing
                await imap.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
            }
        } finally {
            lock.release();
        }
    }

    async disconnect(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.client) {
            await (this.client as { logout(): Promise<void> }).logout();
            this.client = null;
            this.connected = false;
            logger.info(COMPONENT, 'Disconnected');
        }
    }

    async send(message: OutboundMessage): Promise<void> {
        // Email inbound is receive-only; outbound email would be a separate SMTP adapter
        logger.warn(COMPONENT, `Email inbound channel does not support sending. Target: ${message.userId || message.groupId}`);
        logger.info(COMPONENT, 'Use an SMTP/email outbound channel for sending emails');
    }

    getStatus(): ChannelStatus {
        return { name: this.displayName, connected: this.connected };
    }
}
