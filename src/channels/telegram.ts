/**
 * TITAN — Telegram Channel Adapter
 */
import { ChannelAdapter, type InboundMessage, type OutboundMessage, type ChannelStatus } from './base.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Telegram';

export class TelegramChannel extends ChannelAdapter {
    readonly name = 'telegram';
    readonly displayName = 'Telegram';
    private connected = false;
    private bot: unknown = null;

    async connect(): Promise<void> {
        const config = loadConfig();
        const channelConfig = config.channels.telegram;

        if (!channelConfig.enabled) {
            logger.info(COMPONENT, 'Telegram channel is disabled');
            return;
        }

        const token = channelConfig.token;
        if (!token) {
            logger.warn(COMPONENT, 'Telegram token not configured');
            return;
        }

        try {
            // @ts-expect-error — grammy is an optional dependency
            const { Bot } = await import('grammy');
            const bot = new Bot(token);

            bot.catch((err: unknown) => {
                logger.error(COMPONENT, `Grammy error: ${(err as Error).message ?? err}`);
            });

            bot.on('message:text', (ctx: { from?: { id: number; username?: string; first_name: string }; message: { message_id: number; text: string; date: number }; chat: { type: string; id: number } }) => {
                if (!ctx.from) return;
                try {
                    const inbound: InboundMessage = {
                        id: String(ctx.message.message_id),
                        channel: 'telegram',
                        userId: String(ctx.from.id),
                        userName: ctx.from.username || ctx.from.first_name,
                        content: ctx.message.text,
                        groupId: ctx.chat.type !== 'private' ? String(ctx.chat.id) : undefined,
                        timestamp: new Date(ctx.message.date * 1000),
                        raw: ctx,
                    };
                    this.emit('message', inbound);
                } catch (error) {
                    logger.error(COMPONENT, `Message handler error: ${(error as Error).message}`);
                }
            });

            bot.start();
            this.bot = bot;
            this.connected = true;
            logger.info(COMPONENT, 'Connected to Telegram');
        } catch (error) {
            logger.error(COMPONENT, `Failed to connect: ${(error as Error).message}`);
            logger.info(COMPONENT, 'Install grammy with: npm install grammy');
        }
    }

    async disconnect(): Promise<void> {
        if (this.bot) {
            (this.bot as unknown as { stop(): void }).stop();
            this.connected = false;
            logger.info(COMPONENT, 'Disconnected');
        }
    }

    async send(message: OutboundMessage): Promise<void> {
        if (!this.bot || !this.connected) return;
        try {
            // v6.5 — prefer the group chat so a group reply posts in the group,
            // not the triggering user's private DM. For a DM, groupId is unset and
            // userId (== the private chat id) is the correct target.
            const chatId = message.groupId || message.userId;
            if (chatId) {
                await (this.bot as unknown as { api: { sendMessage(chatId: string, content: string, opts: Record<string, string>): Promise<void> } }).api.sendMessage(chatId, message.content, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            logger.error(COMPONENT, `Send failed: ${(error as Error).message}`);
        }
    }

    getStatus(): ChannelStatus {
        return { name: this.displayName, connected: this.connected };
    }
}
