/**
 * TITAN — Zulip Channel Adapter Tests
 *
 * Exercises the REAL behavior of src/channels/zulip.ts:
 *   - name / displayName
 *   - connect() when DISABLED returns without connecting
 *   - connect() with missing credentials warns + stays disconnected
 *   - connect() real transport: GET /api/v1/users/me + POST /api/v1/register,
 *     HTTP Basic auth header derived from token(bot email):apiKey
 *   - send() stream message → POST /api/v1/messages type=stream to the right URL
 *   - send() direct message → POST /api/v1/messages type=direct
 *   - send() when not connected is a no-op (no fetch)
 *   - inbound long-poll parsing → emits a correctly-shaped InboundMessage
 *
 * Self-contained harness (own copy of the config + logger mocks and the
 * fresh-re-import-per-test pattern) so it does not depend on channels.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Common mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Default config factory — zulip disabled by default */
function makeConfig(overrides: Record<string, unknown> = {}) {
    const base = {
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        channels: {
            zulip: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
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

// ── Helpers ────────────────────────────────────────────────────────────────

/** A fetch mock that resolves a JSON body and never lets the background
 *  long-poll loop run away — every /api/v1/events GET hangs forever (never
 *  resolves) so pollEvents() stays parked after the initial register. */
function makeJsonFetch(handler: (url: string, init?: any) => unknown) {
    return vi.fn((url: string, init?: any) => {
        // The background poller GETs /api/v1/events — keep it pending so the
        // test's assertions on the foreground calls are deterministic.
        if (typeof url === 'string' && url.includes('/api/v1/events?queue_id')) {
            return new Promise(() => {}); // never resolves
        }
        const body = handler(url, init);
        return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(body),
        });
    });
}

const ZULIP_SERVER = 'https://titan.zulipchat.com';
const BOT_EMAIL = 'titan-bot@titan.zulipchat.com';
const API_KEY = 's3cr3t-api-key';
// Basic <base64(email:apiKey)>
const EXPECTED_AUTH = 'Basic ' + Buffer.from(`${BOT_EMAIL}:${API_KEY}`).toString('base64');

function enabledConfig(extra: Record<string, unknown> = {}) {
    return makeConfig({
        zulip: {
            enabled: true,
            token: BOT_EMAIL,
            apiKey: API_KEY,
            allowFrom: [ZULIP_SERVER],
            ...extra,
        },
    });
}

// ══════════════════════════════════════════════════════════════════════════
// Zulip Channel
// ══════════════════════════════════════════════════════════════════════════

describe('ZulipChannel', () => {
    let ZulipChannelClass: typeof import('../src/channels/zulip.js')['ZulipChannel'];

    beforeEach(async () => {
        vi.resetModules();
        currentConfig = makeConfig();
        const mod = await import('../src/channels/zulip.js');
        ZulipChannelClass = mod.ZulipChannel;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should have correct name and displayName', () => {
        const ch = new ZulipChannelClass();
        expect(ch.name).toBe('zulip');
        expect(ch.displayName).toBe('Zulip');
    });

    it('connect when disabled should return immediately without connecting', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new ZulipChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        // Disabled → no HTTP traffic at all
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('connect with missing credentials should warn and stay disconnected', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        // enabled but no apiKey / no server url → not configured
        currentConfig = makeConfig({ zulip: { enabled: true, token: BOT_EMAIL, apiKey: '', allowFrom: [] } });
        const ch = new ZulipChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalled();
        // No request attempted when not configured
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('connect should GET /users/me then POST /register with Basic auth, and become connected', async () => {
        const calls: Array<{ url: string; init?: any }> = [];
        const mockFetch = makeJsonFetch((url, init) => {
            calls.push({ url, init });
            if (url.endsWith('/api/v1/users/me')) {
                return { user_id: 4242 };
            }
            if (url.endsWith('/api/v1/register')) {
                return { queue_id: 'queue-abc', last_event_id: 17 };
            }
            return {};
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(true);
        expect(ch.getStatus().name).toBe('Zulip');

        // GET /users/me hit the right URL with the right Basic auth header
        const meCall = calls.find((c) => c.url.endsWith('/api/v1/users/me'));
        expect(meCall).toBeTruthy();
        expect(meCall!.url).toBe(`${ZULIP_SERVER}/api/v1/users/me`);
        expect(meCall!.init?.headers?.Authorization).toBe(EXPECTED_AUTH);

        // POST /register registered for the 'message' event type, form-encoded
        const regCall = calls.find((c) => c.url.endsWith('/api/v1/register'));
        expect(regCall).toBeTruthy();
        expect(regCall!.init?.method).toBe('POST');
        expect(regCall!.init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(regCall!.init?.headers?.Authorization).toBe(EXPECTED_AUTH);
        // body is URLSearchParams.toString() of { event_types: '["message"]' }
        const regParams = new URLSearchParams(regCall!.init?.body as string);
        expect(regParams.get('event_types')).toBe(JSON.stringify(['message']));

        await ch.disconnect();
    });

    it('connect should strip trailing slashes from the server URL', async () => {
        const calls: string[] = [];
        const mockFetch = makeJsonFetch((url) => {
            calls.push(url);
            if (url.endsWith('/api/v1/users/me')) return { user_id: 1 };
            if (url.endsWith('/api/v1/register')) return { queue_id: 'q', last_event_id: 0 };
            return {};
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig({ allowFrom: [`${ZULIP_SERVER}///`] });
        const ch = new ZulipChannelClass();
        await ch.connect();

        // No doubled/triple slash before /api
        expect(calls.some((u) => u === `${ZULIP_SERVER}/api/v1/users/me`)).toBe(true);
        expect(calls.every((u) => !u.includes('.com//api'))).toBe(true);

        await ch.disconnect();
    });

    it('connect should log error and stay disconnected when /users/me fails', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = vi.fn((url: string) => {
            if (typeof url === 'string' && url.endsWith('/api/v1/users/me')) {
                return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
            }
            return new Promise(() => {});
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        await ch.connect();

        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();
    });

    it('send with groupId should POST a stream message to /api/v1/messages', async () => {
        const calls: Array<{ url: string; init?: any }> = [];
        const mockFetch = makeJsonFetch((url, init) => {
            calls.push({ url, init });
            if (url.endsWith('/api/v1/users/me')) return { user_id: 7 };
            if (url.endsWith('/api/v1/register')) return { queue_id: 'q1', last_event_id: 0 };
            if (url.endsWith('/api/v1/messages')) return { id: 999, result: 'success' };
            return {};
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(true);

        await ch.send({ channel: 'zulip', content: 'hello stream', groupId: 'general/standup' });

        const msgCall = calls.find((c) => c.url.endsWith('/api/v1/messages'));
        expect(msgCall).toBeTruthy();
        expect(msgCall!.url).toBe(`${ZULIP_SERVER}/api/v1/messages`);
        expect(msgCall!.init?.method).toBe('POST');
        expect(msgCall!.init?.headers?.Authorization).toBe(EXPECTED_AUTH);

        const params = new URLSearchParams(msgCall!.init?.body as string);
        expect(params.get('type')).toBe('stream');
        expect(params.get('to')).toBe('general');
        expect(params.get('topic')).toBe('standup');
        expect(params.get('content')).toBe('hello stream');

        await ch.disconnect();
    });

    it('send with groupId lacking a topic should default the topic to TITAN', async () => {
        const calls: Array<{ url: string; init?: any }> = [];
        const mockFetch = makeJsonFetch((url, init) => {
            calls.push({ url, init });
            if (url.endsWith('/api/v1/users/me')) return { user_id: 7 };
            if (url.endsWith('/api/v1/register')) return { queue_id: 'q1', last_event_id: 0 };
            if (url.endsWith('/api/v1/messages')) return { id: 1 };
            return {};
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        await ch.connect();

        // groupId with no slash → topic segment is undefined → falls back to 'TITAN'
        await ch.send({ channel: 'zulip', content: 'no topic', groupId: 'announce' });

        const msgCall = calls.find((c) => c.url.endsWith('/api/v1/messages'));
        const params = new URLSearchParams(msgCall!.init?.body as string);
        expect(params.get('type')).toBe('stream');
        expect(params.get('to')).toBe('announce');
        expect(params.get('topic')).toBe('TITAN');

        await ch.disconnect();
    });

    it('send with userId (no groupId) should POST a direct message', async () => {
        const calls: Array<{ url: string; init?: any }> = [];
        const mockFetch = makeJsonFetch((url, init) => {
            calls.push({ url, init });
            if (url.endsWith('/api/v1/users/me')) return { user_id: 7 };
            if (url.endsWith('/api/v1/register')) return { queue_id: 'q1', last_event_id: 0 };
            if (url.endsWith('/api/v1/messages')) return { id: 2 };
            return {};
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        await ch.connect();

        await ch.send({ channel: 'zulip', content: 'private hi', userId: '55' });

        const msgCall = calls.find((c) => c.url.endsWith('/api/v1/messages'));
        expect(msgCall).toBeTruthy();
        const params = new URLSearchParams(msgCall!.init?.body as string);
        expect(params.get('type')).toBe('direct');
        // userId is JSON-stringified into a single-element array
        expect(params.get('to')).toBe(JSON.stringify(['55']));
        expect(params.get('content')).toBe('private hi');

        await ch.disconnect();
    });

    it('send when not connected should be a no-op (no /messages request)', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const ch = new ZulipChannelClass(); // never connected
        await ch.send({ channel: 'zulip', content: 'dropped', userId: '1' });

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('send with neither groupId nor userId should warn (when connected)', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const mockFetch = makeJsonFetch((url) => {
            if (url.endsWith('/api/v1/users/me')) return { user_id: 7 };
            if (url.endsWith('/api/v1/register')) return { queue_id: 'q1', last_event_id: 0 };
            return {};
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        await ch.connect();
        vi.mocked(logger.warn).mockClear();

        await ch.send({ channel: 'zulip', content: 'no target' });
        expect(logger.warn).toHaveBeenCalledWith('Zulip', 'No target provided for Zulip message');

        await ch.disconnect();
    });

    it('inbound long-poll should parse a stream event and emit a shaped InboundMessage', async () => {
        // Drive the long-poll loop manually by resolving /events ONCE with a
        // message event, then hanging on the second poll.
        let eventsCallCount = 0;
        const streamMessage = {
            id: 12345,
            sender_id: 88, // not the bot (botUserId=7)
            sender_full_name: 'Alice Example',
            content: 'hey TITAN',
            stream_id: 3,
            subject: 'general-topic',
            display_recipient: 'engineering',
            timestamp: 1_700_000_000,
            type: 'stream',
        };

        const mockFetch = vi.fn((url: string, init?: any) => {
            if (typeof url === 'string' && url.endsWith('/api/v1/users/me')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user_id: 7 }) });
            }
            if (typeof url === 'string' && url.endsWith('/api/v1/register')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ queue_id: 'qz', last_event_id: 0 }) });
            }
            if (typeof url === 'string' && url.includes('/api/v1/events?queue_id')) {
                eventsCallCount++;
                if (eventsCallCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () => Promise.resolve({
                            events: [{ id: 1, type: 'message', message: streamMessage }],
                        }),
                    });
                }
                // Second+ poll: hang forever so the while loop parks.
                return new Promise(() => {});
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();

        const received: any[] = [];
        ch.on('message', (m) => received.push(m));

        await ch.connect();

        // pollEvents runs in the background — wait for the emitted message.
        await vi.waitFor(() => {
            expect(received.length).toBeGreaterThanOrEqual(1);
        }, { timeout: 2000, interval: 10 });

        const inbound = received[0];
        expect(inbound.id).toBe('12345');
        expect(inbound.channel).toBe('zulip');
        expect(inbound.userId).toBe('88');
        expect(inbound.userName).toBe('Alice Example');
        expect(inbound.content).toBe('hey TITAN');
        // stream → groupId is "display_recipient/subject"
        expect(inbound.groupId).toBe('engineering/general-topic');
        expect(inbound.timestamp).toBeInstanceOf(Date);
        expect(inbound.timestamp.getTime()).toBe(1_700_000_000 * 1000);
        expect(inbound.raw).toBe(streamMessage);

        // Stop the background loop.
        await ch.disconnect();
    });

    it('inbound long-poll should ignore the bots own messages', async () => {
        let eventsCallCount = 0;
        const ownMessage = {
            id: 1, sender_id: 7, sender_full_name: 'TITAN', content: 'echo',
            display_recipient: 'general', subject: 't', timestamp: 1, type: 'stream',
        };
        const mockFetch = vi.fn((url: string) => {
            if (typeof url === 'string' && url.endsWith('/api/v1/users/me')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user_id: 7 }) });
            }
            if (typeof url === 'string' && url.endsWith('/api/v1/register')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ queue_id: 'qz', last_event_id: 0 }) });
            }
            if (typeof url === 'string' && url.includes('/api/v1/events?queue_id')) {
                eventsCallCount++;
                if (eventsCallCount === 1) {
                    return Promise.resolve({
                        ok: true, status: 200,
                        json: () => Promise.resolve({ events: [{ id: 5, type: 'message', message: ownMessage }] }),
                    });
                }
                return new Promise(() => {});
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        const received: any[] = [];
        ch.on('message', (m) => received.push(m));
        await ch.connect();

        // Wait until the first /events poll has been consumed.
        await vi.waitFor(() => {
            expect(eventsCallCount).toBeGreaterThanOrEqual(1);
        }, { timeout: 2000, interval: 10 });
        // Give the loop a beat to (not) emit.
        await new Promise((r) => setTimeout(r, 20));

        expect(received).toHaveLength(0);
        await ch.disconnect();
    });

    it('disconnect should mark disconnected and clear the queue', async () => {
        const mockFetch = makeJsonFetch((url) => {
            if (url.endsWith('/api/v1/users/me')) return { user_id: 7 };
            if (url.endsWith('/api/v1/register')) return { queue_id: 'q1', last_event_id: 0 };
            if (url.endsWith('/api/v1/events')) return {}; // delete-queue POST
            return {};
        });
        vi.stubGlobal('fetch', mockFetch);

        currentConfig = enabledConfig();
        const ch = new ZulipChannelClass();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(true);

        await ch.disconnect();
        expect(ch.getStatus().connected).toBe(false);
    });

    it('getStatus should return the correct shape', () => {
        const ch = new ZulipChannelClass();
        expect(ch.getStatus()).toEqual({ name: 'Zulip', connected: false });
    });
});
