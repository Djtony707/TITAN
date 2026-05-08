/**
 * TITAN — IRC Channel Adapter
 *
 * Connects to IRC servers and relays messages. **Optional dependency:**
 * `irc-framework` is NOT a required dependency in package.json. The
 * adapter ships in TITAN's distribution but the import is lazy and
 * graceful — if the channel is enabled in config but `irc-framework`
 * isn't installed, `connect()` logs an actionable error and returns
 * without throwing. To enable IRC, run `npm install irc-framework` in
 * the TITAN install directory and set `channels.irc.enabled = true`.
 *
 * v5.5.31 audit clarification: a "TODO: Install irc-framework" comment
 * inside the dynamic import block previously made this look broken.
 * It's not broken — it's optional-dep design. The comment is now
 * accurate about the install path.
 */
import { ChannelAdapter, type InboundMessage, type OutboundMessage, type ChannelStatus } from './base.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'IRC';

export class IRCChannel extends ChannelAdapter {
    readonly name = 'irc';
    readonly displayName = 'IRC';
    private connected = false;
    private client: unknown = null;

    async connect(): Promise<void> {
        const config = loadConfig();
        const channelConfig = config.channels.irc;

        if (!channelConfig.enabled) {
            logger.info(COMPONENT, 'IRC channel is disabled');
            return;
        }

        const token = channelConfig.token; // Used as server address (host:port)
        if (!token) {
            logger.warn(COMPONENT, 'IRC server address not configured (set channels.irc.token to host:port)');
            return;
        }

        try {
            // irc-framework is an optional dependency — install with
            // `npm install irc-framework` to enable. The dynamic import
            // throws ERR_MODULE_NOT_FOUND when not installed; we catch
            // below and log the actionable install command.
            // @ts-expect-error — irc-framework is an optional dependency, not in package.json
            const { Client } = await import('irc-framework');
            const [host, portStr] = token.split(':');
            const port = parseInt(portStr || '6667', 10);
            const nick = channelConfig.apiKey || 'TitanBot';

            const client = new Client();
            client.connect({ host, port, nick });

            client.on('registered', () => {
                this.connected = true;
                logger.info(COMPONENT, `Connected to IRC server ${host}:${port} as ${nick}`);
                // Join channels from allowFrom list
                for (const ch of channelConfig.allowFrom) {
                    if (ch.startsWith('#')) {
                        client.join(ch);
                        logger.info(COMPONENT, `Joined ${ch}`);
                    }
                }
            });

            client.on('privmsg', (event: { nick: string; target: string; message: string; time?: number }) => {
                try {
                    const inbound: InboundMessage = {
                        id: `${Date.now()}-${event.nick}`,
                        channel: 'irc',
                        userId: event.nick,
                        userName: event.nick,
                        content: event.message,
                        groupId: event.target.startsWith('#') ? event.target : undefined,
                        timestamp: new Date(event.time ?? Date.now()),
                        raw: event,
                    };
                    this.emit('message', inbound);
                } catch (error) {
                    logger.error(COMPONENT, `Message handler error: ${(error as Error).message}`);
                }
            });

            client.on('close', () => {
                this.connected = false;
                logger.info(COMPONENT, 'Disconnected from IRC');
            });

            this.client = client;
        } catch (error) {
            logger.error(COMPONENT, `Failed to connect: ${(error as Error).message}`);
            logger.info(COMPONENT, 'Install irc-framework with: npm install irc-framework');
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            (this.client as { quit(msg: string): void }).quit('TITAN shutting down');
            this.connected = false;
            this.client = null;
            logger.info(COMPONENT, 'Disconnected');
        }
    }

    async send(message: OutboundMessage): Promise<void> {
        if (!this.client || !this.connected) return;
        const target = message.groupId || message.userId;
        if (!target) {
            logger.warn(COMPONENT, 'No target provided for IRC message');
            return;
        }
        try {
            (this.client as { say(target: string, text: string): void }).say(target, message.content);
            logger.debug(COMPONENT, `Sent message to ${target}`);
        } catch (error) {
            logger.error(COMPONENT, `Send failed: ${(error as Error).message}`);
        }
    }

    getStatus(): ChannelStatus {
        return { name: this.displayName, connected: this.connected };
    }
}
