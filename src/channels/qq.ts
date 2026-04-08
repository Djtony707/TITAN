/**
 * TITAN — QQ Bot Channel Adapter
 * Connects TITAN to Tencent QQ (900M+ registered users) via the QQ Bot API.
 * Requires: QQ Bot App ID and Token from q.qq.com developer portal.
 *
 * This is a scaffold — the full implementation requires the qq-bot-sdk
 * which should be installed when QQ channel is enabled.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'QQ';

export interface QQConfig {
    enabled: boolean;
    appId: string;
    token: string;
    secret?: string;
    sandbox?: boolean;
}

export class QQChannel {
    private config: QQConfig;
    private messageHandler: ((content: string, channel: string, userId: string) => Promise<string>) | null = null;

    constructor(config: QQConfig) {
        this.config = config;
    }

    setMessageHandler(handler: (content: string, channel: string, userId: string) => Promise<string>): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
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

        const client = createOpenAPI({
            appID: this.config.appId,
            token: this.config.token,
            sandbox: this.config.sandbox ?? true,
        });

        const ws = createWebsocket({
            appID: this.config.appId,
            token: this.config.token,
            sandbox: this.config.sandbox ?? true,
            intents: ['AT_MESSAGES', 'DIRECT_MESSAGES', 'GUILD_MESSAGES'],
        });

        ws.on('READY', () => {
            logger.info(COMPONENT, 'QQ Bot connected and ready');
        });

        ws.on('AT_MESSAGE_CREATE', async (data: { msg: { content: string; author: { id: string }; channel_id: string; id: string } }) => {
            const { content, author, channel_id, id } = data.msg;
            if (!this.messageHandler) return;

            try {
                const reply = await this.messageHandler(content.trim(), `qq/${channel_id}`, `qq-${author.id}`);
                await client.messageApi.postMessage(channel_id, {
                    msg_id: id,
                    content: reply,
                });
            } catch (err) {
                logger.error(COMPONENT, `QQ message handling error: ${(err as Error).message}`);
            }
        });
        */

        logger.info(COMPONENT, 'QQ channel scaffold loaded — install qq-bot-sdk for full functionality');
    }

    async stop(): Promise<void> {
        logger.info(COMPONENT, 'QQ Bot stopped');
    }
}
