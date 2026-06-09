/**
 * TITAN — IRC Channel Adapter Tests
 *
 * Exercises the REAL code paths of src/channels/irc.ts:
 *   - name / displayName
 *   - connect() when DISABLED (info log, stays disconnected)
 *   - connect() with missing server address (token) — warns, stays disconnected
 *   - connect() with creds but irc-framework NOT installed — hits the import
 *     failure path (logger.error + actionable install hint), stays disconnected
 *   - connect() with a MOCKED irc-framework — verifies the real transport wiring:
 *     client.connect({host,port,nick}) with parsed host:port + nick from apiKey,
 *     'registered' handler sets connected + joins '#' channels from allowFrom,
 *     'privmsg' handler parses inbound into the exact InboundMessage shape,
 *     'close' handler clears connected
 *   - send() routing through say(target, content) (groupId preferred over userId)
 *   - send() when not connected / no target — real no-op / warn behavior
 *   - disconnect() calls quit() and resets state
 *   - getStatus() shape
 *
 * Self-contained harness (own copy of the config + logger mocks + the
 * fresh-re-import-per-test pattern), mirroring tests/channels.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Common mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-irc',
    TITAN_VERSION: '2026.5.0',
}));

/** Default config factory — IRC channel disabled by default */
function makeConfig(overrides: Record<string, unknown> = {}) {
    const base = {
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        channels: {
            irc: { enabled: false, token: '', apiKey: '', allowFrom: [], dmPolicy: 'pairing' },
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

// ── A fake irc-framework Client for the "installed" path ───────────────────
// The real adapter does `await import('irc-framework')` and uses the `Client`
// export. We capture per-instance state so the test can drive the event
// handlers the adapter registers (registered / privmsg / close).

type Handler = (...args: unknown[]) => void;

class FakeClient {
    static instances: FakeClient[] = [];
    handlers = new Map<string, Handler>();
    connectCalls: Array<{ host?: string; port?: number; nick?: string }> = [];
    joined: string[] = [];
    said: Array<{ target: string; text: string }> = [];
    quitMessages: string[] = [];
    sayShouldThrow = false;

    constructor() {
        FakeClient.instances.push(this);
    }
    connect(opts: { host?: string; port?: number; nick?: string }) {
        this.connectCalls.push(opts);
    }
    on(event: string, handler: Handler) {
        this.handlers.set(event, handler);
    }
    join(ch: string) {
        this.joined.push(ch);
    }
    say(target: string, text: string) {
        if (this.sayShouldThrow) throw new Error('say boom');
        this.said.push({ target, text });
    }
    quit(msg: string) {
        this.quitMessages.push(msg);
    }
    /** Fire a registered event handler the way irc-framework would. */
    fire(event: string, ...args: unknown[]) {
        const h = this.handlers.get(event);
        if (!h) throw new Error(`no handler registered for '${event}'`);
        h(...args);
    }
}

// Default: irc-framework is NOT mocked, so the dynamic import fails (module
// genuinely not installed) — that drives the import-failure tests. Individual
// tests that need the "installed" path register the mock + reset modules.

describe('IRCChannel', () => {
    let IRCChannelClass: typeof import('../src/channels/irc.js')['IRCChannel'];

    async function freshAdapter() {
        const mod = await import('../src/channels/irc.js');
        IRCChannelClass = mod.IRCChannel;
        return new IRCChannelClass();
    }

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks(); // logger mock is module-level; clear per-test so assertions only see this test's calls
        vi.doUnmock('irc-framework');
        currentConfig = makeConfig();
        FakeClient.instances = [];
    });

    // ── Identity ───────────────────────────────────────────────────────────

    it('should have correct name and displayName', async () => {
        const ch = await freshAdapter();
        expect(ch.name).toBe('irc');
        expect(ch.displayName).toBe('IRC');
    });

    it('getStatus should return correct shape (disconnected by default)', async () => {
        const ch = await freshAdapter();
        expect(ch.getStatus()).toEqual({ name: 'IRC', connected: false });
    });

    // ── connect(): disabled ─────────────────────────────────────────────────

    it('connect when disabled should log info and stay disconnected', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig(); // irc disabled
        const ch = await freshAdapter();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.info).toHaveBeenCalledWith('IRC', 'IRC channel is disabled');
    });

    // ── connect(): missing server address (token) ──────────────────────────

    it('connect with missing server address should warn and stay disconnected', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ irc: { enabled: true, token: '' } });
        const ch = await freshAdapter();
        await ch.connect();
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            'IRC',
            'IRC server address not configured (set channels.irc.token to host:port)'
        );
    });

    // ── connect(): creds present but irc-framework NOT installed ────────────

    it('connect with server address but irc-framework missing should hit import-failure path', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        currentConfig = makeConfig({ irc: { enabled: true, token: 'irc.libera.chat:6667', apiKey: 'TitanBot' } });
        const ch = await freshAdapter();
        await ch.connect();
        // irc-framework is genuinely not installed → dynamic import throws → catch.
        expect(ch.getStatus().connected).toBe(false);
        expect(logger.error).toHaveBeenCalled();
        // The actionable install hint must be logged.
        expect(logger.info).toHaveBeenCalledWith('IRC', 'Install irc-framework with: npm install irc-framework');
        // The error message references the failure (no client was created).
        const errorCall = (logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
            (c: unknown[]) => c[0] === 'IRC' && typeof c[1] === 'string' && (c[1] as string).startsWith('Failed to connect:')
        );
        expect(errorCall).toBeTruthy();
    });

    // ── connect(): MOCKED irc-framework — real transport wiring ─────────────

    describe('with mocked irc-framework (transport wiring)', () => {
        async function connectWithFakeClient(ircOverrides: Record<string, unknown>) {
            vi.doMock('irc-framework', () => ({ Client: FakeClient }));
            vi.resetModules();
            currentConfig = makeConfig({ irc: ircOverrides });
            const mod = await import('../src/channels/irc.js');
            const ch = new mod.IRCChannel();
            await ch.connect();
            const client = FakeClient.instances[FakeClient.instances.length - 1];
            return { ch, client };
        }

        it('connect should parse host:port and call client.connect with nick from apiKey', async () => {
            const { client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6697',
                apiKey: 'MyNick',
            });
            expect(client).toBeTruthy();
            expect(client.connectCalls).toHaveLength(1);
            expect(client.connectCalls[0]).toEqual({
                host: 'irc.libera.chat',
                port: 6697,
                nick: 'MyNick',
            });
        });

        it('connect should default port to 6667 and nick to TitanBot when unspecified', async () => {
            const { client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.example.org', // no port
                apiKey: '', // no nick
            });
            expect(client.connectCalls[0]).toEqual({
                host: 'irc.example.org',
                port: 6667,
                nick: 'TitanBot',
            });
        });

        it("'registered' handler should set connected and join '#' channels from allowFrom", async () => {
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
                allowFrom: ['#titan', '#general', 'not-a-channel'],
            });
            // Before the server registers us, we are not connected.
            expect(ch.getStatus().connected).toBe(false);

            client.fire('registered');

            expect(ch.getStatus().connected).toBe(true);
            // Only the '#'-prefixed entries are joined; 'not-a-channel' is skipped.
            expect(client.joined).toEqual(['#titan', '#general']);
        });

        it("'privmsg' handler should parse inbound into the correct InboundMessage shape (channel msg)", async () => {
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            const received: any[] = [];
            ch.on('message', (m) => received.push(m));

            const event = { nick: 'alice', target: '#titan', message: 'hello titan', time: 1700000000000 };
            client.fire('privmsg', event);

            expect(received).toHaveLength(1);
            const msg = received[0];
            expect(msg.channel).toBe('irc');
            expect(msg.userId).toBe('alice');
            expect(msg.userName).toBe('alice');
            expect(msg.content).toBe('hello titan');
            // target starts with '#', so it becomes a groupId.
            expect(msg.groupId).toBe('#titan');
            expect(msg.timestamp).toBeInstanceOf(Date);
            expect(msg.timestamp.getTime()).toBe(1700000000000);
            expect(msg.id).toContain('-alice');
            expect(msg.raw).toBe(event);
        });

        it("'privmsg' handler should leave groupId undefined for a direct (non-#) message", async () => {
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            const received: any[] = [];
            ch.on('message', (m) => received.push(m));

            // A PM: target is the bot's own nick, not a channel.
            client.fire('privmsg', { nick: 'bob', target: 'TitanBot', message: 'psst' });

            expect(received).toHaveLength(1);
            expect(received[0].groupId).toBeUndefined();
            expect(received[0].userId).toBe('bob');
            expect(received[0].content).toBe('psst');
            // No time provided → timestamp falls back to now (still a Date).
            expect(received[0].timestamp).toBeInstanceOf(Date);
        });

        it("'close' handler should clear connected", async () => {
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            client.fire('registered');
            expect(ch.getStatus().connected).toBe(true);
            client.fire('close');
            expect(ch.getStatus().connected).toBe(false);
        });

        // ── send() routing through the transport ─────────────────────────────

        it('send should route to client.say with groupId as target (preferred over userId)', async () => {
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            client.fire('registered'); // must be connected for send() to transmit
            await ch.send({ channel: 'irc', content: 'hi room', groupId: '#titan', userId: 'alice' });
            expect(client.said).toEqual([{ target: '#titan', text: 'hi room' }]);
        });

        it('send should use userId as target when no groupId', async () => {
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            client.fire('registered');
            await ch.send({ channel: 'irc', content: 'dm you', userId: 'bob' });
            expect(client.said).toEqual([{ target: 'bob', text: 'dm you' }]);
        });

        it('send with no target should warn and not call say', async () => {
            const logger = (await import('../src/utils/logger.js')).default;
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            client.fire('registered');
            await ch.send({ channel: 'irc', content: 'no target' });
            expect(client.said).toHaveLength(0);
            expect(logger.warn).toHaveBeenCalledWith('IRC', 'No target provided for IRC message');
        });

        it('send should log error when say() throws', async () => {
            const logger = (await import('../src/utils/logger.js')).default;
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            client.fire('registered');
            client.sayShouldThrow = true;
            await ch.send({ channel: 'irc', content: 'boom', groupId: '#titan' });
            const errCall = (logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
                (c: unknown[]) => c[0] === 'IRC' && typeof c[1] === 'string' && (c[1] as string).startsWith('Send failed:')
            );
            expect(errCall).toBeTruthy();
        });

        // ── disconnect() ────────────────────────────────────────────────────

        it('disconnect should call client.quit and reset state', async () => {
            const { ch, client } = await connectWithFakeClient({
                enabled: true,
                token: 'irc.libera.chat:6667',
                apiKey: 'TitanBot',
            });
            client.fire('registered');
            expect(ch.getStatus().connected).toBe(true);

            await ch.disconnect();
            expect(client.quitMessages).toEqual(['TITAN shutting down']);
            expect(ch.getStatus().connected).toBe(false);

            // After disconnect, client is null → send() is a silent no-op.
            await ch.send({ channel: 'irc', content: 'after-quit', groupId: '#titan' });
            expect(client.said).toHaveLength(0);
        });
    });

    // ── send() / disconnect() with no client (not connected) ────────────────

    it('send when not connected should be a silent no-op (no warn, no throw)', async () => {
        const logger = (await import('../src/utils/logger.js')).default;
        const ch = await freshAdapter();
        // Never connected → client is null, connected is false.
        await expect(
            ch.send({ channel: 'irc', content: 'hello', groupId: '#titan' })
        ).resolves.toBeUndefined();
        // The early `if (!this.client || !this.connected) return;` runs BEFORE
        // the target check, so it must NOT warn about a missing target.
        expect(logger.warn).not.toHaveBeenCalledWith('IRC', 'No target provided for IRC message');
    });

    it('disconnect when client is null should be a no-op', async () => {
        const ch = await freshAdapter();
        await expect(ch.disconnect()).resolves.toBeUndefined();
        expect(ch.getStatus().connected).toBe(false);
    });
});
