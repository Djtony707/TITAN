/**
 * TITAN — Mattermost Channel Adapter Tests
 *
 * Mattermost is a CRITICAL/dark adapter: it speaks the Mattermost REST API
 * (Bearer-token auth) for the auth-probe + send, and opens a `ws` WebSocket
 * for real-time `posted` events. These tests exercise the REAL code paths:
 *   - name / displayName
 *   - connect() when disabled (no fetch, no ws)
 *   - connect() with missing token/serverUrl (warns, stays disconnected)
 *   - connect() happy path: GET /api/v4/users/me with Bearer auth, then opens
 *     a WebSocket to /api/v4/websocket and sends an authentication_challenge
 *     on 'open'
 *   - connect() when the auth probe fails (non-ok) -> logs error, no ws
 *   - inbound 'message' parsing from a `posted` WS event (and own-message skip)
 *   - send() endpoint (POST /api/v4/posts) + Bearer auth header + body shape
 *   - send() when not connected returns early (no fetch)
 *   - disconnect() closes the ws and flips connected=false
 *   - getStatus() shape
 *
 * Self-contained harness: its own vi.mock of config + logger, plus a vi.mock
 * of the `ws` transport so no real socket/network is opened. Fresh re-import
 * per test via vi.resetModules() + dynamic import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── logger mock ─────────────────────────────────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-mattermost',
    TITAN_VERSION: '2026.5.0',
}));

// ── ws transport mock ───────────────────────────────────────────────────────
// The adapter does `const { WebSocket: WS } = await import('ws')` then
// `new WS(wsUrl)`. We replace it with a controllable fake that records the
// URL, captures every `.on(event, cb)` handler, and exposes spies for
// send()/close(). Tests drive the lifecycle by invoking the captured handlers.
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    url: string;
    handlers: Record<string, (...args: unknown[]) => void> = {};
    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
        this.handlers[event] = cb;
    }
    // helpers for tests to fire the events the real `ws` would emit
    fire(event: string, ...args: unknown[]) {
        this.handlers[event]?.(...args);
    }
}

vi.mock('ws', () => ({
    WebSocket: FakeWebSocket,
    default: FakeWebSocket,
}));

// ── config mock (own copy of the channels.test.ts harness) ──────────────────
function makeConfig(overrides: Record<string, unknown> = {}) {
    const base = {
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        channels: {
            mattermost: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
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

// ── helpers ─────────────────────────────────────────────────────────────────
const SERVER_URL = 'https://mm.example.com';
const TOKEN = 'pat-abc123';
const BOT_USER_ID = 'bot-user-1';

/** A fetch mock whose /users/me probe succeeds, returning the bot user id. */
function makeAuthOkFetch() {
    return vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/v4/users/me')) {
            return { ok: true, status: 200, json: async () => ({ id: BOT_USER_ID }) };
        }
        // default for posts etc.
        return { ok: true, status: 200, json: async () => ({}) };
    });
}

/**
 * Connect the channel end-to-end with a stubbed fetch + ws, then drive the
 * ws 'open' handler so the adapter flips connected=true. Returns the live
 * FakeWebSocket instance so the caller can fire inbound events.
 */
async function connectAndOpen(MattermostChannelClass: any, mockFetch = makeAuthOkFetch()) {
    vi.stubGlobal('fetch', mockFetch);
    currentConfig = makeConfig({ mattermost: { enabled: true, token: TOKEN, apiKey: SERVER_URL } });
    const ch = new MattermostChannelClass();
    await ch.connect();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    // The adapter sets connected=true inside the 'open' handler, after
    // sending the authentication_challenge. Fire it to complete the handshake.
    ws.fire('open');
    return { ch, ws, mockFetch };
}

// ══════════════════════════════════════════════════════════════════════════
// MattermostChannel
// ══════════════════════════════════════════════════════════════════════════

