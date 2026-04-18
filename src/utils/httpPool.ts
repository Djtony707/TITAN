/**
 * TITAN — Global HTTP Pool
 *
 * Hunt Finding #29 (2026-04-14): a Phase 5 load test showed the gateway
 * accumulating 100+ keep-alive sockets to Ollama (127.0.0.1:11434) after
 * 100 sequential /api/message requests. Each /api/message triggers 3
 * parallel Ollama fetches (main chat + graph extraction + deliberation),
 * and the default global fetch dispatcher in Node.js has no per-origin
 * connection cap, so the pool grew to match peak concurrency and never
 * shrank. No classical "body not consumed" leak (CLOSE_WAIT was 0), just
 * unbounded pool growth.
 *
 * Fix: install a bounded undici Agent as the global dispatcher, with:
 *   - `connections: 16` per origin (cap the pool size)
 *   - `keepAliveTimeout: 10_000` (close idle connections after 10s)
 *   - `keepAliveMaxTimeout: 60_000` (hard cap — connection can't live
 *     longer than 60s idle even if bumped by pending requests)
 *   - `headersTimeout: 60_000` + `bodyTimeout: 300_000` (protect against
 *     stuck upstreams without fighting the caller's AbortSignal.timeout)
 *
 * This module is import-side-effect: simply `import './utils/httpPool.js'`
 * at gateway startup. Idempotent — safe to import multiple times. A
 * subsequent import returns the same dispatcher without creating a new one.
 *
 * Tunable via config.gateway.httpPool.{connections,keepAliveTimeoutMs}
 * for operators who need to go higher or lower than the defaults.
 */
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import logger from './logger.js';

const COMPONENT = 'HttpPool';

let installed = false;
let currentAgent: Agent | null = null;

export interface HttpPoolOptions {
    /** Max in-flight + idle connections per origin. Default 16. */
    connections?: number;
    /** Idle keep-alive timeout in ms. Default 10_000. */
    keepAliveTimeoutMs?: number;
    /** Hard cap on keep-alive bumps in ms. Default 60_000. */
    keepAliveMaxTimeoutMs?: number;
    /** Max time to wait for response headers. Default 60_000. */
    headersTimeoutMs?: number;
    /** Max time to wait for full response body. Default 300_000. */
    bodyTimeoutMs?: number;
}

/**
 * Install the global dispatcher. Safe to call multiple times — only the
 * first call takes effect. Returns true if installed this call, false if
 * already installed.
 */
export function installGlobalHttpPool(opts: HttpPoolOptions = {}): boolean {
    if (installed) return false;
    const connections = Math.max(1, Math.min(1024, opts.connections ?? 16));
    const keepAliveTimeout = Math.max(1_000, Math.min(300_000, opts.keepAliveTimeoutMs ?? 10_000));
    const keepAliveMaxTimeout = Math.max(
        keepAliveTimeout,
        Math.min(600_000, opts.keepAliveMaxTimeoutMs ?? 60_000),
    );
    const headersTimeout = Math.max(1_000, Math.min(600_000, opts.headersTimeoutMs ?? 60_000));
    const bodyTimeout = Math.max(1_000, Math.min(1_200_000, opts.bodyTimeoutMs ?? 300_000));

    const agent = new Agent({
        connections,
        keepAliveTimeout,
        keepAliveMaxTimeout,
        headersTimeout,
        bodyTimeout,
        // Pipelining defaults to 1; leave it alone — HTTP pipelining has
        // poor server support and is rarely a win.
    });

    setGlobalDispatcher(agent);
    currentAgent = agent;
    installed = true;
    logger.info(
        COMPONENT,
        `Global HTTP pool installed: connections=${connections}, keepAliveTimeout=${keepAliveTimeout}ms, keepAliveMaxTimeout=${keepAliveMaxTimeout}ms, headersTimeout=${headersTimeout}ms, bodyTimeout=${bodyTimeout}ms`,
    );
    return true;
}

/**
 * For tests: close the current agent + reset the "installed" flag so
 * the next call to installGlobalHttpPool creates a fresh Agent. Without
 * this, each test that installs a new pool leaks the old undici Agent's
 * timers + sockets, preventing the vitest worker from exiting cleanly
 * at suite end ("Worker exited unexpectedly" flake).
 */
export async function __resetHttpPoolForTests(): Promise<void> {
    if (currentAgent) {
        try { await currentAgent.close(); } catch { /* best-effort */ }
        currentAgent = null;
    }
    installed = false;
}
