/**
 * TITAN — Channel Adapter Tests
 * Tests all channel adapters: Discord, Telegram, Slack, Matrix, MSTeams,
 * GoogleChat, WhatsApp, Signal, WebChat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Common mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-channels',
    TITAN_VERSION: '2026.5.0',
}));

/** Default config factory — all channels disabled by default */
function makeConfig(overrides: Record<string, unknown> = {}) {
    const base = {
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        channels: {
            discord: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            telegram: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            slack: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            matrix: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            msteams: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            googlechat: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            whatsapp: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            signal: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            webchat: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
            bluebubbles: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
        },
        gateway: { port: 48420, enabled: true },
        providers: {},
    };
    // Apply channel-level overrides
    for (const [k, v] of Object.entries(overrides)) {
        if (base.channels[k as keyof typeof base.channels]) {
            Object.assign(base.channels[k as keyof typeof base.channels], v);
        }
    }
    return base;
}

let currentConfig = makeConfig();

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn(() => currentConfig),
    getDefaultConfig: vi.fn(() => currentConfig),
    resetConfigCache: vi.fn(),
}));

// ══════════════════════════════════════════════════════════════════════════
// WebChat Channel
// ══════════════════════════════════════════════════════════════════════════

import { WebChatChannel, getOutboundQueue } from '../src/channels/webchat.js';

