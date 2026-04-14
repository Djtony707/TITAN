/**
 * TITAN — QQ Bot Channel Adapter
 * Connects TITAN to Tencent QQ (900M+ registered users) via the QQ Bot API.
 * Requires: QQ Bot App ID and Token from q.qq.com developer portal.
 *
 * This is a scaffold — the full implementation requires the qq-bot-sdk
 * which should be installed when QQ channel is enabled.
 *
 * Hunt Finding #26 (2026-04-14): previously this file exported a standalone
 * QQChannel class that did NOT extend ChannelAdapter, which meant any
 * outbound content sent via QQ would bypass the centralized outbound
 * sanitizer (Finding #13). Refactored to extend ChannelAdapter so that the
 * base class's `deliver()` automatically routes sends through
 * sanitizeOutbound — making QQ safe by default the moment the SDK
 * integration is wired in.
 */
import { ChannelAdapter, type OutboundMessage, type ChannelStatus } from './base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'QQ';

export interface QQConfig {
    enabled: boolean;
    appId: string;
    token: string;
    secret?: string;
    sandbox?: boolean;
}

export class QQChannel extends ChannelAdapter {
    readonly name = 'qq';
    readonly displayName = 'QQ';

    private config: QQConfig;
    private connected = false;
    // When the SDK is wired in, the raw client + websocket live here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private client: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private ws: any = null;

    constructor(config: QQConfig) {
        super();
        this.config = config;
    }

    async connect(): Promise<void> {
        if (!this.config.appId || !this.config.token) {
            logger.warn(COMPONENT, 'QQ channel not configured — set channels.qq.appId and channels.qq.token');
            return;
        }

        logger.info(COMPONENT, `QQ Bot starting (appId=${this.config.appId}, sandbox=${this.config.sandbox ?? true})`);

        // NOTE: Full implementation requires qq-bot-sdk package
        // npm install qq-bot-sdk
        // This scaffold provides the integration point — install the SDK and uncomment below:

        /*
        const { createOpenAPI, createWebsocket } = await import('qq-bot-sdk');

        this.client = createOpenAPI({
            appID: this.config.appId,
            token: this.config.token,
            sandbox: this.config.sandbox ?? true,
        });

        this.ws = createWebsocket({
            appID: this.config.appId,
            token: this.config.token,
            sandbox: this.config.sandbox ?? true,
            intents: ['AT_MESSAGES', 'DIRECT_MESSAGES', 'GUILD_MESSAGES'],
        });

        this.ws.on('READY', () => {
            logger.info(COMPONENT, 'QQ Bot connected and ready');
            this.connected = true;
        });

        this.ws.on('AT_MESSAGE_CREATE', async (data: { msg: { content: string; author: { id: string }; channel_id: string; id: string } }) => {
            const { content, author, channel_id, id } = data.msg;
            // Emit inbound — the routing layer will call this.deliver() for the reply,
            // which runs through sanitizeOutbound before reaching send().
            this.emit('message', {
                id,
                channel: `qq/${channel_id}`,
                userId: `qq-${author.id}`,
                content: content.trim(),
                groupId: channel_id,
                replyTo: id,
                timestamp: new Date(),
                raw: data,
            });
        });
        */

        logger.info(COMPONENT, 'QQ channel scaffold loaded — install qq-bot-sdk for full functionality');
    }

    async disconnect(): Promise<void> {
        logger.info(COMPONENT, 'QQ Bot stopped');
        this.connected = false;
        this.client = null;
        this.ws = null;
    }

    /**
     * Raw transport send() — called by the base class `deliver()` AFTER the
     * content has been run through the outbound sanitizer. Do NOT call this
     * directly from the gateway or any routing layer; use `deliver()`.
     */
    async send(message: OutboundMessage): Promise<void> {
        if (!this.connected || !this.client) {
            logger.warn(COMPONENT, 'QQ channel not connected — drop');
            return;
        }
        // Uncomment when qq-bot-sdk is installed:
        /*
        const channelId = message.groupId || message.userId;
        if (!channelId) {
            logger.warn(COMPONENT, 'QQ send missing groupId/userId — drop');
            return;
        }
        await this.client.messageApi.postMessage(channelId, {
            msg_id: message.replyTo,
            content: message.content,
        });
        */
        logger.debug(COMPONENT, `QQ send (scaffold): ${message.content.slice(0, 60)}`);
    }

    getStatus(): ChannelStatus {
        return {
            name: this.displayName,
            connected: this.connected,
            error: !this.config.appId ? 'appId not configured' : undefined,
        };
    }
}
