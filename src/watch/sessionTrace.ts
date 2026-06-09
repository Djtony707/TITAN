/**
 * TITAN — Session Trace (live-agents event spine)
 *
 * The single, session-scoped, attributable fan-out for tool events. Stamps a
 * stable `actionId` and emits onto the existing trace bus (`tool:call` /
 * `tool:result`) — the topics that are typed + subscribed (watchRouter) +
 * humanized today but have NO producer. This is that producer.
 *
 * Two call sites feed it (built in later slices): a zero-blast-radius fallback
 * in `executeTool` and richer sibling emits in `agentLoop`. Because both can
 * fire for the same logical action, a short TTL dedupe (keyed on the shared
 * `actionId`) collapses them to one event. When no `actionId` is present the
 * event always emits (no dedupe — we never silently drop an unattributable
 * event).
 *
 * Design invariants: additive only, never throws to the caller, O(1) emit,
 * model-agnostic, and it touches no LLM and never the `claude` CLI.
 */
import { emit as busEmit, type ToolCallEvent, type ToolResultEvent } from '../substrate/traceBus.js';

/** How long a given actionId stays deduped after first emit. */
export const DEDUPE_TTL_MS = 30_000;
/** Soft cap on the dedupe registry before an opportunistic prune. */
const DEDUPE_MAX = 4096;

const seen = new Map<string, number>();

/**
 * Pure dedupe primitive. Returns true the FIRST time a key is seen within the
 * TTL window, false on repeats. `now` is injected so it is deterministic and
 * unit-testable. Prunes opportunistically when the registry grows large.
 */
export function shouldEmit(key: string, now: number): boolean {
    const exp = seen.get(key);
    if (exp !== undefined && exp > now) return false;
    seen.set(key, now + DEDUPE_TTL_MS);
    if (seen.size > DEDUPE_MAX) {
        for (const [k, e] of seen) if (e <= now) seen.delete(k);
    }
    return true;
}

/** Test/maintenance hook — clears the dedupe registry. */
export function resetDedupe(): void {
    seen.clear();
}

/** Ambient session id, threaded by callers via env when no explicit id exists. */
export function ambientSessionId(): string | undefined {
    return process.env.TITAN_SESSION_ID || undefined;
}

type ToolCallInput = Omit<ToolCallEvent, 'timestamp' | 'sessionId' | 'agentId'> &
    Partial<Pick<ToolCallEvent, 'sessionId' | 'agentId'>>;
type ToolResultInput = Omit<ToolResultEvent, 'timestamp' | 'sessionId' | 'agentId'> &
    Partial<Pick<ToolResultEvent, 'sessionId' | 'agentId'>>;

function resolveIds<T extends { sessionId?: string; agentId?: string }>(input: T): { sessionId: string; agentId: string } {
    return {
        sessionId: input.sessionId || ambientSessionId() || 'unknown',
        agentId: input.agentId || 'main',
    };
}

/**
 * Stamp + emit a `tool:call`. Returns true if emitted, false if deduped.
 * `nowMs` is injectable for tests; defaults to wall clock.
 */
export function emitToolCall(input: ToolCallInput, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    if (input.actionId && !shouldEmit(`tool:call|${input.actionId}`, now)) return false;
    const { sessionId, agentId } = resolveIds(input);
    busEmit('tool:call', { ...input, sessionId, agentId, timestamp: new Date(now).toISOString() });
    return true;
}

/**
 * Stamp + emit a `tool:result`. Returns true if emitted, false if deduped.
 */
export function emitToolResult(input: ToolResultInput, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    if (input.actionId && !shouldEmit(`tool:result|${input.actionId}`, now)) return false;
    const { sessionId, agentId } = resolveIds(input);
    busEmit('tool:result', { ...input, sessionId, agentId, timestamp: new Date(now).toISOString() });
    return true;
}