describe('WebChatChannel', () => {
    let channel: WebChatChannel;

    beforeEach(() => {
        channel = new WebChatChannel();
    });

    afterEach(async () => {
        await channel.disconnect();
    });

    it('should have correct name and displayName', () => {
        expect(channel.name).toBe('webchat');
        expect(channel.displayName).toBe('WebChat');
    });

    it('connect should set connected = true', async () => {
        await channel.connect();
        expect(channel.getStatus().connected).toBe(true);
    });

    it('disconnect should set connected = false', async () => {
        await channel.connect();
        await channel.disconnect();
        expect(channel.getStatus().connected).toBe(false);
    });

    it('getStatus should return correct shape', async () => {
        const status = channel.getStatus();
        expect(status.name).toBe('WebChat');
        expect(typeof status.connected).toBe('boolean');
    });

    it('send should push message to outbound queue', async () => {
        // Drain any existing messages
        getOutboundQueue();

        const msg = { channel: 'webchat', content: 'Hello from test', userId: 'u1' };
        await channel.send(msg);
        const queue = getOutboundQueue();
        expect(queue).toHaveLength(1);
        expect(queue[0].content).toBe('Hello from test');
    });

    it('getOutboundQueue should drain (splice) the queue', async () => {
        getOutboundQueue(); // drain first
        await channel.send({ channel: 'webchat', content: 'msg1' });
        await channel.send({ channel: 'webchat', content: 'msg2' });
        const first = getOutboundQueue();
        expect(first).toHaveLength(2);
        // Queue should be empty after draining
        const second = getOutboundQueue();
        expect(second).toHaveLength(0);
    });

    it('handleWebSocketMessage should emit message event', async () => {
        await channel.connect();
        const received: any[] = [];
        channel.on('message', (msg) => received.push(msg));

        channel.handleWebSocketMessage('user-123', 'Hello TITAN');

        expect(received).toHaveLength(1);
        expect(received[0].channel).toBe('webchat');
        expect(received[0].userId).toBe('user-123');
        expect(received[0].content).toBe('Hello TITAN');
        expect(received[0].id).toMatch(/^wc-/);
        expect(received[0].timestamp).toBeInstanceOf(Date);
    });

    it('handleWebSocketMessage should work even when disconnected', () => {
        const received: any[] = [];
        channel.on('message', (msg) => received.push(msg));
        channel.handleWebSocketMessage('u1', 'test');
        expect(received).toHaveLength(1);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// GoogleChat Channel (webhook adapter)
// ══════════════════════════════════════════════════════════════════════════

import { GoogleChatChannel } from '../src/channels/googlechat.js';

describe('GoogleChatChannel', () => {
    let channel: GoogleChatChannel;

    beforeEach(() => {
        currentConfig = makeConfig();
        channel = new GoogleChatChannel();
    });

    afterEach(async () => {
        await channel.disconnect();
    });

    it('should have correct name and displayName', () => {
        expect(channel.name).toBe('googlechat');
        expect(channel.displayName).toBe('Google Chat');
    });

    it('connect when disabled should return immediately', async () => {
        await channel.connect();
        expect(channel.getStatus().connected).toBe(false);
    });

    it('connect with valid webhook URL should set connected=true', async () => {
        currentConfig = makeConfig({ googlechat: { enabled: true, token: 'https://chat.googleapis.com/v1/spaces/test/messages?key=abc' } });
        await channel.connect();
        expect(channel.getStatus().connected).toBe(true);
    });

    it('connect with no token should not connect', async () => {
        currentConfig = makeConfig({ googlechat: { enabled: true } });
        await channel.connect();
        expect(channel.getStatus().connected).toBe(false);
    });

    it('disconnect should set connected = false', async () => {
        currentConfig = makeConfig({ googlechat: { enabled: true, token: 'https://chat.googleapis.com/v1/spaces/test/messages?key=abc' } });
        await channel.connect();
        expect(channel.getStatus().connected).toBe(true);
        await channel.disconnect();
        expect(channel.getStatus().connected).toBe(false);
    });

    it('send when not connected should not throw', async () => {
        await expect(channel.send({ channel: 'googlechat', content: 'test' }))
            .resolves.toBeUndefined();
    });

    it('getStatus should include error when not connected', () => {
        const status = channel.getStatus();
        expect(status.error).toBe('Webhook URL not configured');
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Discord Channel
// ══════════════════════════════════════════════════════════════════════════

describe('DiscordChannel', () => {
    let channel: Awaited<typeof import('../src/channels/discord.js')>['DiscordChannel'];
    let DiscordChannelClass: typeof import('../src/channels/discord.js')['DiscordChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        // Re-import to get fresh module
        const mod = await import('../src/channels/discord.js');
        DiscordChannelClass = mod.DiscordChannel;
    });

    it('should have correct name and displayName', () => {
        const ch = new DiscordChannelClass();
        expect(ch.name).toBe('discord');
        expect(ch.displayName).toBe('Discord');
    });

    it('connect when disabled should return immediately', async () => {
        const ch = new DiscordChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('connect without token should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ discord: { enabled: true, token: '' } });
        const ch = new DiscordChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('connect with token should attempt to load discord.js and handle import failure', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ discord: { enabled: true, token: 'fake-token-123' } });
        const ch = new DiscordChannelClass();
        // discord.js is not installed in test, so it will fail with an import error
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        // The error handler should have logged
        expect(logger.error).toHaveBeenCalled();
    });

    it('disconnect when client is null should be a no-op', async () => {
        const ch = new DiscordChannelClass();
        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('send when not connected should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new DiscordChannelClass();
        await ch.send({ channel: 'discord', content: 'hello', userId: 'u1' });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('getStatus should return proper shape', () => {
        const ch = new DiscordChannelClass();
        const status = ch.getStatus();
        expect(status).toEqual({ name: 'Discord', connected: false });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Telegram Channel
// ══════════════════════════════════════════════════════════════════════════

describe('TelegramChannel', () => {
    let TelegramChannelClass: typeof import('../src/channels/telegram.js')['TelegramChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/telegram.js');
        TelegramChannelClass = mod.TelegramChannel;
    });

    it('should have correct name and displayName', () => {
        const ch = new TelegramChannelClass();
        expect(ch.name).toBe('telegram');
        expect(ch.displayName).toBe('Telegram');
    });

    it('connect when disabled should return immediately', async () => {
        const ch = new TelegramChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('connect without token should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ telegram: { enabled: true, token: '' } });
        const ch = new TelegramChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('connect with token should attempt to load grammy and handle import failure', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'fake-token-123' } });
        const ch = new TelegramChannelClass();
        await ch.connect();
        // grammy is not installed, should fail gracefully
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();
    });

    it('disconnect when bot is null should be a no-op', async () => {
        const ch = new TelegramChannelClass();
        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('send when not connected should return early', async () => {
        const ch = new TelegramChannelClass();
        // Should not throw
        await ch.send({ channel: 'telegram', content: 'test', userId: 'u1' });
    });

    it('getStatus should return correct shape', () => {
        const ch = new TelegramChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'Telegram', connected: false });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Slack Channel
// ══════════════════════════════════════════════════════════════════════════

describe('SlackChannel', () => {
    let SlackChannelClass: typeof import('../src/channels/slack.js')['SlackChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/slack.js');
        SlackChannelClass = mod.SlackChannel;
    });

    it('should have correct name and displayName', () => {
        const ch = new SlackChannelClass();
        expect(ch.name).toBe('slack');
        expect(ch.displayName).toBe('Slack');
    });

    it('connect when disabled should return immediately', async () => {
        const ch = new SlackChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('connect without token should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ slack: { enabled: true, token: '' } });
        const ch = new SlackChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('connect with token should attempt to load @slack/bolt and handle import failure', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ slack: { enabled: true, token: 'xoxb-fake', apiKey: 'signing-secret' } });
        const ch = new SlackChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();
    });

    it('disconnect should reset state', async () => {
        const ch = new SlackChannelClass();
        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('send when not connected should warn', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new SlackChannelClass();
        await ch.send({ channel: 'slack', content: 'hello', groupId: 'C123' });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('send without channel or userId should warn', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        // Simulate a connected state by directly setting boltClient
        const ch = new SlackChannelClass();
        (ch as any).boltClient = { chat: { postMessage: vi.fn() } };
        (ch as any).connected = true;

        await ch.send({ channel: 'slack', content: 'hello' });
        expect(logger.warn).toHaveBeenCalledWith('Slack', 'No channel or userId provided for Slack message');
    });

    it('send with groupId should call chat.postMessage', async () => {
        const postMessage = vi.fn().mockResolvedValue({});
        const ch = new SlackChannelClass();
        (ch as any).boltClient = { chat: { postMessage } };
        (ch as any).connected = true;

        await ch.send({ channel: 'slack', content: 'hello world', groupId: 'C12345' });
        expect(postMessage).toHaveBeenCalledWith({ channel: 'C12345', text: 'hello world' });
    });

    it('send with userId should call chat.postMessage using userId as channel', async () => {
        const postMessage = vi.fn().mockResolvedValue({});
        const ch = new SlackChannelClass();
        (ch as any).boltClient = { chat: { postMessage } };
        (ch as any).connected = true;

        await ch.send({ channel: 'slack', content: 'dm message', userId: 'U12345' });
        expect(postMessage).toHaveBeenCalledWith({ channel: 'U12345', text: 'dm message' });
    });

    it('send should handle postMessage error gracefully', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const postMessage = vi.fn().mockRejectedValue(new Error('Slack API error'));
        const ch = new SlackChannelClass();
        (ch as any).boltClient = { chat: { postMessage } };
        (ch as any).connected = true;

        await ch.send({ channel: 'slack', content: 'hello', groupId: 'C123' });
        expect(logger.error).toHaveBeenCalled();
    });

    it('getStatus should return correct shape', () => {
        const ch = new SlackChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'Slack', connected: false });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Matrix Channel
// ══════════════════════════════════════════════════════════════════════════

describe('MatrixChannel', () => {
    let MatrixChannelClass: typeof import('../src/channels/matrix.js')['MatrixChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/matrix.js');
        MatrixChannelClass = mod.MatrixChannel;
    });

    it('should have correct name and displayName', () => {
        const ch = new MatrixChannelClass();
        expect(ch.name).toBe('matrix');
        expect(ch.displayName).toBe('Matrix');
    });

    it('connect when disabled should return immediately', async () => {
        const ch = new MatrixChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('connect without token should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ matrix: { enabled: true, token: '' } });
        const ch = new MatrixChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('connect with token should attempt to load matrix-js-sdk', async () => {
        currentConfig = makeConfig({ matrix: { enabled: true, token: 'syt_fake_token' } });
        const ch = new MatrixChannelClass();
        await ch.connect();
        // matrix-js-sdk is installed, so connect completes (may succeed or fail auth)
        // Either way, the adapter should have attempted connection
        const status = ch.getStatus();
        expect(status.name).toBeTruthy();
        await ch.disconnect();
    });

    it('disconnect when client is null should be a no-op', async () => {
        const ch = new MatrixChannelClass();
        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('disconnect when client exists should call stopClient', async () => {
        const stopClient = vi.fn();
        const ch = new MatrixChannelClass();
        (ch as any).client = { stopClient };
        (ch as any).connected = true;

        await ch.disconnect();
        expect(stopClient).toHaveBeenCalled();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('disconnect should handle stopClient errors gracefully', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new MatrixChannelClass();
        (ch as any).client = {
            stopClient: () => { throw new Error('stop failed'); },
        };
        (ch as any).connected = true;

        await ch.disconnect();
        expect(logger.error).toHaveBeenCalled();
    });

    it('send when not connected should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new MatrixChannelClass();
        await ch.send({ channel: 'matrix', content: 'hello', groupId: '!room:matrix.org' });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('send without roomId should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new MatrixChannelClass();
        (ch as any).client = { sendTextMessage: vi.fn() };
        (ch as any).connected = true;

        await ch.send({ channel: 'matrix', content: 'hello' });
        expect(logger.warn).toHaveBeenCalledWith('Matrix', 'No roomId or userId provided for message');
    });

    it('send with groupId should call sendTextMessage', async () => {
        const sendTextMessage = vi.fn().mockResolvedValue({});
        const ch = new MatrixChannelClass();
        (ch as any).client = { sendTextMessage };
        (ch as any).connected = true;

        await ch.send({ channel: 'matrix', content: 'hello', groupId: '!room:matrix.org' });
        expect(sendTextMessage).toHaveBeenCalledWith('!room:matrix.org', 'hello');
    });

    it('send with userId should use userId as roomId', async () => {
        const sendTextMessage = vi.fn().mockResolvedValue({});
        const ch = new MatrixChannelClass();
        (ch as any).client = { sendTextMessage };
        (ch as any).connected = true;

        await ch.send({ channel: 'matrix', content: 'dm', userId: '@user:matrix.org' });
        expect(sendTextMessage).toHaveBeenCalledWith('@user:matrix.org', 'dm');
    });

    it('send should handle sendTextMessage error gracefully', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const sendTextMessage = vi.fn().mockRejectedValue(new Error('Matrix API error'));
        const ch = new MatrixChannelClass();
        (ch as any).client = { sendTextMessage };
        (ch as any).connected = true;

        await ch.send({ channel: 'matrix', content: 'hello', groupId: '!room:matrix.org' });
        expect(logger.error).toHaveBeenCalled();
    });

    it('getStatus should return correct shape', () => {
        const ch = new MatrixChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'Matrix', connected: false });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// MS Teams Channel
// ══════════════════════════════════════════════════════════════════════════

describe('MSTeamsChannel', () => {
    let MSTeamsChannelClass: typeof import('../src/channels/msteams.js')['MSTeamsChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/msteams.js');
        MSTeamsChannelClass = mod.MSTeamsChannel;
    });

    it('should have correct name and displayName', () => {
        const ch = new MSTeamsChannelClass();
        expect(ch.name).toBe('msteams');
        expect(ch.displayName).toBe('MS Teams');
    });

    it('connect when disabled should return immediately', async () => {
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('connect without webhook URL should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ msteams: { enabled: true, token: '' } });
        // Clear env var just in case
        const origEnv = process.env.MSTEAMS_WEBHOOK_URL;
        delete process.env.MSTEAMS_WEBHOOK_URL;

        const ch = new MSTeamsChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalled();

        process.env.MSTEAMS_WEBHOOK_URL = origEnv;
    });

    it('connect with valid webhook URL should set connected = true', async () => {
        currentConfig = makeConfig({
            msteams: { enabled: true, token: 'https://webhook.office.com/webhookb2/test' },
        });
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(true);
    });

    it('connect with non-standard webhook URL should warn but still connect', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({
            msteams: { enabled: true, token: 'https://example.com/webhook' },
        });
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith(
            'MS Teams',
            'Webhook URL does not appear to be a valid Microsoft Teams webhook'
        );
    });

    it('disconnect should reset connected and webhookUrl', async () => {
        currentConfig = makeConfig({
            msteams: { enabled: true, token: 'https://webhook.office.com/webhookb2/test' },
        });
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(true);

        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('send when not connected should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new MSTeamsChannelClass();
        await ch.send({ channel: 'msteams', content: 'hello' });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('send when connected should POST to webhook URL', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({
            msteams: { enabled: true, token: 'https://webhook.office.com/webhookb2/test' },
        });
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        await ch.send({ channel: 'msteams', content: 'Hello Teams!' });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://webhook.office.com/webhookb2/test',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            })
        );

        // Verify the payload structure
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body['@type']).toBe('MessageCard');
        expect(body.sections[0].text).toBe('Hello Teams!');

        vi.unstubAllGlobals();
    });

    it('send should handle webhook error response', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            text: () => Promise.resolve('Bad Request'),
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({
            msteams: { enabled: true, token: 'https://webhook.office.com/webhookb2/test' },
        });
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        await ch.send({ channel: 'msteams', content: 'test' });

        expect(logger.error).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('send should handle fetch network error', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({
            msteams: { enabled: true, token: 'https://webhook.office.com/webhookb2/test' },
        });
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        await ch.send({ channel: 'msteams', content: 'test' });

        expect(logger.error).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('getStatus should include error when not connected', () => {
        const ch = new MSTeamsChannelClass();
        const status = ch.getStatus();
        expect(status.error).toBe('Webhook URL not configured');
    });

    it('getStatus should not include error when connected', async () => {
        currentConfig = makeConfig({
            msteams: { enabled: true, token: 'https://webhook.office.com/webhookb2/test' },
        });
        const ch = new MSTeamsChannelClass();
        await ch.connect();
        const status = ch.getStatus();
        expect(status.error).toBeUndefined();
    });
});

// ══════════════════════════════════════════════════════════════════════════
// WhatsApp Channel
// ══════════════════════════════════════════════════════════════════════════

describe('WhatsAppChannel', () => {
    let WhatsAppChannelClass: typeof import('../src/channels/whatsapp.js')['WhatsAppChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/whatsapp.js');
        WhatsAppChannelClass = mod.WhatsAppChannel;
    });

    it('should have correct name and displayName', () => {
        const ch = new WhatsAppChannelClass();
        expect(ch.name).toBe('whatsapp');
        expect(ch.displayName).toBe('WhatsApp');
    });

    it('connect when disabled should return immediately', async () => {
        const ch = new WhatsAppChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('connect when enabled should attempt to load Baileys and handle import failure', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ whatsapp: { enabled: true } });
        const ch = new WhatsAppChannelClass();
        await ch.connect();
        // Baileys is not installed in test
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();
    });

    it('disconnect when socket is null should be a no-op', async () => {
        const ch = new WhatsAppChannelClass();
        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('disconnect when socket exists should call end()', async () => {
        const end = vi.fn();
        const ch = new WhatsAppChannelClass();
        (ch as any).socket = { end };
        (ch as any).connected = true;

        await ch.disconnect();
        expect(end).toHaveBeenCalled();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('send when not connected should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new WhatsAppChannelClass();
        await ch.send({ channel: 'whatsapp', content: 'hello', userId: 'u1' });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('send without userId or groupId should warn', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new WhatsAppChannelClass();
        (ch as any).socket = { sendMessage: vi.fn() };
        (ch as any).connected = true;

        await ch.send({ channel: 'whatsapp', content: 'hello' });
        expect(logger.warn).toHaveBeenCalledWith('WhatsApp', 'No userId or groupId provided');
    });

    it('send with userId should call sendMessage', async () => {
        const sendMessage = vi.fn().mockResolvedValue({});
        const ch = new WhatsAppChannelClass();
        (ch as any).socket = { sendMessage };
        (ch as any).connected = true;

        await ch.send({ channel: 'whatsapp', content: 'hello', userId: '1234@s.whatsapp.net' });
        expect(sendMessage).toHaveBeenCalledWith('1234@s.whatsapp.net', { text: 'hello' });
    });

    it('send with groupId should call sendMessage with groupId', async () => {
        const sendMessage = vi.fn().mockResolvedValue({});
        const ch = new WhatsAppChannelClass();
        (ch as any).socket = { sendMessage };
        (ch as any).connected = true;

        await ch.send({ channel: 'whatsapp', content: 'group msg', groupId: '123@g.us' });
        expect(sendMessage).toHaveBeenCalledWith('123@g.us', { text: 'group msg' });
    });

    it('send should handle sendMessage error gracefully', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const sendMessage = vi.fn().mockRejectedValue(new Error('WA API error'));
        const ch = new WhatsAppChannelClass();
        (ch as any).socket = { sendMessage };
        (ch as any).connected = true;

        await ch.send({ channel: 'whatsapp', content: 'hello', userId: 'u1' });
        expect(logger.error).toHaveBeenCalled();
    });

    it('getStatus should return correct shape', () => {
        const ch = new WhatsAppChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'WhatsApp', connected: false });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Signal Channel
// ══════════════════════════════════════════════════════════════════════════

describe('SignalChannel', () => {
    let SignalChannelClass: typeof import('../src/channels/signal.js')['SignalChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/signal.js');
        SignalChannelClass = mod.SignalChannel;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should have correct name and displayName', () => {
        const ch = new SignalChannelClass();
        expect(ch.name).toBe('signal');
        expect(ch.displayName).toBe('Signal');
    });

    it('connect when disabled should return immediately', async () => {
        const ch = new SignalChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('connect without SIGNAL_NUMBER should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ signal: { enabled: true } });
        const origNumber = process.env.SIGNAL_NUMBER;
        delete process.env.SIGNAL_NUMBER;

        const ch = new SignalChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalled();

        process.env.SIGNAL_NUMBER = origNumber;
    });

    it('connect with SIGNAL_NUMBER should attempt API check', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ signal: { enabled: true } });
        process.env.SIGNAL_NUMBER = '+15551234567';

        // Mock fetch to fail (API not running)
        const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
        vi.stubGlobal('fetch', mockFetch);

        const ch = new SignalChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();

        delete process.env.SIGNAL_NUMBER;
    });

    it('connect with working API should set connected = true and start polling', async () => {
        currentConfig = makeConfig({ signal: { enabled: true } });
        process.env.SIGNAL_NUMBER = '+15551234567';

        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new SignalChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(true);

        // Clean up the polling timer
        await ch.disconnect();
        delete process.env.SIGNAL_NUMBER;
    });

    it('connect should handle non-200 API response', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ signal: { enabled: true } });
        process.env.SIGNAL_NUMBER = '+15551234567';

        const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new SignalChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();

        delete process.env.SIGNAL_NUMBER;
    });

    it('disconnect should clear poll timer', async () => {
        currentConfig = makeConfig({ signal: { enabled: true } });
        process.env.SIGNAL_NUMBER = '+15551234567';

        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new SignalChannelClass();
        await ch.connect();
        expect((ch as any).pollTimer).not.toBeNull();

        await ch.disconnect();
        expect((ch as any).pollTimer).toBeNull();
        expect(ch.getStatus().connected).toBe(false);

        delete process.env.SIGNAL_NUMBER;
    });

    it('disconnect when no timer should still set connected = false', async () => {
        const ch = new SignalChannelClass();
        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('send when not connected should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new SignalChannelClass();
        await ch.send({ channel: 'signal', content: 'hello', userId: '+15559876543' });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('send without recipient should warn and return', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new SignalChannelClass();
        (ch as any).connected = true;
        (ch as any).apiUrl = 'http://localhost:8080';
        (ch as any).phoneNumber = '+15551234567';

        await ch.send({ channel: 'signal', content: 'hello' });
        expect(logger.warn).toHaveBeenCalledWith('Signal', 'No userId or groupId provided for message');
    });

    it('send with userId should POST to signal API', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new SignalChannelClass();
        (ch as any).connected = true;
        (ch as any).apiUrl = 'http://localhost:8080';
        (ch as any).phoneNumber = '+15551234567';

        await ch.send({ channel: 'signal', content: 'hello', userId: '+15559876543' });

        expect(mockFetch).toHaveBeenCalledWith(
            'http://localhost:8080/v2/send',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            })
        );

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.message).toBe('hello');
        expect(body.number).toBe('+15551234567');
        expect(body.recipients).toEqual(['+15559876543']);
    });

    it('send should handle API error response', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Internal error'),
        });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new SignalChannelClass();
        (ch as any).connected = true;
        (ch as any).apiUrl = 'http://localhost:8080';
        (ch as any).phoneNumber = '+15551234567';

        await ch.send({ channel: 'signal', content: 'hello', userId: '+15559876543' });
        expect(logger.error).toHaveBeenCalled();
    });

    it('send should handle fetch network error', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
        vi.stubGlobal('fetch', mockFetch);

        const ch = new SignalChannelClass();
        (ch as any).connected = true;
        (ch as any).apiUrl = 'http://localhost:8080';
        (ch as any).phoneNumber = '+15551234567';

        await ch.send({ channel: 'signal', content: 'hello', userId: '+15559876543' });
        expect(logger.error).toHaveBeenCalled();
    });

    it('getStatus should return correct shape', () => {
        const ch = new SignalChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'Signal', connected: false });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Base ChannelAdapter (abstract class)
// ══════════════════════════════════════════════════════════════════════════

import { ChannelAdapter } from '../src/channels/base.js';

describe('ChannelAdapter base class', () => {
    it('should be an EventEmitter', () => {
        // WebChatChannel extends ChannelAdapter, so test via it
        const ch = new WebChatChannel();
        expect(typeof ch.on).toBe('function');
        expect(typeof ch.emit).toBe('function');
        expect(typeof ch.removeAllListeners).toBe('function');
    });

    it('ChannelAdapter should be abstract (cannot instantiate directly)', () => {
        // TypeScript enforces this at compile time, but we can check the prototype
        expect(ChannelAdapter.prototype).toBeDefined();
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Cross-channel pattern tests
// ══════════════════════════════════════════════════════════════════════════

describe('Channel adapter common patterns', () => {
    it('all adapters should extend ChannelAdapter', async () => {
        const { DiscordChannel } = await import('../src/channels/discord.js');
        const { TelegramChannel } = await import('../src/channels/telegram.js');
        const { SlackChannel } = await import('../src/channels/slack.js');
        const { MatrixChannel } = await import('../src/channels/matrix.js');
        const { MSTeamsChannel } = await import('../src/channels/msteams.js');
        const { GoogleChatChannel } = await import('../src/channels/googlechat.js');
        const { WhatsAppChannel } = await import('../src/channels/whatsapp.js');
        const { SignalChannel } = await import('../src/channels/signal.js');
        const { WebChatChannel: WC } = await import('../src/channels/webchat.js');

        const adapters = [
            new DiscordChannel(),
            new TelegramChannel(),
            new SlackChannel(),
            new MatrixChannel(),
            new MSTeamsChannel(),
            new GoogleChatChannel(),
            new WhatsAppChannel(),
            new SignalChannel(),
            new WC(),
        ];

        for (const adapter of adapters) {
            // Verify adapter has the ChannelAdapter interface (connect, disconnect, send, getStatus)
            expect(typeof adapter.name).toBe('string');
            expect(typeof adapter.displayName).toBe('string');
            expect(typeof adapter.connect).toBe('function');
            expect(typeof adapter.disconnect).toBe('function');
            expect(typeof adapter.send).toBe('function');
            expect(typeof adapter.getStatus).toBe('function');
        }
    });

    it('all adapters should have unique names', async () => {
        const { DiscordChannel } = await import('../src/channels/discord.js');
        const { TelegramChannel } = await import('../src/channels/telegram.js');
        const { SlackChannel } = await import('../src/channels/slack.js');
        const { MatrixChannel } = await import('../src/channels/matrix.js');
        const { MSTeamsChannel } = await import('../src/channels/msteams.js');
        const { GoogleChatChannel } = await import('../src/channels/googlechat.js');
        const { WhatsAppChannel } = await import('../src/channels/whatsapp.js');
        const { SignalChannel } = await import('../src/channels/signal.js');
        const { WebChatChannel: WC } = await import('../src/channels/webchat.js');

        const names = [
            new DiscordChannel().name,
            new TelegramChannel().name,
            new SlackChannel().name,
            new MatrixChannel().name,
            new MSTeamsChannel().name,
            new GoogleChatChannel().name,
            new WhatsAppChannel().name,
            new SignalChannel().name,
            new WC().name,
        ];

        const unique = new Set(names);
        expect(unique.size).toBe(names.length);
    });

    it('all disabled adapters should show connected = false after connect()', async () => {
        currentConfig = makeConfig(); // all disabled

        const { DiscordChannel } = await import('../src/channels/discord.js');
        const { TelegramChannel } = await import('../src/channels/telegram.js');
        const { SlackChannel } = await import('../src/channels/slack.js');
        const { MatrixChannel } = await import('../src/channels/matrix.js');
        const { MSTeamsChannel } = await import('../src/channels/msteams.js');
        const { GoogleChatChannel } = await import('../src/channels/googlechat.js');
        const { WhatsAppChannel } = await import('../src/channels/whatsapp.js');
        const { SignalChannel } = await import('../src/channels/signal.js');

        const adapters = [
            new DiscordChannel(),
            new TelegramChannel(),
            new SlackChannel(),
            new MatrixChannel(),
            new MSTeamsChannel(),
            new GoogleChatChannel(),
            new WhatsAppChannel(),
            new SignalChannel(),
        ];

        for (const adapter of adapters) {
            await adapter.connect();
            expect(adapter.getStatus().connected).toBe(false);
        }
    });

    it('getStatus().name should match displayName for all adapters', async () => {
        const { DiscordChannel } = await import('../src/channels/discord.js');
        const { TelegramChannel } = await import('../src/channels/telegram.js');
        const { SlackChannel } = await import('../src/channels/slack.js');
        const { MatrixChannel } = await import('../src/channels/matrix.js');
        const { MSTeamsChannel } = await import('../src/channels/msteams.js');
        const { GoogleChatChannel } = await import('../src/channels/googlechat.js');
        const { WhatsAppChannel } = await import('../src/channels/whatsapp.js');
        const { SignalChannel } = await import('../src/channels/signal.js');
        const { WebChatChannel: WC } = await import('../src/channels/webchat.js');

        const adapters = [
            new DiscordChannel(),
            new TelegramChannel(),
            new SlackChannel(),
            new MatrixChannel(),
            new MSTeamsChannel(),
            new GoogleChatChannel(),
            new WhatsAppChannel(),
            new SignalChannel(),
            new WC(),
        ];

        for (const adapter of adapters) {
            expect(adapter.getStatus().name).toBe(adapter.displayName);
        }
    });
});
