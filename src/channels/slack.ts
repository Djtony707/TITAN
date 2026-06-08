/**
 * TITAN — Slack Channel Adapter
 */
import { ChannelAdapter, type InboundMessage, type OutboundMessage, type ChannelStatus } from './base.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Slack';

export class SlackChannel extends ChannelAdapter {
    readonly name = 'slack';
    readonly displayName = 'Slack';
    private connected = false;
    private boltClient: unknown = null;

    async connect(): Promise<void> {
        const config = loadConfig();
        const channelConfig = config.channels.slack;
        if (!channelConfig.enabled) { logger.info(COMPONENT, 'Slack channel is disabled'); return; }
        if (!channelConfig.token) { logger.warn(COMPONENT, 'Slack token not configured'); return; }

        try {
            // v6.5 — Socket Mode needs a distinct app-level token (xapp-…). The old
            // code fed both signingSecret and appToken the single apiKey, so Bolt's
            // start() always threw and Slack never connected. Require an explicit
            // appToken and skip honestly (don't pretend) if it's missing.
            const appToken = channelConfig.appToken;
            if (!appToken) {
                logger.warn(COMPONENT, 'Slack Socket Mode requires an app-level token (xapp-…). Set channels.slack.appToken (and token = your xoxb- bot token). Not connecting.');
                return;
            }
            // Dynamic import to only load Bolt when used
            // @ts-expect-error optional peer dependency — install with: npm install @slack/bolt
            const { App } = await import('@slack/bolt');
            const app = new App({
                token: channelConfig.token,
                signingSecret: channelConfig.signingSecret || undefined,
                socketMode: true,
                appToken,
            });

            app.message(async ({ message }: { message: { subtype?: string; user?: string; ts: string; text?: string; channel?: string } }) => {
                if (message.subtype) return;
                // Attempt to resolve user display name from Slack user info
                let userName: string | undefined;
                try {
                    if (app.client && message.user) {
                        const info = await app.client.users.info({ user: message.user });
                        const infoObj = info as Record<string, unknown>;
                        const userObj = (infoObj?.user ?? {}) as Record<string, unknown>;
                        const profileObj = (userObj?.profile ?? {}) as Record<string, unknown>;
                        userName = (profileObj?.display_name as string)
                            || (userObj?.real_name as string)
                            || (userObj?.name as string);
                    }
                } catch { /* Fallback: userName stays undefined */ }
                const inbound: InboundMessage = {
                    id: message.ts, channel: 'slack', userId: message.user || 'unknown',
                    userName,
                    content: message.text || '', groupId: message.channel,
                    timestamp: new Date(parseFloat(message.ts) * 1000), raw: message,
                };
                this.emit('message', inbound);
            });

            await app.start();
            this.boltClient = app.client;
            this.connected = true;
            logger.info(COMPONENT, 'Connected to Slack');
        } catch (error) {
            logger.error(COMPONENT, `Failed to connect: ${(error as Error).message}`);
            logger.info(COMPONENT, 'Install Bolt with: npm install @slack/bolt');
        }
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.boltClient = null;
    }

    async send(message: OutboundMessage): Promise<void> {
        if (!this.boltClient) {
            logger.warn(COMPONENT, 'Slack not connected — cannot send message');
            return;
        }
        const channel = message.groupId || message.userId;
        if (!channel) {
            logger.warn(COMPONENT, 'No channel or userId provided for Slack message');
            return;
        }
        try {
            await (this.boltClient as { chat: { postMessage(opts: { channel: string; text: string }): Promise<void> } }).chat.postMessage({ channel, text: message.content });
            logger.debug(COMPONENT, `Sent message to ${channel}`);
        } catch (error) {
            logger.error(COMPONENT, `Failed to send message: ${(error as Error).message}`);
        }
    }

    getStatus(): ChannelStatus { return { name: this.displayName, connected: this.connected }; }
}
