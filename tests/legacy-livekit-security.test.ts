import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { Script } from 'vm';
import { transformSync } from 'esbuild';

const routePath = join(process.cwd(), 'titan-voice-ui/app/api/token/route.ts');
const setupPath = join(process.cwd(), 'titan-voice-ui/setup.sh');
let fixture: string;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'titan-legacy-voice-')); });
afterEach(() => { rmSync(fixture, { recursive: true, force: true }); });

function loadRoute(env: Record<string, string>) {
    const minted = vi.fn();
    const secretReads = vi.fn();
    class FakeNextResponse extends Response {
        static json(data: unknown, options: ResponseInit = {}) {
            const headers = new Headers(options.headers);
            headers.set('Content-Type', 'application/json');
            return new Response(JSON.stringify(data), { ...options, headers });
        }
    }
    class FakeAccessToken {
        constructor() { minted(); }
        addGrant() { /* no network; records construction above */ }
        async toJwt() { return 'synthetic-minted-token'; }
    }
    const module = { exports: {} as { POST: (request: Request) => Promise<Response>; revalidate: number } };
    const source = transformSync(readFileSync(routePath, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
    new Script(source, { filename: 'legacy-token-route.fixture.cjs' }).runInNewContext({
        module, exports: module.exports, Request, Response, Headers,
        process: { env: new Proxy(env, { get(target, key: string) { if (key.startsWith('LIVEKIT_')) secretReads(key);return target[key]; } }) },
        console: { error: vi.fn() },
        require: (name: string) => {
            if (name === 'next/server') return { NextResponse: FakeNextResponse };
            if (name === 'livekit-server-sdk') return { AccessToken: FakeAccessToken };
            if (name === '@livekit/protocol') return { RoomConfiguration: { fromJson: () => ({}) } };
            throw new Error('Unexpected module in isolated route fixture: ' + name);
        },
    });
    return { route: module.exports, minted, secretReads };
}

describe('legacy standalone LiveKit security hold', () => {
    it.each(['development', 'production'])('does not issue anonymous tokens with valid private credentials in %s', async mode => {
        const key = 'synthetic_private_operator_key';
        const secret = 'synthetic_private_operator_secret_0123456789abcdef';
        const { route, minted, secretReads } = loadRoute({ NODE_ENV: mode, LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret });
        const result = await route.POST(new Request('http://fixture.invalid/api/token', { method: 'POST', body: JSON.stringify({ room_config: { agents: [{ agent_name: 'fixture' }] } }), headers: { 'Content-Type': 'application/json' } }));
        expect.soft(result.status).toBe(503);
        expect.soft(minted).not.toHaveBeenCalled();
        const text = await result.text();
        expect(text).toContain('security hold');
        for (const value of [key, secret, 'synthetic-minted-token']) expect(text).not.toContain(value);
        expect(minted).not.toHaveBeenCalled();
        expect(secretReads).not.toHaveBeenCalled();
        expect(route.revalidate).toBe(0);
        expect(result.headers.get('Cache-Control')).toBe('no-store');
    });

    it('returns the same clear hold without environment credentials or a valid JSON body', async () => {
        const { route, minted } = loadRoute({});
        const result = await route.POST(new Request('http://fixture.invalid/api/token', { method: 'POST', body: 'invalid json' }));
        expect(result.status).toBe(503);
        expect((await result.json()).error).toContain('authenticated TITAN gateway');
        expect(minted).not.toHaveBeenCalled();
    });

    it('setup refuses before touching existing operator settings or running tools', () => {
        const setup = join(fixture, 'setup.sh');
        writeFileSync(setup, readFileSync(setupPath));
        writeFileSync(join(fixture, 'package.json'), '{}');
        const existing = 'EXISTING_OPERATOR_SETTING=keep-this-fixture\n';
        writeFileSync(join(fixture, '.env.local'), existing, { mode: 0o600 });
        const bin = join(fixture, 'bin');mkdirSync(bin);
        const calls = join(fixture, 'unexpected-tools');
        for (const tool of ['git', 'npm']) writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '${tool}\\n' >> '${calls}'\nexit 78\n`, { mode: 0o700 });
        const result = spawnSync('/bin/bash', [setup], { encoding: 'utf8', timeout: 5000, env: { PATH: `${bin}:/bin:/usr/bin`, HOME: fixture } });
        expect.soft(result.status).toBe(1);
        expect.soft(result.stderr).toContain('security hold');
        expect.soft(readFileSync(join(fixture, '.env.local'), 'utf8')).toBe(existing);
        expect.soft(existsSync(calls)).toBe(false);
    });
});
