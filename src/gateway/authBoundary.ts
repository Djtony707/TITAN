/** Shared gateway authentication boundary, installed before any route or body parser. */
import type { RequestHandler } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

export interface GatewayBoundaryConfig {
    gateway: {
        host?: string;
        port?: number;
        auth?: { mode?: string; token?: unknown; password?: unknown };
        originAllowlist?: string[];
    };
    mesh?: { enabled?: boolean; secret?: string };
}

export function safeCredentialEqual(a: unknown, b: unknown): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}

export function isGatewayAuthConfigured(config: GatewayBoundaryConfig): boolean {
    const auth = config.gateway.auth;
    if (auth?.mode === 'none') return true;
    const credential = auth?.mode === 'token' ? auth.token : auth?.mode === 'password' ? auth.password : undefined;
    return typeof credential === 'string' && credential.trim().length > 0;
}

export function isLoopbackGatewayHost(host: string): boolean {
    return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/** Resolve mesh's effective listen address before network, model or background initialization. */
export function resolveGatewayListenHost(config: GatewayBoundaryConfig, requestedHost?: string): string {
    let host = requestedHost || config.gateway.host || '127.0.0.1';
    if (config.mesh?.enabled && config.mesh.secret && host === '127.0.0.1') host = '0.0.0.0';
    if (!isGatewayAuthConfigured(config)) {
        throw new Error('Gateway authentication is not configured. Set gateway.auth.token or gateway.auth.password with the corresponding mode before starting.');
    }
    if (config.gateway.auth?.mode === 'none' && !isLoopbackGatewayHost(host)) {
        throw new Error('Gateway auth mode "none" is restricted to loopback. Configure token or password authentication before enabling a network or mesh listener.');
    }
    return host;
}

export function isExactHttpOrigin(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048 || value.includes('*')) return false;
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
    } catch { return false; }
}

function trustedOrigins(config: GatewayBoundaryConfig, port: number, listenHost?: string): Set<string> {
    const origins = new Set<string>();
    const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    const configuredHost = listenHost || config.gateway.host;
    if (configuredHost && isLoopbackGatewayHost(configuredHost)) hosts.add(configuredHost === '::1' ? '[::1]' : configuredHost);
    for (const host of hosts) {
        for (const protocol of ['http', 'https']) origins.add(new URL(`${protocol}://${host}:${port}`).origin);
    }
    for (const origin of config.gateway.originAllowlist || []) if (isExactHttpOrigin(origin)) origins.add(origin);
    return origins;
}

export function isGatewayCorsOriginAllowed(origin: string, config: GatewayBoundaryConfig, port: number, listenHost?: string): boolean {
    if (trustedOrigins(config, port, listenHost).has(origin)) return true;
    if (config.gateway.auth?.mode === 'none') return false;
    // Compatibility for authenticated remote dashboards; these patterns are never local no-auth authority.
    return [
        /^https?:\/\/[a-z0-9-]+\.ts\.net(:\d+)?$/,
        /^https?:\/\/[a-z0-9-]+\.trycloudflare\.com(:\d+)?$/,
        /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
        /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
        /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    ].some(pattern => pattern.test(origin));
}