describe('MattermostChannel', () => {
    let MattermostChannelClass: typeof import('../src/channels/mattermost.js')['MattermostChannel'];

    beforeEach(async () => {
        vi.resetModules();
        FakeWebSocket.instances = [];
        currentConfig = makeConfig();
        const mod = await import('../src/channels/mattermost.js');
        MattermostChannelClass = mod.MattermostChannel;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('should have correct name and displayName', () => {
        const ch = new MattermostChannelClass();
        expect(ch.name).toBe('mattermost');
        expect(ch.displayName).toBe('Mattermost');
    });

    it('connect when disabled should return immediately (no fetch, no ws)', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        const logger = (await import('../src/utils/logger.js')).default;

        const ch = new MattermostChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(logger.info).toHaveBeenCalledWith('Mattermost', 'Mattermost channel is disabled');
    });

    it('connect with missing token should warn and stay disconnected', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ mattermost: { enabled: true, token: '', apiKey: SERVER_URL } });

        const ch = new MattermostChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
            'Mattermost',
            'Mattermost token or server URL not configured (token + apiKey)'
        );
    });

    it('connect with missing server URL should warn and stay disconnected', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ mattermost: { enabled: true, token: TOKEN, apiKey: '' } });

        const ch = new MattermostChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });

    it('connect should probe /api/v4/users/me with a Bearer auth header', async () => {
        const mockFetch = makeAuthOkFetch();
        await connectAndOpen(MattermostChannelClass, mockFetch);

        // First fetch is the auth probe.
        const [probeUrl, probeOpts] = mockFetch.mock.calls[0];
        expect(probeUrl).toBe(`${SERVER_URL}/api/v4/users/me`);
        expect((probeOpts as any).headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('connect should open a WebSocket to the ws:// /api/v4/websocket endpoint', async () => {
        const { ws } = await connectAndOpen(MattermostChannelClass);
        // https -> wss (the adapter replaces only the leading "http")
        expect(ws.url).toBe('wss://mm.example.com/api/v4/websocket');
    });

    it("connect 'open' handler should send an authentication_challenge with the token and set connected=true", async () => {
        const { ch, ws } = await connectAndOpen(MattermostChannelClass);

        expect(ws.send).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(ws.send.mock.calls[0][0]);
        expect(sent.action).toBe('authentication_challenge');
        expect(sent.seq).toBe(1);
        expect(sent.data.token).toBe(TOKEN);

        expect(ch.getStatus().connected).toBe(true);
    });

    it('connect should log an error and not open a ws when the auth probe fails', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
        vi.stubGlobal('fetch', mockFetch);
        currentConfig = makeConfig({ mattermost: { enabled: true, token: TOKEN, apiKey: SERVER_URL } });

        const ch = new MattermostChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(logger.error).toHaveBeenCalled();
        // The thrown error carries the status code.
        const errArgs = (logger.error as any).mock.calls[0];
        expect(String(errArgs[1])).toContain('401');
    });

    it('connect should strip trailing slashes from the server URL (baseUrl + ws url)', async () => {
        const mockFetch = makeAuthOkFetch();
        vi.stubGlobal('fetch', mockFetch);
        currentConfig = makeConfig({
            mattermost: { enabled: true, token: TOKEN, apiKey: 'https://mm.example.com///' },
        });
        const ch = new MattermostChannelClass();
        await ch.connect();
        const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
        ws.fire('open');

        // probe used the trimmed base
        expect(mockFetch.mock.calls[0][0]).toBe('https://mm.example.com/api/v4/users/me');
        expect(ws.url).toBe('wss://mm.example.com/api/v4/websocket');
    });

    // ── inbound message parsing ────────────────────────────────────────────
    it("inbound 'posted' WS event should emit a parsed InboundMessage", async () => {
        const { ch, ws } = await connectAndOpen(MattermostChannelClass);

        const received: any[] = [];
        ch.on('message', (m: any) => received.push(m));

        const post = {
            id: 'post-99',
            user_id: 'human-42',
            channel_id: 'channel-7',
            message: 'hello titan',
            create_at: 1717000000000,
            props: { username: 'alice' },
        };
        // Mattermost nests the post as a JSON STRING inside data.post.
        ws.fire('message', JSON.stringify({ event: 'posted', data: { post: JSON.stringify(post) } }));

        expect(received).toHaveLength(1);
        const msg = received[0];
        expect(msg.id).toBe('post-99');
        expect(msg.channel).toBe('mattermost');
        expect(msg.userId).toBe('human-42');
        expect(msg.userName).toBe('alice');
        expect(msg.content).toBe('hello titan');
        expect(msg.groupId).toBe('channel-7');
        expect(msg.timestamp).toBeInstanceOf(Date);
        expect(msg.timestamp.getTime()).toBe(1717000000000);
        expect(msg.raw).toEqual(post);
    });

    it("inbound 'posted' event from the bot's own user_id should be ignored", async () => {
        const { ch, ws } = await connectAndOpen(MattermostChannelClass);

        const received: any[] = [];
        ch.on('message', (m: any) => received.push(m));

        const ownPost = {
            id: 'p1',
            user_id: BOT_USER_ID, // same as the bot -> must be skipped
            channel_id: 'c1',
            message: 'echo from self',
            create_at: 1717000000001,
        };
        ws.fire('message', JSON.stringify({ event: 'posted', data: { post: JSON.stringify(ownPost) } }));

        expect(received).toHaveLength(0);
    });

    it('inbound non-posted events should be ignored', async () => {
        const { ch, ws } = await connectAndOpen(MattermostChannelClass);
        const received: any[] = [];
        ch.on('message', (m: any) => received.push(m));

        ws.fire('message', JSON.stringify({ event: 'typing', data: {} }));
        ws.fire('message', JSON.stringify({ event: 'hello', data: {} }));

        expect(received).toHaveLength(0);
    });

    it('inbound malformed JSON should be caught and logged, not thrown', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const { ws } = await connectAndOpen(MattermostChannelClass);

        // not valid JSON -> JSON.parse throws inside the handler
        expect(() => ws.fire('message', 'not-json{')).not.toThrow();
        expect(logger.error).toHaveBeenCalled();
    });

    // ── send() ─────────────────────────────────────────────────────────────
    it('send when not connected should return early (no fetch)', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        const ch = new MattermostChannelClass();
        await ch.send({ channel: 'mattermost', content: 'hi', groupId: 'c1' });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('send with groupId should POST /api/v4/posts with Bearer auth and correct body', async () => {
        const { ch, mockFetch } = await connectAndOpen(MattermostChannelClass);

        await ch.send({ channel: 'mattermost', content: 'hello world', groupId: 'channel-7' });

        // The last fetch call is the post (first was the /users/me probe).
        const postCall = mockFetch.mock.calls.find((c) =>
            String(c[0]).endsWith('/api/v4/posts')
        )!;
        expect(postCall).toBeDefined();
        const [url, opts] = postCall as [string, any];
        expect(url).toBe(`${SERVER_URL}/api/v4/posts`);
        expect(opts.method).toBe('POST');
        expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(opts.headers['Content-Type']).toBe('application/json');

        const body = JSON.parse(opts.body);
        expect(body).toEqual({ channel_id: 'channel-7', message: 'hello world' });
    });

    it('send with only userId (no groupId) should use userId as the channel_id', async () => {
        const { ch, mockFetch } = await connectAndOpen(MattermostChannelClass);

        await ch.send({ channel: 'mattermost', content: 'dm body', userId: 'dm-channel-3' });

        const postCall = mockFetch.mock.calls.find((c) =>
            String(c[0]).endsWith('/api/v4/posts')
        )! as [string, any];
        const body = JSON.parse(postCall[1].body);
        expect(body.channel_id).toBe('dm-channel-3');
        expect(body.message).toBe('dm body');
    });

    it('send without a channel id should warn and not POST', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const { ch, mockFetch } = await connectAndOpen(MattermostChannelClass);
        const callsBefore = mockFetch.mock.calls.length;

        await ch.send({ channel: 'mattermost', content: 'no destination' });

        expect(mockFetch.mock.calls.length).toBe(callsBefore); // no new fetch
        expect(logger.warn).toHaveBeenCalledWith(
            'Mattermost',
            'No channel ID provided for Mattermost message'
        );
    });

    it('send should log an error when the posts endpoint returns non-ok', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn(async (url: string) => {
            if (String(url).endsWith('/api/v4/users/me')) {
                return { ok: true, status: 200, json: async () => ({ id: BOT_USER_ID }) };
            }
            return { ok: false, status: 500, json: async () => ({}) };
        });
        const { ch } = await connectAndOpen(MattermostChannelClass, mockFetch);

        await ch.send({ channel: 'mattermost', content: 'boom', groupId: 'c1' });

        expect(logger.error).toHaveBeenCalled();
        const errArgs = (logger.error as any).mock.calls.at(-1);
        expect(String(errArgs[1])).toContain('500');
    });

    // ── disconnect() ────────────────────────────────────────────────────────
    it('disconnect should close the websocket and flip connected=false', async () => {
        const { ch, ws } = await connectAndOpen(MattermostChannelClass);
        expect(ch.getStatus().connected).toBe(true);

        await ch.disconnect();

        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(ch.getStatus().connected).toBe(false);
    });

    it('disconnect when never connected should be a no-op', async () => {
        const ch = new MattermostChannelClass();
        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it("ws 'close' handler should flip connected=false", async () => {
        const { ch, ws } = await connectAndOpen(MattermostChannelClass);
        expect(ch.getStatus().connected).toBe(true);

        ws.fire('close');

        expect(ch.getStatus().connected).toBe(false);
    });

    it("ws 'error' handler should log the error without throwing", async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const { ws } = await connectAndOpen(MattermostChannelClass);

        expect(() => ws.fire('error', new Error('socket exploded'))).not.toThrow();
        expect(logger.error).toHaveBeenCalled();
    });

    // ── getStatus() ──────────────────────────────────────────────────────────
    it('getStatus should return correct shape when disconnected', () => {
        const ch = new MattermostChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'Mattermost', connected: false });
    });

    it('getStatus should report connected=true after a full connect handshake', async () => {
        const { ch } = await connectAndOpen(MattermostChannelClass);
        expect(ch.getStatus()).toEqual({ name: 'Mattermost', connected: true });
    });
});
