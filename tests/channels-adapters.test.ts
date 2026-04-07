/**
 * TITAN — Channel Adapters Extended Tests
 * Additional coverage for Telegram, Slack, WhatsApp, Discord, Signal, MSTeams, Matrix
 * channel adapters — focusing on message handling callbacks, error paths, and edge cases
 * not covered by channels.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Common mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-channels-ext',
    TITAN_VERSION: '2026.5.2',
}));

function makeConfig(overrides: Record<string, any> = {}) {
    const base: any = {
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
        },
        gateway: { port: 48420, enabled: true },
        providers: {},
    };
    for (const [k, v] of Object.entries(overrides)) {
        if (base.channels[k]) {
            Object.assign(base.channels[k], v);
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

// Mock global fetch for Signal/MSTeams tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import logger from '../src/utils/logger.js';

// ══════════════════════════════════════════════════════════════════════════
// Telegram — Message handler callback & send paths
// ══════════════════════════════════════════════════════════════════════════

describe('TelegramChannel — extended', () => {
    let TelegramChannel: any;
    let mockBotInstance: any;
    let messageHandlers: Map<string, Function>;

    beforeEach(async () => {
        vi.clearAllMocks();
        messageHandlers = new Map();
        mockBotInstance = {
            on: vi.fn((event: string, handler: Function) => {
                messageHandlers.set(event, handler);
            }),
            catch: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            api: {
                sendMessage: vi.fn().mockResolvedValue(true),
            },
        };

        vi.doMock('grammy', () => ({
            Bot: vi.fn(() => mockBotInstance),
        }));

        const mod = await import('../src/channels/telegram.js');
        TelegramChannel = mod.TelegramChannel;
    });

    afterEach(() => {
        vi.doUnmock('grammy');
    });

    it('should emit inbound message when bot receives text message', async () => {
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'test-token-123' } });

        const channel = new TelegramChannel();
        await channel.connect();

        expect(channel.getStatus().connected).toBe(true);
        expect(mockBotInstance.on).toHaveBeenCalledWith('message:text', expect.any(Function));

        // Simulate a message callback
        const handler = messageHandlers.get('message:text');
        expect(handler).toBeDefined();

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        handler!({
            message: { message_id: 42, text: 'Hello TITAN', date: 1700000000 },
            from: { id: 123, username: 'testuser', first_name: 'Test' },
            chat: { type: 'private', id: 123 },
        });

        expect(messages.length).toBe(1);
        expect(messages[0].id).toBe('42');
        expect(messages[0].channel).toBe('telegram');
        expect(messages[0].userId).toBe('123');
        expect(messages[0].userName).toBe('testuser');
        expect(messages[0].content).toBe('Hello TITAN');
        expect(messages[0].groupId).toBeUndefined();
    });

    it('should set groupId for group messages', async () => {
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'test-token-123' } });

        const channel = new TelegramChannel();
        await channel.connect();

        const handler = messageHandlers.get('message:text');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        handler!({
            message: { message_id: 99, text: 'Group msg', date: 1700000001 },
            from: { id: 456, first_name: 'Bob' },
            chat: { type: 'group', id: -100 },
        });

        expect(messages[0].groupId).toBe('-100');
        expect(messages[0].userName).toBe('Bob'); // Falls back to first_name
    });

    it('should send message to chatId with Markdown parse_mode', async () => {
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'test-token-123' } });

        const channel = new TelegramChannel();
        await channel.connect();

        await channel.send({ channel: 'telegram', content: 'Reply text', userId: '123' });

        expect(mockBotInstance.api.sendMessage).toHaveBeenCalledWith(
            '123',
            'Reply text',
            { parse_mode: 'Markdown' }
        );
    });

    it('should prefer userId over groupId when sending', async () => {
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'test-token-123' } });

        const channel = new TelegramChannel();
        await channel.connect();

        await channel.send({ channel: 'telegram', content: 'text', userId: 'u1', groupId: 'g1' });
        expect(mockBotInstance.api.sendMessage).toHaveBeenCalledWith('u1', 'text', expect.any(Object));
    });

    it('should not send when no chatId provided', async () => {
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'test-token-123' } });

        const channel = new TelegramChannel();
        await channel.connect();

        await channel.send({ channel: 'telegram', content: 'text' });
        expect(mockBotInstance.api.sendMessage).not.toHaveBeenCalled();
    });

    it('should handle send failure gracefully', async () => {
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'test-token-123' } });

        const channel = new TelegramChannel();
        await channel.connect();

        mockBotInstance.api.sendMessage.mockRejectedValueOnce(new Error('API error'));
        await channel.send({ channel: 'telegram', content: 'text', userId: '123' });

        expect(logger.error).toHaveBeenCalledWith('Telegram', expect.stringContaining('Send failed'));
    });

    it('should call bot.stop() on disconnect', async () => {
        currentConfig = makeConfig({ telegram: { enabled: true, token: 'test-token-123' } });

        const channel = new TelegramChannel();
        await channel.connect();
        await channel.disconnect();

        expect(mockBotInstance.stop).toHaveBeenCalled();
        expect(channel.getStatus().connected).toBe(false);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Slack — Message handler, user info resolution
// ══════════════════════════════════════════════════════════════════════════

describe('SlackChannel — extended', () => {
    let SlackChannel: any;
    let mockApp: any;
    let messageCallback: Function | null;

    beforeEach(async () => {
        vi.clearAllMocks();
        messageCallback = null;
        mockApp = {
            message: vi.fn((cb: Function) => { messageCallback = cb; }),
            start: vi.fn().mockResolvedValue(undefined),
            client: {
                chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
                users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Display' }, real_name: 'Real Name', name: 'slackuser' } }) },
            },
        };

        vi.doMock('@slack/bolt', () => ({
            App: vi.fn(() => mockApp),
        }));

        const mod = await import('../src/channels/slack.js');
        SlackChannel = mod.SlackChannel;
    });

    afterEach(() => {
        vi.doUnmock('@slack/bolt');
    });

    it('should emit message with resolved display_name from Slack user info', async () => {
        currentConfig = makeConfig({ slack: { enabled: true, token: 'xoxb-test', apiKey: 'xapp-test' } });

        const channel = new SlackChannel();
        await channel.connect();

        expect(channel.getStatus().connected).toBe(true);
        expect(messageCallback).not.toBeNull();

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        await messageCallback!({
            message: { ts: '1700000000.000100', user: 'U12345', text: 'Hello from Slack', channel: 'C12345' },
        });

        expect(messages.length).toBe(1);
        expect(messages[0].channel).toBe('slack');
        expect(messages[0].userId).toBe('U12345');
        expect(messages[0].userName).toBe('Display');
        expect(messages[0].content).toBe('Hello from Slack');
        expect(messages[0].groupId).toBe('C12345');
    });

    it('should skip messages with subtype', async () => {
        currentConfig = makeConfig({ slack: { enabled: true, token: 'xoxb-test', apiKey: 'xapp-test' } });

        const channel = new SlackChannel();
        await channel.connect();

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        await messageCallback!({
            message: { ts: '1700000000.000200', user: 'U12345', text: 'edit', channel: 'C12345', subtype: 'message_changed' },
        });

        expect(messages.length).toBe(0);
    });

    it('should handle empty text field', async () => {
        currentConfig = makeConfig({ slack: { enabled: true, token: 'xoxb-test', apiKey: 'xapp-test' } });

        const channel = new SlackChannel();
        await channel.connect();

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        await messageCallback!({
            message: { ts: '1700000000.000300', user: 'U12345', channel: 'C12345' },
        });

        expect(messages.length).toBe(1);
        expect(messages[0].content).toBe('');
    });

    it('should fall back gracefully when users.info fails', async () => {
        mockApp.client.users.info.mockRejectedValueOnce(new Error('user not found'));
        currentConfig = makeConfig({ slack: { enabled: true, token: 'xoxb-test', apiKey: 'xapp-test' } });

        const channel = new SlackChannel();
        await channel.connect();

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        await messageCallback!({
            message: { ts: '1700000000.000400', user: 'U99999', text: 'test', channel: 'C12345' },
        });

        expect(messages.length).toBe(1);
        expect(messages[0].userName).toBeUndefined(); // Fallback to undefined
    });

    it('should disconnect properly and clear state', async () => {
        currentConfig = makeConfig({ slack: { enabled: true, token: 'xoxb-test', apiKey: 'xapp-test' } });

        const channel = new SlackChannel();
        await channel.connect();
        expect(channel.getStatus().connected).toBe(true);

        await channel.disconnect();
        expect(channel.getStatus().connected).toBe(false);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Discord — Message handler, send via DM and channel
// ══════════════════════════════════════════════════════════════════════════

describe('DiscordChannel — extended', () => {
    let DiscordChannel: any;
    let mockClient: any;
    let eventHandlers: Map<string, Function>;

    beforeEach(async () => {
        vi.clearAllMocks();
        eventHandlers = new Map();
        mockClient = {
            on: vi.fn((event: string, handler: Function) => {
                eventHandlers.set(event, handler);
            }),
            login: vi.fn().mockResolvedValue('token'),
            destroy: vi.fn(),
            user: { tag: 'TITAN#0001' },
            users: {
                fetch: vi.fn().mockResolvedValue({
                    createDM: vi.fn().mockResolvedValue({
                        send: vi.fn().mockResolvedValue(true),
                    }),
                }),
            },
            channels: {
                fetch: vi.fn().mockResolvedValue({
                    isTextBased: () => true,
                    send: vi.fn().mockResolvedValue(true),
                }),
            },
        };

        vi.doMock('discord.js', () => ({
            Client: vi.fn(() => mockClient),
            GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 },
            Events: { MessageCreate: 'messageCreate', ClientReady: 'ready' },
        }));

        const mod = await import('../src/channels/discord.js');
        DiscordChannel = mod.DiscordChannel;
    });

    afterEach(() => {
        vi.doUnmock('discord.js');
    });

    it('should emit message event when Discord message is received', async () => {
        currentConfig = makeConfig({ discord: { enabled: true, token: 'discord-token-test' } });

        const channel = new DiscordChannel();
        await channel.connect();

        // Simulate ClientReady to set connected = true
        const readyHandler = eventHandlers.get('ready');
        if (readyHandler) readyHandler();

        expect(channel.getStatus().connected).toBe(true);

        // Simulate incoming message
        const messageHandler = eventHandlers.get('messageCreate');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        messageHandler!({
            id: 'msg-001',
            author: { id: 'user-001', username: 'TestUser', bot: false },
            content: 'Hello Discord',
            guild: { id: 'guild-001' },
            createdAt: new Date('2026-01-01'),
        });

        expect(messages.length).toBe(1);
        expect(messages[0].channel).toBe('discord');
        expect(messages[0].userId).toBe('user-001');
        expect(messages[0].userName).toBe('TestUser');
        expect(messages[0].groupId).toBe('guild-001');
    });

    it('should ignore bot messages', async () => {
        currentConfig = makeConfig({ discord: { enabled: true, token: 'discord-token-test' } });

        const channel = new DiscordChannel();
        await channel.connect();

        const messageHandler = eventHandlers.get('messageCreate');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        messageHandler!({
            id: 'msg-bot',
            author: { id: 'bot-001', username: 'SomeBot', bot: true },
            content: 'Bot message',
            guild: null,
            createdAt: new Date(),
        });

        expect(messages.length).toBe(0);
    });

    it('should ignore messages with no author', async () => {
        currentConfig = makeConfig({ discord: { enabled: true, token: 'discord-token-test' } });

        const channel = new DiscordChannel();
        await channel.connect();

        const messageHandler = eventHandlers.get('messageCreate');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        messageHandler!({
            id: 'msg-noauthor',
            author: null,
            content: 'No author',
            guild: null,
            createdAt: new Date(),
        });

        expect(messages.length).toBe(0);
    });

    it('should send DM when userId is provided', async () => {
        currentConfig = makeConfig({ discord: { enabled: true, token: 'discord-token-test' } });

        const channel = new DiscordChannel();
        await channel.connect();
        const readyHandler = eventHandlers.get('ready');
        if (readyHandler) readyHandler();

        await channel.send({ channel: 'discord', content: 'DM reply', userId: 'user-001' });

        expect(mockClient.users.fetch).toHaveBeenCalledWith('user-001');
    });

    it('should send to channel when groupId is provided', async () => {
        currentConfig = makeConfig({ discord: { enabled: true, token: 'discord-token-test' } });

        const channel = new DiscordChannel();
        await channel.connect();
        const readyHandler = eventHandlers.get('ready');
        if (readyHandler) readyHandler();

        await channel.send({ channel: 'discord', content: 'Channel reply', groupId: 'channel-001' });

        expect(mockClient.channels.fetch).toHaveBeenCalledWith('channel-001');
    });

    it('should handle send error gracefully', async () => {
        currentConfig = makeConfig({ discord: { enabled: true, token: 'discord-token-test' } });

        const channel = new DiscordChannel();
        await channel.connect();
        const readyHandler = eventHandlers.get('ready');
        if (readyHandler) readyHandler();

        mockClient.users.fetch.mockRejectedValueOnce(new Error('User not found'));
        await channel.send({ channel: 'discord', content: 'fail', userId: 'unknown' });

        expect(logger.error).toHaveBeenCalledWith('Discord', expect.stringContaining('Send failed'));
    });

    it('should call client.destroy() on disconnect', async () => {
        currentConfig = makeConfig({ discord: { enabled: true, token: 'discord-token-test' } });

        const channel = new DiscordChannel();
        await channel.connect();
        await channel.disconnect();

        expect(mockClient.destroy).toHaveBeenCalled();
        expect(channel.getStatus().connected).toBe(false);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Signal — Polling and send
// ══════════════════════════════════════════════════════════════════════════

describe('SignalChannel — extended', () => {
    let SignalChannel: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockFetch.mockReset();
        process.env.SIGNAL_API_URL = 'http://localhost:8080';
        process.env.SIGNAL_NUMBER = '+15551234567';

        const mod = await import('../src/channels/signal.js');
        SignalChannel = mod.SignalChannel;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.SIGNAL_API_URL;
        delete process.env.SIGNAL_NUMBER;
    });

    it('should start polling after successful connect and emit messages', async () => {
        currentConfig = makeConfig({ signal: { enabled: true } });

        // Mock the /v1/about connectivity check
        mockFetch.mockResolvedValueOnce({ ok: true });

        const channel = new SignalChannel();
        await channel.connect();

        expect(channel.getStatus().connected).toBe(true);

        // Now simulate a poll response
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ([
                {
                    envelope: {
                        source: '+15559999999',
                        dataMessage: {
                            body: 'Hello from Signal',
                            timestamp: 1700000000000,
                        },
                    },
                },
            ]),
        });

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        // Advance timer to trigger polling
        await vi.advanceTimersByTimeAsync(2100);

        expect(messages.length).toBe(1);
        expect(messages[0].content).toBe('Hello from Signal');
        expect(messages[0].userId).toBe('+15559999999');
        expect(messages[0].channel).toBe('signal');

        await channel.disconnect();
    });

    it('should skip messages without dataMessage body', async () => {
        currentConfig = makeConfig({ signal: { enabled: true } });
        mockFetch.mockResolvedValueOnce({ ok: true });

        const channel = new SignalChannel();
        await channel.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ([
                { envelope: { source: '+15559999999', typingMessage: {} } },
                { envelope: { source: '+15559999999', dataMessage: {} } },
            ]),
        });

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));
        await vi.advanceTimersByTimeAsync(2100);

        expect(messages.length).toBe(0);

        await channel.disconnect();
    });

    it('should handle 404 (no messages) during polling gracefully', async () => {
        currentConfig = makeConfig({ signal: { enabled: true } });
        mockFetch.mockResolvedValueOnce({ ok: true });

        const channel = new SignalChannel();
        await channel.connect();

        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

        await vi.advanceTimersByTimeAsync(2100);

        // Should not have thrown or logged error for 404
        expect(channel.getStatus().connected).toBe(true);

        await channel.disconnect();
    });

    it('should handle send with successful API response', async () => {
        currentConfig = makeConfig({ signal: { enabled: true } });
        mockFetch.mockResolvedValueOnce({ ok: true });

        const channel = new SignalChannel();
        await channel.connect();

        mockFetch.mockResolvedValueOnce({ ok: true });

        await channel.send({ channel: 'signal', content: 'Reply', userId: '+15559999999' });

        // The send call should be the second fetch call
        const sendCall = mockFetch.mock.calls[1];
        expect(sendCall[0]).toContain('/v2/send');
        const body = JSON.parse(sendCall[1].body);
        expect(body.message).toBe('Reply');
        expect(body.recipients).toEqual(['+15559999999']);

        await channel.disconnect();
    });

    it('should handle send API error response', async () => {
        currentConfig = makeConfig({ signal: { enabled: true } });
        mockFetch.mockResolvedValueOnce({ ok: true });

        const channel = new SignalChannel();
        await channel.connect();

        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Server Error' });

        await channel.send({ channel: 'signal', content: 'Fail', userId: '+15559999999' });

        expect(logger.error).toHaveBeenCalledWith('Signal', expect.stringContaining('Send failed'));

        await channel.disconnect();
    });
});

// ══════════════════════════════════════════════════════════════════════════
// MSTeams — Webhook send with Adaptive Card
// ══════════════════════════════════════════════════════════════════════════

describe('MSTeamsChannel — extended', () => {
    let MSTeamsChannel: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockFetch.mockReset();

        const mod = await import('../src/channels/msteams.js');
        MSTeamsChannel = mod.MSTeamsChannel;
    });

    it('should connect with webhook URL from env var', async () => {
        process.env.MSTEAMS_WEBHOOK_URL = 'https://outlook.webhook.office.com/test';
        currentConfig = makeConfig({ msteams: { enabled: true } });

        const channel = new MSTeamsChannel();
        await channel.connect();

        expect(channel.getStatus().connected).toBe(true);

        delete process.env.MSTEAMS_WEBHOOK_URL;
        await channel.disconnect();
    });

    it('should send Adaptive Card payload to webhook', async () => {
        currentConfig = makeConfig({ msteams: { enabled: true, token: 'https://outlook.webhook.office.com/test123' } });

        const channel = new MSTeamsChannel();
        await channel.connect();

        mockFetch.mockResolvedValueOnce({ ok: true });
        await channel.send({ channel: 'msteams', content: 'Hello Teams!' });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe('https://outlook.webhook.office.com/test123');
        const body = JSON.parse(opts.body);
        expect(body['@type']).toBe('MessageCard');
        expect(body.sections[0].text).toBe('Hello Teams!');
        expect(body.sections[0].activityTitle).toBe('TITAN Agent');

        await channel.disconnect();
    });

    it('should handle webhook error response during send', async () => {
        currentConfig = makeConfig({ msteams: { enabled: true, token: 'https://outlook.webhook.office.com/test' } });

        const channel = new MSTeamsChannel();
        await channel.connect();

        mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });
        await channel.send({ channel: 'msteams', content: 'Fail' });

        expect(logger.error).toHaveBeenCalledWith('MS Teams', expect.stringContaining('Send failed'));

        await channel.disconnect();
    });

    it('should reset webhookUrl on disconnect', async () => {
        currentConfig = makeConfig({ msteams: { enabled: true, token: 'https://outlook.webhook.office.com/test' } });

        const channel = new MSTeamsChannel();
        await channel.connect();
        expect(channel.getStatus().connected).toBe(true);

        await channel.disconnect();
        expect(channel.getStatus().connected).toBe(false);
    });

    it('getStatus should include error when not connected', () => {
        const channel = new MSTeamsChannel();
        const status = channel.getStatus();
        expect(status.connected).toBe(false);
        expect(status.error).toBe('Webhook URL not configured');
    });

    it('getStatus should not include error when connected', async () => {
        currentConfig = makeConfig({ msteams: { enabled: true, token: 'https://outlook.webhook.office.com/x' } });
        const channel = new MSTeamsChannel();
        await channel.connect();
        const status = channel.getStatus();
        expect(status.connected).toBe(true);
        expect(status.error).toBeUndefined();
        await channel.disconnect();
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Matrix — Timeline handler, send, disconnect error
// ══════════════════════════════════════════════════════════════════════════

describe('MatrixChannel — extended', () => {
    let MatrixChannel: any;
    let mockMatrixClient: any;
    let timelineHandlers: Map<string, Function>;

    beforeEach(async () => {
        vi.clearAllMocks();
        timelineHandlers = new Map();
        mockMatrixClient = {
            on: vi.fn((event: string, handler: Function) => {
                timelineHandlers.set(event, handler);
            }),
            startClient: vi.fn().mockResolvedValue(undefined),
            stopClient: vi.fn(),
            getUserId: vi.fn(() => '@titan:matrix.org'),
            sendTextMessage: vi.fn().mockResolvedValue(true),
        };

        vi.doMock('matrix-js-sdk', () => ({
            createClient: vi.fn(() => mockMatrixClient),
        }));

        const mod = await import('../src/channels/matrix.js');
        MatrixChannel = mod.MatrixChannel;
    });

    afterEach(() => {
        vi.doUnmock('matrix-js-sdk');
    });

    it('should emit inbound message from Matrix room timeline', async () => {
        currentConfig = makeConfig({ matrix: { enabled: true, token: 'matrix-token-test' } });

        const channel = new MatrixChannel();
        await channel.connect();

        expect(channel.getStatus().connected).toBe(true);

        const handler = timelineHandlers.get('Room.timeline');
        expect(handler).toBeDefined();

        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        const mockEvent = {
            getType: () => 'm.room.message',
            getSender: () => '@user:matrix.org',
            getContent: () => ({ body: 'Hello Matrix' }),
            getId: () => 'evt-001',
            getTs: () => 1700000000000,
        };
        const mockRoom = { roomId: '!room:matrix.org' };

        handler!(mockEvent, mockRoom);

        expect(messages.length).toBe(1);
        expect(messages[0].channel).toBe('matrix');
        expect(messages[0].userId).toBe('@user:matrix.org');
        expect(messages[0].content).toBe('Hello Matrix');
        expect(messages[0].groupId).toBe('!room:matrix.org');
    });

    it('should ignore non-message events', async () => {
        currentConfig = makeConfig({ matrix: { enabled: true, token: 'matrix-token-test' } });

        const channel = new MatrixChannel();
        await channel.connect();

        const handler = timelineHandlers.get('Room.timeline');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        handler!(
            { getType: () => 'm.room.member', getSender: () => '@user:matrix.org', getContent: () => ({}) },
            { roomId: '!room:matrix.org' }
        );

        expect(messages.length).toBe(0);
    });

    it('should ignore own messages', async () => {
        currentConfig = makeConfig({ matrix: { enabled: true, token: 'matrix-token-test' } });

        const channel = new MatrixChannel();
        await channel.connect();

        const handler = timelineHandlers.get('Room.timeline');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        handler!(
            {
                getType: () => 'm.room.message',
                getSender: () => '@titan:matrix.org',
                getContent: () => ({ body: 'My own msg' }),
            },
            { roomId: '!room:matrix.org' }
        );

        expect(messages.length).toBe(0);
    });

    it('should ignore messages with empty body', async () => {
        currentConfig = makeConfig({ matrix: { enabled: true, token: 'matrix-token-test' } });

        const channel = new MatrixChannel();
        await channel.connect();

        const handler = timelineHandlers.get('Room.timeline');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        handler!(
            {
                getType: () => 'm.room.message',
                getSender: () => '@user:matrix.org',
                getContent: () => ({}),
            },
            { roomId: '!room:matrix.org' }
        );

        expect(messages.length).toBe(0);
    });

    it('should send text message to room', async () => {
        currentConfig = makeConfig({ matrix: { enabled: true, token: 'matrix-token-test' } });

        const channel = new MatrixChannel();
        await channel.connect();

        await channel.send({ channel: 'matrix', content: 'Reply', groupId: '!room:matrix.org' });

        expect(mockMatrixClient.sendTextMessage).toHaveBeenCalledWith('!room:matrix.org', 'Reply');
    });

    it('should handle disconnect error gracefully', async () => {
        currentConfig = makeConfig({ matrix: { enabled: true, token: 'matrix-token-test' } });

        const channel = new MatrixChannel();
        await channel.connect();

        mockMatrixClient.stopClient.mockImplementation(() => { throw new Error('stop failed'); });
        await channel.disconnect();

        expect(logger.error).toHaveBeenCalledWith('Matrix', expect.stringContaining('Disconnect failed'));
    });
});

// ══════════════════════════════════════════════════════════════════════════
// WhatsApp — Message handler with various message types
// ══════════════════════════════════════════════════════════════════════════

describe('WhatsAppChannel — extended', () => {
    let WhatsAppChannel: any;
    let mockSocket: any;
    let evHandlers: Map<string, Function>;

    beforeEach(async () => {
        vi.clearAllMocks();
        evHandlers = new Map();
        const mockEv = {
            on: vi.fn((event: string, handler: Function) => {
                evHandlers.set(event, handler);
            }),
        };
        mockSocket = {
            ev: mockEv,
            end: vi.fn(),
            sendMessage: vi.fn().mockResolvedValue(true),
        };

        vi.doMock('@whiskeysockets/baileys', () => ({
            default: vi.fn(() => mockSocket),
            useMultiFileAuthState: vi.fn().mockResolvedValue({
                state: {},
                saveCreds: vi.fn(),
            }),
            DisconnectReason: { loggedOut: 401 },
        }));

        const mod = await import('../src/channels/whatsapp.js');
        WhatsAppChannel = mod.WhatsAppChannel;
    });

    afterEach(() => {
        vi.doUnmock('@whiskeysockets/baileys');
    });

    it('should emit messages from messages.upsert event', async () => {
        currentConfig = makeConfig({ whatsapp: { enabled: true } });

        const channel = new WhatsAppChannel();
        await channel.connect();

        // Simulate connection.update -> open
        const connHandler = evHandlers.get('connection.update');
        if (connHandler) connHandler({ connection: 'open' });

        expect(channel.getStatus().connected).toBe(true);

        // Simulate messages.upsert
        const msgHandler = evHandlers.get('messages.upsert');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        msgHandler!({
            messages: [
                {
                    message: { conversation: 'Hello WhatsApp' },
                    key: { id: 'msg-001', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
                    pushName: 'Test User',
                    messageTimestamp: 1700000000,
                },
            ],
        });

        expect(messages.length).toBe(1);
        expect(messages[0].content).toBe('Hello WhatsApp');
        expect(messages[0].userId).toBe('15551234567@s.whatsapp.net');
        expect(messages[0].userName).toBe('Test User');
    });

    it('should handle extended text messages', async () => {
        currentConfig = makeConfig({ whatsapp: { enabled: true } });

        const channel = new WhatsAppChannel();
        await channel.connect();

        const msgHandler = evHandlers.get('messages.upsert');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        msgHandler!({
            messages: [
                {
                    message: { extendedTextMessage: { text: 'Extended text' } },
                    key: { id: 'msg-002', remoteJid: '15559876543@s.whatsapp.net', fromMe: false },
                    messageTimestamp: 1700000001,
                },
            ],
        });

        expect(messages.length).toBe(1);
        expect(messages[0].content).toBe('Extended text');
    });

    it('should skip own messages (fromMe = true)', async () => {
        currentConfig = makeConfig({ whatsapp: { enabled: true } });

        const channel = new WhatsAppChannel();
        await channel.connect();

        const msgHandler = evHandlers.get('messages.upsert');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        msgHandler!({
            messages: [
                {
                    message: { conversation: 'My message' },
                    key: { id: 'msg-003', remoteJid: '15551234567@s.whatsapp.net', fromMe: true },
                    messageTimestamp: 1700000002,
                },
            ],
        });

        expect(messages.length).toBe(0);
    });

    it('should skip messages without text content', async () => {
        currentConfig = makeConfig({ whatsapp: { enabled: true } });

        const channel = new WhatsAppChannel();
        await channel.connect();

        const msgHandler = evHandlers.get('messages.upsert');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        msgHandler!({
            messages: [
                {
                    message: { imageMessage: { url: 'http://img' } },
                    key: { id: 'msg-004', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
                    messageTimestamp: 1700000003,
                },
            ],
        });

        expect(messages.length).toBe(0);
    });

    it('should set groupId for group messages (@g.us)', async () => {
        currentConfig = makeConfig({ whatsapp: { enabled: true } });

        const channel = new WhatsAppChannel();
        await channel.connect();

        const msgHandler = evHandlers.get('messages.upsert');
        const messages: any[] = [];
        channel.on('message', (msg: any) => messages.push(msg));

        msgHandler!({
            messages: [
                {
                    message: { conversation: 'Group msg' },
                    key: { id: 'msg-005', remoteJid: '120363000000@g.us', fromMe: false },
                    messageTimestamp: 1700000004,
                },
            ],
        });

        expect(messages.length).toBe(1);
        expect(messages[0].groupId).toBe('120363000000@g.us');
    });

    it('should send message via socket', async () => {
        currentConfig = makeConfig({ whatsapp: { enabled: true } });

        const channel = new WhatsAppChannel();
        await channel.connect();

        const connHandler = evHandlers.get('connection.update');
        if (connHandler) connHandler({ connection: 'open' });

        await channel.send({ channel: 'whatsapp', content: 'Reply', userId: '15551234567@s.whatsapp.net' });

        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
            '15551234567@s.whatsapp.net',
            { text: 'Reply' }
        );
    });

    it('should call socket.end() on disconnect', async () => {
        currentConfig = makeConfig({ whatsapp: { enabled: true } });

        const channel = new WhatsAppChannel();
        await channel.connect();

        await channel.disconnect();
        expect(mockSocket.end).toHaveBeenCalled();
    });
});