/** Local no-auth mode trusts local native clients, not arbitrary web origins or DNS names. */
export function isLocalGatewayRequestAllowed(
    headers: { host?: string; origin?: string; 'sec-fetch-site'?: string },
    config: GatewayBoundaryConfig,
    port: number,
    listenHost?: string,
): boolean {
    if (!isLoopbackGatewayHost(listenHost || config.gateway.host || '127.0.0.1')) return false;
    const origins = trustedOrigins(config, port, listenHost);
    const host = headers.host;
    if (!host || /[\s\\/@?#]/.test(host)) return false;
    let authority: string;
    try { authority = new URL(`http://${host}`).host; } catch { return false; }
    if (![...origins].some(origin => new URL(origin).host === authority)) return false;
    if (headers['sec-fetch-site'] === 'cross-site') return false;
    return headers.origin === undefined || origins.has(headers.origin);
}

const signedWebhookRoutes = new Set([
    'GET /api/messenger/webhook', 'POST /api/messenger/webhook',
    'GET /messenger/webhook', 'POST /messenger/webhook',
    'POST /api/channels/line/webhook',
    'POST /api/telephony/dograh/inbound',
    'POST /api/twilio/voice-webhook', 'POST /api/twilio/voice-gather',
    'POST /api/twilio/voice-poll', 'GET /api/twilio/voice-poll',
    'POST /api/twilio/status-callback',
]);

function isSignedWebhookRoute(method: string, path: string): boolean {
    // The audio route has its own random 96-bit capability and five-minute cache TTL.
    return signedWebhookRoutes.has(`${method} ${path}`)
        || (method === 'GET' && /^\/api\/twilio\/audio\/[a-f0-9]{24}$/i.test(path));
}

export function isProtectedGatewayPath(path: string): boolean {
    return /^\/(?:api|v1|ollama|paperclip|mcp)(?:\/|$)/i.test(path) || /^\/metrics\/?$/i.test(path);
}

/** Every exception is an exact method/path whose handler authenticates its own platform input. */
export function createGatewayAuthBoundary<T extends GatewayBoundaryConfig>(dependencies: {
    loadConfig: () => T;
    isValidToken: (token: string | undefined, config: T) => boolean;
    port: number;
    host?: string;
}): RequestHandler {
    return (req, res, next) => {
        const path = req.path.replace(/\/$/, '').toLowerCase() || '/';
        if (req.method === 'POST' && path === '/api/channels/lark/webhook') {
            res.status(503).set('Cache-Control', 'no-store').json({ error: 'lark_webhook_security_hold', message: 'Lark inbound events are disabled until a reviewed event-signature configuration is available.' });
            return;
        }
        if (!isProtectedGatewayPath(path)) { next(); return; }
        const config = dependencies.loadConfig();
        const auth = config.gateway.auth;
        if (auth?.mode === 'none' && !isLocalGatewayRequestAllowed({
            host: req.get('host'), origin: req.get('origin'), 'sec-fetch-site': req.get('sec-fetch-site'),
        }, config, dependencies.port, dependencies.host) && !isSignedWebhookRoute(req.method, path)) {
            res.status(403).json({ error: 'local_gateway_origin_required' });
            return;
        }
        // Browser preflights never proceed into proxies or operation handlers.
        if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
        if ((req.method === 'POST' && path === '/api/login') || isSignedWebhookRoute(req.method, path)) { next(); return; }
        const header = req.headers.authorization;
        const token = typeof header === 'string' && header.startsWith('Bearer ')
            ? header.slice(7)
            : header === undefined && typeof req.query.token === 'string' ? req.query.token : undefined;
        if (auth?.mode === 'none' || (isGatewayAuthConfigured(config) && dependencies.isValidToken(token, config))) { next(); return; }
        if (path === '/v1' || path.startsWith('/v1/')) {
            res.status(401).json({ error: { message: 'Unauthorized. A configured TITAN gateway credential is required.', type: 'invalid_request_error', code: 'unauthorized' } });
        } else res.status(401).json({ error: 'Unauthorized' });
    };
}

/** Persisting no-auth cannot weaken an already active network listener. */
export function gatewayAuthConfigTransitionGuard(listenHost: string): RequestHandler {
    return (req, res, next) => {
        if (req.body?.gatewayAuthMode === 'none' && !isLoopbackGatewayHost(listenHost)) {
            res.status(409).json({ error: 'loopback_restart_required', message: 'Authentication cannot be disabled on the active network listener. Configure a loopback host and restart with authentication enabled before selecting local no-auth mode.' });
            return;
        }
        next();
    };
}

/** LINE documents base64(HMAC-SHA256(channel secret, exact raw request bytes)). */
export function verifyLineWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined, channelSecret: unknown): boolean {
    if (!rawBody || !signature || typeof channelSecret !== 'string' || !channelSecret) return false;
    const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
    return safeCredentialEqual(signature, expected);
}
