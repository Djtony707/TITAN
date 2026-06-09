/**
 * TITAN — Lark/Feishu Channel Adapter Tests
 *
 * Exercises the REAL code paths of src/channels/lark.ts:
 *   - name / displayName
 *   - connect() when disabled  → returns, stays disconnected
 *   - connect() missing creds   → warns, stays disconnected
 *   - connect() with creds      → POSTs to the tenant_access_token endpoint,
 *                                 stores the access token, sets connected=true
 *   - connect() token failure   → logs error, stays disconnected
 *   - send() not connected      → no-op (no fetch)
 *   - send() no chatId          → warns
 *   - send() connected          → POSTs to im/v1/messages with Bearer auth +
 *                                 correct receive_id / msg_type / content shape
 *   - send() refreshes an expired token before posting
 *   - handleWebhookEvent() url_verification → echoes challenge
 *   - handleWebhookEvent() im.message.receive_v1 → parses inbound, emits 'message'
 *   - disconnect() resets connected + access token
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Harness (copied from tests/channels.test.ts) ────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-lark',
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
            lark: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
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

// ── Tests ───────────────────────────────────────────────────────────────────

type LarkChannel = import('../src/channels/lark.js')['LarkChannel'];

describe('LarkChannel', () => {
    let LarkChannelClass: typeof import('../src/channels/lark.js')['LarkChannel'];

    beforeEach(async () => {
        vi.resetModules();
        // The logger mock is module-level and shared across tests; clear its
        // call history so per-test assertions on logger.warn/error/info don't
        // see calls leaked from earlier tests.
        vi.clearAllMocks();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/lark.js');
        LarkChannelClass = mod.LarkChannel;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── identity ────────────────────────────────────────────────────────────

    it('should have correct name and displayName', () => {
        const ch = new LarkChannelClass();
        expect(ch.name).toBe('lark');
        expect(ch.displayName).toBe('Lark/Feishu');
    });

    it('getStatus should report displayName and connected=false initially', () => {
        const ch = new LarkChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'Lark/Feishu', connected: false });
    });

    // ── connect() guards ──────────────────────────────────────────────────────

    it('connect when disabled should return immediately without connecting', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LarkChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        // Disabled path never hits the network
        expect(mockFetch).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith('Lark', 'Lark channel is disabled');
    });

    it('connect with missing credentials should warn and stay disconnected', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        // enabled but token (App ID) + apiKey (App Secret) empty
        currentConfig = makeConfig({ lark: { enabled: true, token: '', apiKey: '' } });
        const ch = new LarkChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Lark',
            'Lark App ID or App Secret not configured (token + apiKey)',
        );
    });

    it('connect with App ID but missing App Secret should warn and stay disconnected', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({ lark: { enabled: true, token: 'cli_app123', apiKey: '' } });
        const ch = new LarkChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });

    // ── connect() transport (tenant_access_token) ─────────────────────────────

    it('connect with valid creds should POST to the tenant_access_token endpoint and connect', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ tenant_access_token: 'tat-xyz', expire: 7200 }),
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({ lark: { enabled: true, token: 'cli_app123', apiKey: 'secret456' } });
        const ch = new LarkChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe(
            'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        );
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

        // Body carries the App ID + App Secret from config (token + apiKey)
        const body = JSON.parse(init.body);
        expect(body).toEqual({ app_id: 'cli_app123', app_secret: 'secret456' });
    });

    it('connect should stay disconnected and log error when token refresh fails', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: () => Promise.resolve({}),
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = makeConfig({ lark: { enabled: true, token: 'cli_app123', apiKey: 'secret456' } });
        const ch = new LarkChannelClass();
        await ch.connect();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(ch.getStatus().connected).toBe(false);
        // The Error('Token refresh failed: 401') is caught and logged.
        // The logger mock is module-level and accumulates across tests, so
        // assert against the most recent error call, not index 0.
        expect(logger.error).toHaveBeenCalled();
        const errArgs = (logger.error as ReturnType<typeof vi.fn>).mock.lastCall!;
        expect(errArgs[0]).toBe('Lark');
        expect(String(errArgs[1])).toContain('401');
    });

    // ── send() ────────────────────────────────────────────────────────────────

    it('send when not connected should be a no-op (no fetch)', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LarkChannelClass();
        // not connected
        await expect(
            ch.send({ channel: 'lark', content: 'hi', groupId: 'oc_chat1' }),
        ).resolves.toBeUndefined();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('send connected without chatId should warn and not POST', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LarkChannelClass();
        // Force connected state with a live token so ensureToken() doesn't refetch
        (ch as any).connected = true;
        (ch as any).accessToken = 'tat-live';
        (ch as any).tokenExpiry = Date.now() + 3_600_000;

        await ch.send({ channel: 'lark', content: 'hi' }); // no groupId, no userId

        expect(mockFetch).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith('Lark', 'No chat ID provided for Lark message');
    });

    it('send connected should POST to im/v1/messages with Bearer auth and correct shape', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LarkChannelClass();
        (ch as any).connected = true;
        (ch as any).accessToken = 'tat-live';
        (ch as any).tokenExpiry = Date.now() + 3_600_000; // token still valid → no refresh

        await ch.send({ channel: 'lark', content: 'Hello Feishu', groupId: 'oc_chat1' });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];

        expect(url).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({
            Authorization: 'Bearer tat-live',
            'Content-Type': 'application/json',
        });

        const body = JSON.parse(init.body);
        expect(body.receive_id).toBe('oc_chat1');
        expect(body.msg_type).toBe('text');
        // content is itself a JSON string: { text: "..." }
        expect(JSON.parse(body.content)).toEqual({ text: 'Hello Feishu' });
    });

    it('send should fall back to userId as the chat id when groupId is absent', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LarkChannelClass();
        (ch as any).connected = true;
        (ch as any).accessToken = 'tat-live';
        (ch as any).tokenExpiry = Date.now() + 3_600_000;

        await ch.send({ channel: 'lark', content: 'dm', userId: 'ou_user1' });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.receive_id).toBe('ou_user1');
    });

    it('send should refresh an expired token before posting the message', async () => {
        // First fetch = token refresh, second fetch = message send
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ tenant_access_token: 'tat-fresh', expire: 7200 }),
            })
            .mockResolvedValueOnce({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LarkChannelClass();
        (ch as any).connected = true;
        (ch as any).accessToken = 'tat-stale';
        (ch as any).tokenExpiry = 0; // expired → ensureToken() refreshes

        await ch.send({ channel: 'lark', content: 'after refresh', groupId: 'oc_chat1' });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        // 1st call: token endpoint
        expect(mockFetch.mock.calls[0][0]).toBe(
            'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        );
        // 2nd call: message endpoint, now using the FRESH token
        expect(mockFetch.mock.calls[1][0]).toBe(
            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        );
        expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer tat-fresh');
    });

    it('send should log an error when the message POST returns non-ok', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
        vi.stubGlobal('fetch', mockFetch);

        const ch = new LarkChannelClass();
        (ch as any).connected = true;
        (ch as any).accessToken = 'tat-live';
        (ch as any).tokenExpiry = Date.now() + 3_600_000;

        await ch.send({ channel: 'lark', content: 'boom', groupId: 'oc_chat1' });

        expect(logger.error).toHaveBeenCalled();
        const errArgs = (logger.error as ReturnType<typeof vi.fn>).mock.lastCall!;
        expect(errArgs[0]).toBe('Lark');
        expect(String(errArgs[1])).toContain('500');
    });

    // ── handleWebhookEvent() ──────────────────────────────────────────────────

    it('handleWebhookEvent should echo the challenge for url_verification', () => {
        const ch = new LarkChannelClass();
        const result = ch.handleWebhookEvent({
            type: 'url_verification',
            challenge: 'challenge-token-123',
            token: 'verif',
        });
        expect(result).toEqual({ challenge: 'challenge-token-123' });
    });

    it('handleWebhookEvent should parse an inbound text message and emit it', () => {
        const ch = new LarkChannelClass();
        const received: any[] = [];
        ch.on('message', (m) => received.push(m));

        const body = {
            header: { event_type: 'im.message.receive_v1' },
            event: {
                sender: { sender_id: { open_id: 'ou_sender42', user_id: 'u42' }, sender_type: 'user' },
                message: {
                    message_id: 'om_msg99',
                    chat_id: 'oc_chat7',
                    message_type: 'text',
                    content: JSON.stringify({ text: 'hello from lark' }),
                    create_time: '1700000000000',
                },
            },
        };

        const ret = ch.handleWebhookEvent(body as any);
        // Event callbacks return undefined (only verification returns a challenge)
        expect(ret).toBeUndefined();

        expect(received).toHaveLength(1);
        const msg = received[0];
        expect(msg.id).toBe('om_msg99');
        expect(msg.channel).toBe('lark');
        expect(msg.userId).toBe('ou_sender42');
        expect(msg.content).toBe('hello from lark');
        expect(msg.groupId).toBe('oc_chat7');
        expect(msg.timestamp).toBeInstanceOf(Date);
        expect(msg.timestamp.getTime()).toBe(1700000000000);
        expect(msg.raw).toBe(body);
    });

    it('handleWebhookEvent should render non-text messages as a type placeholder', () => {
        const ch = new LarkChannelClass();
        const received: any[] = [];
        ch.on('message', (m) => received.push(m));

        ch.handleWebhookEvent({
            header: { event_type: 'im.message.receive_v1' },
            event: {
                sender: { sender_id: { open_id: 'ou_sender42' } },
                message: {
                    message_id: 'om_img1',
                    chat_id: 'oc_chat7',
                    message_type: 'image',
                    content: '{"image_key":"img_v2_xxx"}',
                    create_time: '1700000000000',
                },
            },
        } as any);

        expect(received).toHaveLength(1);
        expect(received[0].content).toBe('[image]');
    });

    it('handleWebhookEvent should fall back to "unknown" userId when sender open_id is absent', () => {
        const ch = new LarkChannelClass();
        const received: any[] = [];
        ch.on('message', (m) => received.push(m));

        ch.handleWebhookEvent({
            header: { event_type: 'im.message.receive_v1' },
            event: {
                message: {
                    message_id: 'om_msg1',
                    chat_id: 'oc_chat7',
                    message_type: 'text',
                    content: JSON.stringify({ text: 'no sender' }),
                    create_time: '1700000000000',
                },
            },
        } as any);

        expect(received).toHaveLength(1);
        expect(received[0].userId).toBe('unknown');
    });

    it('handleWebhookEvent should not emit for unrelated event types', () => {
        const ch = new LarkChannelClass();
        const received: any[] = [];
        ch.on('message', (m) => received.push(m));

        const ret = ch.handleWebhookEvent({
            header: { event_type: 'p2p_chat_create' },
            event: { some: 'thing' },
        } as any);

        expect(ret).toBeUndefined();
        expect(received).toHaveLength(0);
    });

    it('handleWebhookEvent should log a parse error and not emit on malformed text content', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new LarkChannelClass();
        const received: any[] = [];
        ch.on('message', (m) => received.push(m));

        ch.handleWebhookEvent({
            header: { event_type: 'im.message.receive_v1' },
            event: {
                sender: { sender_id: { open_id: 'ou_sender42' } },
                message: {
                    message_id: 'om_bad',
                    chat_id: 'oc_chat7',
                    message_type: 'text',
                    content: 'not-json{', // JSON.parse throws
                    create_time: '1700000000000',
                },
            },
        } as any);

        expect(received).toHaveLength(0);
        expect(logger.error).toHaveBeenCalled();
    });

    // ── disconnect() ──────────────────────────────────────────────────────────

    it('disconnect should reset connected and clear the access token', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = new LarkChannelClass();
        (ch as any).connected = true;
        (ch as any).accessToken = 'tat-live';

        await ch.disconnect();

        expect(ch.getStatus().connected).toBe(false);
        expect((ch as any).accessToken).toBe('');
        expect(logger.info).toHaveBeenCalledWith('Lark', 'Disconnected');
    });
});
