import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, request, type Server } from 'http';
import { createHmac } from 'crypto';
import { GatewayConfigSchema } from '../src/config/schema.js';
import { createGatewayAuthBoundary, gatewayAuthConfigTransitionGuard, isGatewayCorsOriginAllowed, isLocalGatewayRequestAllowed, resolveGatewayListenHost, safeCredentialEqual, verifyLineWebhookSignature, type GatewayBoundaryConfig } from '../src/gateway/authBoundary.js';

function config(auth: GatewayBoundaryConfig['gateway']['auth'] = { mode: 'none' }): GatewayBoundaryConfig {
    return { gateway: { host: '127.0.0.1', port: 48420, auth, originAllowlist: [] }, mesh: { enabled: false } };
}

async function withServer(run: (base: string, dispatch: ReturnType<typeof vi.fn>, config: GatewayBoundaryConfig) => Promise<void>, listenHost = '127.0.0.1') {
    const cfg = config();
    const dispatch = vi.fn();
    const app = express();
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    app.use(createGatewayAuthBoundary({ loadConfig: () => cfg, isValidToken: token => token === 'fixture-token', port: address.port, host: listenHost }));
    app.use(express.json({ limit: '1mb' }));
    app.post('/api/config', gatewayAuthConfigTransitionGuard(listenHost), (req, res) => { dispatch(req.body); res.json({ ok: true }); });
    app.all('/ollama/*', (_req, res) => { dispatch(); res.json({ ok: true }); });
    app.all('/api/tools/run', (_req, res) => { dispatch(); res.json({ ok: true }); });
    try { await run(`http://127.0.0.1:${address.port}`, dispatch, cfg); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('gateway startup authentication policy', () => {
    it('keeps a fresh default configuration closed until credentials are configured', () => {
        expect(() => resolveGatewayListenHost({ gateway: GatewayConfigSchema.parse({}) })).toThrow(/authentication is not configured/i);
    });
    it.each([undefined, { mode: 'token' }, { mode: 'token', token: '' }, { mode: 'token', token: '   ' }, { mode: 'password' }, { mode: 'unexpected' }])('rejects incomplete authentication before initialization: %j', auth => {
        const cfg = config(); cfg.gateway.auth = auth;
        expect(() => resolveGatewayListenHost(cfg)).toThrow(/authentication is not configured/i);
    });
    it.each(['0.0.0.0', '::', '192.168.1.2', 'gateway.example'])('rejects no-auth nonloopback listener %s', host => {
        expect(() => resolveGatewayListenHost(config(), host)).toThrow(/restricted to loopback/i);
    });
    it('checks mesh effective binding before any mesh initialization', () => {
        const cfg = config(); cfg.mesh = { enabled: true, secret: 'synthetic-mesh-secret' };
        expect(() => resolveGatewayListenHost(cfg)).toThrow(/network or mesh listener/i);
        cfg.gateway.auth = { mode: 'token', token: 'configured-token' };
        expect(resolveGatewayListenHost(cfg)).toBe('0.0.0.0');
    });
    it.each(['127.0.0.1', 'localhost', '::1'])('preserves local no-auth listener %s', host => {
        expect(resolveGatewayListenHost(config(), host)).toBe(host);
    });
});

describe('exact local browser trust', () => {
    it('rejects hostile Host, foreign Origin and cross-site no-Origin requests', () => {
        const cfg = config();
        expect(isLocalGatewayRequestAllowed({ host: 'attacker.example:48420' }, cfg, 48420)).toBe(false);
        expect(isLocalGatewayRequestAllowed({ host: '127.0.0.1:48420', origin: 'http://attacker.trycloudflare.com' }, cfg, 48420)).toBe(false);
        expect(isLocalGatewayRequestAllowed({ host: '127.0.0.1:48420', 'sec-fetch-site': 'cross-site' }, cfg, 48420)).toBe(false);
        expect(isLocalGatewayRequestAllowed({ host: '127.0.0.1:48420' }, cfg, 48420)).toBe(true);
        expect(isLocalGatewayRequestAllowed({ host: '127.0.0.1:48420', origin: 'http://127.0.0.1:48420' }, cfg, 48420)).toBe(true);
    });
    it('accepts only explicitly persisted exact origins and bounds the schema', () => {
        const parsed = GatewayConfigSchema.parse({ originAllowlist: ['https://owner.example'] });
        const cfg = config(); cfg.gateway.originAllowlist = parsed.originAllowlist;
        expect(isLocalGatewayRequestAllowed({ host: 'owner.example', origin: 'https://owner.example' }, cfg, 48420)).toBe(true);
        expect(isLocalGatewayRequestAllowed({ host: 'owner.example', origin: 'https://child.owner.example' }, cfg, 48420)).toBe(false);
        for (const origin of ['https://*.example', 'https://owner.example/path', 'https://user:secret@owner.example', 'file:///tmp/a', 'null']) {
            expect(GatewayConfigSchema.safeParse({ originAllowlist: [origin] }).success, origin).toBe(false);
        }
        expect(GatewayConfigSchema.safeParse({ originAllowlist: Array(65).fill('https://owner.example') }).success).toBe(false);
        expect(isGatewayCorsOriginAllowed('https://attacker.trycloudflare.com', cfg, 48420)).toBe(false);
    });
    it('terminates preflight and rejects browser form/subresource attempts without dispatch', async () => {
        await withServer(async (base, dispatch) => {
            const own = await fetch(`${base}/ollama/api/delete`, { method: 'OPTIONS', headers: { Origin: base, 'Access-Control-Request-Method': 'DELETE' } });
            expect(own.status).toBe(204);
            const hostile = await fetch(`${base}/api/tools/run`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{not-json' });
            expect(hostile.status).toBe(403);
            const rebound = await new Promise<number>((resolve, reject) => {
                const req = request(`${base}/api/tools/run`, { method: 'POST', headers: { Host: 'attacker.example', 'Content-Type': 'application/json' } }, res => {
                    res.resume(); res.on('end', () => resolve(res.statusCode || 0));
                });
                req.on('error', reject); req.end('{}');
            });
            expect(rebound).toBe(403);
            const subresource = await fetch(`${base}/ollama/api/delete`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
            expect(subresource.status).toBe(403);
            expect(dispatch).not.toHaveBeenCalled();
            expect((await fetch(`${base}/api/tools/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
            expect(dispatch).toHaveBeenCalledTimes(1);
        });
    });
    it('holds Lark before parsing any body and never exempts future Twilio paths', async () => {
        await withServer(async (base, dispatch, cfg) => {
            cfg.gateway.auth = { mode: 'token', token: 'fixture-token' };
            expect((await fetch(`${base}/api/channels/lark/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not-json' })).status).toBe(503);
            expect((await fetch(`${base}/api/twilio/future-admin-action`, { method: 'POST' })).status).toBe(401);
            expect((await fetch(`${base}/api/tools/run?token[]=fixture-token`, { method: 'POST' })).status).toBe(401);
            expect((await fetch(`${base}/api/tools/run?token=fixture-token&token=other`, { method: 'POST' })).status).toBe(401);
            expect(dispatch).not.toHaveBeenCalled();
        });
    });
    it('keeps a previously network-bound listener closed after a live config switches to no-auth', async () => {
        // The controlled transport stays loopback; the captured policy is the original network bind.
        await withServer(async (base, dispatch, cfg) => {
            cfg.gateway.auth = { mode: 'token', token: 'fixture-token' };
            expect((await fetch(`${base}/api/config`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body: '{"gatewayAuthMode":"none"}' })).status).toBe(409);
            expect(dispatch).not.toHaveBeenCalled();
            expect((await fetch(`${base}/api/tools/run`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token' } })).status).toBe(200);
            cfg.gateway.auth = { mode: 'none' };
            expect((await fetch(`${base}/api/tools/run`, { method: 'POST' })).status).toBe(403);
            expect(dispatch).toHaveBeenCalledTimes(1);
        }, '0.0.0.0');
    });
});

describe('credential and webhook comparisons', () => {
    it('compares UTF-8 byte lengths and rejects non-string inputs without throwing', () => {
        expect(safeCredentialEqual('é', 'a')).toBe(false);
        expect(safeCredentialEqual('secret-é', 'secret-é')).toBe(true);
        for (const value of [null, undefined, {}, [], 1]) expect(safeCredentialEqual(value, 'secret')).toBe(false);
    });
    it('verifies LINE raw bytes with the documented channel secret, failing closed when missing', () => {
        const raw = Buffer.from('{ "events": [] }\n');
        const signature = createHmac('sha256', 'synthetic-channel-secret').update(raw).digest('base64');
        expect(verifyLineWebhookSignature(raw, signature, 'synthetic-channel-secret')).toBe(true);
        expect(verifyLineWebhookSignature(Buffer.from('{"events":[]}'), signature, 'synthetic-channel-secret')).toBe(false);
        expect(verifyLineWebhookSignature(raw, signature, undefined)).toBe(false);
        expect(verifyLineWebhookSignature(undefined, signature, 'synthetic-channel-secret')).toBe(false);
        expect(verifyLineWebhookSignature(raw, 'not-a-signature', 'synthetic-channel-secret')).toBe(false);
    });
});
