/**
 * TITAN — Subagent Safety Layer (v4.7.0+)
 *
 * Ports Hermes-agent's three hard limits on the spawn_agent path:
 *
 *   - MAX_SUBAGENT_DEPTH: children can't spawn grandchildren past depth 2
 *   - MAX_CONCURRENT_CHILDREN: at most N children running at once per parent
 *   - BLOCKED_TOOLS: children can't call these no matter what
 *
 * These prevent:
 *   - fork bombs (recursive spawn → exponential blowup)
 *   - memory corruption (child writes to memory that parent reads from)
 *   - unauthorized side-effects (child sending messages / executing code
 *     as if it were the parent)
 *
 * Reference: NousResearch/hermes-agent tools/delegate_tool.py
 */
import logger from '../utils/logger.js';

const COMPONENT = 'SubagentSafety';

/** How deep spawn chains are allowed to go before we refuse. */
export const MAX_SUBAGENT_DEPTH = 2;

/** How many children can run concurrently under a single parent. */
export const MAX_CONCURRENT_CHILDREN = 3;

/**
 * Tools children cannot call, even if enabled on the parent.
 * Protects against:
 *   - Recursive spawning (spawn_agent)
 *   - Corrupting the parent's memory graph from within a short-lived child
 *   - Side-channel messaging (a child DMing Tony on Messenger directly)
 *   - Arbitrary code execution (children should read/write files explicitly,
 *     not exec unaudited code)
 */
export const BLOCKED_CHILD_TOOLS = new Set([
    'spawn_agent',
    'memory_store',
    'memory_write',
    'send_message',
    'fb_post',
    'x_post',
    'send_email',
    'twilio_call',
    'messenger_send',
    'code_exec',
]);

/** Track active children per parent session. */
const activeChildren = new Map<string, Set<string>>();

export function canSpawnChild(parentSessionId: string, depth: number): { ok: true } | { ok: false; reason: string } {
    if (depth >= MAX_SUBAGENT_DEPTH) {
        return { ok: false, reason: `depth ${depth} >= MAX_SUBAGENT_DEPTH (${MAX_SUBAGENT_DEPTH})` };
    }
    const children = activeChildren.get(parentSessionId) || new Set();
    if (children.size >= MAX_CONCURRENT_CHILDREN) {
        return { ok: false, reason: `parent has ${children.size} concurrent children, max ${MAX_CONCURRENT_CHILDREN}` };
    }
    return { ok: true };
}

export function registerChild(parentSessionId: string, childSessionId: string): void {
    if (!activeChildren.has(parentSessionId)) activeChildren.set(parentSessionId, new Set());
    activeChildren.get(parentSessionId)!.add(childSessionId);
    logger.debug(COMPONENT, `Child registered: ${childSessionId.slice(0, 8)} under ${parentSessionId.slice(0, 8)} (${activeChildren.get(parentSessionId)!.size}/${MAX_CONCURRENT_CHILDREN})`);
}

export function unregisterChild(parentSessionId: string, childSessionId: string): void {
    const children = activeChildren.get(parentSessionId);
    if (!children) return;
    children.delete(childSessionId);
    if (children.size === 0) activeChildren.delete(parentSessionId);
}

/**
 * Filter a tool list, removing blocked-for-children tools. Pass the
 * child's depth so we can skip filtering for top-level primary agents.
 */
export function filterToolsForChild(tools: string[], depth: number): string[] {
    if (depth === 0) return tools; // primary agent, no filtering
    const filtered = tools.filter(t => !BLOCKED_CHILD_TOOLS.has(t));
    const dropped = tools.filter(t => BLOCKED_CHILD_TOOLS.has(t));
    if (dropped.length > 0) {
        logger.info(COMPONENT, `Blocked ${dropped.length} unsafe tool(s) for child: ${dropped.join(', ')}`);
    }
    return filtered;
}
