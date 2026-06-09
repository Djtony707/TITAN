/**
 * TITAN — Session Context (live-agents event spine)
 *
 * Async-context-aware "current session" pointer, mirroring worktreeScope. When
 * tool execution is wrapped in `runWithSession`, every `executeTool` call inside
 * it (including nested/awaited sub-agent calls) sees the same `{sessionId,
 * agentId}` via `currentSession()`. sessionTrace uses this so `tool:call` /
 * `tool:result` events are attributed to the session that actually triggered
 * them — instead of falling back to the ambient env (which the gateway never
 * sets per request, so tool events were landing under "unknown").
 *
 * AsyncLocalStorage (not a module global) so two concurrent chats on the same
 * gateway each get their own session — no cross-contamination when their awaits
 * interleave. Neutral module (no agent/toolRunner imports) to avoid import cycles.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SessionContext {
    sessionId: string;
    agentId?: string;
}

const storage = new AsyncLocalStorage<SessionContext>();

/** Read the current session context, or null when outside any runWithSession. */
export function currentSession(): SessionContext | null {
    return storage.getStore() ?? null;
}

/** Run `fn` with the given session context active for all downstream tool calls. */
export function runWithSession<T>(ctx: SessionContext, fn: () => T | Promise<T>): T | Promise<T> {
    return storage.run(ctx, fn);
}
