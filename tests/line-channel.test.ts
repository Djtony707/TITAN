/**
 * TITAN — LINE Channel Adapter Tests
 * Exercises the real connect()/send()/disconnect()/handleWebhookEvent() paths
 * of src/channels/line.ts against the LINE Messaging API REST surface (mocked fetch).
 *
 * Self-contained harness — mirrors tests/channels.test.ts:
 *   - module-level `currentConfig` + `makeConfig` helper
 *   - vi.mock of '../src/config/config.js' returning currentConfig
 *   - vi.mock of '../src/utils/logger.js'
 *   - fresh re-import per describe via vi.resetModules() + dynamic import
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Common mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-line-channel',
    TITAN_VERSION: '2026.5.0',
}));

/** Default config factory — line channel disabled by default */
function makeConfig(overrides: Record<string, unknown> = {}) {
    const base = {
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        channels: {
            line: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
        },
        gateway: { port: 48420, enabled: true },
        providers: {},
    };
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
// LINE Channel
// ══════════════════════════════════════════════════════════════════════════

describe('LineChannel', () => {
    let LineChannelClass: typeof import('../src/channels/line.js')['LineChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/line.js');
        LineChannelClass = mod.LineChannel;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── identity ───────────────────────────────────────────────────────────

    it('should have correct name and displayName', () => {
        const ch = new LineChannelClass();
        expect(ch.name).toBe('line');
        expect(ch.displayName).toBe('LINE');
    });

    it('getStatus should return correct shape', () => {
        const ch = new LineChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'LINE', connected: false });
    });

    // ── connect() ────────────────────────────────────────────────────────────

    it('connect when disabled should return without connecting (no fetch)', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LineChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        // Disabled short-circuits before any network call
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('connect with missing Channel Access Token should warn and stay disconnected', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({ line: { enabled: true, token: '' } });
        const ch = new LineChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith('LINE', 'LINE Channel Access Token not configured');
        // No network call when token is missing
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('connect with token should verify against /v2/bot/info using a Bearer auth header', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ displayName: 'TITAN Bot', userId: 'Uabc123' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({ line: { enabled: true, token: 'CHANNEL_ACCESS_TOKEN_123' } });
        const ch = new LineChannelClass();
        await ch.connect();

        // Hit the real LINE bot-info endpoint with the right Authorization header
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.line.me/v2/bot/info');
        expect(init.headers.Authorization).toBe('Bearer CHANNEL_ACCESS_TOKEN_123');

        // Successful verification flips connected = true
        expect(ch.getStatus().connected).toBe(true);
    });

    it('connect should stay disconnected and log error when bot-info auth fails', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: () => Promise.resolve({}),
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({ line: { enabled: true, token: 'BAD_TOKEN' } });
        const ch = new LineChannelClass();
        await ch.connect();

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.line.me/v2/bot/info',
            expect.objectContaining({ headers: { Authorization: 'Bearer BAD_TOKEN' } }),
        );
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();
    });

    // ── disconnect() ─────────────────────────────────────────────────────────

    it('disconnect should reset connected state and clear the access token', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ displayName: 'TITAN Bot' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({ line: { enabled: true, token: 'TOK' } });
        const ch = new LineChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(true);

        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
        // token cleared internally
        expect((ch as any).channelAccessToken).toBe('');
    });

    // ── handleWebhookEvent() ───────────────────────────────────────────────────

    it('handleWebhookEvent should parse a LINE text message event and emit a normalized inbound message', () => {
        const ch = new LineChannelClass();
        const received: any[] = [];
        ch.on('message', (msg) => received.push(msg));

        ch.handleWebhookEvent({
            events: [
                {
                    type: 'message',
                    message: { id: 'msg-100', type: 'text', text: 'Hello TITAN' },
                    source: { type: 'user', userId: 'Uuser1' },
                    replyToken: 'reply-tok-xyz',
                    timestamp: 1700000000000,
                },
            ],
        });

        expect(received).toHaveLength(1);
        const inbound = received[0];
        expect(inbound.id).toBe('msg-100');
        expect(inbound.channel).toBe('line');
        expect(inbound.userId).toBe('Uuser1');
        expect(inbound.content).toBe('Hello TITAN');
        expect(inbound.replyTo).toBe('reply-tok-xyz');
        expect(inbound.timestamp).toBeInstanceOf(Date);
        expect(inbound.timestamp.getTime()).toBe(1700000000000);
        expect(inbound.raw).toBeDefined();
    });

    it('handleWebhookEvent should map group/room source onto groupId', () => {
        const ch = new LineChannelClass();
        const received: any[] = [];
        ch.on('message', (msg) => received.push(msg));

        // group source
        ch.handleWebhookEvent({
            events: [
                {
                    type: 'message',
                    message: { id: 'm1', type: 'text', text: 'in group' },
                    source: { type: 'group', userId: 'Uu', groupId: 'Cgroup1' },
                },
            ],
        });
        // room source (falls back to roomId when no groupId)
        ch.handleWebhookEvent({
            events: [
                {
                    type: 'message',
                    message: { id: 'm2', type: 'text', text: 'in room' },
                    source: { type: 'room', userId: 'Uu', roomId: 'Rroom1' },
                },
            ],
        });

        expect(received).toHaveLength(2);
        expect(received[0].groupId).toBe('Cgroup1');
        expect(received[1].groupId).toBe('Rroom1');
    });

    it('handleWebhookEvent should ignore non-text / non-message events', () => {
        const ch = new LineChannelClass();
        const received: any[] = [];
        ch.on('message', (msg) => received.push(msg));

        ch.handleWebhookEvent({
            events: [
                { type: 'follow', source: { type: 'user', userId: 'U1' } },
                { type: 'message', message: { id: 'i1', type: 'image' }, source: { type: 'user', userId: 'U1' } },
                { type: 'message', message: { id: 't1', type: 'text', text: '' }, source: { type: 'user', userId: 'U1' } },
            ],
        });

        // follow -> ignored, image -> ignored, empty text -> ignored (falsy text)
        expect(received).toHaveLength(0);
    });

    it('handleWebhookEvent should no-op when body has no events', () => {
        const ch = new LineChannelClass();
        const received: any[] = [];
        ch.on('message', (msg) => received.push(msg));

        expect(() => ch.handleWebhookEvent({})).not.toThrow();
        expect(received).toHaveLength(0);
    });

    // ── send() ─────────────────────────────────────────────────────────────────

    it('send when not connected should return early (no fetch)', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LineChannelClass();
        await ch.send({ channel: 'line', content: 'hi', userId: 'Uuser' });

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('send without a userId should warn and not call the API', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LineChannelClass();
        (ch as any).connected = true;
        (ch as any).channelAccessToken = 'TOK';

        await ch.send({ channel: 'line', content: 'hi' });

        expect(logger.warn).toHaveBeenCalledWith('LINE', 'No userId provided for LINE push message');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('send with a replyTo should POST the reply API with replyToken + text message', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LineChannelClass();
        (ch as any).connected = true;
        (ch as any).channelAccessToken = 'REPLY_TOKEN_AUTH';

        await ch.send({
            channel: 'line',
            content: 'reply body',
            userId: 'Uuser',
            replyTo: 'reply-token-abc',
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.line.me/v2/bot/message/reply');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer REPLY_TOKEN_AUTH');
        expect(init.headers['Content-Type']).toBe('application/json');

        const body = JSON.parse(init.body);
        expect(body.replyToken).toBe('reply-token-abc');
        expect(body.messages).toEqual([{ type: 'text', text: 'reply body' }]);
        // reply API does NOT carry a `to` field
        expect(body.to).toBeUndefined();
    });

    it('send without a replyTo should POST the push API targeting the userId', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LineChannelClass();
        (ch as any).connected = true;
        (ch as any).channelAccessToken = 'PUSH_TOKEN_AUTH';

        await ch.send({ channel: 'line', content: 'push body', userId: 'Utarget99' });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.line.me/v2/bot/message/push');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer PUSH_TOKEN_AUTH');

        const body = JSON.parse(init.body);
        expect(body.to).toBe('Utarget99');
        expect(body.messages).toEqual([{ type: 'text', text: 'push body' }]);
        // push API does NOT carry a replyToken
        expect(body.replyToken).toBeUndefined();
    });

    it('send should log an error when the LINE API rejects the push', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LineChannelClass();
        (ch as any).connected = true;
        (ch as any).channelAccessToken = 'TOK';

        await ch.send({ channel: 'line', content: 'boom', userId: 'Uuser' });

        expect(mockFetch).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
    });

    it('send should swallow fetch network errors and log them', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockRejectedValue(new Error('Network down'));
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LineChannelClass();
        (ch as any).connected = true;
        (ch as any).channelAccessToken = 'TOK';

        await expect(
            ch.send({ channel: 'line', content: 'x', userId: 'Uuser' }),
        ).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalled();
    });
});
