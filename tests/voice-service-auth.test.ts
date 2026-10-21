import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { voiceServiceFetch } from '../src/security/voiceServiceAuth.js';

const token = 'synthetic_voice_service_token_0123456789abcdef';
const origin = 'http://127.0.0.1:48421';
const fakeFetch = vi.fn<typeof fetch>(async () => new Response('synthetic'));

beforeEach(() => {
    vi.stubGlobal('fetch', fakeFetch);
    vi.stubEnv('TITAN_VOICE_SERVER_URL', '');
    vi.stubEnv('TITAN_VOICE_AUTH_TOKEN', '');
    fakeFetch.mockClear();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
const configure = (url = origin) => {
    vi.stubEnv('TITAN_VOICE_SERVER_URL', url);
    vi.stubEnv('TITAN_VOICE_AUTH_TOKEN', token);
};
const sentHeaders = () => new Headers(fakeFetch.mock.calls[0]?.[1]?.headers);

describe('optional voice service credentials', () => {
    it('preserves ordinary default F5 requests without optional service configuration', async () => {
        await voiceServiceFetch('http://localhost:5006/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        expect(sentHeaders().has('authorization')).toBe(false);
        expect(sentHeaders().get('content-type')).toBe('application/json');
    });

    it('sends the independent token only to the exact configured origin and forbids redirects', async () => {
        configure();
        await voiceServiceFetch(origin + '/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
        expect(sentHeaders().get('authorization')).toBe('Bearer ' + token);
        expect(fakeFetch.mock.calls[0][1]?.redirect).toBe('error');
    });

    it.each(['http://127.0.0.1:5006', 'https://other.example', 'http://127.0.0.1.attacker.invalid:48421'])('never sends this token to another origin: %s', async (other) => {
        configure();
        await voiceServiceFetch(other + '/v1/audio/speech');
        expect(sentHeaders().has('authorization')).toBe(false);
    });

    it('supports explicitly configured HTTPS and literal IPv6 loopback origins', async () => {
        for (const url of ['https://voice.example', 'http://[::1]:48421']) {
            configure(url);
            await voiceServiceFetch(url + '/v1/audio/voices');
            expect(sentHeaders().get('authorization')).toBe('Bearer ' + token);
            fakeFetch.mockClear();
        }
    });

    it.each(['http://localhost:48421', 'http://127.0.0.1.attacker.invalid:48421', 'http://192.0.2.1:48421', 'https://user:password@voice.example', 'https://voice.example/base', 'https://voice.example?token=synthetic'])('rejects unsafe configured service URL before dispatch: %s', async (url) => {
        configure(url);
        await expect(voiceServiceFetch(url)).rejects.toThrow('voice service');
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('rejects credentials embedded in a request URL before dispatch', async () => {
        configure('https://voice.example');
        await expect(voiceServiceFetch('https://user:password@voice.example/v1/audio/speech')).rejects.toThrow('voice service');
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('rejects abbreviated loopback notation for credentialed requests', async () => {
        configure();
        await expect(voiceServiceFetch('http://127.1:48421/v1/audio/speech')).rejects.toThrow('voice service');
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it.each(['', 'short', token + ' '])('fails closed for missing or invalid matching service token', async (invalid) => {
        configure();
        vi.stubEnv('TITAN_VOICE_AUTH_TOKEN', invalid);
        await expect(voiceServiceFetch(origin + '/v1/audio/speech')).rejects.toThrow('voice service');
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('requires an explicit service origin when a service token is configured', async () => {
        vi.stubEnv('TITAN_VOICE_AUTH_TOKEN', token);
        await expect(voiceServiceFetch(origin + '/v1/audio/speech')).rejects.toThrow('voice service');
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('rejects ambiguous existing Authorization and propagates redirect refusal', async () => {
        configure();
        await expect(voiceServiceFetch(origin + '/v1/audio/speech', { headers: { Authorization: 'Bearer synthetic_other' } })).rejects.toThrow();
        expect(fakeFetch).not.toHaveBeenCalled();
        fakeFetch.mockImplementationOnce(async (_url, options) => {
            if (options?.redirect === 'error') throw new TypeError('Redirect refused');
            throw new Error('Redirect would have been followed');
        });
        await expect(voiceServiceFetch(origin + '/v1/audio/speech')).rejects.toThrow('Redirect refused');
    });
});
