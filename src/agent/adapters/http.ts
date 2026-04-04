/**
 * TITAN — HTTP Webhook Adapter
 *
 * Persistent adapter that POSTs tasks to an external HTTP endpoint.
 * The remote service processes the task and returns JSON with content field.
 */
import type { ExternalAdapter, AdapterContext, AdapterResult, AdapterConfig, AdapterStatus } from './base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Adapter:HTTP';

interface HttpState {
    _url?: string;
    _config?: AdapterConfig;
    _connected: boolean;
    _upSince: string | null;
    _lastHeartbeat: string | null;
    _error: string | null;
}

const state: HttpState = { _connected: false, _upSince: null, _lastHeartbeat: null, _error: null };

function isOk(s: number): boolean { return s >= 200 && s < 300; }
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const httpAdapter: ExternalAdapter = {
    type: 'http',
    displayName: 'HTTP Webhook',
    persistent: true,

    async start(config: AdapterConfig): Promise<void> {
        if (!config.url) throw new Error('HTTP adapter requires config.url');
        state._url = config.url;
        state._config = config;
        state._upSince = null;
        state._lastHeartbeat = null;
        state._error = null;
        state._connected = false;

        logger.info(COMPONENT, `Validating endpoint: HEAD ${config.url}`);
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? 10_000);
            const res = await fetch(config.url, { method: 'HEAD', signal: ac.signal });
            clearTimeout(timer);
            if (!isOk(res.status)) throw new Error(`HEAD returned ${res.status}`);
            state._connected = true;
            state._upSince = new Date().toISOString();
            state._lastHeartbeat = new Date().toISOString();
            logger.info(COMPONENT, `Endpoint ready: ${config.url}`);
        } catch (err) {
            state._error = errMsg(err);
            logger.warn(COMPONENT, `Validation failed: ${state._error} — will retry via heartbeat`);
        }
    },

    async stop(): Promise<void> {
        logger.info(COMPONENT, `Stopping — ${state._url ?? 'unconfigured'}`);
        state._url = undefined;
        state._config = undefined;
        state._connected = false;
        state._upSince = null;
        state._lastHeartbeat = null;
        state._error = null;
    },

    getStatus(): AdapterStatus {
        return { connected: state._connected, lastHeartbeat: state._lastHeartbeat, upSince: state._upSince, error: state._error };
    },

    async checkHeartbeat(): Promise<boolean> {
        if (!state._url) { state._connected = false; state._error = 'No URL configured'; return false; }
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), state._config?.timeoutMs ?? 10_000);
            const res = await fetch(state._url, { method: 'HEAD', signal: ac.signal });
            clearTimeout(timer);
            const ok = isOk(res.status);
            state._connected = ok;
            state._lastHeartbeat = new Date().toISOString();
            state._error = ok ? null : `Heartbeat returned ${res.status}`;
            return ok;
        } catch (err) {
            state._connected = false;
            state._error = errMsg(err);
            return false;
        }
    },

    async execute(ctx: AdapterContext): Promise<AdapterResult> {
        if (!state._url) return { content: 'HTTP adapter not started', exitCode: 1, success: false, durationMs: 0, toolsUsed: [] };
        const startMs = Date.now();
        const timeoutMs = ctx.timeoutMs ?? state._config?.timeoutMs ?? 300_000;
        const body = JSON.stringify({ task: ctx.task, titanApiUrl: ctx.titanApiUrl, titanRunId: ctx.titanRunId, titanIssueId: ctx.titanIssueId });
        logger.info(COMPONENT, `POST ${state._url} (timeout: ${timeoutMs}ms)`);
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), timeoutMs);
            const res = await fetch(state._url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal });
            clearTimeout(timer);
            const raw = await res.text();
            let content = raw.trim();
            try {
                const p = JSON.parse(raw) as Record<string, unknown>;
                content = (typeof p.content === 'string' ? p.content : typeof p.result === 'string' ? p.result : content);
            } catch { /* use raw */ }
            const success = isOk(res.status);
            if (success) { state._connected = true; state._lastHeartbeat = new Date().toISOString(); state._error = null; }
            return { content: content || `HTTP ${res.status}`, exitCode: success ? 0 : res.status, success, durationMs: Date.now() - startMs, toolsUsed: ['http-webhook'] };
        } catch (err) {
            const msg = errMsg(err);
            state._connected = false;
            state._error = msg;
            return { content: msg.includes('abort') ? `Timed out after ${timeoutMs}ms` : `HTTP error: ${msg}`, exitCode: 1, success: false, durationMs: Date.now() - startMs, toolsUsed: [] };
        }
    },
};
