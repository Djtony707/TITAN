import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Script } from 'vm';
import { transformSync } from 'esbuild';
import { hasPrivateLiveKitCredentials } from '../src/security/livekitCredentials.js';

const key = 'synthetic_operator_key';
const secret = 'synthetic_operator_secret_0123456789abcdef';

function routerFixture(voice: Record<string, unknown>) {
    const handlers = new Map<string, (...args: any[]) => any>();
    const router: Record<string, (...args: any[]) => unknown> = {};
    for (const method of ['get', 'post', 'delete']) router[method] = (path, ...callbacks) => { handlers.set(`${method} ${path}`, callbacks.at(-1)); return router; };
    const module = { exports: {} as { createVoiceRouter: (...args: any[]) => unknown } };
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const source = transformSync(readFileSync(join(process.cwd(), 'src/gateway/routes/voiceRouter.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22', logLevel: 'silent' }).code;
    const forbidden = () => { throw new Error('Unexpected side effect in isolated voice router fixture'); };
    new Script(source, { filename: 'voice-router.fixture.cjs' }).runInNewContext({
        module, exports: module.exports, fetch, AbortController, AbortSignal, URL,
        process: { env: {} }, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        require: (name: string) => {
            if (name === 'express') return { Router: () => router };
            if (name === 'os') return { homedir: () => '/synthetic-not-owner' };
            if (name === 'path') return { join, dirname: () => '/synthetic-router' };
            if (name === 'url') return { fileURLToPath: () => '/synthetic-router/voiceRouter.js' };
            if (name === 'fs') return new Proxy({}, { get: () => forbidden });
            if (name === 'child_process') return { execSync: forbidden, spawn: forbidden };
            if (name.endsWith('/config.js')) return { loadConfig: () => ({ voice }) };
            if (name.endsWith('/logger.js')) return { default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } };
            if (name.endsWith('/livekitCredentials.js')) return { hasPrivateLiveKitCredentials };
            if (name.endsWith('/voiceServiceAuth.js')) return { voiceServiceFetch: fetch };
            if (name.endsWith('/sseFlush.js')) return { setupSSEFlush: forbidden };
            if (name.endsWith('/agent.js')) return { processMessage: forbidden };
            if (name.endsWith('/multiAgent.js')) return { routeMessage: forbidden };
            throw new Error('Unexpected module: ' + name);
        },
    });
    module.exports.createVoiceRouter(new Map(), new Map());
    const response = () => {
        const result = { code: 200, body: undefined as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
        return result;
    };
    return { handlers, fetch, response };
}

describe('private LiveKit credential boundary', () => {
    it.each([
        {}, { livekitApiKey: 'devkey', livekitApiSecret: 'secret' },
        { livekitApiKey: key, livekitApiSecret: 'short' },
        { livekitApiKey: key + '\n', livekitApiSecret: secret },
        { livekitApiKey: key, livekitApiSecret: secret + ':' },
        { livekitApiKey: 'x'.repeat(129), livekitApiSecret: secret },
        { livekitApiKey: key, livekitApiSecret: 'x'.repeat(257) },
        { livekitApiKey: 12345678, livekitApiSecret: secret },
    ])('rejects missing, shared or ambiguous credentials', voice => {
        expect(hasPrivateLiveKitCredentials(voice)).toBe(false);
    });

    it.each([[key, secret], ['12345678', '1'.repeat(32)], ['a'.repeat(128), 'b'.repeat(256)]])('accepts explicit private URL-safe pairs', (livekitApiKey, livekitApiSecret) => {
        expect(hasPrivateLiveKitCredentials({ livekitApiKey, livekitApiSecret })).toBe(true);
    });

    it('the actual configuration route omits the signing secret and preserves ordinary fields', async () => {
        const voice = { enabled: true, livekitUrl: 'ws://127.0.0.1:7880', livekitApiKey: key, livekitApiSecret: secret, ttsEngine: 'f5-tts', ttsUrl: 'http://localhost:5006', ttsVoice: 'andrew' };
        const fixture = routerFixture(voice);
        const res = fixture.response();
        await fixture.handlers.get('get /voice/config')!({}, res);
        expect(res.body).not.toHaveProperty('livekitApiSecret');
        expect(JSON.stringify(res.body)).not.toContain(secret);
        expect(res.body).toEqual({ enabled: true, livekitUrl: voice.livekitUrl, livekitApiKey: key, ttsEngine: 'f5-tts', ttsUrl: voice.ttsUrl, ttsVoice: 'andrew' });
        expect(voice.livekitApiSecret).toBe(secret);
        expect(fixture.fetch).not.toHaveBeenCalled();
    });

    it.each([{}, { livekitApiKey: 'devkey', livekitApiSecret: 'secret' }])('the actual token/status routes refuse invalid credentials before SDK/network calls', async pair => {
        const fixture = routerFixture({ enabled: true, ...pair, livekitUrl: 'ws://127.0.0.1:7880' });
        const tokenRes = fixture.response();
        await fixture.handlers.get('post /livekit/token')!({ headers: {} }, tokenRes);
        expect(tokenRes.code).toBe(503);
        expect(tokenRes.body.error).toBe('LiveKit not configured');
        const statusRes = fixture.response();
        await fixture.handlers.get('get /voice/status')!({}, statusRes);
        expect(statusRes.body.available).toBe(false);
        expect(fixture.fetch).not.toHaveBeenCalled();
    });
});
